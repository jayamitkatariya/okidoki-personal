import Foundation
import AppKit
import Combine

@MainActor
public final class OkidokiStore: ObservableObject {
    @Published public var settings: AppSettings
    @Published public var accounts: [Account]
    @Published public var currentAccountID: String
    @Published public var threads: [ChatThread]
    @Published public var memories: [MemoryItem]
    @Published public var runs: [AgentRun]
    @Published public var skills: [Skill]
    @Published public var routines: [Routine]
    @Published public var connectors: [Connector]
    @Published public var toolInstalled: [String: Bool] = [:]
    @Published public private(set) var lastSavedAt: Date?
    @Published public private(set) var loadError: String?

    private var saveWork: DispatchWorkItem?
    private var isWriting = false
    private var cancellables = Set<AnyCancellable>()
    private let stateURL: URL

    public init(seedDemo: Bool = false) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Okidoki", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        self.stateURL = support.appendingPathComponent("state.json")

        var loaded: AppState?
        if !seedDemo, let data = try? Data(contentsOf: stateURL) {
            do { loaded = try JSONDecoder().decode(AppState.self, from: data) }
            catch { loadError = "couldn't read saved state: \(error.localizedDescription)" }
        }

        let state = loaded ?? AppState()
        var accounts = state.accounts
        var current = state.currentAccountID
        if accounts.isEmpty {
            let name = NSFullUserName().split(separator: " ").first.map(String.init) ?? "you"
            let account = Account(name: name.isEmpty ? "you" : name, email: "", kind: .personal)
            accounts = [account]
            current = account.id
        }
        if current.isEmpty || !accounts.contains(where: { $0.id == current }) {
            current = accounts[0].id
        }

        self.accounts = accounts
        self.currentAccountID = current
        self.settings = state.settings
        self.threads = state.threads
        self.memories = state.memories
        self.runs = state.runs
        self.skills = state.skills
        self.routines = state.routines
        self.connectors = Self.mergeConnectors(state.connectors)

        if seedDemo { seedDemoData() }

        objectWillChange
            .sink { [weak self] _ in
                guard let self, !self.isWriting else { return }
                self.scheduleSave()
            }
            .store(in: &cancellables)
    }

    // MARK: - Derived

    public var activeAccount: Account {
        accounts.first { $0.id == currentAccountID } ?? accounts[0]
    }

    public var activeThreads: [ChatThread] {
        threads.filter { $0.accountID == currentAccountID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    public var activeRuns: [AgentRun] {
        runs.filter { $0.accountID == currentAccountID }
    }

    public var liveRuns: [AgentRun] {
        activeRuns.filter(\.isActive).sorted { $0.createdAt > $1.createdAt }
    }

    public var waitingRuns: [AgentRun] {
        activeRuns.filter { $0.status == .waiting }.sorted { $0.createdAt > $1.createdAt }
    }

    public var activeRoutines: [Routine] {
        routines.filter { $0.accountID == currentAccountID }
    }

    public var activeSkills: [Skill] {
        skills.filter { $0.accountID == currentAccountID }
    }

    public func memories(_ section: MemorySection) -> [MemoryItem] {
        memories.filter { $0.section == section }.sorted { $0.updatedAt > $1.updatedAt }
    }

    public var savings: Double {
        ToolCatalog.tools.reduce(0) { partial, tool in
            toolInstalled[tool.id] == true ? partial + (ToolCatalog.paidAlternatives[tool.id] ?? 0) : partial
        }
    }

    public func run(_ id: String) -> AgentRun? { runs.first { $0.id == id } }
    public func thread(_ id: String) -> ChatThread? { threads.first { $0.id == id } }
    public func skill(_ id: String) -> Skill? { skills.first { $0.id == id } }
    public func routine(_ id: String) -> Routine? { routines.first { $0.id == id } }

    // MARK: - Accounts

    @discardableResult
    public func createAccount(name: String, email: String, kind: AccountKind, colorHex: String? = nil) -> Account {
        let palette = ["1FB57A", "7A8CFF", "B8F26B", "C9A7FF"]
        let color = colorHex ?? palette[accounts.count % palette.count]
        let account = Account(name: name.isEmpty ? "you" : name, email: email, kind: kind, colorHex: color)
        accounts.append(account)
        currentAccountID = account.id
        return account
    }

    public func switchAccount(_ id: String) {
        guard accounts.contains(where: { $0.id == id }) else { return }
        currentAccountID = id
    }

    public func updateAccount(_ account: Account) {
        guard let index = accounts.firstIndex(where: { $0.id == account.id }) else { return }
        accounts[index] = account
    }

    public func deleteAccount(_ id: String) {
        guard accounts.count > 1 else { return }
        accounts.removeAll { $0.id == id }
        threads.removeAll { $0.accountID == id }
        runs.removeAll { $0.accountID == id }
        skills.removeAll { $0.accountID == id }
        routines.removeAll { $0.accountID == id }
        if currentAccountID == id { currentAccountID = accounts[0].id }
    }

    // MARK: - Threads

    @discardableResult
    public func createThread(title: String, app: String = "mac", topic: String = "") -> ChatThread {
        let thread = ChatThread(accountID: currentAccountID, title: title, app: app, topic: topic)
        threads.insert(thread, at: 0)
        return thread
    }

    public func threadForContext(app: String, topic: String = "") -> ChatThread {
        let candidates = threads.filter { $0.accountID == currentAccountID && !$0.archived }
        if let match = candidates.first(where: { $0.topic.lowercased() == topic.lowercased() && !topic.isEmpty }) {
            return match
        }
        if let recent = candidates.first(where: { $0.app == app && Date().timeIntervalSince($0.updatedAt) < 60 * 60 * 6 }) {
            return recent
        }
        return createThread(title: threadTitle(for: app, topic: topic), app: app, topic: topic)
    }

    public func appendMessage(threadID: String, role: MessageRole, text: String, runID: String? = nil) {
        guard let index = threads.firstIndex(where: { $0.id == threadID }) else { return }
        threads[index].messages.append(ChatMessage(role: role, text: text, runID: runID))
        threads[index].updatedAt = Date()
        if threads[index].title.isEmpty || threads[index].messages.count == 1 {
            threads[index].title = threadTitle(for: threads[index].app, topic: text)
        }
        // move to the top
        let thread = threads.remove(at: index)
        threads.insert(thread, at: 0)
    }

    public func archiveThread(_ id: String) {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return }
        threads[index].archived.toggle()
    }

    public func deleteThread(_ id: String) {
        threads.removeAll { $0.id == id }
    }

    private func threadTitle(for app: String, topic: String) -> String {
        let cleaned = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty { return String(cleaned.prefix(48)) }
        if app != "mac" && !app.isEmpty { return "in \(app)" }
        return "new thread"
    }

    // MARK: - Memory

    @discardableResult
    public func addMemory(_ text: String, section: MemorySection = .aboutYou, source: String = "you") -> MemoryItem? {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,;: "))
        guard cleaned.count > 2 else { return nil }
        let lower = cleaned.lowercased()
        if memories.contains(where: { $0.text.lowercased() == lower }) { return nil }
        let item = MemoryItem(section: section, text: cleaned, source: source)
        memories.insert(item, at: 0)
        return item
    }

    public func updateMemory(_ id: String, text: String) {
        guard let index = memories.firstIndex(where: { $0.id == id }) else { return }
        memories[index].text = text
        memories[index].updatedAt = Date()
    }

    public func deleteMemory(_ id: String) {
        memories.removeAll { $0.id == id }
    }

    public var memoryContext: String {
        let about = memories(.aboutYou).prefix(12).map(\.text)
        let now = memories(.rightNow).prefix(6).map(\.text)
        var lines: [String] = []
        if !about.isEmpty { lines.append("About them: " + about.joined(separator: "; ")) }
        if !now.isEmpty { lines.append("Right now: " + now.joined(separator: "; ")) }
        return lines.joined(separator: "\n")
    }

    // MARK: - Runs

    @discardableResult
    public func createRun(kind: RunKind, title: String, prompt: String, threadID: String? = nil,
                          preview: ActionPreview? = nil, steps: [RunStep] = [],
                          agent: CodingAgentID? = nil, workingDirectory: String? = nil,
                          status: RunStatus = .previewing, builtin: String? = nil,
                          pickedPath: String? = nil) -> AgentRun {
        let run = AgentRun(accountID: currentAccountID, kind: kind, title: title, prompt: prompt,
                           threadID: threadID, status: status, preview: preview, steps: steps,
                           agent: agent, workingDirectory: workingDirectory,
                           builtin: builtin, pickedPath: pickedPath)
        runs.insert(run, at: 0)
        return run
    }

    public func updateRun(_ id: String, _ mutate: (inout AgentRun) -> Void) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        mutate(&runs[index])
    }

    public func startRun(_ id: String) {
        updateRun(id) { run in
            run.status = .running
            run.startedAt = Date()
            for index in run.steps.indices where run.steps[index].status == .previewing {
                run.steps[index].status = index == 0 ? .running : .previewing
            }
        }
    }

    public func finishRun(_ id: String, status: RunStatus, summary: String, freedBytes: Int64? = nil) {
        updateRun(id) { run in
            run.status = status
            run.endedAt = Date()
            run.summary = summary
            if let freedBytes { run.freedBytes = freedBytes }
            for index in run.steps.indices {
                run.steps[index].status = status == .done ? .done : (status == .failed ? .failed : run.steps[index].status)
                if run.steps[index].startedAt == nil { run.steps[index].startedAt = run.startedAt }
                if run.steps[index].endedAt == nil { run.steps[index].endedAt = Date() }
            }
        }
    }

    public func cancelRun(_ id: String) {
        updateRun(id) { run in
            run.status = .cancelled
            run.endedAt = Date()
            run.summary = "stopped by you"
        }
    }

    // MARK: - Skills + routines

    @discardableResult
    public func createSkill(name: String, summary: String, steps: [SkillStep], source: String = "watch me") -> Skill {
        let skill = Skill(accountID: currentAccountID, name: name, summary: summary, steps: steps, source: source)
        skills.insert(skill, at: 0)
        return skill
    }

    public func deleteSkill(_ id: String) { skills.removeAll { $0.id == id } }
    public func incrementSkillRun(_ id: String, by count: Int = 1) {
        guard let index = skills.firstIndex(where: { $0.id == id }) else { return }
        skills[index].runCount += max(1, count)
    }
    public func updateSkill(_ id: String, name: String? = nil, summary: String? = nil) {
        guard let index = skills.firstIndex(where: { $0.id == id }) else { return }
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { skills[index].name = name }
        if let summary { skills[index].summary = summary }
    }

    @discardableResult
    public func createRoutine(name: String, prompt: String, cadence: RoutineCadence = .weekly,
                              weekday: Int = 6, hour: Int = 17, minute: Int = 0,
                              enabled: Bool = true) -> Routine {
        var routine = Routine(accountID: currentAccountID, name: name, prompt: prompt,
                              cadence: cadence, weekday: weekday, hour: hour, minute: minute,
                              enabled: enabled)
        routine.nextRunAt = routine.nextDate()
        routines.insert(routine, at: 0)
        return routine
    }

    public func updateRoutine(_ routine: Routine) {
        guard let index = routines.firstIndex(where: { $0.id == routine.id }) else { return }
        var updated = routine
        updated.nextRunAt = routine.nextDate(after: routine.lastRunAt ?? Date())
        routines[index] = updated
    }

    public func toggleRoutine(_ id: String) {
        guard let index = routines.firstIndex(where: { $0.id == id }) else { return }
        routines[index].enabled.toggle()
        routines[index].nextRunAt = routines[index].nextDate()
    }

    public func deleteRoutine(_ id: String) { routines.removeAll { $0.id == id } }

    public func markRoutineRun(_ id: String, at date: Date = Date()) {
        guard let index = routines.firstIndex(where: { $0.id == id }) else { return }
        routines[index].lastRunAt = date
        routines[index].nextRunAt = routines[index].nextDate(after: date)
    }

    // MARK: - Connectors

    public func setConnector(_ id: String, enabled: Bool? = nil, installed: Bool? = nil) {
        guard let index = connectors.firstIndex(where: { $0.id == id }) else { return }
        if let enabled { connectors[index].enabled = enabled }
        if let installed { connectors[index].installed = installed }
    }

    private static func mergeConnectors(_ existing: [Connector]) -> [Connector] {
        ToolCatalog.defaultConnectors.map { spec in
            if let saved = existing.first(where: { $0.id == spec.id }) {
                var merged = spec
                merged.enabled = saved.enabled
                merged.installed = saved.installed
                return merged
            }
            return spec
        }
    }

    // MARK: - Persistence

    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
    }

    public func saveNow() {
        saveWork?.cancel()
        let state = AppState(accounts: accounts, currentAccountID: currentAccountID,
                             settings: settings, threads: threads, memories: memories, runs: runs,
                             skills: skills, routines: routines, connectors: connectors)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        do {
            let data = try encoder.encode(state)
            try data.write(to: stateURL, options: .atomic)
            isWriting = true
            lastSavedAt = Date()
            isWriting = false
        } catch {
            loadError = "couldn't save: \(error.localizedDescription)"
        }
    }

    public func stateForSync() -> AppState {
        AppState(accounts: accounts, currentAccountID: currentAccountID, settings: settings,
                 threads: threads.filter { $0.accountID == currentAccountID },
                 memories: memories,
                 runs: runs.filter { $0.accountID == currentAccountID },
                 skills: skills.filter { $0.accountID == currentAccountID },
                 routines: routines.filter { $0.accountID == currentAccountID },
                 connectors: connectors)
    }

    // MARK: - Demo

    private func seedDemoData() {
        let jay = Account(name: "jay katariya", email: "jay@okidoki.app", kind: .personal, colorHex: "1FB57A",
                          createdAt: Date().addingTimeInterval(-86400 * 40))
        let work = Account(name: "jay at workro", email: "jay@workro.com", kind: .work, colorHex: "7A8CFF",
                           createdAt: Date().addingTimeInterval(-86400 * 20))
        accounts = [jay, work]
        currentAccountID = jay.id
        settings.onboardingComplete = true
        settings.tourComplete = true
        settings.defaultInput = .voice
        settings.appleCalendar = true
        settings.appleReminders = true
        settings.appleNotes = true
        settings.automationGranted = true
        settings.voiceID = "sarah"
        toolInstalled = ["ffmpeg": true, "pandoc": true, "mole": true]

        let now = Date()
        var figma = ChatThread(accountID: jay.id, title: "learning figma", app: "Figma", topic: "figma",
                           messages: [
                            ChatMessage(role: .user, text: "teach me auto layout", createdAt: now.addingTimeInterval(-7200)),
                            ChatMessage(role: .assistant, text: "last time you learned frames. auto layout is the next step: frames that arrange themselves. open Figma and select two cards.", createdAt: now.addingTimeInterval(-7150)),
                            ChatMessage(role: .user, text: "ok done", createdAt: now.addingTimeInterval(-7000)),
                           ], createdAt: now.addingTimeInterval(-7200), updatedAt: now.addingTimeInterval(-7000))
        var space = ChatThread(accountID: jay.id, title: "free up space", app: "Finder", topic: "space",
                           messages: [
                            ChatMessage(role: .user, text: "my mac is out of space", createdAt: now.addingTimeInterval(-3600)),
                            ChatMessage(role: .assistant, text: "you're at 94%. the biggest wins are xcode derived data and old installers. want me to clean them?", createdAt: now.addingTimeInterval(-3590)),
                           ], createdAt: now.addingTimeInterval(-3600), updatedAt: now.addingTimeInterval(-3590))
        figma.updatedAt = now.addingTimeInterval(-720)
        space.updatedAt = now.addingTimeInterval(-3500)
        threads = [figma, space]

        memories = [
            MemoryItem(section: .aboutYou, text: "I'm a student at Purdue, studying IBE", createdAt: now.addingTimeInterval(-86400 * 30)),
            MemoryItem(section: .aboutYou, text: "I use Figma and VS Code every day", createdAt: now.addingTimeInterval(-86400 * 20)),
            MemoryItem(section: .aboutYou, text: "keep answers short and concrete", source: "you", createdAt: now.addingTimeInterval(-86400 * 5)),
            MemoryItem(section: .rightNow, text: "building Okidoki, a Mac assistant", createdAt: now.addingTimeInterval(-3600 * 4)),
            MemoryItem(section: .rightNow, text: "redesigning the Workro onboarding", createdAt: now.addingTimeInterval(-86400)),
        ]

        var cleanup = AgentRun(accountID: jay.id, kind: .terminal, title: "free up 23 GB",
                               prompt: "my mac is out of space", threadID: space.id, status: .done,
                               preview: ActionPreview(summary: "clean caches and old installers with Mole",
                                                      risk: .medium,
                                                      steps: [PreviewStep("scan caches and old installers"),
                                                              PreviewStep("remove 4.2 GB of Xcode derived data"),
                                                              PreviewStep("empty trash")],
                                                      commands: ["mo clean"],
                                                      apps: ["Finder"], files: []),
                               summary: "freed 23 GB", createdAt: now.addingTimeInterval(-3600),
                               startedAt: now.addingTimeInterval(-3595), endedAt: now.addingTimeInterval(-3410),
                               freedBytes: 23_000_000_000)
        cleanup.steps = [RunStep(title: "scan caches", status: .done), RunStep(title: "remove derived data", status: .done), RunStep(title: "empty trash", status: .done)]

        var keynote = AgentRun(accountID: jay.id, kind: .background, title: "export keynote decks",
                               prompt: "export all my keynote decks to pdf", status: .running,
                               preview: ActionPreview(summary: "export 6 Keynote decks to one folder",
                                                      risk: .low,
                                                      steps: [PreviewStep("open each deck"), PreviewStep("export as PDF"), PreviewStep("put them in ~/Desktop/decks")],
                                                      commands: [],
                                                      apps: ["Keynote"], files: ["~/Desktop/decks/*.pdf"]),
                               summary: "", createdAt: now.addingTimeInterval(-180),
                               startedAt: now.addingTimeInterval(-175), endedAt: nil)
        keynote.steps = [RunStep(title: "open each deck", status: .done), RunStep(title: "export as PDF", status: .running), RunStep(title: "collect in one folder", status: .previewing)]

        let rename = AgentRun(accountID: jay.id, kind: .coding, title: "rename screenshots",
                              prompt: "build me a script that renames my screenshots by date", status: .waiting,
                              preview: ActionPreview(summary: "write a small Swift script and run it on ~/Desktop",
                                                     risk: .medium,
                                                     steps: [PreviewStep("create rename-screenshots.swift"), PreviewStep("dry-run on 128 files"), PreviewStep("rename in place")],
                                                     commands: ["claude -p 'build me a script…'"],
                                                     apps: ["Claude Code"], files: ["~/Desktop/rename-screenshots.swift"]),
                              agent: .claude, workingDirectory: "~/Desktop",
                              createdAt: now.addingTimeInterval(-95))

        let teach = AgentRun(accountID: jay.id, kind: .teach, title: "auto layout in figma",
                             prompt: "teach me auto layout in figma", threadID: figma.id, status: .done,
                             summary: "5 steps · you finished it", createdAt: now.addingTimeInterval(-7000),
                             startedAt: now.addingTimeInterval(-6990), endedAt: now.addingTimeInterval(-6800))

        runs = [keynote, rename, cleanup, teach]

        skills = [
            Skill(accountID: jay.id, name: "friday cleanup", summary: "empty downloads, screenshots and old installers",
                  steps: [SkillStep(text: "open Downloads", app: "Finder"), SkillStep(text: "select installers older than 30 days", app: "Finder"), SkillStep(text: "move to trash and empty")],
                  source: "watch me", runCount: 7),
            Skill(accountID: jay.id, name: "weekly backup", summary: "copy Desktop and Documents to the cloud",
                  steps: [SkillStep(text: "run rclone copy", app: "Terminal"), SkillStep(text: "check the log", app: "Terminal")],
                  source: "taught", runCount: 3),
        ]

        var friday = Routine(accountID: jay.id, name: "friday cleanup",
                             prompt: "every friday at 5, clean my downloads folder",
                             cadence: .weekly, weekday: 6, hour: 17, minute: 0)
        friday.lastRunAt = now.addingTimeInterval(-86400 * 7)
        friday.nextRunAt = friday.nextDate()
        var standup = Routine(accountID: jay.id, name: "monday brief",
                              prompt: "every monday at 9, summarise my week and today's calendar",
                              cadence: .weekly, weekday: 2, hour: 9, minute: 0)
        standup.nextRunAt = standup.nextDate()
        routines = [friday, standup]

        connectors = Self.mergeConnectors([
            Connector(id: "calendar", name: "Apple Calendar", kind: "apple", blurb: "", enabled: true, installed: true),
            Connector(id: "reminders", name: "Apple Reminders", kind: "apple", blurb: "", enabled: true, installed: true),
            Connector(id: "notes", name: "Apple Notes", kind: "apple", blurb: "", enabled: true, installed: true),
        ])
    }
}
