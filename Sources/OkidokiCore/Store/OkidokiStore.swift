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
    /// The saved file had items this build couldn't read. They're kept in a copy beside it.
    @Published public private(set) var loadWarning: String?

    /// This Mac (`DeviceIdentity`). Runs and routines started here carry it.
    public let deviceID: String
    /// Items deleted here, id → when, until well after the delete has reached Convex.
    public private(set) var deletions: [String: Date]
    /// Per account, the Convex sync version this Mac last merged. Saved with the state.
    public var syncCursors: [String: Int]
    /// Items this build can't read, from the saved file or a pull. Pushed back as they are, never deleted.
    public private(set) var unreadable: [UnreadableItem]

    private var saveWork: DispatchWorkItem?
    private var isWriting = false
    private var cancellables = Set<AnyCancellable>()
    private let stateURL: URL

    /// How long a delete is remembered: long past any pull that could still bring the item back.
    static let deletionMemory: TimeInterval = 60 * 60 * 24 * 30

    public init(seedDemo: Bool = false, stateURL: URL? = nil, deviceID: String? = nil) {
        let support = stateURL?.deletingLastPathComponent() ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Okidoki", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        // The demo never touches the real state file; it would otherwise be saved over on first launch.
        self.stateURL = stateURL ?? support.appendingPathComponent(seedDemo ? "state-demo.json" : "state.json")

        var loaded: AppState?
        var unreadableAtLoad: [UnreadableItem] = []
        if !seedDemo, let data = try? Data(contentsOf: self.stateURL) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom { decoder in
                let value = try decoder.singleValueContainer()
                if let seconds = try? value.decode(Double.self) { return Date(timeIntervalSinceReferenceDate: seconds) }
                let text = try value.decode(String.self)
                let formatter = ISO8601DateFormatter()
                if let date = formatter.date(from: text) { return date }
                formatter.formatOptions.insert(.withFractionalSeconds)
                if let date = formatter.date(from: text) { return date }
                throw DecodingError.dataCorruptedError(in: value, debugDescription: "Invalid saved date")
            }
            do {
                loaded = try decoder.decode(AppState.self, from: data)
                if let dropped = loaded?.droppedItems, dropped > 0 {
                    // The next save would write the state without them; keep the file as it was.
                    let copy = self.stateURL.deletingPathExtension()
                        .appendingPathExtension("partial-\(Int(Date().timeIntervalSince1970)).json")
                    try? FileManager.default.copyItem(at: self.stateURL, to: copy)
                    if let loaded { unreadableAtLoad = Self.unreadableItems(in: data, besides: loaded) }
                    loadWarning = "\(dropped) saved item\(dropped == 1 ? "" : "s") couldn't be read by this version; the original file is kept as \(copy.lastPathComponent)"
                }
            } catch {
                loadError = "couldn't read saved state: \(error.localizedDescription)"
                // Keep the unreadable file: the first save would otherwise replace it with an empty state.
                let aside = self.stateURL.deletingPathExtension()
                    .appendingPathExtension("unreadable-\(Int(Date().timeIntervalSince1970)).json")
                try? FileManager.default.moveItem(at: self.stateURL, to: aside)
            }
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

        let device = deviceID ?? DeviceIdentity.current
        var memories = state.memories
        var runs = state.runs
        var routines = state.routines
        if loaded != nil, state.version < 2 {
            // Once, on the first launch of a build with per-account memory and multi-Mac sync.
            memories = Self.pruneModelNoise(memories)
            runs = runs.map { run in var run = run; if run.origin == nil { run.origin = device }; return run }
            routines = routines.map { routine in var routine = routine; if routine.origin == nil { routine.origin = device }; return routine }
        }
        // Memories saved before memory was per account belong to the account in front.
        memories = memories.map { item in
            var item = item
            if item.accountID.isEmpty { item.accountID = current }
            return item
        }

        self.deviceID = device
        self.accounts = accounts
        self.currentAccountID = current
        self.settings = state.settings
        self.threads = state.threads
        self.memories = memories
        // Only this Mac's own runs were cut off by its restart; another Mac's are still its business.
        self.runs = runs.map { $0.origin == device ? $0.recoveredAfterRestart() : $0 }
        self.skills = state.skills
        self.routines = routines
        self.connectors = Self.mergeConnectors(state.connectors)
        self.deletions = state.deletions
        self.syncCursors = state.syncCursors
        var unreadable = state.unreadable
        for item in unreadableAtLoad where !unreadable.contains(where: { $0.table == item.table && $0.id == item.id }) {
            unreadable.append(item)
        }
        self.unreadable = unreadable

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

    /// The memories of the account in front.
    public var activeMemories: [MemoryItem] {
        memories.filter { $0.accountID == currentAccountID }
    }

    public func memories(_ section: MemorySection) -> [MemoryItem] {
        activeMemories.filter { $0.section == section }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// "Right now" notes describe the moment; after two weeks without an edit they're no longer handed
    /// to the model or the memory index. They stay on the Memory page until the person removes them.
    public static let rightNowLifetime: TimeInterval = 60 * 60 * 24 * 14

    public func isCurrent(_ item: MemoryItem, now: Date = Date()) -> Bool {
        item.section != .rightNow || now.timeIntervalSince(item.updatedAt) < Self.rightNowLifetime
    }

    /// What the model is told it remembers about the account in front: current right-now notes first,
    /// then the newest about-you notes. The rest is found by meaning through the memory index.
    public func memoryLines(limit: Int = 24, now: Date = Date()) -> [String] {
        let current = memories(.rightNow).filter { isCurrent($0, now: now) }
        let about = memories(.aboutYou)
        return (current + about).prefix(limit).map { "\($0.section.label): \($0.text)" }
    }

    public func isFromThisMac(_ run: AgentRun) -> Bool { run.origin == deviceID }
    public func isFromThisMac(_ routine: Routine) -> Bool { routine.origin == deviceID }

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
        memories.removeAll { $0.accountID == id }
        unreadable.removeAll { $0.accountID == id }
        runs.removeAll { $0.accountID == id }
        skills.removeAll { $0.accountID == id }
        routines.removeAll { $0.accountID == id }
        syncCursors[id] = nil
        // Until Convex has forgotten it too, the sync login still lists it; don't adopt it straight back.
        rememberDeletion(id)
        if currentAccountID == id { currentAccountID = accounts[0].id }
    }

    /// An account this login owns that another Mac created, brought onto this Mac with the same id so
    /// its synced data can be pulled in. An account already here is left as it is.
    @discardableResult
    public func adoptAccount(_ account: Account) -> Bool {
        guard !account.id.isEmpty, !accounts.contains(where: { $0.id == account.id }), deletions[account.id] == nil else { return false }
        accounts.append(account)
        return true
    }

    // MARK: - Threads

    @discardableResult
    public func createThread(title: String, app: String = "mac", topic: String = "") -> ChatThread {
        let thread = ChatThread(accountID: currentAccountID, title: title, app: app, topic: topic)
        threads.insert(thread, at: 0)
        return thread
    }

    /// The thread a new request belongs to. A request continues the app's latest thread only when it
    /// is plausibly a follow-up: within a few minutes, or worded like one. Otherwise it starts fresh,
    /// so an unrelated question hours later doesn't drag an old conversation back into the model's context.
    public func threadForContext(app: String, topic: String = "", text: String = "", now: Date = Date()) -> ChatThread {
        let candidates = threads.filter { $0.accountID == currentAccountID && !$0.archived }
        if !topic.isEmpty,
           let match = candidates.first(where: { $0.topic.lowercased() == topic.lowercased() && now.timeIntervalSince($0.updatedAt) < 60 * 60 * 24 }) {
            return match
        }
        if let recent = candidates.first(where: { $0.app == app }) {
            let age = now.timeIntervalSince(recent.updatedAt)
            if age < 60 * 5 || (age < 60 * 60 * 2 && Self.looksLikeFollowUp(text)) {
                return recent
            }
        }
        return createThread(title: threadTitle(for: app, topic: topic), app: app, topic: topic)
    }

    /// Short replies and anaphora ("and then?", "do that", "yes", "what about the other one").
    public static func looksLikeFollowUp(_ text: String) -> Bool {
        let lower = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !lower.isEmpty else { return false }
        let words = lower.split(whereSeparator: { $0.isWhitespace || $0 == "," })
        if words.count <= 3 { return true }
        let openers = ["and ", "also ", "then ", "now ", "what about", "how about", "ok ", "okay ", "yes", "no ", "nope", "yeah",
                       "again", "retry", "try again", "undo", "that ", "those ", "it ", "them ", "the same", "same ", "more ",
                       "why", "instead", "actually", "wait"]
        if openers.contains(where: { lower.hasPrefix($0) }) { return true }
        return lower.contains(" that one") || lower.contains(" the other") || lower.contains(" it again")
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
        threads[index].updatedAt = Date()
    }

    public func deleteThread(_ id: String) {
        threads.removeAll { $0.id == id }
        rememberDeletion(id)
    }

    private func threadTitle(for app: String, topic: String) -> String {
        let cleaned = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty { return String(cleaned.prefix(48)) }
        if app != "mac" && !app.isEmpty { return "in \(app)" }
        return "new thread"
    }

    // MARK: - Memory

    /// Saves a memory for an account (the one in front unless named). The same text twice in one account is kept once.
    @discardableResult
    public func addMemory(_ text: String, section: MemorySection = .aboutYou, source: String = "you",
                          accountID: String? = nil) -> MemoryItem? {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,;: "))
        guard cleaned.count > 2 else { return nil }
        // What the model saves on its own has to be a lasting fact about the person, checked here, once.
        if Self.modelSources.contains(source), !BrainService.isDurableFact(cleaned) { return nil }
        let account = accountID ?? currentAccountID
        let lower = cleaned.lowercased()
        if memories.contains(where: { $0.accountID == account && $0.text.lowercased() == lower }) { return nil }
        let item = MemoryItem(accountID: account, section: section, text: cleaned, source: source)
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
        rememberDeletion(id)
    }

    /// Sources that mean the model wrote the memory itself. Anything the person typed, answered
    /// in onboarding or imported from another assistant is theirs to keep.
    private static let modelSources: Set<String> = ["said", "followup", "dashboard", "routine", "repair", "lesson"]

    /// Memories the model saved before `isDurableFact` existed — notes about the clipboard, a
    /// screenshot or its own limits — were fed back with every request and kept the model stuck on
    /// them. They are dropped once, when a save from before per-account memory is first loaded; new
    /// ones are checked before they're saved. The person's own notes are never touched.
    static func pruneModelNoise(_ memories: [MemoryItem]) -> [MemoryItem] {
        memories.filter { !modelSources.contains($0.source) || BrainService.isDurableFact($0.text) }
    }

    public var memoryContext: String {
        let about = memories(.aboutYou).prefix(12).map(\.text)
        let now = memories(.rightNow).filter { isCurrent($0) }.prefix(6).map(\.text)
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
        let now = Date()
        let run = AgentRun(accountID: currentAccountID, kind: kind, title: title, prompt: prompt,
                           threadID: threadID, status: status, preview: preview, steps: steps,
                           agent: agent, workingDirectory: workingDirectory, createdAt: now,
                           builtin: builtin, pickedPath: pickedPath, updatedAt: now, origin: deviceID)
        runs.insert(run, at: 0)
        return run
    }

    public func updateRun(_ id: String, _ mutate: (inout AgentRun) -> Void) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        // In place: a run's output can be long, and copying the run would copy it on every chunk.
        func stamped(_ run: inout AgentRun) {
            mutate(&run)
            run.updatedAt = Date()
        }
        stamped(&runs[index])
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
        let now = Date()
        let skill = Skill(accountID: currentAccountID, name: name, summary: summary, steps: steps, createdAt: now,
                          source: source, updatedAt: now)
        skills.insert(skill, at: 0)
        return skill
    }

    /// Puts back a skill that was just deleted (undo), as a fresh edit so sync keeps it.
    public func restoreSkill(_ skill: Skill) {
        guard !skills.contains(where: { $0.id == skill.id }) else { return }
        var skill = skill
        skill.updatedAt = Date()
        skills.insert(skill, at: 0)
        deletions[skill.id] = nil
    }

    /// A skill shared by a colleague, brought onto this Mac for the current account. Steps arrive as
    /// JSON from the dashboard or the worker; a skill with the same shared id is replaced, not duplicated.
    /// Shared recordings carry no screen pictures, so replay works from labels and the brain's look.
    @discardableResult
    public func importSkill(sharedID: String, name: String, summary: String, stepsJSON: Any, version: Int) -> Skill? {
        guard JSONSerialization.isValidJSONObject(stepsJSON),
              let data = try? JSONSerialization.data(withJSONObject: stepsJSON),
              let steps = try? JSONDecoder().decode([SkillStep].self, from: data), !steps.isEmpty else { return nil }
        let source = "shared:\(sharedID)"
        let cleaned = steps.map { step -> SkillStep in
            var step = step
            step.frameX = nil; step.frameY = nil; step.frameW = nil; step.frameH = nil
            return step
        }
        if let index = skills.firstIndex(where: { $0.source == source && $0.accountID == currentAccountID }) {
            skills[index].name = name
            skills[index].summary = summary
            skills[index].steps = cleaned
            skills[index].updatedAt = Date()
            return skills[index]
        }
        // The Mac that published it already has the original (with its pictures): use that, not a copy.
        if let own = skills.first(where: { skill in
            skill.accountID == currentAccountID && !skill.source.hasPrefix("shared:") && skill.name == name
                && skill.steps.map(\.text) == cleaned.map(\.text) && skill.steps.map(\.input) == cleaned.map(\.input)
        }) {
            return own
        }
        return createSkill(name: name, summary: summary.isEmpty ? "shared by a colleague · v\(version)" : summary, steps: cleaned, source: source)
    }

    public func deleteSkill(_ id: String) {
        if let skill = skills.first(where: { $0.id == id }) { SkillFrames.remove(skill: skill) }
        skills.removeAll { $0.id == id }
        rememberDeletion(id)
    }
    public func incrementSkillRun(_ id: String, by count: Int = 1) {
        guard let index = skills.firstIndex(where: { $0.id == id }) else { return }
        skills[index].runCount += max(1, count)
        skills[index].updatedAt = Date()
    }
    public func updateSkill(_ id: String, name: String? = nil, summary: String? = nil) {
        guard let index = skills.firstIndex(where: { $0.id == id }) else { return }
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { skills[index].name = name }
        if let summary { skills[index].summary = summary }
        skills[index].updatedAt = Date()
    }

    @discardableResult
    public func createRoutine(name: String, prompt: String, cadence: RoutineCadence = .weekly,
                              weekday: Int = 6, hour: Int = 17, minute: Int = 0,
                              enabled: Bool = true) -> Routine {
        let now = Date()
        var routine = Routine(accountID: currentAccountID, name: name, prompt: prompt,
                              cadence: cadence, weekday: weekday, hour: hour, minute: minute,
                              enabled: enabled, createdAt: now, updatedAt: now, origin: deviceID)
        routine.nextRunAt = routine.nextDate()
        routines.insert(routine, at: 0)
        return routine
    }

    public func updateRoutine(_ routine: Routine) {
        guard let index = routines.firstIndex(where: { $0.id == routine.id }) else { return }
        var updated = routine
        // From now, like toggleRoutine: a slot missed since lastRunAt would otherwise fire on save.
        updated.nextRunAt = routine.nextDate()
        updated.updatedAt = Date()
        routines[index] = updated
    }

    public func toggleRoutine(_ id: String) {
        guard let index = routines.firstIndex(where: { $0.id == id }) else { return }
        routines[index].enabled.toggle()
        routines[index].nextRunAt = routines[index].nextDate()
        routines[index].updatedAt = Date()
    }

    public func deleteRoutine(_ id: String) {
        routines.removeAll { $0.id == id }
        rememberDeletion(id)
    }

    public func markRoutineRun(_ id: String, at date: Date = Date()) {
        guard let index = routines.firstIndex(where: { $0.id == id }) else { return }
        routines[index].lastRunAt = date
        routines[index].nextRunAt = routines[index].nextDate(after: date)
        routines[index].updatedAt = date
    }

    // MARK: - Sync

    private func rememberDeletion(_ id: String, at date: Date = Date()) {
        deletions[id] = date
    }

    /// Keeps items a pull brought that this build can't read, replacing an older copy of the same one.
    public func keepUnreadable(_ items: [UnreadableItem]) {
        guard !items.isEmpty else { return }
        for item in items {
            unreadable.removeAll { $0.table == item.table && $0.id == item.id }
            unreadable.append(item)
        }
    }

    /// The saved file's items that didn't decode, found by id, so they can be kept rather than lost.
    static func unreadableItems(in data: Data, besides state: AppState) -> [UnreadableItem] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        let readable: [String: Set<String>] = [
            "threads": Set(state.threads.map(\.id)), "memories": Set(state.memories.map(\.id)), "runs": Set(state.runs.map(\.id)),
            "skills": Set(state.skills.map(\.id)), "routines": Set(state.routines.map(\.id)),
        ]
        var found: [UnreadableItem] = []
        for (table, ids) in readable {
            for raw in root[table] as? [[String: Any]] ?? [] {
                guard let id = raw["id"] as? String, !ids.contains(id),
                      let json = try? JSONSerialization.data(withJSONObject: raw),
                      let text = String(data: json, encoding: .utf8) else { continue }
                found.append(UnreadableItem(table: table, id: id, accountID: raw["accountID"] as? String ?? state.currentAccountID, json: text))
            }
        }
        return found
    }

    /// Brings in what another Mac changed in an account (see `SyncMerge`). Collections that end up the
    /// same are left untouched, so a pull with nothing new doesn't trigger a save or another sync.
    @discardableResult
    public func mergePulled(_ changes: PulledChanges) -> MergeSummary {
        guard !changes.isEmpty else { return MergeSummary() }
        var summary = MergeSummary()
        func tombstones(_ table: String) -> [PulledChanges.Deletion] { changes.deletions.filter { $0.table == table } }

        let mergedThreads = SyncMerge.merge(local: threads, remote: changes.threads, deletions: tombstones("threads"),
                                            deletedHere: deletions, editedAt: \.updatedAt,
                                            combine: SyncMerge.combineThreads, summary: &summary)
        let mergedMemories = SyncMerge.merge(local: memories, remote: SyncMerge.withoutDuplicateMemories(changes.memories, local: memories),
                                             deletions: tombstones("memories"), deletedHere: deletions,
                                             editedAt: \.updatedAt, summary: &summary)
        let mergedRuns = SyncMerge.merge(local: runs, remote: changes.runs, deletions: tombstones("runs"),
                                         deletedHere: deletions, editedAt: \.editedAt, summary: &summary)
        let mergedSkills = SyncMerge.merge(local: skills, remote: changes.skills, deletions: tombstones("skills"),
                                           deletedHere: deletions, editedAt: \.editedAt, summary: &summary)
        let mergedRoutines = SyncMerge.merge(local: routines, remote: changes.routines, deletions: tombstones("routines"),
                                             deletedHere: deletions, editedAt: \.editedAt, summary: &summary)

        // An item that reads fine now (or was deleted elsewhere) no longer needs keeping as it came.
        let settled = Set(changes.threads.map(\.id) + changes.memories.map(\.id) + changes.runs.map(\.id)
                          + changes.skills.map(\.id) + changes.routines.map(\.id) + changes.deletions.map(\.id))
        if unreadable.contains(where: { settled.contains($0.id) }) { unreadable.removeAll { settled.contains($0.id) } }

        // Newest first, the way the store keeps them.
        if mergedThreads != threads { threads = mergedThreads.sorted { $0.updatedAt > $1.updatedAt } }
        if mergedMemories != memories { memories = mergedMemories.sorted { $0.createdAt > $1.createdAt } }
        if mergedRuns != runs { runs = mergedRuns.sorted { $0.createdAt > $1.createdAt } }
        if mergedSkills != skills { skills = mergedSkills.sorted { $0.createdAt > $1.createdAt } }
        if mergedRoutines != routines { routines = mergedRoutines.sorted { $0.createdAt > $1.createdAt } }
        return summary
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
        let horizon = Date().addingTimeInterval(-Self.deletionMemory)
        deletions = deletions.filter { $0.value > horizon }
        let state = AppState(accounts: accounts, currentAccountID: currentAccountID,
                             settings: settings, threads: threads, memories: memories, runs: runs,
                             skills: skills, routines: routines, connectors: connectors,
                             deletions: deletions, syncCursors: syncCursors, unreadable: unreadable)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Fractional seconds: sync tells two edits apart by these times, so they shouldn't round off on save.
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(SyncDates.string(from: date))
        }
        do {
            let data = try encoder.encode(state)
            try data.write(to: stateURL, options: .atomic)
            isWriting = true
            lastSavedAt = Date()
            isWriting = false
        } catch {
            // Published inside the writing window so the failure doesn't schedule another save.
            isWriting = true
            loadError = "couldn't save: \(error.localizedDescription)"
            isWriting = false
        }
    }

    /// One account's share of the state, as it goes to Convex (the one in front unless named).
    public func stateForSync(accountID: String? = nil) -> AppState {
        let account = accountID ?? currentAccountID
        return AppState(accounts: accounts, currentAccountID: account, settings: settings,
                        threads: threads.filter { $0.accountID == account },
                        memories: memories.filter { $0.accountID == account },
                        runs: runs.filter { $0.accountID == account },
                        skills: skills.filter { $0.accountID == account },
                        routines: routines.filter { $0.accountID == account },
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
            MemoryItem(accountID: jay.id, section: .aboutYou, text: "I'm a student at Purdue, studying IBE", createdAt: now.addingTimeInterval(-86400 * 30)),
            MemoryItem(accountID: jay.id, section: .aboutYou, text: "I use Figma and VS Code every day", createdAt: now.addingTimeInterval(-86400 * 20)),
            MemoryItem(accountID: jay.id, section: .aboutYou, text: "keep answers short and concrete", source: "you", createdAt: now.addingTimeInterval(-86400 * 5)),
            MemoryItem(accountID: jay.id, section: .rightNow, text: "building Okidoki, a Mac assistant", createdAt: now.addingTimeInterval(-3600 * 4)),
            MemoryItem(accountID: work.id, section: .rightNow, text: "redesigning the Workro onboarding", createdAt: now.addingTimeInterval(-86400)),
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
        friday.origin = deviceID
        standup.origin = deviceID
        routines = [friday, standup]
        runs = runs.map { run in var run = run; run.origin = deviceID; return run }

        connectors = Self.mergeConnectors([
            Connector(id: "calendar", name: "Apple Calendar", kind: "apple", blurb: "", enabled: true, installed: true),
            Connector(id: "reminders", name: "Apple Reminders", kind: "apple", blurb: "", enabled: true, installed: true),
            Connector(id: "notes", name: "Apple Notes", kind: "apple", blurb: "", enabled: true, installed: true),
        ])
    }
}
