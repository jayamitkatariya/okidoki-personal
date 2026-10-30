import AppKit
import Foundation
import OkidokiCore

extension BrainClient {
    /// One turn of a browser run: the page in, the next actions out. Nil when the brain didn't answer.
    func browserStep(_ body: [String: Any]) async -> [[String: Any]]? {
        var request = drivingRequest(path: "browser/step", timeout: 70)
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return json["actions"] as? [[String: Any]]
        } catch {
            return nil
        }
    }
}

/// Web tasks in okidoki's browser. The agent reads the page as text, acts on elements by number, and
/// every action that works is kept as a skill step (with the selectors to find its element again),
/// so a finished run can be saved and replayed with no model at all.
@MainActor
final class BrowserDriver {
    private weak var env: AppEnvironment?
    private var task: Task<Void, Never>?
    private(set) var runID: String?
    var isActive: Bool { task != nil }
    /// What worked, in order: the skill this run would become.
    private(set) var learned: [SkillStep] = []
    static let maxTurns = 40

    init(environment: AppEnvironment) { self.env = environment }

    func begin(run: AgentRun) {
        guard let env, task == nil else {
            env?.store.finishRun(run.id, status: .failed, summary: "the browser is busy with another task — let it finish or stop it first")
            return
        }
        let browser = env.browser
        runID = run.id
        learned = []
        browser.showQuietly()
        browser.beginWork("browsing · \(run.title)")
        browser.onEscape = { [weak self] in self?.cancel(reason: "you stopped me") }
        task = Task { [weak self] in
            await self?.drive(run: run, browser: browser)
        }
    }

    func cancel(reason: String) {
        guard let runID, let env else { return }
        task?.cancel()
        task = nil
        env.browser.endWork()
        env.store.finishRun(runID, status: .cancelled, summary: reason)
        env.store.saveNow()
        self.runID = nil
    }

    private func drive(run: AgentRun, browser: BrowserWindowController) async {
        guard let env else { return }
        var results: [[String: Any]] = []
        var lookNext = false
        var extracted: Any?
        let logins = env.vault.logins.map { BrowserSteps.host(of: $0.site).isEmpty ? $0.site : BrowserSteps.host(of: $0.site) }
        for step in 0..<Self.maxTurns {
            if Task.isCancelled { return }
            await browser.settle(limit: 6)
            let page = await browser.snapshot()
            var observation: [String: Any] = ["url": page.url, "title": page.title, "elements": page.elements, "text": page.text]
            if !page.downloads.isEmpty { observation["downloads"] = page.downloads }
            // A blank or unreadable page gets a look even if the model didn't ask.
            if lookNext || (page.count == 0 && !page.url.isEmpty && !page.url.hasPrefix("about:")),
               let shot = await browser.screenshot() {
                observation["screenshotBase64"] = shot.base64EncodedString()
            }
            lookNext = false
            let body: [String: Any] = [
                "runID": run.id, "goal": run.prompt, "step": step, "observation": observation,
                "results": results, "logins": logins, "settings": ["claudeModel": env.store.settings.claudeModel],
            ]
            guard let actions = await BrainClient.shared.browserStep(body) else {
                if Task.isCancelled { return }
                finish(run, success: false, summary: "the brain didn't answer, so i stopped. try again in a moment.")
                return
            }
            if Task.isCancelled { return }
            results = []
            var halted = false
            for action in actions {
                if Task.isCancelled { return }
                if halted { results.append(["ok": false, "detail": "not run: an earlier action failed"]); continue }
                let type = action["type"] as? String ?? ""
                switch type {
                case "finish":
                    if let extracted { env.store.updateRun(run.id) { $0.output = Self.json(extracted) } }
                    finish(run, success: action["success"] as? Bool ?? false, summary: action["summary"] as? String ?? "done")
                    return
                case "ask":
                    ask(run, question: action["question"] as? String ?? "what should i do next?")
                    return
                case "screenshot":
                    lookNext = true
                    results.append(["ok": true])
                case "extract":
                    extracted = action["data"]
                    results.append(["ok": true])
                default:
                    let outcome = await perform(type, action, browser: browser, url: page.url)
                    results.append(outcome.ok ? ["ok": true] : ["ok": false, "detail": outcome.detail ?? "didn't work"])
                    if outcome.ok, let line = outcome.line { browser.updateWork(line) }
                    if !outcome.ok { halted = true }
                }
            }
        }
        finish(run, success: false, summary: "that took more than \(Self.maxTurns) turns, so i stopped. it may be most of the way there.")
    }

    private struct Outcome { var ok: Bool; var detail: String?; var line: String? }

    private func perform(_ type: String, _ action: [String: Any], browser: BrowserWindowController, url: String) async -> Outcome {
        guard let env else { return Outcome(ok: false) }
        let gap = 0.6
        switch type {
        case "navigate":
            guard let raw = action["url"] as? String, let target = BrowserSteps.addressURL(raw) else { return Outcome(ok: false, detail: "not a URL") }
            await browser.navigate(target)
            learned.append(BrowserSteps.navigate(target.absoluteString, delay: gap))
            return Outcome(ok: true, line: "opening \(BrowserSteps.displayURL(target.absoluteString))")
        case "back":
            await browser.goBack()
            return Outcome(ok: true, line: "going back")
        case "fill_login":
            let site = action["site"] as? String ?? BrowserSteps.host(of: url)
            guard let login = env.vaultLogin(for: site) else {
                return Outcome(ok: false, detail: "no saved login for \(site), or the vault is locked on this Mac (turn on “remember on this Mac” in Vault)")
            }
            let result = await browser.fillLogin(username: login.username, password: login.password)
            if result.ok { learned.append(BrowserSteps.login(site: login.site, url: url, delay: gap)) }
            return Outcome(ok: result.ok, detail: result.detail, line: "signing in to \(login.site)")
        case "click", "type", "select", "press", "scroll":
            var payload: [String: Any] = ["action": type]
            if let ref = action["ref"] as? Int { payload["ref"] = ref }
            if let text = action["text"] as? String { payload["text"] = text }
            if let submit = action["submit"] as? Bool { payload["submit"] = submit }
            if let value = action["value"] as? String { payload["value"] = value }
            if let key = action["key"] as? String { payload["key"] = key }
            if let direction = action["direction"] as? String { payload["direction"] = direction }
            let result = await browser.act(payload)
            guard result.ok else { return Outcome(ok: false, detail: result.detail) }
            if ["click", "press"].contains(type) || payload["submit"] as? Bool == true {
                try? await Task.sleep(nanoseconds: 120_000_000)
                await browser.settle(limit: 6)
            }
            // Scrolling isn't part of the skill: a replay finds elements wherever they are.
            guard type != "scroll" else { return Outcome(ok: true, line: "scrolling") }
            let input: String? = type == "type" ? payload["text"] as? String : type == "select" ? payload["value"] as? String
                : type == "press" ? (payload["key"] as? String ?? "Enter") : nil
            learned.append(.browser(type, text: BrowserSteps.line(type, label: result.label, input: input), url: url,
                                    selectors: result.selectors, label: result.label, role: result.role, input: input, delay: gap))
            if type == "type", payload["submit"] as? Bool == true {
                learned.append(.browser("press", text: BrowserSteps.line("press", label: nil, input: "Enter"), url: url,
                                        selectors: result.selectors, input: "Enter", delay: 0.2))
            }
            return Outcome(ok: true, line: BrowserSteps.line(type, label: result.label, input: input))
        default:
            return Outcome(ok: false, detail: "unknown action \(type)")
        }
    }

    private func finish(_ run: AgentRun, success: Bool, summary: String) {
        guard let env else { return }
        task = nil
        runID = nil
        env.browser.endWork()
        env.store.finishRun(run.id, status: success ? .done : .failed, summary: summary)
        if let threadID = run.threadID { env.store.appendMessage(threadID: threadID, role: .assistant, text: summary, runID: run.id) }
        env.browserRunFinished(run, success: success, summary: summary, learned: success ? learned : [])
        env.store.saveNow()
    }

    private func ask(_ run: AgentRun, question: String) {
        guard let env else { return }
        task = nil
        runID = nil
        env.browser.endWork()
        env.store.finishRun(run.id, status: .asked, summary: question)
        if let threadID = run.threadID { env.store.appendMessage(threadID: threadID, role: .assistant, text: question, runID: run.id) }
        env.presentDriveQuestion(runID: run.id, question: question)
        env.store.saveNow()
    }

    static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else {
            return String(describing: value)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

/// Replays a browser skill in okidoki's browser. Each element is found by the selectors saved with
/// it; when the first ones stopped working and a later one found it, the skill is updated so the next
/// replay goes straight there. Only when none find it does the brain look, for that one step.
@MainActor
final class BrowserReplayer {
    private weak var env: AppEnvironment?
    private var task: Task<Void, Never>?
    private(set) var runID: String?
    var isActive: Bool { task != nil }

    init(environment: AppEnvironment) { self.env = environment }

    func begin(skill: Skill, runID: String, times: Int, values: [[String: String]]) {
        guard let env, task == nil else { env?.failReplay(runID: runID, reason: "a replay is already running in the browser"); return }
        let builtins = ParameterFill.builtins()
        let passValues = values.isEmpty ? [builtins] : values.map { builtins.merging($0) { _, given in given } }
        let needed = ParameterFill.names(in: skill.steps)
        for given in passValues where !needed.isEmpty {
            let missing = ParameterFill.fill(needed.map { "{{\($0)}}" }.joined(separator: " "), values: given).missing
            guard missing.isEmpty else {
                env.failReplay(runID: runID, reason: "“\(skill.name)” needs \(missing.joined(separator: ", ")) — add \(missing[0])=… to the request")
                return
            }
        }
        self.runID = runID
        let browser = env.browser
        browser.showQuietly()
        browser.beginWork("replaying “\(skill.name)”")
        browser.onEscape = { [weak self] in self?.cancel(reason: "you stopped me") }
        let passes = values.isEmpty ? max(1, times) : values.count
        task = Task { [weak self] in
            guard let self else { return }
            var healed = skill.steps
            var changed = false
            for pass in 1...passes {
                let given = passValues[(pass - 1) % passValues.count]
                for (index, step) in skill.steps.enumerated() {
                    if Task.isCancelled { return }
                    self.mark(index, .running, total: skill.steps.count, pass: pass, of: passes, text: ParameterFill.fill(step.text, values: given).text)
                    switch await self.perform(step, values: given, browser: browser) {
                    case .done:
                        break
                    case .healed(let selectors):
                        healed[index].selectors = selectors
                        changed = true
                    case .failed(let reason):
                        self.mark(index, .failed, total: skill.steps.count, pass: pass, of: passes, text: step.text)
                        if changed { env.store.updateSkillSteps(skill.id, healed) }
                        self.end()
                        env.failReplay(runID: runID, reason: "step \(index + 1) (\(step.text)): \(reason)")
                        return
                    }
                    self.mark(index, .done, total: skill.steps.count, pass: pass, of: passes, text: step.text)
                }
            }
            if changed { env.store.updateSkillSteps(skill.id, healed) }
            self.end()
            env.finishReplay(runID: runID, passes: passes)
        }
    }

    func cancel(reason: String) {
        guard let runID, let env else { return }
        task?.cancel()
        end()
        env.store.finishRun(runID, status: .cancelled, summary: reason)
        env.store.saveNow()
    }

    private func end() {
        task = nil
        runID = nil
        env?.browser.endWork()
    }

    private func mark(_ index: Int, _ status: RunStatus, total: Int, pass: Int, of passes: Int, text: String) {
        guard let env, let runID else { return }
        env.store.updateRun(runID) { run in
            guard run.steps.indices.contains(index) else { return }
            if status == .running { run.steps[index].startedAt = Date() } else { run.steps[index].endedAt = Date() }
            run.steps[index].status = status
            if passes > 1 { run.summary = "pass \(pass) of \(passes)" }
        }
        if status == .running { env.browser.updateWork("\(passes > 1 ? "\(pass)/\(passes) · " : "")step \(index + 1)/\(total) · \(text)") }
    }

    private enum StepOutcome { case done, healed([String]), failed(String) }

    private func perform(_ step: SkillStep, values: [String: String], browser: BrowserWindowController) async -> StepOutcome {
        guard let env else { return .failed("okidoki quit") }
        let action = step.action ?? "click"
        switch action {
        case "navigate":
            guard let url = (step.input ?? step.url).flatMap({ BrowserSteps.addressURL(ParameterFill.fill($0, values: values).text) }) else {
                return .failed("no address")
            }
            await browser.navigate(url)
            return .done
        case "login":
            let site = BrowserSteps.vaultReference(in: step.input ?? "")?.site ?? BrowserSteps.host(of: step.url ?? "")
            guard let login = env.vaultLogin(for: site) else { return .failed("no unlocked vault login for \(site)") }
            let result = await browser.fillLogin(username: login.username, password: login.password)
            return result.ok ? .done : .failed(result.detail ?? "couldn't find the login fields")
        default:
            var input = step.input
            if let raw = input {
                if let ref = BrowserSteps.vaultReference(in: raw) {
                    guard let secret = env.vaultSecret(site: ref.site, field: ref.field) else {
                        return .failed("no unlocked vault login for \(ref.site)")
                    }
                    input = secret
                } else {
                    input = ParameterFill.fill(raw, values: values).text
                }
            }
            var payload: [String: Any] = ["action": action, "selectors": step.selectors ?? []]
            if action == "type" { payload["text"] = input ?? "" }
            if action == "select" { payload["value"] = input ?? "" }
            if action == "press" { payload["key"] = input ?? "Enter" }
            // Pages that build themselves after load: give the element a moment to appear.
            var result = await browser.act(payload)
            var tries = 0
            while !result.ok, result.detail == "not on this page", tries < 12, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                result = await browser.act(payload)
                tries += 1
            }
            if !result.ok {
                // None of the saved ways find it: the brain looks at the page for this one step.
                guard let rescued = await rescue(step, input: input, browser: browser) else {
                    return .failed(result.detail ?? "couldn't find it")
                }
                result = rescued
            }
            if ["click", "press"].contains(action) {
                try? await Task.sleep(nanoseconds: 120_000_000)
                await browser.settle(limit: 6)
            }
            // A later selector found it, or the brain did: put what works first for next time.
            if result.matched > 0 || result.matched == -2 {
                return .healed(Self.reordered(step.selectors ?? [], found: result.selectors))
            }
            return .done
        }
    }

    /// The fresh selectors first, then the old ones that still differ, so the skill keeps its fallbacks.
    static func reordered(_ old: [String], found: [String]) -> [String] {
        var out: [String] = []
        for selector in found + old where !out.contains(selector) { out.append(selector) }
        return Array(out.prefix(10))
    }

    /// One step, by the brain: it's told what the step was and picks the element on today's page.
    private func rescue(_ step: SkillStep, input: String?, browser: BrowserWindowController) async -> BrowserActResult? {
        guard let env, env.hasKey("anthropic"), let runID else { return nil }
        let page = await browser.snapshot()
        let goal = """
        Do exactly one step of a recorded skill on this page, then finish: \(step.action ?? "click") \
        \(step.label.map { "the element labelled “\($0)”" } ?? "the element") (role \(step.role ?? "unknown")). \
        It was recorded on \(step.url ?? "this site"). Pick the element that matches it now; don't do anything else.
        """
        let body: [String: Any] = [
            "runID": "\(runID)-rescue-\(step.id)", "goal": goal, "step": 0,
            "observation": ["url": page.url, "title": page.title, "elements": page.elements, "text": String(page.text.prefix(3000))],
            "settings": ["claudeModel": env.store.settings.claudeModel],
        ]
        guard let actions = await BrainClient.shared.browserStep(body),
              let pick = actions.first(where: { $0["ref"] is Int }), let ref = pick["ref"] as? Int else { return nil }
        var payload: [String: Any] = ["action": step.action ?? "click", "ref": ref]
        if step.action == "type" { payload["text"] = input ?? "" }
        if step.action == "select" { payload["value"] = input ?? "" }
        if step.action == "press" { payload["key"] = input ?? "Enter" }
        var result = await browser.act(payload)
        if result.ok { result.matched = -2 }
        return result.ok ? result : nil
    }
}
