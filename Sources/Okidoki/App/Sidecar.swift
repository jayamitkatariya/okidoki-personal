import AppKit
import Foundation
import OkidokiCore

enum BrainConnection {
    static let token = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_TOKEN"] ?? UUID().uuidString
}

enum SidecarStatus: Equatable {
    case idle
    case starting
    case ready
    case runtimeMissing
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "not started"
        case .starting: return "starting…"
        case .ready: return "ready"
        case .runtimeMissing: return "bun not found"
        case .failed(let message): return "offline · \(message)"
        }
    }

    var isReady: Bool { self == .ready }
}

@MainActor
final class BrainSidecar: ObservableObject {
    @Published private(set) var status: SidecarStatus = .idle
    @Published private(set) var lastHealth: [String: Any]?
    private(set) var port: Int
    private(set) var baseURL: URL

    private var process: Process?
    private var logHandle: FileHandle?
    private var intentionalStop = false
    private var healthTimer: Timer?
    /// True when a healthy brain answered on our port but we didn't spawn it (adopted leftover).
    private var adopted = false
    /// Crashes in a row; the relaunch waits longer each time and gives up after the list runs out.
    private var relaunches = 0
    private static let relaunchDelays: [Double] = [1, 3, 10, 30, 60]
    private var readySince: Date?
    /// Health probes missed in a row by a brain we spawned; a few mean it's hung, not busy.
    private var healthMisses = 0

    init() {
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_URL"], let url = URL(string: override) {
            self.baseURL = url
            self.port = url.port ?? 4319
        } else {
            let port = Int(ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_PORT"] ?? "4319") ?? 4319
            self.port = port
            self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        }
    }

    func start() {
        if ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_URL"] != nil {
            status = .starting
            Task { await waitForHealth() }
            return
        }
        guard process == nil else { return }
        guard let bun = ShellRunner.which("bun") else {
            status = .runtimeMissing
            return
        }
        guard let script = scriptURL() else {
            status = .failed("brain script missing")
            return
        }
        status = .starting
        intentionalStop = false
        Task { [weak self] in
            guard let self else { return }
            // Another copy of okidoki (a second build, a leftover from a force-quit) may already own
            // the port with its own token. Spawning there fails with EADDRINUSE and every request
            // would hit a brain that answers 401, so move to a free port instead.
            if await probe() == .foreign, let free = Self.freePort(after: port) {
                port = free
                baseURL = URL(string: "http://127.0.0.1:\(free)")!
                BrainClient.shared.baseURL = baseURL
            }
            spawn(bun: bun, script: script)
        }
    }

    private func spawn(bun: String, script: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["OKIDOKI_BRAIN_PORT"] = String(port)
        env["NODE_ENV"] = "production"
        env["PATH"] = ShellRunner.shared.pathEnvironment + ":" + (env["PATH"] ?? "")
        env["OKIDOKI_BRAIN_TOKEN"] = BrainConnection.token
        if let askpass = AskPass.path { env["OKIDOKI_ASKPASS"] = askpass }
        for (name, value) in ServiceSecrets.brainEnvironment where !value.isEmpty {
            env[name] = value
        }
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        openLog()
        let logHandle = self.logHandle
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            // Empty data is end-of-file; without clearing the handler Foundation keeps calling it.
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            try? logHandle?.write(contentsOf: data)
        }
        process.terminationHandler = { [weak self] process in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                // A restart may already have spawned a newer brain; only the current one's exit counts.
                guard let self, !self.intentionalStop, process === self.process else { return }
                self.process = nil
                self.relaunchAfterCrash(reason: "brain exited (\(process.terminationStatus))")
            }
        }
        do {
            try process.run()
            self.process = process
            Task { await waitForHealth() }
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func stop() {
        intentionalStop = true
        (process?.standardOutput as? Pipe)?.fileHandleForReading.readabilityHandler = nil
        process?.terminate()
        process = nil
        status = .idle
        healthTimer?.invalidate()
        healthTimer = nil
        adopted = false
        try? logHandle?.close()
        logHandle = nil
    }

    func restart() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.start() }
    }

    /// A brain that died on its own comes back by itself, a little slower each time. One that was
    /// healthy for a while earns a fresh count; five crashes in a row and it stays down, and the
    /// dashboard says so.
    private func relaunchAfterCrash(reason: String) {
        if let since = readySince, Date().timeIntervalSince(since) > 120 { relaunches = 0 }
        readySince = nil
        healthMisses = 0
        guard relaunches < Self.relaunchDelays.count else {
            status = .failed("\(reason) — gave up restarting")
            return
        }
        let delay = Self.relaunchDelays[relaunches]
        relaunches += 1
        status = .failed("\(reason) — restarting in \(Int(delay))s")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.process == nil, !self.intentionalStop else { return }
            self.start()
        }
    }

    func waitForHealth() async {
        for _ in 0..<25 {
            if await health() {
                status = .ready
                adopted = (process == nil)
                readySince = Date()
                healthMisses = 0
                startHealthWatch()
                return
            }
            try? await Task.sleep(nanoseconds: 220_000_000)
        }
        if status == .starting { status = .failed("no answer on :\(port)") }
    }

    /// Keeps an eye on the brain once it's up. An adopted one (a leftover from a force-quit) is
    /// replaced the moment it goes away; our own is restarted when it stops answering for a while —
    /// a hung process still holds the port, so a crash isn't the only way to lose it.
    private func startHealthWatch() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.status.isReady else { return }
                if await self.health() {
                    self.healthMisses = 0
                    return
                }
                if self.process == nil {
                    self.status = .failed("the brain on :\(self.port) went away")
                    self.restart()
                    return
                }
                self.healthMisses += 1
                guard self.healthMisses >= 3 else { return }
                self.healthMisses = 0
                self.status = .failed("the brain stopped answering — restarting")
                self.restart()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    @discardableResult
    func health() async -> Bool {
        await probe() == .ours
    }

    enum Probe: Equatable {
        /// Nothing answers on the port.
        case silent
        /// A brain that knows our token.
        case ours
        /// Something else is listening: a brain started by another copy of okidoki, or an unrelated server.
        case foreign
    }

    func probe() async -> Probe {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 1
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .foreign }
            guard http.statusCode == 200 else { return .foreign }
            lastHealth = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return .ours
        } catch {
            return .silent
        }
    }

    /// The first port after `start` that nothing is bound to, within a short range.
    nonisolated static func freePort(after start: Int) -> Int? {
        for candidate in (start + 1)...(start + 40) {
            let socketFD = socket(AF_INET, SOCK_STREAM, 0)
            guard socketFD >= 0 else { continue }
            defer { close(socketFD) }
            var reuse: Int32 = 1
            setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = in_port_t(UInt16(candidate).bigEndian)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            if bound == 0 { return candidate }
        }
        return nil
    }

    private func scriptURL() -> URL? {
        if let path = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_SCRIPT"] {
            return URL(fileURLWithPath: path)
        }
        if let bundled = Bundle.main.url(forResource: "server", withExtension: "js", subdirectory: "brain") {
            return bundled
        }
        #if DEBUG
        // Development only: a release build runs the brain it ships, never one found lying around.
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            cwd.appendingPathComponent("brain/dist/server.js"),
            cwd.appendingPathComponent("../brain/dist/server.js"),
            URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/okidoki/brain/dist/server.js"),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
        #else
        return nil
        #endif
    }

    private func openLog() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Okidoki", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let url = support.appendingPathComponent("brain.log")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: url)
        logHandle?.seekToEndOfFile()
    }
}

// MARK: - Client

struct BrainThinkEnvelope: Decodable {
    var decision: BrainDecision
    var usedModel: Bool
    var error: String?
}

struct BrainErrorBody: Decodable {
    var error: String
}

/// What came back from `/think`. Only an unreachable brain is worth asking the model again from
/// the Mac; a brain that answered with an error or ran out of time already spent the wait.
enum BrainThinkOutcome {
    case answered(BrainThinkEnvelope)
    case failed(String)
    case unreachable
}

struct BrainNativeEvent: Encodable {
    var title: String
    var start: String
}

struct BrainNativeContext: Encodable {
    var now: String
    var events: [BrainNativeEvent]
    var reminders: [String]
    var frontWindow: String
    /// The browser tab in front, when the current app is a browser.
    var pageTitle: String?
    var pageURL: String?
    /// True when the screenshot is the whole display taken at summon time, not something they circled.
    var screenshotIsDisplay: Bool
}

struct BrainMessage: Encodable {
    var role: String
    var text: String
}

struct BrainSettingsPayload: Encodable {
    var claudeModel: String
    var customInstructions: String
    var selectedAgent: String
    var defaultInput: String
    var voiceEnabled: Bool
}

struct BrainAccountPayload: Encodable {
    var name: String
    var kind: String
}

/// An MCP server as the brain needs it, secrets included (read from the Mac's key file per request).
struct BrainMCPServerPayload: Encodable {
    var id: String
    var name: String
    var transport: String
    var command: String
    var args: [String]
    var url: String
    var env: [String: String]
    var headers: [String: String]
}

struct BrainConnectorsPayload: Encodable {
    var apify: Bool
    var mcpServers: [BrainMCPServerPayload]
}

struct MCPToolSummary: Codable, Equatable {
    var name: String
    var description: String
}

/// What the brain found when it connected to an MCP server; shown in the Toolbox.
struct MCPServerStatus: Codable, Equatable {
    var id: String
    var ok: Bool
    var error: String?
    var tools: [MCPToolSummary]
}

/// What the brain's Moss index holds, as reported by `/memory/status` and after each sync.
struct MemoryIndexStatus: Codable, Equatable {
    var ready: Bool = false
    var documents: Int = 0
    var notes: Int = 0
    var messages: Int = 0
    var tools: Int = 0
    var lastSyncAt: Date?
    var error: String?
}

struct BrainConnectorResult: Decodable {
    var ok: Bool
    var answer: String
    var summary: String
    var output: String
    var error: String?
}

struct BrainThinkPayload: Encodable {
    var text: String
    var appName: String
    var bundleID: String
    var threadID: String?
    var source: String
    var account: BrainAccountPayload
    var settings: BrainSettingsPayload
    var memory: [String]
    var history: [BrainMessage]
    var screenshotBase64: String?
    var screenshotMediaType: String?
    var documentText: String
    var documentName: String
    var clipboardText: String
    var installedTools: [String]
    var nativeContext: BrainNativeContext
    var connectors: BrainConnectorsPayload
    /// The current account, so the brain's recall stays within it (plus shared memories).
    var accountId: String
}

/// What the brain's Moss memory index is built from: the Mac's own items, as stored.
struct BrainMemorySyncPayload: Encodable {
    var projectId: String
    var projectKey: String
    var cacheDir: String
    var memories: [MemoryIndexPayload.Note]
    var threads: [MemoryIndexPayload.Thread]
    var runs: [MemoryIndexPayload.RunEntry]
    var skills: [MemoryIndexPayload.SkillEntry]
}

enum BrainExecEvent {
    case output(String)
    case step(index: Int, status: String, title: String)
    case started
    case done(summary: String, freedBytes: Int64?, code: Int32)
    case error(String)
}

struct BrainExecResult {
    var summary: String
    var success: Bool
}

@MainActor
final class BrainClient {
    static let shared = BrainClient()
    /// Where the brain answers. The sidecar moves this when it has to start on another port.
    var baseURL: URL = BrainClient.resolvedBaseURL
    private static var resolvedBaseURL: URL {
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_URL"], let url = URL(string: override) {
            return url
        }
        let port = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_PORT"] ?? "4319"
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    private init() {}

    func think(text: String, request: BrainRequest, history: [BrainMessage], memory: [String],
               events: [BrainNativeEvent], settings: AppSettings, account: Account,
               installedTools: [String], frontWindow: String,
               connectors: BrainConnectorsPayload) async -> BrainThinkOutcome {
        // What they circled wins; otherwise the display shot from summon time gives the brain context.
        let circled = request.screenshotPNG
        let screenshot = circled ?? request.screen?.screenshotPNG
        let page = request.screen
        let payload = BrainThinkPayload(
            text: text,
            appName: request.appName,
            bundleID: request.bundleID,
            threadID: request.threadID,
            source: request.source,
            account: BrainAccountPayload(name: account.name, kind: account.kind.rawValue),
            settings: BrainSettingsPayload(claudeModel: settings.claudeModel,
                                           customInstructions: settings.customInstructions,
                                           selectedAgent: settings.selectedAgent.rawValue,
                                           defaultInput: settings.defaultInput.rawValue,
                                           voiceEnabled: settings.voiceEnabled),
            memory: memory,
            history: history,
            screenshotBase64: screenshot?.base64EncodedString(),
            screenshotMediaType: screenshot == nil ? nil : "image/png",
            documentText: request.documentText,
            documentName: request.attachmentName,
            clipboardText: request.clipboardText,
            installedTools: installedTools,
            nativeContext: BrainNativeContext(now: ISO8601DateFormatter().string(from: Date()),
                                              events: events, reminders: [], frontWindow: frontWindow,
                                              pageTitle: page?.pageTitle.isEmpty == false ? page?.pageTitle : nil,
                                              pageURL: page?.pageURL.isEmpty == false ? page?.pageURL : nil,
                                              screenshotIsDisplay: circled == nil && screenshot != nil),
            connectors: connectors,
            accountId: account.id
        )
        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("think"))
        urlRequest.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            urlRequest.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            urlRequest.httpBody = try JSONEncoder().encode(payload)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            guard (200..<300).contains(http.statusCode) else {
                let body = (try? JSONDecoder().decode(BrainErrorBody.self, from: data))?.error
                    ?? String(decoding: data.prefix(160), as: UTF8.self)
                return .failed("the brain answered \(http.statusCode)" + (body.isEmpty ? "" : ": \(body)"))
            }
            return .answered(try JSONDecoder().decode(BrainThinkEnvelope.self, from: data))
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .networkConnectionLost, .cannotFindHost:
                return .unreachable
            case .timedOut:
                return .failed("the brain took too long")
            default:
                return .failed(error.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    func execute(runID: String, kind: RunKind, commands: [String], agent: CodingAgentID?,
                 prompt: String, workingDirectory: String?, extraArgs: String,
                 onEvent: @MainActor @escaping (BrainExecEvent) -> Void) async -> BrainExecResult? {
        let executeKind: String
        switch kind {
        case .coding: executeKind = "coding"
        case .background: executeKind = "background"
        default: executeKind = "terminal"
        }
        var body: [String: Any] = [
            "runId": runID,
            "kind": executeKind,
            "commands": commands,
            "workingDirectory": workingDirectory ?? NSHomeDirectory(),
            "prompt": prompt,
        ]
        if let agent { body["agent"] = agent.rawValue }
        if !extraArgs.isEmpty { body["extraArgs"] = extraArgs }
        var request = URLRequest(url: baseURL.appendingPathComponent("execute"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 60 * 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return BrainExecResult(summary: "The execution service rejected this job. Review the plan and try again.", success: false)
            }
            var summary = ""
            var freed: Int64?
            var success = false
            var failure: String?
            var currentEvent = ""
            for try await line in bytes.lines {
                if line.hasPrefix("event:") {
                    currentEvent = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    let dataString = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    guard let data = dataString.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    switch currentEvent {
                    case "output":
                        if let text = json["text"] as? String { onEvent(.output(text)) }
                    case "step":
                        let index = json["index"] as? Int ?? 0
                        let status = json["status"] as? String ?? "running"
                        let title = json["title"] as? String ?? ""
                        onEvent(.step(index: index, status: status, title: title))
                    case "started":
                        onEvent(.started)
                    case "done":
                        summary = json["summary"] as? String ?? "done."
                        if let bytes = json["freedBytes"] as? Int64 { freed = bytes }
                        else if let number = json["freedBytes"] as? NSNumber { freed = number.int64Value }
                        success = true
                        onEvent(.done(summary: summary, freedBytes: freed, code: Int32(json["code"] as? Int ?? 0)))
                    case "cancelled":
                        failure = "stopped by you"
                    case "error":
                        failure = json["message"] as? String ?? "the run failed"
                        onEvent(.error(failure ?? "the run failed"))
                    default:
                        break
                    }
                }
            }
            if let failure { return BrainExecResult(summary: failure, success: false) }
            return BrainExecResult(summary: success ? summary : "The connection ended before the result arrived. Check this run before trying again.", success: success)
        } catch {
            return BrainExecResult(summary: "Lost connection to the job. It may still be running. Stop it or check its output before trying again.", success: false)
        }
    }

    func stop(runID: String) {
        post("stop", body: ["runId": runID])
    }

    // MARK: - Computer use

    /// One action for a recorded skill's rescue. The driving loop uses `computerTurn` (BrainDriving.swift).
    func computer(goal: String, step: Int, appName: String, windowTitle: String = "",
                  screen box: OkidokiCore.ScreenBox,
                  imageWidth: Double, imageHeight: Double, history: [[String: Any]],
                  controls: [[String: Any]] = [],
                  scripting: String = "",
                  screenshotPNG: Data?, previousPNG: Data? = nil,
                  referencePNG: Data? = nil,
                  zoom: ComputerUseService.Zoom? = nil,
                  canClick: Bool = true, canSee: Bool = true,
                  remote: Bool = false,
                  model: String) async -> ComputerAction? {
        await computerTurn(goal: goal, step: step, appName: appName, windowTitle: windowTitle, screen: box,
                           imageWidth: imageWidth, imageHeight: imageHeight, history: history, controls: controls,
                           scripting: scripting, screenshotPNG: screenshotPNG, previousPNG: previousPNG,
                           referencePNG: referencePNG, zoom: zoom, canClick: canClick, canSee: canSee,
                           remote: remote, model: model).action
    }

    struct TeachStepEnvelope: Decodable {
        var step: TeachLiveStep?
        var usedModel: Bool?
        var error: String?
    }

    /// One live tutoring step: the model looks at the screen and the log and points at the next thing.
    func teachStep(_ request: TeachStepRequest) async -> TeachLiveStep? {
        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("teach/step"))
        urlRequest.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 70
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            urlRequest.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            urlRequest.httpBody = try JSONEncoder().encode(request)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(TeachStepEnvelope.self, from: data).step
        } catch {
            return nil
        }
    }

    /// Zoomed second look at one control. `found == false` keeps the first guess.
    func teachRefine(_ request: TeachRefineRequest) async -> TeachRefineResult? {
        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("teach/refine"))
        urlRequest.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            urlRequest.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            urlRequest.httpBody = try JSONEncoder().encode(request)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(TeachRefineResult.self, from: data)
        } catch {
            return nil
        }
    }

    struct ConceptFollowEnvelope: Decodable {
        var follow: ConceptFollowUp?
        var error: String?
    }

    /// What the streaming concept endpoint reports, in order: maybe an intro, then a lesson or an error.
    enum ConceptStreamEvent {
        case intro(title: String, intro: String)
        case lesson(ConceptLesson)
        case error(String)
    }

    private struct ConceptStreamLine: Decodable {
        var type: String
        var title: String?
        var intro: String?
        var lesson: ConceptLesson?
        var error: String?
    }

    /// A narrated 2D/3D lesson for the stage; the sidecar also fetches real molecule data and a
    /// photo card. The title and intro arrive as soon as the model has written them, so narration
    /// can start while the scene is still being drawn.
    func teachConceptStream(topic: String, context: String, pageTitle: String?, pageURL: String?,
                            screenshotBase64: String?, imageWidth: Double, imageHeight: Double,
                            language: String?, model: String) -> AsyncStream<ConceptStreamEvent> {
        var body: [String: Any] = ["topic": topic, "context": context, "imageWidth": imageWidth, "imageHeight": imageHeight, "model": model]
        if let pageTitle { body["pageTitle"] = pageTitle }
        if let pageURL { body["pageURL"] = pageURL }
        if let screenshotBase64 { body["screenshotBase64"] = screenshotBase64 }
        if let language { body["language"] = language }
        var request = URLRequest(url: baseURL.appendingPathComponent("teach/concept/stream"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 130
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return AsyncStream { continuation in
            let task = Task {
                var delivered = false
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        continuation.yield(.error("the brain didn't answer"))
                        continuation.finish()
                        return
                    }
                    for try await line in bytes.lines {
                        guard let data = line.data(using: .utf8),
                              let event = try? JSONDecoder().decode(ConceptStreamLine.self, from: data) else { continue }
                        switch event.type {
                        case "intro":
                            continuation.yield(.intro(title: event.title ?? "", intro: event.intro ?? ""))
                        case "lesson":
                            if let lesson = event.lesson { continuation.yield(.lesson(lesson)); delivered = true }
                        case "error":
                            continuation.yield(.error(event.error ?? "couldn't build the lesson")); delivered = true
                        default:
                            break
                        }
                    }
                } catch {
                    if !delivered { continuation.yield(.error("the brain didn't answer")) }
                }
                if !delivered { continuation.yield(.error("the lesson never arrived")) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func teachConceptFollow(topic: String, question: String, partID: String?, partName: String?,
                            sceneSummary: String, language: String?, model: String) async -> ConceptFollowUp? {
        var body: [String: Any] = ["topic": topic, "question": question, "sceneSummary": sceneSummary, "model": model]
        if let partID { body["partId"] = partID }
        if let partName { body["partName"] = partName }
        if let language { body["language"] = language }
        guard let data = await postJSON("teach/concept/follow", body: body, timeout: 70) else { return nil }
        return (try? JSONDecoder().decode(ConceptFollowEnvelope.self, from: data))?.follow
    }

    private func postJSON(_ path: String, body: [String: Any], timeout: TimeInterval) async -> Data? {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return data
        } catch {
            return nil
        }
    }

    func pause(runID: String) {
        post("pause", body: ["runId": runID])
    }

    func resume(runID: String) {
        post("resume", body: ["runId": runID])
    }

    private func post(_ path: String, body: [String: Any]) {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request).resume()
    }

    // MARK: - Connectors

    func mcpTools(servers: [BrainMCPServerPayload], reconnect: Bool = false) async -> [MCPServerStatus]? {
        struct Envelope: Decodable { var servers: [MCPServerStatus] }
        var request = URLRequest(url: baseURL.appendingPathComponent("mcp/tools"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        do {
            let list = try JSONSerialization.jsonObject(with: JSONEncoder().encode(servers))
            request.httpBody = try JSONSerialization.data(withJSONObject: ["servers": list, "reconnect": reconnect])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(Envelope.self, from: data).servers
        } catch {
            return nil
        }
    }

    /// Sends the Mac's items to the brain's memory index; the brain embeds only what changed.
    /// Sends the Mac's data to the index. Returns the index status afterwards (`ok` false when the sync failed),
    /// or nil when the brain couldn't be reached.
    func memorySync(_ payload: BrainMemorySyncPayload) async -> (ok: Bool, status: MemoryIndexStatus)? {
        var request = URLRequest(url: baseURL.appendingPathComponent("memory/sync"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let body = try? encoder.encode(payload) else { return nil }
        request.httpBody = body
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = try? Self.statusDecoder.decode(MemoryIndexStatus.self, from: data) else { return nil }
        return (json["ok"] as? Bool == true, status)
    }

    /// The index as the brain sees it, without sending anything. Nil when the brain is unreachable.
    func memoryStatus() async -> MemoryIndexStatus? {
        var request = URLRequest(url: baseURL.appendingPathComponent("memory/status"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return try? Self.statusDecoder.decode(MemoryIndexStatus.self, from: data)
    }

    private static let statusDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        // JavaScript writes fractional seconds; accept both forms.
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer()
            let text = try value.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: text) { return date }
            throw DecodingError.dataCorruptedError(in: value, debugDescription: "not an ISO 8601 date")
        }
        return decoder
    }()

    func checkApify(token: String) async -> (ok: Bool, detail: String) {
        var request = URLRequest(url: baseURL.appendingPathComponent("apify/check"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (false, "the brain isn't running")
        }
        if json["ok"] as? Bool == true { return (true, json["username"] as? String ?? "connected") }
        return (false, json["error"] as? String ?? "Apify didn't answer")
    }

    /// Runs an approved Apify or MCP call. `callJSON` is the brain's own call, handed back untouched.
    func runConnector(runID: String, prompt: String, callJSON: String, apifyToken: String?,
                      servers: [BrainMCPServerPayload], spendingLimit: Double, model: String) async -> BrainConnectorResult? {
        guard let callData = callJSON.data(using: .utf8),
              let call = try? JSONSerialization.jsonObject(with: callData),
              let serverData = try? JSONEncoder().encode(servers),
              let serverList = try? JSONSerialization.jsonObject(with: serverData) else { return nil }
        var body: [String: Any] = [
            "runId": runID,
            "prompt": prompt,
            "call": call,
            "mcpServers": serverList,
            "spendingLimit": spendingLimit,
            "settings": ["claudeModel": model],
        ]
        if let apifyToken, !apifyToken.isEmpty { body["apifyToken"] = apifyToken }
        var request = URLRequest(url: baseURL.appendingPathComponent("connector/run"))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = 60 * 6
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(BrainConnectorResult.self, from: data)
        } catch {
            return nil
        }
    }
}
