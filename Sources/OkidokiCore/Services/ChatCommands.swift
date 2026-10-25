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

    // Enterprise — only when the work account is linked and spaces are known.

    /// "ask #sales to …" / "#sales: …" / "… for #sales": hand the agent in a space the request.
    case askSpace(spaceID: String, text: String)
    /// A space was named with "#" but nothing matches.
    case unknownSpace(query: String, text: String)
    /// "what's waiting on me": local runs and colleagues' approvals, with Do it right there.
    case whatsWaiting
    case listSpaces
    /// "open #sales", "show the sales chat".
    case openSpace(spaceID: String)
    /// "share <skill> with my team" (organization-wide, `spaceID` nil) or "… with #sales".
    case shareSkill(skillID: String, spaceID: String?)
    /// A replay that names a colleague's published skill not yet on this Mac: pull it, then replay.
    case replayShared(sharedID: String, times: Int)

    /// "file the entry for MTS-4471": one pass per record, `{{placeholders}}` filled from it; `values`
    /// are key=value overrides typed with the request (and all there is when no record is named).
    case replayRecords(skillID: String, recordIDs: [String], values: [String: String])
    /// A record id in the usual shape that isn't in the records file.
    case unknownRecord(query: String)
    /// "add the CBP 3461 to the vault": fetch the document (a known form, a link, or a web search)
    /// and file it in the organization's vault, or a space's when `space` names one.
    case addToVault(query: String, url: String?, space: String)
}

/// A space, as much of it as the chat needs to route a request.
public struct ChatSpaceRef: Equatable, Sendable {
    public var id: String
    public var name: String
    public var joined: Bool
    public init(id: String, name: String, joined: Bool) { self.id = id; self.name = name; self.joined = joined }
}

/// A colleague's shared skill that isn't on this Mac yet.
public struct ChatSharedSkillRef: Equatable, Sendable {
    public var id: String
    public var name: String
    public var publishedBy: String
    public init(id: String, name: String, publishedBy: String) { self.id = id; self.name = name; self.publishedBy = publishedBy }
}

public enum ChatCommands {
    public struct Context: Sendable {
        public var skills: [Skill]
        public var recording: Bool
        public var replaying: Bool
        /// Whether a skill has been replayed this session, so a bare "again" has something to mean.
        public var hasReplayed: Bool
        /// Enterprise: the work account's spaces (empty on a personal account or an unlinked one).
        public var spaces: [ChatSpaceRef]
        /// Enterprise: colleagues' shared skills that aren't on this Mac yet.
        public var sharedSkills: [ChatSharedSkillRef]
        /// Rows skills can be replayed against (records.json): shipments, invoices, customers.
        public var records: [SkillRecord]
        public init(skills: [Skill], recording: Bool = false, replaying: Bool = false, hasReplayed: Bool = false,
                    spaces: [ChatSpaceRef] = [], sharedSkills: [ChatSharedSkillRef] = [], records: [SkillRecord] = []) {
            self.skills = skills; self.recording = recording; self.replaying = replaying; self.hasReplayed = hasReplayed
            self.spaces = spaces; self.sharedSkills = sharedSkills; self.records = records
        }
    }

    public static func parse(_ text: String, context: Context) -> ChatCommand? {
        let t = normalize(text)
        guard !t.isEmpty else { return nil }

        if context.recording, let command = recordingCommand(t, raw: text) { return command }
        if context.replaying, Self.stopWords.contains(t) || t.hasPrefix("stop replay") || t.hasPrefix("stop the replay") {
            return .stopReplay
        }
        if let command = startRecordingCommand(t) { return command }
        if let command = vaultCommand(t, raw: text) { return command }
        if Self.listPhrases.contains(t) || t.hasPrefix("list my skills") || t.hasPrefix("list skills")
            || t.hasPrefix("what skills") || t.hasPrefix("which skills") || t.hasPrefix("show my skills") || t.hasPrefix("show me my skills") {
            return .listSkills
        }
        if waitingPhrases.contains(t) { return .whatsWaiting }
        if !context.spaces.isEmpty {
            if spacesPhrases.contains(t) { return .listSpaces }
            if let command = shareCommand(t, skills: context.skills, spaces: context.spaces) { return command }
            if let command = openSpaceCommand(t, spaces: context.spaces) { return command }
            if let command = askSpaceCommand(t, raw: text, spaces: context.spaces) { return command }
        }
        if let command = renameCommand(t, skills: context.skills) { return command }
        if let command = deleteCommand(t, skills: context.skills) { return command }
        if let command = recordCommand(t, raw: text, skills: context.skills, records: context.records) { return command }
        return replayCommand(t, skills: context.skills, shared: context.sharedSkills, hasReplayed: context.hasReplayed)
    }

    // MARK: - Enterprise

    private static let waitingPhrases: Set<String> = [
        "what's waiting on me", "whats waiting on me", "what's waiting", "whats waiting", "anything waiting", "anything waiting on me",
        "what needs me", "what needs my okay", "what needs my ok", "what needs approval", "what needs approving", "approvals", "pending approvals",
        "what's pending", "whats pending", "what do i need to approve", "anything to approve", "anything for me", "what needs you",
        "what's on my plate", "whats on my plate", "what needs an okay", "waiting on me",
    ]
    private static let spacesPhrases: Set<String> = [
        "spaces", "my spaces", "list spaces", "list my spaces", "show spaces", "show my spaces", "which spaces", "what spaces",
        "which spaces am i in", "what spaces are there", "my team", "team", "open team", "my team's spaces", "show my team",
    ]
    /// Ways of saying "everyone in the organization" when sharing a skill.
    private static let everyoneWords: Set<String> = ["team", "my team", "the team", "everyone", "everybody", "org", "the org", "organization",
                                                     "the organization", "my organization", "company", "the company", "my company", "all", "whole team", "the whole team"]

    /// "#sales", "sales", "the sales space" against known spaces. Explicit "#" accepts a looser match.
    static func bestSpace(_ query: String, in spaces: [ChatSpaceRef], explicit: Bool) -> ChatSpaceRef? {
        let q = query
            .replacingOccurrences(of: "^#", with: "", options: .regularExpression)
            .replacingOccurrences(of: "^(the |my |our )+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "( space| channel| group| chat)$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return nil }
        let ranked = spaces.map { ($0, score(q, against: $0.name)) }.sorted { $0.1 > $1.1 || ($0.1 == $1.1 && $0.0.joined && !$1.0.joined) }
        guard let top = ranked.first, top.1 >= (explicit ? 0.6 : 0.9) else { return nil }
        return top.0
    }

    /// Which leading words name a space: the cut with the best score wins, a shorter cut on a tie,
    /// so "#sales compress the video" takes "sales" and "#design review rename" takes "design review".
    private static func spaceCut(_ words: [String], spaces: [ChatSpaceRef], explicit: Bool, maxCut: Int = 4) -> (cut: Int, space: ChatSpaceRef)? {
        var best: (cut: Int, space: ChatSpaceRef, score: Double)?
        for cut in 1...max(1, min(words.count - 1, maxCut)) {
            let name = words.prefix(cut).joined(separator: " ")
                .replacingOccurrences(of: "( space| channel| chat)$", with: "", options: .regularExpression)
            guard let space = bestSpace(name, in: spaces, explicit: explicit) else { continue }
            let value = score(normalize(name), against: space.name)
            if best == nil || value > best!.score { best = (cut, space, value) }
        }
        return best.map { ($0.cut, $0.space) }
    }

    private static func askSpaceCommand(_ t: String, raw: String, spaces: [ChatSpaceRef]) -> ChatCommand? {
        // "#sales compress the video" / "#sales: …"
        if t.hasPrefix("#"), t.contains(" ") {
            let words = String(t.dropFirst()).split(separator: " ").map(String.init)
            guard words.count >= 2 else { return nil }
            if let found = spaceCut(words, spaces: spaces, explicit: true) {
                let rest = requestAfter(words.dropFirst(found.cut).joined(separator: " "))
                guard !rest.isEmpty else { return nil }
                return .askSpace(spaceID: found.space.id, text: tail(rest, raw: raw))
            }
            return .unknownSpace(query: words[0], text: requestAfter(words.dropFirst().joined(separator: " ")))
        }
        // "ask #sales to …", "tell sales …", "send to #sales: …", "in #sales …", "have #ops …"
        if let match = t.range(of: "^(ask|tell|send to|send|post in|post to|in|for|have|get|let) (the |my |our )?#?[a-z0-9].* .+$", options: .regularExpression) {
            let explicit = t.contains("#")
            let stripped = String(t[match]).replacingOccurrences(of: "^(ask|tell|send to|send|post in|post to|in|for|have|get|let) (the |my |our )?#?", with: "", options: .regularExpression)
            let words = stripped.split(separator: " ").map(String.init)
            guard words.count >= 2 else { return nil }
            if let found = spaceCut(words, spaces: spaces, explicit: explicit, maxCut: 3) {
                let rest = requestAfter(words.dropFirst(found.cut).joined(separator: " "))
                guard !rest.isEmpty else { return nil }
                return .askSpace(spaceID: found.space.id, text: tail(rest, raw: raw))
            }
            if explicit { return .unknownSpace(query: words[0], text: requestAfter(words.dropFirst().joined(separator: " "))) }
            return nil
        }
        // "compress the video for #sales" / "… in #ops"
        if let hash = t.range(of: " (for|in|to|with) #", options: .regularExpression), t.hasSuffix(String(t[hash.upperBound...])) {
            let request = String(t[..<hash.lowerBound])
            let name = String(t[hash.upperBound...])
            guard !request.isEmpty, !name.isEmpty, !name.contains(" ") || spaces.contains(where: { normalize($0.name) == name }) else { return nil }
            if let space = bestSpace(name, in: spaces, explicit: true) { return .askSpace(spaceID: space.id, text: tail(request, raw: raw)) }
            return .unknownSpace(query: name, text: request)
        }
        return nil
    }

    /// The words after the space's name, minus the glue ("to", "that", a colon) that joined them.
    private static func requestAfter(_ text: String) -> String {
        text.replacingOccurrences(of: "^(space |channel |chat )?(to |that |please )?", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// The request as typed, when it can be found in the raw text; the normalized form otherwise.
    private static func tail(_ normalized: String, raw: String) -> String {
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = cleaned.range(of: normalized, options: [.caseInsensitive]) { return String(cleaned[range]) }
        return normalized
    }

    private static func openSpaceCommand(_ t: String, spaces: [ChatSpaceRef]) -> ChatCommand? {
        guard let match = t.range(of: "^(open|show|go to|show me|take me to) (the |my )?#?(.+?)( space| chat| channel)?$", options: .regularExpression) else { return nil }
        let explicit = t.contains("#") || t.hasSuffix(" space") || t.hasSuffix(" chat") || t.hasSuffix(" channel")
        let name = String(t[match])
            .replacingOccurrences(of: "^(open|show|go to|show me|take me to) (the |my )?#?", with: "", options: .regularExpression)
            .replacingOccurrences(of: "( space| chat| channel)$", with: "", options: .regularExpression)
        guard let space = bestSpace(name, in: spaces, explicit: explicit) else { return nil }
        return .openSpace(spaceID: space.id)
    }

    private static func shareCommand(_ t: String, skills: [Skill], spaces: [ChatSpaceRef]) -> ChatCommand? {
        guard let match = t.range(of: "^(share|publish) (the |my )?(skill )?(.+?)( skill)? (with|to) (.+)$", options: .regularExpression) else { return nil }
        let body = String(t[match]).replacingOccurrences(of: "^(share|publish) (the |my )?(skill )?", with: "", options: .regularExpression)
        guard let split = body.range(of: " (with|to) ", options: .regularExpression) else { return nil }
        let query = String(body[..<split.lowerBound]).replacingOccurrences(of: " skill$", with: "", options: .regularExpression)
        let target = String(body[split.upperBound...]).trimmingCharacters(in: .whitespaces)
        guard let best = bestMatch(query, in: skills), best.score >= 0.6 else { return nil }
        if everyoneWords.contains(target) { return .shareSkill(skillID: best.skill.id, spaceID: nil) }
        guard let space = bestSpace(target, in: spaces, explicit: target.hasPrefix("#") || target.hasSuffix(" space")) else {
            return .unknownSpace(query: target, text: "share \(best.skill.name)")
        }
        return .shareSkill(skillID: best.skill.id, spaceID: space.id)
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

    private static func startRecordingCommand(_ t: String) -> ChatCommand? {
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

    private static func renameCommand(_ t: String, skills: [Skill]) -> ChatCommand? {
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

    private static func replayCommand(_ t: String, skills: [Skill], shared: [ChatSharedSkillRef] = [], hasReplayed: Bool) -> ChatCommand? {
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
        guard !query.isEmpty, !skills.isEmpty || !shared.isEmpty else { return strict ? .noSuchSkill(query: query) : nil }

        let ranked = skills.map { ($0, score(query, against: $0.name)) }.sorted { $0.1 > $1.1 }
        // A colleague's shared skill answers the same words. A local skill wins a tie: it's the
        // one they recorded themselves, and it has pictures.
        let sharedRanked = shared.map { ($0, score(query, against: $0.name)) }.sorted { $0.1 > $1.1 }
        if let best = sharedRanked.first, best.1 > (ranked.first?.1 ?? 0) {
            let accepted: Bool
            if strict { accepted = best.1 >= 0.5 }
            else if verbed { accepted = literal(query, names: best.0.name) }
            else { accepted = normalize(best.0.name) == query }
            if accepted { return .replayShared(sharedID: best.0.id, times: times) }
        }
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
