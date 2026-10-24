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
        if kind == "apify" { return hasApifyKey ? nil : "Add an Apify key in Keys first." }
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
public final class ConvexSyncService: ObservableObject {
    @Published public private(set) var status: String = "local only"
    @Published public private(set) var isSyncing = false

    /// A push asked for while one is in flight runs once the current one finishes, with the newer state.
    private var pushAgain = false
    /// Hash of the last state that reached Convex, so an unchanged store isn't re-sent.
    private var lastPushedHash: Int?

    public init() {}

    private func endpoint(_ base: String, path: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed + path)
    }

    public func push(store: OkidokiStore) async {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else {
            status = "local only"
            return
        }
        guard let url = endpoint(store.settings.convexSiteURL, path: "/api/sync") else {
            status = "check the convex url"
            return
        }
        guard let secret = KeyStore.get("convex"), !secret.isEmpty else {
            status = "sync secret missing"
            return
        }
        // One push at a time: two overlapping syncs would race to delete each other's rows on the backend.
        if isSyncing {
            pushAgain = true
            return
        }
        isSyncing = true
        status = "syncing…"
        defer {
            isSyncing = false
            if pushAgain {
                pushAgain = false
                Task { await self.push(store: store) }
            }
        }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.sortedKeys]
            // Only the tail of each run's terminal output syncs; the full log stays on this Mac.
            // Keeps the request well under Convex's HTTP body limit as history grows.
            var syncState = store.stateForSync()
            syncState.runs = syncState.runs.map { run in
                var run = run
                run.output = String(run.output.suffix(20_000))
                return run
            }
            // lastSyncAt is written by this very method; counting it would make every push schedule the next.
            var forHash = syncState
            forHash.settings.lastSyncAt = nil
            let hash = try encoder.encode(forHash).hashValue
            if hash == lastPushedHash {
                status = "synced"
                return
            }
            let stateData = try encoder.encode(syncState)
            let stateObject = try JSONSerialization.jsonObject(with: stateData)
            let body: [String: Any] = [
                "accountId": store.currentAccountID,
                "device": Host.current().localizedName ?? "mac",
                "sentAt": Int(Date().timeIntervalSince1970 * 1000),
                "state": stateObject,
            ]
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 120
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                status = "sync failed: no response"
                return
            }
            if http.statusCode == 409 {
                // A newer sync for this account already landed (another Mac, or a faster push). Nothing lost.
                status = "synced elsewhere"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                let text = String(data: data, encoding: .utf8) ?? ""
                status = http.statusCode == 401 ? "sync secret rejected" : "sync failed \(text.prefix(60))"
                return
            }
            lastPushedHash = hash
            store.settings.lastSyncAt = Date()
            store.saveNow()
            status = "synced just now"
        } catch {
            status = "sync failed: \(error.localizedDescription)"
        }
    }

    public func share(run: AgentRun, account: Account, store: OkidokiStore) async -> String? {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else { return nil }
        guard let secret = KeyStore.get("convex"), !secret.isEmpty else { return nil }
        guard let url = endpoint(store.settings.convexSiteURL, path: "/api/share") else { return nil }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let runObject = try JSONSerialization.jsonObject(with: encoder.encode(run))
            let body: [String: Any] = [
                "accountId": account.id,
                "accountName": account.name,
                "runId": run.id,
                "run": runObject,
            ]
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let link = json["url"] as? String else { return nil }
            return link
        } catch {
            return nil
        }
    }

    /// Deletes everything Convex holds for an account the Mac no longer has.
    @discardableResult
    public func purge(accountID: String, store: OkidokiStore) async -> Bool {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else { return false }
        guard let secret = KeyStore.get("convex"), !secret.isEmpty else { return false }
        guard let url = endpoint(store.settings.convexSiteURL, path: "/api/purge") else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["accountId": accountID])
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    public func pull(store: OkidokiStore) async -> AppState? {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else { return nil }
        guard let secret = KeyStore.get("convex"), !secret.isEmpty,
              let url = endpoint(store.settings.convexSiteURL, path: "/api/bootstrap?accountId=\(store.currentAccountID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")") else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            // /api/bootstrap replies {"state": <AppState as JSON string or object>, "updatedAt": ...}
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let state = json["state"] {
                if let string = state as? String, let inner = string.data(using: .utf8) {
                    return try? decoder.decode(AppState.self, from: inner)
                }
                if let object = state as? [String: Any],
                   let inner = try? JSONSerialization.data(withJSONObject: object) {
                    return try? decoder.decode(AppState.self, from: inner)
                }
            }
            return try? decoder.decode(AppState.self, from: data)
        } catch {
            return nil
        }
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
