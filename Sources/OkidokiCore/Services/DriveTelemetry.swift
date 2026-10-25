import Foundation

/// Where the time went in one driving run: every model request and every action, with timings.
/// Written as JSON under `~/Library/Application Support/Okidoki/telemetry/<run id>.json` so the
/// scenario harness (`scripts/cu-eval.py`) and anyone debugging a slow run can read it. No screenshots.
public struct DriveTelemetry: Codable, Sendable {
    public struct Usage: Codable, Sendable, Equatable {
        public var input: Int
        public var cacheRead: Int
        public var cacheWrite: Int
        public var output: Int

        public init(input: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, output: Int = 0) {
            self.input = input; self.cacheRead = cacheRead; self.cacheWrite = cacheWrite; self.output = output
        }
    }

    /// One request to the model.
    public struct Call: Codable, Sendable {
        public var index: Int
        public var model: String
        public var captureMs: Int
        public var contextMs: Int
        /// Round trip to the brain, as the app saw it.
        public var brainMs: Int
        /// Time spent inside the model request, as the brain saw it.
        public var modelMs: Int?
        /// Time to the first action when the reply streams.
        public var firstActionMs: Int?
        public var requestBytes: Int
        public var actions: Int
        public var stopReason: String?
        public var usage: Usage?
        public var escalated: Bool

        public init(index: Int, model: String, captureMs: Int, contextMs: Int, brainMs: Int, modelMs: Int? = nil,
                    firstActionMs: Int? = nil, requestBytes: Int, actions: Int, stopReason: String? = nil,
                    usage: Usage? = nil, escalated: Bool = false) {
            self.index = index; self.model = model; self.captureMs = captureMs; self.contextMs = contextMs
            self.brainMs = brainMs; self.modelMs = modelMs; self.firstActionMs = firstActionMs
            self.requestBytes = requestBytes; self.actions = actions; self.stopReason = stopReason
            self.usage = usage; self.escalated = escalated
        }
    }

    /// One action the Mac carried out.
    public struct Action: Codable, Sendable {
        public var call: Int
        public var type: String
        public var performMs: Int
        /// Waiting for the screen to settle (or the fixed pause) after the action.
        public var settleMs: Int
        /// Whether the screen visibly changed, when that was measured.
        public var changed: Bool?
        public var ok: Bool
        public var result: String

        public init(call: Int, type: String, performMs: Int, settleMs: Int, changed: Bool? = nil, ok: Bool, result: String) {
            self.call = call; self.type = type; self.performMs = performMs; self.settleMs = settleMs
            self.changed = changed; self.ok = ok; self.result = result
        }
    }

    public var runID: String
    public var goal: String
    public var protocolVersion: String
    public var model: String
    public var startedAt: Date
    public var endedAt: Date?
    /// "done", "failed", or "cancelled".
    public var outcome: String?
    public var summary: String?
    public var calls: [Call]
    public var actions: [Action]
    /// File name of the screen captured after the run ended (scripted testing only), next to the JSON.
    public var finalFrame: String?

    public init(runID: String, goal: String, protocolVersion: String, model: String, startedAt: Date = Date()) {
        self.runID = runID; self.goal = goal; self.protocolVersion = protocolVersion; self.model = model
        self.startedAt = startedAt; self.calls = []; self.actions = []
    }

    public var totalMs: Int? {
        endedAt.map { Int(($0.timeIntervalSince(startedAt) * 1000).rounded()) }
    }
}

public enum DriveTelemetryStore {
    /// Older files are removed past this many runs.
    public static let keep = 200

    public static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Okidoki/telemetry", isDirectory: true)
    }

    public static func url(for runID: String, in directory: URL = directory) -> URL {
        directory.appendingPathComponent("\(safe(runID)).json")
    }

    @discardableResult
    public static func save(_ telemetry: DriveTelemetry, in directory: URL = directory) -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .custom { date, encoder in
                var container = encoder.singleValueContainer()
                try container.encode(stamp.string(from: date))
            }
            try encoder.encode(telemetry).write(to: url(for: telemetry.runID, in: directory), options: .atomic)
            prune(directory)
            return true
        } catch {
            return false
        }
    }

    public static func load(_ runID: String, in directory: URL = directory) -> DriveTelemetry? {
        guard let data = try? Data(contentsOf: url(for: runID, in: directory)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = stamp.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(text)"))
        }
        return try? decoder.decode(DriveTelemetry.self, from: data)
    }

    /// ISO 8601 with milliseconds, so step timings survive the round trip.
    nonisolated(unsafe) static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Saves an image next to the run's JSON and returns its file name.
    public static func saveFrame(_ data: Data, runID: String, ext: String, in directory: URL = directory) -> String? {
        let name = "\(safe(runID))-final.\(ext)"
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent(name), options: .atomic)
            return name
        } catch {
            return nil
        }
    }

    static func prune(_ directory: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let runs = files.filter { $0.pathExtension == "json" }
        guard runs.count > keep else { return }
        let dated = runs.map { url -> (URL, Date) in
            ((url), (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }.sorted { $0.1 < $1.1 }
        for (url, _) in dated.prefix(runs.count - keep) {
            try? fm.removeItem(at: url)
            let stem = url.deletingPathExtension().lastPathComponent
            for ext in ["jpg", "png"] {
                try? fm.removeItem(at: directory.appendingPathComponent("\(stem)-final.\(ext)"))
            }
        }
    }

    static func safe(_ id: String) -> String {
        String(id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }
}
