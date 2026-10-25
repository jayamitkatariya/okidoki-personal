import Foundation

/// "add the CBP 3461 to the vault", "find the USMCA certification of origin and put it in the
/// compliance vault", "save https://…/form.pdf to the vault". Getting a document *into* the vault;
/// "find X in the vault" is a lookup and goes to the brain like any question.
extension ChatCommands {
    private static let vaultSpaceWords: Set<String> = ["the", "our", "my", "org", "orgs", "company", "companys", "team", "teams", "shared",
                                                       "organization", "organizations", "main", "firm", "firms", "office", "doc", "document"]

    static func vaultCommand(_ t: String, raw: String) -> ChatCommand? {
        guard t.range(of: "\\bvault\\b", options: .regularExpression) != nil else { return nil }
        let body = t.replacingOccurrences(of: "^(please |can you |could you |would you |go ahead and |now |okidoki |hey okidoki )+",
                                          with: "", options: .regularExpression)
        // Into the vault, not out of it.
        let adds = body.range(of: "\\b(add|put|save|upload|store|drop|stick|throw|file|download|fetch|grab|pull|get|bring)\\b.*\\b(to|into|in|onto)\\b.*\\bvault\\b",
                              options: .regularExpression) != nil
            || body.range(of: "^vault (it|this|that|the|a|an|cbp|cbsa|form)\\b", options: .regularExpression) != nil
        guard adds else { return nil }
        if body.range(of: "^(find|get|show|open|look|search|where)\\b.*\\b(in|from) (the |our |my )?([a-z0-9#_-]+ )?vault\\b", options: .regularExpression) != nil,
           body.range(of: "\\b(add|put|save|upload|store|drop|stick|throw|download|fetch)\\b", options: .regularExpression) == nil {
            return nil
        }

        let url = raw.range(of: #"https?://[^\s"'<>”]+"#, options: .regularExpression).map { String(raw[$0]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;)")) }

        // Where: "the compliance vault", "#compliance vault", "the vault for #compliance", "the vault in compliance".
        var space = ""
        if let name = capture("\\b(?:to|into|in|onto) (?:the |our |my )?#?([a-z0-9][a-z0-9_-]*(?: [a-z0-9][a-z0-9_-]*)?) vault\\b", in: body) {
            space = name.split(separator: " ").map(String.init).filter { !vaultSpaceWords.contains($0) }.joined(separator: " ")
        }
        if space.isEmpty, let name = capture("\\bvault (?:for|in|under|of) (?:the )?#?([a-z0-9][a-z0-9_-]*)", in: body), !vaultSpaceWords.contains(name) {
            space = name
        }
        if space.isEmpty, let name = capture("#([a-z0-9][a-z0-9_-]*)", in: body) {
            space = name
        }
        space = space.replacingOccurrences(of: "( space| team)$", with: "", options: .regularExpression)

        // What: everything that isn't the verb, the destination or the filler.
        var what = body
        if let url { what = what.replacingOccurrences(of: normalize(url), with: " ") }
        what = what
            .replacingOccurrences(of: "https? ?[a-z0-9./_ -]*\\.pdf", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(to|into|in|onto) (the |our |my )?#?[a-z0-9_ -]*vault\\b.*$", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\bvault\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "#[a-z0-9_-]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(and |then )?(add|put|save|upload|store|drop|stick|throw|file|download|fetch|grab|pull|get|bring|find|search for|search|look up|look for|go get) (it|them|that|this|those|a copy|copies)?\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "^(find|get|grab|fetch|download|pull|search for|search|look up|look for|go get|add|put|save|upload|store|drop|stick|throw|file|bring)\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(from|on|off) (the )?(web|internet|online|cbp|cbp gov|cbsa|their site|the site|its site)\\b|\\bonline\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(the|a|an|our|my|latest|current|newest|official|copy of|a copy of|pdf of|pdf)\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(and|then|for us|for me|please)\\b", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if what.isEmpty, url == nil { return nil }
        return .addToVault(query: what, url: url, space: space)
    }

    /// The first capture group of the first match.
    private static func capture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range])
    }
}
