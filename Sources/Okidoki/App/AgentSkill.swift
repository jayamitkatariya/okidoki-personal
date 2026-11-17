import Foundation
import OkidokiCore

/// Other agents (Claude Code, Codex, anything that reads skills) reach okidoki through the okidoki skill and
/// the `okidoki` command. This puts both in place the way `scripts/install-cli.sh` does: a two-line launcher
/// at ~/.local/bin/okidoki that runs the bundled CLI with bun, and SKILL.md in each agent's skills folder.
enum AgentSkill {
    struct Status: Encodable {
        var installed: Bool
        var cli: Bool
        var paths: [String]
    }

    enum InstallError: LocalizedError {
        case missing(String)
        var errorDescription: String? {
            switch self { case .missing(let what): return what }
        }
    }

    private static var home: URL { URL(fileURLWithPath: NSHomeDirectory()) }
    static var launcher: URL { home.appendingPathComponent(".local/bin/okidoki") }

    /// Where SKILL.md goes: Claude Code, the shared ~/.agents folder, and Codex when it's installed.
    static var skillFolders: [URL] {
        var folders = [home.appendingPathComponent(".claude/skills/okidoki"),
                       home.appendingPathComponent(".agents/skills/okidoki")]
        let codex = home.appendingPathComponent(".codex")
        if FileManager.default.fileExists(atPath: codex.path) {
            folders.append(codex.appendingPathComponent("skills/okidoki"))
        }
        return folders
    }

    static func status() -> Status {
        let fm = FileManager.default
        let paths = skillFolders.map { $0.appendingPathComponent("SKILL.md").path }.filter { fm.fileExists(atPath: $0) }
        return Status(installed: !paths.isEmpty, cli: fm.isExecutableFile(atPath: launcher.path), paths: paths)
    }

    /// Writes the launcher and copies SKILL.md into every skills folder. Returns the folders it filled.
    @discardableResult
    static func install() throws -> [String] {
        let fm = FileManager.default
        guard let cli = bundled("okidoki.js", dev: "mcp/okidoki.ts") else {
            throw InstallError.missing("the okidoki command isn't in this build — rebuild the app with bun installed")
        }
        guard let skill = bundled("SKILL.md", dev: "mcp/skill/SKILL.md") else {
            throw InstallError.missing("SKILL.md isn't in this build")
        }
        guard let bun = findBun() else {
            throw InstallError.missing("bun isn't installed (https://bun.sh) — okidoki's brain needs it too")
        }

        try fm.createDirectory(at: launcher.deletingLastPathComponent(), withIntermediateDirectories: true)
        let script = "#!/bin/sh\nexec \(quote(bun)) \(quote(cli.path)) \"$@\"\n"
        try script.write(to: launcher, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher.path)

        var filled: [String] = []
        for folder in skillFolders {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent("SKILL.md")
            if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
            try fm.copyItem(at: skill, to: target)
            filled.append(folder.path)
        }
        return filled
    }

    /// Removes the okidoki skill folders. The `okidoki` command stays (scripts may use it).
    static func uninstall() throws {
        let fm = FileManager.default
        for folder in skillFolders where fm.fileExists(atPath: folder.path) {
            try fm.removeItem(at: folder)
        }
    }

    static func findBun() -> String? {
        let candidates = ["\(NSHomeDirectory())/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? ShellRunner.which("bun")
    }

    /// The app's Resources/cli copy; in a debug build run from the repo, the source file.
    private static func bundled(_ name: String, dev: String) -> URL? {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("cli/\(name)"),
           FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        #if DEBUG
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [cwd.appendingPathComponent(dev),
                          home.appendingPathComponent("Desktop/okidoki-personal/\(dev)")]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
        #else
        return nil
        #endif
    }

    private static func quote(_ path: String) -> String {
        "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
