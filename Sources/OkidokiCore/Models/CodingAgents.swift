import Foundation

/// One coding agent okidoki can hand work to: a known CLI (Claude Code, Codex…) or a custom command.
public struct CodingAgentConfig: Identifiable, Codable, Equatable, Sendable {
    /// A preset id ("claude", "codex", "amp", "pi", "opencode", "gemini", "cursor") or a UUID for a custom one.
    public var id: String
    public var name: String
    public var enabled: Bool
    /// Custom agents: the command, with {prompt} and {cwd} where they go. Presets: an optional path to the
    /// binary when it isn't found on its own.
    public var command: String
    /// "workspace" (the agent's safest mode that can still edit the working folder) or "full".
    public var access: String

    public init(id: String, name: String, enabled: Bool = false, command: String = "", access: String = "workspace") {
        self.id = id; self.name = name; self.enabled = enabled; self.command = command; self.access = access
    }

    public var isCustom: Bool { CodingAgentCatalog.preset(id) == nil }

    enum CodingKeys: String, CodingKey { case id, name, enabled, command, access }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)).flatMap { $0 } ?? CodingAgentCatalog.preset(id)?.name ?? id
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)).flatMap { $0 } ?? false
        command = (try? c.decodeIfPresent(String.self, forKey: .command)).flatMap { $0 } ?? ""
        access = (try? c.decodeIfPresent(String.self, forKey: .access)).flatMap { $0 } == "full" ? "full" : "workspace"
    }
}

public struct CodingAgentSettings: Codable, Equatable, Sendable {
    /// Agents the person turned on or added. Presets that were never touched aren't stored.
    public var agents: [CodingAgentConfig] = []
    public var defaultID: String = ""
    /// Where the agent works. Empty means the vault folder.
    public var workingFolder: String = ""
    /// Let okidoki send file, terminal and code jobs to the default agent on its own.
    public var autoRoute: Bool = true
    /// Run enabled agents on okidoki's own harness runtime instead of their CLI.
    public var useEngine: Bool = false

    public init(agents: [CodingAgentConfig] = [], defaultID: String = "", workingFolder: String = "", autoRoute: Bool = true, useEngine: Bool = false) {
        self.agents = agents; self.defaultID = defaultID; self.workingFolder = workingFolder; self.autoRoute = autoRoute; self.useEngine = useEngine
    }

    enum CodingKeys: String, CodingKey { case agents, defaultID, workingFolder, autoRoute, useEngine }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = (try? c.decodeIfPresent([CodingAgentConfig].self, forKey: .agents)).flatMap { $0 } ?? []
        defaultID = (try? c.decodeIfPresent(String.self, forKey: .defaultID)).flatMap { $0 } ?? ""
        workingFolder = (try? c.decodeIfPresent(String.self, forKey: .workingFolder)).flatMap { $0 } ?? ""
        autoRoute = (try? c.decodeIfPresent(Bool.self, forKey: .autoRoute)).flatMap { $0 } ?? true
        useEngine = (try? c.decodeIfPresent(Bool.self, forKey: .useEngine)).flatMap { $0 } ?? false
    }

    public var enabled: [CodingAgentConfig] { agents.filter(\.enabled) }

    /// The agent to use: the one asked for if it's on, else the default, else the first one on.
    public func pick(_ id: String?) -> CodingAgentConfig? {
        let on = enabled
        return on.first { $0.id == id } ?? on.first { $0.id == defaultID } ?? on.first
    }

    /// The working folder, falling back to the vault, then home.
    public func folder(vault: String) -> String {
        let chosen = (workingFolder.isEmpty ? vault : workingFolder) as NSString
        let path = chosen.expandingTildeInPath
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { return path }
        return NSHomeDirectory()
    }
}

/// The coding agents okidoki knows how to run, and which of them are on this Mac.
public enum CodingAgentCatalog {
    public struct Preset: Sendable {
        public var id: String
        public var name: String
        public var binary: String
        public var site: String
        /// Where its non-interactive flags were checked: "help" (its --help on a Mac) or "docs".
        public var verified: String
        /// No permission layer of its own: every job waits for the person's okay.
        public var unguarded: Bool
    }

    public static let presets: [Preset] = [
        Preset(id: "claude", name: "Claude Code", binary: "claude", site: "https://claude.com/claude-code", verified: "help", unguarded: false),
        Preset(id: "codex", name: "Codex", binary: "codex", site: "https://developers.openai.com/codex/cli", verified: "help", unguarded: false),
        Preset(id: "amp", name: "Amp", binary: "amp", site: "https://ampcode.com", verified: "docs", unguarded: false),
        Preset(id: "pi", name: "Pi", binary: "pi", site: "https://pi.dev", verified: "help", unguarded: true),
        Preset(id: "opencode", name: "OpenCode", binary: "opencode", site: "https://opencode.ai", verified: "help", unguarded: false),
        Preset(id: "gemini", name: "Gemini CLI", binary: "gemini", site: "https://github.com/google-gemini/gemini-cli", verified: "docs", unguarded: false),
        Preset(id: "cursor", name: "Cursor Agent", binary: "cursor-agent", site: "https://cursor.com/cli", verified: "help", unguarded: false),
    ]

    public static func preset(_ id: String) -> Preset? { presets.first { $0.id == id } }

    /// Folders searched besides PATH: where installers put these CLIs (~/.local/bin, ~/.bun/bin,
    /// Homebrew, npm's global bin, nvm…).
    public static func searchPaths(home: String = NSHomeDirectory()) -> [String] {
        var paths = ShellRunner.searchPaths
        for extra in ["\(home)/.npm/bin", "\(home)/.amp/bin", "\(home)/.cursor/bin", "/usr/local/lib/node_modules/.bin", "/opt/homebrew/lib/node_modules/.bin"]
        where !paths.contains(extra) {
            paths.append(extra)
        }
        let env = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for entry in env where !paths.contains(entry) { paths.append(entry) }
        return paths
    }

    /// The first executable called `binary` in `paths`.
    public static func locate(_ binary: String, in paths: [String]) -> String? {
        if binary.hasPrefix("/") { return FileManager.default.isExecutableFile(atPath: binary) ? binary : nil }
        for folder in paths {
            let candidate = (folder as NSString).appendingPathComponent(binary)
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    public struct Detected: Codable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var path: String?
        public var verified: String
        public var unguarded: Bool
        public var site: String
    }

    /// Every preset with where it was found, or nil when it isn't installed.
    public static func detect(paths: [String] = searchPaths(), overrides: [String: String] = [:]) -> [Detected] {
        presets.map { preset in
            let override = overrides[preset.id]?.trimmingCharacters(in: .whitespaces) ?? ""
            let path = override.isEmpty ? locate(preset.binary, in: paths) : locate((override as NSString).expandingTildeInPath, in: paths)
            return Detected(id: preset.id, name: preset.name, path: path, verified: preset.verified, unguarded: preset.unguarded, site: preset.site)
        }
    }
}
