import Foundation

/// What one pull brought back for an account: items other Macs wrote since this Mac last merged, and the
/// items their syncs deleted.
public struct PulledChanges: Equatable, Sendable {
    public struct Deletion: Codable, Equatable, Sendable {
        public var table: String
        public var id: String
        public var deletedAt: Date

        public init(table: String, id: String, deletedAt: Date) {
            self.table = table; self.id = id; self.deletedAt = deletedAt
        }
    }

    public var threads: [ChatThread] = []
    public var memories: [MemoryItem] = []
    public var runs: [AgentRun] = []
    public var skills: [Skill] = []
    public var routines: [Routine] = []
    public var deletions: [Deletion] = []

    public init(threads: [ChatThread] = [], memories: [MemoryItem] = [], runs: [AgentRun] = [],
                skills: [Skill] = [], routines: [Routine] = [], deletions: [Deletion] = []) {
        self.threads = threads; self.memories = memories; self.runs = runs
        self.skills = skills; self.routines = routines; self.deletions = deletions
    }

    public var isEmpty: Bool {
        threads.isEmpty && memories.isEmpty && runs.isEmpty && skills.isEmpty && routines.isEmpty && deletions.isEmpty
    }
}

public struct MergeSummary: Equatable, Sendable {
    public var added = 0
    public var updated = 0
    public var removed = 0

    public init(added: Int = 0, updated: Int = 0, removed: Int = 0) {
        self.added = added; self.updated = updated; self.removed = removed
    }

    public var changes: Int { added + updated + removed }

    public static func += (lhs: inout MergeSummary, rhs: MergeSummary) {
        lhs.added += rhs.added; lhs.updated += rhs.updated; lhs.removed += rhs.removed
    }
}

/// Merging another Mac's copy of an account into this one, item by item.
///
/// - A deletion removes the local item unless it was edited here after the delete (the edit wins and
///   the next push brings it back).
/// - A remote item replaces the local one only when it was edited later; a tie keeps the local copy.
/// - A remote item deleted here since (and not edited after) stays deleted until the push says so.
public enum SyncMerge {
    public static func merge<T: Identifiable & Equatable>(
        local: [T],
        remote: [T],
        deletions: [PulledChanges.Deletion],
        deletedHere: [String: Date],
        editedAt: (T) -> Date,
        combine: ((_ local: T, _ remote: T) -> T)? = nil,
        summary: inout MergeSummary
    ) -> [T] where T.ID == String {
        var items = local
        if !deletions.isEmpty {
            let tombstones = Dictionary(deletions.map { ($0.id, $0.deletedAt) }, uniquingKeysWith: max)
            let before = items.count
            items.removeAll { item in
                guard let deletedAt = tombstones[item.id] else { return false }
                return editedAt(item) <= deletedAt
            }
            summary.removed += before - items.count
        }
        var index = Dictionary(items.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in remote {
            if let position = index[item.id] {
                let mine = items[position]
                let next: T
                if let combine {
                    next = combine(mine, item)
                } else {
                    next = editedAt(item) > editedAt(mine) ? item : mine
                }
                if next != mine {
                    items[position] = next
                    summary.updated += 1
                }
            } else {
                if let deletedAt = deletedHere[item.id], editedAt(item) <= deletedAt { continue }
                index[item.id] = items.count
                items.append(item)
                summary.added += 1
            }
        }
        return items
    }

    /// A thread edited on two Macs keeps every message from both; the rest comes from the later copy.
    public static func combineThreads(_ local: ChatThread, _ remote: ChatThread) -> ChatThread {
        let remoteIsNewer = remote.updatedAt > local.updatedAt
        var merged = remoteIsNewer ? remote : local
        let older = remoteIsNewer ? local : remote
        let newerIDs = Set(merged.messages.map(\.id))
        let missing = older.messages.filter { !newerIDs.contains($0.id) }
        guard !missing.isEmpty else { return merged }
        merged.messages = (merged.messages + missing).enumerated()
            .sorted { $0.element.createdAt == $1.element.createdAt ? $0.offset < $1.offset : $0.element.createdAt < $1.element.createdAt }
            .map(\.element)
        return merged
    }

    /// A memory another Mac saved under its own id that says exactly what one here says: keep one.
    public static func withoutDuplicateMemories(_ remote: [MemoryItem], local: [MemoryItem]) -> [MemoryItem] {
        let localIDs = Set(local.map(\.id))
        let localTexts = Set(local.map { "\($0.accountID)\u{0}\($0.text.lowercased())" })
        return remote.filter { item in
            localIDs.contains(item.id) || !localTexts.contains("\(item.accountID)\u{0}\(item.text.lowercased())")
        }
    }
}

/// Dates as sync writes and reads them: ISO 8601 with fractional seconds, so two edits a moment apart
/// stay in order. Reading also takes whole seconds (older saves, older Macs) and plain numbers.
public enum SyncDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func string(from date: Date) -> String { fractional.string(from: date) }

    public static func date(from text: String) -> Date? { fractional.date(from: text) ?? whole.date(from: text) }

    public static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(string(from: date))
        }
        return encoder
    }

    public static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer()
            if let seconds = try? value.decode(Double.self) { return Date(timeIntervalSinceReferenceDate: seconds) }
            let text = try value.decode(String.self)
            if let parsed = date(from: text) { return parsed }
            throw DecodingError.dataCorruptedError(in: value, debugDescription: "not an ISO 8601 date: \(text)")
        }
        return decoder
    }
}
