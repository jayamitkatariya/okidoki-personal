import Foundation
import Network
import OkidokiCore

/// A small HTTP endpoint on 127.0.0.1 so other tools on this Mac — the okidoki MCP server, a
/// script, a shortcut — can list and replay skills, and search the vault.
///
/// Every request needs the token in `control.json` in the support folder (owner-only), which also
/// says the port. Nothing listens beyond this Mac. Replays still go through the usual approval rules.
@MainActor
final class ControlServer {
    static let defaultPort: UInt16 = 4330

    private weak var env: AppEnvironment?
    private var listener: NWListener?
    private let token = UUID().uuidString + UUID().uuidString
    private(set) var port: UInt16 = 0

    init(environment: AppEnvironment) { self.env = environment }

    static var infoURL: URL { AppPaths.support("control.json") }

    func start() {
        // A control.json left by a crash names a dead port and token; local tools would get 401s.
        try? FileManager.default.removeItem(at: Self.infoURL)
        let wanted = UInt16(ProcessInfo.processInfo.environment["OKIDOKI_CONTROL_PORT"] ?? "") ?? Self.defaultPort
        listen(on: wanted)
    }

    /// Binding failures (the port is taken) arrive later as `.failed`, not as a throw: retry on any free port.
    private func listen(on candidate: UInt16) {
        guard let port = NWEndpoint.Port(rawValue: candidate) else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        guard let listener = try? NWListener(using: parameters) else {
            if candidate != 0 { listen(on: 0) }
            return
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            Task { @MainActor in
                guard let self, let listener, listener === self.listener else { return }
                switch state {
                case .ready:
                    guard let bound = listener.port?.rawValue else { return }
                    self.port = bound
                    self.writeInfo()
                case .failed:
                    listener.cancel()
                    self.listener = nil
                    if candidate != 0 { self.listen(on: 0) }
                default:
                    break
                }
            }
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
        try? FileManager.default.removeItem(at: Self.infoURL)
    }

    /// Port and token for local clients, readable only by this user.
    private func writeInfo() {
        let info: [String: Any] = ["port": Int(port), "token": token, "pid": Int(ProcessInfo.processInfo.processIdentifier)]
        guard let data = try? JSONSerialization.data(withJSONObject: info) else { return }
        let url = Self.infoURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    // MARK: HTTP

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self else { return connection.cancel() }
                var buffer = buffer
                if let data { buffer.append(data) }
                if let request = Self.parse(buffer) {
                    let (status, body) = await self.handle(request)
                    self.reply(connection, status: status, body: body)
                } else if done || error != nil || buffer.count > 4 << 20 {
                    self.reply(connection, status: 400, body: ["error": "bad request"])
                } else {
                    self.receive(connection, buffer: buffer)
                }
            }
        }
    }

    struct Request {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: [String: Any]
    }

    /// A whole request, once the headers and the body they announce have arrived.
    nonisolated static func parse(_ data: Data) -> Request? {
        guard let split = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<split.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyData = data[split.upperBound...]
        guard bodyData.count >= length else { return nil }
        let body = (try? JSONSerialization.jsonObject(with: bodyData.prefix(length))) as? [String: Any] ?? [:]
        let target = URLComponents(string: String(parts[1]))
        var query: [String: String] = [:]
        for item in target?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(parts[0]), path: target?.path ?? "/", query: query, headers: headers, body: body)
    }

    private func reply(_ connection: NWConnection, status: Int, body: Any) {
        let json = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict"][status] ?? "OK"
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + json, completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: Routes

    /// What other agents can do, for `GET /` and the CLI's help.
    static let routes: [String] = [
        "GET  /status                      what's running, key, smart replay, private Mac phase, session on or off",
        "POST /tasks {text, mode?, thread?, wait?}   a task in plain words; mode auto|browser|computer|chat",
        "GET  /runs?limit=                 recent runs",
        "GET  /runs/<id>?log=1             one run: status, result, what it's waiting for",
        "GET  /runs/<id>/wait?timeout=     waits until it's done, or needs the person",
        "POST /runs/<id>/stop|pause|resume|takeback",
        "POST /runs/<id>/reply {text}      answers the question a run asked",
        "POST /runs/<id>/save {name?}      keeps a finished web run as a skill that replays with new data",
        "GET  /skills                      saved skills with their inputs",
        "GET  /library                     ready-made templates",
        "POST /skills/<name or id>/run {items?, values?, times?, wait?}",
        "GET  /browser/tabs                okidoki's browser tabs",
        "POST /browser/open {url}          a new tab for you",
        "GET  /browser/page?tab=           a tab's text and numbered elements",
        "POST /browser/act {tab, action, ref?|selector?, text?, value?, key?}",
        "GET  /browser/screenshot?tab=     a PNG, base64",
        "POST /browser/close {tab}",
        "GET  /memory?q=&limit=&items=1 · POST /memory {text} · PATCH /memory/<id> {text?, pinned?} · DELETE /memory/<id>",
        "GET  /vault/search?q=",
    ]

    /// Tabs other agents opened here: theirs to drive. Tabs of runs they started are theirs to read.
    private var agentTabs: Set<UUID> = []

    private func handle(_ request: Request) async -> (Int, Any) {
        // Browsers send an Origin; local tools don't. A page on the web must never drive this Mac.
        guard request.headers["origin"] == nil, request.headers["authorization"] == "Bearer \(token)" else {
            return (401, ["error": "unauthorized"])
        }
        guard let env else { return (409, ["error": "okidoki is shutting down"]) }
        let parts = request.path.split(separator: "/").map(String.init)
        switch (request.method, parts.first ?? "") {
        case ("GET", ""):
            return (200, ["okidoki": "control", "routes": Self.routes])
        case ("GET", "status"):
            let live = env.store.runs.filter { $0.status.isActive }
            return (200, ["ok": true, "key": env.hasKey("anthropic"), "smartReplay": env.store.settings.hybridReplay,
                          "brain": env.sidecar.status.isReady, "privateMac": env.privateMac.phase.rawValue,
                          "collab": env.collab?.session != nil,
                          "running": live.map { Self.json($0, env: env, log: false) }])
        case ("POST", "tasks"):
            return await task(request, env: env)
        case ("GET", "runs") where parts.count == 1:
            let limit = max(1, min(Int(request.query["limit"] ?? "") ?? 10, 100))
            return (200, ["runs": env.store.runs.prefix(limit).map { Self.json($0, env: env, log: false) }])
        case (_, "runs"):
            return await runRoute(request, parts: parts, env: env)
        case ("GET", "skills"):
            return (200, ["skills": env.store.activeSkills.filter { $0.template != true }.map { Self.json($0) }])
        case ("GET", "library"):
            return (200, ["templates": env.library.map { entry -> [String: Any] in
                var out = Self.json(SkillLibrary.skill(from: entry, accountID: ""))
                out["id"] = entry.id
                out["surface"] = entry.surface
                out["installed"] = env.store.activeSkills.contains { $0.source == SkillLibrary.source(for: entry.id) }
                return out
            }])
        case ("POST", "skills") where parts.count == 3 && parts[2] == "run":
            return await runSkill(request, name: parts[1], env: env)
        case ("POST", "replay"):
            // The first version of this endpoint, kept for the MCP server's replay_skill.
            return await runSkill(request, name: request.body["skill"] as? String ?? "", env: env)
        case (_, "browser"):
            return await browserRoute(request, parts: parts, env: env)
        case ("GET", "memory") where parts.count == 1:
            // `?q=` ranks the notes the way a request with that text would get them (pinned and matching first).
            let limit = max(1, min(Int(request.query["limit"] ?? "") ?? 200, 1_000))
            // Picked once; `memory` is the lines a request would get, `items` the same notes with ids.
            let notes = MemoryRecall.select(env.store.activeMemories, query: request.query["q"] ?? "", limit: limit,
                                            isCurrent: { env.store.isCurrent($0) })
            let lines = notes.map { "\($0.section.label): \($0.text)" }
            guard request.query["items"] != nil else { return (200, ["memory": lines]) }
            return (200, ["memory": lines, "items": notes.map { ["id": $0.id, "section": $0.section.rawValue, "text": $0.text,
                                                                 "pinned": $0.pinned == true] as [String: Any] }])
        case ("PATCH", "memory") where parts.count == 2:
            // The person's own edit (text) or pin, as on the Memory page.
            guard env.store.activeMemories.contains(where: { $0.id == parts[1] }) else { return (404, ["error": "no such memory"]) }
            if let text = request.body["text"] as? String {
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (400, ["error": "empty text"]) }
                // Same gates as POST: an edit is a way in too (no secrets, nothing that reads as an instruction).
                if let why = MemoryPolicy.refusal(text) {
                    return (400, ["error": why.hasPrefix("secret:") ? MemoryPolicy.vaultNote(String(why.dropFirst(7))) : "only lasting facts about the person are kept"])
                }
                env.store.updateMemory(parts[1], text: text)
            }
            if let pinned = request.body["pinned"] as? Bool { env.store.setMemoryPinned(parts[1], pinned) }
            env.store.saveNow()
            return (200, ["ok": true])
        case ("DELETE", "memory") where parts.count == 2:
            guard env.store.activeMemories.contains(where: { $0.id == parts[1] }) else { return (404, ["error": "no such memory"]) }
            env.store.deleteMemory(parts[1])
            env.store.saveNow()
            return (200, ["ok": true])
        case ("POST", "memory"):
            let text = (request.body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard BrainService.isDurableFact(text) else { return (400, ["error": "only lasting facts about the person are kept"]) }
            if let secret = MemoryPolicy.secretKind(text) {
                return (400, ["error": MemoryPolicy.vaultNote(secret)])
            }
            let results = await env.rememberExplicit([text], words: text, source: "agent", threadID: nil, messageID: nil)
            env.store.saveNow()
            let kept = results.compactMap { save -> [String: Any]? in
                switch save {
                case .added(let item): return ["id": item.id, "text": item.text, "op": "added"]
                case .updated(let item): return ["id": item.id, "text": item.text, "op": "updated", "was": item.previousText ?? ""]
                case .known(let item): return ["id": item.id, "text": item.text, "op": "known"]
                case .refused: return nil
                }
            }
            let added = kept.contains { ($0["op"] as? String) != "known" }
            let note = kept.isEmpty ? "not kept" : kept.contains { ($0["op"] as? String) == "updated" } ? "updated"
                : added ? "remembered" : "already known"
            return (200, ["ok": !kept.isEmpty, "kept": added, "note": note, "memories": kept])
        case ("GET", "vault") where parts.count == 2 && parts[1] == "search":
            let hits = env.vault.search(request.query["q"] ?? "", limit: 10)
            return (200, ["folder": env.vault.folderURL.path, "files": hits.map { file in
                ["name": file.name, "folder": file.folder, "path": env.vault.folderURL.appendingPathComponent(file.id).path,
                 "size": file.size, "modifiedAt": ISO8601DateFormatter().string(from: file.modifiedAt)] as [String: Any]
            }])
        case ("POST", "ask"):
            // The first version: fire and forget. `/tasks` says which run took it.
            let text = (request.body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return (400, ["error": "nothing to ask"]) }
            let thread = env.askFromControl(text, mode: "auto", threadID: nil)
            return (200, ["ok": true, "thread": thread, "note": "okidoki is on it; anything risky waits for an okay in the notch"])
        default:
            return (404, ["error": "no such route", "routes": Self.routes])
        }
    }

    // MARK: Tasks and runs

    private func task(_ request: Request, env: AppEnvironment) async -> (Int, Any) {
        let text = (request.body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return (400, ["error": "nothing to do: send {\"text\": \"…\"}"]) }
        guard env.hasKey("anthropic") else { return (409, ["error": "okidoki has no Anthropic key yet; add one in its Settings"]) }
        let mode = (request.body["mode"] as? String ?? "auto").lowercased()
        // Callers here are other agents, so they never pick the person's coding agent directly: a coding agent
        // okidoki started could otherwise bounce its own work back to itself. Delegating stays okidoki's call.
        guard ["auto", "browser", "computer", "act", "chat"].contains(mode) else {
            return (400, ["error": "mode is auto, browser, computer or chat"])
        }
        let since = Date().addingTimeInterval(-1)
        let thread = env.askFromControl(text, mode: mode, threadID: request.body["thread"] as? String)
        let wait = Self.seconds(request.body["wait"])
        // The run that took it shows up within a moment (the brain decides first).
        guard let run = await firstRun(in: thread, since: since, env: env, patience: max(20, min(wait, 60))) else {
            let said = env.store.thread(thread)?.messages.last(where: { $0.role == .assistant })?.text
            return (200, ["thread": thread, "status": said == nil ? "starting" : "done", "result": said ?? ""])
        }
        let settled = wait > 0 ? await settle(run.id, timeout: wait, env: env) : run
        var out = Self.json(settled, env: env, log: false)
        out["thread"] = thread
        return (200, out)
    }

    private func runRoute(_ request: Request, parts: [String], env: AppEnvironment) async -> (Int, Any) {
        guard parts.count >= 2, let run = env.store.run(parts[1]) else { return (404, ["error": "no such run"]) }
        let verb = parts.count > 2 ? parts[2] : ""
        switch (request.method, verb) {
        case ("GET", ""):
            return (200, Self.json(run, env: env, log: request.query["log"] != nil))
        case ("GET", "wait"):
            let settled = await settle(run.id, timeout: Self.seconds(request.query["timeout"]).nonZero ?? 300, env: env)
            return (200, Self.json(settled, env: env, log: request.query["log"] != nil))
        case ("POST", "stop"):
            env.stopRun(run.id)
        case ("POST", "pause"):
            guard run.status == .running else { return (409, ["error": "it isn't running (\(run.status.rawValue))"]) }
            env.pauseRun(run.id, from: "agent")
        case ("POST", "resume"), ("POST", "takeback"):
            guard run.status == .paused else { return (409, ["error": "it isn't paused (\(run.status.rawValue))"]) }
            if env.handoffRunID == run.id, let back = env.pendingHandoff { back() } else { env.pauseRun(run.id, from: "agent") }
        case ("POST", "save"):
            guard let name = env.saveRunAsSkill(run.id, name: request.body["name"] as? String) else {
                return (409, ["error": "only a web run that worked (in this session) can be kept as a skill"])
            }
            // Generalizing it (inputs, checks) takes a moment; the skill is listed once that's done.
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline, !env.store.activeSkills.contains(where: { $0.name == name && $0.inputs != nil }) {
                if !env.store.settings.hybridReplay, env.store.activeSkills.contains(where: { $0.name == name }) { break }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            guard let skill = env.store.activeSkills.last(where: { $0.name == name }) else { return (200, ["ok": true, "skill": name]) }
            return (200, ["ok": true, "skill": Self.json(skill)])
        case ("POST", "reply"):
            let text = (request.body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard run.status == .asked, !text.isEmpty else { return (409, ["error": "that run isn't waiting on an answer"]) }
            guard let thread = run.threadID else { return (409, ["error": "that run has no conversation to carry on"]) }
            let since = Date().addingTimeInterval(-1)
            _ = env.askFromControl(text, mode: "auto", threadID: thread)
            if let next = await firstRun(in: thread, since: since, env: env, patience: 20, excluding: run.id) {
                var out = Self.json(next, env: env, log: false)
                out["thread"] = thread
                return (200, out)
            }
            return (200, ["ok": true, "thread": thread])
        default:
            return (404, ["error": "no such route", "routes": Self.routes])
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        return (200, Self.json(env.store.run(run.id) ?? run, env: env, log: false))
    }

    private func runSkill(_ request: Request, name raw: String, env: AppEnvironment) async -> (Int, Any) {
        let name = (raw.removingPercentEncoding ?? raw).trimmingCharacters(in: .whitespacesAndNewlines)
        let skills = env.store.activeSkills.filter { $0.template != true }
        guard let skill = skills.first(where: { $0.id == name }) ?? skills.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            return (404, ["error": "no skill called “\(name)”", "skills": skills.map(\.name)])
        }
        let strings: (Any) -> [String: String] = { ($0 as? [String: Any] ?? [:]).compactMapValues { value in
            if let text = value as? String { return text }
            if JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) { return String(data: data, encoding: .utf8) }
            return "\(value)"
        } }
        // One pass per item; or `times` passes of the same values.
        var passes = (request.body["items"] as? [Any] ?? []).map(strings).filter { !$0.isEmpty }
        let times = max(1, min(request.body["times"] as? Int ?? 1, 100))
        if passes.isEmpty {
            let values = strings(request.body["values"] ?? [:])
            if !values.isEmpty { passes = Array(repeating: values, count: times) }
        }
        let thread = env.store.createThread(title: "replay \(skill.name)", app: "agent", topic: "skills")
        env.controlThreads.insert(thread.id)
        let since = Date().addingTimeInterval(-1)
        guard env.startReplayFromChat(skill, times: passes.isEmpty ? times : passes.count, threadID: thread.id, source: "control",
                                      values: passes, request: request.body["request"] as? String ?? "") else {
            return (409, ["error": "okidoki is busy recording or replaying; try again when it's done"])
        }
        guard let run = await firstRun(in: thread.id, since: since, env: env, patience: 5) else {
            return (200, ["ok": true, "skill": skill.name, "thread": thread.id])
        }
        let wait = Self.seconds(request.body["wait"])
        var out = Self.json(wait > 0 ? await settle(run.id, timeout: wait, env: env) : run, env: env, log: false)
        out["thread"] = thread.id
        return (200, out)
    }

    /// The run a request in `thread` started: the one doing the work, or the plain answer when that's all
    /// it was. Nil if none showed up in `patience` seconds.
    private func firstRun(in thread: String, since: Date, env: AppEnvironment, patience: Double, excluding: String? = nil) async -> AgentRun? {
        let deadline = Date().addingTimeInterval(patience)
        var answerSeen: Date?
        while Date() < deadline {
            let fresh = env.store.runs.filter { $0.threadID == thread && $0.createdAt >= since && $0.id != excluding }
            if let work = fresh.first(where: { $0.kind != .answer }) { return work }
            if let answer = fresh.first {
                // An answer can be followed by the work it announced: give that a moment.
                answerSeen = answerSeen ?? Date()
                if answer.status.isActive == false, Date().timeIntervalSince(answerSeen!) > 2 { return answer }
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return env.store.runs.first { $0.threadID == thread && $0.createdAt >= since && $0.id != excluding }
    }

    /// Waits until the run is over, or needs the person (an okay, an answer, their turn on a page).
    private func settle(_ id: String, timeout: Double, env: AppEnvironment) async -> AgentRun {
        let deadline = Date().addingTimeInterval(min(timeout, 1800))
        var last = env.store.run(id)
        while Date() < deadline, let run = env.store.run(id), Self.needs(run) == nil, run.status.isActive {
            last = run
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return env.store.run(id) ?? last!
    }

    /// What a run is waiting on from the person, in words another agent can relay. Nil when nothing.
    static func needs(_ run: AgentRun) -> String? {
        switch run.status {
        case .waiting, .previewing: return "the person's okay in the notch"
        case .asked: return "an answer: reply with POST /runs/\(run.id)/reply"
        case .paused: return run.waitingFor.map { "the person to get past \($0) in okidoki's browser" } ?? "the person (they paused it)"
        default: return nil
        }
    }

    static func json(_ run: AgentRun, env: AppEnvironment, log: Bool) -> [String: Any] {
        let iso = ISO8601DateFormatter()
        var out: [String: Any] = [
            "id": run.id, "kind": run.kind.rawValue, "title": run.title, "status": run.status.rawValue,
            "done": !run.status.isActive, "result": run.summary, "modelCalls": run.modelCalls ?? 0,
            "createdAt": iso.string(from: run.createdAt),
        ]
        if let builtin = run.builtin { out["by"] = builtin == "skill" ? "replay" : builtin == "browser" ? "browser agent" : builtin }
        if let ended = run.endedAt { out["endedAt"] = iso.string(from: ended); out["seconds"] = round(ended.timeIntervalSince(run.startedAt ?? run.createdAt) * 10) / 10 }
        if let needs = needs(run) { out["needs"] = needs }
        if let thread = run.threadID { out["thread"] = thread }
        if !run.steps.isEmpty { out["steps"] = run.steps.map { ["title": $0.title, "status": $0.status.rawValue] } }
        // What the run said back: an answer, a replay's receipts.
        if let thread = run.threadID.flatMap({ env.store.thread($0) }) {
            let said = thread.messages.filter { $0.role == .assistant && $0.runID == run.id }.map(\.text)
            if !said.isEmpty { out["said"] = said }
        }
        if log { out["log"] = String(run.output.suffix(8000)) }
        return out
    }

    static func json(_ skill: Skill) -> [String: Any] {
        var out: [String: Any] = ["id": skill.id, "name": skill.name, "summary": skill.summary, "steps": skill.steps.count,
                                  "runs": skill.runCount, "parameters": ParameterFill.names(in: skill.steps)]
        if let intent = skill.intent { out["intent"] = intent }
        if let noun = skill.itemNoun { out["itemNoun"] = noun }
        if skill.learned == true { out["learned"] = true }
        if let start = skill.startURL ?? skill.startApp { out["start"] = start }
        if let inputs = skill.inputs {
            out["inputs"] = inputs.map { input -> [String: Any] in
                var one: [String: Any] = ["name": input.name, "description": input.description, "kind": input.kind,
                                          "required": input.required ?? true]
                if let fields = input.fields { one["fields"] = fields }
                if let choices = input.choices { one["choices"] = choices }
                if let example = input.example, input.sensitive != true { one["example"] = example }
                return one
            }
        }
        return out
    }

    nonisolated static func seconds(_ value: Any?) -> Double {
        if let number = value as? NSNumber { return max(0, number.doubleValue) }
        if let text = value as? String { return max(0, Double(text) ?? 0) }
        return 0
    }

    // MARK: Browser

    private func browserRoute(_ request: Request, parts: [String], env: AppEnvironment) async -> (Int, Any) {
        let browser = env.browser
        let verb = parts.count > 1 ? parts[1] : ""
        // A tab an agent may read: one it opened, or one a run it started is working in.
        func readable(_ tab: BrowserTab) -> Bool {
            if agentTabs.contains(tab.id) { return true }
            guard let owner = tab.ownerRunID, let thread = env.store.run(owner)?.threadID else { return false }
            return env.controlThreads.contains(thread)
        }
        func target() -> BrowserTab? {
            let number = Int(request.query["tab"] ?? "") ?? (request.body["tab"] as? Int)
            if let number { return browser.tab(number: number) }
            return browser.model.tabs.last { agentTabs.contains($0.id) }
        }
        switch (request.method, verb) {
        case ("GET", "tabs"):
            return (200, ["tabs": browser.model.tabs.map { tab -> [String: Any] in
                ["tab": tab.number, "title": tab.label, "url": tab.address, "yours": agentTabs.contains(tab.id),
                 "readable": readable(tab), "busy": tab.ownerRunID != nil] as [String: Any]
            }])
        case ("POST", "open"):
            guard let raw = request.body["url"] as? String, let url = BrowserSteps.addressURL(raw) else { return (400, ["error": "send {\"url\": \"…\"}"]) }
            browser.showQuietly()
            let tab = browser.openTab(activate: request.body["front"] as? Bool ?? false)
            agentTabs.insert(tab.id)
            await tab.navigate(url)
            await tab.settle(limit: 8)
            return (200, ["tab": tab.number, "url": tab.address, "title": tab.label])
        case ("GET", "page"):
            guard let tab = target() else { return (404, ["error": "no such tab; open one with POST /browser/open"]) }
            guard readable(tab) else { return (403, ["error": "that tab is the person's; open your own"]) }
            await tab.settle(limit: 4)
            let page = await tab.snapshot()
            var out: [String: Any] = ["tab": tab.number, "url": page.url, "title": page.title, "text": page.text, "elements": page.elements]
            if page.more > 0 { out["more"] = page.more }
            if let check = await tab.humanCheck() { out["needsPerson"] = check.text }
            return (200, out)
        case ("POST", "act"):
            guard let tab = target() else { return (404, ["error": "no such tab; open one with POST /browser/open"]) }
            guard agentTabs.contains(tab.id) else { return (403, ["error": "only tabs you opened can be driven; open your own"]) }
            guard tab.ownerRunID == nil else { return (409, ["error": "a run is working in that tab"]) }
            var action = request.body
            action.removeValue(forKey: "tab")
            if let selector = action.removeValue(forKey: "selector") as? String { action["selectors"] = [selector] }
            if action["action"] as? String == "navigate" {
                guard let raw = action["url"] as? String, let url = BrowserSteps.addressURL(raw) else { return (400, ["error": "navigate needs a url"]) }
                await tab.navigate(url)
                await tab.settle(limit: 8)
                return (200, ["ok": true, "url": tab.address])
            }
            if action["action"] as? String == "back" { await tab.goBack(); await tab.settle(limit: 6); return (200, ["ok": true, "url": tab.address]) }
            // Vault secrets never go through here: an agent types what it was given, nothing more.
            action.removeValue(forKey: "secret")
            let result = await tab.act(action)
            await tab.settle(limit: 4, fresh: true)
            var out: [String: Any] = ["ok": result.ok, "url": tab.address]
            if let detail = result.detail { out["detail"] = detail }
            if let label = result.label { out["label"] = label }
            return (200, out)
        case ("GET", "screenshot"):
            guard let tab = target() else { return (404, ["error": "no such tab"]) }
            guard readable(tab) else { return (403, ["error": "that tab is the person's; open your own"]) }
            guard let png = await tab.screenshot() else { return (409, ["error": "couldn't take it"]) }
            return (200, ["tab": tab.number, "png": png.base64EncodedString()])
        case ("POST", "close"):
            guard let tab = target(), agentTabs.contains(tab.id) else { return (404, ["error": "no tab of yours by that number"]) }
            agentTabs.remove(tab.id)
            browser.closeTab(tab)
            return (200, ["ok": true])
        default:
            return (404, ["error": "no such route", "routes": Self.routes])
        }
    }
}

private extension Double {
    var nonZero: Double? { self > 0 ? self : nil }
}
