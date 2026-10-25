import AppKit
import Foundation

// MARK: - Keys

/// Key names the tutor and the learner agree on: "cmd+shift+a", "f", "return", "esc".
public enum TeachKeys {
    private static let names: [UInt16: String] = [
        36: "return", 76: "return", 48: "tab", 49: "space", 51: "delete", 117: "delete", 53: "esc",
        123: "left", 124: "right", 125: "up", 126: "down", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
        122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9",
        109: "f10", 103: "f11", 111: "f12",
    ]

    public static func combo(for event: NSEvent) -> String {
        combo(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers ?? "", flags: event.modifierFlags)
    }

    public static func combo(keyCode: UInt16, characters: String, flags: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.control) { parts.append("ctrl") }
        if flags.contains(.option) { parts.append("alt") }
        if flags.contains(.shift) { parts.append("shift") }
        if flags.contains(.command) { parts.append("cmd") }
        let key = names[keyCode] ?? characters.lowercased()
        parts.append(key.isEmpty ? "key\(keyCode)" : key)
        return parts.joined(separator: "+")
    }

    public static func normalize(_ expected: String) -> [String] {
        let aliases: [String: String] = [
            "command": "cmd", "⌘": "cmd", "cmd": "cmd", "meta": "cmd",
            "option": "alt", "opt": "alt", "⌥": "alt", "alt": "alt",
            "control": "ctrl", "ctrl": "ctrl", "⌃": "ctrl",
            "shift": "shift", "⇧": "shift",
            "enter": "return", "↩": "return", "return": "return",
            "escape": "esc", "esc": "esc", "backspace": "delete", "del": "delete",
            "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
            "spacebar": "space",
        ]
        // The same parser the key actuator uses, so "cmd+-" and "cmd++" keep their key.
        let pieces = EventActuator.keyPieces(expected)
        return pieces.map { aliases[$0] ?? $0 }
    }

    public static func matches(_ combo: String, expected: String?) -> Bool {
        guard let expected, !expected.isEmpty else { return false }
        let modifiers: Set<String> = ["cmd", "alt", "ctrl", "shift"]
        let want = normalize(expected)
        let got = combo.split(separator: "+").map(String.init)
        guard let wantKey = want.last(where: { !modifiers.contains($0) }),
              let gotKey = got.last(where: { !modifiers.contains($0) }) else { return false }
        let wantMods = Set(want.filter { modifiers.contains($0) })
        let gotMods = Set(got.filter { modifiers.contains($0) })
        // A bare letter still counts when shift is the only extra, e.g. "A" typed as shift+a.
        return wantKey == gotKey && (wantMods == gotMods || (wantMods.isEmpty && gotMods == ["shift"]))
    }

    public static func caps(_ expected: String?) -> [String] {
        guard let expected, !expected.isEmpty else { return [] }
        let glyphs: [String: String] = [
            "cmd": "⌘", "alt": "⌥", "ctrl": "⌃", "shift": "⇧", "return": "↩", "tab": "⇥",
            "delete": "⌫", "esc": "esc", "space": "space", "up": "↑", "down": "↓", "left": "←", "right": "→",
        ]
        return normalize(expected).map { glyphs[$0] ?? $0.uppercased() }
    }

    /// Two quick taps of the shift key, on its own: the learner's "next" that needs no voice
    /// and no button. Either shift counts. Any other key, modifier or click in between starts the
    /// count over, so shift+letter typing never trips it.
    public struct DoubleTap {
        public static let leftShift: UInt16 = 56
        public static let rightShift: UInt16 = 60
        public static let leftOption: UInt16 = 58
        public static let rightOption: UInt16 = 61
        public var keyCodes: Set<UInt16>
        public var modifier: NSEvent.ModifierFlags
        public var window: TimeInterval
        private var down = false
        private var lastTapAt: TimeInterval?

        public init(keyCodes: Set<UInt16> = [DoubleTap.leftShift, DoubleTap.rightShift],
                    modifier: NSEvent.ModifierFlags = .shift, window: TimeInterval = 0.4) {
            self.keyCodes = keyCodes
            self.modifier = modifier
            self.window = window
        }

        /// Feed every `flagsChanged`. True on the release that completes the second tap.
        public mutating func flagsChanged(keyCode: UInt16, flags: NSEvent.ModifierFlags, at time: TimeInterval) -> Bool {
            let all: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
            let others = flags.intersection(all.subtracting(modifier))
            guard keyCodes.contains(keyCode), others.isEmpty else { reset(); return false }
            if flags.contains(modifier) {
                down = true
                return false
            }
            guard down else { reset(); return false }
            down = false
            if let last = lastTapAt, time - last <= window {
                lastTapAt = nil
                return true
            }
            lastTapAt = time
            return false
        }

        /// Anything else they do breaks the double tap.
        public mutating func reset() {
            down = false
            lastTapAt = nil
        }
    }
}
