import Foundation
import Combine
import Network
import OkidokiCore

/// The shared session's LAN endpoint. One Mac hosts its private Mac; everyone on the same WiFi joins
/// in a browser. This serves the joiner page and a narrow, code-and-token-gated API: the live screen,
/// the group chat, and okidoki acting in the VM. It listens beyond localhost only while a session is
/// active, and never exposes the host's keys, vault, memory, screen or browser — only okidoki's Mac.
///
/// Modeled on ControlServer (same HTTP parsing), but it keeps SSE connections open to push events,
/// serves the bundled joiner page, and answers a latest-frame endpoint the screen polls.
@MainActor
final class CollabServer {
    static let defaultPort: UInt16 = 4331

    private weak var env: AppEnvironment?
    private var listener: NWListener?
    private(set) var port: UInt16 = 0
    private(set) var session: CollabSession?
    private var clients: [UUID: NWConnection] = [:]
    private var latestFrame: Data?
    private var cancellables = Set<AnyCancellable>()
    private var broadcastWork: DispatchWorkItem?

    init(environment: AppEnvironment) { self.env = environment }

    var isRunning: Bool { session != nil }

    // MARK: Lifecycle

    func start() {
        guard session == nil, let env else { return }
        let session = CollabSession(hostName: Host.current().localizedName ?? "Mac")
        session.onChange = { [weak self] in self?.broadcastPresence() }
        self.session = session
        session.system("started a session — ask okidoki anything")
        listen(on: Self.defaultPort)
        // The VM screen feeds the session while anyone is in it, dashboard open or not.
        env.privateMac.setMirrorSink("collab", wanted: { [weak self] in
            guard let self else { return false }
            return self.session != nil && !self.clients.isEmpty
        }, frame: { [weak self] image in
            guard let self else { return }
            Task { @MainActor in
                let data = await Task.detached(priority: .utility) { PrivateMacService.jpegData(image) }.value
                if let data { self.latestFrame = data }
            }
        })
        // Run progress and VM state reach joiners as they change, throttled so a busy run is smooth.
        env.store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.scheduleBroadcast() }
            .store(in: &cancellables)
        env.driver.model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.scheduleBroadcast() }
            .store(in: &cancellables)
        env.objectWillChange.send()
    }

    func stop() {
        broadcast(["type": "ended"])
        for client in clients.values { client.cancel() }
        clients.removeAll()
        cancellables.removeAll()
        broadcastWork?.cancel()
        broadcastWork = nil
        listener?.cancel()
        listener = nil
        env?.privateMac.removeMirrorSink("collab")
        latestFrame = nil
        session = nil
        port = 0
        env?.objectWillChange.send()
    }

    private func listen(on candidate: UInt16) {
        guard let port = NWEndpoint.Port(rawValue: candidate) else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "0.0.0.0", port: port)
        guard let listener = try? NWListener(using: parameters) else {
            if candidate != 0 { listen(on: 0) }
            return
        }
        listener.service = NWListener.Service(name: session?.hostName ?? "okidoki", type: "_okidoki._tcp")
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            Task { @MainActor in
                guard let self, let listener, listener === self.listener else { return }
                switch state {
                case .ready:
                    self.port = listener.port?.rawValue ?? candidate
                    self.env?.objectWillChange.send()
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
                if let request = ControlServer.parse(buffer) {
                    await self.route(connection, request)
                } else if done || error != nil || buffer.count > 4 << 20 {
                    self.reply(connection, status: 400, body: ["error": "bad request"])
                } else {
                    self.receive(connection, buffer: buffer)
                }
            }
        }
    }

    private func reply(_ connection: NWConnection, status: Int, body: Any) {
        let json = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict"][status] ?? "OK"
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + json, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func replyData(_ connection: NWConnection, status: Int, type: String, data: Data, extra: String = "") {
        let reason = status == 200 ? "OK" : "Not Found"
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\n\(extra)Connection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: Routing

    private func route(_ connection: NWConnection, _ request: ControlServer.Request) async {
        guard let env, let session else {
            reply(connection, status: 409, body: ["error": "no session is active"])
            return
        }
        let parts = request.path.split(separator: "/").map(String.init)

        if request.method == "GET", request.path == "/api/events" {
            startSSE(connection, request: request)
            return
        }
        if request.method == "GET", parts == ["api", "frame"] {
            guard let token = request.query["token"], session.participant(forToken: token) != nil else {
                reply(connection, status: 401, body: ["error": "unauthorized"])
                return
            }
            guard let frame = latestFrame else {
                reply(connection, status: 404, body: ["error": "no frame yet"])
                return
            }
            replyData(connection, status: 200, type: "image/jpeg", data: frame, extra: "Cache-Control: no-store\r\n")
            return
        }
        if request.method == "GET", parts == ["api", "state"] {
            guard let token = request.query["token"], let you = session.participant(forToken: token) else {
                reply(connection, status: 401, body: ["error": "unauthorized"])
                return
            }
            reply(connection, status: 200, body: ["you": Self.encode(you), "session": Self.encode(snapshot())])
            return
        }
        if request.method == "GET", parts.first != "api" {
            serveStatic(connection, path: request.path)
            return
        }
        guard request.method == "POST", parts.first == "api" else {
            reply(connection, status: 404, body: ["error": "no such route"])
            return
        }
        let verb = parts.count > 1 ? parts[1] : ""

        if verb == "join" {
            let name = request.body["name"] as? String ?? ""
            let code = request.body["code"] as? String ?? ""
            do {
                let joined = try session.join(name: name, code: code)
                session.system("\(joined.participant.name) joined")
                reply(connection, status: 200, body: ["token": joined.token, "you": Self.encode(joined.participant), "session": Self.encode(snapshot())])
            } catch CollabJoinError.badCode {
                reply(connection, status: 403, body: ["error": "that code didn't match — check it on the host's screen"])
            } catch {
                reply(connection, status: 409, body: ["error": "this session is full"])
            }
            return
        }

        // Everything past join needs a participant token.
        let bearer = request.headers["authorization"]?.replacingOccurrences(of: "Bearer ", with: "")
        guard let token = bearer ?? request.query["token"], let you = session.participant(forToken: token) else {
            reply(connection, status: 401, body: ["error": "unauthorized"])
            return
        }

        switch verb {
        case "state":
            reply(connection, status: 200, body: ["you": Self.encode(you), "session": Self.encode(snapshot())])
        case "chat":
            let text = CollabRules.clampMessage(request.body["text"] as? String ?? "")
            guard !text.isEmpty else { reply(connection, status: 400, body: ["error": "nothing to say"]); return }
            let ask = (request.body["ask"] as? Bool ?? false) || CollabRules.asksOkidoki(text)
            let message = session.say(authorID: you.id, authorName: you.name, colorHex: you.colorHex, text: text, kind: ask ? .ask : .chat)
            broadcast(["type": "chat", "message": Self.encode(message)])
            if ask {
                let goal = CollabRules.stripAskPrefix(text)
                Task { await env.startSessionTask(text: goal.isEmpty ? text : goal, requestedBy: you.id) }
            }
            reply(connection, status: 200, body: ["ok": true])
        case "skills" where parts.count >= 3 && parts[2] == "run":
            let id = request.body["id"] as? String ?? ""
            guard let card = env.collabSkillCards().first(where: { $0.id == id }) else {
                reply(connection, status: 404, body: ["error": "no such skill"]); return
            }
            let values = request.body["values"] as? [String: String] ?? [:]
            let detail = values.isEmpty ? "" : " (" + values.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ", ") + ")"
            let goal = (card.intent ?? card.name) + detail
            let message = session.say(authorID: you.id, authorName: you.name, colorHex: you.colorHex, text: "asked okidoki: \(card.name)\(detail)", kind: .ask)
            broadcast(["type": "chat", "message": Self.encode(message)])
            Task { await env.startSessionTask(text: goal, requestedBy: you.id) }
            reply(connection, status: 200, body: ["ok": true])
        case "runs" where parts.count >= 3 && parts[2] == "stop":
            let id = request.body["id"] as? String ?? ""
            guard let run = env.store.run(id), session.canStop(requestedBy: run.requestedBy, participantID: you.id) else {
                reply(connection, status: 403, body: ["error": "only the person who asked can stop it"]); return
            }
            env.stopRun(id)
            reply(connection, status: 200, body: ["ok": true])
        case "wheel":
            let action = request.body["action"] as? String ?? ""
            if action == "request" {
                let ok = session.requestWheel(you.id)
                broadcastWheel()
                if ok {
                    reply(connection, status: 200, body: ["ok": true, "holder": (session.wheelHolder as Any?) ?? NSNull()])
                } else {
                    reply(connection, status: 409, body: ["error": "someone already has the wheel"])
                }
            } else {
                session.releaseWheel(you.id)
                broadcastWheel()
                reply(connection, status: 200, body: ["ok": true, "holder": (session.wheelHolder as Any?) ?? NSNull()])
            }
        case "input":
            guard session.wheelHolder == you.id else { reply(connection, status: 403, body: ["error": "take the wheel first"]); return }
            env.performSessionInput(request.body)
            reply(connection, status: 200, body: ["ok": true])
        default:
            reply(connection, status: 404, body: ["error": "no such route"])
        }
    }

    // MARK: SSE

    private func startSSE(_ connection: NWConnection, request: ControlServer.Request) {
        guard let session, let token = request.query["token"], let you = session.participant(forToken: token) else {
            reply(connection, status: 401, body: ["error": "unauthorized"])
            return
        }
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        let id = UUID()
        clients[id] = connection
        send(connection, event: ["type": "hello", "you": Self.encode(you), "session": Self.encode(snapshot())])
        drain(connection, id: id)
    }

    private func drain(_ connection: NWConnection, id: UUID) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] _, _, done, error in
            Task { @MainActor in
                if done || error != nil {
                    self?.clients[id] = nil
                    connection.cancel()
                } else {
                    self?.drain(connection, id: id)
                }
            }
        }
    }

    private func send(_ connection: NWConnection, event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        connection.send(content: Data("data: ".utf8) + data + Data("\n\n".utf8), completion: .contentProcessed { _ in })
    }

    func broadcast(_ event: [String: Any]) {
        for connection in clients.values { send(connection, event: event) }
    }

    private func broadcastPresence() {
        guard let session else { return }
        broadcast(["type": "presence", "participants": session.participants.map { Self.encode($0) }])
    }

    private func broadcastWheel() {
        guard let session else { return }
        broadcast(["type": "wheel", "holder": (session.wheelHolder as Any?) ?? NSNull(),
                   "holderName": (session.wheelHolder.flatMap { session.participant(id: $0)?.name } as Any?) ?? NSNull()])
    }

    private func scheduleBroadcast() {
        guard broadcastWork == nil, session != nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.broadcastWork = nil
            self?.broadcastState()
        }
        broadcastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
    }

    private func broadcastState() {
        guard let env, let session else { return }
        broadcast(["type": "vm", "phase": env.privateMac.phase.rawValue, "running": env.privateMac.isRunning])
        let run = env.collabRunSnapshot(id: session.activeRunID)
        broadcast(["type": "run", "run": run.map { Self.encode($0) } ?? NSNull()])
        // okidoki's new replies in the session conversation reach the group chat, once each.
        for text in env.collabNewAssistantMessages() { postOkidoki(text) }
        // A finished session run idles the stage again.
        if let id = session.activeRunID, let stored = env.store.run(id), !stored.status.isActive {
            session.activeRunID = nil
            broadcast(["type": "run", "run": NSNull()])
        }
    }

    /// okidoki speaks into the group chat: a reply, a question's answer, or why a task couldn't start.
    func postOkidoki(_ text: String) {
        guard let session else { return }
        let message = session.say(authorID: "okidoki", authorName: "okidoki", colorHex: "1FB57A", text: text, kind: .okidoki)
        broadcast(["type": "chat", "message": Self.encode(message)])
    }

    /// The run the session is now watching, set when a joiner's ask becomes a run.
    func watchRun(_ id: String) {
        session?.activeRunID = id
        scheduleBroadcast()
    }

    func broadcastWheelPublic() { broadcastWheel() }

    // MARK: Snapshot helpers

    private func snapshot() -> CollabSnapshot {
        guard let env, let session else {
            return CollabSnapshot(hostName: "Mac", startedAt: Date(), participants: [], wheelHolder: nil,
                                  wheelHolderName: nil, vm: CollabVM(phase: "stopped", running: false), run: nil, skills: [], chat: [])
        }
        return session.snapshot(vm: env.collabVM(), run: env.collabRunSnapshot(id: session.activeRunID), skills: env.collabSkillCards())
    }

    private static func encode<T: Encodable>(_ value: T) -> Any {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(value),
              let object = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
        return object
    }

    // MARK: Static

    /// The bundled joiner page and its assets. The build inlines JS/CSS into collab.html; only images
    /// and fonts remain as files. Paths are confined to the web folder — no traversal.
    private func serveStatic(_ connection: NWConnection, path: String) {
        let relative = (path == "/" || path.isEmpty) ? "collab.html" : String(path.drop { $0 == "/" })
        guard let base = Self.webRoot() else {
            reply(connection, status: 404, body: ["error": "the joiner page isn't built into this app"])
            return
        }
        let url = base.appendingPathComponent(relative).standardizedFileURL
        guard url.path.hasPrefix(base.standardizedFileURL.path),
              let data = try? Data(contentsOf: url) else {
            reply(connection, status: 404, body: ["error": "not found"])
            return
        }
        replyData(connection, status: 200, type: Self.contentType(for: url.pathExtension), data: data)
    }

    private static func webRoot() -> URL? {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web"),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("collab.html").path) {
            return bundled
        }
        // Running bare (`swift run`) there's no bundle; use the repo build if it exists.
        let repo = URL(fileURLWithPath: "web/dist")
        return FileManager.default.fileExists(atPath: repo.appendingPathComponent("collab.html").path) ? repo : nil
    }

    private static func contentType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "js": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        default: return "application/octet-stream"
        }
    }
}
