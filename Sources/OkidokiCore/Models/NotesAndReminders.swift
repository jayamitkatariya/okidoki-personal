import Foundation

/// A note, kept on this Mac and searchable by okidoki. Markdown in `body`.
public struct Note: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var title: String
    public var body: String
    public var tags: [String]
    public var pinned: Bool
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, accountID: String, title: String, body: String = "", tags: [String] = [],
                pinned: Bool = false, createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id; self.accountID = accountID; self.title = title; self.body = body; self.tags = tags
        self.pinned = pinned; self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    /// A title for a note typed as one line: its first sentence, or the start of it.
    public static func title(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 60 { return trimmed.isEmpty ? "untitled" : trimmed }
        let cut = trimmed.prefix(60)
        return (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
    }
}

/// How often a reminder comes back once it's done.
public enum ReminderRepeat: String, Codable, CaseIterable, Sendable {
    case never, daily, weekdays, weekly, monthly

    /// The next time after `date` for a repeating reminder.
    public func next(after date: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .never: return nil
        case .daily: return calendar.date(byAdding: .day, value: 1, to: date)
        case .weekly: return calendar.date(byAdding: .day, value: 7, to: date)
        case .monthly: return calendar.date(byAdding: .month, value: 1, to: date)
        case .weekdays:
            var next = calendar.date(byAdding: .day, value: 1, to: date) ?? date
            while calendar.isDateInWeekend(next) { next = calendar.date(byAdding: .day, value: 1, to: next) ?? next }
            return next
        }
    }
}

/// A reminder okidoki fires itself: a notification and a card in the notch. It can carry a skill
/// to replay when it's due ("every Friday at 4: replay expense report").
public struct Reminder: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var title: String
    public var dueAt: Date?
    public var repeats: ReminderRepeat
    public var done: Bool
    public var doneAt: Date?
    /// A skill to replay when it fires, instead of only telling you.
    public var skillID: String?
    /// When it last fired, so a relaunch doesn't fire it again.
    public var firedAt: Date?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, accountID: String, title: String, dueAt: Date? = nil,
                repeats: ReminderRepeat = .never, done: Bool = false, doneAt: Date? = nil, skillID: String? = nil,
                firedAt: Date? = nil, createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id; self.accountID = accountID; self.title = title; self.dueAt = dueAt; self.repeats = repeats
        self.done = done; self.doneAt = doneAt; self.skillID = skillID; self.firedAt = firedAt
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, accountID, title, dueAt, repeats, done, doneAt, skillID, firedAt, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        accountID = (try? c.decodeIfPresent(String.self, forKey: .accountID)).flatMap { $0 } ?? ""
        title = try c.decode(String.self, forKey: .title)
        dueAt = (try? c.decodeIfPresent(Date.self, forKey: .dueAt)).flatMap { $0 }
        repeats = (try? c.decodeIfPresent(ReminderRepeat.self, forKey: .repeats)).flatMap { $0 } ?? .never
        done = (try? c.decodeIfPresent(Bool.self, forKey: .done)).flatMap { $0 } ?? false
        doneAt = (try? c.decodeIfPresent(Date.self, forKey: .doneAt)).flatMap { $0 }
        skillID = (try? c.decodeIfPresent(String.self, forKey: .skillID)).flatMap { $0 }
        firedAt = (try? c.decodeIfPresent(Date.self, forKey: .firedAt)).flatMap { $0 }
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)).flatMap { $0 } ?? Date()
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)).flatMap { $0 } ?? createdAt
    }

    /// Due and not yet fired for this due time.
    public func isDue(now: Date = Date()) -> Bool {
        guard !done, let dueAt, dueAt <= now else { return false }
        return firedAt.map { $0 < dueAt } ?? true
    }
}
