import AppKit
import ApplicationServices
import Foundation

public struct WatchedStep: Identifiable, Sendable {
    public var id = UUID()
    public var app: String
    public var action: String
    public var detail: String
    public var x: Double?
    public var y: Double?
    public var at: Date
    public init(app: String, action: String, detail: String, x: Double?, y: Double?, at: Date = Date()) {
        self.app = app; self.action = action; self.detail = detail
        self.x = x; self.y = y; self.at = at
    }

    public var step: SkillStep {
        SkillStep(text: detail.isEmpty ? action : detail, app: app, x: x, y: y)
    }
}

@MainActor
public final class WatchRecorder: ObservableObject {
    @Published public private(set) var isRecording = false
    @Published public private(set) var steps: [WatchedStep] = []
    @Published public private(set) var startedAt: Date?

    public var onFinish: (([WatchedStep]) -> Void)?

    private var clickMonitor: Any?
    private var appObserver: NSObjectProtocol?
    private var lastApp = ""
    private var lastAppAt = Date.distantPast

    public init() {}

    public func start() {
        guard !isRecording else { return }
        steps = []
        isRecording = true
        startedAt = Date()
        lastApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "mac"
        steps.append(WatchedStep(app: lastApp, action: "start", detail: "start in \(lastApp)", x: nil, y: nil))

        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor in
                guard let self, self.isRecording else { return }
                let point = NSEvent.mouseLocation
                let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? self.lastApp
                let label = self.accessibilityLabel(at: point)
                let action = event.type == .rightMouseDown ? "right-click" : "click"
                let detail: String
                if label.isEmpty {
                    detail = "in \(app), \(action) at \(Int(point.x)), \(Int(point.y))"
                } else {
                    detail = "in \(app), \(action) “\(label)”"
                }
                self.steps.append(WatchedStep(app: app, action: action, detail: detail, x: Double(point.x), y: Double(point.y)))
            }
        }

        appObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self else { return }
            let app = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.localizedName ?? "app"
            Task { @MainActor in
                guard self.isRecording else { return }
                if app != self.lastApp, Date().timeIntervalSince(self.lastAppAt) > 1.0 {
                    self.lastApp = app
                    self.lastAppAt = Date()
                    self.steps.append(WatchedStep(app: app, action: "switch", detail: "switch to \(app)", x: nil, y: nil))
                }
            }
        }
    }

    public func stop() {
        guard isRecording else { return }
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        if let appObserver { NSWorkspace.shared.notificationCenter.removeObserver(appObserver) }
        clickMonitor = nil
        appObserver = nil
        isRecording = false
        if steps.count > 1 { steps.removeFirst() }
        onFinish?(steps)
    }

    private func accessibilityLabel(at point: NSPoint) -> String {
        guard AXIsProcessTrusted() else { return "" }
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element)
        guard result == .success, let element else { return "" }
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
        let best = [title, description, value].first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        if best.isEmpty {
            return role.replacingOccurrences(of: "AX", with: "").lowercased()
        }
        return String(best.prefix(70))
    }
}

public enum AccessibilityActions {
    public static func click(at point: CGPoint) -> Bool {
        guard AXIsProcessTrusted() || CGPreflightPostEventAccess() else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        move?.post(tap: .cghidEventTap)
        usleep(120_000)
        let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(55_000)
        up?.post(tap: .cghidEventTap)
        return true
    }

    public static func type(_ text: String) -> Bool {
        guard AXIsProcessTrusted() || CGPreflightPostEventAccess() else { return false }
        let source = CGEventSource(stateID: .hidSystemState)
        for scalar in text.unicodeScalars {
            var char = UniChar(scalar.value)
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
            down?.post(tap: .cghidEventTap)
            usleep(12_000)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &char)
            up?.post(tap: .cghidEventTap)
        }
        return true
    }
}
