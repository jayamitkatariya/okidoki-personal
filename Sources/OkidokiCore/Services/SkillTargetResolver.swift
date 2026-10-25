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
        for name in [step.owner ?? "", step.app] where SkillReplayGeometry.isRealApp(name) || SkillReplayGeometry.isSystemSurface(name) {
            if let app = runningApp(named: name) { return app.processIdentifier }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    }

    public static func runningApp(named name: String) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { SkillReplayGeometry.sameApp($0.localizedName ?? "", name) }
    }

    /// Blocking accessibility work: call off the main thread. `quick` skips the tree search, for
    /// the repeated looks while waiting for an app to catch up.
    public static func resolve(_ step: SkillStep, pid: pid_t, recorded: CGPoint?, quick: Bool = false) -> Resolution {
        guard pid != 0, AXIsProcessTrusted() else { return Resolution(point: recorded, verified: false) }
        let checkable = SkillReplayGeometry.isCheckable(step)
        if checkable, let recorded {
            let seen = labelAndRole(in: pid, at: recorded)
            if SkillReplayGeometry.matches(step: step, label: seen.label, role: seen.role) {
                return Resolution(point: recorded, verified: true)
            }
        }
        var carried: CGPoint?
        if let recorded, let was = step.windowFrame, let now = windowFrame(in: pid, like: was, title: step.winTitle), now != was {
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
        if !quick, !label.isEmpty, let found = find(label: label, in: pid, near: carried ?? recorded) {
            return Resolution(point: found, verified: true, shift: recorded.map { shift(from: $0, to: found) } ?? .zero)
        }
        let best = carried ?? recorded
        return Resolution(point: best, verified: false,
                          shift: (recorded != nil && best != nil) ? shift(from: recorded!, to: best!) : .zero)
    }

    /// Finds the control by its saved picture in a fresh capture of the display, and when the
    /// step is checkable confirms with one hit-test. A picture match that lands on a control
    /// with a different label is still trusted when the picture was very sure: lists that
    /// re-render change their labels more often than their looks.
    public static func resolveByPicture(_ step: SkillStep, pid: pid_t, shot: CGImage, box: ScreenBox,
                                        recorded: CGPoint?, near: CGPoint?) -> Resolution? {
        guard let hit = SkillFrames.locate(step: step, in: shot, box: box, near: near) else { return nil }
        if SkillReplayGeometry.isCheckable(step), pid != 0, AXIsProcessTrusted() {
            let seen = labelAndRole(in: pid, at: hit.point)
            // Nothing there at all means the app has no tree to ask; that's no opinion, not a no.
            let silent = seen.label.isEmpty && seen.role.isEmpty
            let agrees = SkillReplayGeometry.matches(step: step, label: seen.label, role: seen.role)
            guard silent || agrees || hit.score >= 0.95 else { return nil }
        }
        return Resolution(point: hit.point, verified: true, shift: recorded.map { shift(from: $0, to: hit.point) } ?? .zero)
    }

    private static func shift(from: CGPoint, to: CGPoint) -> CGSize {
        CGSize(width: to.x - from.x, height: to.y - from.y)
    }

    // MARK: - Activation

    /// Brings the app forward, launching it when it isn't running, and waits until it has a
    /// window to click in — a cold launch would otherwise get the first clicks before it's up.
    public static func activate(_ rawName: String, timeout: TimeInterval = 6) async -> Bool {
        let name = SkillReplayGeometry.cleanAppName(rawName)
        if let app = runningApp(named: name) {
            app.activate()
            _ = await waitForWindow(pid: app.processIdentifier, timeout: 1.5)
            if await becameFrontmost(app.processIdentifier, within: 0.4) { return true }
            // Since macOS 14 an app that isn't itself active (okidoki answering from a space, a
            // routine, a hook) can only ask politely, and the ask is often ignored. Launch Services
            // still brings a running app forward for anyone.
            _ = await openWithLaunchServices(name)
            return await becameFrontmost(app.processIdentifier, within: 2)
        }
        guard await openWithLaunchServices(name) else { return false }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let app = runningApp(named: name) {
                app.activate()
                return await waitForWindow(pid: app.processIdentifier, timeout: deadline.timeIntervalSinceNow)
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        return false
    }

    private static func openWithLaunchServices(_ name: String) async -> Bool {
        await Task.detached { () -> Bool in
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
    }

    /// Whether the app is in front now or gets there within `seconds`.
    public static func becameFrontmost(_ pid: pid_t, within seconds: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
            try? await Task.sleep(nanoseconds: 80_000_000)
        } while Date() < deadline
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
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

    /// The app's window that corresponds to the one a step was recorded in: the one with the
    /// recorded title when there is one, else the focused window when its size is close, else
    /// the window whose size is nearest. Nil when it has none.
    public static func windowFrame(in pid: pid_t, like recorded: CGRect, title: String? = nil) -> CGRect? {
        let app = appElement(pid)
        var frames: [CGRect] = []
        var focusedRef: CFTypeRef?
        var focusedFrame: CGRect?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRef) == .success,
           let focusedRef, let focused = AXSearch.axElement(focusedRef), let frame = frame(of: focused) {
            focusedFrame = frame
            if let title, !title.isEmpty, AXSearch.stringAttribute(kAXTitleAttribute, of: focused) == title { return frame }
            frames.append(frame)
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            for window in windows.prefix(12) {
                guard let frame = frame(of: window) else { continue }
                if let title, !title.isEmpty, AXSearch.stringAttribute(kAXTitleAttribute, of: window) == title { return frame }
                frames.append(frame)
            }
        }
        if let focusedFrame, abs(focusedFrame.width - recorded.width) < 80 && abs(focusedFrame.height - recorded.height) < 80 {
            return focusedFrame
        }
        return frames.min { lhs, rhs in
            let l = abs(lhs.width - recorded.width) + abs(lhs.height - recorded.height)
            let r = abs(rhs.width - recorded.width) + abs(rhs.height - recorded.height)
            return l < r
        }
    }

    /// Centre of the element whose label matches exactly (case-insensitive). When several match,
    /// the one closest to `near` wins. Substring matches are deliberately not accepted. The walk
    /// gives up after `budget` seconds: a big chat list or web page would otherwise turn one
    /// look-up into a replay that sits still.
    public static func find(label: String, in pid: pid_t, near: CGPoint?, budget: TimeInterval = 0.7) -> CGPoint? {
        let app = appElement(pid)
        let deadline = Date().addingTimeInterval(budget)
        var visited = 0
        // The window in front first: it's where the replay is working, and an app with many windows
        // (a browser) would otherwise spend the whole budget on the ones behind it.
        var focusedRef: CFTypeRef?
        let focused = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRef) == .success
            ? focusedRef.flatMap { AXSearch.axElement($0) } : nil
        func walk(from root: AXUIElement, skipping skip: AXUIElement?) -> (point: CGPoint, element: AXUIElement)? {
            var queue: [AXUIElement] = [root]
            queue.reserveCapacity(512)
            var head = 0
            var best: (point: CGPoint, distance: Double, element: AXUIElement)?
            while head < queue.count && visited < 3000 {
                if visited & 31 == 0, Date() > deadline { break }
                let element = queue[head]
                head += 1
                visited += 1
                if AccessibilityLabel.of(element).caseInsensitiveCompare(label) == .orderedSame, let center = center(of: element) {
                    let distance = near.map { hypot(center.x - $0.x, center.y - $0.y) } ?? 0
                    if best == nil || distance < best!.distance { best = (center, distance, element) }
                    if near == nil { break }
                }
                var childrenRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
                   let children = childrenRef as? [AXUIElement] {
                    queue.append(contentsOf: children.prefix(120).filter { child in skip.map { !CFEqual(child, $0) } ?? true })
                }
            }
            return best.map { ($0.point, $0.element) }
        }
        guard let found = focused.flatMap({ walk(from: $0, skipping: nil) }) ?? walk(from: app, skipping: focused) else { return nil }
        return visiblePoint(of: found.element) ?? found.point
    }

    /// A control below the fold of a long page has a frame, just not one on screen: clicking its
    /// centre would hit whatever is there instead. Ask the app to scroll it into view first.
    private static func visiblePoint(of element: AXUIElement) -> CGPoint? {
        guard let center = center(of: element) else { return nil }
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
              let windowRef, let window = AXSearch.axElement(windowRef), let bounds = frame(of: window) else { return center }
        let inside = bounds.insetBy(dx: 4, dy: 4)
        guard !inside.contains(center) else { return center }
        guard AXUIElementPerformAction(element, "AXScrollToVisible" as CFString) == .success else { return center }
        usleep(250_000)
        return self.center(of: element) ?? center
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
