import Foundation

// MARK: - What the organization looks like from this Mac

/// The work account's organization as the deployment last described it. It rides along with
/// every worker poll, so the notch and the cursor card can show approvals, unread chats and
/// shared skills — and act on them — without the control panel open.
public struct EnterpriseSummary: Equatable, Sendable {
    public struct Org: Equatable, Sendable {
        public var id: String
        public var name: String
        public var role: String
        public var welcome: String
        public var pendingJoins: Int
        public var memberCount: Int
        public var isAdmin: Bool { role == "owner" || role == "admin" }
    }

    public struct Space: Identifiable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var colorHex: String
        public var workerPolicy: String
        public var joined: Bool
        public var unread: Int
        public var lastMessage: String
        public var lastMessageAt: Date
    }

    /// A run in one of my spaces that's waiting for someone to say Do it / Not now.
    public struct Approval: Identifiable, Equatable, Sendable {
        public var id: String
        public var spaceId: String
        public var spaceName: String
        public var prompt: String
        public var title: String
        public var requestedBy: String
        public var workerName: String
        public var workerIsYou: Bool
        public var summary: String
        public var risk: RiskLevel
        public var steps: [String]
        public var commands: [String]
        public var apps: [String]
        public var createdAt: Date

        public init(id: String, spaceId: String, spaceName: String, prompt: String, title: String, requestedBy: String,
                    workerName: String, workerIsYou: Bool, summary: String, risk: RiskLevel, steps: [String],
                    commands: [String], apps: [String], createdAt: Date) {
            self.id = id; self.spaceId = spaceId; self.spaceName = spaceName; self.prompt = prompt; self.title = title
            self.requestedBy = requestedBy; self.workerName = workerName; self.workerIsYou = workerIsYou; self.summary = summary
            self.risk = risk; self.steps = steps; self.commands = commands; self.apps = apps; self.createdAt = createdAt
        }
    }

    /// A skill a colleague published. Steps stay on the deployment until it's pulled.
    public struct SharedSkill: Identifiable, Equatable, Sendable {
        public var id: String
        public var spaceId: String?
        public var spaceName: String
        public var sourceSkillId: String
        public var name: String
        public var summary: String
        public var publishedBy: String
        public var isMine: Bool
        public var version: Int
        public var stepCount: Int
        public var requires: [String]
        public var runCount: Int
    }

    public var org: Org?
    public var meName: String = ""
    public var spaces: [Space] = []
    public var approvals: [Approval] = []
    public var sharedSkills: [SharedSkill] = []

    public static let empty = EnterpriseSummary()

    public init(org: Org? = nil, meName: String = "", spaces: [Space] = [], approvals: [Approval] = [], sharedSkills: [SharedSkill] = []) {
        self.org = org; self.meName = meName; self.spaces = spaces; self.approvals = approvals; self.sharedSkills = sharedSkills
    }

    public var joinedSpaces: [Space] { spaces.filter(\.joined) }
    public var unreadCount: Int { joinedSpaces.reduce(0) { $0 + $1.unread } }

    /// Parses the `summary` object from a worker poll. Nil for a Mac that isn't linked.
    public init?(json: Any?) {
        guard let json = json as? [String: Any], let org = json["org"] as? [String: Any],
              let orgID = org["id"] as? String, let orgName = org["name"] as? String else { return nil }
        self.org = Org(id: orgID, name: orgName, role: org["role"] as? String ?? "member",
                       welcome: org["welcome"] as? String ?? "", pendingJoins: org["pendingJoins"] as? Int ?? 0,
                       memberCount: org["memberCount"] as? Int ?? 0)
        self.meName = (json["me"] as? [String: Any])?["name"] as? String ?? ""
        func date(_ value: Any?) -> Date {
            guard let ms = value as? Double else { return .distantPast }
            return Date(timeIntervalSince1970: ms / 1000)
        }
        func strings(_ value: Any?) -> [String] { (value as? [Any])?.compactMap { $0 as? String } ?? [] }
        self.spaces = (json["spaces"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let name = item["name"] as? String else { return nil }
            return Space(id: id, name: name, colorHex: item["colorHex"] as? String ?? "44E45E",
                         workerPolicy: item["workerPolicy"] as? String ?? "thisMac", joined: item["joined"] as? Bool ?? false,
                         unread: item["unread"] as? Int ?? 0, lastMessage: item["lastMessage"] as? String ?? "",
                         lastMessageAt: date(item["lastMessageAt"]))
        }
        self.approvals = (json["approvals"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let spaceId = item["spaceId"] as? String else { return nil }
            let preview = item["preview"] as? [String: Any] ?? [:]
            return Approval(id: id, spaceId: spaceId, spaceName: item["spaceName"] as? String ?? "a space",
                            prompt: item["prompt"] as? String ?? "", title: item["title"] as? String ?? "",
                            requestedBy: item["requestedBy"] as? String ?? "Someone", workerName: item["workerName"] as? String ?? "",
                            workerIsYou: item["workerIsYou"] as? Bool ?? false,
                            summary: preview["summary"] as? String ?? "",
                            risk: RiskLevel(rawValue: preview["risk"] as? String ?? "low") ?? .low,
                            steps: strings(preview["steps"]), commands: strings(preview["commands"]), apps: strings(preview["apps"]),
                            createdAt: date(item["createdAt"]))
        }
        self.sharedSkills = (json["sharedSkills"] as? [[String: Any]] ?? []).compactMap { item in
            guard let id = item["id"] as? String, let name = item["name"] as? String else { return nil }
            return SharedSkill(id: id, spaceId: item["spaceId"] as? String, spaceName: item["spaceName"] as? String ?? "",
                               sourceSkillId: item["sourceSkillId"] as? String ?? "", name: name,
                               summary: item["summary"] as? String ?? "", publishedBy: item["publishedBy"] as? String ?? "Someone",
                               isMine: item["isMine"] as? Bool ?? false, version: item["version"] as? Int ?? 1,
                               stepCount: item["stepCount"] as? Int ?? 0, requires: strings(item["requires"]),
                               runCount: item["runCount"] as? Int ?? 0)
        }
    }
}

// MARK: - Acting on it

/// Enterprise, outside the panel. Holds the latest `EnterpriseSummary` (fed by the worker's
/// poll) and does what the notch and the cursor card ask: answer an approval, send a request
/// to a space, pull a shared skill, publish one. Everything goes over the same secret-guarded
/// routes the worker uses, keyed by the work account.
@MainActor
public final class EnterpriseService: ObservableObject {
    @Published public private(set) var summary = EnterpriseSummary.empty
    @Published public private(set) var linked = false
    @Published public private(set) var updatedAt: Date?
    @Published public private(set) var lastError: String?
    /// A welcome note that hasn't been shown yet, cleared once the app shows it.
    @Published public private(set) var pendingWelcome: (org: String, text: String)?

    /// Approvals answered from this Mac, hidden until the deployment catches up.
    private var answered: [String: Date] = [:]
    /// Spaces read from this Mac, so their count drops before the next poll.
    private var readLocally: [String: Date] = [:]
    private weak var store: OkidokiStore?
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func start(store: OkidokiStore) {
        self.store = store
    }

    /// The `summary` object out of a worker poll reply. Nil means the Mac isn't linked any more.
    public func apply(_ json: Any?) {
        let now = Date()
        answered = answered.filter { now.timeIntervalSince($0.value) < 60 }
        readLocally = readLocally.filter { now.timeIntervalSince($0.value) < 60 }
        guard var next = EnterpriseSummary(json: json) else {
            if linked { linked = false }
            if summary != .empty { summary = .empty }
            return
        }
        // Keep local answers ahead of the deployment: a card that was just dismissed mustn't come back for a tick.
        next.approvals.removeAll { answered[$0.id] != nil }
        for index in next.spaces.indices where readLocally[next.spaces[index].id] != nil { next.spaces[index].unread = 0 }
        if !linked { linked = true }
        if summary != next { summary = next }
        updatedAt = now
        noteWelcome(next)
    }

    private func noteWelcome(_ next: EnterpriseSummary) {
        guard let store, let org = next.org, !org.welcome.isEmpty,
              !store.settings.welcomedOrgIDs.contains(org.id), pendingWelcome?.org != org.id else { return }
        pendingWelcome = (org.id, org.welcome)
    }

    /// The app showed the welcome; it won't come back for this organization.
    public func welcomeShown() {
        guard let store, let pending = pendingWelcome else { return }
        if !store.settings.welcomedOrgIDs.contains(pending.org) { store.settings.welcomedOrgIDs.append(pending.org) }
        pendingWelcome = nil
    }

    // MARK: Reading

    public var org: EnterpriseSummary.Org? { linked ? summary.org : nil }
    public var approvals: [EnterpriseSummary.Approval] { linked ? summary.approvals : [] }
    public var spaces: [EnterpriseSummary.Space] { linked ? summary.spaces : [] }
    public var joinedSpaces: [EnterpriseSummary.Space] { linked ? summary.joinedSpaces : [] }
    public var unreadSpaces: [EnterpriseSummary.Space] { joinedSpaces.filter { $0.unread > 0 }.sorted { $0.lastMessageAt > $1.lastMessageAt } }
    public var unreadCount: Int { linked ? summary.unreadCount : 0 }
    public var sharedSkills: [EnterpriseSummary.SharedSkill] { linked ? summary.sharedSkills : [] }

    /// Shared skills that aren't on this Mac yet (a pulled one lives in the store as `shared:<id>`).
    public var pullableSkills: [EnterpriseSummary.SharedSkill] {
        guard let store else { return sharedSkills }
        let sources = Set(store.activeSkills.map(\.source))
        let ids = Set(store.activeSkills.map(\.id))
        return sharedSkills.filter { !sources.contains("shared:\($0.id)") && !ids.contains($0.sourceSkillId) }
    }

    public func space(id: String) -> EnterpriseSummary.Space? { spaces.first { $0.id == id } }

    /// The space a name points at: "#sales", "sales", "the sales space". Joined spaces first.
    public func space(named query: String) -> EnterpriseSummary.Space? {
        let q = Self.normalizeSpaceName(query)
        guard !q.isEmpty else { return nil }
        let ranked = spaces.map { ($0, ChatCommands.score(q, against: $0.name)) }
            .filter { $0.1 >= 0.6 }
            .sorted { $0.1 > $1.1 || ($0.1 == $1.1 && $0.0.joined && !$1.0.joined) }
        return ranked.first?.0
    }

    public static func normalizeSpaceName(_ text: String) -> String {
        ChatCommands.normalize(text)
            .replacingOccurrences(of: "^#", with: "", options: .regularExpression)
            .replacingOccurrences(of: "^(the |my |our )+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "( space| channel| group| team)$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    // MARK: Doing

    public enum Outcome: Equatable, Sendable {
        case ok
        case failed(String)
        public var error: String? { if case .failed(let text) = self { return text } else { return nil } }
    }

    /// Do it / Not now on a colleague's waiting run. Hidden here at once; the chat hears it on the deployment.
    @discardableResult
    public func decide(jobID: String, decision: String) async -> Outcome {
        answered[jobID] = Date()
        summary.approvals.removeAll { $0.id == jobID }
        let reply = await post("/api/enterprise/decide", ["jobId": jobID, "decision": decision])
        if let error = reply.error { answered[jobID] = nil; return .failed(error) }
        return .ok
    }

    /// A line in a space's chat. Returns the job id when it mentioned the agent.
    public func send(spaceID: String, text: String) async -> Result<String?, EnterpriseError> {
        let reply = await post("/api/enterprise/send", ["spaceId": spaceID, "text": text])
        if let error = reply.error { return .failure(EnterpriseError(error)) }
        readLocally[spaceID] = Date()
        return .success(reply.json?["jobId"] as? String)
    }

    /// Hands the agent in a space a request, as if typed "@okidoki …" in its chat.
    public func ask(spaceID: String, text: String) async -> Result<String?, EnterpriseError> {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = cleaned.lowercased().contains("@okidoki") ? cleaned : "@okidoki \(cleaned)"
        return await send(spaceID: spaceID, text: line)
    }

    public func markRead(spaceID: String) async {
        readLocally[spaceID] = Date()
        if let index = summary.spaces.firstIndex(where: { $0.id == spaceID }) { summary.spaces[index].unread = 0 }
        _ = await post("/api/enterprise/read", ["spaceId": spaceID])
    }

    @discardableResult
    public func joinSpace(spaceID: String) async -> Outcome {
        let reply = await post("/api/enterprise/join-space", ["spaceId": spaceID])
        if let error = reply.error { return .failed(error) }
        if let index = summary.spaces.firstIndex(where: { $0.id == spaceID }) { summary.spaces[index].joined = true }
        return .ok
    }

    /// Brings a colleague's skill onto this Mac so it can be replayed here. Returns the local skill.
    public func pullSkill(_ shared: EnterpriseSummary.SharedSkill) async -> Skill? {
        guard let store else { return nil }
        if let local = store.activeSkills.first(where: { $0.source == "shared:\(shared.id)" }) { return local }
        let reply = await post("/api/enterprise/skill", ["sharedId": shared.id])
        guard let skill = reply.json?["skill"] as? [String: Any], let steps = skill["steps"] else {
            lastError = reply.error ?? "that skill isn't available any more"
            return nil
        }
        let imported = store.importSkill(sharedID: shared.id, name: skill["name"] as? String ?? shared.name,
                                         summary: skill["summary"] as? String ?? shared.summary, stepsJSON: steps,
                                         version: skill["version"] as? Int ?? shared.version)
        if imported != nil { store.saveNow() }
        return imported
    }

    /// A replay of a shared skill finished here; the organization's count goes up.
    public func recordSkillRun(_ skill: Skill) {
        guard skill.source.hasPrefix("shared:") else { return }
        let sharedID = String(skill.source.dropFirst("shared:".count))
        Task { _ = await post("/api/enterprise/skill-run", ["sharedId": sharedID]) }
    }

    /// Publishes one of this Mac's skills to a space, or to the whole organization with `spaceID` nil.
    public func publish(_ skill: Skill, spaceID: String?) async -> Outcome {
        guard let data = try? JSONEncoder().encode(skill.steps),
              let steps = try? JSONSerialization.jsonObject(with: data) else { return .failed("that skill can't be shared") }
        var body: [String: Any] = ["skill": ["id": skill.id, "name": skill.name, "summary": skill.summary, "steps": steps]]
        body["spaceId"] = spaceID ?? NSNull()
        let reply = await post("/api/enterprise/publish", body)
        if let error = reply.error { return .failed(error) }
        return .ok
    }

    // MARK: Wire

    private struct Reply {
        var json: [String: Any]?
        var error: String?
    }

    private func post(_ path: String, _ body: [String: Any]) async -> Reply {
        guard let store else { return Reply(error: "not ready") }
        let base = store.settings.convexSiteURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !base.isEmpty, let url = URL(string: base + path) else { return Reply(error: "sync isn't set up") }
        guard let secret = KeyStore.deviceToken, !secret.isEmpty else { return Reply(error: "sync isn't signed in") }
        let account = store.activeAccount.kind == .work ? store.currentAccountID : store.settings.workerAccountID
        guard !account.isEmpty else { return Reply(error: "pick a work account first") }
        var payload = body
        payload["accountId"] = account
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return Reply(error: "bad request") }
        request.httpBody = data
        do {
            let (bytes, response) = try await session.data(for: request)
            let json = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let message = json?["error"] as? String ?? (http.statusCode == 401 ? "sync secret rejected" : "HTTP \(http.statusCode)")
                lastError = message
                return Reply(json: json, error: message)
            }
            if let message = json?["error"] as? String { lastError = message; return Reply(json: json, error: message) }
            lastError = nil
            return Reply(json: json)
        } catch {
            lastError = error.localizedDescription
            return Reply(error: error.localizedDescription)
        }
    }
}

public struct EnterpriseError: Error, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
}
