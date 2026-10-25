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

/// Two-way sync with the Convex backend, one account at a time: pull what other Macs changed since this
/// Mac last merged, merge it into the store, then push this Mac's copy on top of that exact version.
/// If another Mac synced in between, the push is refused and the round starts over, so a push never
/// deletes what this Mac hasn't seen. Against a backend without versions it falls back to a plain push.
@MainActor
public final class ConvexSyncService: ObservableObject {
    @Published public private(set) var status: String = "local only"
    @Published public private(set) var isSyncing = false
    /// What the last finished sync did.
    @Published public private(set) var lastReport: SyncReport?

    public struct SyncReport: Equatable, Sendable {
        /// Changes brought in from other Macs, all accounts together.
        public var merged = MergeSummary()
        /// Accounts pushed, and accounts with nothing new to push.
        public var pushed: [String] = []
        public var skipped: [String] = []
        /// Pushes refused because another Mac synced first (each was retried after a fresh pull).
        public var conflicts = 0
        /// Pulled items this build couldn't read (from a newer build, say); left on Convex untouched.
        public var unreadable = 0
        /// The backend has no versions yet, so this was a one-way push.
        public var legacy = false
        /// Accounts another sync login owns; this Mac's pairing can't touch them.
        public var foreign: [String] = []
    }

    enum SyncFailure: Error {
        case unauthorized
        case tooLarge
        case http(Int, String)
        case keptLosing
        /// The account belongs to another sync login than the one this Mac is paired with.
        case forbidden
    }

    /// The newest runs and threads that go up with each push; older ones stay on Convex as they are.
    public static let maxRuns = 1_000
    public static let maxThreads = 300
    static let maxAttempts = 4

    /// A sync asked for while one is in flight runs once the current one finishes, with the newer state.
    private var syncAgain = false
    /// Per account, a hash of the last state that reached Convex, so an unchanged account isn't re-sent.
    private var lastPushedHash: [String: Int] = [:]
    private let session: URLSession
    /// The token this Mac got when it paired with the sync login. Nothing syncs without one.
    private let secret: () -> String?
    private let device: String

    public init(session: URLSession = .shared,
                secret: @escaping () -> String? = { KeyStore.deviceToken },
                device: String = Host.current().localizedName ?? "mac") {
        self.session = session
        self.secret = secret
        self.device = device
    }

    private func endpoint(_ base: String, path: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed + path)
    }

    private func request(_ url: URL, secret: String, method: String = "GET", json: Any? = nil, timeout: TimeInterval = 60) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Int, Data) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SyncFailure.http(0, "no response") }
        if http.statusCode == 401 { throw SyncFailure.unauthorized }
        if http.statusCode == 403 { throw SyncFailure.forbidden }
        if http.statusCode == 413 { throw SyncFailure.tooLarge }
        return (http.statusCode, data)
    }

    /// Kept for callers from before sync went both ways.
    public func push(store: OkidokiStore) async { await sync(store: store) }

    /// The Mac was unpaired: nothing pushed from here counts any more.
    public func forgetPairing() {
        status = "local only"
        lastPushedHash = [:]
    }

    /// Pulls, merges and pushes every account on this Mac, the one in front first.
    public func sync(store: OkidokiStore) async {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else {
            status = "local only"
            return
        }
        let base = store.settings.convexSiteURL
        guard endpoint(base, path: "/api/sync") != nil else {
            status = "check the convex url"
            return
        }
        guard let secret = secret(), !secret.isEmpty else {
            status = "sign in to sync in the control panel to pair this Mac"
            return
        }
        // One sync at a time: two overlapping rounds would each push on top of a version the other replaces.
        if isSyncing {
            syncAgain = true
            return
        }
        isSyncing = true
        status = "syncing…"
        defer {
            isSyncing = false
            if syncAgain {
                syncAgain = false
                Task { await self.sync(store: store) }
            }
        }
        var report = SyncReport()
        do {
            let ids = [store.currentAccountID] + store.accounts.map(\.id).filter { $0 != store.currentAccountID }
            for id in ids where store.accounts.contains(where: { $0.id == id }) {
                do {
                    try await syncAccount(id, store: store, base: base, secret: secret, report: &report)
                } catch SyncFailure.forbidden {
                    // Another login's account on this Mac: left alone, the rest still sync.
                    report.foreign.append(id)
                }
            }
            store.noteSynced()
            lastReport = report
            let brought = report.merged.changes
            let foreign = report.foreign.isEmpty ? "" : " · \(report.foreign.count) account\(report.foreign.count == 1 ? "" : "s") signed in elsewhere"
            status = (report.legacy ? "synced (one way: update the backend for two-way sync)"
                : brought > 0 ? "synced · brought in \(brought) change\(brought == 1 ? "" : "s") from your other Macs"
                : "synced just now") + foreign
        } catch SyncFailure.unauthorized {
            status = "this Mac's pairing was revoked; sign in to sync again"
        } catch SyncFailure.tooLarge {
            status = "sync failed: too much to send at once"
        } catch SyncFailure.keptLosing {
            status = "another Mac keeps syncing; will try again"
        } catch SyncFailure.http(let code, let text) {
            status = "sync failed \(code) \(text.prefix(60))"
        } catch {
            status = "sync failed: \(error.localizedDescription)"
        }
        // Whatever finished (cursors, merged items) is worth keeping even when a later account failed.
        store.saveNow()
    }

    private func syncAccount(_ id: String, store: OkidokiStore, base: String, secret: String, report: inout SyncReport) async throws {
        for _ in 0..<Self.maxAttempts {
            guard let remote = try await remoteVersion(id, base: base, secret: secret) else {
                report.legacy = true
                try await legacyPush(id, store: store, base: base, secret: secret, report: &report)
                return
            }
            // A deployment that was reset (or a purged account) is behind this Mac: start over from nothing.
            var cursor = store.syncCursors[id] ?? 0
            if remote < cursor { cursor = 0 }
            let before = try payload(for: id, store: store)
            let hadLocalChanges = before.hash != lastPushedHash[id]
            if remote != cursor {
                let (changes, unreadable) = try await pull(id, since: cursor, base: base, secret: secret)
                report.unreadable += unreadable.count
                report.merged += store.mergePulled(changes)
                store.keepUnreadable(unreadable)
                store.syncCursors[id] = remote
            }
            let state = try payload(for: id, store: store)
            // Nothing new here: after merging, this Mac matches Convex, so there's nothing to push.
            if !hadLocalChanges, store.syncCursors[id] == remote {
                lastPushedHash[id] = state.hash
                report.skipped.append(id)
                return
            }
            var body = state.body
            body["baseVersion"] = remote
            let url = endpoint(base, path: "/api/sync")!
            let (code, data) = try await send(try request(url, secret: secret, method: "POST", json: body, timeout: 120))
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            if code == 409 {
                // Another Mac got in first: pull what it wrote and go again.
                report.conflicts += 1
                continue
            }
            guard (200..<300).contains(code) else { throw SyncFailure.http(code, String(data: data, encoding: .utf8) ?? "") }
            if let version = json["version"] as? Int { store.syncCursors[id] = version }
            lastPushedHash[id] = state.hash
            report.pushed.append(id)
            return
        }
        throw SyncFailure.keptLosing
    }

    /// The account's version on Convex, or nil when the backend predates versions.
    private func remoteVersion(_ id: String, base: String, secret: String) async throws -> Int? {
        guard let url = endpoint(base, path: "/api/version?accountId=\(id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id)") else {
            throw SyncFailure.http(0, "bad url")
        }
        let (code, data) = try await send(try request(url, secret: secret))
        if code == 404 { return nil }
        guard (200..<300).contains(code),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? Int else { throw SyncFailure.http(code, String(data: data, encoding: .utf8) ?? "") }
        return version
    }

    /// Everything that changed for an account since a version, table by table, page by page.
    private func pull(_ id: String, since: Int, base: String, secret: String) async throws -> (PulledChanges, [UnreadableItem]) {
        var changes = PulledChanges()
        var unreadable: [UnreadableItem] = []
        let decoder = SyncDates.decoder
        func page<T: Decodable>(_ table: String, as type: T.Type) async throws -> [T] {
            var items: [T] = []
            var cursor: String?
            for _ in 0..<10_000 {
                var body: [String: Any] = ["accountId": id, "table": table, "since": since]
                if let cursor { body["cursor"] = cursor }
                let url = endpoint(base, path: "/api/pull")!
                let (code, data) = try await send(try request(url, secret: secret, method: "POST", json: body))
                guard (200..<300).contains(code), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw SyncFailure.http(code, String(data: data, encoding: .utf8) ?? "")
                }
                for raw in json["items"] as? [Any] ?? [] {
                    guard let itemData = try? JSONSerialization.data(withJSONObject: raw) else { continue }
                    if let item = try? decoder.decode(T.self, from: itemData) {
                        items.append(item)
                    } else if table != "deletions", let object = raw as? [String: Any], let itemID = object["id"] as? String {
                        // One item this build can't read must not stop the rest, and must not be lost either.
                        unreadable.append(UnreadableItem(table: table, id: itemID, accountID: object["accountID"] as? String ?? id,
                                                         json: String(data: itemData, encoding: .utf8) ?? "{}"))
                    }
                }
                if json["isDone"] as? Bool != false { break }
                cursor = json["cursor"] as? String
            }
            return items
        }
        changes.threads = try await page("threads", as: ChatThread.self)
        changes.memories = try await page("memories", as: MemoryItem.self)
        changes.runs = try await page("runs", as: AgentRun.self)
        changes.skills = try await page("skills", as: Skill.self)
        changes.routines = try await page("routines", as: Routine.self)
        changes.deletions = try await page("deletions", as: PulledChanges.Deletion.self)
        return (changes, unreadable)
    }

    /// The push body for one account, and a hash of it without the bits that change on every push.
    private func payload(for id: String, store: OkidokiStore) throws -> (body: [String: Any], hash: Int) {
        var state = store.stateForSync(accountID: id)
        // Only the tail of each run's terminal output syncs; the full log stays on this Mac.
        let runs = state.runs.sorted { $0.createdAt > $1.createdAt }
        state.runs = runs.prefix(Self.maxRuns).map { run in
            var run = run
            run.output = String(run.output.suffix(20_000))
            return run
        }
        let threads = state.threads.sorted { $0.updatedAt > $1.updatedAt }
        state.threads = Array(threads.prefix(Self.maxThreads))
        // lastSyncAt is written by every sync; counting it would make every push schedule the next.
        state.settings.lastSyncAt = nil
        let encoder = SyncDates.encoder
        var object = try jsonObject(encoder.encode(state))
        // Items this build couldn't read go back exactly as they came, so the push doesn't delete them.
        for item in store.unreadable where item.accountID == id {
            guard let raw = try? JSONSerialization.jsonObject(with: Data(item.json.utf8)) else { continue }
            var list = object[item.table] as? [Any] ?? []
            if !list.contains(where: { ($0 as? [String: Any])?["id"] as? String == item.id }) { list.append(raw) }
            object[item.table] = list
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        var floors: [String: String] = [:]
        if runs.count > Self.maxRuns, let oldest = state.runs.last { floors["runs"] = SyncDates.string(from: oldest.createdAt) }
        if threads.count > Self.maxThreads, let oldest = state.threads.last { floors["threads"] = SyncDates.string(from: oldest.updatedAt) }
        let body: [String: Any] = [
            "accountId": id,
            "device": device,
            "sentAt": Int(Date().timeIntervalSince1970 * 1000),
            "state": object,
            "floors": floors,
        ]
        return (body, data.hashValue)
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SyncFailure.http(0, "state didn't encode") }
        return object
    }

    /// A backend without versions: push as before. A refusal means a newer push from another Mac landed;
    /// it isn't forced through.
    private func legacyPush(_ id: String, store: OkidokiStore, base: String, secret: String, report: inout SyncReport) async throws {
        let state = try payload(for: id, store: store)
        if state.hash == lastPushedHash[id] {
            report.skipped.append(id)
            return
        }
        var body = state.body
        body["floors"] = nil
        let (code, data) = try await send(try request(endpoint(base, path: "/api/sync")!, secret: secret, method: "POST", json: body, timeout: 120))
        if code == 409 {
            report.conflicts += 1
            return
        }
        guard (200..<300).contains(code) else { throw SyncFailure.http(code, String(data: data, encoding: .utf8) ?? "") }
        lastPushedHash[id] = state.hash
        report.pushed.append(id)
    }

    public func share(run: AgentRun, account: Account, store: OkidokiStore) async -> String? {
        guard store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else { return nil }
        guard let secret = secret(), !secret.isEmpty else { return nil }
        guard let url = endpoint(store.settings.convexSiteURL, path: "/api/share") else { return nil }
        do {
            let runObject = try JSONSerialization.jsonObject(with: SyncDates.encoder.encode(run))
            let body: [String: Any] = [
                "accountId": account.id,
                "accountName": account.name,
                "runId": run.id,
                "run": runObject,
            ]
            let (code, data) = try await send(try request(url, secret: secret, method: "POST", json: body))
            guard (200..<300).contains(code),
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
        guard let secret = secret(), !secret.isEmpty else { return false }
        guard let url = endpoint(store.settings.convexSiteURL, path: "/api/purge") else { return false }
        lastPushedHash[accountID] = nil
        guard let request = try? request(url, secret: secret, method: "POST", json: ["accountId": accountID], timeout: 120),
              let (code, _) = try? await send(request) else { return false }
        return (200..<300).contains(code)
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
