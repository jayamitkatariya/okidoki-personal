import Foundation

/// The repeat in a reminder request: "every day", "each weekday", "every monday", "monthly".
public enum ReminderParsing {
    public static func repeats(in text: String) -> ReminderRepeat {
        let t = text.lowercased()
        if t.range(of: #"\b(every|each) (weekday|work ?day)s?\b|\bon weekdays\b"#, options: .regularExpression) != nil { return .weekdays }
        if t.range(of: #"\b(every|each) ?day\b|\bdaily\b|\bevery (morning|evening|night)\b"#, options: .regularExpression) != nil { return .daily }
        if t.range(of: #"\b(every|each) (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bweekly\b"#, options: .regularExpression) != nil { return .weekly }
        if t.range(of: #"\b(every|each) month\b|\bmonthly\b"#, options: .regularExpression) != nil { return .monthly }
        return .never
    }
}
