import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

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

    public init(type: String, x: Double? = nil, y: Double? = nil,
                fromX: Double? = nil, fromY: Double? = nil, toX: Double? = nil, toY: Double? = nil,
                app: String? = nil, text: String? = nil, key: String? = nil,
                dx: Double? = nil, dy: Double? = nil, seconds: Double? = nil,
                reason: String? = nil, summary: String? = nil, say: String? = nil) {
        self.type = type; self.x = x; self.y = y
        self.fromX = fromX; self.fromY = fromY; self.toX = toX; self.toY = toY
        self.app = app; self.text = text; self.key = key
        self.dx = dx; self.dy = dy; self.seconds = seconds
        self.reason = reason; self.summary = summary; self.say = say
    }

    enum CodingKeys: String, CodingKey {
        case type, x, y, fromX = "from_x", fromY = "from_y", toX = "to_x", toY = "to_y"
        case app, text, key, dx, dy, seconds, reason, summary, say
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
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 27, "9": 28,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
        "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44,
    ]

    static func modifiers(_ name: String) -> CGEventFlags? {
        switch name {
        case "cmd", "command", "⌘": return .maskCommand
        case "ctrl", "control", "^": return .maskControl
        case "opt", "option", "alt", "⌥": return .maskAlternate
        case "shift", "⇧": return .maskShift
        default: return nil
        }
    }
}

// MARK: - Event actuator

@MainActor
public enum EventActuator {
    public static var canPost: Bool { AXIsProcessTrusted() || CGPreflightPostEventAccess() }

    static func post(_ event: CGEvent?) {
        event?.post(tap: .cghidEventTap)
    }

    static func sleep(_ ms: UInt64) async {
        try? await Task.sleep(nanoseconds: ms * 1_000_000)
    }

    public static func move(to point: CGPoint) async {
        guard canPost else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
        await sleep(40)
    }

    public static func click(at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) async {
        guard canPost else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button))
        await sleep(70)
        let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
        for _ in 0..<max(1, count) {
            post(CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button))
            await sleep(45)
            post(CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button))
            await sleep(80)
        }
    }

    public static func drag(from source: CGPoint, to target: CGPoint, duration: Double = 0.55) async {
        guard canPost else { return }
        let sourceEvent = CGEventSource(stateID: .hidSystemState)
        post(CGEvent(mouseEventSource: sourceEvent, mouseType: .mouseMoved, mouseCursorPosition: source, mouseButton: .left))
        await sleep(120)
        post(CGEvent(mouseEventSource: sourceEvent, mouseType: .leftMouseDown, mouseCursorPosition: source, mouseButton: .left))
        await sleep(110)
        let steps = max(12, Int(duration * 60))
        for index in 1...steps {
            let t = Double(index) / Double(steps)
            let eased = t * t * (3 - 2 * t)
            let point = CGPoint(x: source.x + (target.x - source.x) * eased,
                                y: source.y + (target.y - source.y) * eased)
            post(CGEvent(mouseEventSource: sourceEvent, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left))
            try? await Task.sleep(nanoseconds: UInt64(duration / Double(steps) * 1_000_000_000))
        }
        await sleep(90)
        post(CGEvent(mouseEventSource: sourceEvent, mouseType: .leftMouseUp, mouseCursorPosition: target, mouseButton: .left))
        await sleep(60)
    }

    public static func typeText(_ text: String) async {
        guard canPost, !text.isEmpty else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        let parts = text.components(separatedBy: "\n")
        for (index, part) in parts.enumerated() {
            if index > 0 { await pressKey("return") }
            var start = part.startIndex
            while start < part.endIndex {
                let end = part.index(start, offsetBy: 20, limitedBy: part.endIndex) ?? part.endIndex
                let chunk = String(part[start..<end])
                var buffer = Array(chunk.utf16)
                let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                down?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
                post(down)
                try? await Task.sleep(nanoseconds: 14_000_000)
                let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                up?.keyboardSetUnicodeString(stringLength: 0, unicodeString: nil)
                post(up)
                try? await Task.sleep(nanoseconds: 12_000_000)
                start = end
            }
        }
    }

    @discardableResult
    public static func pressKey(_ combo: String) async -> Bool {
        guard canPost else { return false }
        let pieces = combo.lowercased()
            .replacingOccurrences(of: "⌘", with: "cmd")
            .replacingOccurrences(of: "⌥", with: "opt")
            .replacingOccurrences(of: "⇧", with: "shift")
            .split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = pieces.last else { return false }
        guard let code = VirtualKeys.named[last] else { return false }
        var flags: CGEventFlags = []
        for piece in pieces.dropLast() {
            if let flag = VirtualKeys.modifiers(piece) { flags.insert(flag) }
        }
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        down?.flags = flags
        post(down)
        try? await Task.sleep(nanoseconds: 35_000_000)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        up?.flags = flags
        post(up)
        try? await Task.sleep(nanoseconds: 40_000_000)
        return true
    }

    public static func scroll(dy: Double, dx: Double = 0, at point: CGPoint?) async {
        guard canPost else { return }
        if let point { await move(to: point) }
        let source = CGEventSource(stateID: .hidSystemState)
        let steps = 3
        let stepY = Int32((-dy) / Double(steps))
        let stepX = Int32((-dx) / Double(steps))
        for _ in 0..<steps {
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                wheel1: stepY, wheel2: stepX, wheel3: 0)
            post(event)
            try? await Task.sleep(nanoseconds: 45_000_000)
        }
    }
}

// MARK: - Accessibility search

public struct AXFound: Equatable, Sendable {
    public var rect: CGRect
    public var label: String
}

public enum AXSearch {
    public static func find(target: String, pid: pid_t) -> AXFound? {
        guard AXIsProcessTrusted(), !target.isEmpty else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var queue: [AXUIElement] = [app]
        var visited = 0
        let needle = target.lowercased()
        while !queue.isEmpty && visited < 700 {
            let element = queue.removeFirst()
            visited += 1
            var title = "", description = "", value = "", role = ""
            for (key, bucket) in [(kAXTitleAttribute, 0), (kAXDescriptionAttribute, 1), (kAXValueAttribute, 2), (kAXRoleAttribute, 3)] {
                var raw: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, key as CFString, &raw) == .success {
                    let string = (raw as? String) ?? ""
                    switch bucket {
                    case 0: title = string
                    case 1: description = string
                    case 2: value = string
                    default: role = string
                    }
                }
            }
            let haystack = "\(title) \(description) \(value) \(role)".lowercased()
            if haystack.contains(needle), let rect = frame(of: element) {
                let label = [title, description, value].first { !$0.isEmpty } ?? role
                return AXFound(rect: rect, label: label)
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(60))
            }
        }
        return nil
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
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
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

    /// Best application bundle URL for a fuzzy name, or nil.
    public static func resolve(name: String) -> (url: URL, bundleID: String)? {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ".app", with: "")
        let needle = normalize(AppResolver.aliases[normalize(cleaned)] ?? cleaned)
        guard !needle.isEmpty else { return nil }
        var best: (url: URL, bundleID: String, score: Int)?
        for directory in searchDirectories() {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { continue }
            for entry in entries where entry.pathExtension == "app" {
                let displayName = displayName(of: entry)
                let candidate = normalize(displayName)
                var score = 0
                if candidate == needle { score = 100 }
                else if candidate.hasPrefix(needle) { score = 60 }
                else if candidate.contains(needle) { score = 40 }
                else if needle.contains(candidate), candidate.count > 3 { score = 25 }
                guard score > 0 else { continue }
                if score > (best?.score ?? 0) {
                    best = (entry, bundleID(of: entry) ?? "", score)
                }
            }
        }
        guard let best else { return nil }
        return (best.url, best.bundleID)
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

    public func capture(screen: NSScreen) -> (png: Data, box: ScreenBox, imageWidth: Double, imageHeight: Double)? {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess()
            return nil
        }
        let rect = Self.cgGlobalRect(for: screen)
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
                  rep.pixelsWide > 0, rep.pixelsHigh > 0 else { return nil }
            return (data, ScreenBox(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
                    Double(rep.pixelsWide), Double(rep.pixelsHigh))
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return nil
        }
    }

    public func screenForAction() -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) })
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
            .map { AppInfo(name: $0.localizedName ?? "", bundleID: $0.bundleIdentifier ?? "",
                           pid: $0.processIdentifier, isActive: $0.isActive) }
    }

    public func frontmost() -> AppInfo? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return AppInfo(name: app.localizedName ?? "", bundleID: app.bundleIdentifier ?? "",
                       pid: app.processIdentifier, isActive: true)
    }

    @discardableResult
    public func openApp(named name: String) async throws -> String {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let running = runningApps().first(where: { AppResolver.normalize($0.name) == AppResolver.normalize(cleaned) }) {
            let app = NSWorkspace.shared.runningApplications.first { $0.processIdentifier == running.pid }
            app?.activate(options: [.activateIgnoringOtherApps])
            await waitForFrontmost(bundleID: running.bundleID, timeout: 4)
            return "focused \(running.name.isEmpty ? cleaned : running.name)"
        }
        if let resolved = AppResolver.resolve(name: cleaned) {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            do {
                try await NSWorkspace.shared.openApplication(at: resolved.url, configuration: config)
            } catch {
                throw ComputerUseError.appNotFound(cleaned)
            }
            await waitForFrontmost(bundleID: resolved.bundleID, timeout: 8)
            return "opened \(AppResolver.displayName(of: resolved.url))"
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
        let needle = AppResolver.normalize(cleaned)
        if let running = runningApps().first(where: { AppResolver.normalize($0.name) == needle || AppResolver.normalize($0.bundleID) == needle }) {
            let app = NSWorkspace.shared.runningApplications.first { $0.processIdentifier == running.pid }
            app?.activate(options: [.activateIgnoringOtherApps])
            await waitForFrontmost(bundleID: running.bundleID, timeout: 3)
            return "focused \(running.name.isEmpty ? cleaned : running.name)"
        }
        if let resolved = AppResolver.resolve(name: cleaned) {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            try? await NSWorkspace.shared.openApplication(at: resolved.url, configuration: config)
            await waitForFrontmost(bundleID: resolved.bundleID, timeout: 6)
            return "opened \(AppResolver.displayName(of: resolved.url))"
        }
        return "couldn't find \(cleaned)"
    }

    private func waitForFrontmost(bundleID: String? = nil, name: String? = nil, timeout: Double) async {
        guard bundleID != nil || name != nil else { return }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let front = NSWorkspace.shared.frontmostApplication {
                if let bundleID, front.bundleIdentifier == bundleID { return }
                if let name,
                   AppResolver.normalize(front.localizedName ?? "") == AppResolver.normalize(name) { return }
            }
            try? await Task.sleep(nanoseconds: 220_000_000)
        }
    }

    // MARK: Coordinate mapping

    public static func mapImage(x: Double, y: Double, box: ScreenBox,
                                imageWidth: Double, imageHeight: Double) -> CGPoint? {
        guard imageWidth > 0, imageHeight > 0, x >= 0, y >= 0 else { return nil }
        let point = CGPoint(x: box.x + (x / imageWidth) * box.width,
                            y: box.y + (y / imageHeight) * box.height)
        guard point.x >= box.x - 40, point.x <= box.x + box.width + 40,
              point.y >= box.y - 40, point.y <= box.y + box.height + 40 else { return nil }
        return point
    }

    // MARK: Perform

    public func perform(_ action: ComputerAction, screen box: ScreenBox,
                        imageWidth: Double, imageHeight: Double) async throws -> String {
        guard EventActuator.canPost else { throw ComputerUseError.accessibility }
        switch action.type {
        case "open_app":
            let name = action.app ?? action.text ?? ""
            return try await openApp(named: name)
        case "activate":
            return await activateApp(named: action.app ?? action.text ?? "")
        case "click", "double_click", "right_click":
            guard let point = Self.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                            imageWidth: imageWidth, imageHeight: imageHeight) else {
                return "ignored click outside the screen"
            }
            let button: CGMouseButton = action.type == "right_click" ? .right : .left
            let count = action.type == "double_click" ? 2 : 1
            await EventActuator.click(at: point, button: button, count: count)
            return action.type == "double_click"
                ? String(format: "double-clicked at (%.0f, %.0f)", point.x, point.y)
                : String(format: "%@ at (%.0f, %.0f)", action.type, point.x, point.y)
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
            await EventActuator.typeText(text)
            return "typed \(text.count) characters"
        case "key":
            guard let combo = action.key, !combo.isEmpty else { return "no key given" }
            guard await EventActuator.pressKey(combo) else { return "unknown key \(combo)" }
            return "pressed \(combo)"
        case "scroll":
            let point = Self.mapImage(x: action.x ?? -1, y: action.y ?? -1, box: box,
                                      imageWidth: imageWidth, imageHeight: imageHeight)
            await EventActuator.scroll(dy: action.dy ?? 0, dx: action.dx ?? 0, at: point)
            return String(format: "scrolled %.0f", action.dy ?? 0)
        case "wait":
            let seconds = min(max(action.seconds ?? 1, 0.2), 5)
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return action.reason.map { "waited — \($0)" } ?? "waited \(String(format: "%.1f", seconds))s"
        default:
            return "unknown action \(action.type)"
        }
    }
}
