import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

/// What was under the pointer when it was clicked: enough to find the same control again
/// even after its window moves or the Dock reorders.
public struct WatchedTarget: Equatable, Sendable {
    public var label: String
    /// App that owns the control (may differ from the front app: Dock, menu bar extras).
    public var owner: String
    public var role: String
    /// The control's window, Quartz space. Nil for things without one (Dock items).
    public var window: CGRect?
    public var windowTitle: String
    public init(label: String = "", owner: String = "", role: String = "", window: CGRect? = nil, windowTitle: String = "") {
        self.label = label; self.owner = owner; self.role = role; self.window = window; self.windowTitle = windowTitle
    }
}

public struct WatchedStep: Identifiable, Sendable {
    public var id = UUID()
    public var app: String
    public var action: String
    public var detail: String
    public var label: String
    public var input: String
    public var x: Double?
    public var y: Double?
    public var toX: Double?
    public var toY: Double?
    public var delay: Double
    public var at: Date
    public var owner: String
    public var role: String
    public var window: CGRect?
    public var windowTitle: String
    /// Screen region saved as a picture for this step (see `SkillFrames`), once the capture lands.
    public var frame: CGRect?
    public init(app: String, action: String, detail: String, label: String = "", input: String = "",
                x: Double? = nil, y: Double? = nil, toX: Double? = nil, toY: Double? = nil,
                delay: Double = 0, at: Date = Date(), owner: String = "", role: String = "", window: CGRect? = nil,
                windowTitle: String = "", frame: CGRect? = nil) {
        self.app = app; self.action = action; self.detail = detail; self.label = label; self.input = input
        self.x = x; self.y = y; self.toX = toX; self.toY = toY; self.delay = delay; self.at = at
        self.owner = owner; self.role = role; self.window = window; self.windowTitle = windowTitle; self.frame = frame
    }

    public var step: SkillStep {
        SkillStep(id: id.uuidString, text: detail.isEmpty ? action : detail, app: app, x: x, y: y, action: action,
                  label: label.isEmpty ? nil : label, input: input.isEmpty ? nil : input,
                  toX: toX, toY: toY, delay: delay,
                  owner: owner.isEmpty || owner == app ? nil : owner, role: role.isEmpty ? nil : role, window: window,
                  windowTitle: windowTitle, frame: frame)
    }
}

/// Watches the whole Mac while the user does a task once: clicks, double and right clicks, drags,
/// typed text, keyboard shortcuts, scrolls and app switches. Points are in Quartz space
/// (top-left origin) so they line up with what the replayer posts.
@MainActor
public final class WatchRecorder: ObservableObject {
    @Published public private(set) var isRecording = false
    @Published public private(set) var steps: [WatchedStep] = []
    @Published public private(set) var startedAt: Date?
    /// Name the user picked before recording, if any.
    @Published public var pendingName = ""

    public var onFinish: (([WatchedStep]) -> Void)?

    private var monitors: [Any] = []
    private var appObserver: NSObjectProtocol?
    private var lastApp = ""
    private var lastAppAt = Date.distantPast
    private var lastStepAt = Date()

    private var mouseDownPoint: CGPoint?
    private var mouseDownIndex: Int?

    private var typing = ""
    private var typingApp = ""
    private var typingFlush: DispatchWorkItem?

    /// Raw device delta (before the natural-scrolling flip), so replay posts what the device sent.
    private var scrollDevice: Double = 0
    /// User-facing delta, only used to say "up" or "down".
    private var scrollShown: Double = 0
    private var scrollPoint: CGPoint?
    private var scrollApp = ""
    private var scrollWindow: CGRect?
    private var scrollWindowTitle = ""
    private var scrollFlush: DispatchWorkItem?

    /// Overridable so the event pipeline can be driven in tests without a real screen.
    var frontAppProvider: () -> String = { SkillReplayGeometry.cleanAppName(NSWorkspace.shared.frontmostApplication?.localizedName ?? "mac") }
    var targetProvider: (CGPoint) -> WatchedTarget = WatchRecorder.systemTarget(at:)
    /// Takes the picture of the screen around a point. Nil turns pictures off (tests).
    var frameProvider: ((CGPoint) async -> SkillFrames.Capture?)? = { await SkillFrames.capture(around: $0) }
    /// Saves a picture for a step. Overridable so tests can see what would be written.
    var frameSaver: (SkillFrames.Capture, String) async -> Bool = { await SkillFrames.save($0, stepID: $1) }

    /// Starts and stops watching the display for pictures. Nil turns that off (tests).
    var frameSession: ((Bool) async -> Void)? = { starting in
        if starting { await SkillFrames.prepare() } else { SkillFrames.finish() }
    }

    /// One recording's pictures: which are still being taken or written, and which landed where.
    /// Its own object so a recording started right after another stopped can't mix them up.
    final class FrameLedger: @unchecked Sendable {
        private let lock = NSLock()
        private var pending: [String: Task<Void, Never>] = [:]
        private var rects: [String: CGRect] = [:]

        func begin(_ id: String, _ task: Task<Void, Never>) { lock.lock(); pending[id] = task; lock.unlock() }
        func end(_ id: String, rect: CGRect?) {
            lock.lock()
            pending[id] = nil
            if let rect { rects[id] = rect }
            lock.unlock()
        }
        var inFlight: [Task<Void, Never>] { lock.lock(); defer { lock.unlock() }; return Array(pending.values) }
        var saved: [String: CGRect] { lock.lock(); defer { lock.unlock() }; return rects }

        /// Waits for the pictures still in flight, but not for ever.
        func settle(within seconds: TimeInterval) async {
            let tasks = inFlight
            guard !tasks.isEmpty else { return }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { for task in tasks { await task.value } }
                group.addTask { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
                await group.next()
                group.cancelAll()
            }
        }
    }

    private var ledger = FrameLedger()
    /// The ledger of the recording that last finished, for cleaning up steps that weren't kept.
    private var finishedLedger: FrameLedger?
    /// Label-only shorthand for tests that don't care about owner, role or window.
    var labelProvider: (CGPoint) -> String {
        get { { [targetProvider] in targetProvider($0).label } }
        set { targetProvider = { WatchedTarget(label: newValue($0)) } }
    }
    /// Typing idle gap before the buffered text becomes a step.
    var typingIdle: TimeInterval = 2.5
    /// Idle gap that ends a scroll gesture.
    var scrollIdle: TimeInterval = 0.8

    public init() {}

    public var frontApp: String { frontAppProvider() }

    public func start(name: String = "") {
        guard !isRecording else { return }
        steps = []
        typing = ""
        typingApp = ""
        scrollDevice = 0
        scrollShown = 0
        scrollPoint = nil
        scrollWindow = nil
        mouseDownPoint = nil
        mouseDownIndex = nil
        pendingName = name
        ledger = FrameLedger()
        isRecording = true
        startedAt = Date()
        lastStepAt = Date()
        lastApp = frontApp
        lastAppAt = .distantPast
        // Watching the display from the start means the first click's picture is already pre-click.
        if frameProvider != nil, let frameSession { Task { await frameSession(true) } }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] event in
            let point = Self.quartzPoint(event)
            let count = event.clickCount
            let type = event.type
            Task { @MainActor in self?.mouseDown(type: type, at: point, clickCount: count) }
        }) {
            monitors.append(monitor)
        }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp], handler: { [weak self] event in
            let point = Self.quartzPoint(event)
            Task { @MainActor in self?.mouseUp(at: point) }
        }) {
            monitors.append(monitor)
        }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            let keyCode = event.keyCode
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let chars = event.characters ?? ""
            let plain = event.charactersIgnoringModifiers ?? ""
            let repeated = event.isARepeat
            Task { @MainActor in self?.keyDown(keyCode: keyCode, flags: flags, chars: chars, plain: plain, repeated: repeated) }
        }) {
            monitors.append(monitor)
        }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel], handler: { [weak self] event in
            let point = Self.quartzPoint(event)
            let shown = event.scrollingDeltaY
            let device = event.isDirectionInvertedFromDevice ? -shown : shown
            Task { @MainActor in self?.scrolled(at: point, shown: shown, device: device) }
        }) {
            monitors.append(monitor)
        }

        appObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let running = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let app = SkillReplayGeometry.cleanAppName(running?.localizedName ?? "app")
            let own = running?.bundleIdentifier == Bundle.main.bundleIdentifier
            Task { @MainActor in self.appSwitched(to: app, own: own) }
        }
    }

    /// Stops and hands the steps to `onFinish`: at once when every picture has landed, otherwise as
    /// soon as they have (a click just before Stop may still be writing its picture).
    public func stop() {
        guard isRecording else { return }
        flushTyping()
        flushScroll()
        let ledger = self.ledger
        let recorded = steps
        tearDown()
        finishedLedger = ledger
        guard !ledger.inFlight.isEmpty else { onFinish?(Self.attach(ledger.saved, to: recorded)); return }
        Task { [weak self] in
            await ledger.settle(within: 1.5)
            guard let self else { return }
            let finished = Self.attach(ledger.saved, to: recorded)
            // Only while this is still the latest recording; a newer one shows its own steps.
            if !self.isRecording { self.steps = finished }
            self.onFinish?(finished)
        }
    }

    private static func attach(_ rects: [String: CGRect], to steps: [WatchedStep]) -> [WatchedStep] {
        var out = steps
        for index in out.indices { out[index].frame = rects[out[index].id.uuidString] }
        return out
    }

    /// Stops and throws the recording away, pictures included.
    public func cancel() {
        guard isRecording else { return }
        let ledger = self.ledger
        tearDown()
        steps = []
        Task.detached(priority: .utility) {
            await ledger.settle(within: 3)
            SkillFrames.remove(Array(ledger.saved.keys))
        }
    }

    /// Picture clean-up for steps that were recorded but not kept.
    public func dropFrames(except kept: [WatchedStep]) {
        guard let finishedLedger else { return }
        let keep = Set(kept.map(\.id.uuidString))
        SkillFrames.remove(finishedLedger.saved.keys.filter { !keep.contains($0) }.sorted())
    }

    private func tearDown() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let appObserver { NSWorkspace.shared.notificationCenter.removeObserver(appObserver) }
        appObserver = nil
        typingFlush?.cancel()
        scrollFlush?.cancel()
        typingFlush = nil
        scrollFlush = nil
        if frameProvider != nil, let frameSession { Task { await frameSession(false) } }
        typing = ""
        scrollPoint = nil
        mouseDownPoint = nil
        mouseDownIndex = nil
        isRecording = false
    }

    // MARK: - Events

    func mouseDown(type: NSEvent.EventType, at point: CGPoint, clickCount: Int) {
        guard isRecording else { return }
        flushTyping()
        flushScroll()
        let app = frontApp

        // Second (or third) press of a multi-click: fold it into the step the first press made.
        if clickCount >= 2, type == .leftMouseDown, let last = steps.indices.last,
           steps[last].action == "click" || steps[last].action == "double-click", near(steps[last], point) {
            if steps[last].action == "click" {
                let where_ = steps[last].label.isEmpty ? "at \(Int(point.x)), \(Int(point.y))" : "“\(steps[last].label)”"
                steps[last].action = "double-click"
                steps[last].detail = "in \(steps[last].app), double-click \(where_)"
            }
            mouseDownIndex = nil
            mouseDownPoint = nil
            return
        }

        let target = targetProvider(point)
        let label = target.label
        let where_ = label.isEmpty ? "at \(Int(point.x)), \(Int(point.y))" : "“\(label)”"
        let action: String
        switch type {
        case .rightMouseDown: action = "right-click"
        case .otherMouseDown: action = "middle-click"
        default: action = "click"
        }
        // A click on the Dock or a menu bar extra belongs to that surface, not to whichever app
        // happened to be in front; the sentence says so and replay won't try to activate it.
        let shown = SkillReplayGeometry.isSystemSurface(target.owner) ? target.owner : app
        let step = WatchedStep(app: shown, action: action, detail: "in \(shown), \(action) \(where_)",
                               label: label, x: point.x, y: point.y, owner: target.owner, role: target.role,
                               window: target.window, windowTitle: target.windowTitle)
        append(step)
        takePicture(for: step.id, at: point)
        if type == .leftMouseDown {
            mouseDownPoint = point
            mouseDownIndex = steps.indices.last
        }
    }

    // MARK: - Pictures

    /// Saves what the screen looked like around a step's point, as it was just before the step.
    private func takePicture(for id: UUID, at point: CGPoint) {
        guard let provider = frameProvider else { return }
        let key = id.uuidString
        let saver = frameSaver
        let ledger = self.ledger
        ledger.begin(key, Task { [weak self] in
            guard let capture = await provider(point), await saver(capture, key) else {
                ledger.end(key, rect: nil)
                return
            }
            ledger.end(key, rect: capture.rect)
            await MainActor.run {
                guard let self, self.ledger === ledger,
                      let index = self.steps.firstIndex(where: { $0.id == id }) else { return }
                self.steps[index].frame = capture.rect
            }
        })
    }

    func mouseUp(at point: CGPoint) {
        guard isRecording, let from = mouseDownPoint, let index = mouseDownIndex else { return }
        mouseDownPoint = nil
        mouseDownIndex = nil
        guard steps.indices.contains(index), steps[index].action == "click" else { return }
        let distance = hypot(point.x - from.x, point.y - from.y)
        guard distance > 8 else { return }
        var step = steps[index]
        step.action = "drag"
        step.toX = point.x
        step.toY = point.y
        let what = step.label.isEmpty ? "from \(Int(from.x)), \(Int(from.y))" : "“\(step.label)”"
        step.detail = "in \(step.app), drag \(what) to \(Int(point.x)), \(Int(point.y))"
        steps[index] = step
    }

    func keyDown(keyCode: UInt16, flags: NSEvent.ModifierFlags, chars: String, plain: String, repeated: Bool) {
        guard isRecording else { return }
        let app = frontApp
        let modified = flags.contains(.command) || flags.contains(.control) || flags.contains(.option)
        let special = Self.specialKeyName(keyCode)

        if modified || special != nil {
            flushTyping()
            flushScroll()
            let name = Self.comboName(keyCode: keyCode, flags: flags, plain: plain)
            append(WatchedStep(app: app, action: "key", detail: "in \(app), press \(Self.prettyCombo(name))", input: name))
            return
        }

        // Plain typing. Private-use scalars are function keys we don't name; control chars aren't text.
        let printable = !chars.isEmpty && chars.unicodeScalars.allSatisfy {
            $0.value >= 32 && $0.value != 127 && !(0xF700...0xF8FF).contains($0.value)
        }
        guard printable else { return }
        if repeated, typing.isEmpty { return }
        if typingApp != app, !typing.isEmpty { flushTyping() }
        flushScroll()
        typingApp = app
        typing += chars
        typingFlush?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushTyping() }
        typingFlush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + typingIdle, execute: work)
    }

    func scrolled(at point: CGPoint, shown: Double, device: Double) {
        guard isRecording else { return }
        flushTyping()
        if scrollPoint == nil {
            scrollPoint = point
            scrollApp = frontApp
            let target = targetProvider(point)
            scrollWindow = target.window
            scrollWindowTitle = target.windowTitle
            scrollDevice = 0
            scrollShown = 0
        }
        scrollDevice += device
        scrollShown += shown
        scrollFlush?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushScroll() }
        scrollFlush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + scrollIdle, execute: work)
    }

    func appSwitched(to app: String, own: Bool) {
        guard isRecording, !own else { return }
        flushTyping()
        flushScroll()
        if app != lastApp, Date().timeIntervalSince(lastAppAt) > 0.6 {
            lastApp = app
            lastAppAt = Date()
            append(WatchedStep(app: app, action: "switch", detail: "switch to \(app)"))
        }
    }

    func flushTyping() {
        typingFlush?.cancel()
        typingFlush = nil
        guard !typing.isEmpty else { return }
        let text = typing
        typing = ""
        let shown = text.count > 48 ? String(text.prefix(45)) + "…" : text
        append(WatchedStep(app: typingApp, action: "type", detail: "in \(typingApp), type “\(shown)”", input: text))
    }

    func flushScroll() {
        scrollFlush?.cancel()
        scrollFlush = nil
        guard let point = scrollPoint else { return }
        let device = scrollDevice
        let shown = scrollShown
        let window = scrollWindow
        let title = scrollWindowTitle
        scrollPoint = nil
        scrollWindow = nil
        scrollWindowTitle = ""
        scrollDevice = 0
        scrollShown = 0
        guard abs(device) >= 4 else { return }
        let direction = shown > 0 ? "up" : "down"
        append(WatchedStep(app: scrollApp, action: "scroll", detail: "in \(scrollApp), scroll \(direction)",
                           x: point.x, y: point.y, toX: 0, toY: device, window: window, windowTitle: title))
    }

    private func append(_ step: WatchedStep) {
        var step = step
        step.delay = max(0, Date().timeIntervalSince(lastStepAt))
        lastStepAt = Date()
        steps.append(step)
    }

    private func near(_ step: WatchedStep, _ point: CGPoint) -> Bool {
        guard let x = step.x, let y = step.y else { return false }
        return abs(x - point.x) < 6 && abs(y - point.y) < 6
    }

    // MARK: - Helpers

    nonisolated private static func quartzPoint(_ event: NSEvent) -> CGPoint {
        if let location = event.cgEvent?.location { return location }
        let height = NSScreen.screens.first?.frame.height ?? 0
        let p = NSEvent.mouseLocation
        return CGPoint(x: p.x, y: height - p.y)
    }

    nonisolated private static func systemTarget(at point: CGPoint) -> WatchedTarget {
        guard AXIsProcessTrusted() else { return WatchedTarget() }
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element)
        guard result == .success, let element else { return WatchedTarget() }
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        let owner = pid > 0 ? SkillReplayGeometry.cleanAppName(NSRunningApplication(processIdentifier: pid)?.localizedName ?? "") : ""
        var windowRef: CFTypeRef?
        var window: CGRect?
        var title = ""
        if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
           let windowRef, let windowElement = AXSearch.axElement(windowRef) {
            window = AXSearch.frame(of: windowElement)
            title = AXSearch.stringAttribute(kAXTitleAttribute, of: windowElement)
        }
        return WatchedTarget(label: AccessibilityLabel.of(element), owner: owner,
                             role: AXSearch.stringAttribute(kAXRoleAttribute, of: element), window: window, windowTitle: title)
    }

    nonisolated static func specialKeyName(_ keyCode: UInt16) -> String? {
        switch Int(keyCode) {
        case kVK_Return, kVK_ANSI_KeypadEnter: return "return"
        case kVK_Tab: return "tab"
        case kVK_Escape: return "escape"
        case kVK_Delete: return "delete"
        case kVK_ForwardDelete: return "forwarddelete"
        case kVK_LeftArrow: return "left"
        case kVK_RightArrow: return "right"
        case kVK_UpArrow: return "up"
        case kVK_DownArrow: return "down"
        case kVK_Home: return "home"
        case kVK_End: return "end"
        case kVK_PageUp: return "pageup"
        case kVK_PageDown: return "pagedown"
        case kVK_F1: return "f1"
        case kVK_F2: return "f2"
        case kVK_F3: return "f3"
        case kVK_F4: return "f4"
        case kVK_F5: return "f5"
        case kVK_F6: return "f6"
        case kVK_F7: return "f7"
        case kVK_F8: return "f8"
        case kVK_F9: return "f9"
        case kVK_F10: return "f10"
        case kVK_F11: return "f11"
        case kVK_F12: return "f12"
        default: return nil
        }
    }

    /// "cmd+shift+s", "shift+tab", "return". Keys the table doesn't know keep their code as "key51".
    nonisolated static func comboName(keyCode: UInt16, flags: NSEvent.ModifierFlags, plain: String) -> String {
        var parts: [String] = []
        if flags.contains(.control) { parts.append("ctrl") }
        if flags.contains(.option) { parts.append("alt") }
        if flags.contains(.shift) { parts.append("shift") }
        if flags.contains(.command) { parts.append("cmd") }
        let key: String
        if let special = specialKeyName(keyCode) {
            key = special
        } else if Int(keyCode) == kVK_Space {
            key = "space"
        } else if AccessibilityActions.knowsKey(plain.lowercased()) {
            key = plain.lowercased()
        } else {
            key = "key\(keyCode)"
        }
        parts.append(key)
        return parts.joined(separator: "+")
    }

    nonisolated public static func prettyCombo(_ combo: String) -> String {
        combo.split(separator: "+").map { part -> String in
            switch part {
            case "cmd": return "⌘"
            case "shift": return "⇧"
            case "alt": return "⌥"
            case "ctrl": return "⌃"
            case "return": return "↩"
            case "tab": return "⇥"
            case "escape": return "esc"
            case "delete": return "⌫"
            case "forwarddelete": return "⌦"
            case "left": return "←"
            case "right": return "→"
            case "up": return "↑"
            case "down": return "↓"
            case "space": return "space"
            case "pageup": return "page up"
            case "pagedown": return "page down"
            default:
                if part.hasPrefix("key"), part.dropFirst(3).allSatisfy(\.isNumber) { return "key \(part.dropFirst(3))" }
                return part.count == 1 ? part.uppercased() : String(part)
            }
        }.joined()
    }
}

// MARK: - Accessibility labels

public enum AccessibilityLabel {
    /// A stable, human handle for an element: its title, description or (for non-text controls) value.
    public static func of(_ element: AXUIElement) -> String {
        func attribute(_ key: String) -> String {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return "" }
            if let string = value as? String { return string }
            if let number = value as? NSNumber { return "\(number)" }
            return ""
        }
        let title = attribute(kAXTitleAttribute)
        let description = attribute(kAXDescriptionAttribute)
        let role = attribute(kAXRoleAttribute)
        let value = attribute(kAXValueAttribute)
        // Text fields carry their whole contents in AXValue; that's not a stable handle.
        let textual = role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXStaticText"
        let candidates = textual ? [title, description] : [title, description, value]
        let best = candidates.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
        return String(best.trimmingCharacters(in: .whitespacesAndNewlines).prefix(70))
    }
}

// MARK: - Posting input

public enum AccessibilityActions {
    public static var canPost: Bool { AXIsProcessTrusted() || CGPreflightPostEventAccess() }

    public static func move(to point: CGPoint) {
        let source = CGEventSource(stateID: .hidSystemState)
        let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        move?.post(tap: .cghidEventTap)
    }

    public static func click(at point: CGPoint, button: String = "left", count: Int = 1) -> Bool {
        guard canPost else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        move?.post(tap: .cghidEventTap)
        usleep(60_000)
        let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
            switch button {
            case "right": return (.rightMouseDown, .rightMouseUp, .right)
            case "middle": return (.otherMouseDown, .otherMouseUp, .center)
            default: return (.leftMouseDown, .leftMouseUp, .left)
            }
        }()
        let presses = max(1, count)
        for n in 1...presses {
            let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            down?.post(tap: .cghidEventTap)
            usleep(40_000)
            up?.post(tap: .cghidEventTap)
            if n < presses { usleep(90_000) }
        }
        return true
    }

    public static func drag(from: CGPoint, to: CGPoint) -> Bool {
        guard canPost else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(60_000)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(80_000)
        let frames = 12
        for i in 1...frames {
            let t = Double(i) / Double(frames)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(16_000)
        }
        usleep(80_000)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
        return true
    }

    /// `dy` is the raw device delta in pixels; the system applies the user's scroll direction itself.
    public static func scroll(at point: CGPoint, dy: Double) -> Bool {
        guard canPost else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40_000)
        var remaining = Int32(max(-20_000, min(20_000, dy.rounded())))
        while remaining != 0 {
            let chunk = max(-60, min(60, remaining))
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: chunk, wheel2: 0, wheel3: 0)
            event?.post(tap: .cghidEventTap)
            remaining -= chunk
            usleep(10_000)
        }
        return true
    }

    public static func type(_ text: String) -> Bool {
        guard canPost else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        for character in text {
            // One keystroke per character; characters outside the BMP need both UTF-16 units.
            var units = Array(String(character).utf16)
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            down?.post(tap: .cghidEventTap)
            usleep(12_000)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            up?.post(tap: .cghidEventTap)
        }
        return true
    }

    /// Presses a combo like "cmd+shift+s", a single key like "return", or a raw "key51".
    public static func press(_ combo: String) -> Bool {
        guard canPost else { return false }
        let parts = combo.lowercased().split(separator: "+").map(String.init)
        guard let keyName = parts.last else { return false }
        var flags: CGEventFlags = []
        for part in parts.dropLast() {
            switch part {
            case "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            default: break
            }
        }
        guard let code = keyCode(for: keyName) else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        usleep(40_000)
        up?.post(tap: .cghidEventTap)
        return true
    }

    public static func knowsKey(_ name: String) -> Bool { keyCodes[name] != nil }

    private static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
        "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
        "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
        "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
        "\\": kVK_ANSI_Backslash, ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma,
        ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, "`": kVK_ANSI_Grave,
        "space": kVK_Space, "return": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape,
        "delete": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
        "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
        "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
    ]

    private static func keyCode(for name: String) -> CGKeyCode? {
        if let known = keyCodes[name] { return CGKeyCode(known) }
        if name.hasPrefix("key"), let raw = UInt16(name.dropFirst(3)) { return CGKeyCode(raw) }
        return nil
    }
}
