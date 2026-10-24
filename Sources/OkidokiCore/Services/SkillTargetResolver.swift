import AppKit
import ApplicationServices
import Foundation

/// Finds, on today's screen, the control a skill step was recorded on. Cheapest check first,
/// so a replay of an unchanged screen costs one accessibility hit-test per click:
///
/// 1. the recorded spot still holds the recorded control;
/// 2. the control's window moved or resized — the spot is carried along with it and checked;
/// 3. a search through the owner app for the recorded label.
///
/// `verified` is false when none of those confirmed the control: the point handed back is the
/// best guess (carried with the window if possible), and the caller decides whether to click
/// blind or ask for help.
public enum SkillTargetResolver {
    public struct Resolution: Equatable, Sendable {
        public var point: CGPoint?
        public var verified: Bool
        /// How far the control moved from where it was recorded; applied to drag end points.
        public var shift: CGSize
        public init(point: CGPoint?, verified: Bool, shift: CGSize = .zero) {
            self.point = point; self.verified = verified; self.shift = shift
        }
    }

    /// The process to look the control up in: the owner recorded with the click (the Dock, a
    /// menu bar extra), else the step's app, else whatever is in front.
    public static func ownerPid(for step: SkillStep) -> pid_t {
        for name in [step.owner ?? "", step.app] where !name.isEmpty && name != "mac" && name != "app" {
            if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) {
                return app.processIdentifier
            }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }

    /// Blocking accessibility work: call off the main thread.
    public static func resolve(_ step: SkillStep, pid: pid_t, recorded: CGPoint?) -> Resolution {
        guard pid != 0, AXIsProcessTrusted() else { return Resolution(point: recorded, verified: false) }
        let checkable = SkillReplayGeometry.isCheckable(step)
        if checkable, let recorded {
            let seen = labelAndRole(in: pid, at: recorded)
            if SkillReplayGeometry.matches(step: step, label: seen.label, role: seen.role) {
                return Resolution(point: recorded, verified: true)
            }
        }
        var carried: CGPoint?
        if let recorded, let was = step.windowFrame, let now = windowFrame(in: pid, like: was), now != was {
            let moved = SkillReplayGeometry.translate(recorded, from: was, to: now)
            carried = moved
            if checkable {
                let seen = labelAndRole(in: pid, at: moved)
                if SkillReplayGeometry.matches(step: step, label: seen.label, role: seen.role) {
                    return Resolution(point: moved, verified: true, shift: shift(from: recorded, to: moved))
                }
            }
        }
        let label = SkillReplayGeometry.targetLabel(step)
        if !label.isEmpty, let found = find(label: label, in: pid, near: carried ?? recorded) {
            return Resolution(point: found, verified: true, shift: recorded.map { shift(from: $0, to: found) } ?? .zero)
        }
        let best = carried ?? recorded
        return Resolution(point: best, verified: false,
                          shift: (recorded != nil && best != nil) ? shift(from: recorded!, to: best!) : .zero)
    }

    private static func shift(from: CGPoint, to: CGPoint) -> CGSize {
        CGSize(width: to.x - from.x, height: to.y - from.y)
    }

    // MARK: - Activation

    /// Brings the app forward, launching it when it isn't running, and waits until it has a
    /// window to click in — a cold launch would otherwise get the first clicks before it's up.
    public static func activate(_ name: String, timeout: TimeInterval = 6) async -> Bool {
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) {
            app.activate()
            _ = await waitForWindow(pid: app.processIdentifier, timeout: 1.5)
            return true
        }
        let launched = await Task.detached { () -> Bool in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", name]
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch {
                return false
            }
        }.value
        guard launched else { return false }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) {
                app.activate()
                return await waitForWindow(pid: app.processIdentifier, timeout: deadline.timeIntervalSinceNow)
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        return false
    }

    /// True once the app reports at least one window through accessibility.
    public static func waitForWindow(pid: pid_t, timeout: TimeInterval) async -> Bool {
        guard AXIsProcessTrusted() else {
            try? await Task.sleep(nanoseconds: 450_000_000)
            return true
        }
        let deadline = Date().addingTimeInterval(max(0.2, timeout))
        while Date() < deadline {
            let has = await Task.detached(priority: .userInitiated) { hasWindow(pid: pid) }.value
            if has { return true }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return false
    }

    private static func hasWindow(pid: pid_t) -> Bool {
        let app = appElement(pid)
        var windowsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
              let windows = windowsRef as? [AXUIElement] else { return false }
        return windows.contains { frame(of: $0) != nil }
    }

    // MARK: - Lookups (blocking)

    /// The app's accessibility root with a short reply timeout: the default is 6 seconds per
    /// call, which turns a busy or hung app into a replay that looks stuck.
    private static func appElement(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        return app
    }

    /// Label and role of whatever the app has at a Quartz point, from one hit-test.
    public static func labelAndRole(in pid: pid_t, at point: CGPoint) -> (label: String, role: String) {
        let app = appElement(pid)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &element) == .success,
              let element else { return ("", "") }
        return (AccessibilityLabel.of(element), AXSearch.stringAttribute(kAXRoleAttribute, of: element))
    }

    /// The app's window that corresponds to the one a step was recorded in: the focused window
    /// when its size is close, else the window whose size is nearest. Nil when it has none.
    public static func windowFrame(in pid: pid_t, like recorded: CGRect) -> CGRect? {
        let app = appElement(pid)
        var frames: [CGRect] = []
        var focusedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRef) == .success,
           let focusedRef, let focused = AXSearch.axElement(focusedRef), let frame = frame(of: focused) {
            if abs(frame.width - recorded.width) < 80 && abs(frame.height - recorded.height) < 80 { return frame }
            frames.append(frame)
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            for window in windows.prefix(12) {
                if let frame = frame(of: window) { frames.append(frame) }
            }
        }
        return frames.min { lhs, rhs in
            let l = abs(lhs.width - recorded.width) + abs(lhs.height - recorded.height)
            let r = abs(rhs.width - recorded.width) + abs(rhs.height - recorded.height)
            return l < r
        }
    }

    /// Centre of the element whose label matches exactly (case-insensitive). When several match,
    /// the one closest to `near` wins. Substring matches are deliberately not accepted.
    public static func find(label: String, in pid: pid_t, near: CGPoint?) -> CGPoint? {
        let app = appElement(pid)
        var queue: [AXUIElement] = [app]
        var visited = 0
        var best: (point: CGPoint, distance: Double)?
        while !queue.isEmpty && visited < 3000 {
            let element = queue.removeFirst()
            visited += 1
            if AccessibilityLabel.of(element).caseInsensitiveCompare(label) == .orderedSame, let center = center(of: element) {
                let distance = near.map { hypot(center.x - $0.x, center.y - $0.y) } ?? 0
                if best == nil || distance < best!.distance { best = (center, distance) }
                if near == nil { break }
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120))
            }
        }
        return best?.point
    }

    public static func frame(of element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posValue = posRef, let sizeValue = sizeRef,
              CFGetTypeID(posValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posValue as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        guard size.width > 1, size.height > 1 else { return nil }
        return CGRect(origin: point, size: size)
    }

    private static func center(of element: AXUIElement) -> CGPoint? {
        guard let frame = frame(of: element), frame.width < 4000, frame.height < 4000 else { return nil }
        return CGPoint(x: frame.midX, y: frame.midY)
    }
}
