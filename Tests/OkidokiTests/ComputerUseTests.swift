import XCTest
import AppKit
@testable import OkidokiCore

@MainActor
final class ComputerUseTests: XCTestCase {

    func testAppResolverFindsSystemApps() {
        let notes = AppResolver.resolve(name: "Notes")
        XCTAssertNotNil(notes, "Notes should resolve to a system app")
        XCTAssertTrue(notes!.url.path.contains("Notes.app"))

        let calculator = AppResolver.resolve(name: "calculator")
        XCTAssertNotNil(calculator, "calculator should resolve case-insensitively to Calculator.app")

        let fuzzy = AppResolver.resolve(name: "Fin")
        XCTAssertNotNil(fuzzy, "partial names should still resolve to Finder")
    }

    func testAppResolverAliases() {
        if FileManager.default.fileExists(atPath: "/Applications/FreeCAD.app") {
            XCTAssertEqual(AppResolver.resolve(name: "cad")?.url.lastPathComponent, "FreeCAD.app")
        }
        let nonsense = AppResolver.resolve(name: "DefinitelyNotAnApp99")
        XCTAssertNil(nonsense)
    }

    func testImageCoordinateMapping() {
        let box = ScreenBox(x: 100, y: 50, width: 1512, height: 982)
        // 2x retina image, click at image center should map to screen center.
        let point = ComputerUseService.mapImage(x: 1512, y: 982, box: box, imageWidth: 3024, imageHeight: 1964)
        XCTAssertEqual(point?.x ?? 0, 100 + 756, accuracy: 0.5)
        XCTAssertEqual(point?.y ?? 0, 50 + 491, accuracy: 0.5)

        // Out-of-bounds clicks are rejected.
        XCTAssertNil(ComputerUseService.mapImage(x: 5000, y: 10, box: box, imageWidth: 3024, imageHeight: 1964))
        XCTAssertNil(ComputerUseService.mapImage(x: -5, y: 10, box: box, imageWidth: 3024, imageHeight: 1964))
    }

    func testComputerActionLenientDecoding() throws {
        // The brain sends snake_case; ints and floats both appear depending on the model.
        let json = #"{"type":"click","x":120,"y":80,"say":"clicking send"}"#.data(using: .utf8)!
        let click = try JSONDecoder().decode(ComputerAction.self, from: json)
        XCTAssertEqual(click.type, "click")
        XCTAssertEqual(click.x, 120)
        XCTAssertEqual(click.y, 80)
        XCTAssertEqual(click.say, "clicking send")

        let dragJSON = #"{"type":"drag","from_x":1,"from_y":2.5,"to_x":300,"to_y":400}"#.data(using: .utf8)!
        let drag = try JSONDecoder().decode(ComputerAction.self, from: dragJSON)
        XCTAssertEqual(drag.fromX, 1)
        XCTAssertEqual(drag.fromY, 2.5)
        XCTAssertEqual(drag.toX, 300)

        let missing = #"{}"#.data(using: .utf8)!
        let fallback = try JSONDecoder().decode(ComputerAction.self, from: missing)
        XCTAssertEqual(fallback.type, "fail")
    }

    func testComputerActionDictionaryRoundTrip() throws {
        let action = ComputerAction(type: "type", text: "hey mom", say: "typing")
        let dict = action.dictionary
        XCTAssertEqual(dict["type"] as? String, "type")
        XCTAssertEqual(dict["text"] as? String, "hey mom")
        let encoded = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(ComputerAction.self, from: encoded)
        XCTAssertEqual(decoded, action)
    }

    func testTeachPlanAndDecisionDecoding() throws {
        let json = """
        {"kind":"overlay","title":"flow","answer":"here you go",
         "overlay_html":"<html></html>","overlay_title":"flow","overlay_width":560,"overlay_height":380,
         "teach_plan":[{"say":"press shift+a","marks":[{"kind":"circle","target":"New chat"}]}]}
        """.data(using: .utf8)!
        let decision = try JSONDecoder().decode(BrainDecision.self, from: json)
        XCTAssertEqual(decision.kind, .overlay)
        XCTAssertEqual(decision.overlayHTML, "<html></html>")
        XCTAssertEqual(decision.overlayWidth, 560)
        XCTAssertEqual(decision.teachPlan.count, 1)
        XCTAssertEqual(decision.teachPlan[0].marks.first?.kind, "circle")
        XCTAssertEqual(decision.teachPlan[0].marks.first?.target, "New chat")

        // Old-format teach decisions still decode.
        let legacy = #"{"kind":"teach","title":"t","answer":"a","teach_steps":["one","two"]}"#.data(using: .utf8)!
        let teach = try JSONDecoder().decode(BrainDecision.self, from: legacy)
        XCTAssertEqual(teach.teachSteps, ["one", "two"])
        XCTAssertEqual(teach.teachPlan, [])
    }

    func testRunningAppsAndFrontmost() {
        let apps = ComputerUseService.shared.runningApps()
        XCTAssertTrue(apps.contains { $0.name == "Finder" }, "Finder is always running")
        _ = ComputerUseService.shared.frontmost()
    }

    func testTypingDefaultInput() {
        XCTAssertEqual(AppSettings().defaultInput, .typing)
    }

    func testTopOfScreenshotStaysAtTopOfDisplay() {
        // Quartz and CGEvent share a top-left origin. A click on the menu bar
        // (small image y) must stay a small y, not get flipped to the bottom.
        let box = ScreenBox(x: 0, y: 0, width: 1352, height: 878)
        let point = ComputerUseService.mapImage(x: 200, y: 10, box: box, imageWidth: 2704, imageHeight: 1756)
        XCTAssertEqual(point?.x ?? -1, 100, accuracy: 0.5)
        XCTAssertEqual(point?.y ?? -1, 5, accuracy: 0.5)
    }

    func testNumberKeycodes() {
        XCTAssertEqual(VirtualKeys.named["8"], 28)
        XCTAssertEqual(VirtualKeys.named["9"], 25)
        XCTAssertEqual(VirtualKeys.named["-"], 27)
        XCTAssertEqual(VirtualKeys.named["1"], 18)
    }

    func testClickEventsCarryClickState() async {
        let report = await Task.detached {
            func summarize(_ events: [CGEvent]) -> String {
                events.map { event in
                    "\(event.type.rawValue):\(event.getIntegerValueField(.mouseEventClickState)):\(event.getIntegerValueField(.mouseEventButtonNumber)):\(event.location.x):\(event.location.y)"
                }.joined(separator: "|")
            }
            let single = summarize(EventActuator.makeClickEvents(at: CGPoint(x: 12, y: 34), button: .left, count: 1))
            let double = summarize(EventActuator.makeClickEvents(at: CGPoint(x: 4, y: 5), button: .left, count: 2))
            let right = summarize(EventActuator.makeClickEvents(at: CGPoint(x: 1, y: 2), button: .right, count: 1))
            return [single, double, right]
        }.value
        XCTAssertTrue(report[0].contains("1:1:0:12"), report[0])
        XCTAssertTrue(report[1].contains("1:1:0:4") && report[1].contains("1:2:0:4"), report[1])
        XCTAssertTrue(report[2].contains("3:1:1:1"), report[2])
    }

    func testDragEventsTravelToTarget() async {
        let report = await Task.detached { () -> String in
            let events = EventActuator.makeDragEvents(from: CGPoint(x: 10, y: 20), to: CGPoint(x: 110, y: 220), steps: 8)
            let types = events.map { String($0.type.rawValue) }.joined(separator: ",")
            let last = events.last
            let suppression = EventActuator.makeSource().localEventsSuppressionInterval
            return "\(types) end=\(last?.location.x ?? -1),\(last?.location.y ?? -1) gap=\(suppression)"
        }.value
        XCTAssertTrue(report.contains(",1,"), report)
        XCTAssertTrue(report.contains(",6,"), report)
        XCTAssertTrue(report.hasPrefix("5,"), report)
        XCTAssertTrue(report.contains("end=110"), report)
        XCTAssertTrue(report.contains("gap=0"), report)
    }

    func testKeyComboPieces() {
        XCTAssertEqual(VirtualKeys.pieces(of: "cmd+shift+a"), ["cmd", "shift", "a"])
        XCTAssertEqual(VirtualKeys.pieces(of: "Cmd + Shift + A"), ["cmd", "shift", "a"])
        XCTAssertEqual(VirtualKeys.pieces(of: "cmd-shift-a"), ["cmd", "shift", "a"])
        XCTAssertEqual(VirtualKeys.pieces(of: "⌘S"), ["cmd", "s"])
        XCTAssertEqual(VirtualKeys.pieces(of: "cmd++"), ["cmd", "plus"])
        XCTAssertEqual(VirtualKeys.pieces(of: "cmd+-"), ["cmd", "-"])
        XCTAssertEqual(VirtualKeys.pieces(of: "-"), ["-"])
        XCTAssertEqual(VirtualKeys.pieces(of: "return"), ["return"])
        XCTAssertEqual(VirtualKeys.pieces(of: "ctrl c"), ["ctrl", "c"])
    }

    func testResolveComboPrefersLiveLayout() {
        // A pretend layout where the physical key for "a" is code 12 (as on a French keyboard).
        let layout: [Character: KeyLayout.Stroke] = [
            "a": .init(code: 12, flags: []), "A": .init(code: 12, flags: .maskShift),
            "=": .init(code: 24, flags: []), "+": .init(code: 24, flags: .maskShift),
            "1": .init(code: 18, flags: []),
        ]
        let a = EventActuator.resolveCombo("cmd+a", layout: layout)
        XCTAssertEqual(a?.code, 12)
        XCTAssertEqual(a?.mods.map { $0.code }, [55])

        let shiftA = EventActuator.resolveCombo("cmd+shift+a", layout: layout)
        XCTAssertEqual(shiftA?.code, 12)
        XCTAssertEqual(shiftA?.mods.map { $0.code }, [55, 56])

        // "plus" is shift+= on this layout; shift is added once.
        let plus = EventActuator.resolveCombo("cmd+plus", layout: layout)
        XCTAssertEqual(plus?.code, 24)
        XCTAssertEqual(plus?.mods.map { $0.code }, [55, 56])
        let plusPlus = EventActuator.resolveCombo("cmd++", layout: layout)
        XCTAssertEqual(plusPlus?.code, 24)

        // Named keys never go through the layout.
        XCTAssertEqual(EventActuator.resolveCombo("return", layout: layout)?.code, 36)
        XCTAssertEqual(EventActuator.resolveCombo("cmd+shift+4", layout: layout)?.code, 21)
        XCTAssertEqual(EventActuator.resolveCombo("arrowdown", layout: layout)?.code, 125)
        XCTAssertEqual(EventActuator.resolveCombo("f13", layout: layout)?.code, 105)

        // Unknown modifiers and keys are rejected rather than mis-typed.
        XCTAssertNil(EventActuator.resolveCombo("hyper+a", layout: layout))
        XCTAssertNil(EventActuator.resolveCombo("volumeup", layout: layout))

        // With no layout at all, the US table still works.
        XCTAssertEqual(EventActuator.resolveCombo("cmd+z", layout: [:])?.code, 6)
    }

    func testLiveLayoutMapsAscii() {
        let layout = KeyLayout.currentMap()
        XCTAssertFalse(layout.isEmpty, "the current keyboard layout should be readable")
        XCTAssertNotNil(layout["a"])
        XCTAssertNotNil(layout["A"])
        XCTAssertNotNil(layout[" "])
        XCTAssertTrue(layout["A"]?.flags.contains(.maskShift) ?? false)
        XCTAssertEqual(layout["a"]?.code, layout["A"]?.code)
    }

    func testTypeStepsUseRealKeysAndBatchTheRest() {
        let layout: [Character: KeyLayout.Stroke] = [
            "h": .init(code: 4, flags: []), "i": .init(code: 34, flags: []),
            "!": .init(code: 18, flags: .maskShift),
        ]
        let steps = EventActuator.typeSteps("hi!\n\t😀x", layout: layout)
        XCTAssertEqual(steps.count, 6, "\(steps)")
        XCTAssertEqual(steps[0], .key(code: 4, flags: [], unicode: Array("h".utf16)))
        XCTAssertEqual(steps[2], .key(code: 18, flags: .maskShift, unicode: Array("!".utf16)))
        XCTAssertEqual(steps[3], .key(code: 36, flags: [], unicode: []))
        XCTAssertEqual(steps[4], .key(code: 48, flags: [], unicode: []))
        XCTAssertEqual(steps[5], .unicode(Array("😀x".utf16)))

        // Long unmapped runs are split so no single event carries too much.
        let long = EventActuator.typeSteps(String(repeating: "漢", count: 30), layout: layout)
        XCTAssertEqual(long.count, 3)
    }

    func testPostedEventsAreTaggedSynthetic() async {
        let report = await Task.detached { () -> [Bool] in
            let click = EventActuator.makeClickEvents(at: CGPoint(x: 10, y: 10)).map { EventActuator.isSynthetic($0) }
            let drag = EventActuator.makeDragEvents(from: .zero, to: CGPoint(x: 5, y: 5), steps: 4).map { EventActuator.isSynthetic($0) }
            let foreign = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true).map { EventActuator.isSynthetic($0) } ?? true
            return click + drag + [!foreign]
        }.value
        XCTAssertFalse(report.isEmpty)
        XCTAssertTrue(report.allSatisfy { $0 }, "\(report)")
    }

    func testScreenshotSendSizeStaysWithinModelLimits() {
        // 14" MacBook Pro: 3024×1964 pixels, 1512×982 points. Must fit the ~1.15 MP budget.
        let laptop = ComputerUseService.sendSize(pixelWidth: 3024, pixelHeight: 1964, pointWidth: 1512)
        XCTAssertLessThanOrEqual(Double(laptop.width * laptop.height), ComputerUseService.maxImagePixels + 2000)
        XCTAssertLessThanOrEqual(laptop.width, 1512)
        XCTAssertEqual(Double(laptop.width) / Double(laptop.height), 3024.0 / 1964.0, accuracy: 0.01)

        // 5K display at 2x: the long edge must come under 1568.
        let big = ComputerUseService.sendSize(pixelWidth: 5120, pixelHeight: 2880, pointWidth: 2560)
        XCTAssertLessThanOrEqual(big.width, Int(ComputerUseService.maxImageLongEdge))
        XCTAssertLessThanOrEqual(Double(big.width * big.height), ComputerUseService.maxImagePixels + 2000)

        // A small 1x display is sent as-is.
        let small = ComputerUseService.sendSize(pixelWidth: 1280, pixelHeight: 800, pointWidth: 1280)
        XCTAssertEqual(small.width, 1280)
        XCTAssertEqual(small.height, 800)
    }

    func testMapPointIsInverseOfMapImage() {
        let box = ScreenBox(x: 100, y: 50, width: 1512, height: 982)
        let image = CGPoint(x: 640, y: 333)
        let point = ComputerUseService.mapImage(x: image.x, y: image.y, box: box, imageWidth: 1331, imageHeight: 864)!
        let back = ComputerUseService.mapPoint(point, box: box, imageWidth: 1331, imageHeight: 864)
        XCTAssertEqual(back.x, image.x, accuracy: 0.01)
        XCTAssertEqual(back.y, image.y, accuracy: 0.01)
    }

    func testScriptErrorsAreExplained() {
        XCTAssertTrue(ScriptActuator.explain("execution error: Not authorized to send Apple events to Notes. (-1743)")?.contains("automation") ?? false)
        XCTAssertTrue(ScriptActuator.explain("Can’t get window 3. (-1728)")?.contains("doesn't exist") ?? false)
        XCTAssertTrue(ScriptActuator.explain("zsh: command not found: ffmpeg")?.contains("isn't installed") ?? false)
        XCTAssertNil(ScriptActuator.explain("some ordinary output"))
    }

    func testVisibleControlsOnFinderWhenTrusted() async throws {
        guard AXIsProcessTrusted() else { throw XCTSkip("accessibility is not granted to the test runner") }
        let finder = ComputerUseService.shared.runningApps().first { $0.name == "Finder" }!
        let controls = await Task.detached {
            AXSearch.controls(pid: finder.pid, visible: CGRect(x: -10000, y: -10000, width: 20000, height: 20000))
        }.value
        XCTAssertFalse(controls.isEmpty, "Finder's menu bar alone should yield controls")
        XCTAssertTrue(controls.contains { $0.label == "File" }, "\(controls.prefix(10))")
    }

    func testActionDecodesZoomRepeatAndModifiers() throws {
        let json = #"{"type":"zoom","x":10,"y":20,"width":300,"height":200,"say":"looking"}"#.data(using: .utf8)!
        let zoom = try JSONDecoder().decode(ComputerAction.self, from: json)
        XCTAssertEqual(zoom.width, 300)
        XCTAssertEqual(zoom.height, 200)

        let key = try JSONDecoder().decode(ComputerAction.self, from: #"{"type":"key","key":"down","count":4,"say":"down"}"#.data(using: .utf8)!)
        XCTAssertEqual(key.times, 4)
        let key2 = try JSONDecoder().decode(ComputerAction.self, from: #"{"type":"key","key":"down","times":2.0,"say":"down"}"#.data(using: .utf8)!)
        XCTAssertEqual(key2.times, 2)

        let click = try JSONDecoder().decode(ComputerAction.self, from: #"{"type":"click","x":1,"y":2,"modifier":"cmd","say":"c"}"#.data(using: .utf8)!)
        XCTAssertEqual(click.modifiers, "cmd")
        let round = try JSONDecoder().decode(ComputerAction.self, from: JSONEncoder().encode(click))
        XCTAssertEqual(round, click)
    }

    func testModifierKeysParse() {
        XCTAssertEqual(EventActuator.modifierKeys(nil)?.count, 0)
        XCTAssertEqual(EventActuator.modifierKeys("")?.count, 0)
        XCTAssertEqual(EventActuator.modifierKeys("cmd")?.map { $0.code }, [55])
        XCTAssertEqual(EventActuator.modifierKeys("cmd+shift")?.map { $0.code }, [55, 56])
        XCTAssertEqual(EventActuator.modifierKeys("⌘⇧")?.map { $0.code }, [55, 56])
        XCTAssertEqual(EventActuator.modifierKeys("shift shift")?.map { $0.code }, [56])
        XCTAssertNil(EventActuator.modifierKeys("hyper"))
    }

    func testMultiWordKeyNames() {
        XCTAssertEqual(VirtualKeys.pieces(of: "page down"), ["pagedown"])
        XCTAssertEqual(VirtualKeys.pieces(of: "cmd + arrow down"), ["cmd", "down"])
        XCTAssertEqual(EventActuator.resolveCombo("forward delete", layout: [:])?.code, 117)
    }

    func testScriptBlockListIsPreciseAboutRm() {
        XCTAssertTrue(ScriptActuator.isBlocked("rm -rf /"))
        XCTAssertTrue(ScriptActuator.isBlocked("rm -rf /*"))
        XCTAssertTrue(ScriptActuator.isBlocked("rm -r ~"))
        XCTAssertTrue(ScriptActuator.isBlocked("rm -fr /Users"))
        XCTAssertTrue(ScriptActuator.isBlocked("rm -rf /System && echo done"))
        XCTAssertTrue(ScriptActuator.isBlocked("sudo rm -rf /tmp/x"))
        XCTAssertTrue(ScriptActuator.isBlocked("tccutil reset All"))
        XCTAssertFalse(ScriptActuator.isBlocked("rm -rf /tmp/okidoki-build"))
        XCTAssertFalse(ScriptActuator.isBlocked("rm -rf ~/Downloads/old-project"))
        XCTAssertFalse(ScriptActuator.isBlocked("rm notes.txt"))
        XCTAssertFalse(ScriptActuator.isBlocked("tell application \"Notes\" to make new note"))
    }

    func testZoomCropsTheFullResolutionImage() throws {
        // A 2x "display": 400×300 full pixels sent as 200×150.
        let space = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
        let full = try XCTUnwrap(context.makeImage())
        let shot = ComputerUseService.Screenshot(png: Data(), box: ScreenBox(x: 0, y: 0, width: 200, height: 150),
                                                 imageWidth: 200, imageHeight: 150, full: full)
        let zoom = try XCTUnwrap(ComputerUseService.zoom(shot, x: 100, y: 75, width: 100, height: 50))
        XCTAssertEqual(zoom.rect, CGRect(x: 50, y: 50, width: 100, height: 50))
        // The crop is 200×100 full pixels: twice what the model saw.
        XCTAssertEqual(zoom.width, 200)
        XCTAssertEqual(zoom.height, 100)
        XCTAssertFalse(zoom.png.isEmpty)

        // Near the edge the region slides inside the image instead of falling off.
        let corner = try XCTUnwrap(ComputerUseService.zoom(shot, x: 0, y: 0, width: 100, height: 50))
        XCTAssertEqual(corner.rect.origin, .zero)
        // Oversized requests are clamped to the image.
        let huge = try XCTUnwrap(ComputerUseService.zoom(shot, x: 100, y: 75, width: 5000, height: 5000))
        XCTAssertEqual(huge.rect, CGRect(x: 0, y: 0, width: 200, height: 150))
    }

    func testAppResolverFindsNestedAndBundleIDs() {
        XCTAssertEqual(AppResolver.resolve(name: "Activity Monitor")?.url.lastPathComponent, "Activity Monitor.app")
        XCTAssertEqual(AppResolver.resolve(name: "com.apple.Notes")?.url.lastPathComponent, "Notes.app")
        XCTAssertEqual(AppResolver.resolve(name: "com.apple.Notes")?.bundleID, "com.apple.Notes")
    }

    func testGlideIsVisibleButBounded() {
        XCTAssertEqual(EventActuator.glideDuration(distance: 0, pace: 1), 0)
        XCTAssertEqual(EventActuator.glideDuration(distance: 400, pace: 0), 0)
        let short = EventActuator.glideDuration(distance: 40, pace: 1)
        let medium = EventActuator.glideDuration(distance: 500, pace: 1)
        let far = EventActuator.glideDuration(distance: 3000, pace: 1)
        XCTAssertEqual(short, 0.12, accuracy: 0.001)
        XCTAssertGreaterThan(medium, short)
        XCTAssertEqual(far, 0.35, accuracy: 0.001)
        XCTAssertEqual(EventActuator.glideDuration(distance: 500, pace: 0.45), medium * 0.45, accuracy: 0.001)

        let points = EventActuator.glidePoints(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: 50), steps: 10)
        XCTAssertEqual(points.count, 10)
        XCTAssertEqual(points.last, CGPoint(x: 100, y: 50))
        // Eased: the first step is short, the middle step is the longest.
        XCTAssertLessThan(points[0].x, 5)
        XCTAssertGreaterThan(points[5].x - points[4].x, points[1].x - points[0].x)
        XCTAssertTrue(points.map(\.x).elementsEqual(points.map(\.x).sorted()))
    }

    func testSDEFSummaryListsClassesAndCommands() {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <dictionary>
          <suite name="Standard Suite" code="????">
            <command name="open" code="aevtodoc"><direct-parameter type="file"/></command>
            <command name="quit" code="aevtquit"/>
            <class name="application" code="capp"><property name="name" code="pnam" type="text"/></class>
          </suite>
          <suite name="Notes Suite" code="note">
            <class name="note" code="note" plural="notes">
              <property name="name" code="pnam" type="text"/>
              <property name="body" code="body" type="text"/>
              <property name="secret" code="scrt" type="text" hidden="yes"/>
              <element type="attachment"/>
            </class>
            <class name="folder" code="fold"><property name="name" code="pnam" type="text"/><element type="note"/></class>
            <command name="show" code="noteshow"><direct-parameter type="note"/></command>
            <command name="make" code="corecrel"><parameter name="new" code="kocl" type="type"/><parameter name="with properties" code="prdt" type="record"/></command>
          </suite>
        </dictionary>
        """.data(using: .utf8)!
        let summary = ScriptHints.summarize(sdefXML: xml)
        XCTAssertTrue(summary.contains("Standard Suite commands: open, quit"), summary)
        XCTAssertTrue(summary.contains("note (name, body; contains attachment)"), summary)
        XCTAssertFalse(summary.contains("secret"), summary)
        XCTAssertTrue(summary.contains("show [note]"), summary)
        XCTAssertTrue(summary.contains("make [new, with properties]"), summary)
        XCTAssertEqual(ScriptHints.summarize(sdefXML: Data("not xml".utf8)), "")
    }

    func testSDEFOfARealScriptableApp() async {
        let notes = URL(fileURLWithPath: "/System/Applications/Notes.app")
        guard FileManager.default.fileExists(atPath: notes.path) else { return }
        let summary = await ScriptHints.summary(appURL: notes)
        XCTAssertTrue(summary.lowercased().contains("note"), summary)
        XCTAssertLessThanOrEqual(summary.count, ScriptHints.maxLength + 1)
        // Cached: the second call is instant and identical.
        let again = await ScriptHints.summary(appURL: notes)
        XCTAssertEqual(again, summary)
    }

    func testScriptActionDecodesLanguageAlias() throws {
        let json = #"{"type":"script","language":"shell","script":"echo hi","say":"running"}"#.data(using: .utf8)!
        let action = try JSONDecoder().decode(ComputerAction.self, from: json)
        XCTAssertEqual(action.type, "script")
        XCTAssertEqual(action.lang, "shell")
        XCTAssertEqual(action.script, "echo hi")
        XCTAssertEqual(action.target, nil)
    }

    func testScriptBlocksDestruction() async {
        let result = await ScriptActuator.run(language: "shell", source: "rm -rf /")
        XCTAssertTrue(result.contains("blocked"), result)
        let sudo = await ScriptActuator.run(language: "shell", source: "sudo reboot")
        XCTAssertTrue(sudo.contains("blocked"), sudo)
    }

    func testScriptRunsShellAndAppleScript() async {
        let shell = await ScriptActuator.run(language: "shell", source: "echo okidoki-script-ok")
        XCTAssertTrue(shell.contains("okidoki-script-ok"), shell)
        let apple = await ScriptActuator.run(language: "applescript", source: "return \"okidoki-as-ok\"")
        XCTAssertTrue(apple.contains("okidoki-as-ok"), apple)
        let jxa = await ScriptActuator.run(language: "javascript", source: "function run() { return 'okidoki-jxa-ok'; }")
        XCTAssertTrue(jxa.contains("okidoki-jxa-ok"), jxa)
    }
}
