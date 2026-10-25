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
