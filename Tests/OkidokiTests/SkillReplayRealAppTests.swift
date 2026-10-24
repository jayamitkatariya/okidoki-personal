import AppKit
import ApplicationServices
import XCTest
@testable import OkidokiCore

/// Runs against real applications through accessibility: records a control the way the recorder
/// does, changes the screen (moves and resizes the window, uses another app's Dock item), and
/// checks that the resolver finds the same control again. Skipped when the test runner has no
/// Accessibility permission, since nothing can be looked up without it.
@MainActor
final class SkillReplayRealAppTests: XCTestCase {
    private var textEdit: NSRunningApplication?
    private var launchedTextEdit = false

    override func setUp() async throws {
        try await super.setUp()
        try XCTSkipUnless(AXIsProcessTrusted(), "needs Accessibility for the test runner")
        try XCTSkipIf(ProcessInfo.processInfo.environment["CI"] != nil, "no display on CI")
    }

    override func tearDown() async throws {
        if launchedTextEdit { textEdit?.terminate() }
        try await super.tearDown()
    }

    // MARK: Helpers

    private func openTextEdit() async throws -> (pid: pid_t, window: AXUIElement) {
        let running = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.apple.TextEdit" }
        if running == nil {
            launchedTextEdit = true
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", "TextEdit", "--args", "-NSQuitAlwaysKeepsWindows", "NO"]
            try process.run()
            process.waitUntilExit()
        }
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.TextEdit" }) {
                textEdit = app
                app.activate()
                if let window = frontWindow(pid: app.processIdentifier) { return (app.processIdentifier, window) }
                // A fresh TextEdit shows the open panel; a new document gives us a plain window.
                let newDoc = Process()
                newDoc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                newDoc.arguments = ["-e", "tell application \"TextEdit\" to make new document"]
                try? newDoc.run()
                newDoc.waitUntilExit()
            }
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        throw XCTSkip("TextEdit didn't come up")
    }

    private func frontWindow(pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var ref: CFTypeRef?
        for key in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if AXUIElementCopyAttributeValue(app, key as CFString, &ref) == .success, let ref,
               CFGetTypeID(ref) == AXUIElementGetTypeID() {
                return (ref as! AXUIElement)
            }
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] { return windows.first }
        return nil
    }

    private func set(_ window: AXUIElement, frame: CGRect) {
        var origin = frame.origin
        var size = frame.size
        if let value = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value) }
        if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value) }
    }

    /// First element with a label in the window, breadth-first: a toolbar button or a close box.
    private func someLabelledControl(in window: AXUIElement) -> (label: String, role: String, frame: CGRect)? {
        var queue = [window]
        var visited = 0
        while !queue.isEmpty, visited < 600 {
            let element = queue.removeFirst()
            visited += 1
            let role = AXSearch.stringAttribute(kAXRoleAttribute, of: element)
            let label = AccessibilityLabel.of(element)
            if element != window, !label.isEmpty, ["AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox"].contains(role),
               let frame = SkillTargetResolver.frame(of: element), frame.width < 200 {
                return (label, role, frame)
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] { queue.append(contentsOf: children) }
        }
        return nil
    }

    private func recordedTarget(at point: CGPoint) -> WatchedTarget {
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success, let element else { return WatchedTarget() }
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        var windowRef: CFTypeRef?
        var window: CGRect?
        if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
           let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID() {
            window = SkillTargetResolver.frame(of: windowRef as! AXUIElement)
        }
        return WatchedTarget(label: AccessibilityLabel.of(element),
                             owner: NSRunningApplication(processIdentifier: pid)?.localizedName ?? "",
                             role: AXSearch.stringAttribute(kAXRoleAttribute, of: element), window: window)
    }

    // MARK: Tests

    func testControlIsFoundAgainAfterItsWindowMovesAndResizes() async throws {
        let (pid, window) = try await openTextEdit()
        let screen = NSScreen.main!.visibleFrame
        let mainHeight = NSScreen.screens[0].frame.height
        // Quartz-space rect near the top-left of the visible area.
        let start = CGRect(x: screen.minX + 60, y: mainHeight - screen.maxY + 60, width: 640, height: 420)
        set(window, frame: start)
        try await Task.sleep(nanoseconds: 400_000_000)
        guard let control = someLabelledControl(in: window) else { throw XCTSkip("no labelled control in the TextEdit window") }
        let clickPoint = CGPoint(x: control.frame.midX, y: control.frame.midY)
        let target = recordedTarget(at: clickPoint)
        XCTAssertEqual(target.owner, "TextEdit")
        XCTAssertNotNil(target.window, "the recorder should capture the window the control lives in")
        let step = SkillStep(text: "in TextEdit, click “\(control.label)”", app: "TextEdit", x: clickPoint.x, y: clickPoint.y,
                             action: "click", label: target.label, role: target.role, window: target.window)

        // Unchanged screen: one hit-test, verified at the recorded spot.
        let same = SkillTargetResolver.resolve(step, pid: pid, recorded: clickPoint)
        XCTAssertTrue(same.verified)
        XCTAssertEqual(same.point, clickPoint)

        // Move and grow the window; the control must be found at its new place.
        let moved = CGRect(x: start.minX + 180, y: start.minY + 140, width: 820, height: 560)
        set(window, frame: moved)
        try await Task.sleep(nanoseconds: 500_000_000)
        let after = SkillTargetResolver.resolve(step, pid: pid, recorded: clickPoint)
        XCTAssertTrue(after.verified, "control should be re-found after the window moved")
        let seen = SkillTargetResolver.labelAndRole(in: pid, at: after.point!)
        XCTAssertEqual(seen.label.lowercased(), control.label.lowercased())
        XCTAssertNotEqual(after.point, clickPoint)
        XCTAssertEqual(after.shift.width, after.point!.x - clickPoint.x, accuracy: 0.01)
    }

    func testDockItemResolvesInTheDockWhateverIsInFront() throws {
        guard let dock = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.dock" }) else {
            throw XCTSkip("no Dock")
        }
        // Finder is always in the Dock.
        let step = SkillStep(text: "in Dock, click “Finder”", app: "Dock", x: 10, y: 10, action: "click", label: "Finder", role: "AXDockItem")
        XCTAssertEqual(SkillTargetResolver.ownerPid(for: step), dock.processIdentifier)
        let found = SkillTargetResolver.resolve(step, pid: dock.processIdentifier, recorded: CGPoint(x: 10, y: 10))
        XCTAssertTrue(found.verified, "Finder's Dock item should be found by label wherever the Dock put it")
        XCTAssertNotEqual(found.point, CGPoint(x: 10, y: 10))
    }

    func testUnverifiedStepStillCarriesWithTheWindowSoNothingIsClickedBlindAtTheOldSpot() async throws {
        let (pid, window) = try await openTextEdit()
        let screen = NSScreen.main!.visibleFrame
        let mainHeight = NSScreen.screens[0].frame.height
        let start = CGRect(x: screen.minX + 60, y: mainHeight - screen.maxY + 60, width: 640, height: 420)
        set(window, frame: start)
        try await Task.sleep(nanoseconds: 400_000_000)
        // A label the window certainly doesn't have, recorded in the middle of the window.
        let point = CGPoint(x: start.midX, y: start.midY)
        let step = SkillStep(text: "click “Nonexistent Control”", app: "TextEdit", x: point.x, y: point.y,
                             action: "click", label: "Nonexistent Control", role: "AXButton", window: start)
        let moved = start.offsetBy(dx: 200, dy: 100)
        set(window, frame: moved)
        try await Task.sleep(nanoseconds: 500_000_000)
        let result = SkillTargetResolver.resolve(step, pid: pid, recorded: point)
        XCTAssertFalse(result.verified)
        XCTAssertEqual(result.point!.x, point.x + 200, accuracy: 2)
        XCTAssertEqual(result.point!.y, point.y + 100, accuracy: 2)
    }
}
