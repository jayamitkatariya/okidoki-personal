import Foundation

/// Turns what happens in okidoki's browser — the person's clicks and typing while recording, or the
/// agent's actions during a run — into skill steps a replay can find again.
public enum BrowserSteps {
    /// A step from the page script's recorder message, or nil when it isn't one.
    /// Passwords and other secrets are never kept: they become a vault placeholder for the page's site.
    public static func step(from message: [String: Any], delay: Double? = nil) -> SkillStep? {
        guard let action = message["action"] as? String,
              ["click", "type", "select", "press"].contains(action) else { return nil }
        let url = message["url"] as? String ?? ""
        let label = (message["label"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let role = message["role"] as? String
        let selectors = message["selectors"] as? [String] ?? []
        var input: String?
        switch action {
        case "type":
            if message["secret"] as? Bool == true {
                input = vaultPlaceholder(site: host(of: url), field: message["kind"] as? String == "password" ? "password" : "secret")
            } else {
                input = message["text"] as? String ?? ""
            }
        case "select": input = message["value"] as? String
        case "press": input = message["key"] as? String ?? "Enter"
        default: break
        }
        return .browser(action, text: line(action, label: label, input: input), url: url, selectors: selectors,
                        label: label, role: role, input: input, delay: delay)
    }

    /// Opening a page, typed into the address bar or reached by the agent's navigate.
    public static func navigate(_ url: String, delay: Double? = nil) -> SkillStep {
        .browser("navigate", text: "open \(displayURL(url))", url: url, input: url, delay: delay)
    }

    /// How to answer the page's next confirm or prompt: "accept", "dismiss", or "accept:<text>" for a prompt.
    public static func dialog(accept: Bool, text: String?, delay: Double? = nil) -> SkillStep {
        let input = accept ? (text.map { "accept:\($0)" } ?? "accept") : "dismiss"
        let line = accept ? (text.map { "answer the next pop-up with “\($0)”" } ?? "answer the next pop-up with OK") : "answer the next pop-up with Cancel"
        return .browser("dialog", text: line, url: "", input: input, delay: delay)
    }

    /// The answer a `dialog` step's input stands for.
    public static func dialogAnswer(_ input: String?) -> (accept: Bool, text: String?) {
        let raw = input ?? "accept"
        if raw == "dismiss" { return (false, nil) }
        if raw.hasPrefix("accept:") { return (true, String(raw.dropFirst("accept:".count))) }
        return (true, nil)
    }

    /// Filling a saved login. Kept as one step so the replay asks the vault, never the skill file.
    public static func login(site: String, url: String, delay: Double? = nil) -> SkillStep {
        .browser("login", text: "sign in to \(site) with your vault login", url: url,
                 input: vaultPlaceholder(site: site, field: "login"), delay: delay)
    }

    /// The line shown in the dashboard for a browser step.
    public static func line(_ action: String, label: String?, input: String?) -> String {
        let what = label.map { "“\($0)”" } ?? "the field"
        switch action {
        case "click": return "click \(label.map { "“\($0)”" } ?? "it")"
        case "hover": return "point at \(label.map { "“\($0)”" } ?? "it")"
        case "type":
            let text = input ?? ""
            if text.hasPrefix("{{vault:") { return "fill \(what) from your vault" }
            return "type “\(text)” in \(what)"
        case "select": return "choose “\(input ?? "")” in \(what)"
        case "press": return "press \(input == "Enter" ? "return" : (input ?? "return"))"
        default: return action
        }
    }

    /// `{{vault:github.com.password}}`: filled from the vault at replay time, never saved in the skill.
    public static func vaultPlaceholder(site: String, field: String) -> String {
        "{{vault:\(site.isEmpty ? "this site" : site).\(field)}}"
    }

    /// The site and field a vault placeholder names, if `text` is one.
    public static func vaultReference(in text: String) -> (site: String, field: String)? {
        guard text.hasPrefix("{{vault:"), text.hasSuffix("}}") else { return nil }
        let inner = text.dropFirst("{{vault:".count).dropLast(2)
        guard let dot = inner.lastIndex(of: ".") else { return nil }
        return (String(inner[..<dot]), String(inner[inner.index(after: dot)...]))
    }

    /// The same site: equal hosts, or one a subdomain of the other at a dot ("accounts.google.com" and
    /// "google.com"), never a mere suffix ("box.com" isn't "x.com"). Hosts or bare domains both work.
    public static func sameSite(_ a: String, _ b: String) -> Bool {
        let x = bareHost(a), y = bareHost(b)
        guard !x.isEmpty, !y.isEmpty else { return false }
        return x == y || x.hasSuffix("." + y) || y.hasSuffix("." + x)
    }

    /// "https://www.GitHub.com/login" or "github.com" → "github.com".
    public static func bareHost(_ site: String) -> String {
        let trimmed = site.trimmingCharacters(in: .whitespacesAndNewlines)
        return host(of: trimmed.contains("://") ? trimmed : "https://" + trimmed)
    }

    public static func host(of url: String) -> String {
        guard let host = URL(string: url)?.host?.lowercased() else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// "google.com/travel/flights" — the scheme and query left off.
    public static func displayURL(_ url: String) -> String {
        guard let parts = URLComponents(string: url), let host = parts.host else { return url }
        let site = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        let path = parts.path == "/" ? "" : parts.path
        return site + path
    }

    /// What the address bar should load for what was typed: a URL as is, a bare domain with https, else a search.
    public static func addressURL(_ typed: String) -> URL? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let url = URL(string: text), let scheme = url.scheme, ["http", "https", "file", "about"].contains(scheme) { return url }
        if looksLikeAddress(text), let url = URL(string: (text.hasPrefix("localhost") ? "http://" : "https://") + text), url.host != nil { return url }
        return searchURL(text)
    }

    /// A Google search for `text`.
    public static func searchURL(_ text: String) -> URL? {
        var search = URLComponents(string: "https://www.google.com/search")!
        search.queryItems = [URLQueryItem(name: "q", value: text.trimmingCharacters(in: .whitespacesAndNewlines))]
        return search.url
    }

    /// A web address rather than words: "https://…", "github.com/x", "localhost:3000", "10.0.0.1".
    public static func looksLikeAddress(_ typed: String) -> Bool {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return false }
        if let scheme = URL(string: text)?.scheme, ["http", "https", "file", "about"].contains(scheme.lowercased()), text.contains(":") { return true }
        if text.lowercased().hasPrefix("localhost") { return true }
        let host = text.split(separator: "/", maxSplits: 1).first.map(String.init) ?? text
        let bare = host.split(separator: ":").first.map(String.init) ?? host
        let parts = bare.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2, parts.allSatisfy({ !$0.isEmpty }) else { return false }
        // The last part is a real top-level domain (letters, 2+) or this is an IP address.
        let tld = String(parts.last!)
        if parts.count == 4, parts.allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }) { return true }
        return tld.count >= 2 && tld.allSatisfy { $0.isLetter } && URL(string: "https://" + text)?.host != nil
    }

    /// Words that read as something to get done ("book a table for two at 8", "find me cheap flights
    /// to Goa") rather than something to look up ("weather lisbon", "how to tie a tie"). Return in the
    /// address bar hands the first to the agent and searches for the second; both are always offered.
    public static func looksLikeTask(_ typed: String) -> Bool {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty, !looksLikeAddress(text) else { return false }
        let words = text.split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init)
        guard let first = words.first else { return false }
        let opener = ["please ", "can you ", "could you ", "would you ", "i want to ", "i need to ", "i'd like to ", "help me ", "go to ", "okidoki "]
        if opener.contains(where: { text.hasPrefix($0) }) { return true }
        if text.contains(" for me") || text.contains(" and then ") { return true }
        // A question is something to look up, however it's worded.
        let questions = ["how", "what", "why", "when", "where", "who", "which", "is", "are", "does", "do", "can", "should", "will"]
        if questions.contains(first) || text.hasSuffix("?") { return false }
        guard words.count >= 3 else { return false }
        let verbs: Set<String> = [
            "book", "buy", "order", "reserve", "purchase", "shop", "pay", "renew", "cancel", "subscribe", "unsubscribe",
            "find", "compare", "research", "gather", "collect", "extract", "scrape", "list", "summarize", "summarise",
            "fill", "sign", "log", "register", "apply", "submit", "add", "remove", "delete", "update", "change", "set",
            "send", "email", "message", "reply", "post", "tweet", "share", "follow", "like", "comment", "rsvp", "invite",
            "check", "track", "download", "upload", "save", "open", "get", "make", "create", "write", "draft", "plan",
            "schedule", "translate", "watch", "play", "read", "show", "tell", "look", "search", "browse", "go", "navigate",
            "visit", "fetch", "grab", "download", "export", "import", "request", "claim", "redeem", "return", "refund",
        ]
        return verbs.contains(first)
    }
}
