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
    public static func blocked(commands: [String], settings: AppSettings) -> String? {
        for command in commands {
            if CommandRisk.isBlocked(command) { return "that command could destroy your Mac. i won't run it." }
            for blocked in settings.blockedApps where mentions(command, blocked) {
                return "\(blocked) is on your blocked list."
            }
        }
        return nil
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
            status = "add a sync secret in keys"
            return
        }
        isSyncing = true
        status = "syncing…"
        defer { isSyncing = false }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            // Only the tail of each run's terminal output syncs; the full log stays on this Mac.
            // Keeps the request well under Convex's HTTP body limit as history grows.
            var syncState = store.stateForSync()
            syncState.runs = syncState.runs.map { run in
                var run = run
                run.output = String(run.output.suffix(20_000))
                return run
            }
            let stateData = try encoder.encode(syncState)
            let stateObject = try JSONSerialization.jsonObject(with: stateData)
            let body: [String: Any] = [
                "accountId": store.currentAccountID,
                "device": Host.current().localizedName ?? "mac",
                "state": stateObject,
            ]
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let text = String(data: data, encoding: .utf8) ?? ""
                status = "sync failed \(text.prefix(60))"
                return
            }
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
