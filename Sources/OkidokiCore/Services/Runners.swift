import Foundation

public struct CodingAgentCommand {
    public var agent: CodingAgentID
    public var binaryPath: String
    public var command: String
    public var workingDirectory: String

    public static func build(agent: CodingAgentID, prompt: String, workingDirectory: String,
                             extraArgs: String = "") -> CodingAgentCommand? {
        guard let path = ShellRunner.which(agent.binary) else { return nil }
        var args = agent.defaultArguments
        let quoted = shellQuote(prompt)
        args = args.map { $0 == "{prompt}" ? quoted : $0 }
        if !extraArgs.trimmingCharacters(in: .whitespaces).isEmpty {
            args.append(extraArgs)
        }
        let command = ([path] + args).joined(separator: " ")
        return CodingAgentCommand(agent: agent, binaryPath: path, command: command, workingDirectory: workingDirectory)
    }

    public static func installedAgents() -> [CodingAgentID] {
        CodingAgentID.allCases.filter { ShellRunner.which($0.binary) != nil }
    }
}

public enum PlaceholderFiller {
    public static func fill(_ commands: [String], file: URL?, folder: URL?) -> [String] {
        let fileURL = file
        let outputDir: URL? = {
            if let fileURL { return fileURL.deletingLastPathComponent() }
            if let folder { return folder.deletingLastPathComponent().appendingPathComponent(folder.lastPathComponent + "-out") }
            return nil
        }()
        let base = fileURL?.deletingPathExtension().lastPathComponent ?? "output"
        let filled = commands.map { command in
            var value = command
            for token in ["file", "dir", "outputDir", "basename"] {
                value = value.replacingOccurrences(of: "\"{{\(token)}}\"", with: "{{\(token)}}")
                value = value.replacingOccurrences(of: "'{{\(token)}}'", with: "{{\(token)}}")
            }
            value = value.replacingOccurrences(of: "{{file}}", with: fileURL.map { shellQuote($0.path) } ?? "{{file}}")
            value = value.replacingOccurrences(of: "{{dir}}", with: folder.map { shellQuote($0.path) } ?? (fileURL.map { shellQuote($0.deletingLastPathComponent().path) } ?? "{{dir}}"))
            value = value.replacingOccurrences(of: "{{outputDir}}", with: shellQuote(outputDir?.path ?? NSHomeDirectory()))
            value = value.replacingOccurrences(of: "{{basename}}", with: shellQuote(base))
            return value
        }
        return filled
    }
}

public enum OutputInsights {
    public static func freedBytes(in output: String) -> Int64? {
        // "Freed 23 GB", "23.4GB freed", "recovered 1,204 MB"
        let pattern = #"([0-9]+(?:[.,][0-9]+)?)\s*(GB|GiB|MB|MiB)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(output.startIndex..., in: output)
        var total: Double = 0
        for match in regex.matches(in: output, range: range) {
            guard let numberRange = Range(match.range(at: 1), in: output),
                  let unitRange = Range(match.range(at: 2), in: output),
                  let number = Double(output[numberRange].replacingOccurrences(of: ",", with: ".")) else { continue }
            let unit = output[unitRange].lowercased()
            total += unit.hasPrefix("g") ? number : number / 1024
        }
        guard total > 0 else { return nil }
        return Int64(total * 1_073_741_824)
    }

    /// What a dry run says it could free, read from its last "would free" / "potential" / "total" line.
    /// Unlike `freedBytes` it doesn't add up every size it sees, since previews also list free space and item sizes.
    public static func reclaimableBytes(in output: String) -> Int64? {
        let pattern = #"\b(?:would|could|can|potential|reclaimable|to free|total)\b[^\n]*?([0-9]+(?:[.,][0-9]+)?)\s*(GB|GiB|MB|MiB)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(output.startIndex..., in: output)
        guard let match = regex.matches(in: output, range: range).last,
              let numberRange = Range(match.range(at: 1), in: output),
              let unitRange = Range(match.range(at: 2), in: output),
              let number = Double(output[numberRange].replacingOccurrences(of: ",", with: ".")), number > 0 else { return nil }
        let gigabytes = output[unitRange].lowercased().hasPrefix("g") ? number : number / 1024
        return Int64(gigabytes * 1_073_741_824)
    }

    public static func plainSummary(from output: String, maxLines: Int = 4) -> String {
        let lines = output
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.hasPrefix("===") && !$0.hasPrefix("---") && $0.count < 180 }
        let meaningful = lines.filter { line in
            let lower = line.lowercased()
            return !lower.hasPrefix("warning:") && !lower.contains("deprecat") && !lower.hasPrefix("hint:")
        }
        let tail = meaningful.suffix(maxLines).joined(separator: "\n")
        return tail.isEmpty ? "done." : tail
    }
}

public enum SafetyPolicy {
    /// Switches may have changed since this connector job was planned.
    public static func connectorUnavailable(callJSON: String, connectors: [Connector], settings: AppSettings,
                                            hasApifyKey: Bool) -> String? {
        guard let data = callJSON.data(using: .utf8),
              let call = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = call["connector"] as? String, ["apify", "mcp"].contains(kind) else {
            return "This connector plan is invalid. Ask again to prepare a new one."
        }
        guard connectors.contains(where: { $0.id == kind && $0.enabled }) else {
            return "\(kind == "mcp" ? "MCP" : "Apify") is off in Toolbox. Turn it on and ask again."
        }
        if kind == "apify" { return hasApifyKey ? nil : "Apify isn't set up in this build." }
        guard let id = call["server"] as? String,
              let server = settings.mcpServers.first(where: { $0.id == id && $0.enabled }) else {
            return "This MCP server is off or was removed. Check Toolbox and ask again."
        }
        return blocked(commands: [server.name, server.command], settings: settings)
    }

    public static func blocked(commands: [String], settings: AppSettings) -> String? {
        for command in commands {
            if CommandRisk.isBlocked(command) { return "that command could destroy your Mac. i won't run it." }
            for blocked in settings.blockedApps where mentions(command, blocked) {
                return "\(blocked) is on your blocked list."
            }
        }
        return nil
    }

    /// The first "always ask" entry named in the run's commands, apps or target, if any.
    public static func mustAsk(_ items: [String], settings: AppSettings) -> String? {
        settings.alwaysAsk.first { entry in items.contains { mentions($0, entry) } }
    }

    /// True when every command starts with an "always allow" prefix, so the run can start without a card.
    /// High-risk plans, chained or redirected commands, installs, deletes and anything on the always-ask list still ask.
    public static func preApproved(commands: [String], risk: RiskLevel, settings: AppSettings) -> Bool {
        guard !commands.isEmpty, risk != .high, mustAsk(commands, settings: settings) == nil else { return false }
        let chaining = #"[;&|`<>\n]|\$\("#
        return commands.allSatisfy { command in
            let command = command.trimmingCharacters(in: .whitespaces)
            guard command.range(of: chaining, options: .regularExpression) == nil,
                  CommandRisk.classify(command) != .high, !alwaysNeedsApproval(command) else { return false }
            return settings.alwaysAllow.contains { entry in
                let entry = entry.trimmingCharacters(in: .whitespaces)
                return !entry.isEmpty && (command == entry || command.hasPrefix(entry + " "))
            }
        }
    }

    /// Installs and deletes ask every time, whatever "always allow" says, and are never remembered.
    public static func alwaysNeedsApproval(_ command: String) -> Bool {
        let installs = [
            #"\bbrew\s+(install|reinstall|upgrade|tap)\b"#, #"Homebrew/install"#,
            #"\bnpm\s+(install|i)\b"#, #"\b(pip|pip3|pipx)\s+install\b"#, #"\buv\s+(tool\s+|pip\s+)?install\b"#,
            #"\b(gem|cargo|go)\s+install\b"#, #"\bmas\s+(install|purchase|upgrade)\b"#,
            #"\b(bash|sh|zsh)\s+\S+\.sh\b"#, #"\binstaller\s+-pkg\b"#,
        ]
        let deletes = [
            #"\brm\b"#, #"\brmdir\b"#, #"\bshred\b"#, #"\s-delete\b"#, #"\s--delete"#, #"\s-overwrite_original"#,
            #"\bbrew\s+(uninstall|remove|rm|cleanup|autoremove)\b"#, #"\bmas\s+uninstall\b"#,
            #"\brestic\s+(forget|prune)\b"#, #"\brclone\s+(sync|delete|deletefile|purge|rmdir|rmdirs|move)\b"#,
            #"\bgit\s+(clean|reset\s+--hard)\b"#,
        ]
        let matches = { (pattern: String) in command.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        if (installs + deletes).contains(where: matches) { return true }
        // Mole's and topgrade's dry runs only look; the real clean or update removes or installs things.
        let previewOnly = matches(#"\s(--dry-run|-n)(\s|$)"#)
        return !previewOnly && (matches(#"\b(mo|mole)\s+(clean|purge|uninstall|remove|optimize)\b"#) || matches(#"\btopgrade\b"#))
    }

    /// What "always allow" remembers for a command: its program and first argument, e.g. "mo clean".
    /// A dry-run flag right after them is kept, so allowing "mo clean --dry-run" never allows the real clean.
    public static func allowPrefix(_ command: String) -> String {
        let words = command.split(separator: " ")
        let keep = words.count > 2 && ["--dry-run", "-n"].contains(words[2]) ? 3 : 2
        return words.prefix(keep).joined(separator: " ")
    }

    /// True when `term` appears in `command` as a whole word, so blocking "mo" (Mole) doesn't block "remove".
    static func mentions(_ command: String, _ term: String) -> Bool {
        let term = term.trimmingCharacters(in: .whitespaces)
        guard !term.isEmpty else { return false }
        let pattern = "(?<![A-Za-z0-9_-])" + NSRegularExpression.escapedPattern(for: term) + "(?![A-Za-z0-9_-])"
        return command.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}

@MainActor
public final class RoutineScheduler {
    public var onDue: ((Routine) -> Void)?
    private var timer: Timer?
    private var fired: Set<String> = []
    private weak var store: OkidokiStore?

    public init(store: OkidokiStore) { self.store = store }

    public func start() {
        timer?.invalidate()
        let timer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    public func stop() { timer?.invalidate(); timer = nil }

    private func tick() {
        guard let store else { return }
        let now = Date()
        // A routine synced from another Mac runs there, not here as well.
        for routine in store.activeRoutines where routine.enabled && store.isFromThisMac(routine) {
            guard let next = routine.nextRunAt else { continue }
            let key = routine.id + "-" + String(Int(next.timeIntervalSince1970 / 60))
            if next <= now, !fired.contains(key) {
                fired.insert(key)
                store.markRoutineRun(routine.id, at: now)
                onDue?(routine)
            }
        }
        if fired.count > 200 { fired.removeAll() }
    }
}
