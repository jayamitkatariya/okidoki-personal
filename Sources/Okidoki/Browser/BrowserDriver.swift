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

    /// The same turn, streamed: `onAction` runs each action the moment the model has written it (while
    /// it writes the next) and returns false once the run is over, which stops listening. Returns the
    /// actions that didn't stream (nil when the brain didn't answer) and how many did.
    func browserStepStream(_ body: [String: Any], onAction: ([String: Any]) async -> Bool)
        async -> (rest: [[String: Any]]?, received: Int, stopped: Bool) {
        var request = drivingRequest(path: "browser/step/stream", timeout: 70)
        var received = 0
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return (nil, 0, false) }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8),
                      let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                switch item["type"] as? String {
                case "action":
                    guard let action = item["action"] as? [String: Any] else { continue }
                    received += 1
                    if !(await onAction(action)) {
                        bytes.task.cancel()
                        return ([], received, true)
                    }
                case "end":
                    return (item["actions"] as? [[String: Any]] ?? [], received, false)
                default:
                    continue
                }
            }
        } catch {
            return (received > 0 ? [] : nil, received, false)
        }
        return (received > 0 ? [] : nil, received, false)
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
        guard let env, task == nil, !env.browserReplayer.isActive else {
            env?.store.finishRun(run.id, status: .failed, summary: "the browser is busy with another task — let it finish or stop it first")
            return
        }
        let browser = env.browser
        runID = run.id
        // A run that continues after the person answered a question keeps what the first part learned.
        learned = run.threadID.flatMap { env.browserLearnedBeforeQuestion.removeValue(forKey: $0) } ?? []
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

    private func drive(run: AgentRun, browser: BrowserController) async {
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
            if !page.dialogs.isEmpty { observation["dialogs"] = page.dialogs }
            if let loadError = page.loadError { observation["loadError"] = loadError }
            if page.more > 0 { observation["more"] = page.more }
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
            results = []
            var haltReason: String?
            var ended = false
            // One action of this turn. False once the run is over (finished, asked, or stopped).
            let handle: ([String: Any]) async -> Bool = { action in
                if Task.isCancelled { ended = true; return false }
                if let haltReason { results.append(["ok": false, "detail": haltReason]); return true }
                let type = action["type"] as? String ?? ""
                switch type {
                case "finish":
                    if let extracted { self.log(run.id, "data:\n" + Self.json(extracted)) }
                    self.finish(run, success: action["success"] as? Bool ?? false, summary: action["summary"] as? String ?? "done")
                    ended = true
                    return false
                case "ask":
                    self.ask(run, question: action["question"] as? String ?? "what should i do next?")
                    ended = true
                    return false
                case "screenshot":
                    lookNext = true
                    results.append(["ok": true])
                case "extract":
                    extracted = action["data"]
                    results.append(["ok": true])
                case "wait":
                    let seconds = min(10, max(1, (action["seconds"] as? NSNumber)?.doubleValue ?? 2))
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    await browser.settle(limit: 4)
                    results.append(["ok": true])
                default:
                    let outcome = await self.perform(type, action, browser: browser, url: page.url)
                    results.append(outcome.ok ? ["ok": true] : ["ok": false, "detail": outcome.detail ?? "didn't work"])
                    if outcome.ok, let line = outcome.line { browser.updateWork(line) }
                    self.log(run.id, outcome.ok ? "→ \(outcome.line ?? type)" : "✗ \(type): \(outcome.detail ?? "didn't work")")
                    if !outcome.ok { haltReason = "not run: an earlier action failed" }
                    // A click can change what's on the page (or quietly not do what was expected, like an
                    // unavailable size): what was planned after it is checked against a fresh look first.
                    else if outcome.changedPage { haltReason = "not run: the page may have changed after the previous action; check it and act again" }
                }
                return true
            }
            // Streamed: the first action starts while the model is still writing the rest of the turn.
            let turn = await BrainClient.shared.browserStepStream(body, onAction: handle)
            if ended || Task.isCancelled { return }
            guard let rest = turn.rest else {
                finish(run, success: false, summary: "the brain didn't answer, so i stopped. try again in a moment.")
                return
            }
            for action in rest where !(await handle(action)) { return }
            if ended || Task.isCancelled { return }
        }
        finish(run, success: false, summary: "that took more than \(Self.maxTurns) turns, so i stopped. it may be most of the way there.")
    }

    /// `changedPage`: the page may now be different from what the model saw, so the rest of its turn
    /// (planned against the old page) waits for a fresh look.
    private struct Outcome { var ok: Bool; var detail: String?; var line: String?; var changedPage = false }

    /// The run's step log, as the Live page and history show it.
    private func log(_ runID: String, _ line: String) {
        env?.store.updateRun(runID) { run in run.output += (run.output.isEmpty ? "" : "\n") + line }
    }

    private func perform(_ type: String, _ action: [String: Any], browser: BrowserController, url: String) async -> Outcome {
        guard let env else { return Outcome(ok: false) }
        let gap = 0.6
        switch type {
        case "navigate":
            guard let raw = action["url"] as? String, let target = BrowserSteps.addressURL(raw) else { return Outcome(ok: false, detail: "not a URL") }
            await browser.navigate(target)
            learned.append(BrowserSteps.navigate(target.absoluteString, delay: gap))
            return Outcome(ok: true, line: "opening \(BrowserSteps.displayURL(target.absoluteString))", changedPage: true)
        case "back":
            await browser.goBack()
            // Back undoes the wrong turn: the step that led away isn't part of the skill.
            if !learned.isEmpty { learned.removeLast() }
            return Outcome(ok: true, line: "going back", changedPage: true)
        case "fill_login":
            // Only ever the login for the page's own site, whatever site the model names: a page that
            // talks the model into "filling the bank login" here gets nothing.
            let here = BrowserSteps.host(of: browser.webView.url?.absoluteString ?? url)
            let named = action["site"] as? String ?? here
            guard !here.isEmpty, BrowserSteps.sameSite(here, named) else {
                return Outcome(ok: false, detail: "this page is \(here.isEmpty ? "not a website" : here), not \(named); logins are only filled on their own site")
            }
            guard let login = env.vaultLogin(for: here) else {
                return Outcome(ok: false, detail: "no saved login for \(here), or the vault is locked on this Mac (turn on “remember on this Mac” in Vault)")
            }
            let result = await browser.fillLogin(username: login.username, password: login.password)
            if result.ok { learned.append(BrowserSteps.login(site: login.site, url: url, delay: gap)) }
            return Outcome(ok: result.ok, detail: result.detail, line: "signing in to \(login.site)")
        case "click", "hover", "type", "select", "press", "scroll":
            var payload: [String: Any] = ["action": type]
            if let ref = action["ref"] as? Int { payload["ref"] = ref }
            if let text = action["text"] as? String { payload["text"] = text }
            if let submit = action["submit"] as? Bool { payload["submit"] = submit }
            if let value = action["value"] as? String { payload["value"] = value }
            if let key = action["key"] as? String { payload["key"] = key }
            if let direction = action["direction"] as? String { payload["direction"] = direction }
            let addressBefore = browser.webView.url
            let result = await browser.act(payload)
            guard result.ok else { return Outcome(ok: false, detail: result.detail) }
            // A choice in a dropdown can load a page too (a shop's size picker).
            if ["click", "press", "select"].contains(type) || payload["submit"] as? Bool == true {
                // Whatever the action set off (a new page, results arriving) gets its moment, no longer.
                await browser.settle(limit: 6, fresh: true)
            } else if type == "hover" {
                await browser.settle(limit: 1.5, fresh: true)
            }
            let formControl = ["checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "select"].contains(result.role ?? "")
            let changedPage = browser.webView.url != addressBefore
                || (type == "click" && !formControl) || type == "press" || payload["submit"] as? Bool == true
            // Scrolling isn't part of the skill: a replay finds elements wherever they are.
            guard type != "scroll" else { return Outcome(ok: true, line: "scrolling") }
            var input: String? = type == "type" ? payload["text"] as? String : type == "select" ? payload["value"] as? String
                : type == "press" ? (payload["key"] as? String ?? "Enter") : nil
            // Whatever went into a password field (a code they gave in an answer, say) isn't kept in the skill.
            if type == "type", result.role == "password" { input = BrowserSteps.vaultPlaceholder(site: BrowserSteps.host(of: url), field: "password") }
            learned.append(.browser(type, text: BrowserSteps.line(type, label: result.label, input: input), url: url,
                                    selectors: result.selectors, label: result.label, role: result.role, input: input, delay: gap))
            if type == "type", payload["submit"] as? Bool == true {
                learned.append(.browser("press", text: BrowserSteps.line("press", label: nil, input: "Enter"), url: url,
                                        selectors: result.selectors, input: "Enter", delay: 0.2))
            }
            // Typed now from the task, not the vault; the saved skill fills it from the vault next time.
            if type == "type", result.role == "password" {
                return Outcome(ok: true, line: "type the password in \(result.label.map { "“\($0)”" } ?? "the field")", changedPage: changedPage)
            }
            return Outcome(ok: true, line: BrowserSteps.line(type, label: result.label, input: input), changedPage: changedPage)
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
        if let threadID = run.threadID { env.browserLearnedBeforeQuestion[threadID] = learned }
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
        guard let env, task == nil, !env.browserDriver.isActive else {
            env?.failReplay(runID: runID, reason: "the browser is busy — let the current task finish or stop it first")
            return
        }
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
                for index in healed.indices {
                    // Later passes use what earlier ones repaired, so a fix is paid for once.
                    let step = healed[index]
                    if Task.isCancelled { return }
                    self.mark(index, .running, total: skill.steps.count, pass: pass, of: passes, text: ParameterFill.fill(step.text, values: given).text)
                    let outcome = await self.perform(step, values: given, browser: browser, pass: pass)
                    // Stopped while that step was in flight: the run is already marked cancelled.
                    if Task.isCancelled || self.runID != runID { return }
                    switch outcome {
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
            if Task.isCancelled || self.runID != runID { return }
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

    private func perform(_ step: SkillStep, values: [String: String], browser: BrowserController, pass: Int) async -> StepOutcome {
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
            let here = BrowserSteps.host(of: browser.webView.url?.absoluteString ?? "")
            // A redirect to some other site since recording: its login fields don't get this site's login.
            guard BrowserSteps.sameSite(here, site) else { return .failed("the page is \(here), not \(site), so the login wasn't filled") }
            guard let login = env.vaultLogin(for: site) else { return .failed("no unlocked vault login for \(site)") }
            let result = await browser.fillLogin(username: login.username, password: login.password)
            return result.ok ? .done : .failed(result.detail ?? "couldn't find the login fields")
        default:
            var input = step.input
            if let raw = input {
                if let ref = BrowserSteps.vaultReference(in: raw) {
                    let here = BrowserSteps.host(of: browser.webView.url?.absoluteString ?? "")
                    guard BrowserSteps.sameSite(here, ref.site) else { return .failed("the page is \(here), not \(ref.site), so the secret wasn't typed") }
                    guard let secret = env.vaultSecret(site: ref.site, field: ref.field) else {
                        let known = ["username", "email", "user", "password"].contains(ref.field)
                        return .failed(known ? "no unlocked vault login for \(ref.site)"
                                             : "this field needs a code or card number only you have; type it, then replay again")
                    }
                    input = secret
                } else {
                    input = ParameterFill.fill(raw, values: values).text
                }
            }
            var payload: [String: Any] = ["action": action, "selectors": step.selectors ?? []]
            if action == "type" { payload["text"] = input ?? "" }
            if action == "type", let kind = Self.secretKind(step) { payload["secret"] = kind }
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
                guard let rescued = await rescue(step, input: input, browser: browser, pass: pass) else {
                    return .failed(result.detail ?? "couldn't find it")
                }
                result = rescued
            }
            if ["click", "press"].contains(action) {
                await browser.settle(limit: 6, fresh: true)
            } else if action == "hover" {
                await browser.settle(limit: 1.5, fresh: true)
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

    /// Which vault field a typing step fills, so the page can refuse to put it anywhere else: a shared
    /// skill must not be able to type the password into a search box or a comment on the same site.
    static func secretKind(_ step: SkillStep) -> String? {
        guard let ref = BrowserSteps.vaultReference(in: step.input ?? "") else { return nil }
        return ref.field == "password" ? "password" : "username"
    }

    /// One step, by the brain: it's told what the step was and picks the element on today's page.
    private func rescue(_ step: SkillStep, input: String?, browser: BrowserController, pass: Int) async -> BrowserActResult? {
        guard let env, env.hasKey("anthropic"), let runID else { return nil }
        let page = await browser.snapshot()
        let action = step.action ?? "click"
        let what = step.label.map { "the element labelled “\($0)”" } ?? "the element"
        // The text itself only when it isn't a secret; the app types the real value either way.
        let typed = (action == "type" && !(step.input ?? "").hasPrefix("{{vault:")) ? " with “\(input ?? "")”" : ""
        let goal = """
        One step of a recorded skill no longer finds its element on this page: \(action) \(what)\(typed) \
        (it was a \(step.role ?? "control") when recorded on \(step.url ?? "this site")). Call \(action == "press" ? "press" : action) \
        once on the element that matches it now, by its number, and nothing else. If nothing on the page matches, finish with success false.
        """
        let body: [String: Any] = [
            // Its own conversation each time, so a second rescue never gets the first one's element number.
            "runID": "\(runID)-rescue-\(step.id)-\(pass)-\(UUID().uuidString.prefix(6))", "goal": goal, "step": 0,
            "observation": ["url": page.url, "title": page.title, "elements": page.elements, "text": String(page.text.prefix(3000))],
            "settings": ["claudeModel": env.store.settings.claudeModel],
        ]
        let actions = await BrainClient.shared.browserStep(body)
        let pick = actions?.first { ($0["ref"] as? NSNumber) != nil }
        guard let ref = (pick?["ref"] as? NSNumber)?.intValue else {
            let said = actions?.first?["summary"] as? String ?? (actions == nil ? "the brain didn't answer" : "no element picked")
            env.store.updateRun(runID) { $0.output += ($0.output.isEmpty ? "" : "\n") + "✗ rescue: \(said)" }
            return nil
        }
        env.store.updateRun(runID) { $0.output += ($0.output.isEmpty ? "" : "\n") + "→ rescued by the model: element \(ref)" }
        var payload: [String: Any] = ["action": step.action ?? "click", "ref": ref]
        if step.action == "type" { payload["text"] = input ?? "" }
        if step.action == "type", let kind = Self.secretKind(step) { payload["secret"] = kind }
        if step.action == "select" { payload["value"] = input ?? "" }
        if step.action == "press" { payload["key"] = input ?? "Enter" }
        var result = await browser.act(payload)
        if result.ok { result.matched = -2 }
        return result.ok ? result : nil
    }
}
