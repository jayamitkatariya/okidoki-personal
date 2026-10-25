import Foundation

/// Judgement calls the driving loop makes about what the model says.
public enum DrivePolicy {
    /// A "can't finish" that is really the model asking whether to go on ("Should I continue by…?",
    /// "Do you want me to…") rather than something stopping it. The user already asked for the whole
    /// task and approved the plan, so the loop tells it to keep going instead of ending the run.
    public static func asksToContinue(_ reason: String) -> Bool {
        let text = reason.lowercased()
        guard !isRealBlocker(text) else { return false }
        let asks = ["should i ", "shall i ", "do you want me", "would you like me", "want me to ", "let me know if",
                    "would you like", "do you want", "if you'd like", "if you want me", "should i continue",
                    "ok to continue", "okay to continue", "may i continue", "can i continue"]
        if asks.contains(where: { text.contains($0) }) { return true }
        return text.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?")
    }

    /// A "can't finish" that is really a question only the user can answer: which of several
    /// matches they meant, a name or number the task left out. The run pauses on it instead of
    /// failing, and their reply picks the task back up.
    public static func asksForDetail(_ reason: String) -> Bool {
        let text = reason.lowercased()
        guard !isRealBlocker(text) else { return false }
        let asks = ["which one", "which of", "which contact", "which chat", "which file", "which account", "which person",
                    "who did you mean", "who you mean", "did you mean", "if you meant", "if you mean",
                    "give me their", "give me the name", "give me a name", "tell me which", "tell me who", "tell me their",
                    "let me know which", "let me know who", "name or number", "what's their", "what is their",
                    "whose ", "there are several", "there are two", "more than one match"]
        return asks.contains { text.contains($0) }
    }

    /// Things the model must stop for: secrets, money, permissions, a missing app or account, a captcha.
    public static func isRealBlocker(_ reason: String) -> Bool {
        let text = reason.lowercased()
        let blockers = ["password", "passcode", "sign in", "sign-in", "signin", "log in", "login", "2fa", "two-factor",
                        "verification code", "one-time code", "captcha", "payment", "credit card", "purchase", "buy ",
                        "subscription", "permission", "allow or don't allow", "accessibility", "screen recording",
                        "not installed", "isn't installed", "no account", "locked", "touch id", "not allowed"]
        return blockers.contains { text.contains($0) }
    }
}
