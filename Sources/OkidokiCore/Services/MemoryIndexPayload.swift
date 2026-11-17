import Foundation

/// What the Mac sends the brain's memory index (Moss): only the parts it embeds. Notes from every
/// account (each tagged with its own), the last two weeks of conversation, recent tasks without their
/// output, and skills without their recorded clicks. Sent every few seconds of changes, so it stays small.
public struct MemoryIndexPayload: Equatable, Sendable {
    public struct Note: Encodable, Equatable, Sendable {
        public var id: String
        public var accountID: String
        public var section: String
        public var text: String
        public var updatedAt: Date
    }

    public struct Message: Encodable, Equatable, Sendable {
        public var id: String
        public var role: String
        public var text: String
        public var createdAt: Date
    }

    public struct Thread: Encodable, Equatable, Sendable {
        public var id: String
        public var accountID: String
        public var title: String
        public var messages: [Message]
    }

    public struct RunEntry: Encodable, Equatable, Sendable {
        public var id: String
        public var accountID: String
        public var kind: String
        public var status: String
        public var title: String
        public var prompt: String
        public var summary: String
        public var createdAt: Date
    }

    public struct SkillLine: Encodable, Equatable, Sendable {
        public var text: String
    }

    public struct SkillEntry: Encodable, Equatable, Sendable {
        public var id: String
        public var accountID: String
        public var name: String
        public var summary: String
        public var steps: [SkillLine]
        public var createdAt: Date
    }

    public var memories: [Note]
    public var threads: [Thread]
    public var runs: [RunEntry]
    public var skills: [SkillEntry]

    /// The brain keeps the newest 48 turns from the last 14 days and runs from the last 60; sending more is waste.
    static let messageDays: TimeInterval = 14
    static let runDays: TimeInterval = 60
    static let maxRuns = 120
    static let maxSkillSteps = 12

    @MainActor
    public init(store: OkidokiStore, now: Date = Date()) {
        self.init(memories: store.memories, threads: store.threads, runs: store.runs, skills: store.skills,
                  forgotten: Array(store.forgottenMemories.keys), now: now)
    }

    /// `forgotten`: memory text the person deleted or replaced (`MemoryRecall.forgetKey`). Turns that repeat it
    /// stay out of the index, so "forget that" isn't undone by recalling the chat where it was said.
    public init(memories: [MemoryItem], threads: [ChatThread], runs: [AgentRun], skills: [Skill],
                forgotten: [String] = [], now: Date = Date()) {
        let messageCutoff = now.addingTimeInterval(-Self.messageDays * 86_400)
        let runCutoff = now.addingTimeInterval(-Self.runDays * 86_400)
        // A note saved again since it was forgotten is known again.
        let current = Set(memories.map { MemoryRecall.forgetKey($0.text) })
        let gone = forgotten.filter { !current.contains($0) }.map { Set($0.split(separator: " ").map(String.init)) }
        self.memories = memories.map {
            Note(id: $0.id, accountID: $0.accountID, section: $0.section.rawValue, text: $0.text, updatedAt: $0.updatedAt)
        }
        self.threads = threads.compactMap { thread in
            guard thread.updatedAt >= messageCutoff else { return nil }
            let recent = thread.messages
                .filter { $0.createdAt >= messageCutoff && $0.role != .system && !MemoryRecall.repeats($0.text, forgotten: gone) }
                .map { Message(id: $0.id, role: $0.role.rawValue, text: String($0.text.prefix(2_000)), createdAt: $0.createdAt) }
            return recent.isEmpty ? nil : Thread(id: thread.id, accountID: thread.accountID, title: thread.title, messages: recent)
        }
        self.runs = runs
            .filter { $0.kind != .answer && $0.status != .previewing && $0.createdAt >= runCutoff }
            .sorted { $0.createdAt > $1.createdAt }
            .prefix(Self.maxRuns)
            .map {
                RunEntry(id: $0.id, accountID: $0.accountID, kind: $0.kind.rawValue, status: $0.status.rawValue,
                     title: $0.title, prompt: String($0.prompt.prefix(600)), summary: String($0.summary.prefix(400)),
                     createdAt: $0.createdAt)
            }
        self.skills = skills.map { skill in
            SkillEntry(id: skill.id, accountID: skill.accountID, name: skill.name, summary: skill.summary,
                       steps: skill.steps.prefix(Self.maxSkillSteps).map { SkillLine(text: String($0.text.prefix(120))) },
                       createdAt: skill.createdAt)
        }
    }
}
