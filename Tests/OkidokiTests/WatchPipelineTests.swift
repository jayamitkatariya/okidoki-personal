import XCTest
import AppKit
import Carbon.HIToolbox
@testable import OkidokiCore

/// Drives the recorder's event handlers directly, the way the global monitors do, and checks
/// the steps that come out — the same steps the dashboard shows and the replayer plays back.
@MainActor
final class WatchPipelineTests: XCTestCase {
    private var recorder: WatchRecorder!
    private var front = "Finder"
    private var labels: [String: String] = [:]

    override func setUp() {
        super.setUp()
        recorder = WatchRecorder()
        recorder.watchesSystem = false
        front = "Finder"
        labels = [:]
        recorder.frameProvider = nil
        recorder.frameSession = nil
        recorder.frontAppProvider = { [unowned self] in self.front }
        recorder.labelProvider = { [unowned self] point in self.labels["\(Int(point.x)),\(Int(point.y))"] ?? "" }
        recorder.typingIdle = 0.05
        recorder.scrollIdle = 0.05
    }

    private func key(_ code: Int, _ chars: String, flags: NSEvent.ModifierFlags = [], repeated: Bool = false) {
        recorder.keyDown(keyCode: UInt16(code), flags: flags, chars: chars, plain: chars.lowercased(), repeated: repeated)
    }

    private func typeText(_ text: String) {
        for character in text {
            let s = String(character)
            key(Int(kVK_ANSI_A), s)
        }
    }

    private func finish() -> [WatchedStep] {
        var out: [WatchedStep] = []
        recorder.onFinish = { out = $0 }
        recorder.stop()
        return out
    }

    // MARK: Clicks

    func testClickRecordsLabelAndQuartzPoint() {
        labels["100,200"] = "Downloads"
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 100, y: 200), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 101, y: 201))
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].action, "click")
        XCTAssertEqual(steps[0].label, "Downloads")
        XCTAssertEqual(steps[0].detail, "in Finder, click “Downloads”")
        XCTAssertEqual(steps[0].x, 100)
        XCTAssertEqual(steps[0].y, 200)
        XCTAssertEqual(steps[0].step.label, "Downloads")
        XCTAssertEqual(steps[0].step.action, "click")
    }

    func testUnlabelledClickFallsBackToCoordinates() {
        recorder.start()
        recorder.mouseDown(type: .rightMouseDown, at: CGPoint(x: 30, y: 40), clickCount: 1)
        let steps = finish()
        XCTAssertEqual(steps[0].action, "right-click")
        XCTAssertEqual(steps[0].detail, "in Finder, right-click at 30, 40")
        XCTAssertNil(steps[0].step.label)
    }

    func testDoubleAndTripleClickFoldIntoOneStep() {
        labels["10,10"] = "report.pdf"
        recorder.start()
        let p = CGPoint(x: 10, y: 10)
        recorder.mouseDown(type: .leftMouseDown, at: p, clickCount: 1)
        recorder.mouseUp(at: p)
        recorder.mouseDown(type: .leftMouseDown, at: p, clickCount: 2)
        recorder.mouseUp(at: p)
        recorder.mouseDown(type: .leftMouseDown, at: p, clickCount: 3)
        recorder.mouseUp(at: p)
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].action, "double-click")
        XCTAssertEqual(steps[0].detail, "in Finder, double-click “report.pdf”")
    }

    func testTwoSeparateClicksStaySeparate() {
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 10, y: 10), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 10, y: 10))
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 300, y: 300), clickCount: 2)
        recorder.mouseUp(at: CGPoint(x: 300, y: 300))
        let steps = finish()
        // A click-count of 2 far away from the last click is a new click, not a double.
        XCTAssertEqual(steps.map(\.action), ["click", "click"])
    }

    func testDragUpgradesTheClick() {
        labels["50,50"] = "photo.jpg"
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 50, y: 50), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 400, y: 420))
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].action, "drag")
        XCTAssertEqual(steps[0].toX, 400)
        XCTAssertEqual(steps[0].toY, 420)
        XCTAssertEqual(steps[0].detail, "in Finder, drag “photo.jpg” to 400, 420")
    }

    func testTinyMouseMovementIsNotADrag() {
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 50, y: 50), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 55, y: 54))
        XCTAssertEqual(finish()[0].action, "click")
    }

    // MARK: Keyboard

    func testTypingCoalescesUntilAClick() {
        recorder.start()
        typeText("hello world")
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 1, y: 1), clickCount: 1)
        let steps = finish()
        XCTAssertEqual(steps.map(\.action), ["type", "click"])
        XCTAssertEqual(steps[0].input, "hello world")
        XCTAssertEqual(steps[0].detail, "in Finder, type “hello world”")
    }

    func testTypingFlushesOnStop() {
        recorder.start()
        typeText("abc")
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].input, "abc")
    }

    func testTypingFlushesAfterIdle() {
        recorder.start()
        typeText("one")
        let flushed = expectation(description: "idle flush")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { flushed.fulfill() }
        wait(for: [flushed], timeout: 1)
        typeText("two")
        let steps = finish()
        XCTAssertEqual(steps.map(\.input), ["one", "two"])
    }

    func testLongTypingIsElidedInTheSentenceButKeptInFull() {
        recorder.start()
        let text = String(repeating: "x", count: 60)
        typeText(text)
        let steps = finish()
        XCTAssertEqual(steps[0].input, text)
        XCTAssertTrue(steps[0].detail.hasSuffix("…”"))
        XCTAssertLessThan(steps[0].detail.count, 70)
    }

    func testShortcutsAndSpecialKeysBreakTyping() {
        recorder.start()
        typeText("name")
        key(Int(kVK_Return), "\r")
        key(Int(kVK_ANSI_S), "s", flags: [.command])
        key(Int(kVK_Tab), "\t", flags: [.shift])
        let steps = finish()
        XCTAssertEqual(steps.map(\.action), ["type", "key", "key", "key"])
        XCTAssertEqual(steps.map(\.input), ["name", "return", "cmd+s", "shift+tab"])
        XCTAssertEqual(steps[2].detail, "in Finder, press ⌘S")
    }

    func testArrowKeysWithFunctionFlagAreKeysNotTyping() {
        recorder.start()
        key(Int(kVK_DownArrow), "\u{F701}", flags: [.function, .numericPad])
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].input, "down")
    }

    func testUnnamedFunctionKeysAreIgnored() {
        recorder.start()
        key(Int(kVK_F13), "\u{F710}", flags: [.function])
        key(Int(kVK_Help), "\u{F746}", flags: [.function])
        XCTAssertTrue(finish().isEmpty)
    }

    func testKeyRepeatOnlyCountsWhileTyping() {
        recorder.start()
        key(Int(kVK_ANSI_A), "a", repeated: true)   // held key before any typing: dropped
        typeText("b")
        key(Int(kVK_ANSI_B), "b", repeated: true)   // repeat mid-word: kept
        XCTAssertEqual(finish()[0].input, "bb")
    }

    func testTypingSplitsAcrossApps() {
        recorder.start()
        typeText("ab")
        front = "Safari"
        typeText("cd")
        let steps = finish()
        XCTAssertEqual(steps.map(\.input), ["ab", "cd"])
        XCTAssertEqual(steps.map(\.app), ["Finder", "Safari"])
    }

    // MARK: Scroll

    func testScrollCoalescesAndKeepsDeviceDelta() {
        recorder.start()
        let p = CGPoint(x: 500, y: 600)
        // Natural scrolling: shown delta is the opposite of what the device sent.
        recorder.scrolled(at: p, shown: -30, device: 30)
        recorder.scrolled(at: p, shown: -30, device: 30)
        recorder.scrolled(at: CGPoint(x: 504, y: 602), shown: -20, device: 20)
        let steps = finish()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].action, "scroll")
        XCTAssertEqual(steps[0].toY, 80)
        XCTAssertEqual(steps[0].x, 500)
        XCTAssertEqual(steps[0].detail, "in Finder, scroll down")
    }

    func testTinyScrollIsDropped() {
        recorder.start()
        recorder.scrolled(at: .zero, shown: 1, device: 1)
        XCTAssertTrue(finish().isEmpty)
    }

    func testScrollThenTypeOrdersCorrectly() {
        recorder.start()
        recorder.scrolled(at: .zero, shown: 50, device: 50)
        typeText("q")
        let steps = finish()
        XCTAssertEqual(steps.map(\.action), ["scroll", "type"])
    }

    // MARK: App switches

    func testAppSwitchRecordedImmediatelyAfterStart() {
        recorder.start()
        recorder.appSwitched(to: "Safari", own: false)
        let steps = finish()
        XCTAssertEqual(steps.map(\.action), ["switch"])
        XCTAssertEqual(steps[0].detail, "switch to Safari")
    }

    func testOwnAppAndSameAppSwitchesIgnored() {
        recorder.start()
        recorder.appSwitched(to: "Okidoki", own: true)
        recorder.appSwitched(to: "Finder", own: false) // already front at start
        XCTAssertTrue(finish().isEmpty)
    }

    func testRapidBounceBackIsThrottled() {
        recorder.start()
        recorder.appSwitched(to: "Safari", own: false)
        recorder.appSwitched(to: "Finder", own: false) // within 0.6s
        XCTAssertEqual(finish().count, 1)
    }

    // MARK: Timing + lifecycle

    func testDelaysAreNonNegativeAndRelative() {
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: .zero, clickCount: 1)
        let waited = expectation(description: "gap")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { waited.fulfill() }
        wait(for: [waited], timeout: 1)
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 900, y: 900), clickCount: 1)
        let steps = finish()
        XCTAssertGreaterThanOrEqual(steps[0].delay, 0)
        XCTAssertGreaterThanOrEqual(steps[1].delay, 0.1)
        XCTAssertLessThan(steps[1].delay, 1)
    }

    func testEventsAfterStopAreIgnored() {
        recorder.start()
        _ = finish()
        recorder.mouseDown(type: .leftMouseDown, at: .zero, clickCount: 1)
        typeText("x")
        recorder.scrolled(at: .zero, shown: 100, device: 100)
        recorder.appSwitched(to: "Safari", own: false)
        XCTAssertTrue(recorder.steps.isEmpty)
    }

    func testCancelDropsBufferedTypingToo() {
        recorder.start()
        typeText("secret")
        recorder.cancel()
        XCTAssertTrue(recorder.steps.isEmpty)
        // A fresh start doesn't leak the old buffer.
        recorder.start()
        XCTAssertTrue(finish().isEmpty)
    }

    func testRestartClearsEverything() {
        recorder.start(name: "first")
        recorder.mouseDown(type: .leftMouseDown, at: .zero, clickCount: 1)
        _ = finish()
        recorder.start(name: "second")
        XCTAssertEqual(recorder.pendingName, "second")
        XCTAssertTrue(recorder.steps.isEmpty)
        recorder.appSwitched(to: "Mail", own: false)
        XCTAssertEqual(finish().count, 1)
    }

    func testStepIdsStayStableAcrossConversions() {
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: .zero, clickCount: 1)
        let first = recorder.steps.map(\.step.id)
        let second = recorder.steps.map(\.step.id)
        XCTAssertEqual(first, second)
    }

    // MARK: A whole recording, as the replayer will see it

    func testRealisticFlowProducesReplayableSteps() {
        labels["640,60"] = "Address and Search"
        labels["900,760"] = "Empty Trash"
        recorder.start(name: "demo")
        recorder.appSwitched(to: "Safari", own: false)
        front = "Safari"
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 640, y: 60), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 640, y: 60))
        typeText("weather")
        key(Int(kVK_Return), "\r")
        recorder.scrolled(at: CGPoint(x: 700, y: 500), shown: -200, device: 200)
        front = "Finder"
        recorder.appSwitched(to: "Finder", own: false)
        // throttle: the Finder switch above may land inside 0.6s of the Safari one; wait it out
        let waited = expectation(description: "gap")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { waited.fulfill() }
        wait(for: [waited], timeout: 2)
        recorder.appSwitched(to: "Finder", own: false)
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 900, y: 760), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 900, y: 760))
        let steps = finish().map(\.step)

        XCTAssertEqual(steps.map(\.action), ["switch", "click", "type", "key", "scroll", "switch", "click"])
        XCTAssertEqual(SkillReplayGeometry.targetLabel(steps[1]), "Address and Search")
        XCTAssertEqual(SkillReplayGeometry.recordedPoint(steps[1], mainDisplayHeight: 1000), CGPoint(x: 640, y: 60))
        XCTAssertEqual(steps[2].input, "weather")
        XCTAssertEqual(steps[3].input, "return")
        XCTAssertEqual(steps[4].toY, 200)
        XCTAssertEqual(steps[5].app, "Finder")
        XCTAssertEqual(SkillReplayGeometry.targetLabel(steps[6]), "Empty Trash")
        for step in steps { XCTAssertFalse(step.text.isEmpty) }
    }
}

final class SkillReplayGeometryTests: XCTestCase {
    func testLegacyStepPullsLabelFromQuotesAndFlipsY() {
        let legacy = SkillStep(text: "in Finder, click “Downloads”", app: "Finder", x: 100, y: 300)
        XCTAssertEqual(SkillReplayGeometry.targetLabel(legacy), "Downloads")
        XCTAssertEqual(SkillReplayGeometry.recordedPoint(legacy, mainDisplayHeight: 1000), CGPoint(x: 100, y: 700))
    }

    func testLegacyStepWithoutQuotesHasNoLabel() {
        let legacy = SkillStep(text: "open Downloads", app: "Finder", x: 1, y: 2)
        XCTAssertEqual(SkillReplayGeometry.targetLabel(legacy), "")
    }

    func testNewStepIsNotFlippedAndIgnoresSentence() {
        let step = SkillStep(text: "in Finder, click “Trash”", app: "Finder", x: 100, y: 300, action: "click", label: nil)
        XCTAssertEqual(SkillReplayGeometry.targetLabel(step), "")
        XCTAssertEqual(SkillReplayGeometry.recordedPoint(step, mainDisplayHeight: 1000), CGPoint(x: 100, y: 300))
    }

    func testMissingPointIsNil() {
        XCTAssertNil(SkillReplayGeometry.recordedPoint(SkillStep(text: "type", app: "a", action: "type"), mainDisplayHeight: 1000))
    }

    func testPauseIsClamped() {
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", delay: 0.01)), 0.45)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", delay: 90)), 2.5)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "", delay: 1.2)), 1.2)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "")), 0.6)
    }

    func testClickShape() {
        XCTAssertEqual(SkillReplayGeometry.clickShape("double-click").count, 2)
        XCTAssertEqual(SkillReplayGeometry.clickShape("right-click").button, "right")
        XCTAssertEqual(SkillReplayGeometry.clickShape("middle-click").button, "middle")
        XCTAssertEqual(SkillReplayGeometry.clickShape(nil).button, "left")
        XCTAssertEqual(SkillReplayGeometry.clickShape(nil).count, 1)
    }

    func testPlaceholderAppsAreNotActivated() {
        XCTAssertFalse(SkillReplayGeometry.isRealApp(""))
        XCTAssertFalse(SkillReplayGeometry.isRealApp("mac"))
        XCTAssertFalse(SkillReplayGeometry.isRealApp("app"))
        XCTAssertTrue(SkillReplayGeometry.isRealApp("Finder"))
    }
}
