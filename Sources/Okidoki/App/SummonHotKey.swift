import AppKit
import Carbon.HIToolbox

/// The global summon shortcut ("option+space" by default). A Carbon hot key: it works in every app,
/// needs no Accessibility or Input Monitoring grant, and doesn't watch the keyboard otherwise.
@MainActor
final class SummonHotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private(set) var registered = ""
    var onPress: (() -> Void)?

    private static let signature: OSType = 0x4F4B_4449 // "OKDI"
    private static weak var current: SummonHotKey?

    /// Registers `spec`, replacing what was there. Empty turns it off. Returns false when macOS
    /// refused it (another app owns that combination) or it couldn't be read.
    @discardableResult
    func set(_ spec: String) -> Bool {
        let spec = spec.lowercased().trimmingCharacters(in: .whitespaces)
        if spec == registered, ref != nil { return true }
        unregister()
        guard !spec.isEmpty, let (code, modifiers) = Self.parse(spec) else { return spec.isEmpty }
        installHandlerIfNeeded()
        var hotKey: EventHotKeyRef?
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(code, modifiers, id, GetApplicationEventTarget(), 0, &hotKey)
        guard status == noErr, let hotKey else { return false }
        ref = hotKey
        registered = spec
        Self.current = self
        return true
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        registered = ""
    }

    private func installHandlerIfNeeded() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard id.signature == SummonHotKey.signature else { return OSStatus(eventNotHandledErr) }
            DispatchQueue.main.async { SummonHotKey.current?.onPress?() }
            return noErr
        }, 1, &spec, nil, &handler)
    }

    /// "command+shift+k" → (key code, Carbon modifiers). Nil without a modifier other than shift, or an unknown key.
    nonisolated static func parse(_ spec: String) -> (UInt32, UInt32)? {
        let parts = spec.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.last, parts.count >= 2 else { return nil }
        var modifiers: UInt32 = 0
        for part in parts.dropLast() {
            switch part {
            case "command", "cmd": modifiers |= UInt32(cmdKey)
            case "option", "alt": modifiers |= UInt32(optionKey)
            case "control", "ctrl": modifiers |= UInt32(controlKey)
            case "shift": modifiers |= UInt32(shiftKey)
            default: return nil
            }
        }
        guard modifiers & ~UInt32(shiftKey) != 0, let code = keyCodes[key] else { return nil }
        return (code, modifiers)
    }

    nonisolated private static let keyCodes: [String: UInt32] = {
        var map: [String: UInt32] = [
            "space": UInt32(kVK_Space), "return": UInt32(kVK_Return),
            "a": UInt32(kVK_ANSI_A), "b": UInt32(kVK_ANSI_B), "c": UInt32(kVK_ANSI_C), "d": UInt32(kVK_ANSI_D),
            "e": UInt32(kVK_ANSI_E), "f": UInt32(kVK_ANSI_F), "g": UInt32(kVK_ANSI_G), "h": UInt32(kVK_ANSI_H),
            "i": UInt32(kVK_ANSI_I), "j": UInt32(kVK_ANSI_J), "k": UInt32(kVK_ANSI_K), "l": UInt32(kVK_ANSI_L),
            "m": UInt32(kVK_ANSI_M), "n": UInt32(kVK_ANSI_N), "o": UInt32(kVK_ANSI_O), "p": UInt32(kVK_ANSI_P),
            "q": UInt32(kVK_ANSI_Q), "r": UInt32(kVK_ANSI_R), "s": UInt32(kVK_ANSI_S), "t": UInt32(kVK_ANSI_T),
            "u": UInt32(kVK_ANSI_U), "v": UInt32(kVK_ANSI_V), "w": UInt32(kVK_ANSI_W), "x": UInt32(kVK_ANSI_X),
            "y": UInt32(kVK_ANSI_Y), "z": UInt32(kVK_ANSI_Z),
        ]
        let digits = [kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]
        for (n, code) in digits.enumerated() { map["\(n)"] = UInt32(code) }
        return map
    }()

    /// "⌥ Space" for menus and copy.
    nonisolated static func label(_ spec: String) -> String {
        guard !spec.isEmpty else { return "" }
        let glyphs = ["command": "⌘", "option": "⌥", "control": "⌃", "shift": "⇧", "space": "Space", "return": "↩"]
        return spec.split(separator: "+").map { glyphs[String($0)] ?? $0.uppercased() }.joined(separator: " ")
    }
}
