import XCTest
import AppKit
import Carbon.HIToolbox
@testable import OkidokiCore

final class WatchRecorderTests: XCTestCase {

    // MARK: Key naming

    func testComboNameOrdersModifiersAndLowercasesKey() {
        let name = WatchRecorder.comboName(keyCode: UInt16(kVK_ANSI_S), flags: [.command, .shift], plain: "S")
        XCTAssertEqual(name, "shift+cmd+s")
        XCTAssertEqual(WatchRecorder.prettyCombo(name), "⇧⌘S")
    }

    func testComboNamePrefersSpecialKeyNames() {
        XCTAssertEqual(WatchRecorder.comboName(keyCode: UInt16(kVK_Return), flags: [], plain: "\r"), "return")
        XCTAssertEqual(WatchRecorder.comboName(keyCode: UInt16(kVK_Tab), flags: [.shift], plain: "\t"), "shift+tab")
        XCTAssertEqual(WatchRecorder.comboName(keyCode: UInt16(kVK_LeftArrow), flags: [.function, .numericPad], plain: ""), "left")
        XCTAssertEqual(WatchRecorder.comboName(keyCode: UInt16(kVK_Space), flags: [.command], plain: " "), "cmd+space")
    }

    func testUnknownCharacterFallsBackToRawKeyCode() {
        // ⌘⇧3 reports "#" as the modifier-ignoring character on a US layout; that's not in the table.
        let name = WatchRecorder.comboName(keyCode: UInt16(kVK_ANSI_3), flags: [.command, .shift], plain: "#")
        XCTAssertEqual(name, "shift+cmd+key\(kVK_ANSI_3)")
        XCTAssertEqual(WatchRecorder.prettyCombo(name), "⇧⌘key \(kVK_ANSI_3)")
    }

    func testPrettyComboSymbols() {
        XCTAssertEqual(WatchRecorder.prettyCombo("cmd+delete"), "⌘⌫")
        XCTAssertEqual(WatchRecorder.prettyCombo("ctrl+alt+escape"), "⌃⌥esc")
        XCTAssertEqual(WatchRecorder.prettyCombo("pagedown"), "page down")
    }

    func testSpecialKeyNamesCoverNavigationKeys() {
        XCTAssertEqual(WatchRecorder.specialKeyName(UInt16(kVK_Escape)), "escape")
        XCTAssertEqual(WatchRecorder.specialKeyName(UInt16(kVK_ForwardDelete)), "forwarddelete")
        XCTAssertEqual(WatchRecorder.specialKeyName(UInt16(kVK_F5)), "f5")
        XCTAssertNil(WatchRecorder.specialKeyName(UInt16(kVK_ANSI_A)))
    }

    func testKnownKeysMatchWhatPressCanPost() {
        for key in ["a", "z", "0", "9", ",", "/", "space", "return", "escape", "f12", "pageup"] {
            XCTAssertTrue(AccessibilityActions.knowsKey(key), key)
        }
        XCTAssertFalse(AccessibilityActions.knowsKey("#"))
        XCTAssertFalse(AccessibilityActions.knowsKey("hyper"))
    }

    // MARK: Steps

    func testWatchedStepKeepsItsIdentityWhenConvertedRepeatedly() {
        let watched = WatchedStep(app: "Finder", action: "click", detail: "in Finder, click “Downloads”",
                                  label: "Downloads", x: 10, y: 20, delay: 0.8)
        XCTAssertEqual(watched.step.id, watched.step.id)
        XCTAssertEqual(watched.step.id, watched.id.uuidString)
    }

    func testWatchedStepDropsEmptyHandles() {
        let step = WatchedStep(app: "Safari", action: "type", detail: "in Safari, type “hi”", label: "", input: "hi").step
        XCTAssertNil(step.label)
        XCTAssertEqual(step.input, "hi")
        XCTAssertEqual(step.action, "type")
        XCTAssertEqual(step.app, "Safari")
    }

    func testLegacySkillStepDecodesWithoutNewFields() throws {
        let json = #"{"id":"s1","text":"open Downloads","app":"Finder","x":660,"y":420}"#
        let step = try JSONDecoder().decode(SkillStep.self, from: Data(json.utf8))
        XCTAssertEqual(step.text, "open Downloads")
        XCTAssertNil(step.action)
        XCTAssertNil(step.label)
        XCTAssertNil(step.delay)
        XCTAssertEqual(step.x, 660)
    }

    func testSkillStepRoundTripsNewFields() throws {
        let original = SkillStep(text: "in Finder, drag “a” to 1, 2", app: "Finder", x: 1, y: 2,
                                 action: "drag", label: "a", input: nil, toX: 3, toY: 4, delay: 1.5)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SkillStep.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    // MARK: Recorder lifecycle

    @MainActor
    func testStartStopWithoutEventsFinishesEmpty() {
        let recorder = WatchRecorder()
        var finished: [WatchedStep]?
        recorder.onFinish = { finished = $0 }
        recorder.start(name: "demo")
        XCTAssertTrue(recorder.isRecording)
        XCTAssertEqual(recorder.pendingName, "demo")
        XCTAssertNotNil(recorder.startedAt)
        recorder.stop()
        XCTAssertFalse(recorder.isRecording)
        XCTAssertEqual(finished?.count, 0)
        // Stopping twice is harmless and doesn't fire again.
        finished = nil
        recorder.stop()
        XCTAssertNil(finished)
    }

    @MainActor
    func testCancelDoesNotFinish() {
        let recorder = WatchRecorder()
        var fired = false
        recorder.onFinish = { _ in fired = true }
        recorder.start()
        recorder.cancel()
        XCTAssertFalse(recorder.isRecording)
        XCTAssertFalse(fired)
        XCTAssertTrue(recorder.steps.isEmpty)
    }
}
