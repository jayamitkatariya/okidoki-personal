import AppKit
import XCTest
@testable import OkidokiCore

/// Pictures saved with each recorded step, and the bits of replay policy around them.
@MainActor
final class SkillFramesTests: XCTestCase {
    private func image(_ w: Int = 40, _ h: Int = 30) -> CGImage {
        let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return context.makeImage()!
    }

    private func capture(at point: CGPoint) -> SkillFrames.Capture {
        SkillFrames.Capture(rect: CGRect(x: point.x - 110, y: point.y - 70, width: 220, height: 140), image: image(), point: point, at: Date())
    }

    // MARK: Model

    func testStepRemembersItsPictureAndWindowTitleAcrossEncoding() throws {
        let step = SkillStep(text: "in WhatsApp, click “Dad”", app: "WhatsApp", x: 300, y: 400, action: "click", label: "Dad",
                             role: "AXCell", window: CGRect(x: 0, y: 0, width: 900, height: 700), windowTitle: "WhatsApp",
                             frame: CGRect(x: 190, y: 330, width: 220, height: 140))
        let data = try JSONEncoder().encode(step)
        let back = try JSONDecoder().decode(SkillStep.self, from: data)
        XCTAssertEqual(back.frameRect, CGRect(x: 190, y: 330, width: 220, height: 140))
        XCTAssertEqual(back.winTitle, "WhatsApp")
        // Older skills decode with neither.
        let legacy = try JSONDecoder().decode(SkillStep.self, from: Data(#"{"id":"a","text":"click","app":"Finder"}"#.utf8))
        XCTAssertNil(legacy.frameRect)
        XCTAssertNil(legacy.winTitle)
        XCTAssertNil(SkillStep(text: "x", windowTitle: "").winTitle)
    }

    func testAppNamesLoseTheirInvisibleDirectionMarks() {
        XCTAssertEqual(SkillReplayGeometry.cleanAppName("\u{200E}WhatsApp"), "WhatsApp")
        XCTAssertEqual(SkillReplayGeometry.cleanAppName("\u{2068}Slack\u{2069} "), "Slack")
        XCTAssertTrue(SkillReplayGeometry.sameApp("\u{200E}WhatsApp", "whatsapp"))
        XCTAssertFalse(SkillReplayGeometry.sameApp("WhatsApp", "Slack"))
    }

    func testCheckableStepsWaitLessBetweenStepsBecauseTheyLookBeforeActing() {
        let blind = SkillStep(text: "click at 1, 1", app: "X", x: 1, y: 1, action: "click", delay: 4)
        XCTAssertEqual(SkillReplayGeometry.pause(for: blind), 2.5)
        let labelled = SkillStep(text: "click “Send”", app: "X", x: 1, y: 1, action: "click", label: "Send", delay: 4)
        XCTAssertEqual(SkillReplayGeometry.pause(for: labelled), 1.2)
        let pictured = SkillStep(text: "click at 1, 1", app: "X", x: 1, y: 1, action: "click", delay: 4, frame: CGRect(x: 0, y: 0, width: 220, height: 140))
        XCTAssertEqual(SkillReplayGeometry.pause(for: pictured), 1.2)
        XCTAssertEqual(SkillReplayGeometry.pause(for: SkillStep(text: "x", action: "click", label: "a", delay: 0.1)), 0.45)
    }

    func testCropStaysInsideTheDisplay() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let middle = SkillFrames.cropRect(around: CGPoint(x: 700, y: 450), in: display)
        XCTAssertEqual(middle, CGRect(x: 590, y: 380, width: 220, height: 140))
        let corner = SkillFrames.cropRect(around: CGPoint(x: 10, y: 890), in: display)
        XCTAssertEqual(corner, CGRect(x: 0, y: 760, width: 220, height: 140))
        XCTAssertTrue(display.contains(corner))
        // A display to the left of the main one has negative x.
        let left = SkillFrames.cropRect(around: CGPoint(x: -1430, y: 5), in: CGRect(x: -1440, y: 0, width: 1440, height: 900))
        XCTAssertEqual(left.origin, CGPoint(x: -1440, y: 0))
    }

    // MARK: Recording

    func testAClickSavesAPictureAndTheStepPointsAtIt() async {
        let recorder = WatchRecorder()
        recorder.watchesSystem = false
        recorder.frameSession = nil
        recorder.frontAppProvider = { "WhatsApp" }
        recorder.targetProvider = { _ in WatchedTarget(label: "Dad", owner: "WhatsApp", role: "AXCell", windowTitle: "WhatsApp") }
        var captured: [CGPoint] = []
        var saved: [String] = []
        recorder.frameProvider = { point in captured.append(point); return self.capture(at: point) }
        recorder.frameSaver = { _, id in saved.append(id); return true }
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 300, y: 400), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 300, y: 400))
        var finished: [WatchedStep]?
        recorder.onFinish = { finished = $0 }
        recorder.stop()
        // The picture is still being written: stop() waits for it rather than losing it.
        for _ in 0..<50 where finished == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(captured, [CGPoint(x: 300, y: 400)])
        XCTAssertEqual(finished?.count, 1)
        XCTAssertEqual(saved, [finished![0].id.uuidString])
        XCTAssertEqual(finished?[0].frame, CGRect(x: 190, y: 330, width: 220, height: 140))
        XCTAssertEqual(finished?[0].windowTitle, "WhatsApp")
        let step = finished![0].step
        XCTAssertEqual(step.frameRect, CGRect(x: 190, y: 330, width: 220, height: 140))
        XCTAssertEqual(step.winTitle, "WhatsApp")
    }

    func testEveryClickGetsItsOwnPictureAndADoubleClickKeepsTheFirst() async {
        let recorder = WatchRecorder()
        recorder.watchesSystem = false
        recorder.frameSession = nil
        recorder.frontAppProvider = { "Finder" }
        recorder.targetProvider = { _ in WatchedTarget(label: "Documents") }
        var captured: [CGPoint] = []
        recorder.frameProvider = { point in captured.append(point); return self.capture(at: point) }
        recorder.frameSaver = { _, _ in true }
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 100, y: 100), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 100, y: 100))
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 500, y: 500), clickCount: 1)
        recorder.mouseUp(at: CGPoint(x: 500, y: 500))
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 501, y: 500), clickCount: 2)
        var finished: [WatchedStep]?
        recorder.onFinish = { finished = $0 }
        recorder.stop()
        for _ in 0..<50 where finished == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(captured, [CGPoint(x: 100, y: 100), CGPoint(x: 500, y: 500)])
        XCTAssertEqual(finished?.map(\.action), ["click", "double-click"])
        XCTAssertEqual(finished?.compactMap(\.frame).count, 2)
    }

    func testWithoutScreenRecordingStepsSimplyHaveNoPicture() {
        let recorder = WatchRecorder()
        recorder.watchesSystem = false
        recorder.frameSession = nil
        recorder.frontAppProvider = { "Finder" }
        recorder.targetProvider = { _ in WatchedTarget(label: "Documents") }
        recorder.frameProvider = { _ in nil }
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 300, y: 400), clickCount: 1)
        var finished: [WatchedStep]?
        recorder.onFinish = { finished = $0 }
        recorder.stop()
        let wait = expectation(description: "finished")
        Task { for _ in 0..<50 where finished == nil { try? await Task.sleep(nanoseconds: 20_000_000) }; wait.fulfill() }
        waitForExpectations(timeout: 2)
        XCTAssertEqual(finished?.count, 1)
        XCTAssertNil(finished?[0].frame)
        XCTAssertNil(finished?[0].step.frameRect)
    }

    func testDiscardingARecordingRemovesItsPictures() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-frames-\(UUID().uuidString)")
        let previous = SkillFrames.directory
        SkillFrames.directory = directory
        defer { SkillFrames.directory = previous; try? FileManager.default.removeItem(at: directory) }
        let recorder = WatchRecorder()
        recorder.watchesSystem = false
        recorder.frameSession = nil
        recorder.frontAppProvider = { "Finder" }
        recorder.targetProvider = { _ in WatchedTarget(label: "Documents") }
        recorder.frameProvider = { point in self.capture(at: point) }
        // Real saver: writes a PNG under the temporary directory.
        recorder.start()
        recorder.mouseDown(type: .leftMouseDown, at: CGPoint(x: 300, y: 400), clickCount: 1)
        try await Task.sleep(nanoseconds: 300_000_000)
        let id = recorder.steps[0].id.uuidString
        XCTAssertTrue(SkillFrames.has(id))
        XCTAssertNotNil(SkillFrames.load(id))
        recorder.cancel()
        for _ in 0..<50 where SkillFrames.has(id) { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertFalse(SkillFrames.has(id))
    }
}
