import Foundation

/// Take-the-wheel input: a joiner's pointer and keyboard events, as the session API receives them,
/// turned into the same ComputerActions okidoki itself drives the private Mac with. Coordinates
/// arrive normalized (0–1 across the guest display) so any screen size aims true; the parser scales
/// them into display points and clamps everything a stranger could send oversized.
public enum CollabInput {
    public static let maxTypeLength = 500
    public static let maxKeyLength = 40
    public static let maxScroll: Double = 2000
    public static let maxKeyTimes = 10

    /// The kinds that move the guest pointer, for the live pointer overlay other joiners see.
    public static func movesPointer(_ kind: String) -> Bool {
        kind == "move" || kind == "click" || kind == "drag"
    }

    public static func number(_ value: Any?) -> Double? {
        if let double = value as? Double { return double.isFinite ? double : nil }
        if let int = value as? Int { return Double(int) }
        if let number = value as? NSNumber { return number.doubleValue.isFinite ? number.doubleValue : nil }
        return nil
    }

    /// Normalized 0–1 → display points, clamped to the display.
    public static func point(_ value: Any?, _ extent: Double) -> Double? {
        guard let normalized = number(value), extent > 0 else { return nil }
        return min(max(normalized, 0), 1) * extent
    }

    /// A wheel event's delta, clamped so one packet can't fling the guest across the screen.
    public static func scrollDelta(_ value: Any?) -> Double {
        min(max(number(value) ?? 0, -maxScroll), maxScroll)
    }

    /// The action for one input packet, or nil when it isn't a well-formed one. Nothing here acts;
    /// the host decides whether the wheel holder may deliver it.
    public static func action(from payload: [String: Any], width: Double, height: Double) -> ComputerAction? {
        let kind = (payload["kind"] as? String ?? "").lowercased()
        switch kind {
        case "move":
            guard let x = point(payload["x"], width), let y = point(payload["y"], height) else { return nil }
            return ComputerAction(type: "move", x: x, y: y)
        case "click":
            guard let x = point(payload["x"], width), let y = point(payload["y"], height) else { return nil }
            let count = Int(number(payload["count"]) ?? 1)
            let right = (payload["button"] as? String)?.lowercased() == "right"
            let type = right ? "right_click" : count >= 3 ? "triple_click" : count == 2 ? "double_click" : "click"
            let modifiers = (payload["modifiers"] as? String)?.trimmingCharacters(in: .whitespaces)
            return ComputerAction(type: type, x: x, y: y, modifiers: modifiers?.isEmpty == false ? modifiers : nil)
        case "drag":
            guard let fromX = point(payload["fromX"], width), let fromY = point(payload["fromY"], height),
                  let toX = point(payload["toX"], width), let toY = point(payload["toY"], height) else { return nil }
            return ComputerAction(type: "drag", fromX: fromX, fromY: fromY, toX: toX, toY: toY)
        case "scroll":
            let x = point(payload["x"], width) ?? width / 2
            let y = point(payload["y"], height) ?? height / 2
            let dx = scrollDelta(payload["dx"])
            let dy = scrollDelta(payload["dy"])
            guard dx != 0 || dy != 0 else { return nil }
            return ComputerAction(type: "scroll", x: x, y: y, dx: dx, dy: dy)
        case "key":
            guard let key = (payload["key"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !key.isEmpty, key.count <= maxKeyLength else { return nil }
            let times = min(max(Int(number(payload["times"]) ?? 1), 1), maxKeyTimes)
            return ComputerAction(type: "key", key: key, times: times)
        case "type":
            guard let text = payload["text"] as? String, !text.isEmpty else { return nil }
            return ComputerAction(type: "type", text: String(text.prefix(maxTypeLength)))
        default:
            return nil
        }
    }
}
