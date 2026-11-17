import Foundation
import OkidokiCore

/// The shared session (stage 3): one Mac hosts its private Mac, everyone on the WiFi joins in a
/// browser. This owns the session's lifecycle and routes its asks through the normal pipeline into
/// the VM — never the host's own screen, replays, vault or memory. See docs/collab.md.
extension AppEnvironment {
    // MARK: Session state

    /// The one conversation a session's okidoki runs live in, so the host sees them in history too.
    private static var collabThreadKey: String { "okidoki.collab.thread" }

    var collabThreadID: String? {
        get { UserDefaults.standard.string(forKey: Self.collabThreadKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.collabThreadKey) }
    }

    func isSessionThread(_ id: String?) -> Bool {
        guard let id, id == collabThreadID else { return false }
        return collab?.session != nil
    }

    private func ensureCollabThread() -> String {
        if let id = collabThreadID, store.thread(id) != nil { return id }
        let thread = store.createThread(title: "shared session", app: "okidoki", topic: "collab")
        collabThreadID = thread.id
        return thread.id
    }

    // MARK: Lifecycle

    func startCollab() {
        guard collab == nil else { return }
        guard PrivateMacService.isSupported else {
            toast(title: "can't share here", detail: "a shared session needs the private Mac, which needs Apple silicon",
                  kind: .warning, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let server = CollabServer(environment: self)
        collab = server
        server.start()
        // Only okidoki's replies from here on reach the group chat, not the session's whole history.
        collabMessageCursor = nil
        _ = collabNewAssistantMessages()
        toast(title: "session live", detail: "everyone on your WiFi can join with the code in Settings",
              kind: .success, undoLabel: nil, onUndo: nil, editLabel: "show", onEdit: { [weak self] in
                  self?.openDashboard(.settings)
              }, runID: nil)
    }

    func stopCollab() {
        collab?.stop()
        collab = nil
        collabThreadID = nil
        collabMessageCursor = nil
        objectWillChange.send()
    }

    func collabKick(_ id: String) {
        collab?.session?.kick(id)
    }

    func collabReclaimWheel() {
        collab?.session?.reclaimWheel()
        collab?.broadcastWheelPublic()
    }

    /// What the host dashboard shows about its session.
    func collabHostState() -> CollabHostStatePayload {
        guard let server = collab, let session = server.session else { return CollabHostStatePayload(active: false) }
        let port = server.port
        let host = Host.current().localizedName ?? "Mac"
        let url = port > 0 ? "http://\(host).local:\(port)/" : nil
        return CollabHostStatePayload(active: true, code: session.code, url: url, port: Int(port),
                                      participants: session.participants, wheelHolder: session.wheelHolder,
                                      runID: session.activeRunID, error: nil)
    }

    // MARK: Tasks

    /// A joiner's ask: the normal pipeline, forced into the private Mac, tagged so they can stop it.
    /// Fire-and-forget from the server's point of view — the chat acks at once, the run appears async.
    func startSessionTask(text: String, requestedBy: String) async {
        guard let server = collab, let session = server.session else { return }
        guard hasKey("anthropic") else {
            server.postOkidoki("the host's Mac has no Anthropic key yet — add one in its Settings.")
            return
        }
        if let active = session.activeRunID, let run = store.run(active), run.status.isActive {
            server.postOkidoki("i'm already working on something — one at a time, please.")
            return
        }
        if let holder = session.wheelHolder, let person = session.participant(id: holder) {
            server.postOkidoki("\(person.name) has the wheel right now — ask them to release it, then try again.")
            return
        }
        let threadID = ensureCollabThread()
        let since = Date().addingTimeInterval(-1)
        await handleRequest(text: text, appName: "mac", bundleID: "", threadID: threadID,
                            screenshot: nil, selection: nil, attachmentName: "", documentText: "",
                            source: "collab", mode: "act")
        var found: AgentRun?
        for _ in 0..<40 {
            found = store.runs.first(where: { $0.threadID == threadID && $0.createdAt >= since })
            if found != nil { break }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        guard let run = found else {
            server.postOkidoki("i couldn't start that — try asking again.")
            return
        }
        if let index = store.runs.firstIndex(where: { $0.id == run.id }) {
            store.runs[index].sessionID = session.code
            store.runs[index].requestedBy = requestedBy
            store.saveNow()
        }
        server.watchRun(run.id)
    }

    // MARK: What joiners see

    func collabVM() -> CollabVM {
        CollabVM(phase: privateMac.phase.rawValue, running: privateMac.isRunning)
    }

    func collabRunSnapshot(id: String?) -> CollabRun? {
        guard let id, let run = store.run(id) else { return nil }
        let steps: [CollabRunStep] = driver.model.runID == id
            ? driver.model.steps.map { CollabRunStep(index: $0.index, say: $0.say, kind: $0.kind, detail: $0.detail, result: $0.result, status: $0.status) }
            : []
        return CollabRun(id: run.id, title: run.title, status: run.status.rawValue, goal: run.prompt,
                         requestedBy: run.requestedBy, needs: ControlServer.needs(run), steps: steps)
    }

    /// The shareable part of the host's skills: names and inputs, never step pictures or secrets.
    func collabSkillCards() -> [CollabSkillCard] {
        store.activeSkills.filter { $0.template != true }.map { skill in
            CollabSkillCard(id: skill.id, name: skill.name, summary: skill.summary, intent: skill.intent,
                            inputs: (skill.inputs ?? []).map { CollabSkillInput(name: $0.name, description: $0.description) })
        }
    }

    /// okidoki's new replies in the session conversation, for the group chat. Advances a cursor so a
    /// reply is posted once. The first call only sets the cursor, never dumps history.
    func collabNewAssistantMessages() -> [String] {
        guard let threadID = collabThreadID, let thread = store.thread(threadID) else { return [] }
        let assistants = thread.messages.filter { $0.role == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard let last = assistants.last else { return [] }
        defer { collabMessageCursor = last.id }
        guard let cursor = collabMessageCursor, let index = assistants.firstIndex(where: { $0.id == cursor }) else { return [] }
        return assistants[(index + 1)...].map(\.text)
    }

    /// Take-the-wheel input: the wheel holder's events, delivered to the guest through the same
    /// ComputerActions okidoki drives it with. Coordinates arrive normalized; the guest display is
    /// the fixed size the model learned, so the mapping is exact. Returns false for a malformed
    /// packet or a guest that isn't up.
    @discardableResult
    func performSessionInput(_ payload: [String: Any]) -> Bool {
        guard privateMac.isRunning else { return false }
        let width = PrivateMacSpec.displayPointWidth
        let height = PrivateMacSpec.displayPointHeight
        guard let action = CollabInput.action(from: payload, width: width, height: height) else { return false }
        let computer = PrivateMacComputer(service: privateMac)
        let box = ScreenBox(x: 0, y: 0, width: width, height: height)
        Task { @MainActor in
            _ = try? await computer.perform(action, screen: box, imageWidth: width, imageHeight: height)
        }
        return true
    }

    /// Whether okidoki is mid-run in the session: the wheel and the agent never drive at once.
    func collabRunIsActive() -> Bool {
        guard let id = collab?.session?.activeRunID, let run = store.run(id) else { return false }
        return run.status.isActive
    }
}

/// The host dashboard's view of its session, encoded into NativeState.collab.
struct CollabHostStatePayload: Encodable {
    var active: Bool
    var code: String? = nil
    var url: String? = nil
    var port: Int? = nil
    var participants: [CollabParticipant]? = nil
    var wheelHolder: String? = nil
    var runID: String? = nil
    var error: String? = nil
}
