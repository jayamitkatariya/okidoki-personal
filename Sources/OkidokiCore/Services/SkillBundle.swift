import Foundation

/// A skill as a file (`.okiskill`), to share or back up: its steps and the small pictures replay uses
/// to re-find controls. Plain JSON, so it can be read, diffed and edited.
public struct SkillBundle: Codable, Equatable, Sendable {
    public static let format = "okidoki-skill"
    public static let currentVersion = 1
    public static let fileExtension = "okiskill"

    public var format: String
    public var version: Int
    public var name: String
    public var summary: String
    public var steps: [SkillStep]
    /// Step id → PNG, base64. Missing for steps recorded without Screen Recording.
    public var frames: [String: String]
    public var exportedAt: Date

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
        return SkillBundle(format: format, version: currentVersion, name: skill.name, summary: skill.summary,
                           steps: skill.steps, frames: frames, exportedAt: now)
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
        guard !bundle.steps.isEmpty else { throw Failure(reason: "that skill has no steps") }
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
