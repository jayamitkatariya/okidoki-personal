import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers
import OkidokiCore

enum DashboardSection: String, CaseIterable, Identifiable {
    case home, browser, runs, history, memory, skills, keys, settings, live, vault
    var id: String { rawValue }
}

@MainActor
final class AppEnvironment: ObservableObject {
    let store: OkidokiStore
    let sidecar: BrainSidecar
    let speech: SpeechRecognizer
    let speaker: VoiceSpeaker
    let watch: WatchRecorder
    let glows: CursorGlowController
    /// The vault folder and its sealed logins.
    let vault: LocalVault

    private(set) var summon: SummonController!
    private(set) var draw: DrawingController!
    private(set) var answerController: AnswerCardController!
    private(set) var ghost: GhostCursorController!
    private(set) var replayer: SkillReplayer!
    private(set) var watchHUD: WatchHUDController!
    private(set) var notch: NotchController!
    private(set) var driver: ComputerUseDriver!
    /// okidoki's own browser window, made the first time it's needed.
    private(set) lazy var browser = BrowserController(environment: self)
    private(set) lazy var browserDriver = BrowserDriver(environment: self)
    private(set) lazy var browserReplayer = BrowserReplayer(environment: self)
    /// Smart replay in the browser (settings.hybridReplay). Off, `browserReplayer` runs as it always has.
    private(set) lazy var hybridBrowserReplayer = HybridBrowserReplayer(environment: self)
    /// The open "check before submitting" card's answer, for scripts (`gate carry|skip|stop`).
    var pendingGate: ((HybridBrowserReplayer.GateAnswer) -> Void)?
    /// The steps of a recording in the browser so far, while one is going.
    var browserRecording: (() -> [SkillStep])?
    /// What a browser run learned before it stopped to ask something, by thread, for the run that continues it.
    var browserLearnedBeforeQuestion: [String: [SkillStep]] = [:]
    /// The last browser run that worked, with what it learned, until it's saved or replaced.
    var lastBrowserRun: LearnedBrowserRun?
    /// Recent web runs that worked, by run id, so one can be kept as a skill later (the card, another agent).
    var savableRuns: [String: LearnedBrowserRun] = [:]
    /// Page texts a finished browser run saw, by run id, until its card is gone (smart replay's compiler reads them).
    var learnedPages: [String: [String: String]] = [:]
    /// The tab a browser run was asked from (typed in that tab's address bar), until the run starts there.
    var browserRunTabs: [String: UUID] = [:]
    /// The macOS VM computer-use runs drive when settings say so; this Mac otherwise.
    let privateMac = PrivateMacService()
    private(set) var simOverlay: SimOverlayController!
    private(set) var statusBar: StatusBarController!
    private(set) var dashboard: DashboardWindowController!
    private(set) var onboarding: OnboardingWindowController!
    private var shake: ShakeDetector!
    private var scheduler: RoutineScheduler!

    @Published var dashboardOpen = false
    @Published var onboardingOpen = false
    @Published var signedOut = false
    @Published var dashboardRoute: DashboardSection = .home
    @Published var dashboardRunID: String?
    /// Where the dashboard's Browser page holds the browser, in the page's points; nil while another page shows.
    @Published var browserFrame: CGRect?
    @Published var askPulse = 0
    @Published var shakePulse = 0
    @Published var inCall = false
    @Published var keysVersion = 0
    /// Last connection result per MCP server id, for Settings.
    @Published var mcpStatus: [String: MCPServerStatus] = [:]
    /// When the MCP servers were last checked, so Settings can say how fresh its status is.
    @Published var mcpCheckedAt: Date?
    /// The brain's Moss index as last reported: after each sync, and on request for the dashboard.
    @Published var memoryIndex = MemoryIndexStatus()
    @Published var isBusy = false
    /// Requests in flight; a routine finishing must not mark a summon request idle.
    private var busyCount = 0 { didSet { isBusy = busyCount > 0 } }
    @Published var suspendSummonForTour = false
    /// Browsers to bring passwords in from, and how the last import went.
    @Published var vaultImport = VaultImportStatus()
    /// A CSV export just imported; it holds passwords in the clear, so okidoki offers to trash it.
    var vaultImportCSV: URL?

    private var summonAppName = "mac"
    private var summonBundleID = ""
    /// Window, browser tab and a small screenshot, gathered while the capsule opens so the brain
    /// can see what the request is about. Finished (or given up on) by the time they submit.
    private var summonContext: Task<ScreenContext?, Never>?
    /// The request the user is waiting on at the capsule or the card. Backing out (esc, the ✕, a
    /// shake, closing the thinking card) cancels it, so a question they walked away from never
    /// answers later, speaks, or starts a run on its own.
    private var foregroundRequest: Task<Void, Never>?
    private var watchRunID: String?
    /// How many passes a queued skill replay should make, by run id.
    private var pendingReplays: [String: Int] = [:]
    /// `{{placeholder}}` values for each pass of a queued replay (one record per pass), by run id.
    var pendingReplayValues: [String: [[String: String]]] = [:]
    /// The last partly failed replay's "retry those" (its toast button), for scripts too.
    var lastFailedReplay: (() -> Void)?
    /// The "your turn" card's take back, while one is showing.
    var pendingHandoff: (() -> Void)?
    /// Conversations other agents started through the control endpoint: their runs (and tabs) are theirs to read.
    var controlThreads: Set<String> = []
    /// "Add to skill" on the newest learn-what-you-did card, for scripts.
    var pendingTeach: (() -> Void)?
    /// Whose "your turn" card is showing.
    var handoffRunID: String?
    var lastHandoffSpoken = Date.distantPast
    /// Runs started with nobody at this Mac (routines): a hand-off there stops instead of waiting.
    var unattendedRuns: Set<String> = []
    /// The words a smart replay was asked with, for finding values the request states in passing.
    var pendingReplayRequests: [String: String] = [:]
    /// Runs following a library template: which template, and the passes still to replay once it's learned.
    var templateRuns: [String: (templateID: String, rest: [[String: String]], request: String, threadID: String)] = [:]
    /// The skill library that ships in the app (Resources/skills), read once.
    private(set) lazy var library: [SkillLibrary.Entry] = SkillLibrary.load(from: Bundle.main.resourceURL?.appendingPathComponent("skills"))
    /// What "again" means in the chat.
    private var lastReplayedSkillID: String?
    private var pendingStarts: [String: DispatchWorkItem] = [:]
    private var pausedStarts: Set<String> = []
    private var mcpRefreshGeneration = 0
    /// Approved-later connector calls by run id: the brain's call JSON, handed back untouched when the run starts.
    private var pendingConnectorCalls: [String: String] = [:]
    private var memoryWork: DispatchWorkItem?
    /// Seconds before the next try after the memory index failed to sync; doubles up to two minutes.
    private var memoryRetryDelay: Double = 5
    /// Hash of the last memory payload the brain accepted, so an unchanged store isn't re-sent.
    /// The last payload the brain indexed. Compared byte for byte: Data's hashValue only covers its
    /// length and first bytes, so a same-length edit (a renamed memory) looked unchanged.
    private var lastMemoryHash: Data?
    private var callTimer: Timer?
    /// Lets local tools (the MCP server, scripts) list and replay skills. 127.0.0.1 only, token required.
    private var control: ControlServer?
    private var nudgeTimer: Timer?
    private var serviceStatusTimer: Timer?
    private var nudgedEvents: Set<String> = []
    private var cancellables = Set<AnyCancellable>()
    private var undoByRun: [String: () -> Void] = [:]

    init() {
        let demo = ProcessInfo.processInfo.environment["OKIDOKI_DEMO"] == "1"
        let store = OkidokiStore(seedDemo: demo)
        self.store = store
        self.sidecar = BrainSidecar()
        self.speech = SpeechRecognizer()
        self.speaker = VoiceSpeaker()
        self.watch = WatchRecorder()
        self.glows = CursorGlowController()
        self.vault = LocalVault(folder: URL(fileURLWithPath: store.settings.vaultFolder, isDirectory: true))
        self.shake = ShakeDetector()
        self.summon = SummonController(environment: self, speech: speech, glow: glows)
        self.draw = DrawingController(environment: self)
        self.answerController = AnswerCardController(environment: self)
        self.ghost = GhostCursorController(environment: self)
        self.replayer = SkillReplayer(environment: self)
        self.watchHUD = WatchHUDController(environment: self)
        self.driver = ComputerUseDriver(environment: self)
        self.simOverlay = SimOverlayController(environment: self)
        self.notch = NotchController(environment: self)

        shake.onShake = { [weak self] in self?.handleShake() }
        watch.onFinish = { [weak self] steps in self?.handleWatchFinished(steps) }
        speaker.onCaption = { [weak self] text in
            guard let self else { return }
            self.notch.model.caption = self.store.settings.captions ? text : nil
        }
        speaker.onCartesiaFailure = { [weak self] reason in self?.cartesiaFailed(reason) }
        // Download/install progress and VM state reach the dashboard and onboarding through the environment.
        privateMac.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        store.$settings
            .receive(on: RunLoop.main)
            .sink { [weak self] settings in
                guard let self else { return }
                self.shake.sensitivity = settings.shakeSensitivity
                self.shake.isEnabled = settings.okidokiEnabled
                // A false shake in voice mode opens the mic, so it takes one more turn to be sure.
                self.shake.deliberate = settings.defaultInput == .voice
                self.notch.model.quiet = settings.quietMode || self.inCall
                self.applyAppearance(settings.appearance)
            }
            .store(in: &cancellables)

        // The panel's Vault page follows the folder as files come and go.
        vault.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        store.$settings.map(\.vaultFolder).removeDuplicates().dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] path in self?.vault.setFolder(URL(fileURLWithPath: path, isDirectory: true)) }
            .store(in: &cancellables)

        store.$settings.map(\.mcpServers).removeDuplicates()
            .combineLatest(store.$connectors.map { $0.first(where: { $0.id == "mcp" })?.enabled == true }.removeDuplicates())
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshMCP() }
            .store(in: &cancellables)

        // Taken synchronously (the store is on the main actor), so a save landing, which the store
        // marks as housekeeping, doesn't schedule the next index push and the next after that.
        store.objectWillChange
            .sink { [weak self] _ in
                guard let self, !self.store.isHousekeeping else { return }
                self.scheduleMemoryIndex()
            }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    func start() {
        applyBuiltinServices()
        applyAppearance(store.settings.appearance)
        vault.start()
        statusBar = StatusBarController(environment: self)
        dashboard = DashboardWindowController(environment: self)
        onboarding = OnboardingWindowController(environment: self)
        notch.install()
        glows.install()
        shake.start()
        if ProcessInfo.processInfo.environment["OKIDOKI_OVERLAY_PREVIEW"] != "1" { sidecar.start() }

        scheduler = RoutineScheduler(store: store)
        scheduler.onDue = { [weak self] routine in
            Task { @MainActor in self?.runRoutine(routine) }
        }
        scheduler.start()
        control = ControlServer(environment: self)
        control?.start()

        // Start MCP servers whenever the brain comes up, so the first request doesn't wait on a cold start.
        sidecar.$status
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] status in
                self?.refreshMCP()
                self?.refreshMemoryStatus()
                guard status.isReady else { return }
                // A fresh brain has an empty index in memory; resend so it loads and catches up.
                self?.lastMemoryHash = nil
                self?.scheduleMemoryIndex(after: 0.2)
            }
            .store(in: &cancellables)

        // While the dashboard is open, keep its MCP and Memory status honest without a toggle or restart.
        $dashboardOpen
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] open in
                guard let self else { return }
                self.serviceStatusTimer?.invalidate()
                self.serviceStatusTimer = nil
                guard open else { return }
                self.refreshServiceStatus()
                self.serviceStatusTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in
                    Task { @MainActor in self?.refreshServiceStatus() }
                }
            }
            .store(in: &cancellables)

        callTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.detectCall() }
        }
        nudgeTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkCalendarNudge() }
        }
        detectCall()

        if ProcessInfo.processInfo.environment["OKIDOKI_OPEN_DASHBOARD"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.openDashboard(.home) }
        } else if ProcessInfo.processInfo.environment["OKIDOKI_OVERLAY_PREVIEW"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.previewOverlays() }
        } else if ProcessInfo.processInfo.environment["OKIDOKI_OPEN_ONBOARDING"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.openOnboarding() }
        } else if !store.settings.onboardingComplete {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.openOnboarding() }
        }

        if ProcessInfo.processInfo.environment["OKIDOKI_DEV_HOOKS"] == "1" { installDevHooks() }
    }

    // MARK: - Dev hooks (OKIDOKI_DEV_HOOKS=1)

    /// Scripted testing: `scripts/dev-drive.sh` posts distributed notifications that start a
    /// computer-use run straight away, send text through the normal pipeline, or stop the run.
    /// Off unless the app is launched with OKIDOKI_DEV_HOOKS=1, since any local process could post them.
    private func installDevHooks() {
        let center = DistributedNotificationCenter.default()
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.drive"), object: nil, queue: .main) { [weak self] note in
            guard let goal = (note.object as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty else { return }
            Task { @MainActor in await self?.devDrive(goal: goal) }
        }
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.ask"), object: nil, queue: .main) { [weak self] note in
            guard let text = note.object as? String else { return }
            Task { @MainActor in self?.askFromDashboard(text) }
        }
        // "x,y" in global Quartz points: a click as the person would make it.
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.click"), object: nil, queue: .main) { note in
            let parts = ((note.object as? String) ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2 else { return }
            Task { await EventActuator.click(at: CGPoint(x: parts[0], y: parts[1])) }
        }
        // Opens the cursor card as a shake would, so a script can check what's on it.
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.summon"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.startSummon() }
        }
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.stop"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.driver.isActive { self.driver.cancel(reason: "stopped by the test script") }
                if self.browserDriver.isActive { self.browserDriver.cancelAll(reason: "stopped by the test script") }
                if self.browserReplayer.isActive { self.browserReplayer.cancel(reason: "stopped by the test script") }
                if self.hybridBrowserReplayer.isActive { self.hybridBrowserReplayer.cancel(reason: "stopped by the test script") }
            }
        }
        // The browser, for scripts/dev-browser.sh: run a goal there, open a page, record, save, replay.
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.browse"), object: nil, queue: .main) { [weak self] note in
            guard let goal = (note.object as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty else { return }
            Task { @MainActor in self?.devBrowse(goal: goal) }
        }
        center.addObserver(forName: Notification.Name("dev.okidoki.personal.dev.browser"), object: nil, queue: .main) { [weak self] note in
            let command = (note.object as? String) ?? ""
            Task { @MainActor in self?.devBrowser(command) }
        }
    }

    /// A goal starting with "[fresh] " gets its own conversation, so scripted runs of the same task
    /// don't see each other (the agent would rightly ask before filing the same return twice).
    private func devBrowse(goal raw: String) {
        let fresh = raw.hasPrefix("[fresh] ")
        let goal = fresh ? String(raw.dropFirst("[fresh] ".count)) : raw
        let preview = ActionPreview(summary: String(goal.prefix(54)), risk: .medium,
                                    steps: [PreviewStep("open the site"), PreviewStep("read the page and work through it"), PreviewStep("report back")],
                                    commands: [], apps: ["okidoki browser"], files: [])
        let thread = fresh ? store.createThread(title: String(goal.prefix(40)), app: "okidoki browser", topic: inferTopic(goal))
                           : store.threadForContext(app: "okidoki browser", topic: inferTopic(goal), text: goal)
        store.appendMessage(threadID: thread.id, role: .user, text: goal)
        let run = store.createRun(kind: .browser, title: String(goal.prefix(54)), prompt: goal, threadID: thread.id, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) }, status: .waiting, builtin: "browser")
        store.saveNow()
        approveRun(run.id)
    }

    /// `open <url>` · `record` · `save <name>` · `keep <name>` (save the last run's steps) · `replay <name>` ·
    /// `eval <js>` (result written to dev-browser.json beside the state file).
    private func devBrowser(_ command: String) {
        let parts = command.split(separator: " ", maxSplits: 1).map(String.init)
        let arg = parts.count > 1 ? parts[1] : ""
        switch parts.first ?? "" {
        case "open": browser.show(url: BrowserSteps.addressURL(arg))
        case "record": startBrowserRecording()
        // The address bar's “Ask okidoki”, in the tab in front (or tab N: `ask 2 <task>`).
        case "ask":
            let words = arg.split(separator: " ", maxSplits: 1).map(String.init)
            if let number = words.first.flatMap(Int.init), let tab = browser.tab(number: number), words.count > 1 {
                startBrowserTask(words[1], in: tab)
            } else {
                browser.show()
                startBrowserTask(arg, in: browser.activeTab)
            }
        case "newtab": browser.openTab(url: BrowserSteps.addressURL(arg), activate: true)
        case "tab": if let number = Int(arg), let tab = browser.tab(number: number) { browser.select(tab) }
        case "tabs":
            let list = browser.model.tabs.map { tab -> [String: Any] in
                ["number": tab.number, "title": tab.label, "url": tab.address, "active": tab.id == browser.model.activeID,
                 "owner": tab.ownerRunID ?? "", "status": tab.status ?? "", "thread": tab.threadID ?? ""]
            }
            if let data = try? JSONSerialization.data(withJSONObject: ["result": list, "url": ""]) {
                try? data.write(to: AppPaths.support("dev-browser.json"))
            }
        case "save":
            if let steps = browserRecording?() { browser.stopRecording(); browserRecording = nil
                saveBrowserSkill(name: arg.isEmpty ? "recorded flow" : arg, steps: BrowserRecordingCleanup.tidy(steps), source: "watch me") }
        case "keep":
            if let last = lastBrowserRun { saveBrowserSkill(name: arg.isEmpty ? last.title : arg, steps: last.steps, source: "act", learnedFrom: last) }
        case "answer":
            // The reply box on the question card, for the newest run that's waiting on one.
            if let asked = store.runs.first(where: { $0.status == .asked }) { answerDriveQuestion(runID: asked.id, text: arg) }
        case "replay":
            if let skill = store.activeSkills.first(where: { $0.name == arg }) {
                let run = makeReplayRun(skill, times: 1, threadID: nil)
                approveRun(run.id)
            }
        // For scripts/replay-eval.py: `hybrid on|off` flips smart replay; `replayjson {"skill": name,
        // "values": [{…}, …]}` replays once per values object, the way records do.
        case "hybrid":
            store.settings.hybridReplay = arg == "on"
            store.saveNow()
        // The notch's okay on a run waiting for one, for scripts (`approve <run id>`).
        case "approve":
            if let run = store.run(arg), [.waiting, .previewing].contains(run.status) { approveRun(run.id) }
        // `importskill <path to .okiskill>`: adds a skill file the way "import" does (scripts/cu-replay-eval.py).
        case "importskill":
            importSkill(at: URL(fileURLWithPath: arg))
        case "forget":
            for skill in store.activeSkills where skill.name == arg || skill.id == arg { store.deleteSkill(skill.id) }
            store.saveNow()
        // The person's side of a hand-off, for scripts: `takeback`, `pause`, and `tabjs <js>` (run in the
        // tab in front, as if the person did it there).
        // `dropstep <skill name>|<step text>`: undoes a lesson, for scripts that teach a skill and then restore it.
        case "dropstep":
            let parts = arg.components(separatedBy: "|")
            if parts.count == 2, var skill = store.activeSkills.first(where: { $0.name == parts[0] }) {
                skill.steps.removeAll { $0.text == parts[1] }
                store.replaceSkill(skill)
                store.saveNow()
            }
        case "clearcache":
            Task { await browser.clearCache() }
        case "teach":
            pendingTeach?()
            pendingTeach = nil
        case "takeback":
            if let back = pendingHandoff { back() } else { hybridBrowserReplayer.takeBack() }
        case "pause":
            // The notch's button on whatever is running: `pause` for the smart replay, `pause <run id>` for any.
            if !arg.isEmpty { pauseRun(arg, from: "script") }
            else if let id = hybridBrowserReplayer.runID { pauseRun(id, from: "script") }
        case "tabjs":
            let tab = browser.activeTab
            Task { @MainActor in _ = await tab.call(arg) }
        case "retryfailed":
            lastFailedReplay?()
            lastFailedReplay = nil
        case "gate":
            if let answer = HybridBrowserReplayer.GateAnswer(rawValue: arg) { pendingGate?(answer); pendingGate = nil }
        case "replayjson":
            guard let data = arg.data(using: .utf8),
                  let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let name = body["skill"] as? String,
                  let skill = store.activeSkills.first(where: { $0.name == name }) else { break }
            let values = (body["values"] as? [[String: Any]] ?? []).map { $0.compactMapValues { "\($0)" } }
            let run = makeReplayRun(skill, times: 1, threadID: nil, values: values)
            approveRun(run.id)
        // A person's input, through the real event system: `click <css selector>`, `type <text>`, `key <combo>`.
        case "click":
            Task { @MainActor in
                guard let point = await browser.screenPoint(of: arg) else { return }
                await EventActuator.click(at: point)
            }
        case "type": Task { await EventActuator.typeText(arg) }
        case "key": Task { _ = await EventActuator.pressKey(arg) }
        case "route":
            if let section = DashboardSection(rawValue: arg) { dashboardRoute = section }
        case "dash":
            Task { @MainActor in
                let value: Any? = try? await WebDashboardController.current?.callAsyncJavaScript(arg, arguments: [:], in: nil, contentWorld: .page)
                let text: Any = value.map { "\($0)" } ?? NSNull()
                if let data = try? JSONSerialization.data(withJSONObject: ["result": text, "url": ""]) {
                    try? data.write(to: AppPaths.support("dev-browser.json"))
                }
            }
        case "winfo":
            let info = browser.windowInfo()
            if let data = try? JSONSerialization.data(withJSONObject: ["result": info, "url": ""]) {
                try? data.write(to: AppPaths.support("dev-browser.json"))
            }
        case "eval":
            Task { @MainActor in
                let value = await browser.call(arg)
                let json: Any = ["result": value.map { "\($0)" } ?? NSNull(), "url": browser.webView.url?.absoluteString ?? ""]
                if let data = try? JSONSerialization.data(withJSONObject: json) {
                    try? data.write(to: AppPaths.support("dev-browser.json"))
                }
            }
        default: break
        }
    }

    private func devDrive(goal: String) async {
        guard !driver.isActive else { return }
        if !EventActuator.canPost { _ = await PermissionsService.shared.request(.accessibility) }
        if !CGPreflightScreenCaptureAccess() { _ = await PermissionsService.shared.request(.screen) }
        let title = String(goal.prefix(54))
        let preview = ActionPreview(summary: title, risk: .medium,
                                    steps: [PreviewStep("look at the screen"), PreviewStep("click and type through it"),
                                            PreviewStep("hand control back")],
                                    commands: [], apps: ["your apps"], files: [])
        let thread = store.threadForContext(app: "mac", topic: inferTopic(goal), text: goal)
        store.appendMessage(threadID: thread.id, role: .user, text: goal)
        let run = store.createRun(kind: .computerUse, title: title, prompt: goal, threadID: thread.id, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "computer-use")
        store.saveNow()
        approveRun(run.id)
    }

    func stop() {
        store.saveNow()
        control?.stop()
        speech.stop()
        speaker.stop()
        shake.stop()
        glows.hide()
        ShellRunner.shared.cancelAll()
        sidecar.stop()
        callTimer?.invalidate()
        nudgeTimer?.invalidate()
        scheduler?.stop()
    }

    private func applyAppearance(_ appearance: AppAppearance) {
        switch appearance {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }

    // MARK: - Summon

    private func handleShake() {
        shakePulse += 1
        if suspendSummonForTour { return }
        guard store.settings.okidokiEnabled else { return }
        // Pointer movement must never interrupt an active action, recording, or replay.
        // Use the session's explicit controls or Escape to stop it.
        guard !driver.isActive, !watch.isRecording, !replayer.isActive,
              !ghost.model.visible else { return }
        if simOverlay.isVisible { simOverlay.dismiss(); return }
        if drawActive { draw.dismissAll(); dismissSummon(); return }
        if summon.model.isVisible || answerControllerVisible {
            dismissSummon()
            return
        }
        startSummon()
    }

    var drawActive: Bool {
        // DrawingController is the only thing that can hold a full-screen key panel.
        NSApp.keyWindow is DrawingPanel || NSApp.windows.contains { $0 is DrawingPanel && $0.isVisible }
    }

    var answerControllerVisible: Bool {
        NSApp.windows.contains { $0 is CardPanel && $0.isVisible }
    }

    func startSummon() {
        // Reaching for it while it's up puts it away, request and all, the same as esc or a shake.
        if summon.model.isVisible { dismissSummon(); return }
        let front = NSWorkspace.shared.frontmostApplication
        summonContext?.cancel()
        summonContext = nil
        if front?.bundleIdentifier != Bundle.main.bundleIdentifier {
            summonAppName = front?.localizedName ?? "mac"
            summonBundleID = front?.bundleIdentifier ?? ""
            // Start looking at the screen now, before the capsule covers anything and while they type.
            if store.settings.screenContext, hasKey("anthropic") {
                let screen = OverlayPlacement.mouseScreen ?? NSScreen.okidokiPrimary
                let model = store.settings.claudeModel
                summonContext = Task { [weak self] in
                    guard self != nil else { return nil }
                    return await ScreenContextService.capture(app: front, screen: screen, model: model)
                }
            }
        } else {
            summonAppName = "mac"
            summonBundleID = ""
        }
        answerController.close(restoreApp: false)
        summon.start()
        notch.noteListening(store.settings.defaultInput == .voice)
    }

    /// Claims the summon-time capture so a later dismiss can't cancel it out from under the request.
    private func claimSummonContext() -> Task<ScreenContext?, Never>? {
        defer { summonContext = nil }
        return summonContext
    }

    /// The claimed screen context, waiting at most `timeout` seconds for it to finish.
    /// A slow capture must never hold up the request; it just goes without the picture.
    /// (Awaiting a Task's value ignores cancellation, so this is a first-wins race, not a group.)
    private func awaitSummonContext(_ task: Task<ScreenContext?, Never>?, timeout: Double = 2.5) async -> ScreenContext? {
        guard let task else { return nil }
        let once = FirstWins()
        return await withCheckedContinuation { (continuation: CheckedContinuation<ScreenContext?, Never>) in
            Task { @MainActor in
                let value = await task.value
                if once.claim() { continuation.resume(returning: value) }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                if once.claim() { task.cancel(); continuation.resume(returning: nil) }
            }
        }
    }

    func dismissSummon() {
        summonContext?.cancel()
        summonContext = nil
        cancelForegroundRequest()
        draw.dismissAll()
        summon.dismiss()
        answerController.close()
        ghost.cancel()
        notch.noteListening(false)
        notch.collapse()
    }

    /// Runs a request the user is waiting on in front of them. Only one is ever in flight: a new
    /// one replaces (and cancels) the last, and `cancelForegroundRequest` drops it on the floor.
    private func startForegroundRequest(_ work: @escaping @MainActor () async -> Void) {
        foregroundRequest?.cancel()
        let task = Task { @MainActor in await work() }
        foregroundRequest = task
    }

    /// The user backed out of the question they were waiting on. The pipeline checks for this
    /// after every pause and before anything that would show, say or start something.
    func cancelForegroundRequest() {
        guard let task = foregroundRequest else { return }
        foregroundRequest = nil
        task.cancel()
    }

    /// Dev-only: stage the two overlay surfaces so their chrome can be reviewed
    /// without waiting on a real request. Enabled with OKIDOKI_OVERLAY_PREVIEW=1.
    func previewOverlays() {
        FileHandle.standardError.write(Data("PREVIEW start\n".utf8))
        store.settings.defaultInput = .typing
        startSummon()
        summon.model.text = "Summarise this page"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            for w in NSApp.windows {
                FileHandle.standardError.write(Data("WIN \(type(of: w)) frame=\(w.frame) alpha=\(w.alphaValue) vis=\(w.isVisible) level=\(w.level.rawValue)\n".utf8))
            }
        }
        FileHandle.standardError.write(Data("PREVIEW summon started visible=\(summon.model.isVisible)\n".utf8))
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in
            guard let self else { return }
            let card = AnswerCardModel(
                title: "Here’s what I found",
                text: "Okidoki wakes up when you reach for it. The capsule leads with the mark, "
                    + "the composer glows when it has focus, and every control answers the pointer.",
                footnote: "shake the pointer to summon · esc to dismiss",
                actions: [
                    CardAction(title: "Do it", kind: .primary, handler: {}),
                    CardAction(title: "Copy link", kind: .secondary, handler: {}),
                    CardAction(title: "Skip", kind: .ghost, handler: {}),
                ],
                threadTitle: "okidoki")
            card.followUpEnabled = true
            FileHandle.standardError.write(Data("PREVIEW showing card\n".utf8))
            self.answerController.show(card, near: NSEvent.mouseLocation)
        }
    }

    func submitSummon(text: String, screenshot: Data?, selection: CGRect?, attachmentName: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || screenshot != nil else { return }
        let appName = summonAppName
        let bundleID = summonBundleID
        let pendingContext = claimSummonContext()
        startForegroundRequest { [weak self] in
            guard let self else { return }
            let screenContext = await self.awaitSummonContext(pendingContext)
            guard !Task.isCancelled else { return }
            await self.handleRequest(text: text, appName: appName, bundleID: bundleID, threadID: nil,
                                     screenshot: screenshot, selection: selection,
                                     attachmentName: attachmentName, documentText: "", source: "summon",
                                     screenContext: screenContext, mode: self.summon.model.summonMode.rawValue)
            guard !Task.isCancelled else { return }
            self.summon.hideInput()
        }
    }

    func followUp(card: AnswerCardModel, text: String) {
        noteSpokenInput(false)
        let threadID = card.threadID
        let runID = card.runID
        answerController.close(restoreApp: false)
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if let runID, store.run(runID)?.status == .waiting,
           lower.contains("do it") || lower.contains("go ahead") || ["yes", "yep", "yeah", "ok", "okay", "sure", "allow", "allow once", "approve", "run it"].contains(lower) {
            approveRun(runID)
            return
        }
        startForegroundRequest { [weak self] in
            await self?.handleRequest(text: text, appName: "mac", bundleID: "", threadID: threadID,
                                      screenshot: nil, selection: nil, attachmentName: "",
                                      documentText: "", source: "followup")
        }
    }

    /// A drive paused on a question only the user can answer. The card shows it with a reply box;
    /// the reply starts a new run in the same thread that carries on from where this one stopped.
    func presentDriveQuestion(runID: String, question: String) {
        guard let run = store.run(runID) else { return }
        let card = AnswerCardModel(title: "one thing first", text: question,
                                   threadTitle: run.threadID.flatMap { store.thread($0)?.title },
                                   runID: runID, threadID: run.threadID)
        card.footnote = "paused · \(run.title)"
        card.onSubmitFollowUp = { [weak self] text in
            self?.answerDriveQuestion(runID: runID, text: text)
        }
        present(card, source: "followup")
        speak(question)
    }

    func answerDriveQuestion(runID: String, text: String) {
        let reply = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reply.isEmpty else { return }
        noteSpokenInput(false)
        answerController.close(restoreApp: false)
        guard let prior = store.run(runID), prior.status == .asked, [.computerUse, .browser].contains(prior.kind),
              let threadID = prior.threadID else {
            if let threadID = store.run(runID)?.threadID { continueThread(threadID, text: reply) }
            return
        }
        store.appendMessage(threadID: threadID, role: .user, text: reply)
        store.markAnswered(prior.id, reply: reply)
        // The browser agent starts a fresh conversation per run, so it's told the task and the answer.
        let prompt = prior.kind == .browser ? "\(prior.prompt)\n\nYou asked: \(prior.summary)\nThey answered: \(reply)" : reply
        let run = store.createRun(kind: prior.kind, title: prior.title, prompt: prompt, threadID: threadID,
                                  preview: prior.preview, steps: (prior.preview?.steps ?? []).map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: prior.kind == .browser ? "browser" : "computer-use")
        // The answer carries on in the tab the question was asked from.
        if let tab = browserRunTabs.removeValue(forKey: prior.id) { browserRunTabs[run.id] = tab }
        store.saveNow()
        approveRun(run.id)
    }

    // MARK: - Request pipeline

    func askFromDashboard(_ text: String, source: String = "dashboard") {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        noteSpokenInput(false)
        Task {
            await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: nil,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: source)
        }
    }

    /// Another agent's request (the `okidoki` CLI, the MCP server): a conversation of its own unless it
    /// continues one, in the mode it asked for (auto · browser · computer · chat). The thread id is how it
    /// finds the run doing the work. Everything risky still waits for the person's okay in the notch.
    func askFromControl(_ text: String, mode: String, threadID: String?) -> String {
        let thread = threadID.flatMap { store.thread($0) } ?? store.createThread(title: String(text.prefix(60)), app: "agent", topic: "")
        controlThreads.insert(thread.id)
        // Continuing a conversation whose last task asked a question: this is the answer.
        if let last = store.runs.first(where: { $0.threadID == thread.id && [.computerUse, .browser].contains($0.kind) }),
           last.status == .asked {
            answerDriveQuestion(runID: last.id, text: text)
            return thread.id
        }
        let modes = ["browser": "browser", "computer": "act", "act": "act", "chat": "chat"]
        noteSpokenInput(false)
        Task {
            await handleRequest(text: text, appName: "mac", bundleID: "", threadID: thread.id,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "control", mode: modes[mode] ?? "auto")
        }
        return thread.id
    }

    func requestAsk() {
        askPulse += 1
        if !dashboardOpen { openDashboard(.home) }
    }

    func continueThread(_ threadID: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Typed into a conversation whose last task paused on a question: that's the answer.
        if let last = store.runs.first(where: { $0.threadID == threadID && [.computerUse, .browser].contains($0.kind) }),
           last.status == .asked {
            answerDriveQuestion(runID: last.id, text: trimmed)
            return
        }
        noteSpokenInput(false)
        Task {
            await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: threadID,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "followup")
        }
    }

    private func handleRequest(text: String, appName: String, bundleID: String, threadID: String?,
                               screenshot: Data?, selection: CGRect?, attachmentName: String,
                               documentText: String, source: String,
                               screenContext: ScreenContext? = nil, mode: String = "auto") async {
        // Skills and recordings are driven straight from the chat: "replay invoice flow", "stop",
        // "save as …", "my skills". No brain round trip, no key needed, no variance.
        if screenshot == nil, documentText.isEmpty, source != "repair",
           let command = ChatCommands.parse(text, context: chatContext()) {
            // "File the returns for Jay and Neha, their documents are in the vault" reads like "file this into
            // the vault". With smart replay on, a skill that does the job gets the first look.
            if case .addToVault = command, store.settings.hybridReplay, hasKey("anthropic"), !ReplayDispatcher.wantsAgent(text) {
                let thread = threadID.flatMap { store.thread($0) } ?? store.threadForContext(app: appName, topic: inferTopic(text), text: text)
                if await dispatchToSkill(text, threadID: thread.id, source: source, echo: true) { return }
            }
            handleChatCommand(command, text: text, appName: appName, threadID: threadID, source: source)
            return
        }
        // "Import my memory from Claude Code": read on the Mac itself, no model needed.
        if screenshot == nil, documentText.isEmpty, let plan = MemoryImport.plan(text) {
            await offerMemoryImport(plan, prompt: text, threadID: threadID, source: source)
            return
        }
        guard hasKey("anthropic") else {
            presentNeedsKey(prompt: text, threadID: threadID, source: source)
            return
        }
        busyCount += 1
        defer { busyCount -= 1 }
        var document = documentText
        var docName = attachmentName
        let lower = text.lowercased()
        // A circled region is the thing to summarise; only ask for a file when there's nothing attached,
        // and never for a routine: a file picker would sit open on an unattended Mac.
        // Nor for another agent's request (MCP): a modal picker it never asked for would block the Mac.
        if document.isEmpty, screenshot == nil, !Self.isUnattended(source), source != "control",
           (lower.contains("summar") || lower.hasPrefix("read this pdf")) {
            if let url = await pickFile(kind: "pdf", prompt: "choose a PDF to read") {
                document = DocumentReader.read(url: url) ?? ""
                docName = url.lastPathComponent
            }
            guard !Task.isCancelled else { return }
        }

        let thread: OkidokiCore.ChatThread
        if let threadID, let existing = store.thread(threadID) {
            thread = existing
        } else if lower.contains("start fresh") {
            thread = store.createThread(title: "fresh thread", app: appName, topic: "")
        } else {
            thread = store.threadForContext(app: appName, topic: inferTopic(text), text: text)
        }

        store.appendMessage(threadID: thread.id, role: .user, text: text.isEmpty ? "look at this" : text)
        // The clipboard is read and sent only when the request names it. Otherwise a copied answer
        // or an unrelated snippet would ride along with every question and the model would answer
        // the clipboard instead of what was typed. Not reading it also keeps macOS from flagging
        // a pasteboard access on every request.
        var clipboard = ""
        if BrainService.mentionsClipboard(text) {
            let priorTurns = (store.thread(thread.id)?.messages ?? []).map(\.text)
            clipboard = BrainService.relevantClipboard(NSPasteboard.general.string(forType: .string) ?? "",
                                                       request: text, history: priorTurns)
        }
        var request = BrainRequest(text: text, appName: appName, bundleID: bundleID,
                                   threadID: thread.id, screenshotPNG: screenshot,
                                   selection: selection, source: source,
                                   attachmentName: docName, documentText: document,
                                   clipboardText: clipboard, screen: screenContext)
        request.mode = mode
        var events: [BrainNativeEvent] = []
        if store.settings.appleCalendar,
           lower.contains("calendar") || lower.contains("meeting") || lower.contains("schedule") || lower.contains("what's next") {
            if let today = try? await AppleBridge.shared.eventsToday() {
                let formatter = ISO8601DateFormatter()
                events = today.prefix(10).map { BrainNativeEvent(title: $0.title, start: formatter.string(from: $0.start)) }
            }
            guard !Task.isCancelled else { return }
        }
        let history = (store.thread(thread.id)?.messages ?? []).map { BrainMessage(role: $0.role.rawValue, text: $0.text) }
        // The account's current notes; anything else it remembers is found by meaning in the memory index.
        let memory = store.memoryLines()
        var decision: BrainDecision?
        if sidecar.status.isReady {
            switch await BrainClient.shared.think(text: text, request: request, history: history,
                                                  memory: memory, events: events,
                                                  settings: store.settings, account: store.activeAccount,
                                                  frontWindow: screenContext?.windowTitle ?? "",
                                                  connectors: connectorsPayload()) {
            case .answered(let envelope):
                decision = envelope.decision
            case .failed(let why):
                // The brain is up and already waited on the model once; a second full round trip from
                // here would only double the silence. Say what happened instead.
                decision = BrainDecision(kind: .answer, title: "model unavailable",
                                         answer: "the model didn't answer, so i stopped instead of guessing. \(why). try again in a moment.")
            case .unreachable:
                break
            }
        }
        // Backing out aborts the call, which reads as a failure above; the user asked for silence.
        guard !Task.isCancelled else { return }
        if let decision {
            await handleDecision(decision, request: request, threadID: thread.id, source: source)
        } else {
            let result = await BrainService(store: store).think(request)
            guard !Task.isCancelled else { return }
            await handleDecision(result.decision, request: request, threadID: thread.id, source: source)
        }
    }

    /// Routines run with nobody at this Mac: nothing may wait on a person here.
    static func isUnattended(_ source: String) -> Bool { source == "routine" }

    private func handleDecision(_ decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        guard !Task.isCancelled else { return }
        var decision = decision
        if Self.isUnattended(source), let needsPerson = Self.needsSomeoneHere(decision.kind) {
            // A recording, the ghost cursor or a drawing takes over this Mac's screen and
            // waits for whoever is at it; from a schedule that is nobody.
            decision.kind = .answer
            decision.answer = "That would need someone at this Mac (\(needsPerson)). Ask it from the Mac itself, or ask for something it can do on its own, like a replay or a web task."
            decision.speak = ""
            decision.title = String(request.text.prefix(60))
        }
        // The mode picked on the cursor card wins, even over a brain that routed differently.
        switch request.mode {
        case "chat" where ![.answer, .memory].contains(decision.kind):
            let said = decision.answer.trimmingCharacters(in: .whitespacesAndNewlines)
            let plan = decision.previewSteps.isEmpty ? "" : "\n\n" + decision.previewSteps.map { "· \($0)" }.joined(separator: "\n")
            decision.kind = .answer
            decision.answer = (said.isEmpty ? "here's how i'd go about it:" : said) + plan + "\n\nswitch the card to Act and i'll do it."
        case "act" where decision.kind == .browser:
            // Act drives the whole Mac; a web task still works there, through the real browser.
            decision.kind = .computerUse
            decision.previewSummary = decision.previewSummary.isEmpty ? request.text : decision.previewSummary
        case "browser" where [.computerUse, .borrow, .answer].contains(decision.kind):
            decision.kind = .browser
            decision.previewSummary = decision.previewSummary.isEmpty ? request.text : decision.previewSummary
        default:
            break
        }
        // A follow-up to a web task ("now add the cheapest to the cart") carries on in the browser, in the
        // same tab, unless the person picked Act or it names a Mac app to drive.
        if request.mode != "act", decision.kind == .computerUse,
           decision.apps.allSatisfy({ Self.browserApps.contains($0.lowercased()) }),
           store.runs.first(where: { $0.threadID == threadID && $0.kind != .answer })?.kind == .browser {
            decision.kind = .browser
            decision.previewSummary = decision.previewSummary.isEmpty ? request.text : decision.previewSummary
        }
        var saved: [String] = []
        for fact in decision.memory where BrainService.isDurableFact(fact) {
            if let item = store.addMemory(fact, section: fact.lowercased().hasPrefix("right now") ? .rightNow : .aboutYou,
                                          source: source == "summon" ? "said" : source) { saved.append(item.text) }
        }
        // The confirmation lists what was actually kept, never what the model meant to keep.
        if decision.kind == .memory {
            let known = decision.memory.filter { fact in store.memories.contains { $0.text.lowercased() == fact.lowercased() } }
            decision.answer = saved.isEmpty && known.isEmpty
                ? "I couldn't find a lasting fact to keep there. Try \"remember that …\" with the detail itself."
                : "Noted. I'll remember:\n" + (saved.isEmpty ? known : saved).map { "· \($0)" }.joined(separator: "\n")
            decision.previewSummary = (saved.isEmpty ? known : saved).joined(separator: " · ")
        }
        // Replay first: with smart replay on, a saved skill that does exactly this job runs in seconds
        // instead of the agent working it out again. The agent still takes anything no skill covers.
        if store.settings.hybridReplay, [.browser, .computerUse].contains(decision.kind), request.mode != "chat",
           !ReplayDispatcher.wantsAgent(request.text),
           await dispatchToSkill(request.text, threadID: threadID, source: source) {
            return
        }
        switch decision.kind {
        case .answer:
            let run = store.createRun(kind: .answer, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
            let card = makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run)
            present(card, source: source)
            speak(decision.speak.isEmpty ? decision.answer : decision.speak)

        case .memory:
            let run = store.createRun(kind: .answer, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
            present(makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run), source: source)
            toast(title: "noted", detail: decision.previewSummary.isEmpty ? decision.answer : decision.previewSummary,
                  kind: .success, undoLabel: nil, onUndo: nil, editLabel: "memory", onEdit: { [weak self] in
                      self?.openDashboard(.memory)
                  }, runID: nil)
            speak("Noted.")

        case .quickAction:
            await performQuickAction(decision: decision, request: request, threadID: threadID, source: source)

        case .routine:
            // A routine firing must do its job, never schedule itself again.
            if source == "routine" {
                let run = store.createRun(kind: .routine, title: decision.title, prompt: request.text,
                                          threadID: threadID, status: .failed)
                store.updateRun(run.id) { $0.summary = "this routine's request reads like a schedule; edit it to say what to do each time" }
                present(makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run), source: source)
                break
            }
            let weekday = decision.routineWeekday ?? 6
            var hour = decision.routineHour ?? 17
            if hour < 0 || hour > 23 { hour = 17 }
            let cadence = RoutineCadence(rawValue: decision.routineCadence ?? "weekly") ?? .weekly
            let name = decision.routineName ?? decision.title
            // What to run each time, in their words ("summarize my inbox"), not the scheduling sentence.
            let each = decision.commands.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            let routine = store.createRoutine(name: name, prompt: each ?? request.text,
                                              cadence: cadence, weekday: weekday, hour: hour,
                                              minute: decision.routineMinute ?? 0)
            let run = store.createRun(kind: .routine, title: "routine · \(routine.name)",
                                      prompt: request.text, threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
            var actions: [CardAction] = []
            actions.append(CardAction(title: "run now", kind: .secondary) { [weak self] in
                self?.runRoutine(routine)
            })
            actions.append(CardAction(title: "open routines", kind: .ghost) { [weak self] in
                self?.openDashboard(.skills)
            })
            let card = AnswerCardModel(title: decision.title, text: decision.answer, actions: actions,
                                       threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
            card.footnote = routine.scheduleLabel
            present(card, source: source)
            toast(title: "routine saved", detail: routine.scheduleLabel, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "edit", onEdit: { [weak self] in
                      self?.openDashboard(.skills)
                  }, runID: run.id)
            speak(decision.speak.isEmpty ? "Routine saved." : decision.speak)

        case .watch:
            startWatching(prompt: request.text, threadID: threadID, decision: decision)
            summon.hideInput()

        case .borrow:
            await prepareBorrow(decision: decision, request: request, threadID: threadID, source: source)

        case .computerUse:
            await prepareComputerUse(decision: decision, request: request, threadID: threadID, source: source)

        case .browser:
            await prepareBrowser(decision: decision, request: request, threadID: threadID, source: source)

        case .overlay:
            await handleOverlay(decision: decision, request: request, threadID: threadID, source: source)

        case .connector:
            await prepareConnector(decision: decision, request: request, threadID: threadID, source: source)
        }
    }

    /// Apps a web task may name that okidoki's own browser stands in for.
    static let browserApps: Set<String> = ["", "safari", "google chrome", "chrome", "arc", "dia", "firefox", "brave", "brave browser",
                                           "microsoft edge", "edge", "browser", "okidoki browser", "web", "the web"]

    /// What an unattended Mac can't give: the kinds that take the screen and wait for a person.
    static func needsSomeoneHere(_ kind: BrainDecision.Kind) -> String? {
        switch kind {
        case .watch: return "a recording of what you do"
        case .borrow: return "borrowing the cursor"
        case .overlay: return "drawing on the screen"
        default: return nil
        }
    }

    func present(_ card: AnswerCardModel, source: String) {
        // Routines report elsewhere; a card at the cursor would interrupt whoever's at this Mac.
        guard !Self.isUnattended(source) else { return }
        // A request the user backed out of has nothing to show.
        guard !Task.isCancelled else { return }
        if card.onClose == nil {
            card.onClose = { [weak self] in self?.answerController.close() }
        }
        if card.onSubmitFollowUp == nil {
            card.onSubmitFollowUp = { [weak self, weak card] text in
                guard let self, let card else { return }
                self.followUp(card: card, text: text)
            }
        }
        let cursor = summon.model.isVisible ? NSEvent.mouseLocation : nil
        // Only an answer the user is waiting on at the capsule takes the keyboard; one that arrives
        // from the dashboard or a replay must not pull typing away from the app they're in.
        let takesFocus = ["summon", "followup", "onboarding"].contains(source) || summon.model.isVisible
        answerController.show(card, near: cursor, makeKey: takesFocus)
    }

    private func makeAnswerCard(decision: BrainDecision, request: BrainRequest,
                                threadID: String, run: AgentRun) -> AnswerCardModel {
        let card = AnswerCardModel(title: decision.title, text: decision.answer,
                                   actions: [],
                                   threadTitle: store.thread(threadID)?.title,
                                   runID: run.id, threadID: threadID)
        return card
    }

    // MARK: - Quick actions

    private func performQuickAction(decision: BrainDecision, request: BrainRequest,
                                    threadID: String, source: String) async {
        guard let action = decision.quickAction else {
            let run = store.createRun(kind: .quickAction, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .done)
            present(makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run), source: source)
            return
        }
        // A single click is the borrow flow (find it, ghost cursor, click once), not something done here.
        if action.type == "click" {
            await prepareBorrow(decision: decision, request: request, threadID: threadID, source: source)
            return
        }
        // Anything else this Mac can't perform: show the answer instead of claiming it's done.
        guard action.type == "event" || action.type == "move_event" else {
            let run = store.createRun(kind: .quickAction, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .done)
            present(makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run), source: source)
            return
        }
        do {
            var undo: (() -> Void)?
            var toastDetail = decision.previewSummary
            switch action.type {
            case "event":
                let start = action.date.flatMap(DateParsing.iso8601) ?? Date().addingTimeInterval(3600)
                let id = try await AppleBridge.shared.addEvent(title: action.title, start: start,
                                                               end: start.addingTimeInterval(3600))
                undo = { Task { try? await AppleBridge.shared.deleteEvent(uid: id) } }
                if toastDetail.isEmpty { toastDetail = "\(relativeTime(start))" }
            case "move_event":
                let moved = try await AppleBridge.shared.moveEvent(startingHour: action.hour ?? 15,
                                                                   toWeekday: action.weekday ?? 6)
                toastDetail = "moved “\(moved)”"
            default:
                break
            }

            let run = store.createRun(kind: .quickAction, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .done)
            store.updateRun(run.id) { run in run.summary = toastDetail }
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)

            let card = makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run)
            if let undo {
                card.actions.insert(CardAction(title: "undo", kind: .ghost) { [weak self] in
                    undo()
                    self?.toast(title: "undone", detail: "put it back", kind: .info,
                                undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                }, at: 0)
            }
            present(card, source: source)
            if undo != nil {
                undoByRun[run.id] = undo
            }
            toast(title: decision.title, detail: toastDetail, kind: .success,
                  undoLabel: undo == nil ? nil : "undo",
                  onUndo: undo,
                  editLabel: undo == nil ? nil : "edit",
                  onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) },
                  runID: run.id)
            if store.settings.confirmOK {
                confirmOK()
            } else {
                speak(decision.speak.isEmpty ? "Done." : decision.speak)
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            let run = store.createRun(kind: .quickAction, title: decision.title, prompt: request.text,
                                      threadID: threadID, status: .failed)
            store.updateRun(run.id) { $0.summary = message }
            let card = AnswerCardModel(title: "couldn't do that",
                                       text: message + "\n\nconnect Calendar in settings, or grant automation when macOS asks.",
                                       actions: [CardAction(title: "open settings", kind: .secondary) { [weak self] in
                                           self?.openDashboard(.settings)
                                       }],
                                       threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
        }
    }

    // MARK: - Tasks

    private func prepareBorrow(decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        if !store.settings.screenBorrowing { store.settings.screenBorrowing = true }
        if !EventActuator.canPost { _ = await PermissionsService.shared.request(.accessibility) }
        guard !Task.isCancelled else { return }
        let target = decision.quickAction?.title ?? request.text
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? "click \(target)" : decision.previewSummary,
                                    risk: .medium,
                                    steps: [PreviewStep("find “\(target)” in the frontmost app"),
                                            PreviewStep("move a ghost cursor there"),
                                            PreviewStep("click once, then hand control back")],
                                    commands: [],
                                    apps: [NSWorkspace.shared.frontmostApplication?.localizedName ?? "app"],
                                    files: [])
        let run = store.createRun(kind: .borrow, title: decision.title, prompt: request.text,
                                  threadID: threadID, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "click", pickedPath: target)
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "clicking “\(target)”. press esc if you want it back.",
                            runID: run.id)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
    }

    /// Borrow and computer-use runs start on their own, unless the app or target is on always ask.
    func startOrAsk(_ run: AgentRun, decision: BrainDecision, threadID: String, source: String) {
        summon.hideInput()
        let items = (run.preview?.apps ?? []) + [run.pickedPath ?? "", run.prompt]
        guard let asked = SafetyPolicy.mustAsk(items, settings: store.settings) else {
            approveRun(run.id)
            return
        }
        let actions = [
            CardAction(title: "review preview", kind: .secondary, glyph: "grid") { [weak self] in
                self?.openDashboard(.runs, runID: run.id)
            },
            CardAction(title: run.kind == .borrow ? "allow once" : "do it", kind: .primary, glyph: "bolt") { [weak self] in
                self?.approveRun(run.id)
            },
        ]
        let card = AnswerCardModel(title: decision.title, text: run.preview?.summary ?? decision.title, actions: actions,
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "action preview · \(asked) is on always ask"
        present(card, source: source)
        store.saveNow()
        speak("\(asked) is on your always ask list. Want me to go ahead?")
    }

    // MARK: - Computer use (end-to-end driving)

    private func prepareComputerUse(decision: BrainDecision, request: BrainRequest,
                                    threadID: String, source: String) async {
        guard hasKey("anthropic") else {
            presentNeedsKey(prompt: request.text, threadID: threadID, source: source)
            return
        }
        if !store.settings.screenBorrowing { store.settings.screenBorrowing = true }
        if !EventActuator.canPost { _ = await PermissionsService.shared.request(.accessibility) }
        if !CGPreflightScreenCaptureAccess() { _ = await PermissionsService.shared.request(.screen) }
        guard !Task.isCancelled else { return }
        let goal = request.text.isEmpty ? decision.title : request.text
        let apps = decision.apps
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? "drive it end to end" : decision.previewSummary,
                                     risk: .medium,
                                     steps: [PreviewStep("open \(apps.first ?? "the app")"),
                                             PreviewStep("do it with a script, or click if it has to"),
                                             PreviewStep("hand control back")],
                                     commands: [],
                                     apps: apps.isEmpty ? ["your apps"] : apps,
                                     files: [])
        let run = store.createRun(kind: .computerUse, title: decision.title, prompt: goal,
                                  threadID: threadID, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "computer-use")
        let detail = decision.answer.isEmpty ? "i'll do it now." : decision.answer
        // The brain strips its own "esc stops me"; guard here too so history never carries it twice.
        let note = detail.lowercased().contains("esc stops me") ? detail : "\(detail) esc stops me."
        store.appendMessage(threadID: threadID, role: .assistant, text: note, runID: run.id)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
    }

    /// A web task, done in okidoki's own browser: the page is read directly instead of from pixels.
    private func prepareBrowser(decision: BrainDecision, request: BrainRequest,
                                threadID: String, source: String) async {
        guard hasKey("anthropic") else {
            presentNeedsKey(prompt: request.text, threadID: threadID, source: source)
            return
        }
        let goal = request.text.isEmpty ? decision.title : request.text
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? "do it in okidoki's browser" : decision.previewSummary,
                                    risk: decision.risk == .high ? .high : .medium,
                                    steps: decision.previewSteps.isEmpty
                                        ? [PreviewStep("open the site"), PreviewStep("read the page and work through it"), PreviewStep("report back")]
                                        : decision.previewSteps.map { PreviewStep($0) },
                                    commands: [],
                                    apps: ["okidoki browser"],
                                    files: [])
        let run = store.createRun(kind: .browser, title: decision.title, prompt: goal,
                                  threadID: threadID, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "browser")
        let detail = decision.answer.isEmpty ? "i'll do it in the browser." : decision.answer
        store.appendMessage(threadID: threadID, role: .assistant, text: detail, runID: run.id)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
    }

    // MARK: - Overlay (simulations drawn on screen)

    private func handleOverlay(decision: BrainDecision, request: BrainRequest,
                               threadID: String, source: String) async {
        let title = decision.overlayTitle ?? decision.title
        let run = store.createRun(kind: .answer, title: title, prompt: request.text,
                                  threadID: threadID, status: .done)
        let width = decision.overlayWidth ?? 560
        let height = decision.overlayHeight ?? 380
        var output = ""
        if let html = decision.overlayHTML, !html.isEmpty {
            let anchor = request.selection.map { rect in
                CGPoint(x: rect.midX, y: rect.midY)
            } ?? (request.screenshotPNG != nil ? NSEvent.mouseLocation : nil)
            simOverlay.show(html: html, title: title, width: width, height: height, near: anchor)
            output = "[overlay shown · \(width)×\(height)]"
        } else {
            output = "[overlay content missing]"
        }
        store.updateRun(run.id) { run in
            run.summary = output
            run.output = output
        }
        store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
        let card = AnswerCardModel(title: title,
                                   text: decision.answer,
                                   actions: [CardAction(title: "close overlay", kind: .secondary) { [weak self] in
                                       self?.simOverlay.dismiss()
                                   }],
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "drawn on your screen · esc closes it"
        present(card, source: source)
        speak(decision.speak.isEmpty ? decision.answer : decision.speak)
    }

    // MARK: - Run control

    func approveRun(_ id: String) {
        guard let run = store.run(id), run.status == .waiting || run.status == .previewing else { return }
        guard store.settings.okidokiEnabled else {
            toast(title: "okidoki is off", detail: "turn it on in Settings to run this", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "settings", onEdit: { [weak self] in self?.openDashboard(.settings) }, runID: id)
            return
        }
        if let blocked = SafetyPolicy.blocked(commands: (run.preview?.commands ?? []) + (run.preview?.apps ?? []), settings: store.settings) {
            store.finishRun(id, status: .failed, summary: blocked)
            return
        }
        answerController.close(restoreApp: false)
        store.startRun(id)
        confirmOK()
        let risk = store.run(id)?.preview?.risk ?? .low
        if risk == .low, let updated = store.run(id) {
            let work = DispatchWorkItem { [weak self] in
                guard let self, let current = self.store.run(id), current.status == .running else { return }
                self.pendingStarts[id] = nil
                self.execute(current)
            }
            pendingStarts[id] = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
            toast(title: "Okidoki!", detail: "\(updated.title) starts in 5 seconds — undo to stop",
                  kind: .success, undoLabel: "stop", onUndo: { [weak self] in self?.stopRun(id) },
                  editLabel: "preview", onEdit: { [weak self] in self?.openDashboard(.runs, runID: id) },
                  runID: id)
        } else if let updated = store.run(id) {
            execute(updated)
            toast(title: "Okidoki!", detail: "on it — \(updated.title)",
                  kind: .success, undoLabel: "stop", onUndo: { [weak self] in self?.stopRun(id) },
                  editLabel: "preview", onEdit: { [weak self] in self?.openDashboard(.runs, runID: id) },
                  runID: id)
        }
        store.saveNow()
    }

    func allowAlways(_ id: String) {
        // Nothing here is matched again later: replays, browser and Act runs are approved one at a time.
        approveRun(id)
        toast(title: "allowed once", detail: "okidoki asks again next time", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: "settings", onEdit: { [weak self] in
                  self?.openDashboard(.settings)
              }, runID: id)
    }

    func denyRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        pausedStarts.remove(id)
        pendingReplays[id] = nil
        pendingReplayValues[id] = nil
        pendingConnectorCalls[id] = nil
        store.cancelRun(id)
        toast(title: "not now", detail: "nothing changed", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
    }

    func pauseRun(_ id: String, from source: String = "button") {
        guard let run = store.run(id) else { return }
        // A recording can't pause: the recorder either watches or it doesn't.
        if run.kind == .watch || run.kind == .connector { return }
        // A Mac replay pauses between steps: the ghost steps aside, and play carries on from the next step.
        if replayer.isActive, replayer.runID == id { replayer.pauseOrResume(); return }
        if browserReplayer.isActive, browserReplayer.runID == id { browserReplayer.pauseOrResume(); return }
        // Smart replay pauses for real: the page is the person's until they take it back, then it carries on.
        if hybridBrowserReplayer.isActive, hybridBrowserReplayer.runID == id {
            if hybridBrowserReplayer.personsTurn { hybridBrowserReplayer.takeBack() } else { hybridBrowserReplayer.pauseForPerson(from: source) }
            return
        }
        // A web task pauses for real too: the agent waits, then looks at the page again.
        if browserDriver.isRunning(id) {
            browserDriver.pauseOrTakeBack(runID: id)
            return
        }
        if run.status == .paused {
            if pausedStarts.remove(id) != nil {
                execute(run)
                return
            }
            store.updateRun(id) { $0.status = .running }
            return
        }
        if pendingStarts[id] != nil {
            pendingStarts[id]?.cancel()
            pendingStarts[id] = nil
            pausedStarts.insert(id)
            store.updateRun(id) { $0.status = .paused }
            return
        }
        // Computer use: the driver steps aside (no pointer, no keys) at its next look and waits for play.
        if driver.isActive, run.kind == .computerUse {
            store.updateRun(id) { $0.status = .paused; $0.waitingFor = nil }
            speak("Paused. The Mac is yours.")
            return
        }
        store.updateRun(id) { $0.status = .paused }
    }

    func stopRun(_ id: String) {
        // A question nobody answered isn't running: dismissing it must not stop whatever is running now.
        if store.run(id)?.status == .asked {
            store.cancelRun(id)
            store.saveNow()
            return
        }
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        pausedStarts.remove(id)
        pendingConnectorCalls[id] = nil
        // Stopping the recording run (from the notch, the Runs page, anywhere) ends the recording
        // and keeps what was captured; the recorder's finish handler closes the run itself.
        if watch.isRecording, watchRunID == id { stopWatching(); return }
        BrainClient.shared.stop(runID: id)
        if replayer.isActive, replayer.runID == id { replayer.cancel(reason: "you stopped me"); return }
        if browserReplayer.isActive, browserReplayer.runID == id { browserReplayer.cancel(reason: "you stopped me"); return }
        if hybridBrowserReplayer.isActive, hybridBrowserReplayer.runID == id { hybridBrowserReplayer.cancel(reason: "you stopped me"); return }
        if browserDriver.isRunning(id) { browserDriver.cancel(runID: id, reason: "you stopped me"); return }
        if ghost.model.visible, store.run(id)?.kind == .borrow { ghost.cancel() }
        if driver.isActive, store.run(id)?.kind == .computerUse { driver.cancel(reason: "you stopped me"); return }
        store.cancelRun(id)
        toast(title: "stopped", detail: "you're in charge", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
    }

    func redirectRun(_ id: String, instruction: String) {
        guard let run = store.run(id) else { return }
        stopRun(id)
        Task {
            await handleRequest(text: instruction, appName: "mac", bundleID: "", threadID: run.threadID,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "dashboard")
        }
    }

    private func execute(_ run: AgentRun) {
        guard let current = store.run(run.id), current.status == .running || current.status == .paused else { return }
        guard store.settings.okidokiEnabled else {
            store.finishRun(run.id, status: .cancelled, summary: "Okidoki is off in Settings.")
            store.saveNow()
            return
        }
        if let blocked = SafetyPolicy.blocked(commands: (run.preview?.commands ?? []) + (run.preview?.apps ?? []), settings: store.settings) {
            store.finishRun(run.id, status: .failed, summary: blocked)
            store.saveNow()
            return
        }
        store.updateRun(run.id) { run in
            run.status = .running
            run.startedAt = run.startedAt ?? Date()
        }
        switch run.kind {
        case .borrow:
            if run.builtin == "skill" {
                let times = pendingReplays.removeValue(forKey: run.id) ?? 1
                guard let id = run.pickedPath, let skill = store.skill(id) else {
                    failReplay(runID: run.id, reason: "that skill was deleted before the replay started")
                    return
                }
                let values = pendingReplayValues.removeValue(forKey: run.id) ?? []
                // A skill smart replay made (inputs, conditions, loops, think steps) only makes sense to
                // the smart replayer, whatever the switch says; the switch decides for plain recordings.
                let smart = store.settings.hybridReplay || skill.usesSmartReplay
                if skill.runsInBrowser {
                    if smart {
                        hybridBrowserReplayer.begin(skill: skill, runID: run.id, passes: values, times: times,
                                                    request: pendingReplayRequests.removeValue(forKey: run.id) ?? "")
                    } else {
                        browserReplayer.begin(skill: skill, runID: run.id, times: times, values: values)
                    }
                } else if smart {
                    replayer.beginSmart(skill: skill, runID: run.id, passes: values, times: times,
                                        request: pendingReplayRequests.removeValue(forKey: run.id) ?? "")
                } else {
                    replayer.begin(skill: skill, runID: run.id, times: times, values: values)
                }
                return
            }
            let target = run.pickedPath ?? run.prompt
            ghost.begin(target: target, runID: run.id)
        case .computerUse, .browser:
            beginDriving(run)
        case .connector:
            Task { await executeConnector(run) }
        case .watch:
            break
        default:
            store.finishRun(run.id, status: .done, summary: "done")
        }
    }

    /// Computer-use runs go to the private Mac when the setting says so. A VM that is set up but
    /// off is booted first; one that isn't set up fails the run rather than quietly driving this Mac.
    private func beginDriving(_ run: AgentRun) {
        if run.kind == .browser {
            browserDriver.begin(run: run)
            return
        }
        guard store.settings.computerTarget == "vm" else {
            driver.begin(run: run)
            return
        }
        switch privateMac.phase {
        case .running, .stopped, .starting:
            let booting = privateMac.phase != .running
            if booting {
                toast(title: "starting your private Mac", detail: "the run begins once it's up",
                      kind: .info, undoLabel: nil, onUndo: nil, editLabel: "show", onEdit: { [weak self] in
                          self?.privateMac.show()
                      }, runID: run.id)
            }
            Task { [weak self] in
                guard let self else { return }
                let ok = await privateMac.start()
                guard store.run(run.id)?.status == .running else { return }
                guard ok else {
                    failDriving(run, reason: privateMac.error ?? "the private Mac didn't start")
                    return
                }
                let wait = privateMac.secondsUntilUsable
                if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                guard store.run(run.id)?.status == .running else { return }
                driver.begin(run: run, target: PrivateMacComputer(service: privateMac))
            }
        case .downloading, .installing:
            failDriving(run, reason: "your private Mac is still being set up — \(privateMac.detail.lowercased())")
        case .stopping:
            failDriving(run, reason: "your private Mac is shutting down — try again in a moment")
        case .unsupported:
            failDriving(run, reason: "a private Mac needs Apple silicon — switch to this Mac in Settings")
        case .notSetUp, .failed:
            failDriving(run, reason: privateMac.error ?? "your private Mac isn't set up yet — finish it in Settings, or switch to this Mac")
        }
    }

    private func failDriving(_ run: AgentRun, reason: String) {
        store.finishRun(run.id, status: .failed, summary: reason)
        if let threadID = run.threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: "i couldn't start — \(reason)", runID: run.id)
        }
        toast(title: "couldn't start", detail: reason, kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: "settings", onEdit: { [weak self] in
                  self?.openDashboard(.settings)
              }, runID: run.id)
        store.saveNow()
    }

    /// "Import my memory from …": shows what will be read, then reads it on the okay. Nothing is
    /// written to the other assistant's files; an export is picked when there are none on this Mac.
    private func offerMemoryImport(_ plan: MemoryImport.Plan, prompt: String, threadID: String?, source: String) async {
        let thread = threadID.flatMap { store.thread($0) } ?? store.threadForContext(app: "mac", topic: "memory", text: prompt)
        store.appendMessage(threadID: thread.id, role: .user, text: prompt)
        let preview = ActionPreview(summary: plan.title, risk: .low, steps: plan.steps.map { PreviewStep($0) },
                                    commands: [], apps: [], files: plan.files)
        let run = store.createRun(kind: .quickAction, title: plan.title, prompt: prompt, threadID: thread.id,
                                  preview: preview, steps: plan.steps.map { RunStep(title: $0) },
                                  status: .waiting, builtin: MemoryImport.builtin)
        let card = AnswerCardModel(title: plan.title, text: plan.summary, actions: [
            CardAction(title: plan.needsExport ? "choose file" : "import", kind: .primary,
                       glyph: plan.needsExport ? "folder" : "bolt") { [weak self] in
                guard let self else { return }
                self.answerController.close(restoreApp: false)
                Task { await self.runMemoryImport(run.id, plan: plan) }
            },
        ], threadTitle: thread.title, runID: run.id, threadID: thread.id)
        present(card, source: source)
        store.saveNow()
    }

    private func runMemoryImport(_ runID: String, plan: MemoryImport.Plan) async {
        guard let run = store.run(runID) else { return }
        var text = ""
        if plan.needsExport {
            guard let url = await pickFile(kind: "document", prompt: "choose the memory export") else {
                store.finishRun(runID, status: .cancelled, summary: "no file chosen")
                return
            }
            text = DocumentReader.read(url: url) ?? (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        } else {
            text = MemoryImport.read(files: plan.files)
        }
        store.startRun(runID)
        finishMemoryImport(run, output: text)
        store.saveNow()
    }

    /// The memory files that were read become memories. Only additions: nothing already remembered is
    /// touched, and the other assistant's files aren't either. Everything lands on the Memory page to edit or forget.
    /// Onboarding's "bring your memory": reads one assistant's files on this Mac straight away, no card.
    /// The number of memories added, or nil when that assistant has nothing here.
    @discardableResult
    func importMemory(sourceID: String) -> Int? {
        guard let source = MemoryImport.source(id: sourceID), source.isLocal else { return nil }
        let files = MemoryImport.files(for: source)
        guard !files.isEmpty else { return nil }
        let prompt = "import my memory from \(source.name)"
        let thread = store.threadForContext(app: "mac", topic: "memory", text: prompt)
        let run = store.createRun(kind: .quickAction, title: "import memory from \(source.name)", prompt: prompt, threadID: thread.id,
                                  steps: [RunStep(title: "read what \(source.name) remembers")],
                                  status: .waiting, builtin: MemoryImport.builtin)
        store.startRun(run.id)
        let added = finishMemoryImport(run, output: MemoryImport.read(files: files), speakResult: false)
        store.saveNow()
        return added
    }

    @discardableResult
    private func finishMemoryImport(_ run: AgentRun, output: String, speakResult: Bool = true) -> Int {
        let found = MemoryImport.parse(output)
        let asked = MemoryImport.source(in: run.prompt)
        var added = 0
        for item in found {
            let name = (MemoryImport.source(forFile: item.file) ?? asked)?.name ?? "another assistant"
            if store.addMemory(item.text, section: item.section, source: "from \(name)") != nil { added += 1 }
        }
        let skipped = found.count - added
        let summary: String
        if found.isEmpty {
            summary = "I read it but found nothing to remember. Exports work best as a plain list, one memory per line."
        } else if added == 0 {
            summary = "All \(found.count) of those were already in Memory, so nothing was added."
        } else {
            summary = "Added \(added) \(added == 1 ? "memory" : "memories")"
                + (skipped > 0 ? " and skipped \(skipped) already remembered." : ".")
                + " They're on the Memory page to edit or forget."
        }
        store.finishRun(run.id, status: .done, summary: summary)
        toast(title: added > 0 ? "\(added) remembered" : "nothing new", detail: summary, kind: added > 0 ? .success : .info,
              undoLabel: nil, onUndo: nil, editLabel: "memory", onEdit: { [weak self] in self?.openDashboard(.memory) },
              runID: run.id)
        if speakResult { speak(added > 0 ? "Done. I remembered \(added) things." : summary) }
        return added
    }

    private func fail(_ id: String, _ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        store.finishRun(id, status: .failed, summary: message)
        toast(title: "that didn't work", detail: message, kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: "open run", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: id)
              }, runID: id)
    }

    func finishBorrow(runID: String) {
        store.finishRun(runID, status: .done, summary: "clicked once and gave control back")
        toast(title: "done", detail: "control is yours again", kind: .success,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
        speak("Done. Control is yours.")
    }

    func cancelRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        pausedStarts.remove(id)
        pendingReplays[id] = nil
        pendingReplayValues[id] = nil
        pendingConnectorCalls[id] = nil
        // A connector running in the brain, or a run driving the screen, has to be told too; otherwise
        // it runs on to the end with the store already saying "cancelled".
        BrainClient.shared.stop(runID: id)
        if replayer.isActive, replayer.runID == id { replayer.cancel(reason: "cancelled") }
        if browserReplayer.isActive, browserReplayer.runID == id { browserReplayer.cancel(reason: "cancelled") }
        if hybridBrowserReplayer.isActive, hybridBrowserReplayer.runID == id { hybridBrowserReplayer.cancel(reason: "cancelled") }
        if browserDriver.isRunning(id) { browserDriver.cancel(runID: id, reason: "cancelled") }
        if driver.isActive, store.run(id)?.kind == .computerUse { driver.cancel(reason: "cancelled") }
        store.cancelRun(id)
    }

    // MARK: - Watch + skills

    private func startWatching(prompt: String, threadID: String, decision: BrainDecision) {
        beginWatching(prompt: prompt, threadID: threadID, name: "", speakLine: decision.speak)
    }

    /// Record from the dashboard's Replay page: "watch me" without a request in a thread.
    func startRecording(name: String) {
        guard !watch.isRecording else { return }
        if replayer.isActive { replayer.cancel(reason: "recording instead") }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        beginWatching(prompt: trimmed.isEmpty ? "record a skill" : "record: \(trimmed)", threadID: "", name: trimmed, speakLine: "")
    }

    private func beginWatching(prompt: String, threadID: String, name: String, speakLine: String) {
        guard !watch.isRecording else { return }
        // Clicks come through without it, but keystrokes and button labels need accessibility trust.
        if PermissionsService.shared.state(.accessibility) != .granted {
            Task { _ = await PermissionsService.shared.request(.accessibility) }
            toast(title: "allow accessibility to capture typing", detail: "clicks still record; keystrokes and button names need it",
                  kind: .warning, undoLabel: nil, onUndo: nil, editLabel: "open settings", onEdit: {
                      PermissionsService.shared.openSettings(.accessibility)
                  }, runID: nil)
        }
        let run = store.createRun(kind: .watch, title: name.isEmpty ? "watch me" : "record · \(name)", prompt: prompt,
                                  threadID: threadID.isEmpty ? nil : threadID, status: .running)
        store.startRun(run.id)
        watchRunID = run.id
        watch.start(name: name)
        // The island shows the recording (dot, clock, Save / Discard) when it can; the HUD pill
        // only steps in when the notch is off or quiet. Both at once would overlap top-centre.
        if notch.showsRecording {
            notch.refresh()
        } else {
            watchHUD.show()
            toast(title: "recording", detail: "do it once. click stop when you're done.",
                  kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: run.id)
        }
        speak(speakLine.isEmpty ? "Recording. Do it once, then stop." : speakLine)
    }

    func stopWatching() {
        guard watch.isRecording else { return }
        watch.stop()
        watchHUD.hide()
    }

    /// Throws the recording away instead of saving a skill.
    func discardWatching() {
        guard watch.isRecording else { return }
        watch.cancel()
        watchHUD.hide()
        if let watchRunID { store.finishRun(watchRunID, status: .cancelled, summary: "recording discarded") }
        watchRunID = nil
        toast(title: "discarded", detail: "nothing was saved", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        store.saveNow()
    }

    private func handleWatchFinished(_ steps: [WatchedStep]) {
        watchHUD.hide()
        let meaningful = steps.filter { $0.action != "start" && !$0.detail.isEmpty }
        watch.dropFrames(except: meaningful)
        guard !meaningful.isEmpty else {
            if let watchRunID { store.finishRun(watchRunID, status: .failed, summary: "nothing to learn") }
            watchRunID = nil
            toast(title: "i didn't catch that", detail: "try again — click through it once, slowly.", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let apps = meaningful.map(\.app).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        let chosen = watch.pendingName.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = chosen.isEmpty ? "\((apps.first ?? "mac").lowercased()) flow" : chosen
        let kinds = Dictionary(grouping: meaningful, by: \.action).mapValues(\.count)
        var bits: [String] = []
        if let n = kinds["click"].map({ $0 + (kinds["double-click"] ?? 0) + (kinds["right-click"] ?? 0) }), n > 0 { bits.append("\(n) \(n == 1 ? "click" : "clicks")") }
        if let n = kinds["type"], n > 0 { bits.append("\(n) typed") }
        if let n = kinds["key"], n > 0 { bits.append("\(n) \(n == 1 ? "shortcut" : "shortcuts")") }
        if let n = kinds["drag"], n > 0 { bits.append("\(n) \(n == 1 ? "drag" : "drags")") }
        if let n = kinds["scroll"], n > 0 { bits.append("\(n) \(n == 1 ? "scroll" : "scrolls")") }
        let summary = "\(bits.isEmpty ? "\(meaningful.count) steps" : bits.joined(separator: ", ")) in \(apps.joined(separator: ", "))"
        let skill = store.createSkill(name: name, summary: summary, steps: meaningful.map(\.step), source: "watch me")
        // Smart replay: what was typed that would differ next time becomes an input, in the background.
        if store.settings.hybridReplay {
            let learned = LearnedBrowserRun(title: name, goal: name, summary: summary, steps: skill.steps, pages: [:])
            Task { @MainActor [weak self] in await self?.generalize(skillID: skill.id, from: learned) }
        }
        let finishedRunID = watchRunID
        if let watchRunID {
            store.finishRun(watchRunID, status: .done, summary: "saved as a skill: \(skill.name)")
            store.updateRun(watchRunID) { $0.prompt = skill.steps.map(\.text).joined(separator: " → ") }
        }
        watchRunID = nil
        var text = "here's what i learned:\n\n"
        for (index, step) in meaningful.prefix(12).enumerated() {
            text += "\(index + 1). \(step.detail)\n"
        }
        if meaningful.count > 12 { text += "…and \(meaningful.count - 12) more\n" }
        text += "\nsaved as “\(skill.name)”. replay it as many times as you like."
        let card = AnswerCardModel(title: "got it.",
                                   text: text,
                                   actions: [
                                       CardAction(title: "replay once", kind: .primary, glyph: "play") { [weak self] in
                                           self?.replaySkill(skill, times: 1)
                                       },
                                       CardAction(title: "open replay", kind: .secondary, glyph: "wand") { [weak self] in
                                           self?.openDashboard(.skills)
                                       }
                                   ],
                                   threadTitle: nil, runID: finishedRunID, threadID: nil)
        present(card, source: "summon")
        toast(title: "saved as a skill", detail: "\(meaningful.count) steps · \(skill.name)", kind: .success,
              undoLabel: nil, onUndo: nil, editLabel: "open", onEdit: { [weak self] in
                  self?.openDashboard(.skills)
              }, runID: nil)
        speak("Got it. Saved as a skill.")
        store.saveNow()
    }

    /// Queues a replay behind the usual approval (dashboard buttons, the "got it" card).
    func replaySkill(_ skill: Skill, times: Int = 1) {
        let run = makeReplayRun(skill, times: times, threadID: nil)
        toast(title: "ready to replay", detail: "approve the preview to run it", kind: .approval,
              undoLabel: nil, onUndo: nil, editLabel: "review", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: run.id)
              }, runID: run.id)
    }

    /// `values`: one set of `{{placeholder}}` values per pass, each usually a record with a `ref`.
    func makeReplayRun(_ skill: Skill, times: Int, threadID: String?, values: [[String: String]] = []) -> AgentRun {
        let passes = values.isEmpty ? max(1, min(times, 10_000)) : values.count
        let refs = values.compactMap { $0["ref"] }
        // The steps read with the first record's values, so the preview says what will be typed.
        let steps = skill.steps.map { step -> SkillStep in
            var shown = step
            shown.text = ParameterFill.fill(step.text, values: values.first ?? [:]).text
            return shown
        }
        let apps = steps.map(\.app).reduce(into: [String]()) { if !$1.isEmpty, !$0.contains($1) { $0.append($1) } }
        let count = !refs.isEmpty ? "for \(refs.joined(separator: ", "))" : passes == 1 ? "once" : "\(passes) times"
        let preview = ActionPreview(summary: "replay “\(skill.name)” \(count) — \(steps.count) steps under a ghost cursor. press esc to stop.",
                                    risk: passes > 1 && refs.isEmpty ? .high : .medium,
                                    steps: steps.map { PreviewStep($0.text) },
                                    commands: [], apps: apps.isEmpty ? ["app"] : apps, files: [])
        let suffix = !refs.isEmpty ? " · \(refs.joined(separator: ", "))" : passes > 1 ? " ×\(passes)" : ""
        let run = store.createRun(kind: .borrow, title: "replay · \(skill.name)\(suffix)", prompt: skill.name,
                                  threadID: threadID, preview: preview, steps: steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "skill", pickedPath: skill.id)
        pendingReplays[run.id] = passes
        if !values.isEmpty { pendingReplayValues[run.id] = values }
        lastReplayedSkillID = skill.id
        return run
    }

    // MARK: - Chat commands (skills and recordings, no brain)

    /// What the chat can act on by itself: this Mac's skills and the records they replay against.
    private func chatContext() -> ChatCommands.Context {
        ChatCommands.Context(skills: store.activeSkills,
                             recording: watch.isRecording,
                             replaying: replayer.isActive || browserReplayer.isActive || hybridBrowserReplayer.isActive,
                             hasReplayed: lastReplayedSkillID.flatMap { store.skill($0) } != nil,
                             records: SkillRecords.load())
    }

    private func handleChatCommand(_ command: ChatCommand, text: String, appName: String, threadID: String?, source: String) {
        let thread = threadID.flatMap { store.thread($0) } ?? store.threadForContext(app: appName, topic: "skills", text: text)
        store.appendMessage(threadID: thread.id, role: .user, text: text)
        func reply(_ title: String, _ body: String, actions: [CardAction] = [], say: String? = nil, runID: String? = nil) {
            let run = store.createRun(kind: .answer, title: title, prompt: text, threadID: thread.id, status: .done)
            store.appendMessage(threadID: thread.id, role: .assistant, text: body, runID: runID ?? run.id)
            let card = AnswerCardModel(title: title, text: body, actions: Array(actions.prefix(3)),
                                       threadTitle: store.thread(thread.id)?.title, runID: runID ?? run.id, threadID: thread.id)
            present(card, source: source)
            if let say, !say.isEmpty { speak(say) }
        }
        func skillLine(_ skill: Skill) -> String {
            "· \(skill.name) — \(skill.summary)\(skill.runCount > 0 ? " · run \(skill.runCount)×" : "")"
        }
        let skills = store.activeSkills

        switch command {
        case .replay(let id, let times):
            guard let skill = store.skill(id) else { return reply("hm", "that skill isn't here anymore.") }
            startReplayFromChat(skill, times: times, threadID: thread.id, source: source)

        case .replayLast(let times):
            guard let id = lastReplayedSkillID, let skill = store.skill(id) else {
                return reply("which one?", skills.isEmpty ? "nothing's been recorded yet. say “watch me” and do it once."
                             : "tell me which skill:\n\n" + skills.prefix(8).map { "· \($0.name)" }.joined(separator: "\n"))
            }
            startReplayFromChat(skill, times: times, threadID: thread.id, source: source)

        case .ambiguousSkill(let query, let ids):
            let options = ids.compactMap { store.skill($0) }
            let actions = options.prefix(3).map { skill in
                CardAction(title: skill.name, kind: .secondary, glyph: "play") { [weak self] in
                    guard let self else { return }
                    self.answerController.close(restoreApp: false)
                    self.startReplayFromChat(skill, times: 1, threadID: thread.id, source: source)
                }
            }
            reply("which “\(query)”?", "a few skills match:\n\n" + options.map(skillLine).joined(separator: "\n"),
                  actions: actions, say: "Which one?")

        case .noSuchSkill(let query):
            let actions = [
                CardAction(title: "record it now", kind: .primary, glyph: "record") { [weak self] in
                    self?.answerController.close(restoreApp: false)
                    self?.startRecording(name: query)
                },
                CardAction(title: "open replay", kind: .secondary, glyph: "wand") { [weak self] in self?.openDashboard(.skills) },
            ]
            let body = skills.isEmpty
                ? "i don't have a skill called “\(query)” — nothing's recorded yet. i can watch you do it once."
                : "no skill called “\(query)”. here's what i know:\n\n" + skills.prefix(8).map { "· \($0.name)" }.joined(separator: "\n")
            reply("not yet", body, actions: actions, say: "I don't know that one yet.")

        case .listSkills:
            var actions: [CardAction] = []
            if let first = skills.first {
                actions.append(CardAction(title: "replay \(first.name)", kind: .primary, glyph: "play") { [weak self] in
                    self?.answerController.close(restoreApp: false)
                    self?.startReplayFromChat(first, times: 1, threadID: thread.id, source: source)
                })
            }
            actions.append(CardAction(title: "open replay", kind: .secondary, glyph: "wand") { [weak self] in self?.openDashboard(.skills) })
            let body = skills.isEmpty
                ? "nothing yet. say “watch me” and do something once — i'll turn it into a skill you can replay."
                : skills.prefix(12).map(skillLine).joined(separator: "\n") + (skills.count > 12 ? "\n…and \(skills.count - 12) more" : "")
                  + "\n\nsay “replay <name>” to run one, or “replay <name> 3 times”."
            reply(skills.isEmpty ? "no skills yet" : "\(skills.count) \(skills.count == 1 ? "skill" : "skills")", body, actions: actions)

        case .startRecording(let name):
            guard !watch.isRecording else { return }
            summon.hideInput()
            answerController.close(restoreApp: false)
            startRecording(name: name)

        case .saveRecording(let name):
            if !name.isEmpty { watch.pendingName = name }
            summon.hideInput()
            answerController.close(restoreApp: false)
            stopWatching()

        case .discardRecording:
            summon.hideInput()
            discardWatching()

        case .restartRecording:
            let name = watch.pendingName
            summon.hideInput()
            answerController.close(restoreApp: false)
            discardWatching()
            startRecording(name: name)

        case .stopReplay:
            summon.hideInput()
            if replayer.isActive { replayer.cancel(reason: "you said stop") }
            if browserReplayer.isActive { browserReplayer.cancel(reason: "you said stop") }
            if hybridBrowserReplayer.isActive { hybridBrowserReplayer.cancel(reason: "you said stop") }

        case .deleteSkill(let id):
            guard let skill = store.skill(id) else { return }
            store.deleteSkill(id)
            store.saveNow()
            summon.hideInput()
            toast(title: "deleted “\(skill.name)”", detail: "undo to bring it back", kind: .info,
                  undoLabel: "undo", onUndo: { [weak self] in
                      guard let self else { return }
                      self.store.restoreSkill(skill)
                      self.store.saveNow()
                  }, editLabel: nil, onEdit: nil, runID: nil)
            store.appendMessage(threadID: thread.id, role: .assistant, text: "deleted “\(skill.name)”.")

        case .renameSkill(let id, let name):
            guard let skill = store.skill(id) else { return }
            store.updateSkill(id, name: name)
            store.saveNow()
            summon.hideInput()
            toast(title: "renamed", detail: "“\(skill.name)” is now “\(name)”", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            store.appendMessage(threadID: thread.id, role: .assistant, text: "renamed “\(skill.name)” to “\(name)”.")

        case .whatsWaiting:
            let mine = store.waitingRuns
            var lines: [String] = []
            if !mine.isEmpty { lines.append(mine.prefix(5).map { "· \($0.title)" }.joined(separator: "\n")) }
            var actions: [CardAction] = []
            if let first = mine.first {
                actions.append(CardAction(title: "do it · \(first.title.prefix(18))", kind: .primary, glyph: "bolt") { [weak self] in
                    self?.answerController.close(restoreApp: false); self?.approveRun(first.id)
                })
                actions.append(CardAction(title: "open runs", kind: .secondary, glyph: "runs") { [weak self] in self?.openDashboard(.runs) })
            }
            let count = mine.count
            reply(count == 0 ? "nothing's waiting" : "\(count) \(count == 1 ? "thing needs" : "things need") you",
                  lines.isEmpty ? "all clear. nothing needs an okay right now." : lines.joined(separator: "\n\n"),
                  actions: actions, say: count == 0 ? "Nothing's waiting on you." : "\(count) \(count == 1 ? "thing needs" : "things need") you.")

        // MARK: Records and the vault

        case .replayRecords(let id, let recordIDs, let values, let times):
            guard let skill = store.skill(id) else { return reply("hm", "that skill isn't here anymore.") }
            let records = SkillRecords.load()
            let picked = recordIDs.compactMap { rid in records.first { $0.id == rid } }
            let passes = picked.isEmpty ? Array(repeating: values, count: max(1, times)) : picked.map { $0.fillValues.merging(values) { _, typed in typed } }
            startReplayFromChat(skill, times: 1, threadID: thread.id, source: source, values: passes)

        case .addToVault(let query, let url, let folder):
            addToVault(query: query, url: url, folder: folder, request: text, threadID: thread.id, source: source)

        case .unknownRecord(let query):
            let records = SkillRecords.load()
            reply("no \(query)", "there's no record \(query). these are the ones i have:\n\n"
                  + records.prefix(8).map { "· \($0.id) — \($0.title)" }.joined(separator: "\n"),
                  say: "I don't have \(query).")
        }
    }

    /// A replay asked for in the chat starts straight away, like any other job asked for there:
    /// the same approval rules apply (always-ask apps still ask), nothing extra.
    /// Returns false when nothing started (a recording is in progress, or another tool asked while a replay runs).
    @discardableResult
    func startReplayFromChat(_ skill: Skill, times: Int, threadID: String, source: String, values: [[String: String]] = [],
                             request: String = "") -> Bool {
        if watch.isRecording {
            toast(title: "still recording", detail: "save or discard the recording first", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return false
        }
        // Another agent must never cut off the user's own replay; the user asking for a new one may.
        if source == "control", replayer.isActive || browserReplayer.isActive || hybridBrowserReplayer.isActive { return false }
        if replayer.isActive { replayer.cancel(reason: "replaying \(skill.name) instead") }
        if browserReplayer.isActive { browserReplayer.cancel(reason: "replaying \(skill.name) instead") }
        if hybridBrowserReplayer.isActive { hybridBrowserReplayer.cancel(reason: "replaying \(skill.name) instead") }
        let passes = max(1, min(times, 10_000))
        let run = makeReplayRun(skill, times: passes, threadID: threadID, values: values)
        if Self.isUnattended(source) { unattendedRuns.insert(run.id) }
        if !request.isEmpty { pendingReplayRequests[run.id] = request }
        let refs = values.compactMap { $0["ref"] }
        let count = !refs.isEmpty ? "for \(refs.joined(separator: ", "))" : passes == 1 ? "once" : "\(passes) times"
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "replaying “\(skill.name)” \(count) — \(skill.steps.count) steps. esc stops me.", runID: run.id)
        let decision = BrainDecision(kind: .borrow, title: "replay · \(skill.name)", answer: "", risk: run.preview?.risk ?? .medium)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
        return true
    }

    func finishReplay(runID: String, passes: Int) {
        if let run = store.run(runID), let id = run.pickedPath {
            store.incrementSkillRun(id, by: passes)
        }
        // Records name what was done ("INV-4471 done") and say more than a count.
        // The step log ("→ rescued by the model…") isn't a receipt.
        let receipts = (store.run(runID)?.output ?? "").split(separator: "\n").map(String.init)
            .filter { !$0.isEmpty && !$0.hasPrefix("→") && !$0.hasPrefix("✗") }
        let line = !receipts.isEmpty ? receipts.joined(separator: "; ") : passes > 1 ? "replayed \(passes) times" : "replayed once"
        // Several records: one reply that lists them all.
        if receipts.count > 1, let threadID = store.run(runID)?.threadID {
            store.appendMessage(threadID: threadID, role: .assistant,
                                text: "done · \(receipts.count) records:\n" + receipts.joined(separator: "\n"), runID: runID)
        }
        store.finishRun(runID, status: .done, summary: line)
        toast(title: "done", detail: "\(line) — control is yours", kind: .success,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
        speak("Done. Control is yours.")
        store.saveNow()
    }

    /// `retry`: the passes that failed (as they were given), offered as one tap that replays just those.
    func failReplay(runID: String, reason: String, retry: (skillID: String, passes: [[String: String]])? = nil) {
        pendingReplays[runID] = nil
        pendingReplayValues[runID] = nil
        store.finishRun(runID, status: .failed, summary: reason)
        var again: (() -> Void)?
        if let retry, let skill = store.skill(retry.skillID) {
            let threadID = store.run(runID)?.threadID
            again = { [weak self] in
                guard let self else { return }
                let run = self.makeReplayRun(skill, times: 1, threadID: threadID, values: retry.passes)
                self.approveRun(run.id)
            }
            lastFailedReplay = again
        }
        let label = retry.map { $0.passes.count == 1 ? "retry that one" : "retry those \($0.passes.count)" }
        toast(title: "couldn't finish the replay", detail: reason, kind: .warning,
              undoLabel: again == nil ? nil : label, onUndo: again, editLabel: "details", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: runID)
              }, runID: runID)
        store.saveNow()
    }

    // MARK: - Routines

    func runRoutine(_ routine: Routine) {
        toast(title: "routine · \(routine.name)", detail: routine.prompt, kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        Task {
            await handleRequest(text: routine.prompt, appName: "mac", bundleID: "", threadID: nil,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "routine")
        }
    }

    // MARK: - Apple apps

    func connectApple(_ id: String) async -> Bool {
        do {
            _ = try await AppleBridge.shared.probe(id)
            PermissionsService.shared.markAutomationGranted(true)
            store.settings.automationGranted = true
            switch id {
            case "calendar": store.settings.appleCalendar = true
            default: break
            }
            store.setConnector(id, enabled: true, installed: true)
            store.saveNow()
            toast(title: "\(id) connected", detail: "ask me something that uses it", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return true
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            toast(title: "couldn't connect \(id)", detail: message, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "open settings", onEdit: {
                      if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                          NSWorkspace.shared.open(url)
                      }
                  }, runID: nil)
            return false
        }
    }

    func disconnectApple(_ id: String) {
        switch id {
        case "calendar": store.settings.appleCalendar = false
        default: break
        }
        store.setConnector(id, enabled: false)
        store.saveNow()
    }

    private func checkCalendarNudge() async {
        guard store.settings.proactiveNudges, store.settings.appleCalendar, !inCall else { return }
        do {
            let events = try await AppleBridge.shared.upcomingEvents(withinMinutes: 12)
            for event in events {
                guard !nudgedEvents.contains(event.id) else { continue }
                let minutes = max(1, Int(event.start.timeIntervalSinceNow / 60))
                guard minutes <= 10 else { continue }
                nudgedEvents.insert(event.id)
                toast(title: "you have a meeting in \(minutes) minutes",
                      detail: event.title,
                      kind: .info,
                      undoLabel: nil, onUndo: nil, editLabel: "calendar", onEdit: { [weak self] in
                          self?.openDashboard(.home)
                      }, runID: nil)
                break
            }
        } catch {}
    }

    private func detectCall() {
        let meetingBundles = [
            "us.zoom.xos", "com.apple.FaceTime", "com.microsoft.teams2",
            "com.webex.meetingmanager", "com.cisco.webexmeetingsapp", "com.hnc.Discord",
        ]
        let active = NSWorkspace.shared.runningApplications.contains { app in
            guard let id = app.bundleIdentifier, meetingBundles.contains(id) else { return false }
            return app.isActive && !app.isHidden
        }
        if active != inCall {
            inCall = active
            notch.model.quiet = store.settings.quietMode || active
            notch.refresh()
        }
    }

    /// A voice to start with. Without a Cartesia key, the Mac's own voice is the one that speaks.
    private func applyBuiltinServices() {
        var settings = store.settings
        if settings.voiceID.isEmpty { settings.voiceID = "sarah" }
        store.settings = settings
        store.saveNow()
    }

    // MARK: - Keys, tools, sync

    func hasKey(_ provider: String) -> Bool { KeyStore.has(provider) }

    /// Nothing answers or drives the screen until an Anthropic key is saved.
    private func presentNeedsKey(prompt: String, threadID: String?, source: String) {
        let thread = threadID.flatMap { store.thread($0) } ?? store.threadForContext(app: "mac", topic: "key")
        let asked = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !asked.isEmpty {
            store.appendMessage(threadID: thread.id, role: .user, text: asked)
        }
        let decision = BrainService.needsKeyDecision()
        let run = store.createRun(kind: .answer, title: decision.title, prompt: asked, threadID: thread.id, status: .done)
        store.appendMessage(threadID: thread.id, role: .assistant, text: decision.answer, runID: run.id)
        let request = BrainRequest(text: asked, threadID: thread.id, source: source)
        let card = makeAnswerCard(decision: decision, request: request, threadID: thread.id, run: run)
        // The card is a dead end without a way to the Keys section.
        card.actions.insert(CardAction(title: "add a key", kind: .primary, glyph: "key") { [weak self] in
            self?.answerController.close(restoreApp: false)
            self?.openDashboard(.keys)
        }, at: 0)
        present(card, source: source)
        summon.hideInput()
        speak("The model isn't available right now.")
    }

    func saveKey(provider: String, value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            KeyStore.delete(provider)
            toast(title: "key removed", detail: provider, kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        } else {
            KeyStore.set(trimmed, for: provider)
            toast(title: "key saved", detail: "\(provider) · stored on this mac", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            if provider == "cartesia" {
                // Check the key and the built-in voices now, not on the first spoken reply.
                cartesiaWarned = false
                Task { [weak self] in
                    let check = await VoiceSpeaker.checkCartesia(key: trimmed)
                    let missing = check.missingVoices.isEmpty ? "" : " Cartesia no longer has: \(check.missingVoices.joined(separator: ", "))."
                    self?.toast(title: check.ok ? "cartesia connected" : "cartesia key didn't work",
                                detail: check.detail + missing,
                                kind: check.ok && check.missingVoices.isEmpty ? .success : .warning,
                                undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                }
            }
            if provider == "anthropic", !onboardingOpen {
                // Bring-your-own-key: say now whether it works, not on the first request.
                Task { [weak self] in
                    let check = await AnthropicKeyCheck.run(key: trimmed)
                    self?.toast(title: check.ok ? "anthropic connected" : "anthropic key didn't work", detail: check.detail,
                                kind: check.ok ? .success : .warning,
                                undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                }
            }
            if provider == "moss" {
                // New credentials: build the memory index now rather than on the next change.
                lastMemoryHash = nil
                scheduleMemoryIndex(after: 1)
            }
            if provider == "apify", sidecar.status.isReady {
                // Catch a mistyped key now rather than on the first scrape.
                Task { [weak self] in
                    let check = await BrainClient.shared.checkApify(token: trimmed)
                    self?.toast(title: check.ok ? "apify connected" : "apify key didn't work",
                                detail: check.ok ? "signed in as \(check.detail)" : check.detail,
                                kind: check.ok ? .success : .warning,
                                undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                }
            }
        }
        keysVersion += 1
    }

    func deleteKey(provider: String) {
        KeyStore.delete(provider)
        keysVersion += 1
        toast(title: "key removed", detail: provider, kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    // MARK: - Connectors (Apify, MCP)

    func connectorsPayload() -> BrainConnectorsPayload {
        let enabled = { (id: String) in self.store.connectors.first(where: { $0.id == id })?.enabled == true }
        return BrainConnectorsPayload(apify: enabled("apify") && hasKey("apify"),
                                      mcpServers: enabled("mcp") ? mcpServerPayloads() : [])
    }

    func mcpServerPayloads() -> [BrainMCPServerPayload] {
        guard store.connectors.contains(where: { $0.id == "mcp" && $0.enabled }) else { return [] }
        return store.settings.mcpServers.filter(\.enabled).map { server in
            let secrets = mcpSecrets(server)
            return BrainMCPServerPayload(id: server.id, name: server.name, transport: server.transport.rawValue,
                                         command: server.command, args: server.args, url: server.url,
                                         env: secrets.env, headers: secrets.headers)
        }
    }

    func mcpSecrets(_ server: MCPServer) -> (env: [String: String], headers: [String: String]) {
        guard let raw = KeyStore.get(server.secretsKey), let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ([:], [:]) }
        return (json["env"] as? [String: String] ?? [:], json["headers"] as? [String: String] ?? [:])
    }

    /// Adds or updates a server. `secrets` nil keeps what's in the key file; empty dictionaries remove it.
    func saveMCPServer(_ server: MCPServer, secrets: (env: [String: String], headers: [String: String])?) {
        var servers = store.settings.mcpServers
        if let index = servers.firstIndex(where: { $0.id == server.id }) {
            servers[index] = server
        } else {
            servers.append(server)
        }
        store.settings.mcpServers = servers
        if let secrets {
            if secrets.env.isEmpty && secrets.headers.isEmpty {
                KeyStore.delete(server.secretsKey)
            } else if let data = try? JSONSerialization.data(withJSONObject: ["env": secrets.env, "headers": secrets.headers]),
                      let text = String(data: data, encoding: .utf8) {
                KeyStore.set(text, for: server.secretsKey)
            }
        }
        store.saveNow()
        mcpStatus[server.id] = nil
        refreshMCP(reconnect: true)
    }

    func deleteMCPServer(_ id: String) {
        store.settings.mcpServers.removeAll { $0.id == id }
        KeyStore.delete("mcp.\(id)")
        mcpStatus[id] = nil
        store.saveNow()
        refreshMCP()
    }

    /// Connects to every enabled server and records what it offers, or why it failed.
    func refreshMCP(reconnect: Bool = false) {
        mcpRefreshGeneration += 1
        let generation = mcpRefreshGeneration
        let servers = mcpServerPayloads()
        let ids = Set(servers.map(\.id))
        mcpStatus = mcpStatus.filter { ids.contains($0.key) }
        guard sidecar.status.isReady else {
            mcpStatus = Dictionary(servers.map {
                ($0.id, MCPServerStatus(id: $0.id, ok: false, error: "The brain isn't running. Reconnect when it's ready.", tools: []))
            }, uniquingKeysWith: { first, _ in first })
            return
        }
        if reconnect { mcpStatus = [:] }
        // An empty list also reaches the sidecar, closing disabled/removed servers.
        Task { [weak self] in
            let statuses = await BrainClient.shared.mcpTools(servers: servers, reconnect: reconnect)
            guard let self, self.mcpRefreshGeneration == generation else { return }
            self.mcpStatus = Dictionary((statuses ?? servers.map {
                MCPServerStatus(id: $0.id, ok: false, error: "Couldn't reach the brain. Try Reconnect.", tools: [])
            }).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            self.mcpCheckedAt = Date()
        }
    }

    /// Re-checks what the dashboard shows about the brain's services: MCP servers and the memory index.
    /// Called when the dashboard opens and now and then while it stays open, so a server that died
    /// mid-session shows up without a toggle or restart.
    func refreshServiceStatus() {
        if !mcpServerPayloads().isEmpty { refreshMCP() }
        refreshMemoryStatus()
    }

    func refreshMemoryStatus() {
        guard sidecar.status.isReady else {
            if memoryIndex != MemoryIndexStatus() { memoryIndex = MemoryIndexStatus() }
            return
        }
        Task { [weak self] in
            guard let status = await BrainClient.shared.memoryStatus() else { return }
            self?.memoryIndex = status
        }
    }

    private func prepareConnector(decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        guard let callJSON = decision.connectorCallJSON, let data = callJSON.data(using: .utf8),
              let call = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // Nothing runnable came back; show what the brain said instead.
            let run = store.createRun(kind: .answer, title: decision.title, prompt: request.text, threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
            present(makeAnswerCard(decision: decision, request: request, threadID: threadID, run: run), source: source)
            return
        }
        let isApify = call["connector"] as? String == "apify"
        let target: String
        let lines: [String]
        if isApify {
            target = "Apify"
            lines = ["apify · \(call["actor"] as? String ?? "actor")", "input · \(compactJSON(call["input"]))"]
        } else {
            let serverID = call["server"] as? String ?? ""
            target = store.settings.mcpServers.first(where: { $0.id == serverID })?.name ?? serverID
            lines = ["mcp · \(target) · \(call["tool"] as? String ?? "tool")", "arguments · \(compactJSON(call["arguments"]))"]
        }
        // "apify" or a server's name on the blocked list stops it, like any blocked tool.
        if let blocked = SafetyPolicy.blocked(commands: lines, settings: store.settings) {
            present(AnswerCardModel(title: "i won't run that", text: blocked,
                                    threadTitle: store.thread(threadID)?.title, threadID: threadID), source: source)
            return
        }
        // Actors spend Apify credits, so they're never low risk.
        let risk: RiskLevel = isApify && decision.risk == .low ? .medium : decision.risk
        let steps = (decision.previewSteps.isEmpty ? ["call \(target)", "read the results", "write up the answer"] : decision.previewSteps)
            .map { RunStep(title: $0) }
        let summary = decision.previewSummary.isEmpty ? decision.title : decision.previewSummary
        let preview = ActionPreview(summary: isApify ? "\(summary) · uses Apify credits" : summary,
                                    risk: risk, steps: steps.map { PreviewStep($0.title) },
                                    commands: lines, apps: [target], files: [])
        let run = store.createRun(kind: .connector, title: decision.title, prompt: request.text,
                                  threadID: threadID, preview: preview, steps: steps, status: .waiting)
        pendingConnectorCalls[run.id] = callJSON
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "prepared “\(run.title)”. \(preview.summary). waiting for your okay.", runID: run.id)

        let actions = [
            CardAction(title: "review preview", kind: .secondary, glyph: "grid") { [weak self] in
                self?.openDashboard(.runs, runID: run.id)
            },
            CardAction(title: "do it", kind: .primary, glyph: "bolt") { [weak self] in
                self?.approveRun(run.id)
            },
        ]
        let card = AnswerCardModel(title: decision.title, text: decision.answer, actions: actions,
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "action preview · \(risk.label) risk"
            + (SafetyPolicy.mustAsk(lines + [target], settings: store.settings).map { " · \($0) is on always ask" } ?? "")
        present(card, source: source)
        store.saveNow()
        speak(decision.speak.isEmpty ? "Here's the plan. Want me to go ahead?" : decision.speak)
    }

    private func executeConnector(_ run: AgentRun) async {
        guard let callJSON = pendingConnectorCalls[run.id] else {
            store.finishRun(run.id, status: .failed, summary: "this was prepared before okidoki restarted. ask again and i'll set it up fresh.")
            return
        }
        if let reason = SafetyPolicy.connectorUnavailable(callJSON: callJSON, connectors: store.connectors,
                                                          settings: store.settings, hasApifyKey: hasKey("apify")) {
            pendingConnectorCalls[run.id] = nil
            store.finishRun(run.id, status: .failed, summary: reason)
            store.saveNow()
            return
        }
        guard sidecar.status.isReady else {
            pendingConnectorCalls[run.id] = nil
            store.finishRun(run.id, status: .failed, summary: "the brain isn't running, so connectors can't either. try again in a moment.")
            return
        }
        store.updateRun(run.id) { current in
            if current.steps.indices.contains(0) {
                current.steps[0].status = .running
                current.steps[0].startedAt = Date()
            }
        }
        let result = await BrainClient.shared.runConnector(runID: run.id, prompt: run.prompt, callJSON: callJSON,
                                                           apifyToken: KeyStore.get("apify"),
                                                           servers: mcpServerPayloads(),
                                                           spendingLimit: store.settings.spendingLimit,
                                                           model: store.settings.claudeModel)
        pendingConnectorCalls[run.id] = nil
        guard store.run(run.id)?.status != .cancelled else { return }
        guard let result, result.ok else {
            let message = result?.error ?? "couldn't reach the brain"
            store.finishRun(run.id, status: .failed, summary: message)
            toast(title: "that didn't work", detail: String(message.prefix(140)), kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "open run",
                  onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) }, runID: run.id)
            store.saveNow()
            return
        }
        store.updateRun(run.id) { current in
            current.output = result.output
            for index in current.steps.indices { current.steps[index].status = .done }
        }
        store.finishRun(run.id, status: .done, summary: result.summary)
        if let threadID = run.threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: result.answer, runID: run.id)
        }
        let card = AnswerCardModel(title: run.title, text: result.answer,
                                   actions: [CardAction(title: "details", kind: .ghost, glyph: "grid") { [weak self] in
                                       self?.openDashboard(.runs, runID: run.id)
                                   }],
                                   threadTitle: run.threadID.flatMap { store.thread($0)?.title },
                                   runID: run.id, threadID: run.threadID)
        card.footnote = result.summary
        present(card, source: "connector")
        toast(title: "done", detail: result.summary, kind: .success, undoLabel: nil, onUndo: nil,
              editLabel: "details", onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) }, runID: run.id)
        speak(result.summary)
        store.saveNow()
    }

    private func compactJSON(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text.count > 300 ? String(text.prefix(300)) + "…" : text
    }

    // MARK: - Memory index (Moss)

    /// Moss credentials from Keys, saved as "projectId:projectKey".
    private func mossCredentials() -> (projectId: String, projectKey: String)? {
        guard let raw = KeyStore.get("moss")?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let parts = raw.split(maxSplits: 1, whereSeparator: { $0 == ":" || $0.isWhitespace }).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (parts[0], parts[1].trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Keeps the brain's memory index current, a few seconds after the store settles.
    private func scheduleMemoryIndex(after delay: Double = 5) {
        guard mossCredentials() != nil else { return }
        memoryWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { await self?.pushMemoryIndex() }
        }
        memoryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func pushMemoryIndex() async {
        guard sidecar.status.isReady, let credentials = mossCredentials() else { return }
        // Only what the index uses: notes, recent turns, recent tasks and skills, never run output.
        let index = MemoryIndexPayload(store: store)
        let payload = BrainMemorySyncPayload(
            projectId: credentials.projectId, projectKey: credentials.projectKey,
            cacheDir: AppPaths.support("moss", isDirectory: true).path,
            memories: index.memories, threads: index.threads, runs: index.runs, skills: index.skills)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = .sortedKeys  // stable bytes, so an unchanged index isn't re-sent
        guard let data = try? encoder.encode(payload) else { return }
        let hash = data
        guard hash != lastMemoryHash else { return }
        let result = await BrainClient.shared.memorySync(payload)
        if let result { memoryIndex = result.status }
        if result?.ok == true {
            lastMemoryHash = hash
            memoryRetryDelay = 5
        } else {
            // The brain was busy, restarting or offline (Moss signs in on first use): try again, backing off.
            scheduleMemoryIndex(after: memoryRetryDelay)
            memoryRetryDelay = min(memoryRetryDelay * 2, 120)
        }
    }

    // MARK: - Onboarding helpers

    func completeOnboarding() {
        store.settings.onboardingComplete = true
        store.settings.tourComplete = true
        store.saveNow()
        onboarding.hide()
        openDashboard(.home)
        toast(title: "you're in", detail: "shake your mouse anywhere. that's the only way in.",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    func openOnboarding() {
        onboarding.show()
    }

    func addOnboardingMemories(_ text: String) {
        let parts = text
            .components(separatedBy: CharacterSet(charactersIn: ",;\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count > 2 }
        for part in parts { store.addMemory(part, section: .aboutYou, source: "onboarding") }
        store.saveNow()
    }

    // MARK: - Dashboard + toast

    func showDashboardQuietly(_ section: DashboardSection) {
        dashboard.showQuietly(section: section)
    }

    func openDashboard(_ section: DashboardSection, runID: String? = nil) {
        dashboardRoute = section
        if let runID { dashboardRunID = runID }
        if signedOut {
            dashboard.show(section: .home, runID: runID)
            return
        }
        dashboard.show(section: section, runID: runID)
    }

    func toast(title: String, detail: String, kind: ToastKind,
               undoLabel: String?, onUndo: (() -> Void)?,
               editLabel: String?, onEdit: (() -> Void)?, runID: String?) {
        let toast = NotchToast(title: title, detail: detail, kind: kind,
                               undoLabel: undoLabel, editLabel: editLabel,
                               runID: runID, expiresAt: Date().addingTimeInterval(6.5))
        notch.model.addToast(toast, undo: onUndo, edit: onEdit)
        notch.refresh()
    }

    private var typedTurn = false

    func noteSpokenInput(_ spoken: Bool) {
        typedTurn = !spoken
        if !spoken { speaker.stop() }
    }

    private func confirmOK() {
        guard store.settings.confirmOK, !typedTurn else { return }
        if store.settings.voiceEnabled {
            speaker.speak("Okidoki.", voiceID: store.settings.voiceID, speed: store.settings.voiceSpeed)
        }
    }

    func speak(_ text: String) {
        // Not for typed requests, and quiet during calls, screen shares and quiet mode; the card still shows the answer.
        guard store.settings.voiceEnabled, !typedTurn, !store.settings.quietMode, !inCall else { return }
        // Nor for a request the user backed out of.
        guard !Task.isCancelled else { return }
        speaker.speak(text, voiceID: store.settings.voiceID, speed: store.settings.voiceSpeed)
    }

    /// Set once Cartesia's failure has been shown, so a broken key doesn't toast on every reply.
    private var cartesiaWarned = false

    private func cartesiaFailed(_ reason: String) {
        guard !cartesiaWarned else { return }
        cartesiaWarned = true
        toast(title: "using your Mac's voice", detail: reason, kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: "settings", onEdit: { [weak self] in
                  self?.openDashboard(.settings)
              }, runID: nil)
    }

    func signOut() {
        signedOut = true
        store.saveNow()
        openDashboard(.home)
    }

    func signIn(accountID: String) {
        store.switchAccount(accountID)
        signedOut = false
        store.saveNow()
    }

    func createAccountAndSignIn(name: String, email: String, kind: AccountKind) {
        store.createAccount(name: name, email: email, kind: kind)
        signedOut = false
        store.saveNow()
    }

    // MARK: - Helpers

    func inferTopic(_ text: String) -> String {
        let lower = text.lowercased()
        let topics = ["figma", "git", "swift", "xcode", "keynote", "screenshot", "space", "calendar", "video", "python", "react"]
        for topic in topics where lower.contains(topic) { return topic }
        return ""
    }

    func pickFile(kind: String, prompt: String) async -> URL? {
        let panel = NSOpenPanel()
        panel.message = prompt
        panel.prompt = "choose"
        panel.canChooseFiles = true
        panel.canChooseDirectories = (kind == "folder" || kind == "images")
        panel.allowsMultipleSelection = false
        switch kind {
        case "pdf":
            panel.allowedContentTypes = [.pdf]
        case "video":
            panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie, .video]
        case "document":
            panel.allowedContentTypes = [.plainText, .pdf, .text, .html, .rtf] + [UTType(filenameExtension: "docx")].compactMap { $0 }
        case "images":
            panel.allowedContentTypes = [.image]
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
        default:
            break
        }
        let response = panel.runModal()
        return response == .OK ? panel.url : nil
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            formatter.dateFormat = "'today at' h:mm a"
        } else if Calendar.current.isDateInTomorrow(date) {
            formatter.dateFormat = "'tomorrow at' h:mm a"
        } else {
            formatter.dateFormat = "EEE 'at' h:mm a"
        }
        return formatter.string(from: date)
    }
}

private final class StringBox: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func append(_ value: String) { lock.lock(); text = String((text + value).suffix(80_000)); lock.unlock() }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

/// Lets exactly one of two racing tasks deliver a result.
@MainActor
private final class FirstWins {
    private var fired = false
    func claim() -> Bool {
        if fired { return false }
        fired = true
        return true
    }
}
