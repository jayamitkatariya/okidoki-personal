import Foundation

/// The decisions smart Mac replay makes in code on top of `HybridReplay`: which dialogs only the person
/// may answer, which are never dismissed automatically, where a pass starts, whether a screen is one the
/// skill knows, and what a key means when acting through Accessibility. No model, no I/O.
public enum MacReplay {

    // MARK: - Dialogs

    /// Processes whose windows are macOS asking the person something (a password, a permission).
    public static let systemAgents: Set<String> = ["com.apple.SecurityAgent", "com.apple.UserNotificationCenter",
                                                    "com.apple.coreservices.uiagent", "com.apple.CoreServicesUIAgent",
                                                    "com.apple.LocalAuthentication.UIAgent", "com.apple.accessibility.universalAccessAuthWarn"]

    /// Why only the person can answer this dialog, or nil. Never clicked by a rule or the model: macOS
    /// password and Touch ID prompts, permission prompts ("would like to access"), keychain prompts,
    /// one-time codes.
    public static func personOnly(text: String, buttons: [String], owner: String = "") -> String? {
        let t = text.lowercased()
        let b = buttons.map { $0.lowercased() }
        if systemAgents.contains(owner) {
            if t.contains("password") || t.contains("touch id") || b.contains("use password…") { return "a macOS password prompt" }
            return "a macOS prompt"
        }
        if t.contains("would like to access") || t.contains("would like to control") || t.contains("wants access to control")
            || t.contains("would like to record") || t.contains("would like to receive keystrokes") { return "a permission prompt" }
        if t.contains("keychain") || t.contains("wants to use your confidential information") { return "a keychain prompt" }
        if b.contains("allow") && (b.contains("don't allow") || b.contains("don’t allow")) { return "a permission prompt" }
        if t.contains("verification code") || t.contains("one-time code") || t.contains("enter the code") { return "a one-time code" }
        return nil
    }

    /// Dialogs a rule never closes by itself, whatever button looks safe: losing work is the gate's
    /// call, not a popup rule's ("Do you want to save the changes…?", "Don't Save").
    public static func neverDismiss(text: String, buttons: [String]) -> Bool {
        let t = text.lowercased()
        let b = buttons.map { $0.lowercased() }
        if t.contains("save the changes") || t.contains("save changes") || t.contains("do you want to save") { return true }
        if b.contains("don't save") || b.contains("don’t save") || b.contains("delete") || b.contains("move to trash") { return true }
        if t.contains("are you sure you want to delete") || t.contains("can't be undone") || t.contains("cannot be undone") { return true }
        return false
    }

    // MARK: - Where a pass starts

    /// The leading steps that bring the app to where every pass begins (open or bring up the app, open its
    /// window). They run at the start of each pass.
    public static func startSteps(_ plan: [HybridReplay.Planned]) -> Int {
        var n = 0
        while n < plan.count, plan[n].step.action == "switch" || plan[n].step.action == "open" { n += 1 }
        return n
    }

    // MARK: - Screens

    /// Whether what's in front (window and sheets) is a screen no step of the plan is on: an inserted
    /// "Verify your email", a "What's new". False when the plan has no window anchors to tell by.
    public static func unknownScreen(_ plan: [HybridReplay.Planned], seen: HybridReplay.Observation) -> Bool {
        let anchored = plan.compactMap(\.step.anchor).filter { !($0.window ?? "").isEmpty || !($0.landmark ?? "").isEmpty }
        guard !anchored.isEmpty else { return false }
        return !anchored.contains { HybridReplay.matches($0, seen) }
    }

    /// The key a learned rule for an unknown screen is filed under: "window:" and the window's words.
    public static func screenKey(window: String, sheets: [String] = []) -> String? {
        let text = ([window] + sheets).joined(separator: " ")
        return HybridReplay.dialogKey(text).map { "window:" + $0 }
    }

    // MARK: - Acting through Accessibility

    public enum KeyMeaning: Equatable, Sendable {
        /// Return: the window's (or sheet's) default button, or the focused field's confirm.
        case defaultButton
        /// Escape: the sheet's or window's cancel button.
        case cancelButton
        /// Tab: the next field.
        case nextField
        /// Anything else can't be done without a real key press.
        case unsupported
    }

    public static func meaning(ofKey combo: String) -> KeyMeaning {
        switch combo.lowercased().trimmingCharacters(in: .whitespaces) {
        case "return", "enter", "keypadenter": return .defaultButton
        case "esc", "escape": return .cancelButton
        case "tab": return .nextField
        default: return .unsupported
        }
    }

    /// What a field should hold after a type step: the typed text alone when the field was empty or the
    /// step types one whole value (a re-run of the same form must not double it), else appended.
    public static func typedValue(current: String, typed: String, wholeValue: Bool) -> String {
        current.isEmpty || wholeValue ? typed : current + typed
    }

    /// Whether a step's input is exactly one value (`{{name}}`), not text around a value.
    public static func isWholeValue(_ raw: String) -> Bool {
        let names = ParameterFill.names(in: raw)
        return names.count == 1 && raw.trimmingCharacters(in: .whitespaces) == "{{\(names[0])}}"
    }

    // MARK: - The person's turn

    /// When the person's turn is over: what they had to answer is gone, and the app has looked the same
    /// for `quiet` seconds. An unreadable or changing screen never counts as done.
    public struct QuietClock: Equatable, Sendable {
        private var since: Date?
        private var signature = ""
        public init() {}
        public mutating func note(clear: Bool, signature: String, now: Date = Date(), quiet: TimeInterval = 1.5) -> Bool {
            guard clear, !signature.isEmpty else { since = nil; return false }
            guard let since, signature == self.signature else {
                self.since = now
                self.signature = signature
                return false
            }
            return now.timeIntervalSince(since) >= quiet
        }
    }

    // MARK: - The model's touches, kept

    /// One control the model (or the person) acted on, with the locator it had then: what promotion and
    /// popup learning keep.
    public struct Touch: Equatable, Sendable {
        public var action: String
        public var locator: AXLocator?
        public var label: String?
        public var role: String?
        /// Typed text, chosen option or key.
        public var input: String?
        public var window: String?
        public init(action: String, locator: AXLocator?, label: String? = nil, role: String? = nil, input: String? = nil, window: String? = nil) {
            self.action = action; self.locator = locator; self.label = label; self.role = role; self.input = input; self.window = window
        }
    }

    /// Words that make a button something a learned rule must never press.
    public static let risky = ["sign out", "log out", "logout", "delete", "buy", "pay", "submit", "confirm", "remove", "send", "file", "trash", "erase", "don't save", "don’t save"]

    public static func isRisky(_ label: String) -> Bool {
        let l = label.lowercased()
        return risky.contains { l.contains($0) }
    }
}
