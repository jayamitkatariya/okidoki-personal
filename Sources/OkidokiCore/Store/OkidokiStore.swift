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
    /// Sidebar pins, in order. Nil until the shell seeds them the first time it opens.
    @Published public var pins: [BrowserPin]?
    @Published public private(set) var lastSavedAt: Date?
    @Published public private(set) var loadError: String?
    /// The saved file had items this build couldn't read. They're kept in a copy beside it.
    @Published public private(set) var loadWarning: String?

    /// This Mac (`DeviceIdentity`). Runs and routines started here carry it.
    public let deviceID: String
    /// Items deleted here, id → when, kept for a while.
    public private(set) var deletions: [String: Date]
    /// Memory text deleted or replaced here (folded → when). Earlier turns that repeat it stay out of recall.
    public private(set) var forgottenMemories: [String: Date] = [:]
    /// Left from older builds that synced. Saved back as it was.
    public var syncCursors: [String: Int]
    /// Items this build can't read, from the saved file. Saved back as they are, never deleted.
    public private(set) var unreadable: [UnreadableItem]

    private var saveWork: DispatchWorkItem?
    /// True while the store publishes housekeeping (a save landing, a sync finishing) rather than a
    /// change of the user's data. Listeners that react to changes skip these, or they'd react to
    /// their own bookkeeping forever.
    public private(set) var isHousekeeping = false
    private var isWriting: Bool {
        get { isHousekeeping }
        set { isHousekeeping = newValue }
    }
    private var cancellables = Set<AnyCancellable>()
    private let stateURL: URL

    /// How long a delete is remembered: long past any pull that could still bring the item back.
    static let deletionMemory: TimeInterval = 60 * 60 * 24 * 30

    public init(seedDemo: Bool = false, stateURL: URL? = nil, deviceID: String? = nil) {
        let support = stateURL?.deletingLastPathComponent() ?? AppPaths.support
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
        // Everything is local now: any run left mid-flight was cut off by the restart, including runs
        // from a state file restored onto a new Mac (its origin is the old Mac's id).
        self.runs = Self.clearingSupersededQuestions(runs.map { $0.recoveredAfterRestart() })
        self.skills = state.skills
        self.routines = routines
        self.connectors = Self.mergeConnectors(state.connectors)
        self.pins = state.pins
        self.deletions = state.deletions
        self.forgottenMemories = state.forgotten ?? [:]
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
    /// With a `query`, notes that share words with it come before the newest ones (see `MemoryRecall`), so
    /// the right note reaches the model even among thousands, and even without a Moss key. Pinned notes
    /// always come first.
    public func memoryLines(limit: Int = 24, query: String = "", now: Date = Date()) -> [String] {
        MemoryRecall.select(activeMemories, query: query, limit: limit, isCurrent: { isCurrent($0, now: now) })
            .map { "\($0.section.label): \($0.text)" }
    }

    public func isFromThisMac(_ run: AgentRun) -> Bool { run.origin == deviceID }
    public func isFromThisMac(_ routine: Routine) -> Bool { routine.origin == deviceID }

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
        // Secrets never become memories, whoever sends them (an import included); they belong in the Vault.
        if MemoryPolicy.secretKind(cleaned) != nil { return nil }
        let account = accountID ?? currentAccountID
        let lower = cleaned.lowercased()
        if memories.contains(where: { $0.accountID == account && $0.text.lowercased() == lower }) { return nil }
        let item = MemoryItem(accountID: account, section: section, text: cleaned, source: source)
        memories.insert(item, at: 0)
        return item
    }

    public func updateMemory(_ id: String, text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, let index = memories.firstIndex(where: { $0.id == id }),
              memories[index].text != cleaned else { return }
        forget(memories[index].text)
        memories[index].text = cleaned
        memories[index].updatedAt = Date()
    }

    /// Earlier turns are indexed for two weeks; what was forgotten is remembered as forgotten that long.
    public static let forgetLifetime: TimeInterval = 60 * 60 * 24 * 15

    /// Notes that the person deleted or replaced; their old wording is kept out of recall.
    private func forget(_ text: String) {
        let key = MemoryRecall.forgetKey(text)
        guard !key.isEmpty else { return }
        forgottenMemories[key] = Date()
    }

    /// What one save did, for the chat chip and the toast.
    public enum MemorySave: Equatable {
        case added(MemoryItem)
        /// A correction replaced what it said; `previousText` on the item holds the old text.
        case updated(MemoryItem)
        /// Already known; nothing changed.
        case known(MemoryItem)
        /// Not saved: "secret:<kind>", "instruction", "not-a-fact" or "empty".
        case refused(String)

        public var item: MemoryItem? {
            switch self {
            case .added(let item), .updated(let item), .known(let item): return item
            case .refused: return nil
            }
        }
    }

    /// The one way a remembered fact is saved: gated (no secrets, no instructions), reconciled with what the
    /// account already knows (a duplicate is skipped, a correction replaces the old memory instead of adding
    /// a second one), and marked with where it came from. `op`/`targetID` come from the brain when it decided;
    /// without them the Mac decides by itself.
    @discardableResult
    public func saveMemory(_ text: String, section: MemorySection = .aboutYou, source: String,
                           learned: Bool = false, threadID: String? = nil, runID: String? = nil,
                           messageID: String? = nil, op: String? = nil, targetID: String? = nil,
                           untrusted: Bool = false) -> MemorySave {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,;: "))
        guard cleaned.count > 2 else { return .refused("empty") }
        if let why = MemoryPolicy.refusal(cleaned, untrusted: untrusted || learned) { return .refused(why) }
        let known = activeMemories
        var decided: MemoryPolicy.Match = MemoryPolicy.match(cleaned, in: known)
        if let op, let targetID, known.contains(where: { $0.id == targetID }) {
            if op == "skip" { decided = .duplicate(id: targetID) }
            if op == "update" { decided = .correction(id: targetID) }
        }
        switch decided {
        case .duplicate(let id):
            guard let item = known.first(where: { $0.id == id }) else { return .refused("empty") }
            return .known(item)
        case .correction(let id):
            guard let index = memories.firstIndex(where: { $0.id == id }) else { return .refused("empty") }
            if memories[index].text.lowercased() == cleaned.lowercased() { return .known(memories[index]) }
            memories[index].previousText = memories[index].text
            // The old wording is out of date: earlier turns that repeat it stay out of recall (undo brings it back).
            forget(memories[index].text)
            memories[index].text = cleaned
            memories[index].updatedAt = Date()
            memories[index].threadID = threadID ?? memories[index].threadID
            memories[index].runID = runID
            memories[index].messageID = messageID
            memories[index].learned = learned ? true : nil
            return .updated(memories[index])
        case .new:
            var item = MemoryItem(accountID: currentAccountID, section: section, text: cleaned, source: source)
            item.threadID = threadID; item.runID = runID; item.messageID = messageID
            item.learned = learned ? true : nil
            memories.insert(item, at: 0)
            return .added(item)
        }
    }

    /// Undo for a save: a correction goes back to what it said before, a new memory goes away.
    public func undoMemorySave(_ id: String) {
        guard let index = memories.firstIndex(where: { $0.id == id }) else { return }
        if let previous = memories[index].previousText, !previous.isEmpty {
            memories[index].text = previous
            memories[index].previousText = nil
            memories[index].messageID = nil
            memories[index].learned = nil
            memories[index].updatedAt = Date()
        } else {
            deleteMemory(id)
        }
    }

    /// Pinned notes go with every request, whatever it's about.
    public func setMemoryPinned(_ id: String, _ pinned: Bool) {
        guard let index = memories.firstIndex(where: { $0.id == id }) else { return }
        memories[index].pinned = pinned ? true : nil
    }

    public func deleteMemory(_ id: String) {
        if let gone = memories.first(where: { $0.id == id }) { forget(gone.text) }
        memories.removeAll { $0.id == id }
        rememberDeletion(id)
    }

    /// Sources that mean the model wrote the memory itself. Anything the person typed, answered
    /// in onboarding or imported from another assistant is theirs to keep.
    private static let modelSources: Set<String> = ["said", "followup", "dashboard", "routine", "repair", "browser"]

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
                          status: RunStatus = .previewing, builtin: String? = nil,
                          pickedPath: String? = nil) -> AgentRun {
        let now = Date()
        let run = AgentRun(accountID: currentAccountID, kind: kind, title: title, prompt: prompt,
                           threadID: threadID, status: status, preview: preview, steps: steps,
                           createdAt: now,
                           builtin: builtin, pickedPath: pickedPath, updatedAt: now, origin: deviceID)
        // A new task in the same conversation, or the same task started over elsewhere, means they moved on
        // from the question: it stops waiting on them. It isn't their answer (that comes through
        // `markAnswered`), so nothing tells the agent it was.
        if [.computerUse, .browser].contains(kind) {
            for asked in runs where asked.status == .asked {
                if let threadID, asked.threadID == threadID {
                    markSuperseded(asked.id, sameTask: false)
                } else if asked.kind == kind, Self.sameTask(asked.prompt, prompt) {
                    markSuperseded(asked.id, sameTask: true)
                }
            }
        }
        runs.insert(run, at: 0)
        return run
    }

    /// Questions left waiting by older builds: a later computer or browser task in the same conversation, or
    /// the same task started over, means the user moved on, so they no longer wait on them.
    static func clearingSupersededQuestions(_ runs: [AgentRun]) -> [AgentRun] {
        runs.map { run in
            guard run.status == .asked else { return run }
            let later = runs.filter { $0.id != run.id && [.computerUse, .browser].contains($0.kind) && $0.createdAt > run.createdAt }
            var run = run
            if let thread = run.threadID, later.contains(where: { $0.threadID == thread }) {
                Self.supersede(&run, sameTask: false)
            } else if later.contains(where: { $0.kind == run.kind && sameTask($0.prompt, run.prompt) }) {
                Self.supersede(&run, sameTask: true)
            } else {
                return run
            }
            run.updatedAt = Date()
            return run
        }
    }

    /// The same request typed again, ignoring case and spacing.
    static func sameTask(_ a: String, _ b: String) -> Bool {
        let norm = { (s: String) in s.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        return !norm(a).isEmpty && norm(a) == norm(b)
    }

    private static func supersede(_ run: inout AgentRun, sameTask: Bool) {
        run.status = .cancelled
        run.summary = (sameTask ? "you started this again, so this question was dropped: " : "you moved on, so this question was dropped: ")
            + run.summary
        for index in run.steps.indices where run.steps[index].status == .asked { run.steps[index].status = .cancelled }
    }

    /// A question left behind: they moved on in the conversation, or started the same task over.
    public func markSuperseded(_ id: String, sameTask: Bool) {
        updateRun(id) { run in
            guard run.status == .asked else { return }
            run.endedAt = run.endedAt ?? Date()
            Self.supersede(&run, sameTask: sameTask)
        }
    }

    /// A question the user has answered no longer needs them. The question stays as the summary.
    public func markAnswered(_ id: String, reply: String) {
        updateRun(id) { run in
            guard run.status == .asked else { return }
            run.status = .done
            run.answer = reply
            for index in run.steps.indices where run.steps[index].status == .asked {
                run.steps[index].status = .done
            }
        }
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

    /// One more model call for the run (an agent turn, a replay rescue, a bind). Counted, never shown
    /// as a step; the replay eval reads it to compare the agent, classic replay and hybrid replay.
    public func countModelCall(_ id: String, by count: Int = 1) {
        guard count > 0, let index = runs.firstIndex(where: { $0.id == id }) else { return }
        runs[index].modelCalls = (runs[index].modelCalls ?? 0) + count
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
            run.waitingFor = nil
            if let freedBytes { run.freedBytes = freedBytes }
            // Steps that finished stay done. On failure or a question, the first unfinished step is where
            // it stopped (failed, or needs your answer) and later ones never ran. Stopped: none of them ran on.
            var stoppedOne = false
            for index in run.steps.indices {
                let unfinished = ![.done, .failed, .cancelled].contains(run.steps[index].status)
                switch status {
                case .done:
                    run.steps[index].status = .done
                case .failed where run.steps[index].status != .done, .asked where unfinished:
                    run.steps[index].status = stoppedOne ? .cancelled : status
                    stoppedOne = true
                case .cancelled where unfinished:
                    run.steps[index].status = .cancelled
                default:
                    break
                }
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
            for index in run.steps.indices where ![.done, .failed, .cancelled].contains(run.steps[index].status) {
                run.steps[index].status = .cancelled
                if run.steps[index].endedAt == nil { run.steps[index].endedAt = Date() }
            }
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

    /// A replay repaired some steps (a selector that works again, say): keep the fix so the next one is direct.
    public func updateSkillSteps(_ id: String, _ steps: [SkillStep]) {
        guard let index = skills.firstIndex(where: { $0.id == id }), skills[index].steps.count == steps.count else { return }
        skills[index].steps = steps
        skills[index].revision = (skills[index].revision ?? 0) + 1
        skills[index].updatedAt = Date()
    }

    /// The whole skill rewritten (smart replay generalized it, or a run patched its steps). Same id, so
    /// history and counts carry over.
    public func replaceSkill(_ skill: Skill) {
        guard let index = skills.firstIndex(where: { $0.id == skill.id }) else { return }
        var skill = skill
        skill.revision = (skills[index].revision ?? 0) + 1
        skill.updatedAt = Date()
        skills[index] = skill
    }

    /// A library template added to the person's skills. Adding the same one twice keeps the first.
    @discardableResult
    public func installTemplate(_ entry: SkillLibrary.Entry) -> Skill {
        let source = SkillLibrary.source(for: entry.id)
        if let existing = skills.first(where: { $0.accountID == currentAccountID && ($0.source == source || $0.templateID == source) }) {
            return existing
        }
        let skill = SkillLibrary.skill(from: entry, accountID: currentAccountID)
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
        if let skill = skills.first(where: { $0.id == id }) {
            SkillFrames.remove(skill: skill)
            // A password the skill remembered goes with it.
            SkillSecrets.forget(skillID: skill.id, names: SkillSecrets.names(in: skill))
        }
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

    // MARK: - Deletions and unreadable items

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

    // MARK: - Connectors

    public func setConnector(_ id: String, enabled: Bool? = nil, installed: Bool? = nil) {
        guard let index = connectors.firstIndex(where: { $0.id == id }) else { return }
        if let enabled { connectors[index].enabled = enabled }
        if let installed { connectors[index].installed = installed }
    }

    private static func mergeConnectors(_ existing: [Connector]) -> [Connector] {
        Connectors.defaults.map { spec in
            if let saved = existing.first(where: { $0.id == spec.id }) {
                var merged = spec
                merged.enabled = saved.enabled
                merged.installed = saved.installed
                return merged
            }
            return spec
        }
    }

    // MARK: - Pins, seen

    public static let maxPins = 12

    /// Pins a site, or does nothing when its host is already pinned. Returns false when the grid is full.
    /// `index` places it among the pins (a tab dropped between two); nil or out of range adds it at the end.
    @discardableResult
    public func pin(url: String, title: String, at index: Int? = nil) -> Bool {
        var list = pins ?? []
        let host = BrowserPin.host(of: url)
        guard !host.isEmpty, !url.isEmpty else { return false }
        if list.contains(where: { $0.host == host }) { return true }
        guard list.count < Self.maxPins else { return false }
        let pin = BrowserPin(url: url, title: title.isEmpty ? host : title)
        if let index, index >= 0, index < list.count { list.insert(pin, at: index) } else { list.append(pin) }
        pins = list
        return true
    }

    public func unpin(_ id: String) {
        pins = (pins ?? []).filter { $0.id != id }
    }

    /// Puts the pins in the order given; ids not listed keep their place at the end.
    public func reorderPins(_ ids: [String]) {
        let list = pins ?? []
        // Repeated ids (a stray drag) must never duplicate a pin, nor crash on one saved twice.
        let byID = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var ordered = ids.filter { seen.insert($0).inserted }.compactMap { byID[$0] }
        ordered += list.filter { seen.insert($0.id).inserted }
        pins = ordered
    }

    /// The pins seeded the first time the shell opens, from sites the person already uses:
    /// vault logins first, then the sites their skills start on, then a few everyday ones.
    public func seedPinsIfNeeded(loginSites: [String]) {
        guard pins == nil else { return }
        var seen = Set<String>()
        var list: [BrowserPin] = []
        func add(_ url: String, _ title: String) {
            let full = url.contains("://") ? url : "https://\(url)"
            let host = BrowserPin.host(of: full)
            guard !host.isEmpty, !seen.contains(host), list.count < 6 else { return }
            seen.insert(host)
            list.append(BrowserPin(url: full, title: title))
        }
        for site in loginSites { add(site, BrowserPin.host(of: site)) }
        for skill in skills { if let url = skill.startURL, !url.isEmpty { add(url, BrowserPin.host(of: url)) } }
        for (url, title) in [("https://mail.google.com", "Gmail"), ("https://www.google.com", "Google"),
                             ("https://calendar.google.com", "Calendar"), ("https://github.com", "GitHub"),
                             ("https://www.youtube.com", "YouTube"), ("https://www.notion.so", "Notion")] {
            add(url, title)
        }
        pins = list
    }

    /// The person looked at a thread or a run: its unread dot goes away.
    public func markSeen(threadID: String? = nil, runID: String? = nil) {
        let now = Date()
        if let threadID, let index = threads.firstIndex(where: { $0.id == threadID }) {
            threads[index].seenAt = now
        }
        if let runID, let index = runs.firstIndex(where: { $0.id == runID }) {
            runs[index].seenAt = now
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
        let forgetHorizon = Date().addingTimeInterval(-Self.forgetLifetime)
        forgottenMemories = forgottenMemories.filter { $0.value > forgetHorizon }
        let state = AppState(accounts: accounts, currentAccountID: currentAccountID,
                             settings: settings, threads: threads, memories: memories, runs: runs,
                             skills: skills, routines: routines, connectors: connectors,
                             deletions: deletions, syncCursors: syncCursors, unreadable: unreadable,
                             pins: pins,
                             forgotten: forgottenMemories.isEmpty ? nil : forgottenMemories)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Fractional seconds: two edits a moment apart stay apart, so they shouldn't round off on save.
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISODates.string(from: date))
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
        settings.automationGranted = true
        settings.voiceID = "sarah"

        let now = Date()
        var figma = ChatThread(accountID: jay.id, title: "flights to chicago", app: "okidoki browser", topic: "travel",
                           messages: [
                            ChatMessage(role: .user, text: "find the cheapest flight to chicago next friday", createdAt: now.addingTimeInterval(-7200)),
                            ChatMessage(role: .assistant, text: "cheapest is $148 on united, leaving 7:05am. i saved the search as a skill so next time it takes seconds.", createdAt: now.addingTimeInterval(-7150)),
                           ], createdAt: now.addingTimeInterval(-7200), updatedAt: now.addingTimeInterval(-7000))
        var space = ChatThread(accountID: jay.id, title: "keynote export", app: "Keynote", topic: "decks",
                           messages: [
                            ChatMessage(role: .user, text: "export all my keynote decks to pdf", createdAt: now.addingTimeInterval(-3600)),
                            ChatMessage(role: .assistant, text: "on it. six decks, one folder on your desktop.", createdAt: now.addingTimeInterval(-3590)),
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

        var flights = AgentRun(accountID: jay.id, kind: .browser, title: "cheapest flight to chicago",
                               prompt: "find the cheapest flight to chicago next friday", threadID: figma.id, status: .done,
                               preview: ActionPreview(summary: "search flights in okidoki's browser and compare prices",
                                                      risk: .low,
                                                      steps: [PreviewStep("open google flights"), PreviewStep("search chicago, next friday"),
                                                              PreviewStep("sort by price")],
                                                      commands: [], apps: ["okidoki browser"], files: []),
                               summary: "$148 on united, 7:05am", createdAt: now.addingTimeInterval(-7100),
                               startedAt: now.addingTimeInterval(-7095), endedAt: now.addingTimeInterval(-7040))
        flights.steps = [RunStep(title: "open google flights", status: .done), RunStep(title: "search chicago", status: .done), RunStep(title: "sort by price", status: .done)]

        var keynote = AgentRun(accountID: jay.id, kind: .computerUse, title: "export keynote decks",
                               prompt: "export all my keynote decks to pdf", threadID: space.id, status: .running,
                               preview: ActionPreview(summary: "export 6 Keynote decks to one folder",
                                                      risk: .low,
                                                      steps: [PreviewStep("open each deck"), PreviewStep("export as PDF"), PreviewStep("put them in ~/Desktop/decks")],
                                                      commands: [],
                                                      apps: ["Keynote"], files: ["~/Desktop/decks/*.pdf"]),
                               summary: "", createdAt: now.addingTimeInterval(-180),
                               startedAt: now.addingTimeInterval(-175), endedAt: nil)
        keynote.steps = [RunStep(title: "open each deck", status: .done), RunStep(title: "export as PDF", status: .running), RunStep(title: "collect in one folder", status: .previewing)]

        runs = [keynote, flights]

        skills = [
            Skill(accountID: jay.id, name: "friday cleanup", summary: "empty downloads, screenshots and old installers",
                  steps: [SkillStep(text: "open Downloads", app: "Finder"), SkillStep(text: "select installers older than 30 days", app: "Finder"), SkillStep(text: "move to trash and empty")],
                  source: "watch me", runCount: 7),
            Skill(accountID: jay.id, name: "flight search", summary: "google flights, cheapest first",
                  steps: [SkillStep(text: "open google.com/travel/flights", app: "okidoki browser"),
                          SkillStep(text: "type “{{city}}” in Where to?", app: "okidoki browser"),
                          SkillStep(text: "sort by price", app: "okidoki browser")],
                  source: "act", runCount: 3),
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
        ])
    }
}
