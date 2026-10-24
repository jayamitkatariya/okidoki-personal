import AppKit

/// The lesson's next/fast-forward key: a double-tap on a bare modifier (⌥⌥ by default), or a single
/// tap on the right ⌘. A modifier on its own never types or triggers an app shortcut, so there is
/// nothing to intercept and nothing to collide with.
///
/// Only clean taps count: the modifier goes down and up within 0.25s with no other key or click in
/// between, and the two taps land within 0.35s. "Ctrl+C" is never a tap.
@MainActor
final class TeachGesture {
    enum Kind: String {
        case option, control, rightCommand, off

        init(setting: String) {
            self = Kind(rawValue: setting) ?? .option
        }

        var caps: String {
            switch self {
            case .option: return "⌥⌥"
            case .control: return "⌃⌃"
            case .rightCommand: return "⌘"
            case .off: return ""
            }
        }

        var hint: String {
            switch self {
            case .option: return "double-tap option"
            case .control: return "double-tap control"
            case .rightCommand: return "tap right command"
            case .off: return ""
            }
        }

        var flag: NSEvent.ModifierFlags? {
            switch self {
            case .option: return .option
            case .control: return .control
            case .rightCommand: return .command
            case .off: return nil
            }
        }

        var needsDouble: Bool { self != .rightCommand }
    }

    var kind: Kind
    var onTrigger: () -> Void
    private var monitors: [Any] = []
    private var downAt: Date?
    private var dirty = false
    private var lastTapEnd: Date?

    init(kind: Kind, onTrigger: @escaping () -> Void) {
        self.kind = kind
        self.onTrigger = onTrigger
    }

    func start() {
        stop()
        guard kind != .off else { return }
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            Task { @MainActor in self?.handle(event) }
            return event
        }) {
            monitors.append(local)
        }
    }

    func stop() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        downAt = nil
        dirty = false
        lastTapEnd = nil
    }

    private func handle(_ event: NSEvent) {
        guard let flag = kind.flag else { return }
        switch event.type {
        case .flagsChanged:
            let pressed = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let onlyOurs = pressed == [flag] || pressed == [flag, .capsLock]
            let isOurKey = kind == .rightCommand ? event.keyCode == 54 : pressed.contains(flag) || downAt != nil
            if onlyOurs, isOurKey, downAt == nil {
                downAt = Date()
                dirty = false
                return
            }
            if let started = downAt, !pressed.contains(flag) {
                downAt = nil
                let held = Date().timeIntervalSince(started)
                guard !dirty, held < 0.25 else { lastTapEnd = nil; return }
                if !kind.needsDouble {
                    lastTapEnd = nil
                    onTrigger()
                    return
                }
                if let last = lastTapEnd, Date().timeIntervalSince(last) < 0.35 {
                    lastTapEnd = nil
                    onTrigger()
                } else {
                    lastTapEnd = Date()
                }
                return
            }
            if downAt != nil, pressed != [flag] {
                // Another modifier joined: this is a chord, not a tap.
                dirty = true
            }
        default:
            // Any key, click or scroll in between breaks the tap.
            dirty = true
            lastTapEnd = nil
        }
    }
}
