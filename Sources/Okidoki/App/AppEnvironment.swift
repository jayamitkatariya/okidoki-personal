import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers
import OkidokiCore

enum DashboardSection: String, CaseIterable, Identifiable {
    case home, runs, history, memory, skills, toolbox, keys, settings, live, spaces, team, vault
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
    let convex: ConvexSyncService
    /// Enterprise: runs the agent's jobs from the work account's spaces on this Mac.
    let worker = SpaceWorkerService()
    /// Enterprise: colleagues on the same network, and this Mac's open invitation to them.
    let nearby = NearbyService()
    /// Enterprise: the organization as seen from this Mac — approvals, spaces, shared skills — and the
    /// actions the notch and the cursor card take on it. Fed by the worker's poll.
    let enterprise = EnterpriseService()

    private(set) var summon: SummonController!
    private(set) var draw: DrawingController!
    private(set) var answerController: AnswerCardController!
    private(set) var teach: TeachController!
    private(set) var concept: ConceptStageController!
    private(set) var ghost: GhostCursorController!
    private(set) var replayer: SkillReplayer!
    private(set) var watchHUD: WatchHUDController!
    private(set) var notch: NotchController!
    private(set) var driver: ComputerUseDriver!
    /// The macOS VM computer-use runs drive when settings say so; this Mac otherwise.
    let privateMac = PrivateMacService()
    private(set) var simOverlay: SimOverlayController!
    private(set) var statusBar: StatusBarController!
    private(set) var dashboard: DashboardWindowController!
    private(set) var onboarding: OnboardingWindowController!
    private var terminalCards: [String: AnswerCardModel] = [:]
    private var shake: ShakeDetector!
    private var scheduler: RoutineScheduler!

    @Published var dashboardOpen = false
    @Published var onboardingOpen = false
    @Published var signedOut = false
    @Published var dashboardRoute: DashboardSection = .home
    @Published var dashboardRunID: String?
    /// The space the panel should open on, set by the notch or the cursor card.
    @Published var dashboardSpaceID: String?
    @Published var askPulse = 0
    @Published var shakePulse = 0
    @Published var inCall = false
    @Published var installedAgents: [CodingAgentID] = []
    /// Every coding agent okidoki knows, with whether it's on the PATH and signed in. Refreshed with the tools.
    @Published var agentStatus: [AgentStatus] = []
    @Published var keysVersion = 0
    /// Last connection result per MCP server id, for the Toolbox.
    @Published var mcpStatus: [String: MCPServerStatus] = [:]
    /// When the MCP servers were last checked, so the Toolbox can say how fresh its status is.
    @Published var mcpCheckedAt: Date?
    /// The brain's Moss index as last reported: after each sync, and on request for the dashboard.
    @Published var memoryIndex = MemoryIndexStatus()
    @Published var isBusy = false
    /// Requests in flight; a routine finishing must not mark a summon request idle.
    private var busyCount = 0 { didSet { isBusy = busyCount > 0 } }
    @Published var suspendSummonForTour = false

    private var summonAppName = "mac"
    private var summonBundleID = ""
    /// Window, browser tab and a small screenshot, gathered while the capsule opens so the brain
    /// can see what the request is about. Finished (or given up on) by the time they submit.
    private var summonContext: Task<ScreenContext?, Never>?
    private var watchRunID: String?
    /// How many passes a queued skill replay should make, by run id.
    private var pendingReplays: [String: Int] = [:]
    /// `{{placeholder}}` values for each pass of a queued replay (one record per pass), by run id.
    var pendingReplayValues: [String: [[String: String]]] = [:]
    /// What "again" means in the chat.
    private var lastReplayedSkillID: String?
    private var pendingStarts: [String: DispatchWorkItem] = [:]
    private var pausedStarts: Set<String> = []
    private var mcpRefreshGeneration = 0
    private var pendingToolInstalls: [String: String] = [:]
    /// Approved-later connector calls by run id: the brain's call JSON, handed back untouched when the run starts.
    private var pendingConnectorCalls: [String: String] = [:]
    private var syncWork: DispatchWorkItem?
    private var syncTimer: Timer?
    private var memoryWork: DispatchWorkItem?
    /// Seconds before the next try after the memory index failed to sync; doubles up to two minutes.
    private var memoryRetryDelay: Double = 5
    /// Hash of the last memory payload the brain accepted, so an unchanged store isn't re-sent.
    private var lastMemoryHash: Int?
    private var callTimer: Timer?
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
        self.convex = ConvexSyncService()
        self.shake = ShakeDetector()
        self.summon = SummonController(environment: self, speech: speech, glow: glows)
        self.draw = DrawingController(environment: self)
        self.answerController = AnswerCardController(environment: self)
        self.teach = TeachController(environment: self)
        self.concept = ConceptStageController(environment: self)
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

        // Space jobs go through the same pipeline as a typed request, in their own thread, with no card or voice here.
        worker.runJob = { [weak self] prompt, threadID in await self?.askFromSpace(prompt, threadID: threadID) }
        worker.approveRun = { [weak self] id in self?.approveRun(id) }
        worker.cancelRun = { [weak self] id in self?.cancelRun(id) }
        worker.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        enterprise.start(store: store)
        worker.onSummary = { [weak self] json in self?.enterprise.apply(json) }
        enterprise.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        enterprise.$pendingWelcome
            .receive(on: RunLoop.main)
            .compactMap { $0 }
            .sink { [weak self] welcome in self?.showOrgWelcome(welcome) }
            .store(in: &cancellables)
        worker.start(store: store)
        nearby.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        // Browsing is a passive multicast listen; it runs whenever a work account is selected.
        store.$currentAccountID.combineLatest(store.$accounts)
            .map { id, accounts in accounts.first { $0.id == id }?.kind == .work }
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] work in
                guard let self else { return }
                if work { self.nearby.startBrowsing() } else { self.nearby.stopBrowsing(); self.nearby.stopAdvertising() }
            }
            .store(in: &cancellables)

        store.$settings
            .receive(on: RunLoop.main)
            .sink { [weak self] settings in
                guard let self else { return }
                self.shake.sensitivity = settings.shakeSensitivity
                self.shake.isEnabled = settings.okidokiEnabled
                self.notch.model.quiet = settings.quietMode || self.inCall
                self.applyAppearance(settings.appearance)
            }
            .store(in: &cancellables)

        store.$settings.map(\.mcpServers).removeDuplicates()
            .combineLatest(store.$connectors.map { $0.first(where: { $0.id == "mcp" })?.enabled == true }.removeDuplicates())
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshMCP() }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshInstalled() }
            .store(in: &cancellables)

        // Taken synchronously (the store is on the main actor), so a save landing or a sync finishing,
        // which the store marks as housekeeping, doesn't schedule the next sync and the next after that.
        store.objectWillChange
            .sink { [weak self] _ in
                guard let self, !self.store.isHousekeeping else { return }
                self.scheduleSync()
                self.scheduleMemoryIndex()
            }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    func start() {
        applyBuiltinServices()
        // An IT-provisioned Mac is in its organization before anyone types: the deployment URL
        // and a join code arrive with the managed configuration.
        ManagedConfig.current().apply(to: store)
        applyAppearance(store.settings.appearance)
        statusBar = StatusBarController(environment: self)
        dashboard = DashboardWindowController(environment: self)
        onboarding = OnboardingWindowController(environment: self)
        notch.install()
        glows.install()
        shake.start()
        if ProcessInfo.processInfo.environment["OKIDOKI_OVERLAY_PREVIEW"] != "1" { sidecar.start() }
        if ProcessInfo.processInfo.environment["OKIDOKI_TEACH_LAB"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.teach.startLab() }
        }

        scheduler = RoutineScheduler(store: store)
        scheduler.onDue = { [weak self] routine in
            Task { @MainActor in self?.runRoutine(routine) }
        }
        scheduler.start()

        refreshInstalled()
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

        // While the dashboard is open, keep its Toolbox and Memory status honest without a toggle or restart.
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

        // Sync is two-way: on launch, and every few minutes after, this Mac pulls what the account's other
        // Macs changed (cheap when nothing did: one version check per account) and merges it in.
        refreshSync()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 5 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshSync() }
        }

        if ProcessInfo.processInfo.environment["OKIDOKI_DEV_HOOKS"] == "1" { installDevHooks() }
    }

    // MARK: - Dev hooks (OKIDOKI_DEV_HOOKS=1)

    /// Scripted testing: `scripts/dev-drive.sh` posts distributed notifications that start a
    /// computer-use run straight away, send text through the normal pipeline, or stop the run.
    /// Off unless the app is launched with OKIDOKI_DEV_HOOKS=1, since any local process could post them.
    private func installDevHooks() {
        let center = DistributedNotificationCenter.default()
        center.addObserver(forName: Notification.Name("com.jaykatariya.okidoki.dev.drive"), object: nil, queue: .main) { [weak self] note in
            guard let goal = (note.object as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty else { return }
            Task { @MainActor in await self?.devDrive(goal: goal) }
        }
        center.addObserver(forName: Notification.Name("com.jaykatariya.okidoki.dev.ask"), object: nil, queue: .main) { [weak self] note in
            guard let text = note.object as? String else { return }
            Task { @MainActor in self?.askFromDashboard(text) }
        }
        // "x,y" in global Quartz points: a click as the learner, so a scripted run can follow a lesson.
        center.addObserver(forName: Notification.Name("com.jaykatariya.okidoki.dev.click"), object: nil, queue: .main) { note in
            let parts = ((note.object as? String) ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2 else { return }
            Task { await EventActuator.click(at: CGPoint(x: parts[0], y: parts[1])) }
        }
        center.addObserver(forName: Notification.Name("com.jaykatariya.okidoki.dev.stop"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.driver.isActive { self.driver.cancel(reason: "stopped by the test script") }
            }
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
        // Pointer movement must never interrupt an active action, recording, or lesson.
        // Use the session's explicit controls or Escape to stop it.
        guard !driver.isActive, !watch.isRecording, !replayer.isActive,
              !ghost.model.visible, !teach.model.isActive, !concept.isActive else { return }
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
        draw.dismissAll()
        summon.dismiss()
        answerController.close()
        ghost.cancel()
        notch.noteListening(false)
        notch.collapse()
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
        if teach.isActive, teach.handleCommand(text) {
            summon.hideInput()
            notch.noteListening(false)
            notch.collapse()
            return
        }
        if concept.isActive, screenshot == nil, !text.trimmingCharacters(in: .whitespaces).isEmpty {
            // A question while the 3D lesson is up gets answered on the stage itself.
            let lower = text.lowercased()
            if ["next", "skip", "continue"].contains(where: { lower == $0 }) { concept.next() }
            else if ["back", "go back"].contains(where: { lower == $0 }) { concept.back() }
            else if ["stop", "close", "quit"].contains(where: { lower == $0 }) { concept.dismiss(completed: false) }
            else { concept.ask(text) }
            summon.hideInput()
            notch.noteListening(false)
            notch.collapse()
            return
        }
        // A space chosen on the capsule sends the request to that space's agent instead of this Mac.
        // A circled screenshot can't travel in a chat line, so it stays local.
        if screenshot == nil, let scope = summon.model.scope, let space = enterprise.space(id: scope.id),
           ChatCommands.parse(text, context: chatContext()) == nil {
            summonContext?.cancel()
            summonContext = nil
            handleChatCommand(.askSpace(spaceID: space.id, text: text), text: text, appName: appName, threadID: nil, source: "summon")
            return
        }
        let pendingContext = claimSummonContext()
        Task {
            let screenContext = await awaitSummonContext(pendingContext)
            await handleRequest(text: text, appName: appName, bundleID: bundleID, threadID: nil,
                                screenshot: screenshot, selection: selection,
                                attachmentName: attachmentName, documentText: "", source: "summon",
                                screenContext: screenContext)
            summon.hideInput()
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
        Task {
            await handleRequest(text: text, appName: "mac", bundleID: "", threadID: threadID,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "followup")
        }
    }

    /// A drive paused on a question only the user can answer. The card shows it with a reply box;
    /// the reply starts a new run in the same thread that carries on from where this one stopped.
    func presentDriveQuestion(runID: String, question: String) {
        guard let run = store.run(runID) else { return }
        // A colleague's job reports through its space chat; a card here would interrupt whoever's at this Mac.
        guard run.threadID == nil || run.threadID != worker.activeThreadID else { return }
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
        guard let prior = store.run(runID), prior.status == .asked, prior.kind == .computerUse,
              let threadID = prior.threadID else {
            if let threadID = store.run(runID)?.threadID { continueThread(threadID, text: reply) }
            return
        }
        store.appendMessage(threadID: threadID, role: .user, text: reply)
        let run = store.createRun(kind: .computerUse, title: prior.title, prompt: reply, threadID: threadID,
                                  preview: prior.preview, steps: (prior.preview?.steps ?? []).map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "computer-use")
        store.saveNow()
        approveRun(run.id)
    }

    // MARK: - Request pipeline

    func askFromDashboard(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        noteSpokenInput(false)
        Task {
            await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: nil,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "dashboard")
        }
    }

    /// A job from a space: a colleague's request, run here. Typed, so nothing is spoken aloud.
    func askFromSpace(_ text: String, threadID: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        noteSpokenInput(false)
        await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: threadID,
                            screenshot: nil, selection: nil, attachmentName: "",
                            documentText: "", source: "space")
    }

    func requestAsk() {
        askPulse += 1
        if !dashboardOpen { openDashboard(.home) }
    }

    func continueThread(_ threadID: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        noteSpokenInput(false)
        Task {
            await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: threadID,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "followup")
        }
    }

    func startSkillWalkthrough(_ skill: Skill) {
        let run = store.createRun(kind: .teach, title: skill.name, prompt: skill.name,
                                  status: .running)
        store.startRun(run.id)
        teach.start(topic: skill.name, steps: skill.steps.map(\.text), runID: run.id, threadID: nil)
        answerController.close(restoreApp: false)
        summon.hideInput()
    }

    private func handleRequest(text: String, appName: String, bundleID: String, threadID: String?,
                               screenshot: Data?, selection: CGRect?, attachmentName: String,
                               documentText: String, source: String,
                               screenContext: ScreenContext? = nil) async {
        // Skills and recordings are driven straight from the chat: "replay invoice flow", "stop",
        // "save as …", "my skills". No brain round trip, no key needed, no variance.
        if screenshot == nil, documentText.isEmpty, source != "repair",
           let command = ChatCommands.parse(text, context: chatContext()) {
            handleChatCommand(command, text: text, appName: appName, threadID: threadID, source: source)
            return
        }
        // Built-in terminal jobs (installs, updates, opening tools, common conversions) are
        // planned on the Mac itself, so they work without a model key and never vary.
        let builtin = screenshot == nil && documentText.isEmpty && source != "repair" ? TerminalActions.decide(text) : nil
        guard builtin != nil || hasKey("anthropic") else {
            presentNeedsKey(prompt: text, threadID: threadID, source: source)
            return
        }
        busyCount += 1
        defer { busyCount -= 1 }
        var document = documentText
        var docName = attachmentName
        let lower = text.lowercased()
        // A circled region is the thing to summarise; only ask for a file when there's nothing attached,
        // and never for a space job or a routine: a file picker would sit open on an unattended Mac.
        if builtin == nil, document.isEmpty, screenshot == nil, !Self.isUnattended(source),
           (lower.contains("summar") || lower.hasPrefix("read this pdf")) {
            if let url = await pickFile(kind: "pdf", prompt: "choose a PDF to read") {
                document = DocumentReader.read(url: url) ?? ""
                docName = url.lastPathComponent
            }
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
        if let builtin {
            let request = BrainRequest(text: text, appName: appName, bundleID: bundleID, threadID: thread.id, source: source)
            await handleDecision(builtin, request: request, threadID: thread.id, source: source)
            return
        }
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
        let request = BrainRequest(text: text, appName: appName, bundleID: bundleID,
                                   threadID: thread.id, screenshotPNG: screenshot,
                                   selection: selection, source: source,
                                   attachmentName: docName, documentText: document,
                                   clipboardText: clipboard, screen: screenContext)
        var events: [BrainNativeEvent] = []
        if store.settings.appleCalendar,
           lower.contains("calendar") || lower.contains("meeting") || lower.contains("schedule") || lower.contains("what's next") {
            if let today = try? await AppleBridge.shared.eventsToday() {
                let formatter = ISO8601DateFormatter()
                events = today.prefix(10).map { BrainNativeEvent(title: $0.title, start: formatter.string(from: $0.start)) }
            }
        }
        let history = (store.thread(thread.id)?.messages ?? []).map { BrainMessage(role: $0.role.rawValue, text: $0.text) }
        // The account's current notes; anything else it remembers is found by meaning in the memory index.
        var memory = store.memoryLines()
        if teach.isActive { memory.insert("Right now: \(teach.questionContext)", at: 0) }
        else if concept.isActive { memory.insert("Right now: \(concept.questionContext)", at: 0) }
        let installed = ToolCatalog.tools.filter { store.toolInstalled[$0.id] == true }.map(\.id)
        var decision: BrainDecision?
        if sidecar.status.isReady {
            switch await BrainClient.shared.think(text: text, request: request, history: history,
                                                  memory: memory, events: events,
                                                  settings: store.settings, account: store.activeAccount,
                                                  installedTools: installed,
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
        if let decision {
            await handleDecision(decision, request: request, threadID: thread.id, source: source)
        } else {
            let result = await BrainService(store: store).think(request)
            await handleDecision(result.decision, request: request, threadID: thread.id, source: source)
        }
    }

    /// Space jobs and routines run with nobody at this Mac: nothing may wait on a person here.
    static func isUnattended(_ source: String) -> Bool { source == "space" || source == "routine" }

    private func handleDecision(_ decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        var decision = withoutShowOrDoChoice(decision, request: request)
        if Self.isUnattended(source), let needsPerson = Self.needsSomeoneHere(decision.kind) {
            // A lesson, a recording, the ghost cursor or a drawing takes over this Mac's screen and
            // waits for whoever is at it; from a space or a schedule that is nobody.
            decision.kind = .answer
            decision.answer = "That would need someone at this Mac (\(needsPerson)). Ask it from the Mac itself, or ask for something it can do on its own, like a command, a script or a web task."
            decision.speak = ""
            decision.title = String(request.text.prefix(60))
        }
        if decision.kind == .teach {
            // Same rule as the brain, applied once more here so the sidecar and the native
            // fallback can't disagree: a how-to in the tool in front of them is an app lesson,
            // an "explain" over a lecture is a concept model.
            decision.lessonKind = LessonRouting.resolve(lessonKind: decision.lessonKind, scene: decision.scene, text: request.text)
        }
        for fact in decision.memory where BrainService.isDurableFact(fact) {
            store.addMemory(fact, section: fact.lowercased().hasPrefix("right now") ? .rightNow : .aboutYou,
                            source: source == "summon" ? "said" : source)
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
            let weekday = decision.routineWeekday ?? 6
            var hour = decision.routineHour ?? 17
            if hour < 0 || hour > 23 { hour = 17 }
            let cadence = RoutineCadence(rawValue: decision.routineCadence ?? "weekly") ?? .weekly
            let name = decision.routineName ?? decision.title
            let routine = store.createRoutine(name: name, prompt: request.text,
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

        case .teach:
            let topic = String(decision.title.replacingOccurrences(of: "teach: ", with: ""))
            let run = store.createRun(kind: .teach, title: topic, prompt: request.text, threadID: threadID, status: .running)
            store.startRun(run.id)
            store.appendMessage(threadID: threadID, role: .assistant, text: decision.answer, runID: run.id)
            answerController.close(restoreApp: false)
            summon.hideInput()
            if decision.lessonKind == "concept" {
                concept.begin(topic: topic, requestText: request.text, appBundleID: request.bundleID,
                              screenshotPNG: request.screenshotPNG, runID: run.id, threadID: threadID)
                toast(title: "drawing · \(topic)", detail: "a model is coming up beside your screen · esc closes it",
                      kind: .info, undoLabel: "stop", onUndo: { [weak self] in self?.concept.dismiss(completed: false) },
                      editLabel: nil, onEdit: nil, runID: run.id)
            } else {
                let outline = decision.teachPlan.isEmpty ? decision.teachSteps : decision.teachPlan.map(\.say)
                teach.start(topic: topic, outline: outline, appBundleID: request.bundleID,
                            runID: run.id, threadID: threadID)
                toast(title: "teaching · \(topic)", detail: "i'll point, you do it · it moves on as you go · esc stops",
                      kind: .info, undoLabel: "stop", onUndo: { [weak self] in self?.teach.stop(completed: false) },
                      editLabel: nil, onEdit: nil, runID: run.id)
            }

        case .watch:
            startWatching(prompt: request.text, threadID: threadID, decision: decision)
            summon.hideInput()

        case .terminal, .coding, .background:
            await prepareTask(decision: decision, request: request, threadID: threadID, source: source)

        case .borrow:
            await prepareBorrow(decision: decision, request: request, threadID: threadID, source: source)

        case .computerUse:
            await prepareComputerUse(decision: decision, request: request, threadID: threadID, source: source)

        case .overlay:
            await handleOverlay(decision: decision, request: request, threadID: threadID, source: source)

        case .connector:
            await prepareConnector(decision: decision, request: request, threadID: threadID, source: source)
        }
    }

    /// What an unattended Mac can't give: the kinds that take the screen and wait for a person.
    static func needsSomeoneHere(_ kind: BrainDecision.Kind) -> String? {
        switch kind {
        case .teach: return "a lesson on screen"
        case .watch: return "a recording of what you do"
        case .borrow: return "borrowing the cursor"
        case .overlay: return "drawing on the screen"
        default: return nil
        }
    }

    func present(_ card: AnswerCardModel, source: String) {
        // Routines and space jobs report elsewhere; a card at the cursor would interrupt whoever's at this Mac.
        guard !Self.isUnattended(source) else { return }
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
        // from the dashboard, a lesson or a repair must not pull typing away from the app they're in.
        let takesFocus = ["summon", "followup", "onboarding"].contains(source) || summon.model.isVisible
        answerController.show(card, near: cursor, makeKey: takesFocus)
    }

    private func makeAnswerCard(decision: BrainDecision, request: BrainRequest,
                                threadID: String, run: AgentRun) -> AnswerCardModel {
        var actions: [CardAction] = []
        if decision.pickFile != nil, decision.commands.isEmpty {
            actions.append(CardAction(title: "choose file", kind: .primary, glyph: "folder") { [weak self] in
                self?.answerController.close(restoreApp: false)
                Task { await self?.repreparePickFile(decision: decision, request: request, threadID: threadID) }
            })
        }
        let card = AnswerCardModel(title: decision.title, text: decision.answer,
                                   actions: Array(actions.prefix(3)),
                                   threadTitle: store.thread(threadID)?.title,
                                   runID: run.id, threadID: threadID)
        return card
    }

    /// A model that still asks "show or do" gets answered here. The card never offers the choice.
    private func withoutShowOrDoChoice(_ decision: BrainDecision, request: BrainRequest) -> BrainDecision {
        guard decision.kind == .answer, offersShowOrDo(decision) else { return decision }
        if TeachLibrary.prefersShowing(request.text, appName: request.appName) {
            let topic = String(request.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(48))
            let plan = TeachLibrary.plan(for: topic.isEmpty ? decision.title : topic)
            return BrainDecision(kind: .teach, title: "teach: \(topic.isEmpty ? decision.title : topic)",
                                 answer: "alright — \(topic.isEmpty ? decision.title : topic). i'll play it on your screen. pause if you want to linger on a step.",
                                 speak: "",
                                 teachSteps: plan.map(\.say),
                                 teachPlan: plan)
        }
        let title = String(request.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(54))
        let app = request.appName.trimmingCharacters(in: .whitespacesAndNewlines)
        return BrainDecision(kind: .computerUse, title: title.isEmpty ? decision.title : title,
                             answer: "doing it.",
                             speak: "",
                             risk: .medium,
                             previewSummary: title.isEmpty ? decision.title : title,
                             previewSteps: ["open the app", "look at the screen", "click and type through it", "hand control back"],
                             apps: app.isEmpty ? [] : [app])
    }

    private func offersShowOrDo(_ decision: BrainDecision) -> Bool {
        let actions = decision.actions.map { $0.lowercased() }
        if actions.contains(where: { $0.contains("show") }), actions.contains(where: { $0.contains("do") }) {
            return true
        }
        let ask = (decision.clarification ?? "").lowercased()
        if ask.contains("show"), ask.contains("do") { return true }
        let answer = decision.answer.lowercased()
        return answer.contains("show you") && answer.contains("do it")
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
        if action.type == "reminder", action.date == nil {
            let card = AnswerCardModel(title: "when?",
                                       text: "i'll put “\(action.title)” in reminders. give me a time — “today at 6” or “tomorrow morning”.",
                                       actions: [],
                                       threadTitle: store.thread(threadID)?.title, threadID: threadID)
            card.onSubmitFollowUp = { [weak self, weak card] text in
                guard let self, let card else { return }
                self.answerController.close(restoreApp: false)
                Task {
                    await self.handleRequest(text: "remind me to \(action.title) \(text)",
                                             appName: "mac", bundleID: "", threadID: card.threadID,
                                             screenshot: nil, selection: nil, attachmentName: "",
                                             documentText: "", source: "followup")
                }
            }
            present(card, source: source)
            speak("When should I remind you?")
            return
        }

        do {
            var undo: (() -> Void)?
            var toastDetail = decision.previewSummary
            switch action.type {
            case "reminder":
                let date = action.date.flatMap(DateParsing.iso8601)
                let id = try await AppleBridge.shared.addReminder(title: action.title, due: date)
                undo = { Task { try? await AppleBridge.shared.deleteReminder(id: id) } }
                if toastDetail.isEmpty {
                    toastDetail = date.map { "for \(relativeTime($0))" } ?? "no date"
                }
            case "note":
                let id = try await AppleBridge.shared.addNote(title: action.title, body: action.body ?? "")
                undo = { Task { try? await AppleBridge.shared.deleteNote(id: id) } }
                if toastDetail.isEmpty { toastDetail = "saved in notes" }
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
                                       text: message + "\n\nconnect the apple app in toolbox, or grant automation when macOS asks.",
                                       actions: [CardAction(title: "open toolbox", kind: .secondary) { [weak self] in
                                           self?.openDashboard(.toolbox)
                                       }],
                                       threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
        }
    }

    // MARK: - Tasks

    private func prepareTask(decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        if decision.kind == .background && !store.settings.backgroundMode {
            let card = AnswerCardModel(title: "background mode is off",
                                       text: "turn on background mode and i'll do this quietly while you keep working.",
                                       actions: [CardAction(title: "turn it on", kind: .primary) { [weak self] in
                                           self?.store.settings.backgroundMode = true
                                           self?.store.saveNow()
                                       }], threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }

        var file: URL?
        var folder: URL?
        var decision = decision
        // A fix for a stopped job keeps that job's folder and picked file; nobody is asked twice.
        let repair = source == "repair" ? repairContext[threadID] : nil
        if let repair {
            var isDirectory: ObjCBool = false
            if let picked = repair.pickedPath, FileManager.default.fileExists(atPath: picked, isDirectory: &isDirectory) {
                if isDirectory.boolValue { folder = URL(fileURLWithPath: picked) } else { file = URL(fileURLWithPath: picked) }
            }
            if file == nil && folder == nil, let directory = repair.workingDirectory { folder = URL(fileURLWithPath: directory) }
            decision.pickFile = nil
        }
        if let pick = decision.pickFile, !decision.commands.isEmpty {
            if pick == "folder" || pick == "images" {
                folder = await pickFile(kind: pick, prompt: pick == "images" ? "choose a folder of images" : "choose a folder")
            } else {
                file = await pickFile(kind: pick, prompt: "choose a \(pick)")
            }
            if file == nil && folder == nil {
                let card = AnswerCardModel(title: "no file chosen",
                                           text: "okay — nothing happened. pick a file when you're ready, or drag one into the dashboard and ask again.",
                                           threadTitle: store.thread(threadID)?.title, threadID: threadID)
                present(card, source: source)
                return
            }
        }

        var workingDirectory = decision.kind == .coding ? store.settings.lastWorkingDirectory
            : (folder?.path ?? file?.deletingLastPathComponent().path ?? NSHomeDirectory())
        if decision.kind == .coding {
            if workingDirectory.isEmpty || !FileManager.default.fileExists(atPath: workingDirectory) {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.allowsMultipleSelection = false
                panel.prompt = "use this folder"
                panel.message = "where should \(store.settings.selectedAgent.displayName) work?"
                if panel.runModal() == .OK, let url = panel.url {
                    workingDirectory = url.path
                    store.settings.lastWorkingDirectory = url.path
                } else {
                    workingDirectory = NSHomeDirectory()
                }
            }
        }

        var filled = PlaceholderFiller.fill(decision.commands, file: file, folder: folder)
        if decision.kind == .coding, let agent = CodingAgentCommand.build(agent: store.settings.selectedAgent,
                                                                          prompt: request.text,
                                                                          workingDirectory: workingDirectory,
                                                                          extraArgs: store.settings.agentExtraArgs[store.settings.selectedAgent.rawValue] ?? "") {
            filled = [agent.command]
        }
        var addedInstalls: [(label: String, command: String)] = []
        var asksForPassword = false
        var builtin = decision.builtin
        if decision.kind != .coding, builtin == nil || builtin == TerminalActions.launchBuiltin {
            do {
                let prepared = try TerminalActions.preparePlan(filled)
                addedInstalls = prepared.installs
                asksForPassword = prepared.asksForPassword
                filled = prepared.commands
            } catch {
                let card = AnswerCardModel(title: "one thing to fix first", text: error.localizedDescription,
                                           threadTitle: store.thread(threadID)?.title, threadID: threadID)
                present(card, source: source)
                return
            }
            // Chat UIs and full-screen tools can't run in a pipe; give them a Terminal window.
            if builtin == nil, filled.contains(where: TerminalActions.needsRealTerminal) {
                builtin = TerminalActions.launchBuiltin
            }
        }
        if let blocked = SafetyPolicy.blocked(commands: filled, settings: store.settings) {
            let card = AnswerCardModel(title: "i won't run that",
                                       text: blocked,
                                       threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }

        let commandRisk = CommandRisk.classify(filled.joined(separator: "\n"))
        let risk: RiskLevel = decision.risk == .high || commandRisk == .high ? .high
            : (decision.risk == .medium || commandRisk == .medium || !addedInstalls.isEmpty ? .medium : .low)
        let runKind = RunKind(rawValue: decision.kind.rawValue) ?? .terminal
        let stepTitles: [String]
        if decision.kind == .terminal || decision.kind == .background, !filled.isEmpty {
            let original = decision.previewSteps.count == decision.commands.count ? decision.previewSteps
                : decision.commands.indices.map { "step \($0 + 1) of \(decision.commands.count)" }
            stepTitles = addedInstalls.map(\.label) + original
        } else {
            stepTitles = decision.previewSteps.isEmpty ? defaultSteps(kind: runKind) : decision.previewSteps
        }
        let steps = stepTitles.map { RunStep(title: $0) }
        let files = decision.files + [file?.path, folder?.path].compactMap { $0 }
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? decision.title : decision.previewSummary,
                                    risk: risk, steps: steps.map { PreviewStep($0.title) },
                                    commands: filled, apps: builtin == TerminalActions.launchBuiltin ? ["Terminal"] : decision.apps,
                                    files: files.isEmpty ? (workingDirectory.isEmpty ? [] : [workingDirectory]) : files)
        let run = store.createRun(kind: runKind, title: decision.title, prompt: request.text,
                                  threadID: threadID, preview: preview,
                                  steps: steps, agent: decision.kind == .coding ? store.settings.selectedAgent : nil,
                                  workingDirectory: workingDirectory.isEmpty ? nil : workingDirectory,
                                  status: .waiting, builtin: builtin,
                                  pickedPath: folder?.path ?? file?.path)

        // Commands you chose "always allow" for start straight away, unless something here is on always ask.
        if decision.kind == .terminal || decision.kind == .background,
           SafetyPolicy.preApproved(commands: filled, risk: risk, settings: store.settings) {
            store.appendMessage(threadID: threadID, role: .assistant,
                                text: "running “\(run.title)”. you always allow these commands.", runID: run.id)
            summon.hideInput()
            approveRun(run.id)
            store.saveNow()
            return
        }
        let askedFor = SafetyPolicy.mustAsk(filled + preview.apps, settings: store.settings)

        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "prepared “\(run.title)”. \(preview.summary). waiting for your okay.", runID: run.id)

        var actions: [CardAction] = []
        actions.append(CardAction(title: "review preview", kind: .secondary, glyph: "grid") { [weak self] in
            self?.openDashboard(.runs, runID: run.id)
        })
        actions.append(CardAction(title: decision.kind == .borrow ? "allow once" : "do it", kind: .primary, glyph: "bolt") { [weak self] in
            self?.approveRun(run.id)
        })
        var text = decision.answer
        if !preview.commands.isEmpty {
            text += "\n\n" + steps.enumerated().map { "\($0.offset + 1). \($0.element.title)" }.joined(separator: "\n")
            text += "\n\nFolder: \(workingDirectory)"
            if !addedInstalls.isEmpty { text += "\nIncludes a one-time installation for missing tools." }
            if asksForPassword { text += "\nOne step asks for your Mac login password in a dialog. It goes straight to macOS and is never stored." }
            if builtin == TerminalActions.launchBuiltin { text += "\nThis opens in a Terminal window you can see and type into." }
        }
        if decision.kind == .coding {
            let agent = store.settings.selectedAgent
            if ShellRunner.which(agent.binary) == nil {
                text = "\(agent.displayName) isn't installed yet. I can install it now, or you can pick another agent in toolbox."
                actions = [CardAction(title: "install \(agent.displayName)", kind: .primary, glyph: "bolt") { [weak self] in
                    guard let self else { return }
                    self.answerController.close(restoreApp: false)
                    Task { await self.handleRequest(text: "install \(agent.displayName.lowercased())", appName: "mac", bundleID: "",
                                                    threadID: threadID, screenshot: nil, selection: nil, attachmentName: "",
                                                    documentText: "", source: "followup") }
                }, CardAction(title: "open toolbox", kind: .secondary, glyph: "grid") { [weak self] in
                    self?.openDashboard(.toolbox)
                }]
            }
        }
        let card = AnswerCardModel(title: decision.title, text: text, actions: actions,
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.terminalCommands = filled
        card.footnote = "action preview · \(risk.label) risk" + (askedFor.map { " · \($0) is on always ask" } ?? "")
        present(card, source: source)
        store.saveNow()
        speak(decision.speak.isEmpty ? "Here's the plan. Want me to go ahead?" : decision.speak)
    }

    private func defaultSteps(kind: RunKind) -> [String] {
        switch kind {
        case .terminal: return ["check the inputs", "run the command", "verify the result"]
        case .coding: return ["read the project", "plan the change", "edit files", "run a check", "summarise"]
        case .background: return ["prepare the batch", "work through each item", "collect the results"]
        case .borrow: return ["find the target", "move the ghost cursor", "click once", "give control back"]
        case .computerUse: return ["open the app", "look at the screen", "click and type through it", "hand control back"]
        default: return ["prepare", "run", "check"]
        }
    }

    private func repreparePickFile(decision: BrainDecision, request: BrainRequest, threadID: String) async {
        var decision = decision
        if let pick = decision.pickFile {
            if pick == "folder" || pick == "images" {
                if let folder = await pickFile(kind: pick, prompt: "choose a folder") {
                    decision.commands = PlaceholderFiller.fill(decision.commands, file: nil, folder: folder)
                }
            } else if let file = await pickFile(kind: pick, prompt: "choose a \(pick)") {
                decision.commands = PlaceholderFiller.fill(decision.commands, file: file, folder: nil)
            }
        }
        await prepareTask(decision: decision, request: request, threadID: threadID, source: "summon")
    }

    private func prepareBorrow(decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        if !store.settings.screenBorrowing { store.settings.screenBorrowing = true }
        if !EventActuator.canPost { _ = await PermissionsService.shared.request(.accessibility) }
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
        if run.kind == .coding, ShellRunner.which((run.agent ?? store.settings.selectedAgent).binary) == nil {
            let agent = run.agent ?? store.settings.selectedAgent
            toast(title: "\(agent.displayName) isn't installed", detail: "i can set it up for you",
                  kind: .warning, undoLabel: nil, onUndo: nil, editLabel: "install", onEdit: { [weak self] in
                      guard let self else { return }
                      Task { await self.handleRequest(text: "install \(agent.displayName.lowercased())", appName: "mac", bundleID: "",
                                                      threadID: run.threadID, screenshot: nil, selection: nil, attachmentName: "",
                                                      documentText: "", source: "followup") }
                  }, runID: id)
            return
        }
        if let blocked = SafetyPolicy.blocked(commands: run.preview?.commands ?? [], settings: store.settings) {
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
        guard let run = store.run(id) else { return }
        // Only shell commands can be matched next time; other runs are approved just this once.
        // Installs and deletes still ask every time, so they're never remembered.
        let remembers = run.kind == .terminal || run.kind == .background
        let stillAsks = remembers && (run.preview?.commands ?? []).contains(where: SafetyPolicy.alwaysNeedsApproval)
        if remembers {
            for command in run.preview?.commands ?? [] where !SafetyPolicy.alwaysNeedsApproval(command) {
                let prefix = SafetyPolicy.allowPrefix(command)
                if !prefix.isEmpty, !store.settings.alwaysAllow.contains(prefix) {
                    store.settings.alwaysAllow.append(prefix)
                }
            }
        }
        approveRun(id)
        toast(title: remembers ? "always allowed" : "allowed once",
              detail: !remembers ? "always allow only covers terminal commands"
                : stillAsks ? "installs and deletes will still ask" : "i won't ask for these commands again", kind: .info,
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
        pendingToolInstalls[id] = nil
        store.cancelRun(id)
        finishTerminalCard(id)
        toast(title: "not now", detail: "nothing changed", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
    }

    func pauseRun(_ id: String) {
        guard let run = store.run(id) else { return }
        // A recording can't pause: the recorder either watches or it doesn't.
        if run.kind == .watch || run.kind == .connector { return }
        // A replay can't resume mid-click either; pausing hands control back, like computer use.
        if replayer.isActive, replayer.runID == id { replayer.cancel(reason: "paused — control is yours"); return }
        if run.status == .paused {
            if pausedStarts.remove(id) != nil {
                execute(run)
                return
            }
            store.updateRun(id) { $0.status = .running }
            ShellRunner.shared.resume(id: id)
            BrainClient.shared.resume(runID: id)
            return
        }
        if pendingStarts[id] != nil {
            pendingStarts[id]?.cancel()
            pendingStarts[id] = nil
            pausedStarts.insert(id)
            store.updateRun(id) { $0.status = .paused }
            return
        }
        if driver.isActive, run.kind == .computerUse {
            driver.cancel(reason: "paused — control is yours")
            return
        }
        store.updateRun(id) { $0.status = .paused }
        ShellRunner.shared.pause(id: id)
        BrainClient.shared.pause(runID: id)
    }

    func stopRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        pausedStarts.remove(id)
        pendingConnectorCalls[id] = nil
        pendingToolInstalls[id] = nil
        // Stopping the recording run (from the notch, the Runs page, anywhere) ends the recording
        // and keeps what was captured; the recorder's finish handler closes the run itself.
        if watch.isRecording, watchRunID == id { stopWatching(); return }
        ShellRunner.shared.cancel(id: id)
        BrainClient.shared.stop(runID: id)
        if replayer.isActive, replayer.runID == id { replayer.cancel(reason: "you stopped me"); return }
        if ghost.model.visible, store.run(id)?.kind == .borrow { ghost.cancel() }
        if driver.isActive, store.run(id)?.kind == .computerUse { driver.cancel(reason: "you stopped me"); return }
        if teach.model.isActive, store.run(id)?.kind == .teach { teach.stop(completed: false); return }
        store.cancelRun(id)
        finishTerminalCard(id)
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
        let agentCommands = run.kind == .coding ? [(run.agent ?? store.settings.selectedAgent).binary] : []
        if let blocked = SafetyPolicy.blocked(commands: (run.preview?.commands ?? []) + agentCommands, settings: store.settings) {
            store.finishRun(run.id, status: .failed, summary: blocked)
            finishTerminalCard(run.id)
            store.saveNow()
            return
        }
        store.updateRun(run.id) { run in
            run.status = .running
            run.startedAt = run.startedAt ?? Date()
        }
        switch run.kind {
        case .terminal, .background:
            Task { await executeShell(run) }
        case .coding:
            Task { await executeCoding(run) }
        case .borrow:
            if run.builtin == "skill" {
                let times = pendingReplays.removeValue(forKey: run.id) ?? 1
                guard let id = run.pickedPath, let skill = store.skill(id) else {
                    failReplay(runID: run.id, reason: "that skill was deleted before the replay started")
                    return
                }
                replayer.begin(skill: skill, runID: run.id, times: times,
                               values: pendingReplayValues.removeValue(forKey: run.id) ?? [])
                return
            }
            let target = run.pickedPath ?? run.prompt
            ghost.begin(target: target, runID: run.id)
        case .computerUse:
            beginDriving(run)
        case .connector:
            Task { await executeConnector(run) }
        case .teach:
            break
        case .watch:
            break
        default:
            store.finishRun(run.id, status: .done, summary: "done")
        }
    }

    /// Computer-use runs go to the private Mac when the setting says so. A VM that is set up but
    /// off is booted first; one that isn't set up fails the run rather than quietly driving this Mac.
    private func beginDriving(_ run: AgentRun) {
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

    private func executeShell(_ run: AgentRun) async {
        let card = AnswerCardModel(title: run.title, text: "Working on your request…", actions: [
            CardAction(title: "stop", kind: .danger) { [weak self] in self?.stopRun(run.id) },
            CardAction(title: "details", kind: .secondary) { [weak self] in self?.openDashboard(.runs, runID: run.id) }
        ], runID: run.id, threadID: run.threadID)
        card.terminalCommands = run.preview?.commands ?? []
        card.footnote = "running · you can keep working"
        terminalCards[run.id] = card
        present(card, source: "summon")

        // Shell jobs always run in the app itself, never through the brain sidecar: the same progress
        // frames, password helper, Mole follow-up and repair path whether or not Bun is up.
        if run.builtin == "export-keynote", let folder = run.pickedPath {
            let output = folder + "-pdf"
            try? FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
            do {
                let count = try await AppleBridge.shared.exportKeynoteDecks(in: folder, to: output)
                store.updateRun(run.id) { $0.output = "exported \(count) decks to \(output)" }
                store.finishRun(run.id, status: .done, summary: "exported \(count) decks to \(URL(fileURLWithPath: output).lastPathComponent)")
                toast(title: "decks exported", detail: "\(count) PDFs in \(URL(fileURLWithPath: output).lastPathComponent)",
                      kind: .success, undoLabel: nil, onUndo: nil, editLabel: "open", onEdit: {
                          NSWorkspace.shared.open(URL(fileURLWithPath: output))
                      }, runID: run.id)
                speak("Done. \(count) decks exported.")
            } catch {
                fail(run.id, error)
            }
            finishTerminalCard(run.id)
            return
        }

        var commands = run.preview?.commands ?? []
        guard !commands.isEmpty else {
            store.finishRun(run.id, status: .failed, summary: "No commands were prepared. Ask again with the job you want to do.")
            finishTerminalCard(run.id)
            return
        }
        guard store.run(run.id)?.status != .cancelled else { return }

        var interactiveCommand: String?
        if run.builtin == TerminalActions.launchBuiltin {
            do {
                let split = try TerminalActions.splitLaunch(commands)
                commands = split.setup
                interactiveCommand = split.launch
            } catch {
                fail(run.id, error)
                finishTerminalCard(run.id)
                return
            }
            if commands.isEmpty, let interactiveCommand {
                await openInteractiveTerminal(run, command: interactiveCommand)
                return
            }
        }

        let marker = "okidoki_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let box = TerminalOutputBuffer(marker: marker, commandCount: commands.count)
        let exitCode: Int32 = await withCheckedContinuation { continuation in
            ShellRunner.shared.stream(id: run.id, command: TerminalActions.script(commands, progressMarker: marker), cwd: run.workingDirectory,
                onOutput: { text in
                    box.append(text)
                    guard box.needsRefresh() else { return }
                    Task { @MainActor in
                        let progress = box.progress
                        guard let status = self.store.run(run.id)?.status, status == .running || status == .paused else { return }
                        self.store.updateRun(run.id) { current in
                            current.output = String(progress.output.suffix(80_000))
                            self.terminalCards[run.id]?.terminalOutput = String(current.output.suffix(6000))
                            for index in current.steps.indices {
                                if progress.completed.contains(index) {
                                    current.steps[index].status = .done
                                    current.steps[index].endedAt = current.steps[index].endedAt ?? Date()
                                } else if index == progress.currentStep {
                                    current.steps[index].status = progress.failed == index ? .failed : .running
                                    current.steps[index].startedAt = current.steps[index].startedAt ?? Date()
                                    self.terminalCards[run.id]?.text = current.steps[index].title
                                }
                            }
                        }
                    }
                }, completion: { code in continuation.resume(returning: code) })
        }
        guard store.run(run.id)?.status != .cancelled else { return }
        let progress = box.progress
        let allOutput = progress.output
        store.updateRun(run.id) { $0.output = String(allOutput.suffix(80_000)) }

        if exitCode == 0 && progress.completed.count == commands.count {
            if let interactiveCommand {
                store.updateRun(run.id) { current in
                    for index in commands.indices where current.steps.indices.contains(index) {
                        current.steps[index].status = .done
                        current.steps[index].endedAt = current.steps[index].endedAt ?? Date()
                    }
                }
                noteInstallFinished(run)
                await openInteractiveTerminal(run, command: interactiveCommand)
                return
            }
            if run.builtin == MemoryImport.builtin {
                store.updateRun(run.id) { current in
                    for index in current.steps.indices { current.steps[index].status = .done; current.steps[index].endedAt = current.steps[index].endedAt ?? Date() }
                }
                finishMemoryImport(run, output: allOutput)
                finishTerminalCard(run.id)
                store.saveNow()
                return
            }
            let cleaned = commands.contains { $0.hasPrefix("mo clean") && !$0.contains("dry-run") }
            let freed: Int64? = cleaned ? OutputInsights.freedBytes(in: allOutput) : nil
            let summary = freed.map { "freed \(Bytes.human($0))" }
                ?? OutputInsights.plainSummary(from: allOutput.components(separatedBy: "\n").filter { !$0.hasPrefix("$ ") }.joined(separator: "\n"))
            store.updateRun(run.id) { current in
                for index in current.steps.indices { current.steps[index].status = .done; current.steps[index].endedAt = current.steps[index].endedAt ?? Date() }
            }
            store.finishRun(run.id, status: .done, summary: summary, freedBytes: freed)
            noteInstallFinished(run)
            toast(title: freed != nil ? "freed \(Bytes.human(freed!))" : "done",
                  detail: summary, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
            if !cleaned, commands.contains(where: { $0.hasPrefix("mo clean") }) {
                // Mole's preview is done; the real clean is its own approval, after they've seen what it found.
                finishTerminalCard(run.id)
                store.saveNow()
                await offerMoleClean(after: run, output: allOutput)
                return
            }
            speak(summary)
        } else {
            let failedIndex = progress.failed ?? progress.currentStep
            store.updateRun(run.id) { current in
                if current.steps.indices.contains(failedIndex) {
                    current.steps[failedIndex].status = .failed
                    current.steps[failedIndex].endedAt = Date()
                }
            }
            // Keep the final handoff in repair plans too; a failed prerequisite must not
            // silently turn “install and open” into an install-only retry.
            await recover(run: run, commands: run.preview?.commands ?? commands, failedIndex: failedIndex, output: allOutput)
            return
        }
        finishTerminalCard(run.id)
        store.saveNow()
    }

    /// A launch acknowledges only the handoff. Setup has already completed under ShellRunner,
    /// and no output or successful execution of the interactive tool is invented here.
    private func openInteractiveTerminal(_ run: AgentRun, command: String) async {
        guard store.run(run.id)?.status != .cancelled else { return }
        do {
            let script = try await TerminalLauncher.open(title: run.title, commands: [command],
                                                         workingDirectory: run.workingDirectory ?? NSHomeDirectory())
            guard store.run(run.id)?.status != .cancelled else { return }
            store.updateRun(run.id) { current in
                current.output += "\n[handed \(script.lastPathComponent) to Terminal; interactive session is not monitored]\n"
                if let index = current.steps.indices.last {
                    current.steps[index].status = .done
                    current.steps[index].endedAt = Date()
                }
            }
            store.finishRun(run.id, status: .done, summary: "Handed the interactive session to Terminal. Its progress and exit status are shown there.")
            toast(title: "opened in Terminal", detail: run.title, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
            speak("It's open in Terminal.")
        } catch { fail(run.id, error) }
        finishTerminalCard(run.id)
        store.saveNow()
    }

    /// After a successful install, the toolbox and the agent picker reflect it right away.
    private func noteInstallFinished(_ run: AgentRun) {
        repairAttempts[run.threadID ?? run.id] = nil
        pendingToolInstalls[run.id] = nil
        refreshInstalled()
    }

    /// The memory files the job printed become memories. Only additions: nothing already remembered is
    /// touched, and the other assistant's files aren't either. Everything lands on the Memory page to edit or forget.
    private func finishMemoryImport(_ run: AgentRun, output: String) {
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
        speak(added > 0 ? "Done. I remembered \(added) things." : summary)
    }

    /// The second half of "free up space": prepare the real clean, which waits for its own okay.
    private func offerMoleClean(after run: AgentRun, output: String) async {
        let threadID = run.threadID ?? store.threadForContext(app: "mac", topic: run.title).id
        let found = OutputInsights.reclaimableBytes(in: output).map { "Mole can free about \(Bytes.human($0))" }
            ?? "Mole's preview is done"
        let decision = BrainDecision(kind: .terminal, title: "clean with mole",
                                     answer: "\(found) from caches, logs and trash. The full list is in the run's output. Clean it?",
                                     speak: "\(found). Want me to clean it?",
                                     risk: .medium,
                                     previewSummary: "clean what Mole found in caches, logs and trash",
                                     previewSteps: ["ask for your Mac password", "clean caches, logs and trash"],
                                     commands: ["sudo -v", "mo clean"], apps: [])
        let request = BrainRequest(text: run.prompt, threadID: threadID, source: "followup")
        await prepareTask(decision: decision, request: request, threadID: threadID, source: "followup")
    }

    private var repairAttempts: [String: Int] = [:]
    private var repairContext: [String: (workingDirectory: String?, pickedPath: String?)] = [:]

    /// A failed step never ends with raw output. The cause is diagnosed on the Mac first; when
    /// it isn't a known one, the model is asked for a corrected plan, which still needs approval.
    private func recover(run: AgentRun, commands: [String], failedIndex: Int, output: String) async {
        let command = commands.indices.contains(failedIndex) ? commands[failedIndex] : (commands.last ?? "")
        let diagnosis = TerminalActions.diagnose(output: output, command: command)
        let stepNumber = failedIndex + 1
        store.finishRun(run.id, status: .failed, summary: "Step \(stepNumber) stopped. \(diagnosis.message)")
        finishTerminalCard(run.id)

        let threadID = run.threadID ?? store.threadForContext(app: "mac", topic: run.title).id
        let attempts = repairAttempts[threadID, default: 0]
        let title = run.title.hasPrefix("fix: ") ? String(run.title.dropFirst(5)) : run.title
        repairContext[threadID] = (run.workingDirectory, run.pickedPath)
        if !diagnosis.fixCommands.isEmpty, attempts < 3 {
            repairAttempts[threadID] = attempts + 1
            let remaining = Array(commands[failedIndex...])
            let fixed = diagnosis.fixCommands + (diagnosis.retry ? remaining : [])
            let titles = run.steps.count == commands.count ? run.steps.map(\.title) : commands.indices.map { "step \($0 + 1) of \(commands.count)" }
            let steps = diagnosis.fixLabels + (diagnosis.retry ? Array(titles[failedIndex...]) : [])
            let decision = BrainDecision(kind: .terminal, title: "fix: \(title)",
                                         answer: diagnosis.message,
                                         speak: "That stopped. Here's a fix.",
                                         risk: .medium,
                                         previewSummary: diagnosis.retry ? "fix the cause, then finish \(title)" : "fix the cause",
                                         previewSteps: steps, commands: fixed, apps: [])
            let request = BrainRequest(text: run.prompt, threadID: threadID, source: "repair")
            await prepareTask(decision: decision, request: request, threadID: threadID, source: "repair")
            return
        }
        if hasKey("anthropic"), attempts < 2 {
            repairAttempts[threadID] = attempts + 1
            toast(title: "that didn't work", detail: "looking for a fix…", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "open run", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
            let report = """
            The terminal job “\(run.title)” stopped at step \(stepNumber) of \(commands.count).
            Original request: \(run.prompt)
            Working folder: \(run.workingDirectory ?? NSHomeDirectory())
            Steps that completed: \(commands.prefix(failedIndex).map { "$ " + $0 }.joined(separator: "\n"))
            Failed command:
            $ \(command)
            Output (last part):
            \(String(output.suffix(4000)))
            """
            await handleRequest(text: "that stopped at step \(stepNumber) — fix the cause and finish the job. Reply with a terminal plan; don't repeat steps that already completed unless they must run again.",
                                appName: "mac", bundleID: "", threadID: threadID,
                                screenshot: nil, selection: nil, attachmentName: "terminal output",
                                documentText: report, source: "repair")
            return
        }
        let card = AnswerCardModel(title: "that didn't work",
                                   text: diagnosis.message + (hasKey("anthropic") ? "" : "\n\nOnce the model is reachable again I can work out fixes for problems like this."),
                                   actions: [CardAction(title: "details", kind: .secondary) { [weak self] in self?.openDashboard(.runs, runID: run.id) }],
                                   threadTitle: run.threadID.flatMap { store.thread($0)?.title }, runID: run.id, threadID: run.threadID)
        card.terminalOutput = String(output.suffix(6000))
        card.footnote = "stopped at step \(stepNumber)"
        present(card, source: "summon")
        toast(title: "that didn't work", detail: String(diagnosis.message.prefix(120)), kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: "open run", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: run.id)
              }, runID: run.id)
        store.saveNow()
    }

    private func finishTerminalCard(_ id: String) {
        guard let run = store.run(id), let card = terminalCards.removeValue(forKey: id) else { return }
        let commands = run.preview?.commands ?? []
        let readOnly = commands.allSatisfy { command in
            ["df ", "sw_vers", "uname ", "git status", "ls ", "pwd"].contains(where: command.hasPrefix)
        }
        card.text = run.status == .done
            ? "Finished: \(run.title).\n\n" + (readOnly ? run.summary : "All \(run.steps.count) steps completed. Your output is available below.")
            : run.summary
        card.terminalOutput = String(run.output.suffix(6000))
        card.footnote = run.status == .done ? "completed" : (run.status == .cancelled ? "stopped" : "needs attention")
        card.actions = [CardAction(title: "details", kind: .secondary) { [weak self] in self?.openDashboard(.runs, runID: id) }]
        if run.status == .done, let picked = run.pickedPath {
            card.actions.insert(CardAction(title: "show files", kind: .primary) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: picked)])
            }, at: 0)
        }
        if let threadID = run.threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: "\(run.title): \(run.summary)\n\(run.output.suffix(2000))", runID: id)
        }
    }

    private func executeCoding(_ run: AgentRun) async {
        guard sidecar.status.isReady else {
            await executeCodingLocal(run)
            return
        }
        let agent = run.agent ?? store.settings.selectedAgent
        let result = await BrainClient.shared.execute(
            runID: run.id, kind: .coding, commands: [], agent: agent,
            prompt: run.prompt, workingDirectory: run.workingDirectory,
            extraArgs: store.settings.agentExtraArgs[agent.rawValue] ?? "",
            onEvent: { [weak self] event in
                guard let self, let current = self.store.run(run.id), current.status != .cancelled else { return }
                switch event {
                case .output(let text):
                    self.store.updateRun(run.id) { run in
                        run.output += text
                        if run.output.count > 120_000 { run.output = String(run.output.suffix(100_000)) }
                    }
                case .step:
                    self.store.updateRun(run.id) { run in
                        if let first = run.steps.indices.first, run.steps[first].status != .done {
                            run.steps[first].status = .running
                            run.steps[first].startedAt = Date()
                        }
                    }
                default:
                    break
                }
            })
        guard store.run(run.id)?.status != .cancelled else { return }
        guard let result else {
            store.finishRun(run.id, status: .failed, summary: "No result received. Check the run before retrying.")
            return
        }
        if result.success {
            let summary = result.summary.isEmpty ? "done" : result.summary
            self.store.updateRun(run.id) { current in
                for index in current.steps.indices {
                    current.steps[index].status = .done
                    current.steps[index].endedAt = Date()
                }
            }
            self.store.finishRun(run.id, status: .done, summary: summary)
            self.toast(title: "\(agent.displayName) finished", detail: summary, kind: .success,
                       undoLabel: nil, onUndo: nil, editLabel: "see the work",
                       onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) }, runID: run.id)
            self.speak("\(agent.displayName) finished. \(summary)")
        } else {
            self.store.finishRun(run.id, status: .failed, summary: result.summary)
            self.toast(title: "the agent hit a wall", detail: "open the run to see the last lines", kind: .warning,
                       undoLabel: nil, onUndo: nil, editLabel: "open run",
                       onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) }, runID: run.id)
        }
        self.store.saveNow()
    }

    private func executeCodingLocal(_ run: AgentRun) async {
        let agent = run.agent ?? store.settings.selectedAgent
        guard let built = CodingAgentCommand.build(agent: agent, prompt: run.prompt,
                                                   workingDirectory: run.workingDirectory ?? NSHomeDirectory(),
                                                   extraArgs: store.settings.agentExtraArgs[agent.rawValue] ?? "") else {
            store.finishRun(run.id, status: .failed, summary: "\(agent.displayName) is not installed")
            toast(title: "agent not installed", detail: agent.installHint, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "toolbox", onEdit: { [weak self] in
                      self?.openDashboard(.toolbox)
                  }, runID: run.id)
            return
        }
        store.updateRun(run.id) { current in
            current.output += "$ \(built.command)\n\n"
            if current.steps.indices.contains(0) { current.steps[0].status = .running }
        }
        let box = StringBox()
        let code = await withCheckedContinuation { continuation in
            ShellRunner.shared.stream(id: run.id, command: built.command,
                                      cwd: built.workingDirectory,
                                      onOutput: { text in
                                          box.append(text)
                                          Task { @MainActor in
                                              self.store.updateRun(run.id) { current in
                                                  current.output += text
                                                  if current.output.count > 120_000 {
                                                      current.output = String(current.output.suffix(100_000))
                                                  }
                                              }
                                          }
                                      }, completion: { code in
                                          continuation.resume(returning: code)
                                      })
        }
        let output = box.value
        guard store.run(run.id)?.status != .cancelled else { return }
        if code == 0 {
            let summary = OutputInsights.plainSummary(from: output)
            store.updateRun(run.id) { current in
                for index in current.steps.indices {
                    current.steps[index].status = .done
                    current.steps[index].endedAt = Date()
                }
            }
            store.finishRun(run.id, status: .done, summary: summary)
            toast(title: "\(agent.displayName) finished", detail: summary, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "see the work", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
            speak("\(agent.displayName) finished. \(summary)")
        } else {
            store.finishRun(run.id, status: .failed, summary: String(output.suffix(400)))
            toast(title: "the agent hit a wall", detail: "open the run to see the last lines", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "open run", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
        }
        store.saveNow()
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

    func finishTeach(runID: String, topic: String, threadID: String?, summary: String = "", stepsDone: Int = 0,
                     app: String = "", log: [TeachLogEntry] = [], quiet: Bool = false) {
        let line = summary.isEmpty ? "walkthrough finished" : summary
        store.finishRun(runID, status: .done, summary: line)
        let recap = TeachRecap.text(topic: topic, app: app, steps: log, summary: line)
        if let threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: recap, runID: runID)
        }
        if stepsDone >= 2 {
            // Remember it, so next time the basics get skipped, and keep the steps as a replayable skill.
            let fact = "knows \(topic) in \(app)"
            if !store.activeMemories.contains(where: { $0.text.lowercased() == fact.lowercased() }) {
                _ = store.addMemory(fact, section: .aboutYou, source: "lesson")
            }
            if !store.skills.contains(where: { $0.name.lowercased() == topic.lowercased() && $0.source == "lesson" }) {
                let steps = log.filter { $0.action != "look" }.map { SkillStep(text: $0.say, app: app, label: $0.label) }
                if !steps.isEmpty {
                    _ = store.createSkill(name: topic, summary: line, steps: steps, source: "lesson")
                }
            }
        }
        if !quiet {
            toast(title: "that's \(topic)", detail: summary.isEmpty ? "you did it. ask me again anytime." : summary,
                  kind: .success, undoLabel: nil, onUndo: nil, editLabel: "recap", onEdit: { [weak self] in
                      guard let self else { return }
                      let card = AnswerCardModel(title: "recap · \(topic)", text: recap, actions: [],
                                                 threadTitle: threadID.flatMap { self.store.thread($0)?.title },
                                                 runID: runID, threadID: threadID)
                      self.present(card, source: "lesson")
                  }, runID: runID)
        }
        store.saveNow()
    }

    func finishConcept(runID: String, topic: String, title: String, threadID: String?, recap: String) {
        store.finishRun(runID, status: .done, summary: "explained \(title)")
        if let threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: recap, runID: runID)
        }
        let fact = "knows about \(topic)"
        if !store.activeMemories.contains(where: { $0.text.lowercased() == fact.lowercased() }) {
            _ = store.addMemory(fact, section: .aboutYou, source: "lesson")
        }
        store.saveNow()
    }

    func cancelRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        pausedStarts.remove(id)
        pendingReplays[id] = nil
        pendingReplayValues[id] = nil
        pendingConnectorCalls[id] = nil
        pendingToolInstalls[id] = nil
        ShellRunner.shared.cancel(id: id)
        // A job executing through the brain, or driving the screen, has to be told too; otherwise
        // it runs on to the end with the store already saying "cancelled".
        BrainClient.shared.stop(runID: id)
        if replayer.isActive, replayer.runID == id { replayer.cancel(reason: "cancelled") }
        if driver.isActive, store.run(id)?.kind == .computerUse { driver.cancel(reason: "cancelled") }
        store.cancelRun(id)
        finishTerminalCard(id)
    }

    // MARK: - Watch + skills

    private func startWatching(prompt: String, threadID: String, decision: BrainDecision) {
        beginWatching(prompt: prompt, threadID: threadID, name: "", speakLine: decision.speak)
    }

    /// Dashboard "Record" button: same recorder as "watch me", with a name chosen up front.
    func startTeaching(name: String) {
        guard !watch.isRecording else { return }
        if replayer.isActive { replayer.cancel(reason: "recording instead") }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        beginWatching(prompt: trimmed.isEmpty ? "teach a skill" : "teach: \(trimmed)", threadID: "", name: trimmed, speakLine: "")
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
        let run = store.createRun(kind: .watch, title: name.isEmpty ? "watch me" : "teach · \(name)", prompt: prompt,
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

    /// What the chat can act on by itself: this Mac's skills, and — on a linked work account — its
    /// spaces and colleagues' shared skills.
    private func chatContext() -> ChatCommands.Context {
        let work = store.activeAccount.kind == .work && enterprise.linked
        return ChatCommands.Context(skills: store.activeSkills,
                                    recording: watch.isRecording,
                                    replaying: replayer.isActive,
                                    hasReplayed: lastReplayedSkillID.flatMap { store.skill($0) } != nil,
                                    spaces: work ? enterprise.spaces.map { ChatSpaceRef(id: $0.id, name: $0.name, joined: $0.joined) } : [],
                                    sharedSkills: work ? enterprise.pullableSkills.map { ChatSharedSkillRef(id: $0.id, name: $0.name, publishedBy: $0.publishedBy) } : [],
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
                    self?.startTeaching(name: query)
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
            startTeaching(name: name)

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
            startTeaching(name: name)

        case .stopReplay:
            summon.hideInput()
            replayer.cancel(reason: "you said stop")

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

        // MARK: Enterprise

        case .askSpace(let spaceID, let request):
            guard let space = enterprise.space(id: spaceID) else { return reply("hm", "that space isn't around any more.") }
            summon.hideInput()
            answerController.close(restoreApp: false)
            Task {
                guard await askSpace(space, text: request) else { return }
                store.appendMessage(threadID: thread.id, role: .assistant, text: "sent to #\(space.name): “\(request)”. a Mac in the space will pick it up.")
                toast(title: "sent to #\(space.name)", detail: request, kind: .success,
                      undoLabel: nil, onUndo: nil, editLabel: "open chat", onEdit: { [weak self] in self?.openSpace(space.id) }, runID: nil)
                speak("Sent to \(space.name).")
            }

        case .unknownSpace(let query, let request):
            let spaces = enterprise.spaces
            var actions = spaces.prefix(2).map { space in
                CardAction(title: "#\(space.name)", kind: .secondary, glyph: "number") { [weak self] in
                    guard let self else { return }
                    self.answerController.close(restoreApp: false)
                    Task { await self.askSpace(space, text: request) }
                }
            }
            actions.append(CardAction(title: "open spaces", kind: .ghost, glyph: "people") { [weak self] in self?.openDashboard(.spaces) })
            reply("no #\(query)", spaces.isEmpty ? "you're not in any spaces yet." : "no space called “\(query)”. yours are:\n\n" + spaces.prefix(8).map { "· #\($0.name)\($0.joined ? "" : " (not joined)")" }.joined(separator: "\n"),
                  actions: Array(actions), say: "Which space?")

        case .whatsWaiting:
            let mine = store.waitingRuns
            let theirs = enterprise.approvals.filter { !$0.workerIsYou }
            var lines: [String] = []
            if !mine.isEmpty { lines.append("on this mac:\n" + mine.prefix(5).map { "· \($0.title)" }.joined(separator: "\n")) }
            if !theirs.isEmpty { lines.append("from your team:\n" + theirs.prefix(5).map { "· #\($0.spaceName) — \($0.title.isEmpty ? $0.prompt : $0.title) (\($0.requestedBy))" }.joined(separator: "\n")) }
            let pending = enterprise.org?.pendingJoins ?? 0
            if pending > 0 { lines.append("\(pending) \(pending == 1 ? "person wants" : "people want") to join \(enterprise.org?.name ?? "your organization").") }
            let unread = enterprise.unreadCount
            if unread > 0 { lines.append("\(unread) unread in \(enterprise.unreadSpaces.prefix(3).map { "#\($0.name)" }.joined(separator: ", ")).") }
            var actions: [CardAction] = []
            if let first = mine.first {
                actions.append(CardAction(title: "do it · \(first.title.prefix(18))", kind: .primary, glyph: "bolt") { [weak self] in
                    self?.answerController.close(restoreApp: false); self?.approveRun(first.id)
                })
            } else if let first = theirs.first {
                actions.append(CardAction(title: "do it · #\(first.spaceName)", kind: .primary, glyph: "bolt") { [weak self] in
                    self?.answerController.close(restoreApp: false); self?.decideSpaceJob(first.id, approve: true)
                })
            }
            if pending > 0 { actions.append(CardAction(title: "review requests", kind: .secondary, glyph: "people") { [weak self] in self?.openDashboard(.team) }) }
            else if !theirs.isEmpty || unread > 0 { actions.append(CardAction(title: "open spaces", kind: .secondary, glyph: "chat") { [weak self] in self?.openDashboard(.spaces) }) }
            else if !mine.isEmpty { actions.append(CardAction(title: "open runs", kind: .secondary, glyph: "runs") { [weak self] in self?.openDashboard(.runs) }) }
            let count = mine.count + theirs.count
            reply(count == 0 ? "nothing's waiting" : "\(count) \(count == 1 ? "thing needs" : "things need") you",
                  lines.isEmpty ? "all clear. nothing needs an okay right now." : lines.joined(separator: "\n\n"),
                  actions: actions, say: count == 0 ? "Nothing's waiting on you." : "\(count) \(count == 1 ? "thing needs" : "things need") you.")

        case .listSpaces:
            let spaces = enterprise.spaces
            let actions = spaces.filter(\.joined).prefix(2).map { space in
                CardAction(title: "#\(space.name)", kind: .secondary, glyph: "number") { [weak self] in self?.readSpace(space) }
            } + [CardAction(title: "open spaces", kind: .ghost, glyph: "people") { [weak self] in self?.openDashboard(.spaces) }]
            let body = spaces.isEmpty
                ? "no spaces yet. ask an admin to make one, or open Team to create your own."
                : spaces.prefix(12).map { "· #\($0.name)\($0.joined ? ($0.unread > 0 ? " · \($0.unread) new" : "") : " · not joined")" }.joined(separator: "\n")
                  + "\n\nsay “ask #name to …” to hand the agent a job there."
            reply(enterprise.org.map { "\($0.name) · \(spaces.count) \(spaces.count == 1 ? "space" : "spaces")" } ?? "spaces", body, actions: Array(actions))

        case .openSpace(let spaceID):
            summon.hideInput()
            answerController.close(restoreApp: false)
            if let space = enterprise.space(id: spaceID) { readSpace(space) } else { openSpace(spaceID) }

        case .shareSkill(let skillID, let spaceID):
            guard let skill = store.skill(skillID) else { return }
            let target = spaceID.flatMap { enterprise.space(id: $0) }
            let where_ = target.map { "#\($0.name)" } ?? (enterprise.org?.name ?? "your team")
            summon.hideInput()
            answerController.close(restoreApp: false)
            Task { [weak self] in
                guard let self else { return }
                let outcome = await enterprise.publish(skill, spaceID: spaceID)
                if let error = outcome.error {
                    toast(title: "couldn't share “\(skill.name)”", detail: error, kind: .warning,
                          undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                    return
                }
                store.appendMessage(threadID: thread.id, role: .assistant, text: "shared “\(skill.name)” with \(where_). colleagues can say “replay \(skill.name)” on their own Mac.")
                toast(title: "shared with \(where_)", detail: "“\(skill.name)” — colleagues can replay it now", kind: .success,
                      undoLabel: nil, onUndo: nil, editLabel: "open replay", onEdit: { [weak self] in self?.openDashboard(.skills) }, runID: nil)
                speak("Shared with \(target?.name ?? "your team").")
            }

        case .replayShared(let sharedID, let times):
            guard let shared = enterprise.sharedSkills.first(where: { $0.id == sharedID }) else { return reply("hm", "that skill isn't shared any more.") }
            summon.hideInput()
            answerController.close(restoreApp: false)
            Task {
                guard let skill = await enterprise.pullSkill(shared) else {
                    toast(title: "couldn't get “\(shared.name)”", detail: enterprise.lastError ?? "try again in a moment", kind: .warning,
                          undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                    return
                }
                store.appendMessage(threadID: thread.id, role: .assistant, text: "pulled “\(shared.name)” from \(shared.publishedBy)\(shared.requires.isEmpty ? "" : " · needs \(shared.requires.joined(separator: ", "))").")
                startReplayFromChat(skill, times: times, threadID: thread.id, source: source)
            }

        // MARK: Records and the vault

        case .replayRecords(let id, let recordIDs, let values):
            guard let skill = store.skill(id) else { return reply("hm", "that skill isn't here anymore.") }
            let records = SkillRecords.load()
            let picked = recordIDs.compactMap { rid in records.first { $0.id == rid } }
            let passes = picked.isEmpty ? [values] : picked.map { $0.fillValues.merging(values) { _, typed in typed } }
            startReplayFromChat(skill, times: 1, threadID: thread.id, source: source, values: passes)

        case .addToVault(let query, let url, let space):
            addToVault(query: query, url: url, space: space, request: text, threadID: thread.id, source: source)

        case .unknownRecord(let query):
            let records = SkillRecords.load()
            reply("no \(query)", "there's no record \(query). these are the ones i have:\n\n"
                  + records.prefix(8).map { "· \($0.id) — \($0.title)" }.joined(separator: "\n"),
                  say: "I don't have \(query).")
        }
    }

    /// A replay asked for in the chat starts straight away, like any other job asked for there:
    /// the same approval rules apply (always-ask apps still ask), nothing extra.
    func startReplayFromChat(_ skill: Skill, times: Int, threadID: String, source: String, values: [[String: String]] = []) {
        if replayer.isActive { replayer.cancel(reason: "replaying \(skill.name) instead") }
        if watch.isRecording {
            toast(title: "still recording", detail: "save or discard the recording first", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let passes = max(1, min(times, 10_000))
        let run = makeReplayRun(skill, times: passes, threadID: threadID, values: values)
        let refs = values.compactMap { $0["ref"] }
        let count = !refs.isEmpty ? "for \(refs.joined(separator: ", "))" : passes == 1 ? "once" : "\(passes) times"
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "replaying “\(skill.name)” \(count) — \(skill.steps.count) steps. esc stops me.", runID: run.id)
        let decision = BrainDecision(kind: .borrow, title: "replay · \(skill.name)", answer: "", risk: run.preview?.risk ?? .medium)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
    }

    func finishReplay(runID: String, passes: Int) {
        if let run = store.run(runID), let id = run.pickedPath {
            store.incrementSkillRun(id, by: passes)
            if let skill = store.skill(id) { noteSharedReplay(skill) }
        }
        // Records that came back with a receipt ("MTS-4471 → entry … accepted") say more than a count.
        let receipts = (store.run(runID)?.output ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        let line = !receipts.isEmpty ? receipts.joined(separator: "; ") : passes > 1 ? "replayed \(passes) times" : "replayed once"
        // Several records: one reply that lists them all, which is also what a space sees last.
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

    func failReplay(runID: String, reason: String) {
        pendingReplays[runID] = nil
        pendingReplayValues[runID] = nil
        store.finishRun(runID, status: .failed, summary: reason)
        toast(title: "couldn't finish the replay", detail: reason, kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak self] in
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

    // MARK: - Teaching helper

    /// One live tutoring step. The sidecar when it's up, otherwise straight to the model.
    func teachStep(_ request: TeachStepRequest) async -> TeachLiveStep? {
        guard let key = KeyStore.get("anthropic"), !key.isEmpty else { return nil }
        if sidecar.status.isReady, let step = await BrainClient.shared.teachStep(request) {
            return step
        }
        return await TeachBrain.step(request, key: key, model: teachModel)
    }

    /// Lesson steps are written by Sonnet unless a bigger model was chosen; Haiku is too loose on a busy screen.
    var teachModel: String { TeachBrain.stepModel(for: store.settings.claudeModel) }

    /// Quick checks and zoom passes use Haiku.
    var fastModel: String {
        let chosen = store.settings.claudeModel
        if chosen.lowercased().contains("haiku") { return chosen }
        return ImageFit.tier(for: chosen) == .highResolution ? "claude-haiku-5-5" : "claude-haiku-4-5"
    }

    func teachRefine(_ request: TeachRefineRequest) async -> TeachRefineResult {
        guard let key = KeyStore.get("anthropic"), !key.isEmpty else { return TeachRefineResult(found: false) }
        var fast = request
        fast.model = request.model ?? fastModel
        if sidecar.status.isReady, let result = await BrainClient.shared.teachRefine(fast) {
            return result
        }
        return await TeachBrain.refine(fast, key: key, model: fast.model ?? fastModel)
    }

    /// A narrated 2D/3D lesson. Needs the sidecar: it also fetches real molecule data and a photo card.
    /// The title and intro stream first so the stage can start talking before the model is drawn.
    func teachConceptStream(topic: String, context: String, pageTitle: String?, pageURL: String?,
                            screenshotBase64: String?, imageWidth: Double, imageHeight: Double) async -> AsyncStream<BrainClient.ConceptStreamEvent> {
        guard let key = KeyStore.get("anthropic"), !key.isEmpty else {
            return AsyncStream { $0.yield(.error("the model isn't available right now")); $0.finish() }
        }
        // The brain comes up a few seconds after launch; a lesson asked for right away waits for it.
        var waited = 0.0
        while !sidecar.status.isReady, waited < 12, sidecar.status == .starting || sidecar.status == .idle {
            try? await Task.sleep(nanoseconds: 300_000_000)
            waited += 0.3
        }
        guard sidecar.status.isReady else {
            return AsyncStream { $0.yield(.error("the brain isn't running — install bun to draw lessons")); $0.finish() }
        }
        let language = Locale.preferredLanguages.first.flatMap { code -> String? in
            guard !code.hasPrefix("en") else { return nil }
            return Locale.current.localizedString(forLanguageCode: String(code.prefix(2))) ?? code
        }
        return BrainClient.shared.teachConceptStream(topic: topic, context: context, pageTitle: pageTitle, pageURL: pageURL,
                                                     screenshotBase64: screenshotBase64, imageWidth: imageWidth, imageHeight: imageHeight,
                                                     language: language, model: store.settings.claudeModel)
    }

    func teachConceptFollow(topic: String, question: String, partID: String?, partName: String?, sceneSummary: String) async -> ConceptFollowUp? {
        guard sidecar.status.isReady else { return nil }
        return await BrainClient.shared.teachConceptFollow(topic: topic, question: question, partID: partID, partName: partName,
                                                           sceneSummary: sceneSummary, language: nil, model: store.settings.claudeModel)
    }

    // MARK: - Apple apps

    func connectApple(_ id: String) async -> Bool {
        do {
            _ = try await AppleBridge.shared.probe(id)
            PermissionsService.shared.markAutomationGranted(true)
            store.settings.automationGranted = true
            switch id {
            case "calendar": store.settings.appleCalendar = true
            case "reminders": store.settings.appleReminders = true
            case "notes": store.settings.appleNotes = true
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
        case "reminders": store.settings.appleReminders = false
        case "notes": store.settings.appleNotes = false
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

    /// Points this Mac at the Convex deployment and a Cartesia voice. Credentials come from env.
    /// Sync itself stays the user's choice: the Settings switch is the only thing that turns it on.
    private func applyBuiltinServices() {
        var settings = store.settings
        if settings.convexSiteURL.isEmpty { settings.convexSiteURL = ServiceSecrets.convexSiteURL }
        if settings.voiceID.isEmpty { settings.voiceID = "sarah" }
        store.settings = settings
        store.saveNow()
    }

    // MARK: - Keys, tools, sync

    func hasKey(_ provider: String) -> Bool { KeyStore.has(provider) }

    /// Nothing answers, teaches, or drives the screen until an Anthropic key is saved.
    private func presentNeedsKey(prompt: String, threadID: String?, source: String) {
        let thread = threadID.flatMap { store.thread($0) } ?? store.threadForContext(app: "mac", topic: "key")
        let asked = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !asked.isEmpty {
            store.appendMessage(threadID: thread.id, role: .user, text: asked)
        }
        let decision = BrainService.needsKeyDecision()
        // A space job that never reached the model is a failure the chat should see, not an answer.
        let run = store.createRun(kind: .answer, title: decision.title, prompt: asked, threadID: thread.id, status: source == "space" ? .failed : .done)
        if source == "space" { store.updateRun(run.id) { $0.summary = "the model isn't available on this Mac yet — add an Anthropic key under Settings › Keys" } }
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

    func refreshInstalled() {
        var installed: [String: Bool] = [:]
        for tool in ToolCatalog.tools {
            installed[tool.id] = ShellRunner.toolInstalled(tool)
        }
        store.toolInstalled = installed
        installedAgents = CodingAgentCommand.installedAgents()
        let status = AgentDetection.detect()
        if status != agentStatus { agentStatus = status }
        autoConnectAgent()
    }

    /// When the default agent can't answer (missing, or installed but logged out), move to the first
    /// one that's installed and signed in. Runs on every rescan, but only changes anything once:
    /// after the switch the default is ready, so later rescans leave it alone.
    func autoConnectAgent() {
        guard store.settings.autoConnectAgents else { return }
        let current = store.settings.selectedAgent
        guard !agentStatus.contains(where: { $0.id == current.rawValue && $0.ready }),
              let pick = agentStatus.first(where: \.ready),
              let agent = CodingAgentID(rawValue: pick.id), agent != current else { return }
        store.settings.selectedAgent = agent
        store.saveNow()
        let who = pick.account.isEmpty
            ? (pick.providers.isEmpty ? "signed in" : "signed in to \(pick.providers.joined(separator: ", "))")
            : "signed in as \(pick.account)"
        toast(title: "\(agent.displayName) connected", detail: "\(who) · now the default coding agent",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    func installTool(_ tool: ToolSpec) {
        guard !(store.toolInstalled[tool.id] ?? false) else { return }
        do {
            let plan = try TerminalActions.preparePlan([tool.installCommand, tool.checkCommand])
            if let reason = SafetyPolicy.blocked(commands: plan.commands + [tool.command], settings: store.settings) {
                toast(title: "Tool is off", detail: reason, kind: .warning, undoLabel: nil, onUndo: nil,
                      editLabel: nil, onEdit: nil, runID: nil)
                return
            }
            let titles = plan.installs.map(\.label) + ["install \(tool.name)", "verify \(tool.command) is on your path"]
            let summary = "install \(tool.name)" + (plan.asksForPassword ? " · asks for your Mac password" : "")
            let preview = ActionPreview(summary: summary, risk: .medium,
                                        steps: titles.map { PreviewStep($0) }, commands: plan.commands,
                                        apps: ["Terminal"], files: [])
            let run = store.createRun(kind: .terminal, title: "install \(tool.name)", prompt: "install \(tool.name)",
                                      preview: preview, steps: titles.map { RunStep(title: $0) },
                                      status: .waiting, builtin: "install", pickedPath: tool.id)
            pendingToolInstalls[run.id] = tool.id
            store.saveNow()
            openDashboard(.runs, runID: run.id)
            toast(title: "install \(tool.name)?", detail: "review the steps · approval first",
                  kind: .approval, undoLabel: nil, onUndo: nil, editLabel: "preview", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
        } catch {
            toast(title: "Couldn't prepare installation", detail: error.localizedDescription, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }

    /// Pulls, merges and pushes now. Does nothing while sync is off.
    func refreshSync() {
        guard store.settings.syncEnabled else { return }
        Task { await convex.sync(store: store) }
    }

    func shareRun(_ id: String) {
        guard let run = store.run(id) else { return }
        Task {
            if let url = await convex.share(run: run, account: store.activeAccount, store: store) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
                toast(title: "share link copied", detail: "read-only · anyone can watch the work",
                      kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
            } else {
                let text = "\(run.title)\n\n\(run.prompt)\n\n\(run.summary)\n\n\(run.output.suffix(3000))"
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                toast(title: "run copied", detail: "share pages aren't up yet, so the run itself is on the clipboard",
                      kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
            }
        }
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
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        // Only what the index uses: notes, recent turns, recent tasks and skills, never run output.
        let index = MemoryIndexPayload(store: store)
        let payload = BrainMemorySyncPayload(
            projectId: credentials.projectId, projectKey: credentials.projectKey,
            cacheDir: support.appendingPathComponent("Okidoki/moss", isDirectory: true).path,
            memories: index.memories, threads: index.threads, runs: index.runs, skills: index.skills)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(payload) else { return }
        let hash = data.hashValue
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

    private func scheduleSync() {
        guard store.settings.syncEnabled else { return }
        syncWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            Task { await self.convex.sync(store: self.store) }
        }
        syncWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    // MARK: - Onboarding helpers

    func completeOnboarding() {
        store.settings.onboardingComplete = true
        store.settings.tourComplete = true
        store.saveNow()
        onboarding.hide()
        // A join accepted during onboarding finishes on Team, where the sync login lives.
        openDashboard(store.settings.pendingJoinCode.isEmpty ? .home : .team)
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

    func openDashboard(_ section: DashboardSection, runID: String? = nil) {
        dashboardRoute = section
        if let runID { dashboardRunID = runID }
        refreshSync()
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

    // MARK: - Enterprise, from the notch and the cursor card

    /// Opens the panel on a space's chat.
    func openSpace(_ spaceID: String) {
        dashboardSpaceID = spaceID
        openDashboard(.spaces)
    }

    /// Do it / Not now on a colleague's run, from the notch. The chat hears who answered.
    func decideSpaceJob(_ jobID: String, approve: Bool) {
        let approval = enterprise.approvals.first { $0.id == jobID }
        Task { [weak self] in
            guard let self else { return }
            let outcome = await enterprise.decide(jobID: jobID, decision: approve ? "approve" : "decline")
            if let error = outcome.error {
                toast(title: "that didn't go through", detail: error, kind: .warning,
                      undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            } else if let approval {
                toast(title: approve ? "okayed for #\(approval.spaceName)" : "held in #\(approval.spaceName)",
                      detail: approve ? "\(approval.workerName.isEmpty ? "A Mac" : approval.workerName + "'s Mac") goes ahead with it" : "\(approval.requestedBy) will see it stopped",
                      kind: approve ? .success : .info, undoLabel: nil, onUndo: nil,
                      editLabel: "open chat", onEdit: { [weak self] in self?.openSpace(approval.spaceId) }, runID: nil)
            }
        }
    }

    /// Hands a request to the agent in a space, the way "@okidoki …" in its chat would.
    /// Returns the line to show, or nil with a toast when it couldn't be sent.
    @discardableResult
    func askSpace(_ space: EnterpriseSummary.Space, text: String) async -> Bool {
        if !space.joined {
            if let error = await enterprise.joinSpace(spaceID: space.id).error {
                toast(title: "couldn't join #\(space.name)", detail: error, kind: .warning,
                      undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                return false
            }
        }
        switch await enterprise.ask(spaceID: space.id, text: text) {
        case .success:
            return true
        case .failure(let error):
            toast(title: "couldn't reach #\(space.name)", detail: error.message, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return false
        }
    }

    /// Open a space from the notch: the chat comes up and its count clears.
    func readSpace(_ space: EnterpriseSummary.Space) {
        Task { await enterprise.markRead(spaceID: space.id) }
        openSpace(space.id)
    }

    /// The admin's welcome note, once per organization, the first time this Mac sees it linked.
    private func showOrgWelcome(_ welcome: (org: String, text: String)) {
        let name = enterprise.org?.name ?? "your organization"
        toast(title: "welcome to \(name)", detail: welcome.text, kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: "see spaces", onEdit: { [weak self] in self?.openDashboard(.spaces) }, runID: nil)
        enterprise.welcomeShown()
    }

    /// A replay of a colleague's skill ended here: the organization's count goes up.
    func noteSharedReplay(_ skill: Skill) {
        enterprise.recordSkillRun(skill)
    }

    /// The organization this Mac could join with one click, if any: a managed join code, or a
    /// colleague's Mac inviting over the network.
    var teamInvitation: (orgName: String, code: String, via: String)? {
        let code = store.settings.pendingJoinCode
        if !code.isEmpty {
            return (store.settings.pendingJoinOrgName.isEmpty ? "your organization" : store.settings.pendingJoinOrgName, code, "set up by your IT team")
        }
        if let invite = nearby.invites.first { return (invite.orgName, invite.code, "\(invite.device), on this network") }
        return nil
    }

    /// Takes an invitation: makes sure there's a work account, keeps the code for the login, and
    /// opens Team so the join finishes the moment the sync login exists.
    func acceptTeamInvitation(orgName: String, code: String, openTeam: Bool = true) {
        let cleaned = ManagedConfig.cleanCode(code)
        guard !cleaned.isEmpty else { return }
        if let work = store.accounts.first(where: { $0.kind == .work }) {
            store.switchAccount(work.id)
        } else {
            store.createAccount(name: "\(store.activeAccount.firstName) at \(orgName)", email: "", kind: .work)
        }
        store.settings.pendingJoinCode = cleaned
        store.settings.pendingJoinOrgName = orgName
        store.saveNow()
        if openTeam { openDashboard(.team) }
    }

    /// A typed question stays silent until the next spoken one.
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

    /// This Mac is now paired with the sync login: everything that talks to Convex can start.
    func pairDevice(token: String, userID: String, email: String) {
        let changed = KeyStore.deviceToken != token
        KeyStore.pairDevice(token: token, userID: userID, email: email)
        keysVersion += 1
        guard changed else { return }
        refreshSync()
        toast(title: "this Mac is paired", detail: email.isEmpty ? "synced with your login" : "synced as \(email)",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    /// The sync login signed out: retire this Mac's token on the backend, then forget it here.
    func unpairDevice() {
        guard let token = KeyStore.deviceToken else { return }
        let base = store.settings.convexSiteURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        KeyStore.unpairDevice()
        keysVersion += 1
        convex.forgetPairing()
        guard !base.isEmpty, let url = URL(string: base + "/api/unpair") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        Task.detached { _ = try? await URLSession.shared.data(for: request) }
    }

    func signIn(accountID: String) {
        store.switchAccount(accountID)
        signedOut = false
        store.saveNow()
        // The account in front should be current with its other Macs.
        refreshSync()
    }

    func createAccountAndSignIn(name: String, email: String, kind: AccountKind) {
        store.createAccount(name: name, email: email, kind: kind)
        signedOut = false
        store.saveNow()
    }

    // MARK: - Helpers

    private func inferTopic(_ text: String) -> String {
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
