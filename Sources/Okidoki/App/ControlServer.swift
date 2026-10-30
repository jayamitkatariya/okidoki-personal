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
        let wanted = UInt16(ProcessInfo.processInfo.environment["OKIDOKI_CONTROL_PORT"] ?? "") ?? Self.defaultPort
        for candidate in [wanted, 0] {
            guard let port = NWEndpoint.Port(rawValue: candidate) else { continue }
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
            parameters.allowLocalEndpointReuse = true
            guard let listener = try? NWListener(using: parameters) else { continue }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection) }
            }
            listener.stateUpdateHandler = { [weak self] state in
                guard case .ready = state else { return }
                Task { @MainActor in
                    guard let self, let bound = self.listener?.port?.rawValue else { return }
                    self.port = bound
                    self.writeInfo()
                }
            }
            listener.start(queue: .main)
            self.listener = listener
            return
        }
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

    private func handle(_ request: Request) async -> (Int, Any) {
        // Browsers send an Origin; local tools don't. A page on the web must never drive this Mac.
        guard request.headers["origin"] == nil, request.headers["authorization"] == "Bearer \(token)" else {
            return (401, ["error": "unauthorized"])
        }
        guard let env else { return (409, ["error": "okidoki is shutting down"]) }
        switch (request.method, request.path) {
        case ("GET", "/skills"):
            return (200, ["skills": env.store.activeSkills.map { skill in
                ["id": skill.id, "name": skill.name, "summary": skill.summary, "steps": skill.steps.count,
                 "parameters": ParameterFill.names(in: skill.steps)] as [String: Any]
            }])
        case ("POST", "/replay"):
            let name = (request.body["skill"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let skill = env.store.activeSkills.first(where: { $0.id == name })
                    ?? env.store.activeSkills.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
                return (404, ["error": "no skill called “\(name)”", "skills": env.store.activeSkills.map(\.name)])
            }
            let times = max(1, min(request.body["times"] as? Int ?? 1, 100))
            let values = (request.body["values"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" }
            let thread = env.store.threadForContext(app: "mac", topic: "skills", text: "replay \(skill.name)")
            env.startReplayFromChat(skill, times: times, threadID: thread.id, source: "control",
                                    values: values.isEmpty ? [] : Array(repeating: values, count: times))
            return (200, ["ok": true, "skill": skill.name, "times": times,
                          "note": "started; okidoki may ask for an okay in the notch first"])
        case ("GET", "/vault/search"):
            let hits = env.vault.search(request.query["q"] ?? "", limit: 10)
            return (200, ["folder": env.vault.folderURL.path, "files": hits.map { file in
                ["name": file.name, "folder": file.folder, "path": env.vault.folderURL.appendingPathComponent(file.id).path,
                 "size": file.size, "modifiedAt": ISO8601DateFormatter().string(from: file.modifiedAt)] as [String: Any]
            }])
        case ("POST", "/ask"):
            let text = (request.body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return (400, ["error": "nothing to ask"]) }
            env.askFromDashboard(text)
            return (200, ["ok": true, "note": "okidoki is on it; anything risky waits for an okay in the notch"])
        default:
            return (404, ["error": "no such route"])
        }
    }
}
