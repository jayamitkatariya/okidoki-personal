import Foundation

/// The pure parts of turning a recorded step back into a target on screen. Kept out of the
/// replayer so they can be tested without a display.
public enum SkillReplayGeometry {
    /// The label to re-find a control by. New recordings carry it; legacy steps only have the
    /// sentence, so the quoted part of “…” is used when there is one.
    public static func targetLabel(_ step: SkillStep) -> String {
        if let label = step.label, !label.isEmpty { return label }
        guard step.action == nil else { return "" }
        guard let open = step.text.firstIndex(of: "“") else { return "" }
        let afterOpen = step.text.index(after: open)
        guard let close = step.text[afterOpen...].firstIndex(of: "”") else { return "" }
        return String(step.text[afterOpen..<close])
    }

    /// The recorded point in Quartz space (top-left origin). Legacy steps (`action == nil`)
    /// were captured in AppKit space and are flipped using the main display's height.
    public static func recordedPoint(_ step: SkillStep, mainDisplayHeight: Double) -> CGPoint? {
        guard let x = step.x, let y = step.y else { return nil }
        if step.action == nil { return CGPoint(x: x, y: mainDisplayHeight - y) }
        return CGPoint(x: x, y: y)
    }

    /// Replay pacing: the recorded gap, kept between a floor that lets apps catch up and a
    /// ceiling so a coffee break during recording doesn't become one during replay.
    public static func pause(for step: SkillStep) -> TimeInterval {
        min(max(step.delay ?? 0.6, 0.45), 2.5)
    }

    /// Mouse button and press count for a click-family action.
    public static func clickShape(_ action: String?) -> (button: String, count: Int) {
        switch action {
        case "right-click": return ("right", 1)
        case "middle-click": return ("middle", 1)
        case "double-click": return ("left", 2)
        default: return ("left", 1)
        }
    }

    /// An app worth activating. Empty and the "mac"/"app" placeholders are not.
    public static func isRealApp(_ name: String) -> Bool {
        !name.isEmpty && name != "mac" && name != "app" && !isSystemSurface(name)
    }

    /// Surfaces that are always on screen and never "activated": clicks there are looked up in
    /// that process, not in the front app.
    public static func isSystemSurface(_ name: String) -> Bool {
        ["Dock", "Control Center", "ControlCenter", "SystemUIServer", "Notification Center", "NotificationCenter",
         "Spotlight", "Window Server", "WindowServer", "Menu Bar", "loginwindow"].contains(name)
    }

    /// Where a point recorded inside window `from` lands now that the window is `to`. Each axis
    /// keeps its distance from the nearer edge, so a toolbar button stays at the top-left offset
    /// and a bottom-right "Send" stays at the bottom-right one when the window is resized.
    public static func translate(_ point: CGPoint, from: CGRect, to: CGRect) -> CGPoint {
        guard from.width > 0, from.height > 0 else { return point }
        let x: Double
        let y: Double
        if point.x - from.minX <= from.maxX - point.x {
            x = to.minX + (point.x - from.minX)
        } else {
            x = to.maxX - (from.maxX - point.x)
        }
        if point.y - from.minY <= from.maxY - point.y {
            y = to.minY + (point.y - from.minY)
        } else {
            y = to.maxY - (from.maxY - point.y)
        }
        // Inside the new window whatever the sizes did.
        return CGPoint(x: min(max(x, to.minX + 1), to.maxX - 1), y: min(max(y, to.minY + 1), to.maxY - 1))
    }

    /// Whether what's at a candidate point is the control the step was recorded on. A label is
    /// the strongest evidence; without one, the role has to agree. Nothing recorded, nothing to check.
    public static func matches(step: SkillStep, label: String, role: String) -> Bool {
        let wanted = targetLabel(step)
        if !wanted.isEmpty { return label.caseInsensitiveCompare(wanted) == .orderedSame }
        if let wantedRole = step.role, !wantedRole.isEmpty { return role == wantedRole }
        return false
    }

    /// True when the step carries something a replay can check before clicking.
    public static func isCheckable(_ step: SkillStep) -> Bool {
        !targetLabel(step).isEmpty || !(step.role ?? "").isEmpty
    }
}
