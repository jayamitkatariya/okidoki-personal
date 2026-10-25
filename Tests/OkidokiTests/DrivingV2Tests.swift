import XCTest
@testable import OkidokiCore

final class DrivingV2Tests: XCTestCase {
    func testNewerModelsSeeTheDisplayAtOnePixelPerPoint() {
        let hi = ComputerUseService.ImageLimits.forModel("claude-haiku-5-5")
        XCTAssertEqual(hi, .highResolution)
        XCTAssertEqual(ComputerUseService.ImageLimits.forModel("claude-sonnet-5-5"), .highResolution)
        XCTAssertEqual(ComputerUseService.ImageLimits.forModel("claude-haiku-4-5"), .standard)

        // A 14" MacBook at its default scaling: 1512×982 points on a 3024×1964 panel.
        let laptop = ComputerUseService.sendSize(pixelWidth: 3024, pixelHeight: 1964, pointWidth: 1512, pointHeight: 982, limits: hi)
        XCTAssertEqual(laptop.width, 1512)
        XCTAssertEqual(laptop.height, 982)

        // A 1440p display fills the visual-token budget exactly.
        let monitor = ComputerUseService.sendSize(pixelWidth: 5120, pixelHeight: 2880, pointWidth: 2560, pointHeight: 1440, limits: hi)
        XCTAssertEqual(monitor.width, 2560)
        XCTAssertEqual(monitor.height, 1440)

        // Bigger than the long edge or the token budget: shrunk to fit both.
        let studio = ComputerUseService.sendSize(pixelWidth: 6016, pixelHeight: 3384, pointWidth: 3008, pointHeight: 1692, limits: hi)
        XCTAssertLessThanOrEqual(studio.width, 2576)
        let tokens = Int((Double(studio.width) / 28).rounded(.up)) * Int((Double(studio.height) / 28).rounded(.up))
        XCTAssertLessThanOrEqual(tokens, 4784)
        XCTAssertGreaterThan(studio.width, 2300)

        // Older models keep the old limits.
        let old = ComputerUseService.sendSize(pixelWidth: 3024, pixelHeight: 1964, pointWidth: 1512, pointHeight: 982, limits: .standard)
        XCTAssertLessThan(Double(old.width * old.height), 1_150_001)
        XCTAssertLessThan(old.width, 1512)
    }

    func testScreenChangeIgnoresTinyNoiseAndSeesSmallControls() {
        let w = 256, h = 160
        let base = ScreenSample(width: w, height: h, pixels: Array(repeating: 200, count: w * h))
        XCTAssertFalse(ScreenSampler.compare(base, base).changed)

        // A blinking caret: a 1-point line is about half a sample pixel wide, so half its contrast, a few rows tall.
        var caret = base.pixels
        for y in 20..<27 { caret[y * w + 40] = 100 }
        XCTAssertFalse(ScreenSampler.compare(base, ScreenSample(width: w, height: h, pixels: caret)).changed)

        // A checkbox: a few pixels square.
        var box = base.pixels
        for y in 50..<54 { for x in 60..<64 { box[y * w + x] = 20 } }
        let small = ScreenSampler.compare(base, ScreenSample(width: w, height: h, pixels: box))
        XCTAssertTrue(small.changed)
        XCTAssertFalse(small.large)

        // A window covering half the screen.
        var window = base.pixels
        for y in 0..<h { for x in 0..<(w / 2) { window[y * w + x] = 30 } }
        let big = ScreenSampler.compare(base, ScreenSample(width: w, height: h, pixels: window))
        XCTAssertTrue(big.changed)
        XCTAssertTrue(big.large)

        // Different sizes can't be compared: treat as changed.
        XCTAssertTrue(ScreenSampler.compare(base, ScreenSample(width: 10, height: 10, pixels: Array(repeating: 0, count: 100))).large)
    }

    func testScriptTargetsAreFound() {
        XCTAssertEqual(ScriptActuator.targets(of: #"tell application "Notes" to make new note"#), ["Notes"])
        XCTAssertEqual(ScriptActuator.targets(of: """
            tell application "System Events"
              tell process "Safari" to click menu item "New Private Window" of menu "File" of menu bar 1
            end tell
            """), ["System Events"])
        XCTAssertEqual(ScriptActuator.targets(of: #"tell app id "com.apple.finder" to activate"#), ["com.apple.finder"])
        XCTAssertEqual(ScriptActuator.targets(of: #"const f = Application('Finder'); Application("Notes").activate()"#).sorted(), ["Finder", "Notes"])
        XCTAssertEqual(ScriptActuator.targets(of: "set volume output volume 30"), [])
        XCTAssertEqual(ScriptActuator.bundleID(forScriptTarget: "System Events"), "com.apple.systemevents")
        XCTAssertEqual(ScriptActuator.bundleID(forScriptTarget: "com.apple.Safari"), "com.apple.Safari")
    }

    func testInvisibleMarksAreDroppedFromAppNames() {
        XCTAssertEqual(AppResolver.visible("\u{200E}WhatsApp"), "WhatsApp")
        XCTAssertEqual(AppResolver.normalize("\u{200E}WhatsApp"), "whatsapp")
        XCTAssertEqual(AppResolver.visible("Notes"), "Notes")
    }

    func testV2ActionsDecodeTheirToolCall() throws {
        let json = #"{"id":"toolu_1","tool":"click_element","member":false,"type":"click_element","element":7,"button":"right","times":2}"#
        let act = try JSONDecoder().decode(ComputerAction.self, from: Data(json.utf8))
        XCTAssertEqual(act.toolUseID, "toolu_1")
        XCTAssertEqual(act.tool, "click_element")
        XCTAssertEqual(act.member, false)
        XCTAssertEqual(act.element, 7)
        XCTAssertEqual(act.button, "right")
        XCTAssertEqual(act.times, 2)
        let drag = try JSONDecoder().decode(ComputerAction.self, from: Data(#"{"id":"t","type":"drag","from_x":1,"from_y":2,"to_x":3,"to_y":4,"member":true}"#.utf8))
        XCTAssertEqual(drag.fromX, 1)
        XCTAssertEqual(drag.toY, 4)
        XCTAssertEqual(drag.member, true)
        // Round trip keeps the id, so the history and results can name the call.
        let again = try JSONDecoder().decode(ComputerAction.self, from: JSONEncoder().encode(act))
        XCTAssertEqual(again, act)
    }

    func testTelemetryIsSavedAndOldRunsArePruned() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-telemetry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        var t = DriveTelemetry(runID: "run/1", goal: "do it", protocolVersion: "v2", model: "claude-haiku-5-5")
        t.calls.append(.init(index: 0, model: "claude-haiku-5-5", captureMs: 40, contextMs: 90, brainMs: 1800, modelMs: 1700,
                             requestBytes: 300_000, actions: 3, stopReason: "tool_use",
                             usage: .init(input: 900, cacheRead: 6000, cacheWrite: 0, output: 80)))
        t.actions.append(.init(call: 0, type: "click", performMs: 120, settleMs: 200, changed: true, ok: true, result: "pressed “Send”"))
        t.endedAt = t.startedAt.addingTimeInterval(2.5)
        t.outcome = "done"
        XCTAssertTrue(DriveTelemetryStore.save(t, in: dir))
        let loaded = try XCTUnwrap(DriveTelemetryStore.load("run/1", in: dir))
        XCTAssertEqual(loaded.calls.first?.usage?.cacheRead, 6000)
        XCTAssertEqual(loaded.actions.first?.changed, true)
        XCTAssertEqual(loaded.totalMs, 2500)
        XCTAssertEqual(DriveTelemetryStore.saveFrame(Data([0xFF, 0xD8]), runID: "run/1", ext: "jpg", in: dir), "run_1-final.jpg")
    }
}
