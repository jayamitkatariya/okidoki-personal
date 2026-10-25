import Foundation

/// Enterprise: this Mac as a worker for the agent in the work account's spaces.
///
/// Every few seconds it asks the Convex deployment (over the same secret-guarded routes sync
/// uses) for jobs queued in spaces this account's login belongs to. One job runs at a time:
/// its prompt goes through the ordinary request pipeline in a thread of its own, and whatever
/// that produces — a plan waiting for approval, steps, output, an answer — is mirrored back
/// so the space's chat shows it. Approvals come back the same way: someone in the chat says
/// "Do it" and the run here is approved; "Not now" cancels it.
///
/// The worker keeps its place in the organization while the person looks at Personal: it
/// still heart-beats (as "paused"), still mirrors the job it holds and still honours decisions,
/// but takes nothing new until the work account is back in front. A relaunch picks the held
/// job back up from Settings instead of leaving the chat hanging.
@MainActor
public final class SpaceWorkerService: ObservableObject {
    public struct Job: Equatable, Sendable {
        public var id: String
        public var spaceId: String
        public var spaceName: String
        public var prompt: String
    }

    /// What this Mac tells the organization each poll.
    public enum State: String, Sendable { case off, paused, ready }

    /// One line for Settings: off · idle · paused · running · the last error.
    @Published public private(set) var status: String = "off"
    @Published public private(set) var state: State = .off
    @Published public private(set) var activeJob: Job?
    @Published public private(set) var lastPollAt: Date?
    @Published public private(set) var jobsDone: Int = 0

    /// Routes a job's prompt through the request pipeline, in the given thread. Set by the app.
    public var runJob: ((_ prompt: String, _ threadID: String) async -> Void)?
    public var approveRun: ((String) -> Void)?
    public var cancelRun: ((String) -> Void)?
    /// The organization's view that rides along with each poll (`EnterpriseSummary` JSON, or nil
    /// when the account isn't linked). Set by the app; the enterprise service reads it.
    public var onSummary: ((Any?) -> Void)?

    public static let pollInterval: TimeInterval = 4
    /// How long a routed prompt may go without becoming a run before the job is closed from the thread.
    static let routeGrace: TimeInterval = 45

    private struct Tracked {
        var job: Job
        var accountID: String
        var threadID: String
        var runID: String?
        var routedAt: Date?
        var lastReport: String = ""
        var appliedDecision: String = ""
        var lastStatus: String = "accepted"
    }

    private weak var store: OkidokiStore?
    private var timer: Timer?
    private var polling = false
    private var tracked: Tracked? {
        didSet { remember() }
    }
    /// The thread (and run, once there is one) of the job this Mac holds, so the notch can say who it's for.
    public var activeThreadID: String? { tracked?.threadID }
    public var activeRunID: String? { tracked?.runID }
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func start(store: OkidokiStore) {
        self.store = store
        timer?.invalidate()
        let timer = Timer(timeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        Task { await tick() }
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - Wiring

    private var device: String { Host.current().localizedName ?? "mac" }

    private func endpoint(_ base: String, path: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed + path)
    }

    private func post(_ path: String, _ body: [String: Any]) async -> [String: Any]? {
        guard let store, let url = endpoint(store.settings.convexSiteURL, path: path),
              let secret = KeyStore.get("convex"), !secret.isEmpty else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = data
        do {
            let (payload, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard (200..<300).contains(http.statusCode) else {
                status = http.statusCode == 401 ? "sync secret rejected" : "worker: HTTP \(http.statusCode)"
                return nil
            }
            return try JSONSerialization.jsonObject(with: payload) as? [String: Any]
        } catch {
            status = "worker: \(error.localizedDescription)"
            return nil
        }
    }

    /// The work account this Mac works as: the active one when it's a work account, otherwise the
    /// one it last worked as (so a job keeps reporting while Personal is in front). Nil without sync
    /// or without any work account.
    public var workerAccountID: String? {
        guard let store, store.settings.syncEnabled, !store.settings.convexSiteURL.isEmpty else { return nil }
        if store.activeAccount.kind == .work { return store.currentAccountID }
        if let held = tracked { return held.accountID }
        let remembered = store.settings.workerAccountID
        guard !remembered.isEmpty, store.accounts.contains(where: { $0.id == remembered && $0.kind == .work }) else { return nil }
        return remembered
    }

    private var workerKind: String {
        store?.settings.computerTarget == "vm" ? "privateMac" : "thisMac"
    }

    private func remember() {
        guard let store else { return }
        let held = tracked.map { WorkerHeldJob(jobID: $0.job.id, spaceID: $0.job.spaceId, spaceName: $0.job.spaceName,
                                               prompt: $0.job.prompt, threadID: $0.threadID, runID: $0.runID) }
        guard held != store.settings.workerHeldJob else { return }
        store.settings.workerHeldJob = held
        store.saveNow()
    }

    // MARK: - The loop

    public func tick() async {
        guard let store, !polling else { return }
        guard let accountID = workerAccountID else {
            if status != "off" { status = "off" }
            state = .off
            return
        }
        polling = true
        defer { polling = false }
        if store.activeAccount.kind == .work, store.settings.workerAccountID != accountID {
            store.settings.workerAccountID = accountID
            store.saveNow()
        }
        let enabled = store.settings.workerEnabled
        let next: State = !enabled ? .off : (store.currentAccountID == accountID ? .ready : .paused)
        state = next
        // The heartbeat goes out either way, so the organization sees this Mac switch off or pause.
        guard let reply = await post("/api/worker/poll", [
            "accountId": accountID,
            "device": device,
            "kind": workerKind,
            "enabled": enabled,
            "state": next.rawValue,
        ]) else { return }
        lastPollAt = Date()
        onSummary?(reply["summary"])
        guard reply["ok"] as? Bool == true else {
            status = (reply["reason"] as? String).map { "worker: \($0)" } ?? "worker: not linked"
            return
        }
        guard enabled else {
            status = "off"
            return
        }

        let held = reply["held"] as? [[String: Any]] ?? []
        await recover(held, accountID: accountID)
        await reportProgress()
        await applyDecisions(held)

        if next == .ready, tracked == nil, let first = (reply["jobs"] as? [[String: Any]])?.first,
           let id = first["id"] as? String, let spaceId = first["spaceId"] as? String, let prompt = first["prompt"] as? String {
            let job = Job(id: id, spaceId: spaceId, spaceName: first["spaceName"] as? String ?? "space", prompt: prompt)
            await accept(job, accountID: accountID)
        }
        if tracked == nil {
            status = next == .paused ? "paused: switch to \(store.accounts.first { $0.id == accountID }?.name ?? "your work account") to take jobs" : "idle"
        }
    }

    private func accept(_ job: Job, accountID: String) async {
        guard let store else { return }
        guard let reply = await post("/api/worker/accept", ["accountId": accountID, "jobId": job.id, "device": device]),
              let accepted = reply["job"] as? [String: Any] else { return }
        // The space's shared skills come with the job, so "replay …" finds them even on a Mac that never recorded them.
        for shared in accepted["sharedSkills"] as? [[String: Any]] ?? [] {
            guard let id = shared["id"] as? String, let name = shared["name"] as? String, let steps = shared["steps"] else { continue }
            store.importSkill(sharedID: id, name: name, summary: shared["summary"] as? String ?? "", stepsJSON: steps, version: shared["version"] as? Int ?? 1)
        }
        let thread = store.createThread(title: "\(job.spaceName) · \(job.prompt.prefix(48))", app: "space", topic: job.spaceId)
        tracked = Tracked(job: job, accountID: accountID, threadID: thread.id)
        activeJob = job
        status = "running: \(job.prompt.prefix(60))"
        guard let runJob else {
            await finish(status: "failed", say: "This Mac can't take jobs right now.")
            return
        }
        Task { [weak self] in
            await runJob(job.prompt, thread.id)
            await MainActor.run { self?.tracked?.routedAt = Date() }
        }
    }

    /// Jobs the organization says this Mac holds but nothing here is tracking: the app relaunched,
    /// or an earlier close didn't reach the deployment. Pick the job back up when its run is still
    /// here; otherwise close it honestly so the chat isn't left waiting.
    private func recover(_ held: [[String: Any]], accountID: String) async {
        guard let store else { return }
        let remembered = store.settings.workerHeldJob
        // The job Settings remembers comes first, so a leftover never takes its place.
        let ordered = held.sorted { ($0["id"] as? String) == remembered?.jobID && ($1["id"] as? String) != remembered?.jobID }
        for item in ordered {
            guard let id = item["id"] as? String, id != tracked?.job.id else { continue }
            if tracked != nil {
                // One job at a time: a second one can only be a leftover whose close never landed.
                _ = await post("/api/worker/update", ["accountId": accountID, "jobId": id, "status": "failed",
                                                      "say": "This Mac lost track of that one. Ask again and it starts fresh."])
                continue
            }
            let memory = remembered?.jobID == id ? remembered : nil
            let runID = memory?.runID ?? item["runClientId"] as? String
            let run = runID.flatMap { store.run($0) }
                ?? memory.flatMap { held in store.runs.filter { $0.threadID == held.threadID }.sorted { $0.createdAt > $1.createdAt }.first }
            if let threadID = memory?.threadID ?? run?.threadID {
                let job = Job(id: id, spaceId: memory?.spaceID ?? "", spaceName: memory?.spaceName ?? "space", prompt: memory?.prompt ?? run?.prompt ?? "")
                var current = Tracked(job: job, accountID: accountID, threadID: threadID, runID: run?.id)
                // Nothing routed in this process: whatever the thread already holds is the answer.
                current.routedAt = run == nil ? .distantPast : nil
                current.lastStatus = item["status"] as? String ?? "accepted"
                current.appliedDecision = run?.status == .waiting ? "" : (item["decision"] as? String ?? "")
                tracked = current
                activeJob = job
                status = "running: \(job.prompt.prefix(60))"
                continue
            }
            _ = await post("/api/worker/update", ["accountId": accountID, "jobId": id, "status": "failed",
                                                  "say": "This Mac restarted before finishing. Ask again and it starts fresh."])
        }
    }

    /// A decision made in the chat for the job this Mac holds.
    private func applyDecisions(_ held: [[String: Any]]) async {
        guard var current = tracked else { return }
        for item in held where item["id"] as? String == current.job.id {
            let decision = item["decision"] as? String ?? ""
            guard !decision.isEmpty, decision != current.appliedDecision else { continue }
            if decision == "decline" {
                current.appliedDecision = decision
                tracked = current
                if let runID = current.runID { cancelRun?(runID) }
                await finish(status: "cancelled", say: nil)
                return
            }
            // An approval needs the run to exist here; until it does, try again next tick.
            guard decision == "approve", let runID = current.runID, let run = store?.run(runID) else { continue }
            if run.status == .waiting { approveRun?(runID) }
            current.appliedDecision = decision
            tracked = current
        }
    }

    /// Mirrors the run this job turned into — once it exists — and closes the job when it ends.
    private func reportProgress() async {
        guard let store, var current = tracked else { return }
        let run = current.runID.flatMap { store.run($0) }
            ?? store.runs.filter { $0.threadID == current.threadID }.sorted { $0.createdAt > $1.createdAt }.first
        if current.runID == nil, let run {
            current.runID = run.id
            tracked = current
        }
        guard let run else {
            // Routed a while ago and nothing became a run: the pipeline answered without one or gave up.
            if let routedAt = current.routedAt, Date().timeIntervalSince(routedAt) > Self.routeGrace {
                let answer = lastAssistantLine(threadID: current.threadID)
                await finish(status: answer.isEmpty ? "failed" : "done", say: answer.isEmpty ? "Nothing came of that on this Mac." : answer)
            }
            return
        }
        let status = Self.jobStatus(for: run.status)
        var body: [String: Any] = [
            "accountId": current.accountID,
            "jobId": current.job.id,
            "status": status,
            "runClientId": run.id,
            "title": run.title,
            "summary": run.summary,
            "output": String(run.output.suffix(8_000)),
            "steps": run.steps.map { ["title": $0.title, "detail": $0.detail, "status": $0.status.rawValue] },
        ]
        if let preview = run.preview {
            body["preview"] = ["summary": preview.summary, "risk": preview.risk.rawValue,
                               "steps": preview.steps.map(\.text), "commands": preview.commands, "apps": preview.apps]
        } else {
            body["preview"] = NSNull()
        }
        let terminal = ["done", "failed", "cancelled"].contains(status)
        if terminal {
            body["say"] = Self.closingLine(run: run, answer: lastAssistantLine(threadID: current.threadID))
        } else if status == "waiting", current.lastStatus != "waiting" {
            body["say"] = "Needs an okay before it goes ahead: \(run.preview?.summary ?? run.title)"
            // A fresh wait is a fresh question: the chat's earlier answer mustn't count for it.
            current.appliedDecision = ""
        }
        let signature = "\(status)|\(run.title)|\(run.summary)|\(run.output.count)|\(run.steps.map { "\($0.title):\($0.status.rawValue)" }.joined(separator: ","))|\(run.preview?.summary ?? "")"
        guard signature != current.lastReport else { return }
        current.lastReport = signature
        current.lastStatus = status
        tracked = current
        guard await post("/api/worker/update", body) != nil else {
            // The deployment didn't hear this one; say it again next tick.
            current.lastReport = ""
            tracked = current
            return
        }
        if terminal {
            jobsDone += 1
            tracked = nil
            activeJob = nil
        }
    }

    private func finish(status: String, say: String?) async {
        guard let current = tracked else { return }
        var body: [String: Any] = ["accountId": current.accountID, "jobId": current.job.id, "status": status]
        if let say { body["say"] = say }
        _ = await post("/api/worker/update", body)
        tracked = nil
        activeJob = nil
        self.status = "idle"
    }

    private func lastAssistantLine(threadID: String) -> String {
        store?.thread(threadID)?.messages.last(where: { $0.role == .assistant })?.text ?? ""
    }

    // MARK: - Pure helpers

    nonisolated public static func jobStatus(for status: RunStatus) -> String {
        switch status {
        case .previewing, .running, .paused: return "running"
        case .waiting: return "waiting"
        case .done: return "done"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        }
    }

    /// What the agent says in the chat when the job ends.
    nonisolated public static func closingLine(run: AgentRun, answer: String) -> String {
        switch run.status {
        case .done:
            if !answer.isEmpty { return answer }
            if !run.summary.isEmpty { return "Done: \(run.summary)" }
            return "Done: \(run.title)"
        case .failed:
            let tail = run.output.split(separator: "\n").last.map(String.init) ?? ""
            return "That didn't work: \(run.summary.isEmpty ? (tail.isEmpty ? run.title : tail) : run.summary)"
        case .cancelled:
            return "Stopped."
        default:
            return run.summary
        }
    }
}
