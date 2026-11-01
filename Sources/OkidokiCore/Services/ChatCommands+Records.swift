import Foundation

/// Replaying a skill against records: "file the entry for MTS-4471", "submit MTS-4471 and MTS-4472",
/// "file all pending entries", "replay file ACE entry with hts=8471.30.0100". Each record is one pass,
/// with the skill's `{{placeholders}}` filled from it.
extension ChatCommands {
    private static let recordVerbs = ["file", "submit", "replay", "rerun", "re-run", "run", "do", "process", "enter",
                                      "lodge", "transmit", "prepare", "fill out", "fill in", "fill", "complete", "key in", "book", "clear"]
    /// Verbs that only ever mean "play the skill back"; they never form part of a skill's name.
    private static let playVerbs: Set<String> = ["replay", "rerun", "re-run", "run", "do"]
    private static let allWords = #"\b(all|every|each)\b"#
    private static let recordFiller = #"\b(the|a|an|my|our|this|that|these|those|for|on|against|with|and|of|to|please|now|pending|open|outstanding|remaining|today'?s?|all|every|each)\b"#

    static func recordCommand(_ t: String, raw: String, skills: [Skill], records: [SkillRecord]) -> ChatCommand? {
        guard !skills.isEmpty else { return nil }
        let body = t.replacingOccurrences(of: "^(please |can you |could you |would you |go ahead and |now |okidoki |hey okidoki )+",
                                          with: "", options: .regularExpression)
        guard let verb = recordVerbs.first(where: { body == $0 || body.hasPrefix($0 + " ") }) else { return nil }
        let overrides = ParameterFill.overrides(in: raw)
        // Overrides are typed as key=value; the normalized text has lost the "=", so drop that tail.
        let request = body.range(of: " with ").map { overrides.isEmpty ? body : String(body[..<$0.lowerBound]) } ?? body

        let named = recordsNamed(in: request, records: records)
        var picked = named.map(\.id)
        let wantsAll = picked.isEmpty && !records.isEmpty && request.range(of: allWords, options: .regularExpression) != nil

        let query = skillQuery(request, verb: verb, records: named)
        if wantsAll {
            // "do all my emails" must still reach the brain: "all" only counts when what's left
            // names the kind of thing the records are for ("entries" → "file ACE entry").
            let skillNames = Set(records.map(\.skill).filter { !$0.isEmpty })
            let fits = skillNames.contains { name in
                let wanted = nounTokens(singular(normalize(name)))
                return !wanted.isEmpty && !nounTokens(singular(query)).intersection(wanted).isEmpty
            }
            guard fits else { return nil }
            picked = records.map(\.id)
        }

        if picked.isEmpty {
            // "file the entry for MTS-9999": clearly one of ours, just not a record we have.
            if !records.isEmpty, let token = recordLikeToken(request, records: records) {
                return .unknownRecord(query: token.uppercased())
            }
            guard !overrides.isEmpty, playVerbs.contains(verb) || verb == "replay" else { return nil }
            // "replay x 3 times with city=Lisbon": the count isn't part of the skill's name.
            let (untimed, times) = splitTimes(request)
            guard let skill = bestSkill(skillQuery(untimed, verb: verb, records: []), in: skills, threshold: 0.5) else { return nil }
            return .replayRecords(skillID: skill.id, recordIDs: [], values: overrides, times: times)
        }

        let chosenRecords = picked.compactMap { id in records.first { $0.id == id } }
        let defaultName = chosenRecords.first?.skill ?? ""
        let fallback = defaultName.isEmpty ? nil : bestSkill(normalize(defaultName), in: skills, threshold: 0.75)
        let asked = query.isEmpty ? nil : bestSkill(query, in: skills, threshold: fallback == nil ? 0.5 : 0.8)
        guard let skill = asked ?? fallback else {
            return .noSuchSkill(query: defaultName.isEmpty ? (query.isEmpty ? verb : query) : defaultName)
        }
        return .replayRecords(skillID: skill.id, recordIDs: picked, values: overrides)
    }

    /// Records whose id appears in the text, in the order they appear. "MTS-4471", "mts 4471" and
    /// "mts4471" all count.
    static func recordsNamed(in text: String, records: [SkillRecord]) -> [SkillRecord] {
        var hits: [(Int, SkillRecord)] = []
        for record in records {
            let chunks = normalize(record.id).split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
            guard !chunks.isEmpty else { continue }
            let pattern = "(^|[^a-z0-9])" + chunks.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "[- ]?") + "($|[^a-z0-9])"
            if let range = text.range(of: pattern, options: .regularExpression) {
                hits.append((text.distance(from: text.startIndex, to: range.lowerBound), record))
            }
        }
        return hits.sorted { $0.0 < $1.0 }.map(\.1)
    }

    /// A token shaped like the records' ids ("mts-9999" when records are "MTS-…").
    private static func recordLikeToken(_ text: String, records: [SkillRecord]) -> String? {
        let prefixes = Set(records.compactMap { record -> String? in
            let p = normalize(record.id).prefix(while: { $0.isLetter })
            return p.isEmpty ? nil : String(p)
        })
        guard let range = text.range(of: "\\b[a-z]{2,6}[- ]?[0-9]{2,8}\\b", options: .regularExpression) else { return nil }
        let token = String(text[range])
        let letters = String(token.prefix(while: { $0.isLetter }))
        return prefixes.contains(letters) ? token : nil
    }

    /// What's left of the request once the verb (when it's only a verb), the record ids and the
    /// connecting words are gone: "replay file ace entry for mts-4471" → "file ace entry".
    private static func skillQuery(_ request: String, verb: String, records: [SkillRecord]) -> String {
        var q = request
        if playVerbs.contains(verb) { q = String(q.dropFirst(verb.count)) }
        for record in records {
            let chunks = normalize(record.id).split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
            let pattern = chunks.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "[- ]?")
            q = q.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        q = q.replacingOccurrences(of: recordFiller, with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(skill|shipments?|records?|ones?)\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return singular(q)
    }

    /// A local skill wins over a colleague's copy with the same name.
    private static func bestSkill(_ query: String, in skills: [Skill], threshold: Double) -> Skill? {
        guard !query.isEmpty else { return nil }
        let ranked = skills.map { ($0, score(query, against: singular(normalize($0.name)))) }
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : (!$0.0.source.hasPrefix("shared:") && $1.0.source.hasPrefix("shared:")) }
        guard let top = ranked.first, top.1 >= threshold else { return nil }
        return top.0
    }

    /// Words that say what the thing is, not what to do with it.
    private static func nounTokens(_ s: String) -> Set<String> {
        Set(s.split(separator: " ").map(String.init).filter { $0.count > 1 && !recordVerbs.contains($0) && !["the", "a", "an", "my", "for", "of"].contains($0) })
    }

    /// "entries" → "entry", "forms" → "form"; good enough to line requests up with skill names.
    static func singular(_ s: String) -> String {
        s.split(separator: " ").map { word -> String in
            let w = String(word)
            if w.count > 4, w.hasSuffix("ies") { return String(w.dropLast(3)) + "y" }
            if w.count > 3, w.hasSuffix("s"), !w.hasSuffix("ss") { return String(w.dropLast()) }
            return w
        }.joined(separator: " ")
    }
}
