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
    public static let summonModes = ["auto", "act", "browser", "chat"]
    public static var defaultVaultFolder: String {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Desktop/Okidoki Vault", isDirectory: true).path
    }

    public var okidokiEnabled: Bool = true
    public var defaultInput: InputMode = .typing
    public var voiceID: String = "sarah"
    public var voiceSpeed: Double = 1.0
    public var voiceEnabled: Bool = true
    public var captions: Bool = true
    public var confirmOK: Bool = true
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
    public var automationGranted: Bool = false
    public var inputMonitoringGranted: Bool = false

    public var onboardingComplete: Bool = false
    public var tourComplete: Bool = false
    public var showedWelcome: Bool = false

    public var claudeModel: String = "claude-haiku-5-5"
    /// How visibly the pointer moves while okidoki drives: "calm" glides, "fast" is quicker.
    public var drivePace: String = "fast"
    /// Where computer-use runs happen: "mac" is this Mac, "vm" is okidoki's private Mac (a macOS VM).
    public var computerTarget: String = "mac"
    /// What a request typed at the cursor is for: "auto" lets the brain decide, "act" drives the Mac,
    /// "browser" works in okidoki's own browser, "chat" just answers.
    public var summonMode: String = "auto"
    /// The vault: a folder of documents okidoki can file into and search. On the Desktop unless moved.
    public var vaultFolder: String = AppSettings.defaultVaultFolder

    /// Send the front window, browser tab and a small screenshot with every request, so the
    /// brain knows what's on screen before it decides how to help. Never stored.
    public var screenContext: Bool = true

    /// Hybrid replay: skills fill their values from your documents, check every step, pick themselves
    /// for everyday requests and hand off to the agent when the screen changed. Off runs replay exactly
    /// as before, so the two can be compared on the same build.
    public var hybridReplay: Bool = false

    /// The new look: one browser shell with a frosted sidebar (pins, chats, tabs, agent tabs) and Home as
    /// the new tab. Off keeps the original dashboard, untouched, so the two can be compared.
    public var newShell: Bool = false
    /// Shaking the mouse opens summon. Off removes the global mouse monitor entirely; the hotkey, the
    /// notch and the menu bar still summon.
    public var shakeToSummon: Bool = true
    /// Global summon shortcut, written like "option+space". Empty turns it off.
    public var summonHotkey: String = "option+space"

    /// MCP servers okidoki can call. Their secrets (env vars, headers) live in the Mac's key file, not here.
    public var mcpServers: [MCPServer] = []

    public init() {}

    enum CodingKeys: String, CodingKey {
        case okidokiEnabled, defaultInput, voiceID, voiceSpeed, voiceEnabled, captions, confirmOK
        case customInstructions, backgroundMode, screenBorrowing, proactiveNudges
        case quietMode, notchEnabled, notificationStyle, notchExternalPosition, appearance
        case cursorGlowHex, glowEnabled, shakeSensitivity, drawingStyle, drawingColorHex
        case blockedApps, alwaysAsk, alwaysAllow, spendingLimit, hideInScreenshots
        case appleCalendar, automationGranted, inputMonitoringGranted
        case onboardingComplete, tourComplete, showedWelcome
        case claudeModel, mcpServers, drivePace, computerTarget
        case screenContext, summonMode, vaultFolder
        case hybridReplay, newShell, shakeToSummon, summonHotkey
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
        automationGranted = bool(.automationGranted, false)
        inputMonitoringGranted = bool(.inputMonitoringGranted, false)
        onboardingComplete = bool(.onboardingComplete, false)
        tourComplete = bool(.tourComplete, false)
        showedWelcome = bool(.showedWelcome, false)
        claudeModel = string(.claudeModel, "claude-haiku-5-5")
        mcpServers = (try? c.decodeIfPresent([MCPServer].self, forKey: .mcpServers)).flatMap { $0 } ?? []
        drivePace = string(.drivePace, "fast")
        computerTarget = string(.computerTarget, "mac") == "vm" ? "vm" : "mac"
        let mode = string(.summonMode, "auto")
        summonMode = Self.summonModes.contains(mode) ? mode : "auto"
        vaultFolder = string(.vaultFolder, Self.defaultVaultFolder)
        screenContext = bool(.screenContext, true)
        hybridReplay = bool(.hybridReplay, false)
        newShell = bool(.newShell, false)
        shakeToSummon = bool(.shakeToSummon, true)
        summonHotkey = string(.summonHotkey, "option+space")
    }
}

// MARK: - MCP servers

public struct MCPServer: Identifiable, Codable, Equatable, Sendable {
    public enum Transport: String, Codable, Sendable { case stdio, http }

    public var id: String
    public var name: String
    public var transport: Transport
    /// stdio: the program to start, e.g. "npx", with its arguments.
    public var command: String
    public var args: [String]
    /// http: the server's streamable HTTP endpoint.
    public var url: String
    public var enabled: Bool

    public init(id: String = UUID().uuidString, name: String, transport: Transport = .stdio,
                command: String = "", args: [String] = [], url: String = "", enabled: Bool = true) {
        self.id = id; self.name = name; self.transport = transport
        self.command = command; self.args = args; self.url = url; self.enabled = enabled
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "mcp server"
        transport = (try? c.decode(Transport.self, forKey: .transport)) ?? .stdio
        command = (try? c.decode(String.self, forKey: .command)) ?? ""
        args = (try? c.decode([String].self, forKey: .args)) ?? []
        url = (try? c.decode(String.self, forKey: .url)) ?? ""
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? true
    }

    /// KeyStore entry holding this server's secrets as JSON: {"env": {...}, "headers": {...}}.
    public var secretsKey: String { "mcp.\(id)" }
}

// MARK: - Connectors

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
    /// The account this belongs to. Empty only for memories saved before memory was per account;
    /// the store gives those to the account in front when it loads them.
    public var accountID: String
    public var section: MemorySection
    public var text: String
    public var source: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, accountID: String = "", section: MemorySection, text: String,
                source: String = "you", createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id; self.accountID = accountID; self.section = section; self.text = text; self.source = source
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        // Older saves have no account; a missing key must not drop the memory.
        accountID = (try? c.decodeIfPresent(String.self, forKey: .accountID)).flatMap { $0 } ?? ""
        section = try c.decode(MemorySection.self, forKey: .section)
        text = try c.decode(String.self, forKey: .text)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0 } ?? "you"
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)).flatMap { $0 } ?? createdAt
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
    /// When the person last opened the thread. A reply after it shows as unread. Nil means never opened,
    /// which only counts as unread once okidoki has answered.
    public var seenAt: Date?

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
    case answer, quickAction = "quick_action", watch, borrow, computerUse = "computer_use", browser, routine, connector
    public var label: String {
        switch self {
        case .answer: return "answer"
        case .quickAction: return "quick action"
        case .watch: return "watch me"
        case .borrow: return "screen borrow"
        case .computerUse: return "computer use"
        case .browser: return "browser"
        case .routine: return "routine"
        case .connector: return "connector"
        }
    }

    /// Kinds this build no longer has (teach, terminal, coding…) read as answers, so their history stays.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunKind(rawValue: raw) ?? .answer
    }
}

public enum RunStatus: String, Codable, CaseIterable, Sendable {
    /// `asked`: the run paused on a question for the user; their reply starts a new run in the same thread.
    case previewing, waiting, running, paused, done, failed, cancelled, asked
    public var label: String {
        switch self {
        case .previewing: return "previewing"
        case .waiting: return "waiting for you"
        case .running: return "running"
        case .paused: return "paused"
        case .done: return "done"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .asked: return "needs your answer"
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
    public var createdAt: Date
    public var startedAt: Date?
    public var endedAt: Date?
    public var freedBytes: Int64?
    public var builtin: String?
    public var pickedPath: String?
    /// Last change on any Mac, so sync keeps the newest copy. Nil on runs saved before sync merged.
    public var updatedAt: Date?
    /// The Mac that ran it (`DeviceIdentity`). Only that Mac executes, stops or recovers it;
    /// elsewhere it's history synced from that Mac.
    public var origin: String?
    /// The user's reply to the question an `asked` run paused on. Set when they answer (or carry on in the
    /// same conversation), which also moves the run to done so it stops waiting on them.
    public var answer: String?
    /// Model calls this run made (agent turns, replay rescues, binds). Nil on runs that made none
    /// or were saved before it was counted; the replay eval compares it across modes.
    public var modelCalls: Int?
    /// While paused: what the person is doing for the run ("a captcha", "a one-time code"), or nil when
    /// they simply paused it. Cleared when they hand it back.
    public var waitingFor: String?
    /// When the person last looked at the run (opened its card, chat or tab). A run that finished after
    /// it is unread.
    public var seenAt: Date?

    public init(id: String = UUID().uuidString, accountID: String, kind: RunKind,
                title: String, prompt: String, threadID: String? = nil,
                status: RunStatus = .previewing, preview: ActionPreview? = nil,
                steps: [RunStep] = [], output: String = "", summary: String = "",
                createdAt: Date = Date(), startedAt: Date? = nil, endedAt: Date? = nil,
                freedBytes: Int64? = nil, builtin: String? = nil, pickedPath: String? = nil,
                updatedAt: Date? = nil, origin: String? = nil) {
        self.id = id; self.accountID = accountID; self.kind = kind; self.title = title
        self.prompt = prompt; self.threadID = threadID; self.status = status
        self.preview = preview; self.steps = steps; self.output = output; self.summary = summary
        self.createdAt = createdAt; self.startedAt = startedAt; self.endedAt = endedAt
        self.freedBytes = freedBytes
        self.builtin = builtin; self.pickedPath = pickedPath
        self.updatedAt = updatedAt; self.origin = origin
    }

    public var isActive: Bool { status.isActive }
    /// When it last changed, for merging copies from two Macs.
    public var editedAt: Date { updatedAt ?? createdAt }
}

/// One recorded movement. `text` is the human line shown in the dashboard; the rest is what
/// the replayer needs to do it again. Older skills only have `text`/`app`/`x`/`y`.
public struct SkillStep: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var app: String
    /// Quartz-space point (top-left origin) for new recordings; AppKit-space for legacy steps (`action == nil`).
    public var x: Double?
    public var y: Double?
    /// click · double-click · right-click · drag · type · key · scroll · switch
    public var action: String?
    /// Accessibility label of what was clicked, so replay can re-find it if the window moved.
    public var label: String?
    /// Typed text for `type`, key combo like "cmd+s" for `key`.
    public var input: String?
    /// Drag end point, or scroll delta (dy in `toY`).
    public var toX: Double?
    public var toY: Double?
    /// Seconds after the previous step; replay keeps the same pacing (clamped).
    public var delay: Double?
    /// The app that owns the clicked control when it isn't the front app: the Dock, a menu bar
    /// extra, Control Center. Replay looks the control up there instead of in `app`.
    public var owner: String?
    /// Accessibility role of the clicked control (AXButton, AXDockItem…). Lets a label-less
    /// control be checked before it's clicked again.
    public var role: String?
    /// Frame of the control's window when it was recorded (Quartz space). When the window has
    /// moved or been resized since, the point is carried along with it.
    public var winX: Double?
    public var winY: Double?
    public var winW: Double?
    public var winH: Double?
    /// Title of that window, so the right one is picked when the app has several of similar size.
    public var winTitle: String?
    /// Region of the screen (Quartz points) saved as a picture when the step was recorded, under
    /// `SkillFrames`. Replay matches it against the live screen when the control can't be found
    /// through accessibility — a reordered list, a moved window, a web page without labels.
    public var frameX: Double?
    public var frameY: Double?
    public var frameW: Double?
    public var frameH: Double?
    /// "browser" for a step taken in okidoki's browser; nil for the Mac's own apps.
    public var surface: String?
    /// The page the step was taken on (browser steps).
    public var url: String?
    /// Ways to find the element again in the page, most specific first (browser steps). A replay
    /// that had to fall back moves the one that worked to the front, so the next replay is direct.
    public var selectors: [String]?

    // v2: hybrid replay. All optional; a v1 step leaves them nil and replays as before.
    /// Do the step only when this holds for the pass's values: `{{has_gains}}`, `{{regime}} == old`,
    /// `!{{x}}`, joined with `&&` / `||`. Evaluated in code, never by the model.
    public var when: String?
    /// The first step of a loop: this step and the next `repeatLength - 1` run once per entry of the
    /// list input named here, with `{{item.field}}` filled from the entry.
    public var repeatOver: String?
    public var repeatLength: Int?
    /// "think": a bounded sub-goal the model does with this pass's values (`text` is the goal), for the
    /// rare stretch that can't be a loop or a condition. Nil is a plain deterministic step.
    public var mode: String?
    public var maxTurns: Int?
    /// Checked right after the step, locally.
    public var expect: StepExpectation?
    /// The place this step happens, for noticing popups and re-syncing.
    public var anchor: StepAnchor?
    /// Read a value off the screen after the step into this input (a reference number), for later
    /// steps and the run's receipt.
    public var capture: String?
    /// Submits, pays, sends or deletes: the replay may pause here when it's unsure about the values.
    public var irreversible: Bool?
    /// The screen right after the step when it was learned.
    public var observedAfter: StepObservation?
    /// How often replays needed help with this step; shows which steps are fragile.
    public var heals: Int?
    /// The page an irreversible step is on shows what the pass entered (a review page). Learned on a
    /// replay; once true, a pass whose details don't show there is paused, not submitted.
    public var echoes: Bool?
    /// Mac steps: how to find the control again through Accessibility (identifier, role and label in its
    /// window, its containers, its spot). Nil for browser steps and older recordings, which fall back to
    /// `label`, `role` and the window-relative point.
    public var axLocator: AXLocator?

    public init(id: String = UUID().uuidString, text: String, app: String = "",
                x: Double? = nil, y: Double? = nil, action: String? = nil, label: String? = nil,
                input: String? = nil, toX: Double? = nil, toY: Double? = nil, delay: Double? = nil,
                owner: String? = nil, role: String? = nil, window: CGRect? = nil, windowTitle: String? = nil,
                frame: CGRect? = nil) {
        self.id = id; self.text = text; self.app = app; self.x = x; self.y = y
        self.action = action; self.label = label; self.input = input
        self.toX = toX; self.toY = toY; self.delay = delay
        self.owner = owner; self.role = role
        if let window {
            winX = window.minX; winY = window.minY; winW = window.width; winH = window.height
        }
        self.winTitle = (windowTitle?.isEmpty ?? true) ? nil : windowTitle
        if let frame {
            frameX = frame.minX; frameY = frame.minY; frameW = frame.width; frameH = frame.height
        }
    }

    public var windowFrame: CGRect? {
        guard let winX, let winY, let winW, let winH, winW > 0, winH > 0 else { return nil }
        return CGRect(x: winX, y: winY, width: winW, height: winH)
    }

    public var frameRect: CGRect? {
        guard let frameX, let frameY, let frameW, let frameH, frameW > 0, frameH > 0 else { return nil }
        return CGRect(x: frameX, y: frameY, width: frameW, height: frameH)
    }

    public var isBrowser: Bool { surface == "browser" }

    /// A step in okidoki's browser: navigate · click · type · select · press. `input` is the URL,
    /// the typed text, the option or the key.
    public static func browser(_ action: String, text: String, url: String, selectors: [String] = [],
                               label: String? = nil, role: String? = nil, input: String? = nil,
                               delay: Double? = nil) -> SkillStep {
        var step = SkillStep(text: text, app: "okidoki browser", action: action, label: label,
                             input: input, delay: delay, role: role)
        step.surface = "browser"
        step.url = url
        step.selectors = selectors.isEmpty ? nil : selectors
        return step
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
    /// Last change on any Mac, so sync keeps the newest copy.
    public var updatedAt: Date?
    /// How many times a replay repaired a step and saved the fix back. Nil for skills never repaired.
    public var revision: Int?

    // v2: hybrid replay and the library. All optional.
    /// The values each pass needs.
    public var inputs: [SkillInput]?
    /// One line on what it achieves ("file an income tax return for a person"), for picking it from a request.
    public var intent: String?
    /// What one pass is for: "person", "invoice", "row".
    public var itemNoun: String?
    /// A library template: `outline` guides the agent's first run, which then becomes a learned skill.
    public var template: Bool?
    /// Learned from a template's first run.
    public var learned: Bool?
    /// The template it came from.
    public var templateID: String?
    /// Always pause before irreversible steps (money, deletion), sure or not.
    public var alwaysConfirm: Bool?
    public var interrupts: [InterruptHandler]?
    /// Template: the steps in words, and where to start.
    public var outline: [String]?
    public var startURL: String?
    public var startApp: String?
    /// Library filters: browser · mac · work · personal …
    public var tags: [String]?

    public init(id: String = UUID().uuidString, accountID: String, name: String,
                summary: String, steps: [SkillStep] = [], createdAt: Date = Date(),
                source: String = "watch me", runCount: Int = 0, updatedAt: Date? = nil) {
        self.id = id; self.accountID = accountID; self.name = name; self.summary = summary
        self.steps = steps; self.createdAt = createdAt; self.source = source; self.runCount = runCount
        self.updatedAt = updatedAt
    }

    public var editedAt: Date { updatedAt ?? createdAt }

    /// Every step happens in okidoki's browser, so the replay never needs the mouse.
    public var runsInBrowser: Bool { !steps.isEmpty && steps.allSatisfy(\.isBrowser) }
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
    /// Last change on any Mac, so sync keeps the newest copy.
    public var updatedAt: Date?
    /// The Mac that runs it on schedule (`DeviceIdentity`). Synced copies on other Macs never fire,
    /// so one routine doesn't run once per Mac.
    public var origin: String?

    public init(id: String = UUID().uuidString, accountID: String, name: String, prompt: String,
                cadence: RoutineCadence = .weekly, weekday: Int = 6, hour: Int = 17, minute: Int = 0,
                enabled: Bool = true, createdAt: Date = Date(),
                lastRunAt: Date? = nil, nextRunAt: Date? = nil, updatedAt: Date? = nil, origin: String? = nil) {
        self.id = id; self.accountID = accountID; self.name = name; self.prompt = prompt
        self.cadence = cadence; self.weekday = weekday; self.hour = hour; self.minute = minute
        self.enabled = enabled; self.createdAt = createdAt; self.lastRunAt = lastRunAt
        self.nextRunAt = nextRunAt; self.updatedAt = updatedAt; self.origin = origin
    }

    public var editedAt: Date { updatedAt ?? createdAt }

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

/// What was on screen when the person summoned okidoki: the front window's title, the browser
/// tab (title and URL) when the front app is a browser, and a small screenshot of the display.
/// Gathered before the request is routed so the brain knows a "circuit" asked about on
/// Tinkercad lives in the page in front of them, not in a model beside it.
public struct ScreenContext: Sendable, Equatable {
    public var windowTitle: String
    public var pageTitle: String
    public var pageURL: String
    public var screenshotPNG: Data?
    public var imageWidth: Double
    public var imageHeight: Double

    public init(windowTitle: String = "", pageTitle: String = "", pageURL: String = "",
                screenshotPNG: Data? = nil, imageWidth: Double = 0, imageHeight: Double = 0) {
        self.windowTitle = windowTitle; self.pageTitle = pageTitle; self.pageURL = pageURL
        self.screenshotPNG = screenshotPNG; self.imageWidth = imageWidth; self.imageHeight = imageHeight
    }

    public var isEmpty: Bool {
        windowTitle.isEmpty && pageTitle.isEmpty && pageURL.isEmpty && screenshotPNG == nil
    }

    /// One line for a prompt: "Tinkercad Circuits — https://www.tinkercad.com/…", or the window title.
    public var summary: String {
        let page = [pageTitle, pageURL].filter { !$0.isEmpty }.joined(separator: " — ")
        if !page.isEmpty { return page }
        return windowTitle
    }
}

public struct BrainRequest: Sendable {
    public var text: String
    public var appName: String
    public var bundleID: String
    public var threadID: String?
    /// What they circled, if anything. Takes precedence over the display shot in `screen`.
    public var screenshotPNG: Data?
    public var selection: CGRect?
    public var source: String
    public var attachmentName: String
    public var documentText: String
    public var clipboardText: String
    /// The window, browser tab and display as they were at summon time.
    public var screen: ScreenContext?
    /// "act", "browser" or "chat" from the cursor card; "auto" leaves it to the brain.
    public var mode: String = "auto"

    public init(text: String, appName: String = "", bundleID: String = "",
                threadID: String? = nil, screenshotPNG: Data? = nil,
                selection: CGRect? = nil, source: String = "summon",
                attachmentName: String = "", documentText: String = "",
                clipboardText: String = "", screen: ScreenContext? = nil) {
        self.text = text; self.appName = appName; self.bundleID = bundleID
        self.threadID = threadID; self.screenshotPNG = screenshotPNG
        self.selection = selection; self.source = source
        self.attachmentName = attachmentName; self.documentText = documentText
        self.clipboardText = clipboardText; self.screen = screen
    }
}

public struct QuickActionPayload: Codable, Equatable, Sendable {
    public var type: String
    public var title: String
    public var body: String?
    public var date: String?
    public var hour: Int?
    public var weekday: Int?
}

public struct BrainDecision: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case answer
        case quickAction = "quick_action"
        case borrow
        case watch
        case memory
        case routine
        case computerUse = "computer_use"
        case browser
        case overlay
        case connector
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
    public var overlayHTML: String?
    public var overlayTitle: String?
    public var overlayWidth: Int?
    public var overlayHeight: Int?
    /// For connector: the Apify or MCP call as JSON. The app keeps it opaque and hands it back to the brain to run.
    public var connectorCallJSON: String?
    /// What the model saw in front of them: "watching", "reading", "working" or "other".
    public var scene: String?

    public init(kind: Kind, title: String, answer: String, speak: String = "",
                risk: RiskLevel = .low, previewSummary: String = "", previewSteps: [String] = [],
                commands: [String] = [], apps: [String] = [], files: [String] = [],
                memory: [String] = [], routineName: String? = nil,
                routineCadence: String? = nil, routineWeekday: Int? = nil, routineHour: Int? = nil,
                routineMinute: Int? = nil, clarification: String? = nil, actions: [String] = [],
                quickAction: QuickActionPayload? = nil, pickFile: String? = nil, builtin: String? = nil,
                overlayHTML: String? = nil, overlayTitle: String? = nil,
                overlayWidth: Int? = nil, overlayHeight: Int? = nil, connectorCallJSON: String? = nil) {
        self.kind = kind; self.title = title; self.answer = answer; self.speak = speak
        self.risk = risk; self.previewSummary = previewSummary; self.previewSteps = previewSteps
        self.commands = commands; self.apps = apps; self.files = files
        self.memory = memory; self.routineName = routineName; self.routineCadence = routineCadence
        self.routineWeekday = routineWeekday; self.routineHour = routineHour
        self.routineMinute = routineMinute; self.clarification = clarification; self.actions = actions
        self.quickAction = quickAction; self.pickFile = pickFile; self.builtin = builtin
        self.overlayHTML = overlayHTML; self.overlayTitle = overlayTitle
        self.overlayWidth = overlayWidth; self.overlayHeight = overlayHeight
        self.connectorCallJSON = connectorCallJSON
        self.scene = nil
    }

    enum CodingKeys: String, CodingKey {
        case kind, title, answer, speak, risk, previewSummary, previewSteps, commands, apps, files
        case memory, routineName, routineCadence, routineWeekday, routineHour, routineMinute
        case clarification, actions, quickAction, pickFile, builtin
        case overlayHTML, overlayTitle, overlayWidth, overlayHeight, connectorCallJSON
        case overlayHTMLSnake = "overlay_html"
        case overlayTitleSnake = "overlay_title"
        case overlayWidthSnake = "overlay_width"
        case overlayHeightSnake = "overlay_height"
        case scene
    }

    /// A list, or a single string the model sent where a list belonged (one item, or one per line).
    private static func list(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [String] {
        if let items = try? c.decode([String].self, forKey: key) { return items }
        guard let text = try? c.decode(String.self, forKey: key) else { return [] }
        return text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .answer
        title = (try? c.decode(String.self, forKey: .title)) ?? "okidoki"
        answer = (try? c.decode(String.self, forKey: .answer)) ?? ""
        speak = (try? c.decode(String.self, forKey: .speak)) ?? ""
        risk = (try? c.decode(RiskLevel.self, forKey: .risk)) ?? .low
        previewSummary = (try? c.decode(String.self, forKey: .previewSummary)) ?? ""
        previewSteps = Self.list(c, .previewSteps)
        commands = Self.list(c, .commands)
        apps = Self.list(c, .apps)
        files = Self.list(c, .files)
        memory = Self.list(c, .memory)
        routineName = try? c.decodeIfPresent(String.self, forKey: .routineName)
        routineCadence = try? c.decodeIfPresent(String.self, forKey: .routineCadence)
        routineWeekday = try? c.decodeIfPresent(Int.self, forKey: .routineWeekday)
        routineHour = try? c.decodeIfPresent(Int.self, forKey: .routineHour)
        routineMinute = try? c.decodeIfPresent(Int.self, forKey: .routineMinute)
        clarification = try? c.decodeIfPresent(String.self, forKey: .clarification)
        actions = Self.list(c, .actions)
        quickAction = try? c.decodeIfPresent(QuickActionPayload.self, forKey: .quickAction)
        pickFile = try? c.decodeIfPresent(String.self, forKey: .pickFile)
        builtin = try? c.decodeIfPresent(String.self, forKey: .builtin)
        // Accept both the normalized camelCase (brain maps keys) and raw snake_case payloads.
        overlayHTML = (try? c.decodeIfPresent(String.self, forKey: .overlayHTML))
            ?? (try? c.decodeIfPresent(String.self, forKey: .overlayHTMLSnake))
        overlayTitle = (try? c.decodeIfPresent(String.self, forKey: .overlayTitle))
            ?? (try? c.decodeIfPresent(String.self, forKey: .overlayTitleSnake))
        overlayWidth = (try? c.decodeIfPresent(Int.self, forKey: .overlayWidth))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .overlayWidthSnake))
        overlayHeight = (try? c.decodeIfPresent(Int.self, forKey: .overlayHeight))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .overlayHeightSnake))
        connectorCallJSON = try? c.decodeIfPresent(String.self, forKey: .connectorCallJSON)
        scene = try? c.decodeIfPresent(String.self, forKey: .scene)
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
        try c.encodeIfPresent(overlayHTML, forKey: .overlayHTML)
        try c.encodeIfPresent(overlayTitle, forKey: .overlayTitle)
        try c.encodeIfPresent(overlayWidth, forKey: .overlayWidth)
        try c.encodeIfPresent(overlayHeight, forKey: .overlayHeight)
        try c.encodeIfPresent(connectorCallJSON, forKey: .connectorCallJSON)
        try c.encodeIfPresent(scene, forKey: .scene)
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

// MARK: - State container

/// An item this build can't read (a newer build wrote it, say). Kept exactly as it came and sent back with
/// every push, so a Mac on an older version never deletes what a newer one made.
public struct UnreadableItem: Codable, Equatable, Sendable {
    /// threads · memories · runs · skills · routines
    public var table: String
    public var id: String
    public var accountID: String
    /// The item's JSON, untouched.
    public var json: String

    public init(table: String, id: String, accountID: String, json: String) {
        self.table = table; self.id = id; self.accountID = accountID; self.json = json
    }
}

// MARK: - Browser pins and bookmarks

/// A site pinned to the top of the sidebar, as a favicon tile.
public struct BrowserPin: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var url: String
    public var title: String
    public var createdAt: Date

    public init(id: String = UUID().uuidString, url: String, title: String, createdAt: Date = Date()) {
        self.id = id; self.url = url; self.title = title; self.createdAt = createdAt
    }

    /// "github.com" for "https://www.github.com/x": what the tile and the favicon cache key on.
    public var host: String { BrowserPin.host(of: url) }

    public static func host(of url: String) -> String {
        let host = URL(string: url)?.host ?? URL(string: "https://\(url)")?.host ?? url
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// A saved page in the sidebar's Bookmarks.
public struct Bookmark: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var url: String
    public var title: String
    public var createdAt: Date

    public init(id: String = UUID().uuidString, url: String, title: String, createdAt: Date = Date()) {
        self.id = id; self.url = url; self.title = title; self.createdAt = createdAt
    }
}

public struct AppState: Codable, Sendable {
    /// 2: memories belong to an account, and runs and routines know which Mac they came from.
    public static let currentVersion = 2

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
    /// Items deleted on this Mac (id → when). Kept for a while, then dropped.
    public var deletions: [String: Date]
    /// Left from older builds that synced; read so their state files still load.
    public var syncCursors: [String: Int]
    /// Items this build couldn't read, kept as they came so nothing is lost.
    public var unreadable: [UnreadableItem]
    /// Sites pinned in the sidebar, in order. Nil until the new shell seeds them once.
    public var pins: [BrowserPin]?
    public var bookmarks: [Bookmark]
    /// Items in the saved file that couldn't be read (a newer build's data, say). Not saved.
    public private(set) var droppedItems = 0

    public init(version: Int = AppState.currentVersion, accounts: [Account] = [], currentAccountID: String = "",
                settings: AppSettings = AppSettings(), threads: [ChatThread] = [],
                memories: [MemoryItem] = [], runs: [AgentRun] = [], skills: [Skill] = [],
                routines: [Routine] = [], connectors: [Connector] = [],
                deletions: [String: Date] = [:], syncCursors: [String: Int] = [:], unreadable: [UnreadableItem] = [],
                pins: [BrowserPin]? = nil, bookmarks: [Bookmark] = []) {
        self.version = version; self.accounts = accounts; self.currentAccountID = currentAccountID
        self.settings = settings; self.threads = threads; self.memories = memories; self.runs = runs
        self.skills = skills; self.routines = routines; self.connectors = connectors
        self.deletions = deletions; self.syncCursors = syncCursors; self.unreadable = unreadable
        self.pins = pins; self.bookmarks = bookmarks
    }

    enum CodingKeys: String, CodingKey {
        case version, accounts, currentAccountID, settings, threads, memories, runs, skills, routines, connectors
        case deletions, syncCursors, unreadable, pins, bookmarks
    }

    /// One item that fails to decode (an unknown enum value from a newer build, say) must not take
    /// the whole collection with it.
    private struct Lossy<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) { value = try? T(from: decoder) }
    }

    private static func items<T: Decodable>(_ type: T.Type, _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys,
                                            dropped: inout Int) -> [T]? {
        guard let lossy = try? c.decodeIfPresent([Lossy<T>].self, forKey: key) else { return nil }
        let kept = lossy.compactMap(\.value)
        dropped += lossy.count - kept.count
        return kept
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var dropped = 0
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)).flatMap { $0 } ?? 1
        accounts = Self.items(Account.self, c, .accounts, dropped: &dropped) ?? []
        currentAccountID = (try? c.decodeIfPresent(String.self, forKey: .currentAccountID)).flatMap { $0 } ?? ""
        settings = (try? c.decodeIfPresent(AppSettings.self, forKey: .settings)).flatMap { $0 } ?? AppSettings()
        threads = Self.items(ChatThread.self, c, .threads, dropped: &dropped) ?? []
        memories = Self.items(MemoryItem.self, c, .memories, dropped: &dropped) ?? []
        runs = Self.items(AgentRun.self, c, .runs, dropped: &dropped) ?? []
        skills = Self.items(Skill.self, c, .skills, dropped: &dropped) ?? []
        routines = Self.items(Routine.self, c, .routines, dropped: &dropped) ?? []
        // Apple Notes and Reminders were connectors in older builds.
        connectors = (Self.items(Connector.self, c, .connectors, dropped: &dropped) ?? Connectors.defaults)
            .filter { $0.id != "notes" && $0.id != "reminders" }
        deletions = (try? c.decodeIfPresent([String: Date].self, forKey: .deletions)).flatMap { $0 } ?? [:]
        syncCursors = (try? c.decodeIfPresent([String: Int].self, forKey: .syncCursors)).flatMap { $0 } ?? [:]
        unreadable = Self.items(UnreadableItem.self, c, .unreadable, dropped: &dropped) ?? []
        pins = Self.items(BrowserPin.self, c, .pins, dropped: &dropped)
        bookmarks = Self.items(Bookmark.self, c, .bookmarks, dropped: &dropped) ?? []
        droppedItems = dropped
    }
}
