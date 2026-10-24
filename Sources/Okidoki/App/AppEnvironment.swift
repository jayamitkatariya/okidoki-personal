import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers
import OkidokiCore

enum DashboardSection: String, CaseIterable, Identifiable {
    case home, runs, history, memory, skills, toolbox, keys, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .home: return "home"
        case .runs: return "runs"
        case .history: return "history"
        case .memory: return "memory"
        case .skills: return "skills & routines"
        case .toolbox: return "toolbox"
        case .keys: return "keys"
        case .settings: return "settings"
        }
    }
    var shortTitle: String {
        switch self {
        case .skills: return "skills"
        default: return title
        }
    }
    var glyph: String {
        switch self {
        case .home: return "home"
        case .runs: return "runs"
        case .history: return "clock"
        case .memory: return "memory"
        case .skills: return "wand"
        case .toolbox: return "grid"
        case .keys: return "key"
        case .settings: return "gear"
        }
    }
    var subtitle: String {
        switch self {
        case .home: return "what's moving, and what needs you"
        case .runs: return "live work, action previews, plan vs actual"
        case .history: return "threads and past requests"
        case .memory: return "about you and right now — yours to edit"
        case .skills: return "things okidoki learned, and things that repeat"
        case .toolbox: return "free tools, coding agents, apple apps"
        case .keys: return "bring your own keys. kept in the keychain"
        case .settings: return "input, voice, permissions, notch, look"
        }
    }
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

    private(set) var summon: SummonController!
    private(set) var draw: DrawingController!
    private(set) var answerController: AnswerCardController!
    private(set) var teach: TeachController!
    private(set) var ghost: GhostCursorController!
    private(set) var watchHUD: WatchHUDController!
    private(set) var notch: NotchController!
    private(set) var driver: ComputerUseDriver!
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
    @Published var askPulse = 0
    @Published var shakePulse = 0
    @Published var inCall = false
    @Published var installedAgents: [CodingAgentID] = []
    @Published var keysVersion = 0
    /// Last connection result per MCP server id, for the Toolbox.
    @Published var mcpStatus: [String: MCPServerStatus] = [:]
    @Published var isBusy = false
    @Published var suspendSummonForTour = false
    @Published var lastError: String?

    private var summonAppName = "mac"
    private var summonBundleID = ""
    private var watchRunID: String?
    private var pendingStarts: [String: DispatchWorkItem] = [:]
    private var pendingToolInstalls: [String: String] = [:]
    /// Approved-later connector calls by run id: the brain's call JSON, handed back untouched when the run starts.
    private var pendingConnectorCalls: [String: String] = [:]
    private var syncWork: DispatchWorkItem?
    private var callTimer: Timer?
    private var nudgeTimer: Timer?
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
        self.ghost = GhostCursorController(environment: self)
        self.watchHUD = WatchHUDController(environment: self)
        self.driver = ComputerUseDriver(environment: self)
        self.simOverlay = SimOverlayController(environment: self)
        self.notch = NotchController(environment: self)

        shake.onShake = { [weak self] in self?.handleShake() }
        watch.onFinish = { [weak self] steps in self?.handleWatchFinished(steps) }

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

        store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.scheduleSync() }
            .store(in: &cancellables)
    }

    // MARK: - Lifecycle

    func start() {
        applyAppearance(store.settings.appearance)
        statusBar = StatusBarController(environment: self)
        dashboard = DashboardWindowController(environment: self)
        onboarding = OnboardingWindowController(environment: self)
        notch.install()
        glows.install()
        shake.start()
        sidecar.start()

        scheduler = RoutineScheduler(store: store)
        scheduler.onDue = { [weak self] routine in
            Task { @MainActor in self?.runRoutine(routine) }
        }
        scheduler.start()

        refreshInstalled()
        // Start MCP servers whenever the brain comes up, so the first request doesn't wait on a cold start.
        sidecar.$status
            .removeDuplicates()
            .filter(\.isReady)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshMCP() }
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
        } else if ProcessInfo.processInfo.environment["OKIDOKI_OPEN_ONBOARDING"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.openOnboarding() }
        } else if !store.settings.onboardingComplete {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.openOnboarding() }
        }

        if store.settings.syncEnabled {
            Task {
                if let remote = await convex.pull(store: store), remote.accounts.count > 0,
                   let account = remote.accounts.first(where: { $0.id == store.currentAccountID }) {
                    // Only restore when there is nothing local worth keeping.
                    if store.threads.isEmpty && store.memories.isEmpty {
                        store.threads = remote.threads
                        store.memories = remote.memories
                        store.runs = remote.runs
                        store.skills = remote.skills
                        store.routines = remote.routines
                        store.accounts = remote.accounts
                        store.saveNow()
                        toast(title: "restored from convex", detail: "\(account.name)'s threads and memory are here",
                              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
                    }
                }
            }
        }
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
        if driver.isActive { driver.cancel(reason: "you shook — control is yours"); return }
        if simOverlay.isVisible { simOverlay.dismiss(); return }
        if watch.isRecording { stopWatching(); return }
        if ghost.model.visible { ghost.cancel(); return }
        if drawActive { draw.dismissAll(); dismissSummon(); return }
        if teach.model.isActive { teach.stop(completed: false); return }
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
        if front?.bundleIdentifier != Bundle.main.bundleIdentifier {
            summonAppName = front?.localizedName ?? "mac"
            summonBundleID = front?.bundleIdentifier ?? ""
        } else {
            summonAppName = "mac"
            summonBundleID = ""
        }
        answerController.close(restoreApp: false)
        summon.start()
        notch.noteListening(store.settings.defaultInput == .voice)
    }

    func dismissSummon() {
        draw.dismissAll()
        summon.dismiss()
        answerController.close()
        ghost.cancel()
        if teach.model.isActive { teach.stop(completed: false) }
        notch.noteListening(false)
        notch.collapse()
    }

    func submitSummon(text: String, screenshot: Data?, selection: CGRect?, attachmentName: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || screenshot != nil else { return }
        let appName = summonAppName
        let bundleID = summonBundleID
        Task {
            await handleRequest(text: text, appName: appName, bundleID: bundleID, threadID: nil,
                                screenshot: screenshot, selection: selection,
                                attachmentName: attachmentName, documentText: "", source: "summon")
            summon.hideInput()
        }
    }

    func followUp(card: AnswerCardModel, text: String) {
        let threadID = card.threadID
        let runID = card.runID
        answerController.close(restoreApp: false)
        if text.lowercased().contains("do it"), let runID,
           store.run(runID)?.status == .waiting {
            approveRun(runID)
            return
        }
        Task {
            await handleRequest(text: text, appName: "mac", bundleID: "", threadID: threadID,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "followup")
        }
    }

    // MARK: - Request pipeline

    func askFromDashboard(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            await handleRequest(text: trimmed, appName: "mac", bundleID: "", threadID: nil,
                                screenshot: nil, selection: nil, attachmentName: "",
                                documentText: "", source: "dashboard")
        }
    }

    func requestAsk() {
        askPulse += 1
        if !dashboardOpen { openDashboard(.home) }
    }

    func continueThread(_ threadID: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
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
        speak("Let's walk through \(skill.name).")
    }

    private func handleRequest(text: String, appName: String, bundleID: String, threadID: String?,
                               screenshot: Data?, selection: CGRect?, attachmentName: String,
                               documentText: String, source: String) async {
        isBusy = true
        defer { isBusy = false }
        var document = documentText
        var docName = attachmentName
        let lower = text.lowercased()
        if document.isEmpty, (lower.contains("pdf") || lower.contains("summar")) {
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
            thread = store.threadForContext(app: appName, topic: inferTopic(text))
        }

        store.appendMessage(threadID: thread.id, role: .user, text: text.isEmpty ? "look at this" : text)
        let clipboard = NSPasteboard.general.string(forType: .string) ?? ""
        let request = BrainRequest(text: text, appName: appName, bundleID: bundleID,
                                   threadID: thread.id, screenshotPNG: screenshot,
                                   selection: selection, source: source,
                                   attachmentName: docName, documentText: document,
                                   clipboardText: clipboard)
        var events: [BrainNativeEvent] = []
        if store.settings.appleCalendar,
           lower.contains("calendar") || lower.contains("meeting") || lower.contains("schedule") || lower.contains("what's next") {
            if let today = try? await AppleBridge.shared.eventsToday() {
                let formatter = ISO8601DateFormatter()
                events = today.prefix(10).map { BrainNativeEvent(title: $0.title, start: formatter.string(from: $0.start)) }
            }
        }
        let history = (store.thread(thread.id)?.messages ?? []).map { BrainMessage(role: $0.role.rawValue, text: $0.text) }
        let memory = store.memories.map { "\($0.section.label): \($0.text)" }
        let installed = ToolCatalog.tools.filter { store.toolInstalled[$0.id] == true }.map(\.id)
        var result: BrainThinkEnvelope?
        if sidecar.status.isReady {
            result = await BrainClient.shared.think(text: text, request: request, history: history,
                                                    memory: memory, events: events,
                                                    settings: store.settings, account: store.activeAccount,
                                                    installedTools: installed,
                                                    frontWindow: appName,
                                                    connectors: connectorsPayload())
        }
        if let decision = result?.decision {
            await handleDecision(decision, request: request, threadID: thread.id, source: source)
        } else {
            let decision = await LocalBrain.decide(request, store: store)
            await handleDecision(decision, request: request, threadID: thread.id, source: source)
        }
    }

    private func handleDecision(_ decision: BrainDecision, request: BrainRequest, threadID: String, source: String) async {
        for fact in decision.memory where !fact.isEmpty {
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
            let plan = decision.teachPlan.isEmpty
                ? decision.teachSteps.map { TeachPlanStep(say: $0) }
                : decision.teachPlan
            teach.start(topic: topic, plan: plan, runID: run.id, threadID: threadID)
            toast(title: "teaching · \(topic)", detail: "\(plan.count) steps · i'll wait for you",
                  kind: .info, undoLabel: "stop", onUndo: { [weak self] in self?.teach.stop(completed: false) },
                  editLabel: nil, onEdit: nil, runID: run.id)
            speak(decision.speak.isEmpty ? "Let's start." : decision.speak)

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

    private func present(_ card: AnswerCardModel, source: String) {
        guard source != "routine" else { return }
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
        answerController.show(card, near: cursor)
    }

    private func makeAnswerCard(decision: BrainDecision, request: BrainRequest,
                                threadID: String, run: AgentRun) -> AnswerCardModel {
        var actions: [CardAction] = []
        if decision.kind == .answer, decision.clarification != nil {
            if decision.actions.contains(where: { $0.contains("show") }) || decision.actions.isEmpty {
                actions.append(CardAction(title: "show me", kind: .secondary, glyph: "wand") { [weak self] in
                    self?.answerController.close(restoreApp: false)
                    self?.startTeach(topic: request.text, runID: nil, threadID: threadID)
                })
            }
            if decision.actions.contains(where: { $0.contains("do") }) {
                actions.append(CardAction(title: "do it", kind: .primary, glyph: "bolt") { [weak self] in
                    self?.doIt(request: request, threadID: threadID)
                })
            }
        }
        if decision.kind == .quickAction, decision.actions.contains("undo") {
            // Undo lives in the notch toast; the card explains it.
        }
        if let picked = decision.pickFile, decision.commands.isEmpty {
            actions.append(CardAction(title: "choose file", kind: .primary, glyph: "folder") { [weak self] in
                self?.answerController.close(restoreApp: false)
                Task { await self?.repreparePickFile(decision: decision, request: request, threadID: threadID) }
            })
        }
        if decision.answer.lowercased().contains("add one in keys") || decision.answer.lowercased().contains("add a key") {
            actions.append(CardAction(title: "open keys", kind: .secondary, glyph: "key") { [weak self] in
                self?.openDashboard(.keys)
            })
        }
        let card = AnswerCardModel(title: decision.title, text: decision.answer,
                                   actions: Array(actions.prefix(3)),
                                   threadTitle: store.thread(threadID)?.title,
                                   runID: run.id, threadID: threadID)
        return card
    }

    private func doIt(request: BrainRequest, threadID: String) {
        // If there is a waiting run for this thread, run it. Otherwise ask the model once more.
        if let run = store.activeRuns.first(where: { $0.threadID == threadID && $0.status == .waiting }) {
            approveRun(run.id)
            return
        }
        Task {
            await handleRequest(text: (request.text.isEmpty ? "do it" : request.text) + "\n\ndo it — take the smallest concrete action.",
                                appName: request.appName, bundleID: request.bundleID, threadID: threadID,
                                screenshot: request.screenshotPNG, selection: request.selection,
                                attachmentName: request.attachmentName, documentText: request.documentText,
                                source: "followup")
        }
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
                let date = action.date.flatMap { ISO8601DateFormatter().date(from: $0) }
                let id = try await AppleBridge.shared.addReminder(title: action.title, due: date)
                undo = { Task { try? await AppleBridge.shared.deleteReminder(id: id) } }
                if toastDetail.isEmpty {
                    toastDetail = date.map { "for \(relativeTime($0))" } ?? "no date"
                }
            case "note":
                let id = try await AppleBridge.shared.addNote(title: action.title, body: action.body)
                undo = { Task { try? await AppleBridge.shared.deleteNote(id: id) } }
                if toastDetail.isEmpty { toastDetail = "saved in notes" }
            case "event":
                let start = action.date.flatMap { ISO8601DateFormatter().date(from: $0) } ?? Date().addingTimeInterval(3600)
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
        if let pick = decision.pickFile, decision.commands.contains(where: { $0.contains("{{") }) {
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

        var workingDirectory = store.settings.lastWorkingDirectory
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
        if let blocked = SafetyPolicy.blocked(commands: filled, settings: store.settings) {
            let card = AnswerCardModel(title: "i won't run that",
                                       text: blocked,
                                       threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }

        let risk = decision.risk == .high ? RiskLevel.high : (decision.risk == .medium ? .medium : CommandRisk.classify(filled.joined(separator: "\n")))
        let runKind = RunKind(rawValue: decision.kind.rawValue) ?? .terminal
        let steps = (decision.previewSteps.isEmpty ? defaultSteps(kind: runKind) : decision.previewSteps).map { RunStep(title: $0) }
        let files = decision.files + [file?.path, folder?.path].compactMap { $0 }
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? decision.title : decision.previewSummary,
                                    risk: risk, steps: steps.map { PreviewStep($0.title) },
                                    commands: filled, apps: decision.apps,
                                    files: files.isEmpty ? (workingDirectory.isEmpty ? [] : [workingDirectory]) : files)
        let run = store.createRun(kind: runKind, title: decision.title, prompt: request.text,
                                  threadID: threadID, preview: preview,
                                  steps: steps, agent: decision.kind == .coding ? store.settings.selectedAgent : nil,
                                  workingDirectory: workingDirectory.isEmpty ? nil : workingDirectory,
                                  status: .waiting, builtin: decision.builtin,
                                  pickedPath: folder?.path ?? file?.path)

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
            text += "\n\ncommands are in the preview — one click away."
        }
        if decision.kind == .coding {
            let agent = store.settings.selectedAgent
            if ShellRunner.which(agent.binary) == nil {
                text = "\(agent.displayName) isn't installed yet. install it, or pick another agent in toolbox.\n\n\(agent.installHint)"
                actions = [CardAction(title: "open toolbox", kind: .secondary, glyph: "grid") { [weak self] in
                    self?.openDashboard(.toolbox)
                }]
            }
        }
        let card = AnswerCardModel(title: decision.title, text: text, actions: actions,
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "action preview · \(risk.label) risk"
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
        guard store.settings.screenBorrowing else {
            let card = AnswerCardModel(title: "screen borrowing is off",
                                       text: "turn it on in settings and i'll take over for ten seconds — with an action preview first.",
                                       actions: [CardAction(title: "open settings", kind: .secondary) { [weak self] in
                                           self?.openDashboard(.settings)
                                       }], threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }
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
        let card = AnswerCardModel(title: "borrow your screen?",
                                   text: decision.answer.isEmpty ? "i'll find “\(target)”, move a ghost cursor, click once, and give control right back. moving your mouse cancels instantly." : decision.answer,
                                   actions: [
                                    CardAction(title: "allow once", kind: .primary, glyph: "hand") { [weak self] in
                                        self?.approveRun(run.id)
                                    },
                                    CardAction(title: "not now", kind: .ghost) { [weak self] in
                                        self?.denyRun(run.id)
                                    }
                                   ],
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "action preview · you can take back control anytime"
        present(card, source: source)
        speak("Can I take over for ten seconds?")
    }

    // MARK: - Computer use (end-to-end driving)

    private func prepareComputerUse(decision: BrainDecision, request: BrainRequest,
                                    threadID: String, source: String) async {
        guard store.settings.screenBorrowing else {
            let card = AnswerCardModel(title: "screen control is off",
                                       text: "turn on screen borrowing in settings and i'll drive apps end to end — one approval, live moves, stop anytime.",
                                       actions: [CardAction(title: "open settings", kind: .secondary) { [weak self] in
                                           self?.openDashboard(.settings)
                                       }], threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }
        guard EventActuator.canPost else {
            let card = AnswerCardModel(title: "i need accessibility",
                                       text: ComputerUseError.accessibility.localizedDescription,
                                       actions: [CardAction(title: "open settings", kind: .primary) {
                                           if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                                               NSWorkspace.shared.open(url)
                                           }
                                       }], threadTitle: store.thread(threadID)?.title, threadID: threadID)
            present(card, source: source)
            return
        }
        let goal = request.text.isEmpty ? decision.title : request.text
        let apps = decision.apps
        let preview = ActionPreview(summary: decision.previewSummary.isEmpty ? "drive it end to end" : decision.previewSummary,
                                     risk: .medium,
                                     steps: [PreviewStep("open \(apps.first ?? "the app")"),
                                             PreviewStep("look at the screen, click and type"),
                                             PreviewStep("finish and hand control back")],
                                     commands: [],
                                     apps: apps.isEmpty ? ["your apps"] : apps,
                                     files: [])
        let run = store.createRun(kind: .computerUse, title: decision.title, prompt: goal,
                                  threadID: threadID, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "computer-use")
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "i can drive this end to end. \(decision.answer.isEmpty ? "" : decision.answer) approve once and i'll take over — every move narrated, esc or a mouse move stops me.",
                            runID: run.id)
        let detail = apps.isEmpty ? "i'll pick the app from your goal" : "in \(apps.joined(separator: ", "))"
        let card = AnswerCardModel(title: decision.title,
                                   text: (decision.answer.isEmpty
                                          ? "i'll open the app, look at the screen, and do the whole thing — clicking, typing, the lot."
                                          : decision.answer)
                                       + "\n\nyou'll see a live pill with every step. **esc or moving your mouse stops me instantly.**",
                                   actions: [
                                       CardAction(title: "go ahead", kind: .primary, glyph: "bolt") { [weak self] in
                                           self?.approveRun(run.id)
                                       },
                                       CardAction(title: "not now", kind: .ghost) { [weak self] in
                                           self?.denyRun(run.id)
                                       },
                                   ],
                                   threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
        card.footnote = "computer use · \(detail) · risk medium"
        present(card, source: source)
        speak(decision.speak.isEmpty ? "Want me to drive?" : decision.speak)
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
        guard store.settings.okidokiEnabled || run.kind != .watch else { return }
        if run.kind == .coding, ShellRunner.which(store.settings.selectedAgent.binary) == nil {
            toast(title: "agent not installed", detail: store.settings.selectedAgent.installHint,
                  kind: .warning, undoLabel: nil, onUndo: nil, editLabel: "toolbox", onEdit: { [weak self] in
                      self?.openDashboard(.toolbox)
                  }, runID: id)
            return
        }
        answerController.close(restoreApp: false)
        store.startRun(id)
        confirmOK()
        let risk = store.run(id)?.preview?.risk ?? .low
        if risk == .low, let updated = store.run(id) {
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.store.run(id)?.status == .running else { return }
                self.execute(updated)
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
        if let command = run.preview?.commands.first {
            let prefix = command.split(separator: " ").prefix(2).joined(separator: " ")
            if !prefix.isEmpty, !store.settings.alwaysAllow.contains(prefix) {
                store.settings.alwaysAllow.append(prefix)
            }
        }
        approveRun(id)
        toast(title: "always allowed", detail: "i won't ask for this one again", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: "settings", onEdit: { [weak self] in
                  self?.openDashboard(.settings)
              }, runID: id)
    }

    func denyRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        store.cancelRun(id)
        toast(title: "not now", detail: "nothing changed", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
    }

    func pauseRun(_ id: String) {
        guard let run = store.run(id) else { return }
        if run.status == .paused {
            store.updateRun(id) { $0.status = .running }
            ShellRunner.shared.resume(id: id)
            BrainClient.shared.resume(runID: id)
            return
        }
        if pendingStarts[id] != nil {
            pendingStarts[id]?.cancel()
            pendingStarts[id] = nil
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
        ShellRunner.shared.cancel(id: id)
        BrainClient.shared.stop(runID: id)
        if ghost.model.visible, store.run(id)?.kind == .borrow { ghost.cancel() }
        if driver.isActive, store.run(id)?.kind == .computerUse { driver.cancel(reason: "you stopped me"); return }
        if teach.model.isActive, store.run(id)?.kind == .teach { teach.stop(completed: false); return }
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
        guard store.settings.okidokiEnabled else { return }
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
            let target = run.pickedPath ?? run.prompt
            ghost.begin(target: target, appName: run.preview?.apps.first ?? "app", runID: run.id)
        case .computerUse:
            driver.begin(run: run)
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

    private func executeShell(_ run: AgentRun) async {
        if run.builtin != nil || !sidecar.status.isReady {
            await executeShellLocal(run)
            return
        }
        let commands = run.preview?.commands ?? []
        guard !commands.isEmpty else {
            store.finishRun(run.id, status: .done, summary: "nothing to run")
            return
        }
        store.updateRun(run.id) { current in
            current.output += "\n$ " + commands.joined(separator: "\n$ ") + "\n\n"
        }
        let result = await BrainClient.shared.execute(
            runID: run.id, kind: run.kind, commands: commands, agent: nil,
            prompt: run.prompt, workingDirectory: run.workingDirectory,
            extraArgs: "", onEvent: { [weak self] event in
                guard let self, let current = self.store.run(run.id), current.status != .cancelled else { return }
                switch event {
                case .output(let text):
                    self.store.updateRun(run.id) { run in
                        run.output += text
                        if run.output.count > 90_000 { run.output = String(run.output.suffix(80_000)) }
                    }
                case .step(let index, let status, _):
                    self.store.updateRun(run.id) { run in
                        if run.steps.indices.contains(index) {
                            run.steps[index].status = status == "done" ? .done : (status == "failed" ? .failed : .running)
                            if run.steps[index].startedAt == nil { run.steps[index].startedAt = Date() }
                        }
                    }
                case .error(let message):
                    self.store.updateRun(run.id) { $0.summary = message }
                default:
                    break
                }
            })
        guard let result else {
            await self.executeShellLocal(run)
            return
        }
        if result.success {
            let summary = result.summary.isEmpty ? "done — \(run.title)" : result.summary
            self.store.finishRun(run.id, status: .done, summary: summary, freedBytes: result.freedBytes)
            if let tool = self.pendingToolInstalls[run.id] {
                self.store.toolInstalled[tool] = true
                self.pendingToolInstalls[run.id] = nil
                self.refreshInstalled()
            }
            self.toast(title: result.freedBytes != nil ? "freed \(Bytes.human(result.freedBytes!))" : "done",
                       detail: summary, kind: .success, undoLabel: nil, onUndo: nil,
                       editLabel: "details", onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) },
                       runID: run.id)
            self.speak(summary)
        } else {
            self.store.finishRun(run.id, status: .failed, summary: result.summary)
            self.toast(title: "that didn't work", detail: String(result.summary.prefix(140)), kind: .warning,
                       undoLabel: nil, onUndo: nil, editLabel: "open run",
                       onEdit: { [weak self] in self?.openDashboard(.runs, runID: run.id) }, runID: run.id)
        }
        self.store.saveNow()
    }

    private func executeShellLocal(_ run: AgentRun) async {
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
            return
        }

        let commands = run.preview?.commands ?? []
        guard !commands.isEmpty else {
            store.finishRun(run.id, status: .done, summary: "nothing to run")
            return
        }
        var allOutput = ""
        var exitCode: Int32 = 0
        for (index, command) in commands.enumerated() {
            if store.run(run.id)?.status == .cancelled { return }
            while store.run(run.id)?.status == .paused {
                try? await Task.sleep(nanoseconds: 400_000_000)
                if store.run(run.id)?.status == .cancelled { return }
            }
            store.updateRun(run.id) { current in
                if current.steps.indices.contains(index) {
                    current.steps[index].status = .running
                    current.steps[index].startedAt = Date()
                }
                current.output += "\n$ \(command)\n"
            }
            allOutput += "\n$ \(command)\n"
            let box = StringBox()
            exitCode = await withCheckedContinuation { continuation in
                ShellRunner.shared.stream(id: run.id, command: command,
                                          cwd: run.workingDirectory,
                                          onOutput: { text in
                                              box.append(text)
                                              Task { @MainActor in
                                                  self.store.updateRun(run.id) { current in
                                                      current.output += text
                                                      if current.output.count > 80_000 {
                                                          current.output = String(current.output.suffix(70_000))
                                                      }
                                                  }
                                              }
                                          }, completion: { code in
                                              continuation.resume(returning: code)
                                          })
            }
            allOutput = box.value
            store.updateRun(run.id) { current in
                if current.steps.indices.contains(index) {
                    current.steps[index].status = exitCode == 0 ? .done : .failed
                    current.steps[index].endedAt = Date()
                }
            }
            if exitCode != 0 { break }
        }

        if exitCode == 0 {
            let freed = OutputInsights.freedBytes(in: allOutput)
            let summary = freed.map { "freed \(Bytes.human($0))" }
                ?? (run.title.lowercased().contains("export") ? "all done" : "done — \(run.title)")
            store.finishRun(run.id, status: .done, summary: summary, freedBytes: freed)
            if let tool = pendingToolInstalls[run.id] {
                store.toolInstalled[tool] = true
                pendingToolInstalls[run.id] = nil
                refreshInstalled()
            }
            toast(title: freed != nil ? "freed \(Bytes.human(freed!))" : "done",
                  detail: summary, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
            speak(summary)
        } else {
            let last = allOutput.split(separator: "\n").suffix(3).joined(separator: "\n")
            store.finishRun(run.id, status: .failed, summary: last.isEmpty ? "command failed" : String(last))
            toast(title: "that didn't work", detail: String(last.prefix(120)), kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "open run", onEdit: { [weak self] in
                      self?.openDashboard(.runs, runID: run.id)
                  }, runID: run.id)
        }
        store.saveNow()
    }

    private func executeCoding(_ run: AgentRun) async {
        guard sidecar.status.isReady else {
            await executeCodingLocal(run)
            return
        }
        let agent = store.settings.selectedAgent
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
        guard let result else {
            await self.executeCodingLocal(run)
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
        let agent = store.settings.selectedAgent
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

    func finishTeach(runID: String, topic: String, threadID: String?) {
        store.finishRun(runID, status: .done, summary: "walkthrough finished")
        if let threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: "walkthrough finished — nice work on \(topic).", runID: runID)
        }
        toast(title: "that's \(topic)", detail: "you did it. ask me again anytime.",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
        speak("That's \(topic). Nice work.")
        store.saveNow()
    }

    func cancelRun(_ id: String) {
        pendingStarts[id]?.cancel()
        pendingStarts[id] = nil
        ShellRunner.shared.cancel(id: id)
        store.cancelRun(id)
    }

    // MARK: - Watch + skills

    private func startWatching(prompt: String, threadID: String, decision: BrainDecision) {
        let run = store.createRun(kind: .watch, title: "watch me", prompt: prompt,
                                  threadID: threadID, status: .running)
        store.startRun(run.id)
        watchRunID = run.id
        watch.start()
        watchHUD.show()
        toast(title: "watching you", detail: "do it once. click stop or shake when you're done.",
              kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: run.id)
        speak(decision.speak.isEmpty ? "I'm watching. Do it once." : decision.speak)
    }

    func stopWatching() {
        guard watch.isRecording else { return }
        watch.stop()
        watchHUD.hide()
    }

    private func handleWatchFinished(_ steps: [WatchedStep]) {
        watchHUD.hide()
        let meaningful = steps.filter { $0.action != "start" && !$0.detail.isEmpty }
        guard !meaningful.isEmpty else {
            if let watchRunID { store.finishRun(watchRunID, status: .failed, summary: "nothing to learn") }
            toast(title: "i didn't catch that", detail: "try again — click through it once, slowly.", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let app = meaningful.first?.app ?? "mac"
        let skill = store.createSkill(name: "\(app.lowercased()) flow", summary: "\(meaningful.count) steps, learned \(relativeTime(Date()))",
                                      steps: meaningful.map(\.step), source: "watch me")
        if let watchRunID {
            store.finishRun(watchRunID, status: .done, summary: "saved as a skill: \(skill.name)")
            store.updateRun(watchRunID) { $0.prompt = skill.steps.map(\.text).joined(separator: " → ") }
        }
        watchRunID = nil
        var text = "here's what i learned:\n\n"
        for (index, step) in meaningful.enumerated() {
            text += "\(index + 1). \(step.detail)\n"
        }
        text += "\nsaved as “\(skill.name)”. replay it, schedule it, or turn it into a walkthrough."
        let card = AnswerCardModel(title: "got it.",
                                   text: text,
                                   actions: [
                                       CardAction(title: "open skills", kind: .primary, glyph: "wand") { [weak self] in
                                           self?.openDashboard(.skills)
                                       },
                                       CardAction(title: "schedule it", kind: .secondary, glyph: "clock") { [weak self] in
                                           self?.openDashboard(.skills)
                                       }
                                   ],
                                   threadTitle: nil, runID: watchRunID, threadID: nil)
        present(card, source: "summon")
        toast(title: "saved as a skill", detail: "\(meaningful.count) steps · \(skill.name)", kind: .success,
              undoLabel: nil, onUndo: nil, editLabel: "open", onEdit: { [weak self] in
                  self?.openDashboard(.skills)
              }, runID: nil)
        speak("Got it. Saved as a skill.")
        store.saveNow()
    }

    func replaySkill(_ skill: Skill) {
        let steps = skill.steps
        let preview = ActionPreview(summary: "replay “\(skill.name)” with a ghost cursor",
                                    risk: .medium,
                                    steps: steps.map { PreviewStep($0.text) },
                                    commands: [], apps: [steps.first?.app ?? "app"], files: [])
        let run = store.createRun(kind: .borrow, title: "replay · \(skill.name)", prompt: skill.name,
                                  preview: preview, steps: steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "skill", pickedPath: skill.id)
        store.incrementSkillRun(skill.id)
        toast(title: "ready to replay", detail: "approve the preview to run it", kind: .approval,
              undoLabel: nil, onUndo: nil, editLabel: "review", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: run.id)
              }, runID: run.id)
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

    func createRoutineFromText(_ text: String) {
        let lower = text.lowercased()
        let weekday = ["sunday": 1, "monday": 2, "tuesday": 3, "wednesday": 4, "thursday": 5, "friday": 6, "saturday": 7]
            .first(where: { lower.contains($0.key) })?.value ?? 6
        var hour = 17
        if let match = text.range(of: #"at\s+(\d{1,2})"#, options: .regularExpression) {
            let digits = text[match].filter(\.isNumber)
            if let value = Int(digits) {
                hour = value < 8 ? value + 12 : value
            }
        }
        let name = text.split(separator: ",").last.map { $0.trimmingCharacters(in: .whitespaces) } ?? "routine"
        let routine = store.createRoutine(name: String(name.prefix(40)), prompt: text,
                                          cadence: .weekly, weekday: weekday, hour: hour, minute: 0)
        toast(title: "routine saved", detail: routine.scheduleLabel, kind: .success,
              undoLabel: nil, onUndo: nil, editLabel: "edit", onEdit: { [weak self] in
                  self?.openDashboard(.skills)
              }, runID: nil)
    }

    // MARK: - Teaching helper

    func startTeach(topic: String, runID: String?, threadID: String?) {
        let steps = TeachLibrary.steps(for: topic)
        let run = runID ?? store.createRun(kind: .teach, title: topic, prompt: topic,
                                           threadID: threadID, status: .running).id
        if runID == nil { store.startRun(run) }
        teach.start(topic: topic, steps: steps, runID: run, threadID: threadID)
        answerController.close(restoreApp: false)
        summon.hideInput()
        speak("Let's learn \(topic).")
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

    // MARK: - Keys, tools, sync

    func hasKey(_ provider: String) -> Bool { Keychain.has(provider) }

    func saveKey(provider: String, value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            Keychain.delete(provider)
            toast(title: "key removed", detail: provider, kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        } else {
            Keychain.set(trimmed, for: provider)
            toast(title: "key saved", detail: "\(provider) · stored in the keychain", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
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
        Keychain.delete(provider)
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
        store.settings.mcpServers.filter(\.enabled).map { server in
            let secrets = mcpSecrets(server)
            return BrainMCPServerPayload(id: server.id, name: server.name, transport: server.transport.rawValue,
                                         command: server.command, args: server.args, url: server.url,
                                         env: secrets.env, headers: secrets.headers)
        }
    }

    func mcpSecrets(_ server: MCPServer) -> (env: [String: String], headers: [String: String]) {
        guard let raw = Keychain.get(server.keychainKey), let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ([:], [:]) }
        return (json["env"] as? [String: String] ?? [:], json["headers"] as? [String: String] ?? [:])
    }

    /// Adds or updates a server. `secrets` nil keeps what's in the Keychain; empty dictionaries remove it.
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
                Keychain.delete(server.keychainKey)
            } else if let data = try? JSONSerialization.data(withJSONObject: ["env": secrets.env, "headers": secrets.headers]),
                      let text = String(data: data, encoding: .utf8) {
                Keychain.set(text, for: server.keychainKey)
            }
        }
        store.saveNow()
        mcpStatus[server.id] = nil
        BrainClient.shared.forgetMCP(id: server.id)
        refreshMCP()
    }

    func deleteMCPServer(_ id: String) {
        store.settings.mcpServers.removeAll { $0.id == id }
        Keychain.delete("mcp.\(id)")
        mcpStatus[id] = nil
        BrainClient.shared.forgetMCP(id: id)
        store.saveNow()
    }

    /// Connects to every enabled server and records what it offers, or why it failed.
    func refreshMCP() {
        guard sidecar.status.isReady else { return }
        let servers = mcpServerPayloads()
        guard !servers.isEmpty else {
            mcpStatus = [:]
            return
        }
        Task { [weak self] in
            guard let statuses = await BrainClient.shared.mcpTools(servers: servers) else { return }
            self?.mcpStatus = Dictionary(uniqueKeysWithValues: statuses.map { ($0.id, $0) })
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
        present(card, source: source)
        store.saveNow()
        speak(decision.speak.isEmpty ? "Here's the plan. Want me to go ahead?" : decision.speak)
    }

    private func executeConnector(_ run: AgentRun) async {
        guard let callJSON = pendingConnectorCalls[run.id] else {
            store.finishRun(run.id, status: .failed, summary: "this was prepared before okidoki restarted. ask again and i'll set it up fresh.")
            return
        }
        guard sidecar.status.isReady else {
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
                                                           apifyToken: Keychain.get("apify"),
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
    }

    func installTool(_ tool: ToolSpec) {
        guard !(store.toolInstalled[tool.id] ?? false) else { return }
        let preview = ActionPreview(summary: "install \(tool.name) with homebrew",
                                    risk: .medium,
                                    steps: [PreviewStep("run \(tool.installCommand)"), PreviewStep("verify \(tool.command) is on your path")],
                                    commands: [tool.installCommand, tool.checkCommand],
                                    apps: ["Terminal"], files: [])
        let run = store.createRun(kind: .terminal, title: "install \(tool.name)", prompt: "install \(tool.name)",
                                  preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) },
                                  status: .waiting, builtin: "install", pickedPath: tool.id)
        pendingToolInstalls[run.id] = tool.id
        toast(title: "install \(tool.name)?", detail: "one homebrew command · approval first",
              kind: .approval, undoLabel: nil, onUndo: nil, editLabel: "preview", onEdit: { [weak self] in
                  self?.openDashboard(.runs, runID: run.id)
              }, runID: run.id)
    }

    func findTools(_ query: String) -> [ToolSpec] {
        ToolCatalog.findTools(for: query)
    }

    func refreshSync() {
        Task { await convex.push(store: store) }
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
                toast(title: "run copied", detail: "turn on convex sync to create a live share link",
                      kind: .info, undoLabel: nil, onUndo: nil, editLabel: "keys", onEdit: { [weak self] in
                          self?.openDashboard(.keys)
                      }, runID: id)
            }
        }
    }

    private func scheduleSync() {
        guard store.settings.syncEnabled else { return }
        syncWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            Task { await self.convex.push(store: self.store) }
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
        openDashboard(.home)
        toast(title: "you're in", detail: "shake your mouse anywhere. that's the only way in.",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    func resetOnboarding() {
        store.settings.onboardingComplete = false
        store.settings.tourComplete = false
        store.saveNow()
        openOnboarding()
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

    func tourSetReminder(_ title: String) async -> Bool {
        do {
            let date = LocalBrainDateHelper.date(in: title) ?? Date().addingTimeInterval(3600)
            _ = try await AppleBridge.shared.addReminder(title: title, due: date)
            toast(title: "reminder set", detail: "\(title) · \(relativeTime(date))", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return true
        } catch {
            return false
        }
    }

    func tourRunTool() async -> String {
        let command = ShellRunner.which("pandoc") != nil ? "pandoc --version | head -2" : "sw_vers"
        let result = await ShellRunner.shared.run(command: command)
        return result.output.isEmpty ? "tool ran with no output." : result.output
    }

    // MARK: - Dashboard + toast

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

    private func confirmOK() {
        guard store.settings.confirmOK else { return }
        if store.settings.voiceEnabled {
            speaker.speak("Okidoki.", voiceID: store.settings.voiceID, speed: store.settings.voiceSpeed)
        }
    }

    func speak(_ text: String) {
        guard store.settings.voiceEnabled else { return }
        speaker.speak(text, voiceID: store.settings.voiceID, speed: store.settings.voiceSpeed)
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
    func append(_ value: String) { lock.lock(); text += value; lock.unlock() }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

private enum LocalBrainDateHelper {
    static func date(in text: String) -> Date? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) else { return nil }
        return detector.matches(in: text, options: [], range: NSRange(text.startIndex..., in: text))
            .compactMap(\.date).first
    }
}
