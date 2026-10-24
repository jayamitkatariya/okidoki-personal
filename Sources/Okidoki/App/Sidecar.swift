import AppKit
import Foundation
import OkidokiCore

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
    let port: Int
    let baseURL: URL

    private var process: Process?
    private var startedAt: Date?
    private var logHandle: FileHandle?
    private var intentionalStop = false
    private var healthTimer: Timer?
    /// True when a healthy brain answered on our port but we didn't spawn it (adopted leftover).
    private var adopted = false

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
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["OKIDOKI_BRAIN_PORT"] = String(port)
        env["NODE_ENV"] = "production"
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice
        openLog()
        let logHandle = self.logHandle
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            logHandle?.write(data)
        }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self, !self.intentionalStop else { return }
                self.status = .failed("brain exited (\(process.terminationStatus))")
                self.process = nil
            }
        }
        do {
            try process.run()
            self.process = process
            startedAt = Date()
            Task { await waitForHealth() }
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func stop() {
        intentionalStop = true
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

    func waitForHealth() async {
        for _ in 0..<25 {
            if await health() {
                status = .ready
                adopted = (process == nil)
                startHealthWatch()
                return
            }
            try? await Task.sleep(nanoseconds: 220_000_000)
        }
        if status == .starting { status = .failed("no answer on :\(port)") }
    }

    /// If we adopted a brain we didn't spawn (a leftover from a force-quit), watch it:
    /// once it dies (its own watchdog exits when its parent is gone), spawn our own.
    private func startHealthWatch() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.status.isReady, self.process == nil else { return }
                if !(await self.health()) {
                    self.status = .failed("the brain on :\(self.port) went away")
                    self.restart()
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    @discardableResult
    func health() async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.timeoutInterval = 1
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return false }
            lastHealth = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return true
        } catch {
            return false
        }
    }

    private func scriptURL() -> URL? {
        if let path = ProcessInfo.processInfo.environment["OKIDOKI_BRAIN_SCRIPT"] {
            return URL(fileURLWithPath: path)
        }
        if let bundled = Bundle.main.url(forResource: "server", withExtension: "js", subdirectory: "brain") {
            return bundled
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            cwd.appendingPathComponent("brain/dist/server.js"),
            cwd.appendingPathComponent("../brain/dist/server.js"),
            URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/okidoki/brain/dist/server.js"),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
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

struct BrainNativeEvent: Encodable {
    var title: String
    var start: String
}

struct BrainNativeContext: Encodable {
    var now: String
    var events: [BrainNativeEvent]
    var reminders: [String]
    var frontWindow: String
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
    var freedBytes: Int64?
    var success: Bool
}

@MainActor
final class BrainClient {
    static let shared = BrainClient()
    private var baseURL: URL { BrainClient.resolvedBaseURL }
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
               installedTools: [String], frontWindow: String) async -> BrainThinkEnvelope? {
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
            screenshotBase64: request.screenshotPNG?.base64EncodedString(),
            screenshotMediaType: request.screenshotPNG == nil ? nil : "image/png",
            documentText: request.documentText,
            documentName: request.attachmentName,
            clipboardText: request.clipboardText,
            installedTools: installedTools,
            nativeContext: BrainNativeContext(now: ISO8601DateFormatter().string(from: Date()),
                                              events: events, reminders: [], frontWindow: frontWindow)
        )
        var urlRequest = URLRequest(url: baseURL.appendingPathComponent("think"))
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = Keychain.get("anthropic"), !key.isEmpty {
            urlRequest.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            urlRequest.httpBody = try JSONEncoder().encode(payload)
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONDecoder().decode(BrainThinkEnvelope.self, from: data)
        } catch {
            return nil
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
        request.httpMethod = "POST"
        request.timeoutInterval = 60 * 30
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            var summary = ""
            var freed: Int64?
            var success = false
            var failure: String?
            var currentEvent = ""
            for try await line in bytes.lines {
                if line.hasPrefix("event:") {
                    currentEvent = line.replacingOccurrences(of: "event:", with: "").trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    let dataString = line.replacingOccurrences(of: "data:", with: "").trimmingCharacters(in: .whitespaces)
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
                    case "error":
                        failure = json["message"] as? String ?? "the run failed"
                        onEvent(.error(failure ?? "the run failed"))
                    default:
                        break
                    }
                }
            }
            if let failure { return BrainExecResult(summary: failure, freedBytes: nil, success: false) }
            return BrainExecResult(summary: summary, freedBytes: freed, success: success)
        } catch {
            return nil
        }
    }

    func stop(runID: String) {
        post("stop", body: ["runId": runID])
    }

    // MARK: - Computer use

    struct BrainComputerEnvelope: Decodable {
        var action: ComputerAction?
        var usedModel: Bool?
        var error: String?
    }

    func computer(goal: String, step: Int, appName: String, screen box: OkidokiCore.ScreenBox,
                  imageWidth: Double, imageHeight: Double, history: [[String: Any]],
                  screenshotPNG: Data?, model: String) async -> ComputerAction? {
        var body: [String: Any] = [
            "goal": goal,
            "step": step,
            "app": appName,
            "screen": ["x": box.x, "y": box.y, "width": box.width, "height": box.height],
            "imageWidth": imageWidth,
            "imageHeight": imageHeight,
            "history": history,
            "settings": ["claudeModel": model],
        ]
        if let screenshotPNG {
            body["screenshotBase64"] = screenshotPNG.base64EncodedString()
        }
        var request = URLRequest(url: baseURL.appendingPathComponent("computer"))
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = Keychain.get("anthropic"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            let envelope = try JSONDecoder().decode(BrainComputerEnvelope.self, from: data)
            return envelope.action
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
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request).resume()
    }

    func tools() async -> [[String: Any]] {
        var request = URLRequest(url: baseURL.appendingPathComponent("tools"))
        request.timeoutInterval = 5
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tools = json["tools"] as? [[String: Any]] else { return [] }
        return tools
    }
}
