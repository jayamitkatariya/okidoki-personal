import Foundation

// MARK: - Wire shapes

/// The shared-session contract, mirrored by web/src/collab/protocol.ts and docs/collab.md.
/// These encode straight to the JSON the joiner page reads; camelCase keys match the TypeScript.

public struct CollabParticipant: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var colorHex: String
    public var joinedAt: Date
    public var isHost: Bool

    public init(id: String, name: String, colorHex: String, joinedAt: Date, isHost: Bool = false) {
        self.id = id; self.name = name; self.colorHex = colorHex; self.joinedAt = joinedAt; self.isHost = isHost
    }
}

public enum CollabMessageKind: String, Codable, Sendable {
    case chat, ask, okidoki, system
}

public struct CollabMessage: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var authorID: String
    public var authorName: String
    public var colorHex: String
    public var text: String
    public var kind: CollabMessageKind
    public var at: Date

    public init(id: String = UUID().uuidString, authorID: String, authorName: String, colorHex: String,
                text: String, kind: CollabMessageKind, at: Date = Date()) {
        self.id = id; self.authorID = authorID; self.authorName = authorName; self.colorHex = colorHex
        self.text = text; self.kind = kind; self.at = at
    }
}

public struct CollabSkillInput: Codable, Equatable, Sendable {
    public var name: String
    public var description: String
    public init(name: String, description: String) { self.name = name; self.description = description }
}

/// The shareable part of a skill: its name and inputs, never its step pictures or secrets.
public struct CollabSkillCard: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var summary: String
    public var intent: String?
    public var inputs: [CollabSkillInput]
    public init(id: String, name: String, summary: String, intent: String? = nil, inputs: [CollabSkillInput] = []) {
        self.id = id; self.name = name; self.summary = summary; self.intent = intent; self.inputs = inputs
    }
}

public struct CollabRunStep: Codable, Equatable, Sendable {
    public var index: Int
    public var say: String
    public var kind: String
    public var detail: String
    public var result: String
    public var status: String
    public init(index: Int, say: String, kind: String, detail: String, result: String, status: String) {
        self.index = index; self.say = say; self.kind = kind; self.detail = detail; self.result = result; self.status = status
    }
}

public struct CollabRun: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var status: String
    public var goal: String
    public var requestedBy: String?
    public var needs: String?
    public var steps: [CollabRunStep]
    public init(id: String, title: String, status: String, goal: String, requestedBy: String? = nil,
                needs: String? = nil, steps: [CollabRunStep] = []) {
        self.id = id; self.title = title; self.status = status; self.goal = goal
        self.requestedBy = requestedBy; self.needs = needs; self.steps = steps
    }
}

public struct CollabVM: Codable, Equatable, Sendable {
    public var phase: String
    public var running: Bool
    public init(phase: String, running: Bool) { self.phase = phase; self.running = running }
}

public struct CollabSnapshot: Codable, Sendable {
    public var hostName: String
    public var startedAt: Date
    public var participants: [CollabParticipant]
    public var wheelHolder: String?
    public var wheelHolderName: String?
    public var vm: CollabVM
    public var run: CollabRun?
    public var skills: [CollabSkillCard]
    public var chat: [CollabMessage]

    public init(hostName: String, startedAt: Date, participants: [CollabParticipant], wheelHolder: String? = nil,
                wheelHolderName: String? = nil, vm: CollabVM, run: CollabRun? = nil,
                skills: [CollabSkillCard] = [], chat: [CollabMessage] = []) {
        self.hostName = hostName; self.startedAt = startedAt; self.participants = participants
        self.wheelHolder = wheelHolder; self.wheelHolderName = wheelHolderName
        self.vm = vm; self.run = run; self.skills = skills; self.chat = chat
    }
}

public struct CollabJoin: Sendable {
    public let participant: CollabParticipant
    public let token: String
}

public enum CollabJoinError: Error, Equatable {
    case badCode, full
}

// MARK: - Rules

/// Pure helpers, so the gating and formatting are testable without a session or a network.
public enum CollabRules {
    /// Unambiguous alphabet: no I/L/O/0/1 to read wrong off a screen.
    public static let codeAlphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    public static let codeLength = 6
    public static let maxParticipants = 8
    public static let chatCap = 300
    public static let messageMax = 2000
    public static let nameMax = 40
    public static let palette = ["44E45E", "7A8CFF", "FFB454", "FF6B8A", "4CC9F0", "B388FF", "1FB57A", "F78DA7"]

    public static func makeCode() -> String {
        String((0..<codeLength).map { _ in codeAlphabet.randomElement()! })
    }

    public static func normalizeCode(_ code: String) -> String {
        code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    public static func color(forIndex index: Int) -> String {
        palette[((index % palette.count) + palette.count) % palette.count]
    }

    public static func displayName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Guest" : String(trimmed.prefix(nameMax))
    }

    /// A message addressed to okidoki ("okidoki, …") is a task, not group chat.
    public static func asksOkidoki(_ text: String) -> Bool {
        text.range(of: #"^\s*okidoki\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    public static func stripAskPrefix(_ text: String) -> String {
        text.replacingOccurrences(of: #"^\s*okidoki[,:]?\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func clampMessage(_ text: String) -> String {
        String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(messageMax))
    }
}

// MARK: - Session

/// One shared session's state: who's in it, the group chat, and who holds the wheel. The host's
/// CollabServer confines every call to the main thread; this class holds no networking of its own.
public final class CollabSession {
    public let code: String
    public let hostName: String
    public let startedAt: Date
    public private(set) var participants: [CollabParticipant] = []
    public private(set) var messages: [CollabMessage] = []
    public private(set) var wheelHolder: String?
    /// The run the session is watching right now, set when someone asks okidoki. Nil when idle.
    public var activeRunID: String?
    /// Called after any change, so the server can broadcast and the dashboard can refresh.
    public var onChange: (() -> Void)?

    private var tokens: [String: String] = [:]

    public init(hostName: String, code: String = CollabRules.makeCode()) {
        self.hostName = hostName
        self.code = CollabRules.normalizeCode(code)
        self.startedAt = Date()
    }

    public var participantCount: Int { participants.count }

    public func join(name: String, code: String) throws -> CollabJoin {
        guard CollabRules.normalizeCode(code) == self.code else { throw CollabJoinError.badCode }
        guard participants.count < CollabRules.maxParticipants else { throw CollabJoinError.full }
        let participant = CollabParticipant(id: UUID().uuidString, name: CollabRules.displayName(name),
                                            colorHex: CollabRules.color(forIndex: participants.count), joinedAt: Date())
        participants.append(participant)
        let token = UUID().uuidString + UUID().uuidString
        tokens[token] = participant.id
        onChange?()
        return CollabJoin(participant: participant, token: token)
    }

    public func participant(forToken token: String) -> CollabParticipant? {
        guard let id = tokens[token] else { return nil }
        return participants.first { $0.id == id }
    }

    public func participant(id: String) -> CollabParticipant? {
        participants.first { $0.id == id }
    }

    public func kick(_ id: String) {
        participants.removeAll { $0.id == id }
        tokens = tokens.filter { $0.value != id }
        if wheelHolder == id { wheelHolder = nil }
        onChange?()
    }

    @discardableResult
    public func say(authorID: String, authorName: String, colorHex: String, text: String, kind: CollabMessageKind) -> CollabMessage {
        let message = CollabMessage(authorID: authorID, authorName: authorName, colorHex: colorHex,
                                    text: CollabRules.clampMessage(text), kind: kind)
        messages.append(message)
        if messages.count > CollabRules.chatCap { messages.removeFirst(messages.count - CollabRules.chatCap) }
        onChange?()
        return message
    }

    public func system(_ text: String) {
        say(authorID: "system", authorName: "okidoki", colorHex: "1FB57A", text: text, kind: .system)
    }

    /// One driver at a time. Returns false when someone already holds it.
    @discardableResult
    public func requestWheel(_ id: String) -> Bool {
        guard wheelHolder == nil, participants.contains(where: { $0.id == id }) else { return false }
        wheelHolder = id
        onChange?()
        return true
    }

    public func releaseWheel(_ id: String) {
        guard wheelHolder == id else { return }
        wheelHolder = nil
        onChange?()
    }

    /// The host always wins the wheel back.
    public func reclaimWheel() {
        guard wheelHolder != nil else { return }
        wheelHolder = nil
        onChange?()
    }

    public func canStop(requestedBy: String?, participantID: String) -> Bool {
        requestedBy == participantID
    }

    public func snapshot(vm: CollabVM, run: CollabRun?, skills: [CollabSkillCard]) -> CollabSnapshot {
        CollabSnapshot(hostName: hostName, startedAt: startedAt, participants: participants,
                       wheelHolder: wheelHolder, wheelHolderName: wheelHolder.flatMap { id in participants.first { $0.id == id }?.name },
                       vm: vm, run: run, skills: skills, chat: messages)
    }
}
