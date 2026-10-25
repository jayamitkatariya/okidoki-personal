import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

// MARK: - Geometry

/// A rectangle in CG global coordinates (origin at the top-left of the main display, y downward).
public struct ScreenBox: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }

    public var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

// MARK: - Action model

public struct ComputerAction: Codable, Equatable, Sendable {
    public var type: String
    public var x: Double?
    public var y: Double?
    public var fromX: Double?
    public var fromY: Double?
    public var toX: Double?
    public var toY: Double?
    public var app: String?
    public var text: String?
    public var key: String?
    public var dx: Double?
    public var dy: Double?
    public var seconds: Double?
    public var reason: String?
    public var summary: String?
    public var say: String?
    /// AppleScript, JXA, or shell source for a `script` action.
    public var script: String?
    /// "applescript" (default), "javascript", or "shell".
    public var lang: String?
    /// Accessibility label. When it matches a control, the click lands on that control's center.
    public var target: String?
    /// Region size for `zoom`, in screenshot pixels.
    public var width: Double?
    public var height: Double?
    /// How many times to press a `key`.
    public var times: Int?
    /// Modifier keys held during a click, e.g. "cmd" or "cmd+shift".
    public var modifiers: String?
    /// v2: the model's tool call this action answers.
    public var toolUseID: String?
    /// v2: the tool the model called ("left_click", "click_element", "run_script", …).
    public var tool: String?
    /// v2: a member of the computer use toolset (its result must say so).
    public var member: Bool?
    /// v2: number of a control from the step's numbered list, for `click_element`.
    public var element: Int?
    /// v2: "left", "right" or "middle", for `click_element`.
    public var button: String?

    public init(type: String, x: Double? = nil, y: Double? = nil,
                fromX: Double? = nil, fromY: Double? = nil, toX: Double? = nil, toY: Double? = nil,
                app: String? = nil, text: String? = nil, key: String? = nil,
                dx: Double? = nil, dy: Double? = nil, seconds: Double? = nil,
                reason: String? = nil, summary: String? = nil, say: String? = nil,
                script: String? = nil, lang: String? = nil, target: String? = nil,
                width: Double? = nil, height: Double? = nil, times: Int? = nil, modifiers: String? = nil) {
        self.type = type; self.x = x; self.y = y
        self.fromX = fromX; self.fromY = fromY; self.toX = toX; self.toY = toY
        self.app = app; self.text = text; self.key = key
        self.dx = dx; self.dy = dy; self.seconds = seconds
        self.reason = reason; self.summary = summary; self.say = say
        self.script = script; self.lang = lang; self.target = target
        self.width = width; self.height = height; self.times = times; self.modifiers = modifiers
    }

    enum CodingKeys: String, CodingKey {
        case type, x, y, fromX = "from_x", fromY = "from_y", toX = "to_x", toY = "to_y"
        case app, text, key, dx, dy, seconds, reason, summary, say
        case script, lang, language, target
        case width, height, times, count, modifiers, modifier
        case toolUseID = "id", tool, member, element, button
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func num(_ key: CodingKeys) -> Double? {
            if let v = try? c.decodeIfPresent(Double.self, forKey: key) { return v }
            if let v = try? c.decodeIfPresent(Int.self, forKey: key) { return Double(v) }
            return nil
        }
        type = (try? c.decode(String.self, forKey: .type)) ?? "fail"
        x = num(.x); y = num(.y)
        fromX = num(.fromX); fromY = num(.fromY); toX = num(.toX); toY = num(.toY)
        if let v = try? c.decodeIfPresent(Double.self, forKey: .dx) { dx = v } else if let v = try? c.decodeIfPresent(Int.self, forKey: .dx) { dx = Double(v) }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .dy) { dy = v } else if let v = try? c.decodeIfPresent(Int.self, forKey: .dy) { dy = Double(v) }
        if let v = try? c.decodeIfPresent(Double.self, forKey: .seconds) { seconds = v } else if let v = try? c.decodeIfPresent(Int.self, forKey: .seconds) { seconds = Double(v) }
        app = try? c.decodeIfPresent(String.self, forKey: .app)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        say = try? c.decodeIfPresent(String.self, forKey: .say)
        script = try? c.decodeIfPresent(String.self, forKey: .script)
        lang = (try? c.decodeIfPresent(String.self, forKey: .lang))
            ?? (try? c.decodeIfPresent(String.self, forKey: .language))
        target = try? c.decodeIfPresent(String.self, forKey: .target)
        width = num(.width); height = num(.height)
        times = (num(.times) ?? num(.count)).map { Int($0) }
        modifiers = (try? c.decodeIfPresent(String.self, forKey: .modifiers))
            ?? (try? c.decodeIfPresent(String.self, forKey: .modifier))
        toolUseID = try? c.decodeIfPresent(String.self, forKey: .toolUseID)
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
        member = try? c.decodeIfPresent(Bool.self, forKey: .member)
        element = num(.element).map { Int($0) }
        button = try? c.decodeIfPresent(String.self, forKey: .button)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(x, forKey: .x)
        try c.encodeIfPresent(y, forKey: .y)
        try c.encodeIfPresent(fromX, forKey: .fromX)
        try c.encodeIfPresent(fromY, forKey: .fromY)
        try c.encodeIfPresent(toX, forKey: .toX)
        try c.encodeIfPresent(toY, forKey: .toY)
        try c.encodeIfPresent(app, forKey: .app)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encodeIfPresent(dx, forKey: .dx)
        try c.encodeIfPresent(dy, forKey: .dy)
        try c.encodeIfPresent(seconds, forKey: .seconds)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encodeIfPresent(summary, forKey: .summary)
        try c.encodeIfPresent(say, forKey: .say)
        try c.encodeIfPresent(script, forKey: .script)
        try c.encodeIfPresent(lang, forKey: .lang)
        try c.encodeIfPresent(target, forKey: .target)
        try c.encodeIfPresent(width, forKey: .width)
        try c.encodeIfPresent(height, forKey: .height)
        try c.encodeIfPresent(times, forKey: .times)
        try c.encodeIfPresent(modifiers, forKey: .modifiers)
        try c.encodeIfPresent(toolUseID, forKey: .toolUseID)
        try c.encodeIfPresent(tool, forKey: .tool)
        try c.encodeIfPresent(member, forKey: .member)
        try c.encodeIfPresent(element, forKey: .element)
        try c.encodeIfPresent(button, forKey: .button)
    }

    public var dictionary: [String: Any] {
        (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:]
    }
}

// MARK: - Errors

public enum ComputerUseError: LocalizedError {
    case accessibility
    case screenCapture
    case appNotFound(String)

    public var errorDescription: String? {
        switch self {
        case .accessibility:
            return "okidoki needs accessibility to move the mouse and type. grant it in system settings › privacy & security › accessibility."
        case .screenCapture:
            return "okidoki needs screen recording to see your screen. grant it in system settings › privacy & security › screen recording."
        case .appNotFound(let name):
            return "i couldn't find an app called “\(name)” on this mac."
        }
    }
}

// MARK: - Virtual keys

enum VirtualKeys {
    static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "esc": 53, "escape": 53, "tab": 48, "space": 49,
        "delete": 51, "backspace": 51, "forwarddelete": 117, "home": 115, "end": 119,
        "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
        "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
        "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44,
        "`": 50, "grave": 50, "backtick": 50, "capslock": 57, "fn": 63, "help": 114, "insert": 114,
        "clear": 71, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        "ret": 36, "del": 51, "pgup": 116, "pgdn": 121, "pgdown": 121, "spacebar": 49,
        "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
        "leftarrow": 123, "rightarrow": 124, "downarrow": 125, "uparrow": 126,
        "minus": 27, "equal": 24, "equals": 24, "comma": 43, "period": 47, "dot": 47, "slash": 44,
        "backslash": 42, "semicolon": 41, "quote": 39, "apostrophe": 39,
        "leftbracket": 33, "rightbracket": 30, "keypadenter": 76, "numpadenter": 76,
    ]

    /// Names that mean a shifted key on a US layout. Used when the live layout can't tell us.
    static let shifted: [String: String] = [
        "plus": "=", "+": "=", "underscore": "-", "_": "-", "tilde": "`", "~": "`",
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
        "exclamation": "1", "question": "/", "colon": ";", "pipe": "\\",
    ]

    /// Left-side modifier key plus the flag that key sets.
    static func modifier(_ name: String) -> (code: CGKeyCode, flag: CGEventFlags)? {
        switch name {
        case "cmd", "command", "⌘", "meta", "super", "win": return (55, .maskCommand)
        case "ctrl", "control", "⌃", "^": return (59, .maskControl)
        case "opt", "option", "alt", "⌥": return (58, .maskAlternate)
        case "shift", "⇧": return (56, .maskShift)
        default: return nil
        }
    }

    /// Pieces of a combo like "cmd+shift+a", "cmd-shift-a", "⌘S", or "ctrl + c".
    static func pieces(of combo: String) -> [String] {
        var text = combo.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // A trailing "+" typed by the model means the plus key; one left by a symbol like ⌘ does not.
        let literalPlus = text.hasSuffix("+")
        text = text
            .replacingOccurrences(of: "⌘", with: "cmd+")
            .replacingOccurrences(of: "⌥", with: "opt+")
            .replacingOccurrences(of: "⇧", with: "shift+")
            .replacingOccurrences(of: "⌃", with: "ctrl+")
            .replacingOccurrences(of: "++", with: "+plus")
        while !literalPlus, text.hasSuffix("+") { text.removeLast() }
        for (spaced, joined) in [("page down", "pagedown"), ("page up", "pageup"), ("arrow down", "down"),
                                 ("arrow up", "up"), ("arrow left", "left"), ("arrow right", "right"),
                                 ("caps lock", "capslock"), ("forward delete", "forwarddelete"),
                                 ("space bar", "space"), ("back space", "backspace")] {
            text = text.replacingOccurrences(of: spaced, with: joined)
        }
        if text.hasSuffix("+") { text.removeLast(); text += "+plus" }
        var parts: [String]
        if text.contains("+") {
            parts = text.split(separator: "+", omittingEmptySubsequences: true).map { String($0) }
        } else if text.count > 1, text.contains("-"), !text.hasSuffix("-") {
            parts = text.split(separator: "-", omittingEmptySubsequences: true).map { String($0) }
        } else if text.count > 1, text.contains(" ") {
            parts = text.split(separator: " ", omittingEmptySubsequences: true).map { String($0) }
        } else {
            parts = [text]
        }
        return parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

// MARK: - Keyboard layout

/// Maps characters to the physical key that produces them on the user's current keyboard layout,
/// so typed text and shortcuts land on the right key for non-US layouts too.
enum KeyLayout {
    struct Stroke: Equatable, Sendable {
        var code: CGKeyCode
        var flags: CGEventFlags
    }

    /// Characters reachable with no modifier or shift only. Dead keys are left out, since pressing
    /// them wouldn't produce the character directly.
    @MainActor static func currentMap() -> [Character: Stroke] {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return build(from: data)
    }

    nonisolated static func build(from data: Data) -> [Character: Stroke] {
        var map: [Character: Stroke] = [:]
        let keyboardType = UInt32(LMGetKbdType())
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            guard let base = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            let modifierSets: [(mask: UInt32, flags: CGEventFlags)] = [(0, []), (UInt32(shiftKey >> 8), .maskShift)]
            for (mask, flags) in modifierSets {
                for code in 0..<128 {
                    var deadKeyState: UInt32 = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    var length = 0
                    let status = UCKeyTranslate(base, UInt16(code), UInt16(kUCKeyActionDown), mask, keyboardType,
                                                0, &deadKeyState, 4, &length, &chars)
                    guard status == noErr, deadKeyState == 0, length == 1,
                          let scalar = UnicodeScalar(chars[0]), scalar.value >= 0x20, scalar.value != 0x7f else { continue }
                    let char = Character(scalar)
                    if map[char] == nil { map[char] = Stroke(code: CGKeyCode(code), flags: flags) }
                }
            }
        }
        return map
    }
}

// MARK: - Event actuator

@MainActor
public enum EventActuator {
    public static var canPost: Bool { AXIsProcessTrusted() || CGPreflightPostEventAccess() }

    /// Stamped into every event we post, so our own monitors can tell a synthetic
    /// escape or mouse move from the user's.
    public nonisolated static let syntheticTag: Int64 = 0x4F4B_4944

    public nonisolated static func isSynthetic(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceUserData) == syntheticTag
    }

    public nonisolated static func isSynthetic(_ event: NSEvent) -> Bool {
        guard let cg = event.cgEvent else { return false }
        return isSynthetic(cg)
    }

    /// Default suppression is 0.25s, which swallows the click that follows a move
    /// and lands it on the old cursor position. Zero keeps every posted event.
    /// Built off the main thread: creating a CGEvent source on the main thread can
    /// deadlock against the window server.
    /// One source for the life of the process. Creating and releasing a source per event
    /// churns window-server state and has deadlocked inside SkyLight.
    nonisolated(unsafe) private static var cachedSource: CGEventSource?
    nonisolated private static let sourceLock = NSLock()

    nonisolated static func makeSource() -> CGEventSource {
        sourceLock.lock()
        defer { sourceLock.unlock() }
        if let cachedSource { return cachedSource }
        let source = CGEventSource(stateID: .hidSystemState) ?? CGEventSource(stateID: .combinedSessionState)!
        source.localEventsSuppressionInterval = 0
        source.userData = syntheticTag
        cachedSource = source
        return source
    }

    nonisolated static func post(_ event: CGEvent?) {
        event?.post(tap: .cghidEventTap)
    }

    static func sleep(_ ms: UInt64) async {
        try? await Task.sleep(nanoseconds: ms * 1_000_000)
    }

    /// Blocking gap between posted events. Only ever called on the detached actuator thread.
    nonisolated static func pause(_ seconds: Double) {
        Thread.sleep(forTimeInterval: seconds)
    }

    nonisolated static func buttonParts(_ button: CGMouseButton) -> (down: CGEventType, up: CGEventType, number: Int64) {
        switch button {
        case .right: return (.rightMouseDown, .rightMouseUp, 1)
        case .center: return (.otherMouseDown, .otherMouseUp, 2)
        default: return (.leftMouseDown, .leftMouseUp, 0)
        }
    }

    nonisolated static func stamp(_ type: CGEventType, at point: CGPoint, button: CGMouseButton,
                      clickState: Int64, source: CGEventSource) -> CGEvent? {
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
        let number = buttonParts(button).number
        event?.setIntegerValueField(.mouseEventClickState, value: clickState)
        event?.setIntegerValueField(.mouseEventButtonNumber, value: number)
        return event
    }

    /// Events for one click sequence. `count` 2 is a double-click (clickState 1, then 2).
    nonisolated static func makeClickEvents(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) -> [CGEvent] {
        let source = makeSource()
        let parts = buttonParts(button)
        var events: [CGEvent] = []
        if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
            events.append(move)
        }
        let clicks = max(1, min(count, 3))
        for index in 1...clicks {
            if let down = stamp(parts.down, at: point, button: button, clickState: Int64(index), source: source) {
                events.append(down)
            }
            if let up = stamp(parts.up, at: point, button: button, clickState: Int64(index), source: source) {
                events.append(up)
            }
        }
        return events
    }

    nonisolated static func makeDragEvents(from origin: CGPoint, to target: CGPoint, steps: Int = 16) -> [CGEvent] {
        let source = makeSource()
        var events: [CGEvent] = []
        if let move = stamp(.mouseMoved, at: origin, button: .left, clickState: 0, source: source) { events.append(move) }
        if let down = stamp(.leftMouseDown, at: origin, button: .left, clickState: 1, source: source) { events.append(down) }
        let count = max(4, steps)
        for index in 1...count {
            let t = Double(index) / Double(count)
            let eased = t * t * (3 - 2 * t)
            let point = CGPoint(x: origin.x + (target.x - origin.x) * eased,
                                y: origin.y + (target.y - origin.y) * eased)
            if let drag = stamp(.leftMouseDragged, at: point, button: .left, clickState: 1, source: source) {
                events.append(drag)
            }
        }
        if let up = stamp(.leftMouseUp, at: target, button: .left, clickState: 1, source: source) { events.append(up) }
        return events
    }

    /// How long pointer travel takes: 1 is a calm, visible glide; smaller is quicker; 0 jumps.
    public static var pace: Double = 1

    public static func setPace(_ name: String) {
        switch name {
        case "fast": pace = 0.45
        case "instant": pace = 0
        default: pace = 1
        }
    }

    /// Travel time for a glide, scaled by distance so short hops stay snappy and long
    /// trips across the screen are easy to follow.
    nonisolated static func glideDuration(distance: Double, pace: Double) -> Double {
        guard pace > 0, distance >= 2 else { return 0 }
        let base = 0.1 + distance / 3200
        return min(max(base, 0.12), 0.35) * pace
    }

    /// Eased path from `origin` to `target`: slow start, slow finish, like a hand moving a mouse.
    nonisolated static func glidePoints(from origin: CGPoint, to target: CGPoint, steps: Int) -> [CGPoint] {
        guard steps > 0 else { return [target] }
        return (1...steps).map { index in
            let t = Double(index) / Double(steps)
            let eased = t * t * (3 - 2 * t)
            return CGPoint(x: origin.x + (target.x - origin.x) * eased,
                           y: origin.y + (target.y - origin.y) * eased)
        }
    }

    /// Moves the real pointer to `target` with mouse-moved events along the way, so the user
    /// can see where it's going and apps get their hover states.
    nonisolated static func glide(to target: CGPoint, pace: Double) {
        let origin = CGEvent(source: nil)?.location ?? target
        let distance = hypot(target.x - origin.x, target.y - origin.y)
        let duration = glideDuration(distance: Double(distance), pace: pace)
        if duration > 0 {
            let steps = max(6, Int(duration * 120))
            let slice = duration / Double(steps)
            let source = makeSource()
            let type: CGEventType = leftButtonHeld ? .leftMouseDragged : .mouseMoved
            for point in glidePoints(from: origin, to: target, steps: steps) {
                post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left))
                pause(slice)
            }
        }
        placeCursor(target)
    }

    public static func move(to point: CGPoint) async {
        guard canPost else { return }
        let pace = pace
        await Task.detached(priority: .userInitiated) {
            glide(to: point, pace: pace)
            if !cursorIsNear(point) { placeCursor(point) }
            pause(0.03)
        }.value
    }

    /// Modifier keys named in text like "cmd+shift", in press order. Nil when a name is unknown.
    public nonisolated static func modifierKeys(_ text: String?) -> [(code: CGKeyCode, flag: CGEventFlags)]? {
        guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        var keys: [(code: CGKeyCode, flag: CGEventFlags)] = []
        for piece in VirtualKeys.pieces(of: text) {
            guard let modifier = VirtualKeys.modifier(piece) else { return nil }
            if !keys.contains(where: { $0.flag == modifier.flag }) { keys.append(modifier) }
        }
        return keys
    }

    /// `held` modifiers are pressed before the click and released after, and stamped on every
    /// mouse event, so cmd-click, shift-click, and option-drag behave like the real thing.
    public static func click(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1,
                             held: [(code: CGKeyCode, flag: CGEventFlags)] = []) async {
        guard canPost else { return }
        let pace = pace
        await Task.detached(priority: .userInitiated) {
            glide(to: point, pace: pace)
            pause(0.04)
            let source = makeSource()
            var flags: CGEventFlags = []
            for modifier in held {
                flags.insert(modifier.flag)
                let down = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: true)
                down?.flags = flags
                post(down)
                pause(0.02)
            }
            func play() {
                placeCursor(point)
                let events = makeClickEvents(at: point, button: button, count: count)
                for (index, event) in events.enumerated() {
                    if !flags.isEmpty { event.flags = flags }
                    post(event)
                    let isDown = event.type == .leftMouseDown || event.type == .rightMouseDown || event.type == .otherMouseDown
                    let isUp = event.type == .leftMouseUp || event.type == .rightMouseUp || event.type == .otherMouseUp
                    let gap = index == 0 ? 0.05 : isDown ? 0.04 : (count > 1 && isUp ? 0.055 : 0.04)
                    pause(gap)
                }
            }
            play()
            if !cursorIsNear(point, tolerance: 8) { play() }
            for modifier in held.reversed() {
                flags.remove(modifier.flag)
                let up = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: false)
                up?.flags = flags
                post(up)
                pause(0.02)
            }
        }.value
    }

    /// Parts of a key combo, for display: "cmd+shift+a" → ["cmd", "shift", "a"].
    public nonisolated static func keyPieces(_ combo: String) -> [String] { VirtualKeys.pieces(of: combo) }

    /// True while a password field (or anything else using secure input) owns the keyboard.
    public nonisolated static var secureInputActive: Bool { IsSecureEventInputEnabled() }

    /// One physical key with the modifiers held for it, resolved on the live keyboard layout.
    /// For targets that take key codes rather than `CGEvent`s, like a virtual machine's view.
    public struct Keystroke: Equatable, Sendable {
        public var code: CGKeyCode
        public var flags: CGEventFlags
        /// The characters this stroke produces, empty for named keys and shortcuts.
        public var characters: String
    }

    /// "cmd+shift+a" → the A key with command and shift held. Nil for an unknown key name.
    public static func keystroke(for combo: String) -> Keystroke? {
        guard let resolved = resolveCombo(combo, layout: KeyLayout.currentMap()) else { return nil }
        var flags = resolved.extraFlags
        for modifier in resolved.mods { flags.insert(modifier.flag) }
        return Keystroke(code: resolved.code, flags: flags, characters: "")
    }

    /// Text as key presses on the live layout. Characters the layout has no key for (emoji,
    /// other scripts) are counted in `skipped`, since a key-only target can't produce them.
    public static func keystrokes(typing text: String) -> (strokes: [Keystroke], skipped: Int) {
        var strokes: [Keystroke] = []
        var skipped = 0
        for step in typeSteps(text, layout: KeyLayout.currentMap()) {
            switch step {
            case .key(let code, let flags, let unicode):
                strokes.append(Keystroke(code: code, flags: flags, characters: String(utf16CodeUnits: unicode, count: unicode.count)))
            case .unicode(let buffer):
                skipped += String(utf16CodeUnits: buffer, count: buffer.count).count
            }
        }
        return (strokes, skipped)
    }

    public static func drag(from origin: CGPoint, to target: CGPoint, duration: Double = 0.55) async {
        guard canPost else { return }
        let pace = pace
        await Task.detached(priority: .userInitiated) {
            glide(to: origin, pace: pace)
            pause(0.05)
            let steps = max(12, Int(duration * 60))
            let events = makeDragEvents(from: origin, to: target, steps: steps)
            let slice = duration / Double(max(events.count, 1))
            for event in events {
                post(event)
                let gap = event.type == .leftMouseDown ? 0.16 : slice
                pause(gap)
            }
            pause(0.04)
        }.value
    }

    /// Above this length the text is pasted through the clipboard instead of typed key by key.
    public static let pasteThreshold = 240

    /// One typing step: a real key with its unicode attached, or a batch of characters
    /// the layout can't produce (emoji, other scripts) sent as a unicode-only event.
    enum TypeStep: Equatable {
        case key(code: CGKeyCode, flags: CGEventFlags, unicode: [UniChar])
        case unicode([UniChar])
    }

    public static func typeText(_ text: String) async {
        guard canPost, !text.isEmpty else { return }
        if text.count > pasteThreshold {
            await pasteText(text)
            return
        }
        let steps = typeSteps(text, layout: KeyLayout.currentMap())
        await Task.detached(priority: .userInitiated) {
            let source = makeSource()
            for step in steps {
                switch step {
                case .key(let code, let flags, var unicode):
                    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
                    down?.flags = flags.union(.maskNonCoalesced)
                    if !unicode.isEmpty { down?.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: &unicode) }
                    post(down)
                    pause(0.005)
                    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
                    up?.flags = flags.union(.maskNonCoalesced)
                    if !unicode.isEmpty { up?.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: &unicode) }
                    post(up)
                    pause(0.006)
                case .unicode(var buffer):
                    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                    down?.flags = .maskNonCoalesced
                    down?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
                    post(down)
                    pause(0.014)
                    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                    up?.flags = .maskNonCoalesced
                    up?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
                    post(up)
                    pause(0.016)
                }
            }
        }.value
    }

    nonisolated static func typeSteps(_ text: String, layout: [Character: KeyLayout.Stroke]) -> [TypeStep] {
        var steps: [TypeStep] = []
        var pending: [UniChar] = []
        func flush() {
            if !pending.isEmpty { steps.append(.unicode(pending)); pending.removeAll() }
        }
        for char in text {
            switch char {
            case "\n", "\r", "\r\n":
                flush(); steps.append(.key(code: 36, flags: [], unicode: []))
            case "\t":
                flush(); steps.append(.key(code: 48, flags: [], unicode: []))
            default:
                if let stroke = layout[char] {
                    flush()
                    steps.append(.key(code: stroke.code, flags: stroke.flags, unicode: Array(String(char).utf16)))
                } else {
                    pending.append(contentsOf: Array(String(char).utf16))
                    if pending.count >= 12 { flush() }
                }
            }
        }
        flush()
        return steps
    }

    /// Pastes through the general pasteboard and puts the user's clipboard back afterwards.
    static func pasteText(_ text: String) async {
        let pasteboard = NSPasteboard.general
        let saved: [NSPasteboardItem] = (pasteboard.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        await sleep(80)
        await pressKey("cmd+v")
        await sleep(400)
        pasteboard.clearContents()
        if !saved.isEmpty { pasteboard.writeObjects(saved) }
    }

    /// Resolves a combo into modifier keys plus the final key. Single characters go through
    /// the live keyboard layout first so shortcuts work on non-US layouts.
    nonisolated static func resolveCombo(_ combo: String, layout: [Character: KeyLayout.Stroke])
        -> (code: CGKeyCode, extraFlags: CGEventFlags, mods: [(code: CGKeyCode, flag: CGEventFlags)])? {
        let pieces = VirtualKeys.pieces(of: combo)
        guard let last = pieces.last else { return nil }
        var mods: [(code: CGKeyCode, flag: CGEventFlags)] = []
        for piece in pieces.dropLast() {
            guard let modifier = VirtualKeys.modifier(piece) else { return nil }
            mods.append(modifier)
        }
        var extra: CGEventFlags = []
        var code: CGKeyCode?
        if let named = VirtualKeys.named[last], last.count > 1 || layout.isEmpty {
            code = named
        } else if last.count == 1, let stroke = layout[Character(last)] {
            code = stroke.code
            extra = stroke.flags
        } else if let shifted = VirtualKeys.shifted[last] {
            if let stroke = layout[Character(shifted)] {
                code = stroke.code
                extra = stroke.flags.union(.maskShift)
            } else if let named = VirtualKeys.named[shifted] {
                code = named
                extra = .maskShift
            }
        } else if let named = VirtualKeys.named[last] {
            code = named
        }
        guard let code else { return nil }
        if extra.contains(.maskShift), !mods.contains(where: { $0.flag == .maskShift }) {
            mods.append((56, .maskShift))
        }
        return (code, extra.subtracting(.maskShift), mods)
    }

    @discardableResult
    public static func pressKey(_ combo: String, times: Int = 1) async -> Bool {
        guard canPost else { return false }
        guard let resolved = resolveCombo(combo, layout: KeyLayout.currentMap()) else { return false }
        let code = resolved.code
        let mods = resolved.mods
        let repeats = min(max(times, 1), 50)
        await Task.detached(priority: .userInitiated) {
          for index in 0..<repeats {
            if index > 0 { pause(0.05) }
            let source = makeSource()
            var flags: CGEventFlags = []
            for modifier in mods {
                flags.insert(modifier.flag)
                let down = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: true)
                down?.flags = flags
                post(down)
                pause(0.012)
            }
            let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
            down?.flags = flags
            post(down)
            pause(0.032)
            let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            up?.flags = flags
            post(up)
            pause(0.016)
            for modifier in mods.reversed() {
                flags.remove(modifier.flag)
                let upMod = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: false)
                upMod?.flags = flags
                post(upMod)
                pause(0.012)
            }
          }
        }.value
        return true
    }

    /// Where the pointer is now, in Quartz global points.
    public nonisolated static func currentPoint() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    /// The left button is held down by `mouseButton(down:)`, so moves are drags.
    nonisolated(unsafe) static var leftButtonHeld = false

    /// Presses or releases the left button where the pointer is, for drags the model builds step by step.
    public static func mouseButton(down: Bool) async {
        guard canPost else { return }
        await Task.detached(priority: .userInitiated) {
            let point = currentPoint()
            let source = makeSource()
            post(stamp(down ? .leftMouseDown : .leftMouseUp, at: point, button: .left, clickState: 1, source: source))
            leftButtonHeld = down
            pause(0.03)
        }.value
    }

    /// Holds a key or combo down for `seconds` (at most 10), then lets go.
    @discardableResult
    public static func holdKey(_ combo: String, seconds: Double) async -> Bool {
        guard canPost, let resolved = resolveCombo(combo, layout: KeyLayout.currentMap()) else { return false }
        let hold = min(max(seconds, 0.05), 10)
        let source = makeSource()
        var flags: CGEventFlags = []
        for modifier in resolved.mods {
            flags.insert(modifier.flag)
            let down = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: true)
            down?.flags = flags
            post(down)
        }
        let down = CGEvent(keyboardEventSource: source, virtualKey: resolved.code, keyDown: true)
        down?.flags = flags
        post(down)
        try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000))
        let up = CGEvent(keyboardEventSource: source, virtualKey: resolved.code, keyDown: false)
        up?.flags = flags
        post(up)
        for modifier in resolved.mods.reversed() {
            flags.remove(modifier.flag)
            let release = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: false)
            release?.flags = flags
            post(release)
        }
        return true
    }

    public static func scroll(dy: Double, dx: Double = 0, at point: CGPoint?) async {
        guard canPost else { return }
        if let point { await move(to: point) }
        let steps = 4
        // Positive dy scrolls content downward. Pixel deltas under a line get truncated to 0.
        func step(_ delta: Double) -> Int32 {
            let raw = Int32((-delta) / Double(steps))
            if raw == 0, delta != 0 { return delta > 0 ? -48 : 48 }
            return raw
        }
        let stepY = step(dy)
        let stepX = step(dx)
        await Task.detached(priority: .userInitiated) {
            let source = makeSource()
            for _ in 0..<steps {
                let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                    wheel1: stepY, wheel2: stepX, wheel3: 0)
                post(event)
                pause(0.04)
            }
        }.value
    }

    /// Puts the pointer on the pixel, then generates a move so the click is not a warp with no event.
    nonisolated static func placeCursor(_ point: CGPoint) {
        CGWarpMouseCursorPosition(point)
        CGAssociateMouseAndMouseCursorPosition(1)
        let source = makeSource()
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    }

    nonisolated static func cursorIsNear(_ point: CGPoint, tolerance: CGFloat = 4) -> Bool {
        guard let live = CGEvent(source: nil)?.location else { return true }
        return hypot(live.x - point.x, live.y - point.y) <= tolerance
    }
}

// MARK: - Accessibility search

public struct AXFound: Equatable, Sendable {
    public var rect: CGRect
    public var label: String
}

/// One actionable control on screen, in Quartz global points.
public struct AXControl: Codable, Equatable, Sendable {
    public var role: String
    public var label: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

public enum AXSearch {
    /// Chromium and Electron apps (Chrome, Slack, Discord, VS Code, Notion, WhatsApp) keep their
    /// accessibility tree empty until a client asks for it. Harmless for everything else.
    public static func enableTree(pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0) // a hung app must not stall the overlay for the 6 s default
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    static func roots(of app: AXUIElement) -> [AXUIElement] {
        var roots: [AXUIElement] = []
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXMenuBarAttribute] {
            var raw: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, attribute as CFString, &raw) == .success,
               let raw, let element = axElement(raw) {
                roots.append(element)
            }
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            roots.append(contentsOf: windows.prefix(6))
        }
        return roots
    }

    /// Best on-screen control whose title or description matches `target`.
    /// Prefers an exact label on a small control over a loose match on a big container.
    public static func find(target: String, pid: pid_t, near: CGPoint? = nil) -> AXFound? {
        locate(target: target, pid: pid, near: near)?.found
    }

    static func locate(target: String, pid: pid_t, near: CGPoint? = nil) -> (element: AXUIElement, found: AXFound)? {
        guard AXIsProcessTrusted(), !target.isEmpty else { return nil }
        enableTree(pid: pid)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0) // a hung app must not stall the overlay for the 6 s default
        var queue: [AXUIElement] = [app] + roots(of: app)
        var visited = 0
        let needle = target.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        var best: (element: AXUIElement, found: AXFound, score: Int)?
        let started = Date()
        let keys = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute,
                    kAXPlaceholderValueAttribute, kAXValueAttribute, kAXRoleAttribute,
                    kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute]
        while !queue.isEmpty && visited < 2600 && Date().timeIntervalSince(started) < 1.6 {
            let element = queue.removeFirst()
            visited += 1
            let raw = batch(element, keys)
            let got = raw.prefix(7).map { $0.map(asString) ?? "" }
            let (title, description, help, identifier, placeholder, value, role) = (got[0], got[1], got[2], got[3], got[4], got[5], got[6])
            let fields = [title, description, help, identifier, placeholder]
            let exact = fields.contains { $0.lowercased().trimmingCharacters(in: .whitespaces) == needle }
                || (value.count < 80 && value.lowercased().trimmingCharacters(in: .whitespaces) == needle)
            let contains = fields.contains { !$0.isEmpty && $0.lowercased().contains(needle) }
                || (value.count < 80 && value.lowercased().contains(needle))
            if (exact || contains), let rect = frame(position: raw[7], size: raw[8]) {
                let lowerRole = role.lowercased()
                let specificRole = ["button", "menuitem", "menubaritem", "text", "link", "cell", "check", "radio", "popup", "tab", "field", "row", "image", "static", "slider", "disclosure", "combobox", "incrementor"]
                    .contains { lowerRole.contains($0) }
                let huge = rect.width > 720 && rect.height > 420
                if (specificRole || exact), !(huge && !exact) {
                    var score = exact ? 120 : 40
                    if lowerRole.contains("button") || lowerRole.contains("menuitem") || lowerRole.contains("link") { score += 25 }
                    if lowerRole.contains("statictext") { score -= 10 }
                    score += max(0, 36 - Int(rect.width / 30))
                    if let near {
                        let distance = hypot(rect.midX - near.x, rect.midY - near.y)
                        if rect.insetBy(dx: -8, dy: -8).contains(near) { score += 60 }
                        else { score -= min(60, Int(distance / 20)) }
                    }
                    let label = [title, description, help, placeholder, value].first { !$0.isEmpty } ?? role
                    if score > (best?.score ?? Int.min) {
                        best = (element, AXFound(rect: rect, label: label), score)
                    }
                }
            }
            if let children = raw[9] as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120))
            }
        }
        guard let best else { return nil }
        return (best.element, best.found)
    }

    /// Several attributes in one round trip to the app instead of one call each. Missing ones are nil.
    nonisolated static func batch(_ element: AXUIElement, _ names: [String]) -> [AnyObject?] {
        var raw: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
        guard status == .success, let values = raw as? [AnyObject], values.count == names.count else {
            return names.map { name in
                var value: CFTypeRef?
                return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
            }
        }
        return values.map { value in
            if value is NSNull { return nil }
            if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
            return value
        }
    }

    nonisolated static func frame(position: AnyObject?, size: AnyObject?) -> CGRect? {
        guard let position, let size,
              CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
              AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
        return CGRect(origin: origin, size: extent)
    }

    /// Presses or opens the menu of a labeled control. More reliable than a coordinate click when it succeeds.
    /// With `near`, the control has to be where the model pointed, so a same-named control elsewhere is ignored.
    @discardableResult

    /// Performs `action` only when the element advertises it, so a text field is never "pressed".
    static func press(_ element: AXUIElement, action: String) -> Bool {
        var actionsRef: CFArray?
        if AXUIElementCopyActionNames(element, &actionsRef) == .success,
           let names = actionsRef as? [String], !names.contains(action) {
            return false
        }
        return AXUIElementPerformAction(element, action as CFString) == .success
    }

    /// One traversal for a click: find the labeled control and, when `action` is given and the
    /// control sits where the model pointed, press it through accessibility.
    public static func findAndMaybePress(target: String, pid: pid_t, near: CGPoint?, action: String?) -> (found: AXFound?, pressed: Bool) {
        guard let hit = locate(target: target, pid: pid, near: near) else { return (nil, false) }
        guard let action else { return (hit.found, false) }
        let agrees = near.map { hit.found.rect.insetBy(dx: -12, dy: -12).contains($0) } ?? true
        guard agrees else { return (hit.found, false) }
        return (hit.found, press(hit.element, action: action))
    }

    static func focusedWindow(pid: pid_t) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0) // a hung app must not stall the overlay for the 6 s default
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &raw) == .success,
              let raw else { return nil }
        return axElement(raw)
    }

    /// Title of the window the app is working in, or empty.
    public static func focusedWindowTitle(pid: pid_t) -> String {
        focusedWindow(pid: pid).map { stringAttribute(kAXTitleAttribute, of: $0) } ?? ""
    }

    /// Frame of the focused window in Quartz global points.
    public static func focusedWindowFrame(pid: pid_t) -> CGRect? {
        focusedWindow(pid: pid).flatMap { frame(of: $0) }
    }

    static let controlRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXTextField",
        "AXTextArea", "AXSearchField", "AXComboBox", "AXLink", "AXMenuItem", "AXMenuBarItem",
        "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXTab", "AXToolbarButton",
        "AXSwitch", "AXColorWell", "AXDateField", "AXTimeField", "AXCell", "AXRow", "AXImage",
        "AXStaticText", "AXHeading", "AXTabButton",
    ]

    /// Actionable controls inside `visible`, in Quartz points. Bounded in time and count so a
    /// heavy app can't stall the step.
    /// Containers that hide whatever falls outside their frame.
    static let clippingRoles: Set<String> = ["AXScrollArea", "AXWindow", "AXSheet", "AXDrawer", "AXPopover", "AXTabGroup", "AXSplitGroup", "AXWebArea"]

    /// Actionable controls inside `visible`, in Quartz points. Elements scrolled out of their
    /// scroll area are skipped. Interactive controls come before plain text so a long document
    /// can't push the buttons off the list. Bounded in time and count.
    public static func controls(pid: pid_t, visible: CGRect, limit: Int = 150, budget: TimeInterval = 1.4) -> [AXControl] {
        snapshot(pid: pid, visible: visible, limit: limit, budget: budget).map(\.control)
    }

    /// One control and the element behind it, so a click can press exactly that control later.
    public struct Entry: @unchecked Sendable {
        public var control: AXControl
        public var element: AXUIElement
    }

    /// Actionable controls inside `visible` with their elements. One batched attribute read per element.
    public static func snapshot(pid: pid_t, visible: CGRect, limit: Int = 150, budget: TimeInterval = 1.4) -> [Entry] {
        guard AXIsProcessTrusted() else { return [] }
        enableTree(pid: pid)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0) // a hung app must not stall the overlay for the 6 s default
        var queue: [(element: AXUIElement, clip: CGRect)] = roots(of: app).map { ($0, visible) }
        var interactive: [Entry] = []
        var text: [Entry] = []
        var seen = Set<String>()
        var visited = 0
        let started = Date()
        let keys = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute,
                    kAXValueAttribute, kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute]
        while !queue.isEmpty && visited < 3000 && interactive.count < limit && Date().timeIntervalSince(started) < budget {
            let (element, clip) = queue.removeFirst()
            visited += 1
            let raw = batch(element, keys)
            let got = raw.prefix(6).map { $0.map(asString) ?? "" }
            let role = got[0]
            let rect = frame(position: raw[6], size: raw[7])
            var childClip = clip
            if clippingRoles.contains(role), let rect {
                childClip = clip.intersection(rect)
                if childClip.isNull || childClip.isEmpty { continue }
            }
            if controlRoles.contains(role), let rect, rect.intersects(clip),
               clip.contains(CGPoint(x: rect.midX, y: rect.midY)) {
                let (title, description, placeholder, value, help) = (got[1], got[2], got[3], got[4], got[5])
                var label = [title, description, placeholder, help].first { !$0.isEmpty } ?? ""
                if label.isEmpty, value.count <= 60, !value.isEmpty, ["AXStaticText", "AXCell", "AXRow", "AXHeading", "AXLink", "AXButton"].contains(role) {
                    label = value
                }
                let isText = ["AXStaticText", "AXHeading", "AXImage"].contains(role)
                let showValue = !value.isEmpty && !isText && value.count <= 40 && value != label
                if !label.isEmpty, !(isText && label.count > 60) {
                    let cleaned = label.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                    let key = "\(role)|\(cleaned)|\(Int(rect.midX))|\(Int(rect.midY))"
                    if !seen.contains(key) {
                        seen.insert(key)
                        let control = AXControl(role: shortRole(role), label: showValue ? "\(cleaned) = \(value)" : cleaned,
                                                x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
                        let entry = Entry(control: control, element: element)
                        if isText { if text.count < limit / 3 { text.append(entry) } } else { interactive.append(entry) }
                    }
                }
            }
            if let children = raw[8] as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120).map { ($0, childClip) })
            }
        }
        return Array((interactive + text).prefix(limit))
    }

    /// Brings an app to the front through accessibility and raises its main window. Works when a
    /// plain activation request from a background app is refused.
    public nonisolated static func raise(pid: pid_t) {
        guard AXIsProcessTrusted() else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            var raw: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, attribute as CFString, &raw) == .success, let raw,
               CFGetTypeID(raw) == AXUIElementGetTypeID() {
                AXUIElementPerformAction(raw as! AXUIElement, kAXRaiseAction as CFString)
                return
            }
        }
    }

    /// Where an element is now, for checking a remembered control hasn't moved before pressing it.
    public nonisolated static func currentFrame(of element: AXUIElement) -> CGRect? {
        let raw = batch(element, [kAXPositionAttribute, kAXSizeAttribute])
        return frame(position: raw[0], size: raw[1])
    }

    /// Presses a remembered control: an accessibility action when it advertises one.
    @discardableResult
    public nonisolated static func perform(_ action: String, on element: AXUIElement) -> Bool {
        press(element, action: action)
    }

    /// Role and label of whatever is under a point, for narrating and checking a click.
    public nonisolated static func describe(at point: CGPoint) -> (role: String, label: String)? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.3)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success, let hit else { return nil }
        let raw = batch(hit, [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXPlaceholderValueAttribute])
        let got = raw.map { $0.map(asString) ?? "" }
        let value = got[3].count <= 60 ? got[3] : ""
        let label = [got[1], got[2], got[4], value].first { !$0.isEmpty } ?? ""
        return (got[0], label.replacingOccurrences(of: "\n", with: " "))
    }

    /// The focused element of the frontmost app: its role, whether it is a text input, and its value.
    public nonisolated static func focusedInput(pid: pid_t) -> (role: String, value: String?)? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let element = raw as! AXUIElement
        let values = batch(element, [kAXRoleAttribute, kAXValueAttribute])
        let role = values[0].map(asString) ?? ""
        let value = values[1].flatMap { $0 is String ? ($0 as! String) : nil }
        return (role, value)
    }

    public nonisolated static let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

    static func shortRole(_ role: String) -> String {
        let trimmed = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        switch trimmed {
        case "StaticText": return "text"
        case "MenuBarItem": return "menubar"
        case "MenuItem": return "menu"
        case "PopUpButton", "MenuButton": return "popup"
        case "TextField", "SearchField", "TextArea", "ComboBox", "DateField", "TimeField": return "field"
        case "CheckBox", "Switch": return "checkbox"
        case "RadioButton", "Tab", "TabButton": return "tab"
        case "DisclosureTriangle": return "disclosure"
        case "ToolbarButton": return "button"
        default: return trimmed.lowercased()
        }
    }

    static func stringAttribute(_ key: String, of element: AXUIElement) -> String {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &raw) == .success, let raw else { return "" }
        return asString(raw)
    }

    static func asString(_ raw: AnyObject) -> String {
        if let string = raw as? String { return string }
        if let number = raw as? NSNumber { return number.stringValue }
        if let attributed = raw as? NSAttributedString { return attributed.string }
        return ""
    }

    /// Several string attributes in one round trip to the app. Missing ones come back empty.
    static func strings(_ keys: [String], of element: AXUIElement) -> [String] {
        var raw: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(element, keys as CFArray, AXCopyMultipleAttributeOptions(), &raw)
        guard status == .success, let values = raw as? [AnyObject], values.count == keys.count else {
            return keys.map { stringAttribute($0, of: element) }
        }
        return values.map(asString)
    }

    static func axElement(_ raw: CFTypeRef) -> AXUIElement? {
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }

    static func frame(of element: AXUIElement) -> CGRect? {
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
        guard size.width > 1, size.height > 1, size.width < 6000, size.height < 4000 else { return nil }
        return CGRect(origin: point, size: size)
    }
}

// MARK: - App resolution

public enum AppResolver {
    static let aliases: [String: String] = [
        "whatsapp": "whatsapp", "notes": "notes", "calendar": "calendar",
        "reminders": "reminders", "messages": "messages", "finder": "finder",
        "notion": "notion", "figma": "figma", "blender": "blender",
        "terminal": "terminal", "safari": "safari", "mail": "mail",
        "music": "music", "photos": "photos", "maps": "maps",
        "freeform": "freeform", "pages": "pages", "numbers": "numbers",
        "keynote": "keynote",         "xcode": "xcode", "discord": "discord",
        "slack": "slack", "zoom": "zoom", "spotify": "spotify", "vscode": "visual studio code",
        "vs code": "visual studio code", "freecad": "freecad", "cad": "freecad",
        "word": "microsoft word", "excel": "microsoft excel", "powerpoint": "microsoft powerpoint",
        "chrome": "google chrome", "preview": "preview", "calculator": "calculator",
    ]

    static func normalize(_ value: String) -> String {
        visible(value).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    /// Drops invisible direction and zero-width marks some apps put in their names (WhatsApp is "\u{200E}WhatsApp").
    public static func visible(_ value: String) -> String {
        let invisible: Set<Unicode.Scalar> = ["\u{200B}", "\u{200C}", "\u{200D}", "\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}",
                                              "\u{202C}", "\u{202D}", "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}", "\u{FEFF}"]
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: value.unicodeScalars.filter { !invisible.contains($0) })
        return String(scalars).trimmingCharacters(in: .whitespaces)
    }

    static func searchDirectories() -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            URL(fileURLWithPath: "/System/Applications"),
            URL(fileURLWithPath: "/System/Applications/Utilities"),
            URL(fileURLWithPath: "/Applications"),
            URL(fileURLWithPath: "\(home)/Applications"),
            URL(fileURLWithPath: "/System/Library/CoreServices"),
        ].filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// App bundles in the usual folders, one level of subfolders included (Utilities, Setapp, JetBrains…).
    static func candidateApps() -> [URL] {
        var apps: [URL] = []
        for directory in searchDirectories() {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { continue }
            for entry in entries {
                if entry.pathExtension == "app" {
                    apps.append(entry)
                } else if (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true,
                          let nested = try? FileManager.default.contentsOfDirectory(
                            at: entry, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                    apps.append(contentsOf: nested.filter { $0.pathExtension == "app" })
                }
            }
        }
        return apps
    }

    static func score(candidate: String, needle: String) -> Int {
        if candidate == needle { return 100 }
        if candidate.hasPrefix(needle) { return 60 }
        if candidate.contains(needle) { return 40 }
        if needle.contains(candidate), candidate.count > 3 { return 25 }
        return 0
    }

    /// Best application bundle URL for a fuzzy name, or nil. Falls back to Spotlight for apps
    /// installed somewhere unusual, and to a bundle identifier when that's what was given.
    public static func resolve(name: String) -> (url: URL, bundleID: String)? {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ".app", with: "")
        let needle = normalize(AppResolver.aliases[normalize(cleaned)] ?? cleaned)
        guard !needle.isEmpty else { return nil }
        var best: (url: URL, bundleID: String, score: Int)?
        for entry in candidateApps() {
            let displayName = displayName(of: entry)
            var points = score(candidate: normalize(displayName), needle: needle)
            let fileName = normalize(entry.deletingPathExtension().lastPathComponent)
            if fileName != normalize(displayName) { points = max(points, score(candidate: fileName, needle: needle)) }
            guard points > 0 else { continue }
            if points > (best?.score ?? 0) {
                best = (entry, bundleID(of: entry) ?? "", points)
            }
        }
        if let best, best.score >= 60 { return (best.url, best.bundleID) }
        if cleaned.contains("."), cleaned.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+$"#, options: [.regularExpression, .caseInsensitive]) != nil,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: cleaned) {
            return (url, cleaned)
        }
        if let spotlight = spotlightApp(named: cleaned) {
            return (spotlight, bundleID(of: spotlight) ?? "")
        }
        guard let best else { return nil }
        return (best.url, best.bundleID)
    }

    /// Spotlight lookup for an app bundle by display name. Bounded to a couple of seconds.
    static func spotlightApp(named name: String) -> URL? {
        let escaped = name.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "'", with: "")
        guard !escaped.isEmpty else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '\(escaped)*'cd"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(2.5)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.03) }
        if process.isRunning { process.terminate(); return nil }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let paths = output.split(separator: "\n").map(String.init)
            .filter { $0.hasSuffix(".app") && !$0.contains("/Library/Developer/") && !$0.contains("/.Trash/") && !$0.contains("/Backups.backupdb/") }
        // Prefer the top-level Applications folders over copies buried elsewhere.
        let ranked = paths.sorted { a, b in
            func rank(_ path: String) -> Int {
                if path.hasPrefix("/Applications/") || path.hasPrefix("/System/Applications/") { return 0 }
                if path.hasPrefix(NSHomeDirectory() + "/Applications/") { return 1 }
                return 2
            }
            return (rank(a), a.count) < (rank(b), b.count)
        }
        return ranked.first.map { URL(fileURLWithPath: $0) }
    }

    static func displayName(of url: URL) -> String {
        if let bundle = Bundle(url: url),
           let name = bundle.infoDictionary?["CFBundleDisplayName"] as? String
            ?? (bundle.infoDictionary?["CFBundleName"] as? String), !name.isEmpty {
            return name
        }
        return url.deletingPathExtension().lastPathComponent
    }

    static func bundleID(of url: URL) -> String? {
        Bundle(url: url)?.bundleIdentifier
    }
}

// MARK: - Scripts

public enum ScriptActuator {
    /// The script running right now, so Stop/Esc can end it instead of letting it drive on for up to 30 s.
    nonisolated(unsafe) private static var running: Process?
    private static let runningLock = NSLock()

    public static func cancelRunning() {
        runningLock.lock(); defer { runningLock.unlock() }
        if let process = running, process.isRunning { process.terminate() }
    }

    /// Catastrophic commands only. Ordinary file and app work is allowed; the user already approved the run.
    public static func isBlocked(_ source: String) -> Bool {
        let c = source.lowercased()
        let needles = [
            "sudo ", "mkfs", "diskutil erase", "diskutil erasedisk", "diskutil reformat",
            "shutdown -", "halt", "reboot", "> /dev/disk", ":(){", "chmod -r 777 /",
            "dd if=/dev/zero", "dd if=/dev/random", "killall", "pkill", "kill -9",
            "launchctl unload", "csrutil", "nvram ", "tccutil reset", "security delete",
        ]
        if needles.contains(where: { c.contains($0) }) { return true }
        // rm of the whole disk, home, or a system root. A project folder is allowed.
        let roots = "(/|/\\*|~|~/|~/\\*|\\$home|/users|/users/\\*|/system|/library|/applications|/private|/usr|/etc|/var|/bin|/sbin|/volumes|/volumes/\\*)"
        let pattern = "\\brm\\s+(-[a-z]*\\s+)*(-[a-z]*r[a-z]*\\s+)(-[a-z]*\\s+)*\(roots)(\\s|$|;|&|\\|)"
        if let regex = try? NSRegularExpression(pattern: pattern),
           regex.firstMatch(in: c, range: NSRange(c.startIndex..., in: c)) != nil {
            return true
        }
        return false
    }

    public static func normalizeLanguage(_ raw: String?) -> String {
        switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "shell", "zsh", "bash", "sh": return "shell"
        case "javascript", "jxa", "js": return "javascript"
        default: return "applescript"
        }
    }

    /// Apps a script sends Apple events to: `tell application "X"`, `application id "…"`, JXA `Application("X")`.
    public static func targets(of source: String) -> [String] {
        let patterns = [
            #"(?i)\b(?:tell\s+)?(?:application|app)\s+id\s+"([^"]+)""#,
            #"(?i)\btell\s+(?:application|app)\s+"([^"]+)""#,
            #"(?i)\bapplication\s+"([^"]+)""#,
            #"\bApplication\(\s*["']([^"']+)["']\s*\)"#,
        ]
        var found: [String] = []
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(source.startIndex..., in: source)
            for match in regex.matches(in: source, range: range) {
                guard let r = Range(match.range(at: 1), in: source) else { continue }
                let name = String(source[r]).trimmingCharacters(in: .whitespaces)
                if !name.isEmpty, !found.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { found.append(name) }
            }
        }
        return found
    }

    public enum Consent: Equatable, Sendable { case granted, denied, notDetermined, unknown }

    /// Whether okidoki may send Apple events to the app, asked without showing a prompt.
    /// Unknown when the app isn't running (macOS can only answer for running apps).
    public static func consent(bundleID: String) -> Consent {
        var address = AEAddressDesc()
        let bytes = Array(bundleID.utf8)
        let created = bytes.withUnsafeBytes { AECreateDesc(typeApplicationBundleID, $0.baseAddress, bytes.count, &address) }
        guard created == noErr else { return .unknown }
        defer { AEDisposeDesc(&address) }
        switch AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, false) {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
        default: return .unknown
        }
    }

    /// The bundle identifier for a scripted app name.
    public static func bundleID(forScriptTarget name: String) -> String? {
        if name.contains("."), !name.contains(" ") { return name }
        switch name.lowercased() {
        case "system events": return "com.apple.systemevents"
        case "finder": return "com.apple.finder"
        default: break
        }
        if let running = NSWorkspace.shared.runningApplications.first(where: {
            AppResolver.normalize($0.localizedName ?? "") == AppResolver.normalize(name)
        }), let id = running.bundleIdentifier { return id }
        return AppResolver.resolve(name: name)?.bundleID
    }

    public static func run(language: String, source: String, timeout: Double = 30) async -> String {
        let language = normalizeLanguage(language)
        let source = source
        let timeout = timeout
        return await Task.detached(priority: .userInitiated) {
            execute(language: language, source: source, timeout: timeout)
        }.value
    }

    private static func execute(language: String, source: String, timeout: Double) -> String {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "empty script" }
        guard trimmed.count <= 20_000 else { return "script is too long" }
        guard !isBlocked(trimmed) else { return "blocked — that script can destroy files or kill processes" }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-script-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            return "couldn't start the script"
        }
        defer { try? FileManager.default.removeItem(at: directory) }

        let process = Process()
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let prefix = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.bun/bin",
                      "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        env["PATH"] = prefix + ":" + (env["PATH"] ?? "")
        env["TERM"] = "dumb"
        process.environment = env
        process.standardInput = FileHandle.nullDevice

        let stdoutURL = directory.appendingPathComponent("out.txt")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        guard let stdout = try? FileHandle(forWritingTo: stdoutURL) else { return "couldn't start the script" }
        process.standardOutput = stdout
        process.standardError = stdout

        switch language {
        case "shell":
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-c", trimmed]
        case "javascript":
            let file = directory.appendingPathComponent("script.js")
            do { try trimmed.write(to: file, atomically: true, encoding: .utf8) } catch { return "couldn't write the script" }
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-l", "JavaScript", file.path]
        default:
            let file = directory.appendingPathComponent("script.applescript")
            do { try trimmed.write(to: file, atomically: true, encoding: .utf8) } catch { return "couldn't write the script" }
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = [file.path]
        }

        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        do { try process.run() } catch {
            try? stdout.close()
            return "couldn't start the script"
        }
        runningLock.lock(); running = process; runningLock.unlock()
        defer {
            runningLock.lock()
            if running === process { running = nil }
            runningLock.unlock()
        }
        // Wakes the moment the script ends instead of polling.
        _ = finished.wait(timeout: .now() + timeout)
        if process.isRunning {
            process.terminate()
            try? stdout.close()
            return "script timed out after \(Int(timeout))s — if a dialog or permission prompt is showing, the user has to answer it; otherwise try a smaller step or drive the app directly"
        }
        try? stdout.close()
        var output = (try? String(contentsOf: stdoutURL, encoding: .utf8)) ?? ""
        // osascript prefixes errors with the temp file's path; the line:column is all that helps.
        output = output.replacingOccurrences(of: "(/private)?" + NSRegularExpression.escapedPattern(for: directory.path) + "/script\\.[a-z]+:",
                                             with: "line ", options: .regularExpression)
        let clipped = output.count > 4000 ? String(output.prefix(4000)) + "…" : output
        let text = clipped.trimmingCharacters(in: .whitespacesAndNewlines)
        if process.terminationStatus != 0 {
            if let hint = explain(text) { return "script failed: \(hint) (\(text))" }
            return text.isEmpty ? "script failed (\(process.terminationStatus))" : "script failed: \(text)"
        }
        return text.isEmpty ? "script ok" : text
    }

    /// True when osascript was refused permission to send Apple events to an app.
    public static func isAutomationDenied(_ output: String) -> Bool {
        let lower = output.lowercased()
        return lower.contains("-1743") || lower.contains("not authorized to send apple events")
    }

    /// Turns the usual osascript failures into something the model can act on.
    public static func explain(_ output: String) -> String? {
        let lower = output.lowercased()
        if lower.contains("-1743") || lower.contains("not authorized to send apple events") || lower.contains("not allowed assistive") {
            return "okidoki isn't allowed to control that app yet — the user has to approve it in system settings › privacy & security › automation. use open_app, key, and click instead for now"
        }
        if lower.contains("-1728") {
            return "that object doesn't exist in the app — check the name or index, or look at the screen"
        }
        if lower.contains("-1708") {
            return "the app doesn't understand that command — it may not support scripting; use open_app, key, and click instead"
        }
        if lower.contains("-600") || lower.contains("-10810") {
            return "the app isn't running or couldn't be launched — try open_app first"
        }
        if lower.contains("-1712") {
            return "the app didn't respond in time — it may be showing a dialog; look at the screen"
        }
        if lower.contains("-2741") || lower.contains("syntax error") || lower.contains("-2753") {
            return "syntax error in the script"
        }
        if lower.contains("user canceled") || lower.contains("(-128)") {
            return "the user cancelled a dialog"
        }
        if lower.contains("command not found") {
            return "that command isn't installed"
        }
        return nil
    }
}

// MARK: - Service

@MainActor
public final class ComputerUseService {
    public static let shared = ComputerUseService()
    private init() {}

    // MARK: Screen

    public static func cgGlobalRect(for screen: NSScreen) -> CGRect {
        let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        return CGRect(x: screen.frame.minX,
                      y: mainHeight - screen.frame.maxY,
                      width: screen.frame.width,
                      height: screen.frame.height)
    }

    /// The model's coordinates are only exact when it sees the image at the size we think it does.
    /// The API shrinks anything over 1568 px on the long edge or about 1.15 megapixels, so we shrink first.
    public nonisolated static let maxImageLongEdge: Double = 1568
    public nonisolated static let maxImagePixels: Double = 1_150_000

    /// Size the screenshot should be sent at: never larger than the display in points
    /// (1 image pixel = 1 point on Retina), and inside the API's limits.
    public nonisolated static func sendSize(pixelWidth: Double, pixelHeight: Double, pointWidth: Double) -> (width: Int, height: Int) {
        guard pixelWidth > 0, pixelHeight > 0 else { return (0, 0) }
        var scale = min(1, pointWidth / pixelWidth)
        let longEdge = max(pixelWidth, pixelHeight) * scale
        if longEdge > maxImageLongEdge { scale *= maxImageLongEdge / longEdge }
        let pixels = pixelWidth * pixelHeight * scale * scale
        if pixels > maxImagePixels { scale *= (maxImagePixels / pixels).squareRoot() }
        return (max(1, Int((pixelWidth * scale).rounded())), max(1, Int((pixelHeight * scale).rounded())))
    }

    /// One display, as sent to the model plus the full-resolution original for zooming.
    public struct Screenshot: @unchecked Sendable {
        /// The encoded image: PNG, or JPEG when `mediaType` says so.
        public var png: Data
        public var box: ScreenBox
        public var imageWidth: Double
        public var imageHeight: Double
        public var full: CGImage
        public var mediaType: String

        public init(png: Data, box: ScreenBox, imageWidth: Double, imageHeight: Double, full: CGImage, mediaType: String = "image/png") {
            self.png = png; self.box = box; self.imageWidth = imageWidth; self.imageHeight = imageHeight; self.full = full
            self.mediaType = mediaType
        }
    }

    /// The largest image the driving model reads without shrinking it.
    public struct ImageLimits: Sendable, Equatable {
        public var longEdge: Double
        /// Newer models count ⌈w/28⌉·⌈h/28⌉ visual tokens.
        public var visualTokens: Int?
        /// Older models cap the pixel count.
        public var pixels: Double?

        public static let highResolution = ImageLimits(longEdge: 2576, visualTokens: 4784, pixels: nil)
        public static let standard = ImageLimits(longEdge: 1568, visualTokens: nil, pixels: 1_150_000)

        public static func forModel(_ model: String) -> ImageLimits {
            let name = model.lowercased()
            let newer = ["claude-haiku-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-7", "claude-opus-4-8",
                         "claude-fable", "claude-mythos"]
            return newer.contains { name.hasPrefix($0) } ? .highResolution : .standard
        }
    }

    /// Size to send: never larger than the display in points (1 image pixel = 1 point), and inside the model's limits.
    public nonisolated static func sendSize(pixelWidth: Double, pixelHeight: Double, pointWidth: Double, pointHeight: Double,
                                            limits: ImageLimits) -> (width: Int, height: Int) {
        guard pixelWidth > 0, pixelHeight > 0 else { return (0, 0) }
        var scale = min(1, pointWidth / pixelWidth)
        let longEdge = max(pixelWidth, pixelHeight) * scale
        if longEdge > limits.longEdge { scale *= limits.longEdge / longEdge }
        if let pixels = limits.pixels {
            let count = pixelWidth * pixelHeight * scale * scale
            if count > pixels { scale *= (pixels / count).squareRoot() }
        }
        func size(_ s: Double) -> (Int, Int) {
            (max(1, Int((pixelWidth * s).rounded(.down))), max(1, Int((pixelHeight * s).rounded(.down))))
        }
        if let budget = limits.visualTokens {
            for _ in 0..<12 {
                let (w, h) = size(scale)
                let tokens = Int((Double(w) / 28).rounded(.up)) * Int((Double(h) / 28).rounded(.up))
                if tokens <= budget { break }
                scale *= (Double(budget) / Double(tokens)).squareRoot() * 0.995
            }
        }
        let (w, h) = size(scale)
        return (w, h)
    }

    /// The driving loop's capture: the cached display filter, sized for the model, PNG or JPEG.
    /// Teach and the other features keep using `capture(screen:)`.
    public func captureForDriving(screen: NSScreen, limits: ImageLimits, jpeg: Bool) async -> Screenshot? {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            return nil
        }
        for attempt in 0..<2 {
            guard let entry = await DisplayFilterCache.shared.filter(for: screen) else { break }
            let scale = max(screen.backingScaleFactor, 1)
            let pointW = entry.display.frame.width > 0 ? entry.display.frame.width : CGFloat(entry.display.width)
            let pointH = entry.display.frame.height > 0 ? entry.display.frame.height : CGFloat(entry.display.height)
            let config = SCStreamConfiguration()
            config.width = Int((pointW * scale).rounded())
            config.height = Int((pointH * scale).rounded())
            config.showsCursor = false
            config.scalesToFit = false
            config.captureResolution = .best
            guard let image = try? await SCScreenshotManager.captureImage(contentFilter: entry.filter, configuration: config),
                  image.width > 0, image.height > 0 else {
                DisplayFilterCache.shared.invalidate()
                if attempt == 0 { continue }
                break
            }
            let bounds = entry.display.frame
            let box = ScreenBox(x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height)
            let encoded = await Task.detached(priority: .userInitiated) { () -> (Data, Double, Double)? in
                let size = Self.sendSize(pixelWidth: Double(image.width), pixelHeight: Double(image.height),
                                         pointWidth: Double(pointW), pointHeight: Double(pointH), limits: limits)
                guard let scaled = Self.resized(image, to: size) else { return nil }
                let data = jpeg ? Self.jpegData(scaled, quality: 0.85) : Self.pngData(scaled)
                return data.map { ($0, Double(scaled.width), Double(scaled.height)) }
            }.value
            guard let encoded else { return nil }
            return Screenshot(png: encoded.0, box: box, imageWidth: encoded.1, imageHeight: encoded.2, full: image,
                              mediaType: jpeg ? "image/jpeg" : "image/png")
        }
        return await capture(screen: screen)
    }

    /// A magnified crop of a screenshot. `rect` is the region in screenshot pixels.
    public struct Zoom: Sendable {
        public var png: Data
        public var rect: CGRect
        public var width: Double
        public var height: Double
    }

    /// Screenshot of one display. The box is Quartz global points: origin at the top-left
    /// of the main display, y downward — the same space `CGEvent` mouse positions use.
    /// The image is downscaled for the model; `imageWidth`/`imageHeight` describe the sent image.
    public func capture(screen: NSScreen) async -> Screenshot? {
        if let shot = await captureDisplay(screen) { return shot }
        let rect = Self.cgGlobalRect(for: screen)
        return await Task.detached(priority: .userInitiated) {
            Self.captureCLI(rect: rect)
        }.value
    }

    /// Crops `rect` (screenshot pixels) out of the full-resolution capture, so small text and
    /// tight controls are legible. Sent no larger than 1200 px on the long edge.
    public nonisolated static func zoom(_ shot: Screenshot, x: Double, y: Double, width: Double?, height: Double?) -> Zoom? {
        guard shot.imageWidth > 0, shot.imageHeight > 0 else { return nil }
        let w = min(max(width ?? 400, 60), shot.imageWidth)
        let h = min(max(height ?? w * 0.66, 40), shot.imageHeight)
        // x,y is the center unless that would push the box off the image.
        var originX = x - w / 2
        var originY = y - h / 2
        originX = min(max(originX, 0), shot.imageWidth - w)
        originY = min(max(originY, 0), shot.imageHeight - h)
        let region = CGRect(x: originX.rounded(), y: originY.rounded(), width: w.rounded(), height: h.rounded())
        let scaleX = Double(shot.full.width) / shot.imageWidth
        let scaleY = Double(shot.full.height) / shot.imageHeight
        let pixelRect = CGRect(x: region.minX * scaleX, y: region.minY * scaleY,
                               width: region.width * scaleX, height: region.height * scaleY).integral
        guard let crop = shot.full.cropping(to: pixelRect) else { return nil }
        let longEdge = Double(max(crop.width, crop.height))
        let factor = min(1, 1200 / longEdge)
        let size = (width: max(1, Int(Double(crop.width) * factor)), height: max(1, Int(Double(crop.height) * factor)))
        guard let scaled = resized(crop, to: size), let png = pngData(scaled) else { return nil }
        return Zoom(png: png, rect: region, width: Double(scaled.width), height: Double(scaled.height))
    }

    nonisolated static func resized(_ image: CGImage, to size: (width: Int, height: Int)) -> CGImage? {
        guard size.width > 0, size.height > 0 else { return nil }
        if image.width == size.width && image.height == size.height { return image }
        let space = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: size.width, height: size.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        return context.makeImage()
    }

    public nonisolated static func encodeForModel(_ image: CGImage, pointWidth: Double) -> (png: Data, width: Double, height: Double)? {
        let size = sendSize(pixelWidth: Double(image.width), pixelHeight: Double(image.height),
                            pointWidth: pointWidth)
        guard let scaled = resized(image, to: size), let png = pngData(scaled) else { return nil }
        return (png, Double(scaled.width), Double(scaled.height))
    }

    /// A full-resolution capture of one display with no downscaling or encoding, for local image
    /// work (a replay finding a control by its picture). Nil without Screen Recording.
    public func captureRaw(screen: NSScreen) async -> (image: CGImage, box: ScreenBox)? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        if let raw = await captureDisplayImage(screen) { return (raw.image, raw.box) }
        let rect = Self.cgGlobalRect(for: screen)
        return await Task.detached(priority: .userInitiated) {
            Self.captureCLI(rect: rect).map { ($0.full, $0.box) }
        }.value
    }

    private func captureDisplay(_ screen: NSScreen) async -> Screenshot? {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            return nil
        }
        guard let raw = await captureDisplayImage(screen) else { return nil }
        let encoded = await Task.detached(priority: .userInitiated) {
            Self.encodeForModel(raw.image, pointWidth: raw.pointWidth)
        }.value
        guard let encoded else { return nil }
        return Screenshot(png: encoded.png, box: raw.box, imageWidth: encoded.width, imageHeight: encoded.height, full: raw.image)
    }

    private func captureDisplayImage(_ screen: NSScreen) async -> (image: CGImage, box: ScreenBox, pointWidth: CGFloat)? {
        let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
            ?? CGMainDisplayID()
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return nil }
            let ownBundle = Bundle.main.bundleIdentifier
            let own = content.applications.filter { $0.bundleIdentifier == ownBundle }
            let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
            let scale = max(screen.backingScaleFactor, 1)
            // SCDisplay.width is in points. The stream wants pixels, or the model gets a blurry 1x image.
            let pointW = display.frame.width > 0 ? display.frame.width : CGFloat(display.width)
            let pointH = display.frame.height > 0 ? display.frame.height : CGFloat(display.height)
            let pixelW = Int((pointW * scale).rounded())
            let pixelH = Int((pointH * scale).rounded())
            guard pixelW > 0, pixelH > 0 else { return nil }
            let config = SCStreamConfiguration()
            config.width = pixelW
            config.height = pixelH
            config.showsCursor = false
            config.scalesToFit = false
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            guard image.width > 0, image.height > 0 else { return nil }
            let bounds = display.frame
            let box = ScreenBox(x: bounds.origin.x, y: bounds.origin.y,
                                width: bounds.size.width, height: bounds.size.height)
            return (image, box, pointW)
        } catch {
            return nil
        }
    }

    nonisolated private static func pngData(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }

    /// JPEG through ImageIO, optionally shrunk so the long edge is at most `maxLongEdge` pixels.
    public nonisolated static func jpegData(_ image: CGImage, maxLongEdge: Double? = nil, quality: Double = 0.85) -> Data? {
        var source = image
        if let maxLongEdge {
            let longEdge = Double(max(image.width, image.height))
            if longEdge > maxLongEdge {
                let factor = maxLongEdge / longEdge
                source = resized(image, to: (max(1, Int(Double(image.width) * factor)), max(1, Int(Double(image.height) * factor)))) ?? image
            }
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, source, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    nonisolated private static func captureCLI(rect: CGRect) -> Screenshot? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-cu-\(UUID().uuidString).png")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-R", "\(Int(rect.minX)),\(Int(rect.minY)),\(Int(rect.width)),\(Int(rect.height))", temp.path]
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  let data = try? Data(contentsOf: temp) else { return nil }
            try? FileManager.default.removeItem(at: temp)
            guard let rep = NSBitmapImageRep(data: data),
                  rep.pixelsWide > 0, rep.pixelsHigh > 0, let image = rep.cgImage,
                  let encoded = encodeForModel(image, pointWidth: rect.width) else { return nil }
            return Screenshot(png: encoded.png, box: ScreenBox(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
                              imageWidth: encoded.width, imageHeight: encoded.height, full: image)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return nil
        }
    }

    /// The display to look at and act on: where the frontmost app's window is, else where the pointer is.
    public func screenForAction() -> NSScreen {
        if NSScreen.screens.count > 1, let front = frontmost(),
           front.pid != ProcessInfo.processInfo.processIdentifier,
           let frame = AXSearch.focusedWindowFrame(pid: front.pid) {
            let center = CGPoint(x: frame.midX, y: frame.midY)
            if let screen = NSScreen.screens.first(where: { Self.cgGlobalRect(for: $0).contains(center) }) {
                return screen
            }
        }
        return NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
            ?? NSScreen.main ?? NSScreen.screens.first ?? NSScreen()
    }

    // MARK: Apps

    public struct AppInfo: Sendable {
        public var name: String
        public var bundleID: String
        public var pid: pid_t
        public var isActive: Bool
    }

    public func runningApps() -> [AppInfo] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && !$0.isTerminated }
            .map { AppInfo(name: AppResolver.visible($0.localizedName ?? ""), bundleID: $0.bundleIdentifier ?? "",
                           pid: $0.processIdentifier, isActive: $0.isActive) }
    }

    public func frontmost() -> AppInfo? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return AppInfo(name: AppResolver.visible(app.localizedName ?? ""), bundleID: app.bundleIdentifier ?? "",
                       pid: app.processIdentifier, isActive: true)
    }

    /// True when the app has a normal, on-screen window (not minimized, not hidden).
    public nonisolated static func hasVisibleWindow(pid: pid_t) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return true
        }
        return list.contains { info in
            guard (info[kCGWindowOwnerPID as String] as? Int32) == pid,
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: Double] else { return false }
            return (bounds["Width"] ?? 0) > 80 && (bounds["Height"] ?? 0) > 60
        }
    }

    /// Brings a running app forward and makes sure a window shows: an app with every window closed
    /// or minimized gets a reopen (what clicking its Dock icon does).
    private func surface(_ running: NSRunningApplication, timeout: Double) async {
        let pid = running.processIdentifier
        running.unhide()
        running.activate()
        await waitForFrontmost(bundleID: running.bundleIdentifier, name: running.localizedName, timeout: min(timeout, 0.8))
        if frontmost()?.pid != pid {
            // macOS can refuse activation asked for by a background app; accessibility can still raise it.
            await Task.detached(priority: .userInitiated) { AXSearch.raise(pid: pid) }.value
            await waitForFrontmost(bundleID: running.bundleIdentifier, name: running.localizedName, timeout: 0.8)
        }
        if frontmost()?.pid == pid, Self.hasVisibleWindow(pid: pid) { return }
        // Every window closed or minimized, or still behind: reopen it the way the Dock icon does.
        if let url = running.bundleURL {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: config)
        }
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline, frontmost()?.pid != pid || !Self.hasVisibleWindow(pid: pid) {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    private func runningMatch(named name: String) -> AppInfo? {
        let needle = AppResolver.normalize(AppResolver.aliases[AppResolver.normalize(name)] ?? name)
        guard !needle.isEmpty else { return nil }
        let apps = runningApps()
        if let exact = apps.first(where: { AppResolver.normalize($0.name) == needle }) { return exact }
        return apps.first { app in
            let normalized = AppResolver.normalize(app.name)
            return normalized.hasPrefix(needle) || normalized.contains(needle)
                || AppResolver.normalize(app.bundleID).contains(needle)
        }
    }

    @discardableResult
    public func openApp(named name: String) async throws -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let running = runningMatch(named: cleaned) {
            return await bringForward(running, label: running.name.isEmpty ? cleaned : running.name, timeout: 4)
        }
        let resolved = await Task.detached(priority: .userInitiated) { AppResolver.resolve(name: cleaned) }.value
        if let resolved {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            let display = AppResolver.displayName(of: resolved.url)
            do {
                try await NSWorkspace.shared.openApplication(at: resolved.url, configuration: config)
            } catch {
                throw ComputerUseError.appNotFound(cleaned)
            }
            let bundle = resolved.bundleID.isEmpty ? nil : resolved.bundleID
            await waitForFrontmost(bundleID: bundle, name: display, timeout: 8)
            if let bundle, frontmost()?.bundleID != bundle,
               let launched = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundle }) {
                await surface(launched, timeout: 1)
            }
            return "opened \(display)"
        }
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        open.arguments = ["-a", cleaned]
        open.standardOutput = FileHandle.nullDevice
        open.standardError = FileHandle.nullDevice
        do { try open.run(); open.waitUntilExit() } catch { throw ComputerUseError.appNotFound(cleaned) }
        guard open.terminationStatus == 0 else { throw ComputerUseError.appNotFound(cleaned) }
        await waitForFrontmost(name: cleaned, timeout: 8)
        return "opened \(cleaned)"
    }

    @discardableResult
    public func activateApp(named name: String) async -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let running = runningMatch(named: cleaned) {
            return await bringForward(running, label: running.name.isEmpty ? cleaned : running.name, timeout: 3)
        }
        let resolved = await Task.detached(priority: .userInitiated) { AppResolver.resolve(name: cleaned) }.value
        if let resolved {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            let display = AppResolver.displayName(of: resolved.url)
            _ = try? await NSWorkspace.shared.openApplication(at: resolved.url, configuration: config)
            let bundle = resolved.bundleID.isEmpty ? nil : resolved.bundleID
            await waitForFrontmost(bundleID: bundle, name: display, timeout: 6)
            if let bundle, frontmost()?.bundleID != bundle,
               let launched = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundle }) {
                await surface(launched, timeout: 1)
            }
            return "opened \(display)"
        }
        return "couldn't find \(cleaned)"
    }

    /// Front and showing a window, or a result that says what is still missing.
    private func bringForward(_ running: AppInfo, label: String, timeout: Double) async -> String {
        let alreadyFront = frontmost()?.pid == running.pid
        if alreadyFront, Self.hasVisibleWindow(pid: running.pid) {
            let title = AXSearch.focusedWindowTitle(pid: running.pid)
            return "\(label) is already frontmost\(title.isEmpty ? "" : " (window “\(title.prefix(60))”)") — go straight to the next step"
        }
        guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == running.pid }) else {
            return "couldn't find \(label) running"
        }
        await surface(app, timeout: timeout)
        let front = frontmost()?.pid == running.pid
        let window = Self.hasVisibleWindow(pid: running.pid)
        if front && window { return "focused \(label) — it's frontmost with a window open, go straight to the next step" }
        if front { return "\(label) is frontmost but has no window open — use its File menu or a shortcut like cmd+n to open one" }
        return "couldn't bring \(label) to the front — try clicking its window or its Dock icon"
    }

    private func waitForFrontmost(bundleID: String? = nil, name: String? = nil, timeout: Double) async {
        let bundle = (bundleID?.isEmpty == false) ? bundleID : nil
        let wanted = (name?.isEmpty == false) ? name : nil
        guard bundle != nil || wanted != nil else { return }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let front = NSWorkspace.shared.frontmostApplication {
                if let bundle, front.bundleIdentifier == bundle { return }
                if let wanted,
                   AppResolver.normalize(front.localizedName ?? "") == AppResolver.normalize(wanted) { return }
            }
            try? await Task.sleep(nanoseconds: 180_000_000)
        }
    }

    // MARK: What the model gets to know

    /// Abridged AppleScript dictionary of the frontmost app, or empty when it isn't scriptable.
    public func scriptingHints() async -> String {
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let url = front.bundleURL else { return "" }
        return await ScriptHints.summary(appURL: url)
    }

    /// Title of the frontmost window, or empty.
    public func frontWindowTitle() async -> String {
        guard let pid = frontmost()?.pid else { return "" }
        return await Task.detached(priority: .userInitiated) {
            AXSearch.focusedWindowTitle(pid: pid)
        }.value
    }

    /// Clickable controls of the frontmost app as the brain expects them: role, label, and the
    /// center in screenshot pixels. Runs off the main thread with a time budget.
    public func visibleControls(box: ScreenBox, imageWidth: Double, imageHeight: Double,
                                limit: Int = 150) async -> [[String: Any]] {
        await visibleSnapshot(box: box, imageWidth: imageWidth, imageHeight: imageHeight, limit: limit).controls
    }

    /// Numbered controls for the model (ids from 1) and the elements behind them, for `click_element`.
    public func visibleSnapshot(box: ScreenBox, imageWidth: Double, imageHeight: Double, limit: Int = 150,
                                budget: TimeInterval = 1.2) async -> (controls: [[String: Any]], elements: [Int: AXSearch.Entry]) {
        guard let pid = frontmost()?.pid, imageWidth > 0, imageHeight > 0, box.width > 0, box.height > 0 else { return ([], [:]) }
        let found = await Task.detached(priority: .userInitiated) {
            AXSearch.snapshot(pid: pid, visible: box.cgRect, limit: limit, budget: budget)
        }.value
        var controls: [[String: Any]] = []
        var elements: [Int: AXSearch.Entry] = [:]
        for (index, entry) in found.enumerated() {
            let id = index + 1
            let control = entry.control
            let point = Self.mapPoint(CGPoint(x: control.rect.midX, y: control.rect.midY), box: box,
                                      imageWidth: imageWidth, imageHeight: imageHeight)
            controls.append(["id": id, "role": control.role, "label": String(control.label.prefix(60)),
                             "x": Int(point.x.rounded()), "y": Int(point.y.rounded()),
                             "w": Int((control.width / box.width * imageWidth).rounded()),
                             "h": Int((control.height / box.height * imageHeight).rounded())])
            elements[id] = entry
        }
        return (controls, elements)
    }

    // MARK: Coordinate mapping

    /// Image pixels (origin top-left of the screenshot) → Quartz global points.
    /// `CGEvent` mouse positions use this same space, so the result is posted as-is.
    public static func mapImage(x: Double, y: Double, box: ScreenBox,
                                imageWidth: Double, imageHeight: Double) -> CGPoint? {
        guard imageWidth > 0, imageHeight > 0, x >= 0, y >= 0 else { return nil }
        let point = CGPoint(x: box.x + (x / imageWidth) * box.width,
                            y: box.y + (y / imageHeight) * box.height)
        guard point.x >= box.x - 40, point.x <= box.x + box.width + 40,
              point.y >= box.y - 40, point.y <= box.y + box.height + 40 else { return nil }
        return point
    }

    /// Quartz global points → image pixels. The inverse of `mapImage`.
    public static func mapPoint(_ point: CGPoint, box: ScreenBox, imageWidth: Double, imageHeight: Double) -> CGPoint {
        guard box.width > 0, box.height > 0 else { return .zero }
        return CGPoint(x: (point.x - box.x) / box.width * imageWidth,
                       y: (point.y - box.y) / box.height * imageHeight)
    }

    // MARK: Perform

    public func perform(_ action: ComputerAction, screen box: ScreenBox,
                        imageWidth: Double, imageHeight: Double) async throws -> String {
        switch action.type {
        case "open_app":
            let name = action.app ?? action.text ?? ""
            guard !name.isEmpty else { return "no app name" }
            do { return try await openApp(named: name) }
            catch { return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
        case "activate":
            return await activateApp(named: action.app ?? action.text ?? "")
        case "open_url":
            return openURL(action.text ?? action.app ?? "")
        case "script", "shell", "applescript", "jxa":
            let language = action.lang ?? (action.type == "shell" ? "shell"
                                            : action.type == "jxa" ? "javascript"
                                            : action.type == "applescript" ? "applescript" : nil)
            let source = action.script ?? action.text ?? ""
            if let blocked = await scriptPermissionProblem(source) { return blocked }
            let result = await ScriptActuator.run(language: language ?? "applescript", source: source)
            // A denied Apple event with no prompt is usually a grant left over from an older build.
            // Clear it once so macOS asks the user again, and let the model retry the same script.
            if ScriptActuator.isAutomationDenied(result), PermissionsService.shared.repairStaleGrant(.automation) {
                return "script failed: okidoki's permission to control apps was stale and has been reset — "
                    + "run the exact same script once more; macOS will now ask the user to allow it"
            }
            return result
        case "click", "double_click", "triple_click", "right_click", "middle_click", "move", "drag", "type", "key", "scroll":
            // Without accessibility the event can't be posted. Tell the model rather than ending the
            // run: scripts, open_app, and open_url still work, and the user may be granting it right now.
            guard EventActuator.canPost else {
                return "couldn't \(action.type.replacingOccurrences(of: "_", with: " ")) — accessibility is off, so clicks and keys can't be delivered. "
                    + "use script, open_app, or open_url for this instead, or fail and tell the user to grant accessibility in system settings › privacy & security › accessibility"
            }
            await focusIfAsked(action)
            return await performPointer(action, box: box, imageWidth: imageWidth, imageHeight: imageHeight)
        case "wait":
            let seconds = min(max(action.seconds ?? 1, 0.2), 10)
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return action.reason.map { "waited — \($0)" } ?? "waited \(String(format: "%.1f", seconds))s"
        case "zoom":
            // The driver crops the screenshot; here we only validate.
            guard action.x != nil, action.y != nil else { return "zoom needs x and y" }
            return "zoomed"
        default:
            return "unknown action \(action.type)"
        }
    }

    /// Called with an app's name just before a script makes macOS ask the user whether okidoki may control it.
    public var onPermissionPrompt: ((String) -> Void)?

    /// Scripted testing runs unattended: a permission prompt nobody answers stalls the run, so scripts
    /// to apps okidoki may not control yet are refused with guidance instead.
    public static var avoidsPermissionPrompts: Bool { UserDefaults.standard.bool(forKey: "drivingAvoidPrompts") }

    /// Why a script shouldn't run (okidoki isn't allowed to control an app it talks to), or nil.
    func scriptPermissionProblem(_ source: String) async -> String? {
        let avoid = Self.avoidsPermissionPrompts
        for name in ScriptActuator.targets(of: source) {
            guard let id = await Task.detached(priority: .userInitiated, operation: { ScriptActuator.bundleID(forScriptTarget: name) }).value,
                  id != Bundle.main.bundleIdentifier else { continue }
            var consent = await Task.detached(priority: .userInitiated) { ScriptActuator.consent(bundleID: id) }.value
            if consent == .unknown, avoid, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
                // macOS only answers for running apps: start it in the background and ask again.
                let config = NSWorkspace.OpenConfiguration()
                config.activates = false
                _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: config)
                let deadline = Date().addingTimeInterval(2.5)
                while Date() < deadline, !NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == id }) {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                consent = await Task.detached(priority: .userInitiated) { ScriptActuator.consent(bundleID: id) }.value
            }
            switch consent {
            case .granted, .unknown:
                continue
            case .denied where avoid:
                return "script not run: okidoki isn't allowed to control \(name) (System Settings › Privacy & Security › Automation) — do this with clicks and keys instead"
            case .notDetermined where avoid:
                return "script not run: okidoki hasn't been allowed to control \(name) yet, and asking would put a macOS permission prompt in front of the user — do this with clicks and keys instead"
            case .notDetermined:
                onPermissionPrompt?(name)
            case .denied:
                continue
            }
        }
        return nil
    }

    /// Keys and clicks go to the frontmost app. When the action names another running app, bring it up first.
    private func focusIfAsked(_ action: ComputerAction) async {
        guard ["type", "key"].contains(action.type),
              let name = action.app?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty,
              let wanted = runningMatch(named: name), let front = frontmost(), wanted.pid != front.pid else { return }
        _ = await activateApp(named: name)
        await EventActuator.sleep(150)
    }

    private func openURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              ["http", "https", "file", "mailto"].contains(scheme) else {
            return "need an http, https, or file url"
        }
        NSWorkspace.shared.open(url)
        return "opened \(trimmed)"
    }

    /// Quartz point for a click. An accessibility label that agrees with the image coordinate
    /// wins over the raw pixel; a label alone is used when there is no pixel.
    private func resolvePoint(x: Double?, y: Double?, target: String?, app: String?,
                              box: ScreenBox, imageWidth: Double, imageHeight: Double) async -> (point: CGPoint, how: String)? {
        let mapped = Self.mapImage(x: x ?? -1, y: y ?? -1, box: box, imageWidth: imageWidth, imageHeight: imageHeight)
        let label = target?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var found: AXFound?
        if !label.isEmpty, let pid = runningMatch(named: app ?? "")?.pid ?? frontmost()?.pid {
            found = await Task.detached(priority: .userInitiated) {
                AXSearch.find(target: label, pid: pid, near: mapped)
            }.value
        }
        return Self.choosePoint(mapped: mapped, found: found)
    }

    /// Snap to the control's center when the model's pixel lands on it, or when there is no
    /// pixel and the label is all we have. Otherwise trust the pixel.
    nonisolated static func choosePoint(mapped: CGPoint?, found: AXFound?) -> (point: CGPoint, how: String)? {
        if let found {
            let hit = mapped.map { found.rect.insetBy(dx: -8, dy: -8).contains($0) } ?? true
            if hit { return (CGPoint(x: found.rect.midX, y: found.rect.midY), "on “\(found.label)”") }
        }
        if let mapped { return (mapped, String(format: "at (%.0f, %.0f)", mapped.x, mapped.y)) }
        return nil
    }

    private func pointerMiss(_ action: ComputerAction, verb: String) -> String {
        let label = action.target?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if action.x == nil || action.y == nil {
            return label.isEmpty
                ? "\(verb) needs x and y in screenshot pixels"
                : "couldn't find a control labeled “\(label)” — look at the screenshot and give x and y"
        }
        return "ignored \(verb) outside the screen"
    }

    private func performPointer(_ action: ComputerAction, box: ScreenBox,
                                imageWidth: Double, imageHeight: Double) async -> String {
        switch action.type {
        case "click", "double_click", "triple_click", "right_click", "middle_click":
            let label = action.target?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let mapped = Self.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                       imageWidth: imageWidth, imageHeight: imageHeight)
            guard let held = EventActuator.modifierKeys(action.modifiers) else {
                return "unknown modifiers \(action.modifiers ?? "")"
            }
            // A plain press through accessibility is exact. Modified clicks need real mouse events.
            var found: AXFound?
            if !label.isEmpty, let pid = runningMatch(named: action.app ?? "")?.pid ?? frontmost()?.pid {
                let axAction: String? = held.isEmpty && action.type == "click" ? kAXPressAction
                    : held.isEmpty && action.type == "right_click" ? kAXShowMenuAction : nil
                let outcome = await Task.detached(priority: .userInitiated) {
                    AXSearch.findAndMaybePress(target: label, pid: pid, near: mapped, action: axAction)
                }.value
                if outcome.pressed {
                    return action.type == "right_click" ? "opened the menu “\(label)”" : "pressed “\(label)”"
                }
                found = outcome.found
            }
            guard let resolved = Self.choosePoint(mapped: mapped, found: found) else {
                return pointerMiss(action, verb: "click")
            }
            let button: CGMouseButton = action.type == "right_click" ? .right : action.type == "middle_click" ? .center : .left
            let count = action.type == "double_click" ? 2 : action.type == "triple_click" ? 3 : 1
            await EventActuator.click(at: resolved.point, button: button, count: count, held: held)
            let verb = action.type == "double_click" ? "double-clicked"
                : action.type == "triple_click" ? "triple-clicked"
                : action.type.replacingOccurrences(of: "_", with: " ")
            let withMods = held.isEmpty ? "" : " holding \(action.modifiers ?? "")"
            return "\(verb)\(withMods) \(resolved.how)"
        case "move":
            guard let resolved = await resolvePoint(x: action.x, y: action.y, target: action.target, app: action.app,
                                                    box: box, imageWidth: imageWidth, imageHeight: imageHeight) else {
                return pointerMiss(action, verb: "move")
            }
            await EventActuator.move(to: resolved.point)
            return "moved \(resolved.how)"
        case "drag":
            guard let from = Self.mapImage(x: action.fromX ?? -1, y: action.fromY ?? -1, box: box,
                                          imageWidth: imageWidth, imageHeight: imageHeight),
                  let to = Self.mapImage(x: action.toX ?? -1, y: action.toY ?? -1, box: box,
                                         imageWidth: imageWidth, imageHeight: imageHeight) else {
                return "ignored drag outside the screen"
            }
            await EventActuator.drag(from: from, to: to)
            return String(format: "dragged from (%.0f, %.0f) to (%.0f, %.0f)", from.x, from.y, to.x, to.y)
        case "type":
            let text = action.text ?? ""
            guard !text.isEmpty else { return "nothing to type" }
            if EventActuator.secureInputActive {
                return "a password field has the keyboard — i don't type secrets. ask the user to fill it in, then continue"
            }
            await EventActuator.typeText(text)
            return text.count > EventActuator.pasteThreshold
                ? "pasted \(text.count) characters" : "typed \(text.count) characters"
        case "key":
            guard let combo = action.key, !combo.isEmpty else { return "no key given" }
            let times = min(max(action.times ?? 1, 1), 50)
            guard await EventActuator.pressKey(combo, times: times) else { return "unknown key \(combo)" }
            return times > 1 ? "pressed \(combo) \(times) times" : "pressed \(combo)"
        case "scroll":
            let point = Self.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                      imageWidth: imageWidth, imageHeight: imageHeight)
            await EventActuator.scroll(dy: action.dy ?? 0, dx: action.dx ?? 0, at: point)
            return String(format: "scrolled %.0f", action.dy ?? 0)
        default:
            return "unknown action \(action.type)"
        }
    }
}
