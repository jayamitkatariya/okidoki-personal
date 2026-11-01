import Foundation

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
            return "\(kind == "mcp" ? "MCP" : "Apify") is off in Settings › Connectors. Turn it on and ask again."
        }
        if kind == "apify" { return hasApifyKey ? nil : "Apify isn't set up in this build." }
        guard let id = call["server"] as? String,
              let server = settings.mcpServers.first(where: { $0.id == id && $0.enabled }) else {
            return "This MCP server is off or was removed. Check Settings › MCP servers and ask again."
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
        // Everything is local (no sync): a state file restored onto a new Mac keeps its routines running.
        for routine in store.activeRoutines where routine.enabled {
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
