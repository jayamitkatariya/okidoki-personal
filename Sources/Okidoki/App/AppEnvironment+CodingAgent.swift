import AppKit
import Foundation
import OkidokiCore

/// One job waiting for, or running in, a coding agent. Kept in memory: a job prepared before a restart is
/// asked for again rather than run blind.
struct CodingAgentJob {
    var task: String
    var agentID: String
    /// Exact tool rules the person okayed after the agent was denied them.
    var allow: [String]
}

@MainActor private var codingAgentJobs: [String: CodingAgentJob] = [:]

/// Coding agents (Claude Code, Codex, Amp, Pi, OpenCode, Gemini CLI, Cursor Agent, or a custom command)
/// take the jobs that need files, the terminal or code. The brain runs the agent's CLI non-interactively in
/// the working folder and streams what it does; this side owns the run, its steps, approvals and the chat.
extension AppEnvironment {
    var codingAgentSettings: CodingAgentSettings { store.settings.codingAgents }

    /// The agents that are on, for /think, or nil when none are (or auto routing is off).
    func codingAgentsPayload(threadID: String?) -> BrainCodingAgentsPayload? {
        let settings = codingAgentSettings
        let on = settings.enabled
        guard !on.isEmpty, settings.autoRoute else { return nil }
        return BrainCodingAgentsPayload(
            agents: on.map { .init(id: $0.id, name: $0.name) },
            defaultId: settings.pick(nil)?.id ?? "",
            folder: settings.folder(vault: store.settings.vaultFolder),
            threadAgent: threadID.flatMap(lastAgentRun(threadID:))?.agentID)
    }

    /// The last coding agent run in a conversation, which a follow-up resumes.
    func lastAgentRun(threadID: String) -> AgentRun? {
        store.runs.first { $0.threadID == threadID && $0.kind == .codingAgent && $0.agentID != nil }
    }

    /// Where an agent's program is: its own override, else found on this Mac's paths. Custom agents run
    /// their command through zsh, so they need nothing found.
    func codingAgentBinary(_ agent: CodingAgentConfig) -> String? {
        guard let preset = CodingAgentCatalog.preset(agent.id) else { return agent.command.isEmpty ? nil : "/bin/zsh" }
        let override = agent.command.trimmingCharacters(in: .whitespaces)
        let paths = CodingAgentCatalog.searchPaths()
        return CodingAgentCatalog.locate(override.isEmpty ? preset.binary : (override as NSString).expandingTildeInPath, in: paths)
    }

    /// Whether a job needs the person's okay before it starts: full access, or an agent with no permission layer.
    func codingAgentNeedsOK(_ agent: CodingAgentConfig) -> Bool {
        agent.access == "full" || agent.isCustom || CodingAgentCatalog.preset(agent.id)?.unguarded == true
    }

    /// What the agent may touch, in plain words, for the preview.
    func codingAgentAccessLine(_ agent: CodingAgentConfig, folder: String) -> String {
        let place = folder.replacingOccurrences(of: NSHomeDirectory(), with: "~")
        if agent.isCustom { return "a custom command: it can do anything your user can, starting in \(place)" }
        if CodingAgentCatalog.preset(agent.id)?.unguarded == true { return "no permission layer: it can run any command, starting in \(place)" }
        if agent.access == "full" { return "full access: any file, any command, starting in \(place)" }
        switch agent.id {
        case "claude": return "edits files in \(place) and runs safe commands there; deleting, installing and sending come back to you"
        case "codex": return "writes only inside \(place), no network (Codex's workspace sandbox)"
        case "gemini": return "edits files in \(place); shell commands are not allowed"
        default: return "works in \(place) under \(agent.name)'s own permission rules"
        }
    }

    /// Picked "Agent" in the composer: the job goes straight to the coding agent. False when there's nothing
    /// to do it with, after saying so.
    func delegateToCodingAgent(text: String, appName: String, threadID: String?, source: String) async -> Bool {
        let thread = threadID.flatMap { store.thread($0) } ?? store.createThread(title: String(text.prefix(60)), app: appName, topic: inferTopic(text))
        store.appendMessage(threadID: thread.id, role: .user, text: text)
        // A new session gets the conversation so far; a resumed one already has it.
        var task = text
        if lastAgentRun(threadID: thread.id)?.agentSession == nil {
            let earlier = (store.thread(thread.id)?.messages ?? []).dropLast().suffix(6)
                .map { "\($0.role == .user ? "them" : "okidoki"): \($0.text.prefix(600))" }
            if !earlier.isEmpty { task += "\n\nEarlier in this conversation:\n" + earlier.joined(separator: "\n") }
        }
        prepareCodingAgent(task: task, agentID: lastAgentRun(threadID: thread.id)?.agentID, title: String(text.prefix(60)),
                           answer: "", prompt: text, threadID: thread.id, source: source)
        return true
    }

    /// Sets up a coding agent run: starts it at once when the agent's own sandbox keeps it to the working
    /// folder, or waits for the person's okay when it has wider access.
    func prepareCodingAgent(task: String, agentID: String?, title: String, answer: String, prompt: String,
                            threadID: String, source: String, allow: [String] = []) {
        guard let agent = codingAgentSettings.pick(agentID) else {
            let text = "no coding agent is on yet. turn one on in Settings → Agents (Claude Code, Codex, Amp…) and i'll hand this to it."
            let run = store.createRun(kind: .answer, title: "no coding agent", prompt: prompt, threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: text, runID: run.id)
            let card = AnswerCardModel(title: "no coding agent", text: text,
                                       actions: [CardAction(title: "settings", kind: .secondary, glyph: "gear") { [weak self] in self?.openDashboard(.settings) }],
                                       threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
            present(card, source: source)
            return
        }
        let folder = codingAgentSettings.folder(vault: store.settings.vaultFolder)
        let resumes = lastAgentRun(threadID: threadID).flatMap { $0.agentID == agent.id ? $0.agentSession : nil }
        let access = codingAgentAccessLine(agent, folder: folder)
        // Wider access, an agent with no permission layer, or steps it was denied: the person okays it first.
        let needsOK = codingAgentNeedsOK(agent) || !allow.isEmpty
        // "Bash(cp *)" reads as "cp"; an exact okay like "Bash(rm notes.txt)" reads as "rm notes.txt".
        let allowed = allow.map { $0.replacingOccurrences(of: #"^Bash\((.*?)( \*)?\)$"#, with: "$1", options: .regularExpression) }
        let steps = [RunStep(title: "start \(agent.name) in \(URL(fileURLWithPath: folder).lastPathComponent)")]
        let preview = ActionPreview(summary: "\(agent.name) · \(task.prefix(160))", risk: needsOK ? .high : .medium,
                                    steps: [PreviewStep("\(agent.name) works on it in \(folder)"),
                                            PreviewStep("anything risky comes back to you"),
                                            PreviewStep("its answer lands here")],
                                    commands: [access] + (allowed.isEmpty ? [] : ["also allows: " + allowed.joined(separator: ", ")]),
                                    apps: [agent.name], files: [folder])
        let run = store.createRun(kind: .codingAgent, title: title.isEmpty ? String(prompt.prefix(60)) : title, prompt: prompt,
                                  threadID: threadID, preview: preview, steps: steps, status: needsOK ? .waiting : .running)
        store.updateRun(run.id) { $0.agentID = agent.id; $0.agentSession = resumes }
        codingAgentJobs[run.id] = CodingAgentJob(task: task, agentID: agent.id, allow: allow)
        let lead = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        if needsOK {
            store.appendMessage(threadID: threadID, role: .assistant,
                                text: allowed.isEmpty ? "prepared it for \(agent.name) (\(access)). waiting for your okay."
                                    : "okay it and \(agent.name) carries on in the same session, allowed to run \(allowed.joined(separator: ", ")).", runID: run.id)
            let card = AnswerCardModel(title: run.title, text: lead.isEmpty ? "\(agent.name) will do this with \(access)." : lead,
                                       actions: [CardAction(title: "do it", kind: .primary, glyph: "bolt") { [weak self] in self?.approveRun(run.id) }],
                                       threadTitle: store.thread(threadID)?.title, runID: run.id, threadID: threadID)
            card.footnote = "\(agent.name) · needs your okay"
            present(card, source: source)
        } else {
            store.appendMessage(threadID: threadID, role: .assistant,
                                text: resumes == nil ? "handed it to \(agent.name)." : "back to \(agent.name), same session.", runID: run.id)
            store.startRun(run.id)
            Task { await executeCodingAgent(store.run(run.id) ?? run) }
        }
        store.saveNow()
    }

    func executeCodingAgent(_ run: AgentRun) async {
        guard let job = codingAgentJobs[run.id] else {
            store.finishRun(run.id, status: .failed, summary: "this was prepared before okidoki restarted. ask again and i'll hand it over fresh.")
            store.saveNow()
            return
        }
        // Couldn't start: the run fails and the conversation says why, instead of ending on "handed it to …".
        func cannotStart(_ why: String) {
            codingAgentJobs[run.id] = nil
            store.finishRun(run.id, status: .failed, summary: why)
            if let threadID = run.threadID { store.appendMessage(threadID: threadID, role: .assistant, text: why, runID: run.id) }
            store.saveNow()
        }
        guard let agent = codingAgentSettings.agents.first(where: { $0.id == job.agentID && $0.enabled }) else {
            cannotStart("that coding agent was turned off in Settings.")
            return
        }
        guard let binary = codingAgentBinary(agent) else {
            cannotStart(agent.isCustom ? "this custom agent has no command." : "\(agent.name) isn't installed on this Mac (looked for `\(CodingAgentCatalog.preset(agent.id)?.binary ?? agent.id)`). install it or set its path in Settings → Agents.")
            return
        }
        guard sidecar.status.isReady else {
            cannotStart("the brain isn't running, so coding agents can't either. try again in a moment.")
            return
        }
        let folder = codingAgentSettings.folder(vault: store.settings.vaultFolder)
        store.updateRun(run.id) { current in
            if current.steps.indices.contains(0) {
                current.steps[0].status = .done
                current.steps[0].startedAt = current.startedAt ?? Date()
                current.steps[0].endedAt = Date()
            }
        }
        var body: [String: Any] = [
            "runId": run.id,
            "agent": agent.isCustom ? "custom" : agent.id,
            "prompt": job.task,
            "cwd": folder,
            "access": agent.access,
            "path": CodingAgentCatalog.searchPaths(),
            "allow": job.allow,
            "engine": store.settings.codingAgents.useEngine,
        ]
        if agent.isCustom { body["template"] = agent.command } else { body["binary"] = binary }
        if let session = store.run(run.id)?.agentSession { body["sessionId"] = session }

        let end = await BrainClient.shared.codingAgentStream(body) { [weak self] event in
            self?.applyCodingAgentEvent(event, runID: run.id)
        }
        codingAgentJobs[run.id] = nil
        finishCodingAgent(runID: run.id, agent: agent, job: job, end: end)
    }

    private func applyCodingAgentEvent(_ event: CodingAgentEvent, runID: String) {
        guard store.run(runID)?.status == .running || store.run(runID)?.status == .paused else { return }
        store.updateRun(runID) { run in
            switch event.type {
            case "session":
                if let id = event.id, !id.isEmpty { run.agentSession = id }
            case "tool":
                let line = "\(event.name ?? "tool") · \(event.detail ?? "")"
                run.output += (run.output.isEmpty ? "" : "\n") + "› " + line
                // The latest steps stay; a long job would otherwise grow the run without end.
                if let last = run.steps.lastIndex(where: { $0.status == .running }) { run.steps[last].status = .done; run.steps[last].endedAt = Date() }
                run.steps.append(RunStep(id: event.id ?? UUID().uuidString, title: line, status: .running, startedAt: Date()))
                if run.steps.count > 80 { run.steps.removeFirst(run.steps.count - 80) }
            case "tool_done":
                if let index = run.steps.lastIndex(where: { $0.id == event.id && $0.status == .running })
                    ?? run.steps.lastIndex(where: { $0.status == .running }) {
                    run.steps[index].status = event.ok == false ? .failed : .done
                    run.steps[index].endedAt = Date()
                    if let detail = event.detail, !detail.isEmpty { run.steps[index].detail = String(detail.prefix(300)) }
                }
            case "text", "log":
                let text = (event.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return }
                run.output += (run.output.isEmpty ? "" : "\n") + text.prefix(2000)
            default:
                break
            }
            if run.output.count > 60_000 { run.output = String(run.output.suffix(50_000)) }
        }
    }

    private func finishCodingAgent(runID: String, agent: CodingAgentConfig, job: CodingAgentJob, end: CodingAgentEnd?) {
        guard let run = store.run(runID) else { return }
        store.updateRun(runID) { current in
            for index in current.steps.indices where current.steps[index].status == .running {
                current.steps[index].status = end?.ok == true ? .done : .failed
                current.steps[index].endedAt = Date()
            }
            if let session = end?.sessionId, !session.isEmpty { current.agentSession = session }
        }
        if run.status == .cancelled || end?.stopped == true {
            if store.run(runID)?.status != .cancelled { store.finishRun(runID, status: .cancelled, summary: "you stopped \(agent.name)") }
            store.saveNow()
            return
        }
        guard let end else {
            store.finishRun(runID, status: .failed, summary: "lost touch with \(agent.name) through the brain. check the working folder before retrying.")
            store.saveNow()
            return
        }
        let answer = end.answer.trimmingCharacters(in: .whitespacesAndNewlines)
        let denials = end.denials ?? []
        let threadID = run.threadID
        if !end.ok, denials.isEmpty {
            let why = (end.error ?? "it stopped without an answer").trimmingCharacters(in: .whitespacesAndNewlines)
            store.finishRun(runID, status: .failed, summary: "\(agent.name): \(why.prefix(300))")
            if let threadID { store.appendMessage(threadID: threadID, role: .assistant, text: answer.isEmpty ? "\(agent.name) didn't finish: \(why.prefix(300))" : answer, runID: runID) }
            toast(title: "\(agent.name) didn't finish", detail: String(why.prefix(140)), kind: .warning, undoLabel: nil, onUndo: nil,
                  editLabel: "open run", onEdit: { [weak self] in self?.openDashboard(.runs, runID: runID) }, runID: runID)
            store.saveNow()
            return
        }
        let summary = "\(agent.name) · \(end.tools ?? 0) tool \((end.tools ?? 0) == 1 ? "call" : "calls")"
        store.finishRun(runID, status: .done, summary: answer.isEmpty ? summary : String(answer.prefix(400)))
        var text = answer.isEmpty ? "\(agent.name) finished." : answer
        if !denials.isEmpty {
            text += "\n\n\(agent.name) stopped short of \(denials.count == 1 ? "one step" : "\(denials.count) steps") that need your okay:\n"
                + denials.prefix(8).map { "· \($0.tool): `\($0.detail.prefix(200))`" }.joined(separator: "\n")
        }
        if let threadID { store.appendMessage(threadID: threadID, role: .assistant, text: text, runID: runID) }
        if !denials.isEmpty, let threadID {
            // The denied steps become a plan waiting for an okay, in the chat and the notch like any other:
            // approving it resumes the same session with just those programs allowed.
            // What was okayed in earlier rounds stays okayed; otherwise round three is denied round one's programs again.
            let rules = Array(Set(job.allow + denials.flatMap(\.rules))).sorted()
            prepareCodingAgent(task: "The person okayed the steps you were denied; go ahead with them and finish the job: "
                                + denials.map { String($0.detail.prefix(400)) }.joined(separator: "; "),
                               agentID: agent.id, title: run.title, answer: text, prompt: run.prompt, threadID: threadID,
                               source: "followup", allow: rules)
            store.saveNow()
            return
        }
        let card = AnswerCardModel(title: run.title, text: text,
                                   actions: [CardAction(title: "details", kind: .ghost, glyph: "grid") { [weak self] in self?.openDashboard(.runs, runID: runID) }],
                                   threadTitle: threadID.flatMap { store.thread($0)?.title }, runID: runID, threadID: threadID)
        card.footnote = summary
        present(card, source: "connector")
        toast(title: "done", detail: String((answer.isEmpty ? summary : answer).prefix(140)), kind: .success, undoLabel: nil, onUndo: nil,
              editLabel: "details", onEdit: { [weak self] in self?.openDashboard(.runs, runID: runID) }, runID: runID)
        store.saveNow()
    }
}

// MARK: - Brain stream

struct CodingAgentEvent: Decodable {
    var type: String
    var id: String?
    var text: String?
    var name: String?
    var detail: String?
    var ok: Bool?
}

struct CodingAgentDenial: Decodable {
    var tool: String
    var detail: String
    /// What would allow it: the programs it ran, as Claude Code rules ("Bash(rm *)").
    var rules: [String]
}

struct CodingAgentEnd: Decodable {
    var ok: Bool
    var answer: String
    var sessionId: String?
    var denials: [CodingAgentDenial]?
    var stopped: Bool?
    var error: String?
    var tools: Int?
}

extension BrainClient {
    /// Runs one coding agent job through the brain, handing each event to `onEvent` as it happens.
    /// Nil when the brain couldn't be reached or the stream broke before the end.
    func codingAgentStream(_ body: [String: Any], onEvent: @escaping (CodingAgentEvent) -> Void) async -> CodingAgentEnd? {
        struct Line: Decodable {
            var type: String
            var event: CodingAgentEvent?
        }
        // Long silences are normal while an agent thinks; the brain's own timeout ends a stuck job.
        var request = drivingRequest(path: "agent/run/stream", timeout: 60 * 35)
        request.setValue(nil, forHTTPHeaderField: "x-anthropic-key")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8), let item = try? JSONDecoder().decode(Line.self, from: data) else { continue }
                if item.type == "event", let event = item.event {
                    onEvent(event)
                } else if item.type == "end" {
                    return try? JSONDecoder().decode(CodingAgentEnd.self, from: data)
                }
            }
        } catch {
            return nil
        }
        return nil
    }
}

// MARK: - Settings

/// What Settings shows for each known agent: found or not, and what it may touch.
struct DashboardCodingAgentPayload: Encodable {
    var id: String
    var name: String
    var path: String?
    var verified: String
    var unguarded: Bool
    var site: String
}

struct DashboardCodingAgentsPayload: Encodable {
    var detected: [DashboardCodingAgentPayload]
    /// The folder agents work in right now (the setting, or the vault when it's empty).
    var folder: String
    /// Per configured agent: what it may touch, in words.
    var access: [String: String]
}

@MainActor private var detectedAgents: (at: Date, list: [CodingAgentCatalog.Detected])?

extension AppEnvironment {
    /// Detection is a few hundred file checks, so it's cached and refreshed on request or every minute.
    func detectedCodingAgents(refresh: Bool = false) -> [CodingAgentCatalog.Detected] {
        let overrides = Dictionary(codingAgentSettings.agents.filter { !$0.isCustom }.map { ($0.id, $0.command) }, uniquingKeysWith: { a, _ in a })
        if !refresh, let cached = detectedAgents, Date().timeIntervalSince(cached.at) < 60 { return cached.list }
        let list = CodingAgentCatalog.detect(overrides: overrides)
        detectedAgents = (Date(), list)
        return list
    }

    func codingAgentsDashboard() -> DashboardCodingAgentsPayload {
        let folder = codingAgentSettings.folder(vault: store.settings.vaultFolder)
        return DashboardCodingAgentsPayload(
            detected: detectedCodingAgents().map { DashboardCodingAgentPayload(id: $0.id, name: $0.name, path: $0.path, verified: $0.verified, unguarded: $0.unguarded, site: $0.site) },
            folder: folder,
            access: Dictionary(codingAgentSettings.agents.map { ($0.id, codingAgentAccessLine($0, folder: folder)) }, uniquingKeysWith: { a, _ in a }))
    }

    /// A folder picker for where coding agents work.
    func pickCodingAgentFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use folder"
        panel.message = "Coding agents work in this folder"
        panel.directoryURL = URL(fileURLWithPath: codingAgentSettings.folder(vault: store.settings.vaultFolder))
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.settings.codingAgents.workingFolder = url.path
        store.saveNow()
    }
}
