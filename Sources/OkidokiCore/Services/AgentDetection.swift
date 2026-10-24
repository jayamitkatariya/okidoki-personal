import Foundation
import SQLite3

/// Where a coding agent stands on this Mac: on the PATH, and signed in to something that can answer.
public struct AgentStatus: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var installed: Bool
    public var signedIn: Bool
    /// Who the CLI is signed in as, when it writes that down (an email, mostly). Never a token.
    public var account: String
    /// Providers the CLI holds credentials for, e.g. ["anthropic", "openrouter"]. Empty for a single-vendor CLI.
    public var providers: [String]
    /// Where okidoki looked, shown as a hint: "~/.claude/.credentials.json".
    public var source: String
    public var installHint: String
    public var loginHint: String

    public var ready: Bool { installed && signedIn }
}

/// Reads each CLI's own login files to tell whether it can answer without a prompt.
/// Only the shape of those files is inspected: an email, a provider name, whether a token exists.
/// Secrets are never copied anywhere, and the Keychain is never opened.
public enum AgentDetection {
    public struct Probe: Equatable, Sendable {
        public var signedIn: Bool
        public var account: String
        public var providers: [String]
        public var source: String

        public static let none = Probe(signedIn: false, account: "", providers: [], source: "")
    }

    public static func detect(home: String = NSHomeDirectory(),
                              installed: (CodingAgentID) -> Bool = { ShellRunner.which($0.binary) != nil }) -> [AgentStatus] {
        CodingAgentID.allCases.map { agent in
            let probe = self.probe(agent, home: home)
            return AgentStatus(id: agent.rawValue, name: agent.displayName, installed: installed(agent),
                               signedIn: probe.signedIn, account: probe.account, providers: probe.providers,
                               source: probe.source, installHint: agent.installHint, loginHint: agent.loginHint)
        }
    }

    public static func probe(_ agent: CodingAgentID, home: String) -> Probe {
        switch agent {
        case .claude: return claude(home: home)
        case .opencode: return opencode(home: home)
        case .omp: return omp(home: home)
        case .hermes: return hermes(home: home)
        case .codex: return codex(home: home)
        case .gemini: return gemini(home: home)
        case .cursor: return cursor(home: home)
        }
    }

    // MARK: - Per-agent probes

    /// `claude login` writes an OAuth token to ~/.claude/.credentials.json (or the Keychain, which
    /// okidoki doesn't read) and the account's email to ~/.claude.json either way.
    static func claude(home: String) -> Probe {
        let credentials = json(home, ".claude/.credentials.json")
        let oauth = credentials?["claudeAiOauth"] as? [String: Any]
        let hasToken = !(oauth?["accessToken"] as? String ?? "").isEmpty
        let account = (json(home, ".claude.json")?["oauthAccount"] as? [String: Any])?["emailAddress"] as? String ?? ""
        guard hasToken || !account.isEmpty else { return .none }
        return Probe(signedIn: true, account: account, providers: ["anthropic"],
                     source: hasToken ? "~/.claude/.credentials.json" : "~/.claude.json")
    }

    /// `opencode auth login` keeps one entry per provider in auth.json under the XDG data dir.
    static func opencode(home: String) -> Probe {
        let candidates = [
            (xdgDataHome(home: home) + "/opencode/auth.json", "~/.local/share/opencode/auth.json"),
            (home + "/.config/opencode/auth.json", "~/.config/opencode/auth.json"),
        ]
        for (path, label) in candidates {
            guard let entries = json(path: path) else { continue }
            let providers = entries.keys.filter { key in
                guard let entry = entries[key] as? [String: Any] else { return false }
                return !(entry["key"] as? String ?? "").isEmpty || !(entry["refresh"] as? String ?? "").isEmpty
                    || !(entry["access"] as? String ?? "").isEmpty
            }.sorted()
            if !providers.isEmpty { return Probe(signedIn: true, account: "", providers: providers, source: label) }
        }
        return .none
    }

    /// omp keeps credentials in a SQLite vault at ~/.omp/agent/agent.db. Only the provider column is read.
    static func omp(home: String) -> Probe {
        let path = home + "/.omp/agent/agent.db"
        guard FileManager.default.fileExists(atPath: path) else { return .none }
        let providers = sqliteStrings(path: path,
                                      query: "SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY provider")
        guard !providers.isEmpty else { return .none }
        return Probe(signedIn: true, account: "", providers: providers, source: "~/.omp/agent/agent.db")
    }

    /// Hermes pools credentials per provider in ~/.hermes/auth.json and also honors *_API_KEY lines in ~/.hermes/.env.
    static func hermes(home: String) -> Probe {
        var providers: [String] = []
        if let auth = json(home, ".hermes/auth.json"), let pool = auth["credential_pool"] as? [String: Any] {
            providers += pool.compactMap { key, value in (value as? [Any])?.isEmpty == false ? key : nil }
        }
        providers += envKeyProviders(path: home + "/.hermes/.env")
        providers = Array(Set(providers)).sorted()
        guard !providers.isEmpty else { return .none }
        return Probe(signedIn: true, account: "", providers: providers, source: "~/.hermes/auth.json")
    }

    /// `codex login` stores ChatGPT tokens (or an API key) in ~/.codex/auth.json. The email lives inside the id token.
    static func codex(home: String) -> Probe {
        guard let auth = json(home, ".codex/auth.json") else { return .none }
        let tokens = auth["tokens"] as? [String: Any]
        let hasToken = !(tokens?["access_token"] as? String ?? "").isEmpty
        let hasKey = !(auth["OPENAI_API_KEY"] as? String ?? "").isEmpty
        guard hasToken || hasKey else { return .none }
        let account = jwtClaim(tokens?["id_token"] as? String, "email") ?? ""
        return Probe(signedIn: true, account: account, providers: ["openai"], source: "~/.codex/auth.json")
    }

    /// Gemini CLI signs in with Google (oauth_creds.json, google_accounts.json) or a GEMINI_API_KEY in ~/.gemini/.env.
    static func gemini(home: String) -> Probe {
        let creds = json(home, ".gemini/oauth_creds.json")
        let hasToken = !(creds?["access_token"] as? String ?? "").isEmpty || !(creds?["refresh_token"] as? String ?? "").isEmpty
        let account = json(home, ".gemini/google_accounts.json")?["active"] as? String ?? ""
        let hasKey = envKeyProviders(path: home + "/.gemini/.env").contains("gemini")
        guard hasToken || !account.isEmpty || hasKey else { return .none }
        return Probe(signedIn: true, account: account, providers: ["google"],
                     source: hasToken || !account.isEmpty ? "~/.gemini/oauth_creds.json" : "~/.gemini/.env")
    }

    /// `cursor-agent login` records who you are in ~/.cursor/cli-config.json under authInfo.
    static func cursor(home: String) -> Probe {
        guard let info = json(home, ".cursor/cli-config.json")?["authInfo"] as? [String: Any] else { return .none }
        let email = info["email"] as? String ?? ""
        let userID = info["userId"] as? String ?? ""
        guard !email.isEmpty || !userID.isEmpty else { return .none }
        return Probe(signedIn: true, account: email, providers: ["cursor"], source: "~/.cursor/cli-config.json")
    }

    // MARK: - Helpers

    static func xdgDataHome(home: String) -> String {
        let xdg = ProcessInfo.processInfo.environment["XDG_DATA_HOME"] ?? ""
        return xdg.isEmpty ? home + "/.local/share" : xdg
    }

    static func json(_ home: String, _ relative: String) -> [String: Any]? {
        json(path: (home as NSString).appendingPathComponent(relative))
    }

    static func json(path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path), data.count < 4_000_000 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Provider names from `FOO_API_KEY=value` lines in a dotenv file: "openrouter", "gemini". Values are discarded.
    static func envKeyProviders(path: String) -> [String] {
        guard let data = FileManager.default.contents(atPath: path), data.count < 1_000_000,
              let text = String(data: data, encoding: .utf8) else { return [] }
        var providers: [String] = []
        for rawLine in text.split(separator: "\n") {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard !line.hasPrefix("#"), let equals = line.firstIndex(of: "=") else { continue }
            let name = line[..<equals].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: equals)...].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            guard name.hasSuffix("_API_KEY"), !value.isEmpty else { continue }
            providers.append(String(name.dropLast("_API_KEY".count)).lowercased().replacingOccurrences(of: "_", with: "-"))
        }
        return providers
    }

    /// One claim out of a JWT's payload, without verifying it: enough to show an email, never used for auth.
    static func jwtClaim(_ token: String?, _ claim: String) -> String? {
        guard let token, token.split(separator: ".").count >= 2 else { return nil }
        var payload = String(token.split(separator: ".")[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if let value = object[claim] as? String { return value }
        // Codex nests profile claims under its own namespace.
        for (_, nested) in object {
            if let dict = nested as? [String: Any], let value = dict[claim] as? String { return value }
        }
        return nil
    }

    /// First column of each row, from a read-only open so a live agent's writes are never blocked.
    static func sqliteStrings(path: String, query: String) -> [String] {
        var db: OpaquePointer?
        // SQLite allocates the handle even when open fails, and it still has to be closed.
        let opened = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil)
        defer { if let db { sqlite3_close(db) } }
        guard opened == SQLITE_OK, let db else { return [] }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK, let statement else { return [] }
        defer { sqlite3_finalize(statement) }
        var values: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) { values.append(String(cString: text)) }
        }
        return values
    }
}
