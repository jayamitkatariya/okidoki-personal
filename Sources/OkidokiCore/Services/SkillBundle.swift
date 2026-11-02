import Foundation

/// A skill as a file (`.okiskill`), to share or back up: its steps and the small pictures replay uses
/// to re-find controls. Plain JSON, so it can be read, diffed and edited.
public struct SkillBundle: Codable, Equatable, Sendable {
    public static let format = "okidoki-skill"
    /// 2 adds inputs, conditions, loops, checks and templates (all optional). A skill that uses none of
    /// them is still written as 1, so older okidokis keep opening it.
    public static let currentVersion = 2
    public static let fileExtension = "okiskill"

    public var format: String
    public var version: Int
    public var name: String
    public var summary: String
    public var steps: [SkillStep]
    /// Step id → PNG, base64. Missing for steps recorded without Screen Recording.
    public var frames: [String: String]
    public var exportedAt: Date
    /// v2: everything a skill carries beyond its steps (inputs, intent, template outline…). Nil in v1 files.
    public var skill: SkillExtras?

    /// The v2 skill-level fields, kept apart so a v1 file is byte-for-byte what it was.
    public struct SkillExtras: Codable, Equatable, Sendable {
        public var inputs: [SkillInput]?
        public var intent: String?
        public var itemNoun: String?
        public var template: Bool?
        public var alwaysConfirm: Bool?
        public var interrupts: [InterruptHandler]?
        public var outline: [String]?
        public var startURL: String?
        public var startApp: String?
        public var tags: [String]?

        public init(from skill: Skill) {
            inputs = skill.inputs; intent = skill.intent; itemNoun = skill.itemNoun; template = skill.template
            alwaysConfirm = skill.alwaysConfirm; interrupts = skill.interrupts; outline = skill.outline
            startURL = skill.startURL; startApp = skill.startApp; tags = skill.tags
        }

        public var isEmpty: Bool { self == SkillExtras(from: Skill(accountID: "", name: "", summary: "")) }

        /// Copies these onto a skill being installed.
        public func apply(to skill: inout Skill) {
            skill.inputs = inputs; skill.intent = intent; skill.itemNoun = itemNoun; skill.template = template
            skill.alwaysConfirm = alwaysConfirm; skill.interrupts = interrupts; skill.outline = outline
            skill.startURL = startURL; skill.startApp = startApp; skill.tags = tags
        }
    }

    public struct Failure: LocalizedError, Sendable {
        public var reason: String
        public var errorDescription: String? { reason }
    }

    /// Everything a replay on another Mac needs, pictures included.
    public static func make(from skill: Skill, now: Date = Date()) -> SkillBundle {
        var frames: [String: String] = [:]
        for step in skill.steps {
            if let data = try? Data(contentsOf: SkillFrames.url(for: step.id)) { frames[step.id] = data.base64EncodedString() }
        }
        let extras = SkillExtras(from: skill)
        let stepsUseV2 = skill.steps.contains { $0.when != nil || $0.repeatOver != nil || $0.mode != nil || $0.expect != nil
            || $0.anchor != nil || $0.capture != nil || $0.irreversible != nil || $0.observedAfter != nil }
        let v2 = !extras.isEmpty || stepsUseV2
        return SkillBundle(format: format, version: v2 ? currentVersion : 1, name: skill.name, summary: skill.summary,
                           steps: skill.steps, frames: frames, exportedAt: now, skill: v2 && !extras.isEmpty ? extras : nil)
    }

    public func encoded() throws -> Data {
        let encoder = ISODates.encoder
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> SkillBundle {
        guard let bundle = try? ISODates.decoder.decode(SkillBundle.self, from: data), bundle.format == format else {
            throw Failure(reason: "that isn't an okidoki skill file")
        }
        guard bundle.version <= currentVersion else { throw Failure(reason: "that skill was saved by a newer okidoki — update this one first") }
        // A template is an outline the agent follows the first time; it has no recorded steps yet.
        let isTemplate = bundle.skill?.template == true && !(bundle.skill?.outline ?? []).isEmpty
        guard !bundle.steps.isEmpty || isTemplate else { throw Failure(reason: "that skill has no steps") }
        return bundle
    }

    /// The steps with fresh ids (so importing twice never mixes up pictures), each picture written
    /// under its new id. Steps whose picture didn't come along lose their picture box, so replay
    /// doesn't look for one.
    public func installableSteps() -> [SkillStep] {
        steps.map { step in
            var copy = step
            copy.id = UUID().uuidString
            if let encoded = frames[step.id], let data = Data(base64Encoded: encoded) {
                let url = SkillFrames.url(for: copy.id)
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: url, options: .atomic)
            } else {
                copy.frameX = nil; copy.frameY = nil; copy.frameW = nil; copy.frameH = nil
            }
            return copy
        }
    }
}
