import Foundation

// MARK: - Accounts

public enum AccountKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case personal
    case work

    public var id: String { rawValue }
    public var label: String { self == .personal ? "personal" : "work" }
}

public struct Account: Identifiable, Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var email: String
    public var kind: AccountKind
    public var colorHex: String
    public var createdAt: Date

    public init(id: String = UUID().uuidString, name: String, email: String,
                kind: AccountKind = .personal, colorHex: String = "44E45E", createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.email = email
        self.kind = kind
        self.colorHex = colorHex
        self.createdAt = createdAt
    }

    public var initials: String {
        let parts = name.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first }
        return String(letters).uppercased()
    }

    public var firstName: String {
        name.split(separator: " ").first.map(String.init) ?? name
    }
}

// MARK: - Settings

public enum InputMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case voice
    case typing
    public var id: String { rawValue }
    public var label: String { self == .voice ? "voice" : "typing" }
}

public enum AppAppearance: String, Codable, CaseIterable, Identifiable, Sendable {
    case system, light, dark
    public var id: String { rawValue }
}

public enum NotificationStyle: String, Codable, CaseIterable, Identifiable, Sendable {
    case everything
    case approvalsAndDone
    case silent
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .everything: return "everything"
        case .approvalsAndDone: return "approvals + finished"
        case .silent: return "silent"
        }
    }
}

public enum DrawingStyle: String, Codable, CaseIterable, Identifiable, Sendable {
    case ink, marker, pencil
    public var id: String { rawValue }
}

public struct AppSettings: Codable, Equatable, Sendable {
    public var okidokiEnabled: Bool = true
    public var defaultInput: InputMode = .typing
    public var voiceID: String = "sarah"
    public var voiceSpeed: Double = 1.0
    public var voiceEnabled: Bool = true
    public var captions: Bool = true
    public var confirmOK: Bool = true
    public var selectedAgent: CodingAgentID = .claude
    public var customInstructions: String = ""

    public var backgroundMode: Bool = true
    public var screenBorrowing: Bool = true
    public var proactiveNudges: Bool = false

    public var quietMode: Bool = false
    public var notchEnabled: Bool = true
    public var notificationStyle: NotificationStyle = .everything
    public var notchExternalPosition: String = "top-center"

    public var appearance: AppAppearance = .light
    public var cursorGlowHex: String = "44E45E"
    public var glowEnabled: Bool = true
    public var shakeSensitivity: Double = 0.65
    public var drawingStyle: DrawingStyle = .ink
    public var drawingColorHex: String = "44E45E"

    public var blockedApps: [String] = []
    public var alwaysAsk: [String] = []
    public var alwaysAllow: [String] = []
    public var spendingLimit: Double = 25
    public var hideInScreenshots: Bool = true

    public var appleCalendar: Bool = false
    public var appleReminders: Bool = false
    public var appleNotes: Bool = false
    public var automationGranted: Bool = false
    public var inputMonitoringGranted: Bool = false

    public var convexSiteURL: String = ""
    public var syncEnabled: Bool = false
    public var lastSyncAt: Date? = nil

    public var onboardingComplete: Bool = false
    public var tourComplete: Bool = false
    public var showedWelcome: Bool = false

    public var claudeModel: String = "claude-sonnet-4-5"
    public var agentExtraArgs: [String: String] = [:]
    public var lastWorkingDirectory: String = ""

    public init() {}

    enum CodingKeys: String, CodingKey {
        case okidokiEnabled, defaultInput, voiceID, voiceSpeed, voiceEnabled, captions, confirmOK
        case selectedAgent, customInstructions, backgroundMode, screenBorrowing, proactiveNudges
        case quietMode, notchEnabled, notificationStyle, notchExternalPosition, appearance
        case cursorGlowHex, glowEnabled, shakeSensitivity, drawingStyle, drawingColorHex
        case blockedApps, alwaysAsk, alwaysAllow, spendingLimit, hideInScreenshots
        case appleCalendar, appleReminders, appleNotes, automationGranted, inputMonitoringGranted
        case convexSiteURL, syncEnabled, lastSyncAt, onboardingComplete, tourComplete, showedWelcome
        case claudeModel, agentExtraArgs, lastWorkingDirectory
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func bool(_ key: CodingKeys, _ fallback: Bool) -> Bool { (try? c.decodeIfPresent(Bool.self, forKey: key)) ?? nil ?? fallback }
        func string(_ key: CodingKeys, _ fallback: String) -> String { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil ?? fallback }
        func double(_ key: CodingKeys, _ fallback: Double) -> Double { (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil ?? fallback }

        okidokiEnabled = bool(.okidokiEnabled, true)
        defaultInput = (try? c.decodeIfPresent(InputMode.self, forKey: .defaultInput)) .flatMap { $0 } ?? .typing
        voiceID = string(.voiceID, "sarah")
        voiceSpeed = double(.voiceSpeed, 1.0)
        voiceEnabled = bool(.voiceEnabled, true)
        captions = bool(.captions, true)
        confirmOK = bool(.confirmOK, true)
        selectedAgent = (try? c.decodeIfPresent(CodingAgentID.self, forKey: .selectedAgent)).flatMap { $0 } ?? .claude
        customInstructions = string(.customInstructions, "")
        backgroundMode = bool(.backgroundMode, true)
        screenBorrowing = bool(.screenBorrowing, true)
        proactiveNudges = bool(.proactiveNudges, false)
        quietMode = bool(.quietMode, false)
        notchEnabled = bool(.notchEnabled, true)
        notificationStyle = (try? c.decodeIfPresent(NotificationStyle.self, forKey: .notificationStyle)).flatMap { $0 } ?? .everything
        notchExternalPosition = string(.notchExternalPosition, "top-center")
        appearance = (try? c.decodeIfPresent(AppAppearance.self, forKey: .appearance)).flatMap { $0 } ?? .light
        cursorGlowHex = string(.cursorGlowHex, "44E45E")
        glowEnabled = bool(.glowEnabled, true)
        shakeSensitivity = double(.shakeSensitivity, 0.65)
        drawingStyle = (try? c.decodeIfPresent(DrawingStyle.self, forKey: .drawingStyle)).flatMap { $0 } ?? .ink
        drawingColorHex = string(.drawingColorHex, "44E45E")
        blockedApps = (try? c.decodeIfPresent([String].self, forKey: .blockedApps)).flatMap { $0 } ?? []
        alwaysAsk = (try? c.decodeIfPresent([String].self, forKey: .alwaysAsk)).flatMap { $0 } ?? []
        alwaysAllow = (try? c.decodeIfPresent([String].self, forKey: .alwaysAllow)).flatMap { $0 } ?? []
        spendingLimit = double(.spendingLimit, 25)
        hideInScreenshots = bool(.hideInScreenshots, true)
        appleCalendar = bool(.appleCalendar, false)
        appleReminders = bool(.appleReminders, false)
        appleNotes = bool(.appleNotes, false)
        automationGranted = bool(.automationGranted, false)
        inputMonitoringGranted = bool(.inputMonitoringGranted, false)
        convexSiteURL = string(.convexSiteURL, "")
        syncEnabled = bool(.syncEnabled, false)
        lastSyncAt = (try? c.decodeIfPresent(Date.self, forKey: .lastSyncAt)).flatMap { $0 }
        onboardingComplete = bool(.onboardingComplete, false)
        tourComplete = bool(.tourComplete, false)
        showedWelcome = bool(.showedWelcome, false)
        claudeModel = string(.claudeModel, "claude-sonnet-4-5")
        agentExtraArgs = (try? c.decodeIfPresent([String: String].self, forKey: .agentExtraArgs)).flatMap { $0 } ?? [:]
        lastWorkingDirectory = string(.lastWorkingDirectory, "")
    }
}

// MARK: - Coding agents

public enum CodingAgentID: String, Codable, CaseIterable, Identifiable, Sendable {
    case claude, opencode, omp, hermes

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .opencode: return "OpenCode"
        case .omp: return "omp"
        case .hermes: return "Hermes"
        }
    }

    public var binary: String {
        switch self {
        case .claude: return "claude"
        case .opencode: return "opencode"
        case .omp: return "omp"
        case .hermes: return "hermes"
        }
    }

    public var blurb: String {
        switch self {
        case .claude: return "thoughtful, tight diffs; great on a single repo"
        case .opencode: return "open source, provider agnostic, runs anywhere"
        case .omp: return "long-running autonomous work, model mix"
        case .hermes: return "tool-heavy workflows and MCP"
        }
    }

    public var accentHex: String {
        switch self {
        case .claude: return "D97757"
        case .opencode: return "7A8CFF"
        case .omp: return "B8F26B"
        case .hermes: return "C9A7FF"
        }
    }

    public var defaultArguments: [String] {
        switch self {
        case .claude: return ["-p", "{prompt}", "--output-format", "text", "--permission-mode", "acceptEdits"]
        case .opencode: return ["run", "--auto", "{prompt}"]
        case .omp: return ["-p", "--auto-approve", "{prompt}"]
        case .hermes: return ["-z", "{prompt}"]
        }
    }

    public var installHint: String {
        switch self {
        case .claude: return "npm install -g @anthropic-ai/claude-code"
        case .opencode: return "curl -fsSL https://opencode.ai/install | bash"
        case .omp: return "https://omp.sh"
        case .hermes: return "pipx install hermes-agent"
        }
    }
}

// MARK: - Tools

public struct ToolSpec: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var command: String
    public var replaces: String
    public var blurb: String
    public var examples: [String]
    public var installCommand: String
    public var checkCommand: String
    public var docs: String
    public var license: String
    public var popularity: Int
    public var category: String

    public init(id: String, name: String, command: String, replaces: String, blurb: String,
                examples: [String], installCommand: String, checkCommand: String, docs: String,
                license: String, popularity: Int, category: String) {
        self.id = id; self.name = name; self.command = command; self.replaces = replaces
        self.blurb = blurb; self.examples = examples; self.installCommand = installCommand
        self.checkCommand = checkCommand; self.docs = docs; self.license = license
        self.popularity = popularity; self.category = category
    }
}

public struct Connector: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var kind: String
    public var blurb: String
    public var enabled: Bool
    public var installed: Bool
    public var installCommand: String
    public var docs: String

    public init(id: String, name: String, kind: String, blurb: String,
                enabled: Bool = false, installed: Bool = false,
                installCommand: String = "", docs: String = "") {
        self.id = id; self.name = name; self.kind = kind; self.blurb = blurb
        self.enabled = enabled; self.installed = installed
        self.installCommand = installCommand; self.docs = docs
    }
}

// MARK: - Memory + threads

public enum MemorySection: String, Codable, CaseIterable, Identifiable, Sendable {
    case aboutYou
    case rightNow
    public var id: String { rawValue }
    public var label: String { self == .aboutYou ? "about you" : "right now" }
}

public struct MemoryItem: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var section: MemorySection
    public var text: String
    public var source: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, section: MemorySection, text: String,
                source: String = "you", createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id; self.section = section; self.text = text; self.source = source
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
}

public enum MessageRole: String, Codable, Sendable {
    case user, assistant, system
}

public struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var role: MessageRole
    public var text: String
    public var createdAt: Date
    public var runID: String?

    public init(id: String = UUID().uuidString, role: MessageRole, text: String,
                createdAt: Date = Date(), runID: String? = nil) {
        self.id = id; self.role = role; self.text = text
        self.createdAt = createdAt; self.runID = runID
    }
}

public struct ChatThread: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var title: String
    public var app: String
    public var topic: String
    public var messages: [ChatMessage]
    public var createdAt: Date
    public var updatedAt: Date
    public var archived: Bool

    public init(id: String = UUID().uuidString, accountID: String, title: String,
                app: String = "mac", topic: String = "", messages: [ChatMessage] = [],
                createdAt: Date = Date(), updatedAt: Date = Date(), archived: Bool = false) {
        self.id = id; self.accountID = accountID; self.title = title; self.app = app
        self.topic = topic; self.messages = messages; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.archived = archived
    }
}

// MARK: - Runs

public enum RunKind: String, Codable, CaseIterable, Sendable {
    case answer, quickAction = "quick_action", terminal, coding, background, teach, watch, borrow, computerUse = "computer_use", routine
    public var label: String {
        switch self {
        case .answer: return "answer"
        case .quickAction: return "quick action"
        case .terminal: return "terminal bridge"
        case .coding: return "coding agent"
        case .background: return "background"
        case .teach: return "teach"
        case .watch: return "watch me"
        case .borrow: return "screen borrow"
        case .computerUse: return "computer use"
        case .routine: return "routine"
        }
    }
}

public enum RunStatus: String, Codable, CaseIterable, Sendable {
    case previewing, waiting, running, paused, done, failed, cancelled
    public var label: String {
        switch self {
        case .previewing: return "previewing"
        case .waiting: return "waiting for you"
        case .running: return "running"
        case .paused: return "paused"
        case .done: return "done"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }
    public var isActive: Bool { self == .running || self == .waiting || self == .previewing || self == .paused }
}

public enum RiskLevel: String, Codable, CaseIterable, Sendable {
    case low, medium, high
    public var label: String { rawValue }
}

public struct PreviewStep: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public init(id: String = UUID().uuidString, _ text: String) {
        self.id = id; self.text = text
    }
}

public struct ActionPreview: Codable, Equatable, Sendable {
    public var summary: String
    public var risk: RiskLevel
    public var steps: [PreviewStep]
    public var commands: [String]
    public var apps: [String]
    public var files: [String]
    public var createdAt: Date

    public init(summary: String, risk: RiskLevel = .low, steps: [PreviewStep] = [],
                commands: [String] = [], apps: [String] = [], files: [String] = [],
                createdAt: Date = Date()) {
        self.summary = summary; self.risk = risk; self.steps = steps
        self.commands = commands; self.apps = apps; self.files = files; self.createdAt = createdAt
    }
}

public struct RunStep: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var detail: String
    public var status: RunStatus
    public var startedAt: Date?
    public var endedAt: Date?

    public init(id: String = UUID().uuidString, title: String, detail: String = "",
                status: RunStatus = .previewing, startedAt: Date? = nil, endedAt: Date? = nil) {
        self.id = id; self.title = title; self.detail = detail
        self.status = status; self.startedAt = startedAt; self.endedAt = endedAt
    }
}

public struct AgentRun: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var kind: RunKind
    public var title: String
    public var prompt: String
    public var threadID: String?
    public var status: RunStatus
    public var preview: ActionPreview?
    public var steps: [RunStep]
    public var output: String
    public var summary: String
    public var agent: CodingAgentID?
    public var workingDirectory: String?
    public var createdAt: Date
    public var startedAt: Date?
    public var endedAt: Date?
    public var freedBytes: Int64?
    public var builtin: String?
    public var pickedPath: String?

    public init(id: String = UUID().uuidString, accountID: String, kind: RunKind,
                title: String, prompt: String, threadID: String? = nil,
                status: RunStatus = .previewing, preview: ActionPreview? = nil,
                steps: [RunStep] = [], output: String = "", summary: String = "",
                agent: CodingAgentID? = nil, workingDirectory: String? = nil,
                createdAt: Date = Date(), startedAt: Date? = nil, endedAt: Date? = nil,
                freedBytes: Int64? = nil, builtin: String? = nil, pickedPath: String? = nil) {
        self.id = id; self.accountID = accountID; self.kind = kind; self.title = title
        self.prompt = prompt; self.threadID = threadID; self.status = status
        self.preview = preview; self.steps = steps; self.output = output; self.summary = summary
        self.agent = agent; self.workingDirectory = workingDirectory
        self.createdAt = createdAt; self.startedAt = startedAt; self.endedAt = endedAt
        self.freedBytes = freedBytes
    }

    public var isActive: Bool { status.isActive }
}

public struct SkillStep: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var app: String
    public var x: Double?
    public var y: Double?
    public init(id: String = UUID().uuidString, text: String, app: String = "",
                x: Double? = nil, y: Double? = nil) {
        self.id = id; self.text = text; self.app = app; self.x = x; self.y = y
    }
}

public struct Skill: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var name: String
    public var summary: String
    public var steps: [SkillStep]
    public var createdAt: Date
    public var source: String
    public var runCount: Int

    public init(id: String = UUID().uuidString, accountID: String, name: String,
                summary: String, steps: [SkillStep] = [], createdAt: Date = Date(),
                source: String = "watch me", runCount: Int = 0) {
        self.id = id; self.accountID = accountID; self.name = name; self.summary = summary
        self.steps = steps; self.createdAt = createdAt; self.source = source; self.runCount = runCount
    }
}

public enum RoutineCadence: String, Codable, CaseIterable, Identifiable, Sendable {
    case hourly, daily, weekdays, weekly, manual
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .hourly: return "every hour"
        case .daily: return "every day"
        case .weekdays: return "weekdays"
        case .weekly: return "every week"
        case .manual: return "manual"
        }
    }
}

public struct Routine: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var accountID: String
    public var name: String
    public var prompt: String
    public var cadence: RoutineCadence
    public var weekday: Int
    public var hour: Int
    public var minute: Int
    public var enabled: Bool
    public var createdAt: Date
    public var lastRunAt: Date?
    public var nextRunAt: Date?

    public init(id: String = UUID().uuidString, accountID: String, name: String, prompt: String,
                cadence: RoutineCadence = .weekly, weekday: Int = 6, hour: Int = 17, minute: Int = 0,
                enabled: Bool = true, createdAt: Date = Date(),
                lastRunAt: Date? = nil, nextRunAt: Date? = nil) {
        self.id = id; self.accountID = accountID; self.name = name; self.prompt = prompt
        self.cadence = cadence; self.weekday = weekday; self.hour = hour; self.minute = minute
        self.enabled = enabled; self.createdAt = createdAt; self.lastRunAt = lastRunAt
        self.nextRunAt = nextRunAt
    }

    public func nextDate(after date: Date = Date(), calendar: Calendar = .current) -> Date? {
        guard enabled, cadence != .manual else { return nil }
        var comps = DateComponents()
        comps.hour = hour
        comps.minute = minute
        switch cadence {
        case .hourly:
            let nextHour = calendar.date(byAdding: .hour, value: 1, to: date) ?? date
            return calendar.date(bySettingHour: calendar.component(.hour, from: nextHour),
                                 minute: minute, second: 0, of: nextHour)
        case .daily:
            return calendar.nextDate(after: date, matching: comps, matchingPolicy: .nextTime)
        case .weekdays:
            var cursor = date
            for _ in 0..<8 {
                if let candidate = calendar.nextDate(after: cursor, matching: comps, matchingPolicy: .nextTime) {
                    let weekday = calendar.component(.weekday, from: candidate)
                    if weekday != 1 && weekday != 7 { return candidate }
                    cursor = calendar.date(byAdding: .day, value: 1, to: candidate) ?? candidate
                } else { break }
            }
            return nil
        case .weekly:
            comps.weekday = weekday
            return calendar.nextDate(after: date, matching: comps, matchingPolicy: .nextTime)
        case .manual:
            return nil
        }
    }

    public var scheduleLabel: String {
        if cadence == .manual { return "when you ask" }
        let days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        let time = String(format: "%d:%02d %@", hour % 12 == 0 ? 12 : hour % 12, minute, hour < 12 ? "am" : "pm")
        switch cadence {
        case .hourly: return "every hour at :\(String(format: "%02d", minute))"
        case .daily: return "every day at \(time)"
        case .weekdays: return "weekdays at \(time)"
        case .weekly: return "every \(days[max(0, min(6, weekday - 1))]) at \(time)"
        case .manual: return "when you ask"
        }
    }
}

// MARK: - Brain

/// One drawing instruction for the teach overlay. The model describes what to draw
/// ("circle", "arrow", "cursor" motion, "label", spotlight-"dim", "ink" scribble, "box")
/// and either names a UI element by its accessibility label or gives a fallback position
/// relative to the app window (0.0-1.0).
public struct TeachMark: Codable, Equatable, Sendable {
    public var kind: String
    public var target: String?
    public var point: [Double]?
    public var rect: [Double]?
    public var to: [Double]?
    public var text: String?
    public var seconds: Double?

    public init(kind: String, target: String? = nil, point: [Double]? = nil,
                rect: [Double]? = nil, to: [Double]? = nil, text: String? = nil, seconds: Double? = nil) {
        self.kind = kind; self.target = target; self.point = point; self.rect = rect
        self.to = to; self.text = text; self.seconds = seconds
    }

    enum CodingKeys: String, CodingKey { case kind, target, point, rect, to, text, seconds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "box"
        target = try? c.decodeIfPresent(String.self, forKey: .target)
        point = try? c.decodeIfPresent([Double].self, forKey: .point)
        rect = try? c.decodeIfPresent([Double].self, forKey: .rect)
        to = try? c.decodeIfPresent([Double].self, forKey: .to)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        seconds = try? c.decodeIfPresent(Double.self, forKey: .seconds)
    }
}

/// A teach step: what to say plus what to draw.
public struct TeachPlanStep: Codable, Equatable, Sendable {
    public var say: String
    public var marks: [TeachMark]

    public init(say: String, marks: [TeachMark] = []) {
        self.say = say; self.marks = marks
    }

    enum CodingKeys: String, CodingKey { case say, marks }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        say = (try? c.decode(String.self, forKey: .say)) ?? ""
        marks = (try? c.decode([TeachMark].self, forKey: .marks)) ?? []
    }
}

public struct BrainRequest: Sendable {
    public var text: String
    public var appName: String
    public var bundleID: String
    public var threadID: String?
    public var screenshotPNG: Data?
    public var selection: CGRect?
    public var source: String
    public var attachmentName: String
    public var documentText: String
    public var clipboardText: String

    public init(text: String, appName: String = "", bundleID: String = "",
                threadID: String? = nil, screenshotPNG: Data? = nil,
                selection: CGRect? = nil, source: String = "summon",
                attachmentName: String = "", documentText: String = "",
                clipboardText: String = "") {
        self.text = text; self.appName = appName; self.bundleID = bundleID
        self.threadID = threadID; self.screenshotPNG = screenshotPNG
        self.selection = selection; self.source = source
        self.attachmentName = attachmentName; self.documentText = documentText
        self.clipboardText = clipboardText
    }
}

public struct QuickActionPayload: Codable, Equatable, Sendable {
    public var type: String
    public var title: String
    public var body: String
    public var date: String?
    public var hour: Int?
    public var weekday: Int?

    public init(type: String, title: String, body: String = "", date: String? = nil,
                hour: Int? = nil, weekday: Int? = nil) {
        self.type = type; self.title = title; self.body = body
        self.date = date; self.hour = hour; self.weekday = weekday
    }
}

public struct BrainDecision: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case answer
        case quickAction = "quick_action"
        case terminal
        case coding
        case background
        case teach
        case borrow
        case watch
        case memory
        case routine
        case computerUse = "computer_use"
        case overlay
    }

    public var kind: Kind
    public var title: String
    public var answer: String
    public var speak: String
    public var risk: RiskLevel
    public var previewSummary: String
    public var previewSteps: [String]
    public var commands: [String]
    public var apps: [String]
    public var files: [String]
    public var teachSteps: [String]
    public var memory: [String]
    public var routineName: String?
    public var routineCadence: String?
    public var routineWeekday: Int?
    public var routineHour: Int?
    public var routineMinute: Int?
    public var clarification: String?
    public var actions: [String]
    public var quickAction: QuickActionPayload?
    public var pickFile: String?
    public var builtin: String?
    public var teachPlan: [TeachPlanStep]
    public var overlayHTML: String?
    public var overlayTitle: String?
    public var overlayWidth: Int?
    public var overlayHeight: Int?

    public init(kind: Kind, title: String, answer: String, speak: String = "",
                risk: RiskLevel = .low, previewSummary: String = "", previewSteps: [String] = [],
                commands: [String] = [], apps: [String] = [], files: [String] = [],
                teachSteps: [String] = [], memory: [String] = [], routineName: String? = nil,
                routineCadence: String? = nil, routineWeekday: Int? = nil, routineHour: Int? = nil,
                routineMinute: Int? = nil, clarification: String? = nil, actions: [String] = [],
                quickAction: QuickActionPayload? = nil, pickFile: String? = nil, builtin: String? = nil,
                teachPlan: [TeachPlanStep] = [], overlayHTML: String? = nil, overlayTitle: String? = nil,
                overlayWidth: Int? = nil, overlayHeight: Int? = nil) {
        self.kind = kind; self.title = title; self.answer = answer; self.speak = speak
        self.risk = risk; self.previewSummary = previewSummary; self.previewSteps = previewSteps
        self.commands = commands; self.apps = apps; self.files = files; self.teachSteps = teachSteps
        self.memory = memory; self.routineName = routineName; self.routineCadence = routineCadence
        self.routineWeekday = routineWeekday; self.routineHour = routineHour
        self.routineMinute = routineMinute; self.clarification = clarification; self.actions = actions
        self.quickAction = quickAction; self.pickFile = pickFile; self.builtin = builtin
        self.teachPlan = teachPlan; self.overlayHTML = overlayHTML; self.overlayTitle = overlayTitle
        self.overlayWidth = overlayWidth; self.overlayHeight = overlayHeight
    }

    enum CodingKeys: String, CodingKey {
        case kind, title, answer, speak, risk, previewSummary, previewSteps, commands, apps, files
        case teachSteps, memory, routineName, routineCadence, routineWeekday, routineHour, routineMinute
        case clarification, actions, quickAction, pickFile, builtin
        case teachPlan, overlayHTML, overlayTitle, overlayWidth, overlayHeight
        case teachStepsSnake = "teach_steps"
        case teachPlanSnake = "teach_plan"
        case overlayHTMLSnake = "overlay_html"
        case overlayTitleSnake = "overlay_title"
        case overlayWidthSnake = "overlay_width"
        case overlayHeightSnake = "overlay_height"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .answer
        title = (try? c.decode(String.self, forKey: .title)) ?? "okidoki"
        answer = (try? c.decode(String.self, forKey: .answer)) ?? ""
        speak = (try? c.decode(String.self, forKey: .speak)) ?? ""
        risk = (try? c.decode(RiskLevel.self, forKey: .risk)) ?? .low
        previewSummary = (try? c.decode(String.self, forKey: .previewSummary)) ?? ""
        previewSteps = (try? c.decode([String].self, forKey: .previewSteps)) ?? []
        commands = (try? c.decode([String].self, forKey: .commands)) ?? []
        apps = (try? c.decode([String].self, forKey: .apps)) ?? []
        files = (try? c.decode([String].self, forKey: .files)) ?? []
        teachSteps = (try? c.decode([String].self, forKey: .teachSteps))
            ?? (try? c.decode([String].self, forKey: .teachStepsSnake))
            ?? []
        memory = (try? c.decode([String].self, forKey: .memory)) ?? []
        routineName = try? c.decodeIfPresent(String.self, forKey: .routineName)
        routineCadence = try? c.decodeIfPresent(String.self, forKey: .routineCadence)
        routineWeekday = try? c.decodeIfPresent(Int.self, forKey: .routineWeekday)
        routineHour = try? c.decodeIfPresent(Int.self, forKey: .routineHour)
        routineMinute = try? c.decodeIfPresent(Int.self, forKey: .routineMinute)
        clarification = try? c.decodeIfPresent(String.self, forKey: .clarification)
        actions = (try? c.decode([String].self, forKey: .actions)) ?? []
        quickAction = try? c.decodeIfPresent(QuickActionPayload.self, forKey: .quickAction)
        pickFile = try? c.decodeIfPresent(String.self, forKey: .pickFile)
        builtin = try? c.decodeIfPresent(String.self, forKey: .builtin)
        // Accept both the normalized camelCase (brain maps keys) and raw snake_case payloads.
        teachPlan = (try? c.decodeIfPresent([TeachPlanStep].self, forKey: .teachPlan)).flatMap { $0 }
            ?? (try? c.decodeIfPresent([TeachPlanStep].self, forKey: .teachPlanSnake)).flatMap { $0 }
            ?? []
        overlayHTML = (try? c.decodeIfPresent(String.self, forKey: .overlayHTML))
            ?? (try? c.decodeIfPresent(String.self, forKey: .overlayHTMLSnake))
        overlayTitle = (try? c.decodeIfPresent(String.self, forKey: .overlayTitle))
            ?? (try? c.decodeIfPresent(String.self, forKey: .overlayTitleSnake))
        overlayWidth = (try? c.decodeIfPresent(Int.self, forKey: .overlayWidth))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .overlayWidthSnake))
        overlayHeight = (try? c.decodeIfPresent(Int.self, forKey: .overlayHeight))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .overlayHeightSnake))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(answer, forKey: .answer)
        try c.encode(speak, forKey: .speak)
        try c.encode(risk, forKey: .risk)
        try c.encode(previewSummary, forKey: .previewSummary)
        try c.encode(previewSteps, forKey: .previewSteps)
        try c.encode(commands, forKey: .commands)
        try c.encode(apps, forKey: .apps)
        try c.encode(files, forKey: .files)
        try c.encode(teachSteps, forKey: .teachSteps)
        try c.encode(memory, forKey: .memory)
        try c.encode(routineName, forKey: .routineName)
        try c.encode(routineCadence, forKey: .routineCadence)
        try c.encode(routineWeekday, forKey: .routineWeekday)
        try c.encode(routineHour, forKey: .routineHour)
        try c.encode(routineMinute, forKey: .routineMinute)
        try c.encodeIfPresent(clarification, forKey: .clarification)
        try c.encode(actions, forKey: .actions)
        try c.encodeIfPresent(quickAction, forKey: .quickAction)
        try c.encodeIfPresent(pickFile, forKey: .pickFile)
        try c.encodeIfPresent(builtin, forKey: .builtin)
        try c.encode(teachPlan, forKey: .teachPlan)
        try c.encodeIfPresent(overlayHTML, forKey: .overlayHTML)
        try c.encodeIfPresent(overlayTitle, forKey: .overlayTitle)
        try c.encodeIfPresent(overlayWidth, forKey: .overlayWidth)
        try c.encodeIfPresent(overlayHeight, forKey: .overlayHeight)
    }
}

public struct BrainResult: Sendable {
    public var decision: BrainDecision
    public var usedModel: Bool
    public var error: String?
    public init(decision: BrainDecision, usedModel: Bool, error: String? = nil) {
        self.decision = decision; self.usedModel = usedModel; self.error = error
    }
}

// MARK: - Notifications / approvals (ephemeral, app layer)

public enum ToastKind: String, Sendable {
    case success, info, warning, approval
}

public struct ApprovalRequest: Identifiable, Equatable, Sendable {
    public var id: String
    public var runID: String
    public var title: String
    public var summary: String
    public var risk: RiskLevel
    public var commands: [String]
    public var app: String?
    public var isBorrow: Bool
    public init(id: String = UUID().uuidString, runID: String, title: String, summary: String,
                risk: RiskLevel, commands: [String] = [], app: String? = nil, isBorrow: Bool = false) {
        self.id = id; self.runID = runID; self.title = title; self.summary = summary
        self.risk = risk; self.commands = commands; self.app = app; self.isBorrow = isBorrow
    }
}

// MARK: - State container

public struct AppState: Codable, Sendable {
    public var version: Int
    public var accounts: [Account]
    public var currentAccountID: String
    public var settings: AppSettings
    public var threads: [ChatThread]
    public var memories: [MemoryItem]
    public var runs: [AgentRun]
    public var skills: [Skill]
    public var routines: [Routine]
    public var connectors: [Connector]

    public init(version: Int = 1, accounts: [Account] = [], currentAccountID: String = "",
                settings: AppSettings = AppSettings(), threads: [ChatThread] = [],
                memories: [MemoryItem] = [], runs: [AgentRun] = [], skills: [Skill] = [],
                routines: [Routine] = [], connectors: [Connector] = []) {
        self.version = version; self.accounts = accounts; self.currentAccountID = currentAccountID
        self.settings = settings; self.threads = threads; self.memories = memories; self.runs = runs
        self.skills = skills; self.routines = routines; self.connectors = connectors
    }

    enum CodingKeys: String, CodingKey {
        case version, accounts, currentAccountID, settings, threads, memories, runs, skills, routines, connectors
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)).flatMap { $0 } ?? 1
        accounts = (try? c.decodeIfPresent([Account].self, forKey: .accounts)).flatMap { $0 } ?? []
        currentAccountID = (try? c.decodeIfPresent(String.self, forKey: .currentAccountID)).flatMap { $0 } ?? ""
        settings = (try? c.decodeIfPresent(AppSettings.self, forKey: .settings)).flatMap { $0 } ?? AppSettings()
        threads = (try? c.decodeIfPresent([ChatThread].self, forKey: .threads)).flatMap { $0 } ?? []
        memories = (try? c.decodeIfPresent([MemoryItem].self, forKey: .memories)).flatMap { $0 } ?? []
        runs = (try? c.decodeIfPresent([AgentRun].self, forKey: .runs)).flatMap { $0 } ?? []
        skills = (try? c.decodeIfPresent([Skill].self, forKey: .skills)).flatMap { $0 } ?? []
        routines = (try? c.decodeIfPresent([Routine].self, forKey: .routines)).flatMap { $0 } ?? []
        connectors = (try? c.decodeIfPresent([Connector].self, forKey: .connectors)).flatMap { $0 } ?? ToolCatalog.defaultConnectors
    }
}
