import Foundation

/// Something typed into the chat that okidoki can do on the spot, without the brain: replay a
/// skill, control a recording, or look after the skill list. Matched before anything is sent
/// anywhere, so these are instant and work without a model key.
public enum ChatCommand: Equatable, Sendable {
    case replay(skillID: String, times: Int)
    /// "again" with no skill named: the last one that was replayed.
    case replayLast(times: Int)
    /// More than one skill fits the name about equally well.
    case ambiguousSkill(query: String, skillIDs: [String])
    /// A replay was clearly asked for, but nothing by that name exists.
    case noSuchSkill(query: String)
    case listSkills
    case startRecording(name: String)
    /// Ends the recording and keeps it. A name given here ("save as …") overrides the one picked up front.
    case saveRecording(name: String)
    case discardRecording
    /// Throws the recording away and starts a fresh one under the same name.
    case restartRecording
    case stopReplay
    case deleteSkill(skillID: String)
    case renameSkill(skillID: String, name: String)
}

public enum ChatCommands {
    public struct Context: Sendable {
        public var skills: [Skill]
        public var recording: Bool
        public var replaying: Bool
        /// Whether a skill has been replayed this session, so a bare "again" has something to mean.
        public var hasReplayed: Bool
        public init(skills: [Skill], recording: Bool = false, replaying: Bool = false, hasReplayed: Bool = false) {
            self.skills = skills; self.recording = recording; self.replaying = replaying; self.hasReplayed = hasReplayed
        }
    }

    public static func parse(_ text: String, context: Context) -> ChatCommand? {
        let t = normalize(text)
        guard !t.isEmpty else { return nil }

        if context.recording, let command = recordingCommand(t, raw: text) { return command }
        if context.replaying, Self.stopWords.contains(t) || t.hasPrefix("stop replay") || t.hasPrefix("stop the replay") {
            return .stopReplay
        }
        if let command = startRecordingCommand(t, raw: text) { return command }
        if Self.listPhrases.contains(t) || t.hasPrefix("list my skills") || t.hasPrefix("list skills")
            || t.hasPrefix("what skills") || t.hasPrefix("which skills") || t.hasPrefix("show my skills") || t.hasPrefix("show me my skills") {
            return .listSkills
        }
        if let command = renameCommand(t, raw: text, skills: context.skills) { return command }
        if let command = deleteCommand(t, skills: context.skills) { return command }
        return replayCommand(t, skills: context.skills, hasReplayed: context.hasReplayed)
    }

    // MARK: - Recording

    private static let stopWords: Set<String> = ["stop", "stop it", "cancel", "esc", "escape", "halt", "enough", "stop now"]
    private static let savePhrases: Set<String> = [
        "stop", "stop recording", "stop the recording", "stop watching", "end recording", "end the recording",
        "save", "save it", "save this", "save recording", "save the recording", "save skill", "save the skill",
        "done", "i'm done", "im done", "all done", "that's it", "thats it", "that's all", "thats all",
        "finish", "finished", "finish recording", "got it", "that's the skill", "ok done", "okay done", "stop and save",
    ]
    private static let discardPhrases: Set<String> = [
        "discard", "discard it", "discard recording", "discard the recording", "cancel", "cancel recording",
        "cancel the recording", "scrap it", "scrap that", "forget it", "forget that", "never mind", "nevermind",
        "throw it away", "don't save", "dont save", "don't save it", "dont save it", "trash it",
    ]
    private static let restartPhrases: Set<String> = [
        "start over", "start again", "redo", "redo it", "restart", "restart recording", "restart the recording",
        "record again", "from the top", "again", "let me redo that", "let me try again", "try again",
    ]

    private static func recordingCommand(_ t: String, raw: String) -> ChatCommand? {
        if restartPhrases.contains(t) { return .restartRecording }
        if discardPhrases.contains(t) { return .discardRecording }
        if savePhrases.contains(t) { return .saveRecording(name: "") }
        for prefix in ["save as ", "save it as ", "save this as ", "call it ", "call this ", "name it ", "name this ", "stop and call it ", "done, call it ", "done call it "] {
            if t.hasPrefix(prefix) {
                let name = cleanName(String(normalize(raw).dropFirst(prefix.count)))
                return .saveRecording(name: name)
            }
        }
        return nil
    }

    private static func startRecordingCommand(_ t: String, raw: String) -> ChatCommand? {
        for prefix in ["watch me do ", "watch me ", "record what i do", "record me ", "record a skill called ", "record a skill named ",
                       "record a new skill called ", "record skill ", "record a skill", "record a new skill", "start recording ", "start recording",
                       "new skill called ", "new skill named ", "teach you to ", "teach you how to ", "learn this: ", "learn how i "] {
            if t == prefix.trimmingCharacters(in: .whitespaces) || t.hasPrefix(prefix) {
                var name = String(t.dropFirst(min(t.count, prefix.count)))
                name = name.replacingOccurrences(of: "^(called|named|:)\\s*", with: "", options: .regularExpression)
                return .startRecording(name: cleanName(name))
            }
        }
        return nil
    }

    // MARK: - Skill list

    private static let listPhrases: Set<String> = [
        "skills", "my skills", "list skills", "list my skills", "show skills", "show my skills", "show me my skills",
        "what skills do i have", "what skills are there", "what can you replay", "what have you learned",
        "what did you learn", "what do you know how to do", "which skills do i have",
    ]

    private static func renameCommand(_ t: String, raw: String, skills: [Skill]) -> ChatCommand? {
        guard let match = t.range(of: "^rename (the |my )?(skill )?(.+?)( skill)? (to|as) (.+)$", options: .regularExpression) else { return nil }
        let parts = String(t[match]).replacingOccurrences(of: "^rename (the |my )?(skill )?", with: "", options: .regularExpression)
        guard let split = parts.range(of: " (to|as) ", options: .regularExpression) else { return nil }
        let query = String(parts[..<split.lowerBound]).replacingOccurrences(of: " skill$", with: "", options: .regularExpression)
        let name = cleanName(String(parts[split.upperBound...]))
        guard !name.isEmpty, let best = bestMatch(query, in: skills), best.score >= 0.6 else { return nil }
        return .renameSkill(skillID: best.skill.id, name: name)
    }

    private static func deleteCommand(_ t: String, skills: [Skill]) -> ChatCommand? {
        guard let match = t.range(of: "^(delete|remove|forget|drop) (the |my )?(skill )?(.+?)( skill)?$", options: .regularExpression) else { return nil }
        let body = String(t[match])
        guard body.contains("skill") || body.hasPrefix("forget ") else { return nil }
        let query = body
            .replacingOccurrences(of: "^(delete|remove|forget|drop) (the |my )?(skill )?", with: "", options: .regularExpression)
            .replacingOccurrences(of: " skill$", with: "", options: .regularExpression)
        guard let best = bestMatch(query, in: skills), best.score >= 0.75 else { return nil }
        return .deleteSkill(skillID: best.skill.id)
    }

    // MARK: - Replay

    /// Verbs that only ever mean "replay the skill": a miss still answers, so the user learns what exists.
    private static let strictVerbs = ["replay", "rerun", "re-run", "repeat", "redo", "play back", "playback"]
    /// Everyday verbs: they only count when a skill clearly matches, otherwise the request goes to the brain.
    private static let looseVerbs = ["run", "play", "do", "perform", "execute", "trigger"]

    /// Ways of saying "the last skill" that name a replay outright.
    private static let replayLastPhrases: Set<String> = ["replay", "replay it", "replay that", "replay again", "replay last", "replay the last one", "replay the last skill"]
    /// Ways that only mean a replay once one has happened; otherwise "again" is just conversation.
    private static let againPhrases: Set<String> = ["again", "do it again", "run it again", "play it again", "one more time", "once more", "same again", "do that again", "run that again", "go again"]

    private static func replayCommand(_ t: String, skills: [Skill], hasReplayed: Bool) -> ChatCommand? {
        let (body, times) = splitTimes(t)
        if replayLastPhrases.contains(body) || (hasReplayed && againPhrases.contains(body)) {
            return .replayLast(times: times)
        }
        var query = body
        var strict = false
        var verbed = false
        for verb in strictVerbs where query == verb || query.hasPrefix(verb + " ") {
            query = String(query.dropFirst(verb.count)).trimmingCharacters(in: .whitespaces)
            strict = true; verbed = true
            break
        }
        if !verbed {
            for verb in looseVerbs where query.hasPrefix(verb + " ") {
                query = String(query.dropFirst(verb.count)).trimmingCharacters(in: .whitespaces)
                verbed = true
                break
            }
        }
        query = query
            .replacingOccurrences(of: "^(the |my |that |this |skill |the skill |my skill )+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "( skill| again| now| please| for me)+$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if strict, query.isEmpty { return .replayLast(times: times) }
        guard !query.isEmpty, !skills.isEmpty else { return strict ? .noSuchSkill(query: query) : nil }

        let ranked = skills.map { ($0, score(query, against: $0.name)) }.sorted { $0.1 > $1.1 }
        guard let top = ranked.first else { return strict ? .noSuchSkill(query: query) : nil }
        // "replay x" accepts a fuzzy hit; "run x" / "do x" must name the skill literally so everyday
        // requests ("do my taxes") still reach the brain; a bare name must be the whole skill name.
        let accepted: Bool
        if strict { accepted = top.1 >= 0.5 }
        else if verbed { accepted = literal(query, names: top.0.name) }
        else { accepted = normalize(top.0.name) == query }
        guard accepted else { return strict ? .noSuchSkill(query: query) : nil }
        let rivals = ranked.dropFirst().prefix(while: { top.1 - $0.1 < 0.08 && $0.1 >= 0.5 })
        if !rivals.isEmpty, top.1 < 0.99 {
            return .ambiguousSkill(query: query, skillIDs: [top.0.id] + rivals.map(\.0.id))
        }
        return .replay(skillID: top.0.id, times: times)
    }

    private static func literal(_ query: String, names name: String) -> Bool {
        let n = normalize(name)
        guard query.count >= 3 else { return n == query }
        return n == query || n.contains(query) || query.contains(n)
    }

    /// "replay x 3 times" → ("replay x", 3). Also "twice", "x3", "3x", "five times".
    static func splitTimes(_ t: String) -> (String, Int) {
        let words: [String: Int] = ["once": 1, "twice": 2, "thrice": 3, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
                                    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "twenty": 20, "fifty": 50, "hundred": 100, "a hundred": 100]
        var body = t
        var times = 1
        if let match = body.range(of: "\\s*(\\d+|[a-z]+|a hundred)\\s*(times|x)$", options: .regularExpression) {
            let piece = String(body[match]).trimmingCharacters(in: .whitespaces)
            let count = piece.replacingOccurrences(of: "\\s*(times|x)$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            if let n = Int(count) ?? words[count] {
                times = n
                body = String(body[..<match.lowerBound])
            }
        } else if let match = body.range(of: "\\s*x\\s*(\\d+)$", options: .regularExpression),
                  let n = Int(String(body[match]).replacingOccurrences(of: "[^0-9]", with: "", options: .regularExpression)) {
            times = n
            body = String(body[..<match.lowerBound])
        } else if body.hasSuffix(" twice") {
            times = 2
            body = String(body.dropLast(6))
        } else if body.hasSuffix(" once") {
            body = String(body.dropLast(5))
        }
        return (body.trimmingCharacters(in: .whitespaces), max(1, min(times, 10_000)))
    }

    // MARK: - Matching

    public static func bestMatch(_ query: String, in skills: [Skill]) -> (skill: Skill, score: Double)? {
        let q = normalize(query)
        guard !q.isEmpty else { return nil }
        return skills.map { ($0, score(q, against: $0.name)) }.max { $0.1 < $1.1 }
    }

    /// 1 for the same name, high for one containing the other, token overlap otherwise.
    static func score(_ query: String, against name: String) -> Double {
        let n = normalize(name)
        guard !n.isEmpty, !query.isEmpty else { return 0 }
        if n == query { return 1 }
        if n.contains(query) || query.contains(n) {
            let overlap = Double(min(n.count, query.count)) / Double(max(n.count, query.count))
            return 0.8 + overlap * 0.15
        }
        let a = Set(tokens(n)), b = Set(tokens(query))
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        let shared = a.intersection(b)
        let jaccard = Double(shared.count) / Double(a.union(b).count)
        // Partial words still count: "fig" for "figma".
        var prefixHits = 0
        for word in b where !shared.contains(word) && word.count >= 3 {
            if a.contains(where: { $0.hasPrefix(word) || word.hasPrefix($0) }) { prefixHits += 1 }
        }
        let partial = Double(shared.count + prefixHits) / Double(max(a.count, b.count))
        return max(jaccard, partial * 0.85)
    }

    private static let filler: Set<String> = ["the", "a", "an", "my", "skill", "flow", "of", "to", "in", "on"]

    private static func tokens(_ s: String) -> [String] {
        s.split(separator: " ").map(String.init).filter { !filler.contains($0) }
    }

    static func normalize(_ s: String) -> String {
        let lowered = s.lowercased()
            .replacingOccurrences(of: "[“”\"'`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[.!?,;:]+$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[^a-z0-9+#&/ -]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return lowered.trimmingCharacters(in: .whitespaces)
    }

    private static func cleanName(_ s: String) -> String {
        String(s.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^[“\"']+|[”\"']+$", with: "", options: .regularExpression)
            .prefix(48))
    }
}
