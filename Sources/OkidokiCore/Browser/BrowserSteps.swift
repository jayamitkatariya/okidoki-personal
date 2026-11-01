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
        if !text.contains(" "), text.contains("."), let url = URL(string: "https://" + text), url.host != nil { return url }
        var search = URLComponents(string: "https://www.google.com/search")!
        search.queryItems = [URLQueryItem(name: "q", value: text)]
        return search.url
    }
}
