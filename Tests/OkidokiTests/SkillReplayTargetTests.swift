import XCTest
@testable import OkidokiCore

/// How a recorded click is found again when the window moved, the Dock reordered, or the
/// skill was saved before those details were recorded at all.
@MainActor
final class SkillReplayTargetTests: XCTestCase {
    // MARK: Carrying a point along with its window

    func testMovedWindowCarriesThePointWithIt() {
        let was = CGRect(x: 100, y: 100, width: 800, height: 600)
        let now = CGRect(x: 400, y: 250, width: 800, height: 600)
        XCTAssertEqual(SkillReplayGeometry.translate(CGPoint(x: 150, y: 130), from: was, to: now), CGPoint(x: 450, y: 280))
    }

    func testResizedWindowKeepsEdgeOffsets() {
        let was = CGRect(x: 0, y: 0, width: 800, height: 600)
        let now = CGRect(x: 0, y: 0, width: 1200, height: 900)
        // Top-left toolbar button: same offset from the top-left.
        XCTAssertEqual(SkillReplayGeometry.translate(CGPoint(x: 40, y: 30), from: was, to: now), CGPoint(x: 40, y: 30))
        // Bottom-right "Send": same offset from the bottom-right.
        XCTAssertEqual(SkillReplayGeometry.translate(CGPoint(x: 770, y: 580), from: was, to: now), CGPoint(x: 1170, y: 880))
        // Right sidebar item: anchored to the right, top.
        XCTAssertEqual(SkillReplayGeometry.translate(CGPoint(x: 760, y: 100), from: was, to: now), CGPoint(x: 1160, y: 100))
    }

    func testShrunkWindowStaysInside() {
        let was = CGRect(x: 0, y: 0, width: 800, height: 600)
        let now = CGRect(x: 0, y: 0, width: 300, height: 200)
        let p = SkillReplayGeometry.translate(CGPoint(x: 390, y: 290), from: was, to: now)
        XCTAssertTrue(now.insetBy(dx: 0.5, dy: 0.5).contains(p))
    }

    // MARK: What counts as the same control

    func testLabelIsCheckedFirstThenRole() {
        let labelled = SkillStep(text: "click “Send”", app: "WhatsApp", x: 1, y: 1, action: "click", label: "Send", role: "AXButton")
        XCTAssertTrue(SkillReplayGeometry.matches(step: labelled, label: "send", role: "AXButton"))
        XCTAssertFalse(SkillReplayGeometry.matches(step: labelled, label: "Attach", role: "AXButton"))
        let unlabelled = SkillStep(text: "click at 1, 1", app: "WhatsApp", x: 1, y: 1, action: "click", role: "AXTextArea")
        XCTAssertTrue(SkillReplayGeometry.matches(step: unlabelled, label: "", role: "AXTextArea"))
        XCTAssertFalse(SkillReplayGeometry.matches(step: unlabelled, label: "", role: "AXButton"))
        let bare = SkillStep(text: "click at 1, 1", app: "WhatsApp", x: 1, y: 1, action: "click")
        XCTAssertFalse(SkillReplayGeometry.isCheckable(bare))
        XCTAssertTrue(SkillReplayGeometry.isCheckable(unlabelled))
    }

    func testSystemSurfacesAreNeverActivated() {
        XCTAssertTrue(SkillReplayGeometry.isSystemSurface("Dock"))
        XCTAssertFalse(SkillReplayGeometry.isRealApp("Dock"))
        XCTAssertTrue(SkillReplayGeometry.isRealApp("WhatsApp"))
    }

    // MARK: Recording the owner, role and window

    func testDockClickIsRememberedAsTheDocksEvenWhenAnotherAppIsInFront() {
        let recorder = WatchRecorder()
        recorder.frameProvider = nil
        recorder.frameSession = nil
        recorder.frontAppProvider = { "Finder" }
        recorder.targetProvider = { _ in WatchedTarget(label: "WhatsApp", owner: "Dock", role: "AXDockItem", window: nil) }
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 700, y: 1060), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 700, y: 1060))
        var steps: [WatchedStep] = []
        recorder.onFinish = { steps = $0 }
        recorder.stop()
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps[0].detail, "in Dock, click “WhatsApp”")
        let step = steps[0].step
        XCTAssertEqual(step.app, "Dock")
        // The owner is the app itself here, so it isn't stored twice; replay looks it up by `app`.
        XCTAssertNil(step.owner)
        XCTAssertEqual(step.role, "AXDockItem")
        XCTAssertNil(step.windowFrame)
    }

    func testInAppClickRemembersRoleAndWindowButNotARedundantOwner() {
        let recorder = WatchRecorder()
        recorder.frameProvider = nil
        recorder.frameSession = nil
        recorder.frontAppProvider = { "WhatsApp" }
        let window = CGRect(x: 120, y: 80, width: 900, height: 700)
        recorder.targetProvider = { _ in WatchedTarget(label: "", owner: "WhatsApp", role: "AXTextArea", window: window) }
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 600, y: 740), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 600, y: 740))
        var steps: [WatchedStep] = []
        recorder.onFinish = { steps = $0 }
        recorder.stop()
        let step = steps[0].step
        XCTAssertEqual(step.app, "WhatsApp")
        XCTAssertNil(step.owner)
        XCTAssertEqual(step.role, "AXTextArea")
        XCTAssertEqual(step.windowFrame, window)
    }

    func testSkillsSavedBeforeTheseFieldsStillDecode() throws {
        let json = """
        {"id":"s","text":"in Finder, click “Downloads”","app":"Finder","x":100,"y":200,"action":"click","label":"Downloads","delay":0.5}
        """
        let step = try JSONDecoder().decode(SkillStep.self, from: Data(json.utf8))
        XCTAssertEqual(step.label, "Downloads")
        XCTAssertNil(step.owner)
        XCTAssertNil(step.role)
        XCTAssertNil(step.windowFrame)
        XCTAssertTrue(SkillReplayGeometry.isCheckable(step))
        let roundTrip = try JSONDecoder().decode(SkillStep.self, from: JSONEncoder().encode(step))
        XCTAssertEqual(roundTrip, step)
    }
}
