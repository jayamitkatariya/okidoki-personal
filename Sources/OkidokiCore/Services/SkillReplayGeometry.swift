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
        !name.isEmpty && name != "mac" && name != "app"
    }
}
