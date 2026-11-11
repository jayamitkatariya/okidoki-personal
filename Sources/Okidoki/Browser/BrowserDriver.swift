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
    /// actions that didn't stream (nil when the brain didn't answer), how many did, and the brain's error.
    func browserStepStream(_ body: [String: Any], onAction: ([String: Any]) async -> Bool)
        async -> (rest: [[String: Any]]?, received: Int, stopped: Bool, error: String?) {
        var request = drivingRequest(path: "browser/step/stream", timeout: 70)
        var received = 0
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return (nil, 0, false, "the brain answered \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8),
                      let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                switch item["type"] as? String {
                case "action":
                    guard let action = item["action"] as? [String: Any] else { continue }
                    received += 1
                    if !(await onAction(action)) {
                        bytes.task.cancel()
                        return ([], received, true, nil)
                    }
                case "end":
                    return (item["actions"] as? [[String: Any]] ?? [], received, false, item["error"] as? String)
                default:
                    continue
                }
            }
        } catch {
            return (received > 0 ? [] : nil, received, false, error.localizedDescription)
        }
        return (received > 0 ? [] : nil, received, false, nil)
    }
}

/// Web tasks in okidoki's browser. Each run works in tabs of its own, so several can go at once and the
/// person keeps the tab they're in. This hands out the runs and answers for all of them.
@MainActor
final class BrowserDriver {
    private weak var env: AppEnvironment?
    private var runs: [String: BrowserAgentRun] = [:]
    var isActive: Bool { !runs.isEmpty }
    func isRunning(_ runID: String) -> Bool { runs[runID] != nil }

    init(environment: AppEnvironment) { self.env = environment }

    func begin(run: AgentRun) {
        guard let env, runs[run.id] == nil else { return }
        let agent = BrowserAgentRun(environment: env, run: run) { [weak self] id in self?.runs[id] = nil }
        runs[run.id] = agent
        agent.start()
    }

    func cancel(runID: String, reason: String) {
        runs[runID]?.cancel(reason: reason)
    }

    /// The notch's pause button on a web task: the page is the person's until they take it back.
    func pauseOrTakeBack(runID: String) {
        guard let agent = runs[runID] else { return }
        if agent.personsTurn { agent.takeBack() } else { agent.pause() }
    }

    func takeBack(runID: String) { runs[runID]?.takeBack() }

    func cancelAll(reason: String) {
        for agent in runs.values { agent.cancel(reason: reason) }
    }
}

/// One web task. The agent reads the page as text, acts on elements by number, and every action that
/// works is kept as a skill step (with the selectors to find its element again), so a finished run can
/// be saved and replayed with no model at all.
@MainActor
final class BrowserAgentRun {
    private weak var env: AppEnvironment?
    private let run: AgentRun
    private let ended: (String) -> Void
    private var task: Task<Void, Never>?
    /// The tab the agent is working in now; it may open and move between others.
    private var tab: BrowserTab
    /// What worked, in order: the skill this run would become.
    private(set) var learned: [SkillStep] = []
    /// Some text from each page the run went through, for smart replay's compiler: what the run
    /// didn't use (an optional section, an empty table) is only visible here.
    private var pageTexts: [String: String] = [:]
    static let maxTurns = 80
    /// Times in a row the brain didn't answer before the run gives up.
    static let maxMisses = 3

    init(environment: AppEnvironment, run: AgentRun, ended: @escaping (String) -> Void) {
        self.env = environment
        self.run = run
        self.ended = ended
        self.tab = environment.browser.tabForRun(runID: run.id, threadID: run.threadID,
                                                 preferred: environment.browserRunTabs.removeValue(forKey: run.id))
    }

    func start() {
        guard let env else { return }
        let browser = env.browser
        // A run that continues after the person answered a question keeps what the first part learned.
        learned = run.threadID.flatMap { env.browserLearnedBeforeQuestion.removeValue(forKey: $0) } ?? []
        browser.beginWork("browsing · \(run.title)", in: tab, runID: run.id, threadID: run.threadID) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
        // The person watches the work, unless they're recording in the tab in front.
        browser.presentForWork(tab)
        task = Task { [weak self] in
            await self?.drive()
        }
    }

    func cancel(reason: String) {
        guard let env else { return }
        task?.cancel()
        task = nil
        personHasIt = false
        env.closeHandoffCard(runID: run.id)
        env.browser.endWork(runID: run.id)
        env.store.finishRun(run.id, status: .cancelled, summary: reason)
        env.store.saveNow()
        ended(run.id)
    }

    private var takeBackAsked = false
    /// Paused by the person (the notch, the card, a script): the agent waits before its next turn.
    private(set) var personHasIt = false
    private var handingOff = false
    var personsTurn: Bool { personHasIt || handingOff }

    func pause() {
        guard let env, !personHasIt else { return }
        if handingOff { takeBack(); return }
        personHasIt = true
        takeBackAsked = false
        env.store.updateRun(run.id) { $0.status = .paused; $0.waitingFor = nil }
        log("→ paused — the page is yours")
        env.browser.updateWork("paused — the page is yours", in: tab)
        env.browser.show()
        env.presentHandoff(runID: run.id, title: "paused · the page is yours",
                           text: "Do what you need to on the page. When you take it back, okidoki looks again and carries on from there.",
                           takeBack: { [weak self] in self?.takeBack() },
                           stop: { [weak self] in self?.cancel(reason: "you stopped me") })
    }

    func takeBack() {
        guard let env, personHasIt || handingOff else { return }
        env.store.updateRun(run.id) { $0.status = .running; $0.waitingFor = nil }
        if personHasIt { log("→ taken back — looking at the page again") }
        personHasIt = false
        takeBackAsked = true
        env.closeHandoffCard(runID: run.id)
        env.browser.updateWork("browsing · \(run.title)", in: tab)
    }

    /// Hands the page to the person ("your turn") and waits until the check is gone or they take it back,
    /// up to 10 minutes. False when stopped, timed out, or nobody is at this Mac (a routine).
    private func waitForPerson(_ why: String) async -> Bool {
        guard let env else { return false }
        if env.unattendedRuns.contains(run.id) {
            log("✗ needs a person (\(why)), and nobody is at this Mac")
            return false
        }
        handingOff = true
        defer { handingOff = false }
        takeBackAsked = false
        env.store.updateRun(run.id) { $0.status = .paused; $0.waitingFor = why }
        log("→ your turn: \(why)")
        env.browser.updateWork("your turn: \(why) — okidoki carries on when it's done", in: tab)
        env.browser.show()
        env.browser.select(tab)
        env.presentHandoff(runID: run.id, title: "your turn · \(why)",
                           text: "This page needs a person: \(why). Do it in the browser; okidoki notices when it's done and carries on, or press take back.",
                           takeBack: { [weak self] in self?.takeBack() },
                           stop: { [weak self] in self?.cancel(reason: "you stopped me") })
        let watched = tab
        let checkURL = tab.webView.url?.absoluteString ?? ""
        let ending = await PersonTurn.waitPast(tab: watched, takenBack: { self.takeBackAsked }, alive: { !Task.isCancelled })
        takeBackAsked = false
        guard ending == .cleared || ending == .takenBack else {
            env.closeHandoffCard(runID: run.id)
            return false
        }
        env.store.updateRun(run.id) { if $0.status == .paused { $0.status = .running }; $0.waitingFor = nil }
        env.closeHandoffCard(runID: run.id)
        log("→ thanks — taking it from here")
        env.browser.updateWork("browsing · \(run.title)", in: tab)
        await tab.settle(limit: 4)
        if let pressed = await PersonTurn.continuePast(on: watched, checkURL: checkURL) {
            log("→ pressed “\(pressed)” on the check page")
        }
        return true
    }

    /// The run's tabs for the agent, the one it's in marked.
    private func tabList() -> String {
        guard let env else { return "" }
        let mine = env.browser.tabs(ownedBy: run.id)
        guard mine.count > 1 else { return "" }
        return mine.map { "[\($0.number)]\($0 === tab ? " *" : "") \($0.label) — \($0.address)" }.joined(separator: "\n")
    }

    /// The conversation before this run, for a follow-up to make sense of.
    private func conversation() -> [[String: String]] {
        guard let env, let threadID = run.threadID, let thread = env.store.thread(threadID) else { return [] }
        var messages = thread.messages.filter { $0.runID != run.id }
        // The request that started this run is the task itself, not context.
        if let last = messages.last, last.role == .user, run.prompt.hasPrefix(last.text) { messages.removeLast() }
        return messages.suffix(12).map { ["role": $0.role.rawValue, "text": $0.text] }
    }

    private func drive() async {
        guard let env else { return }
        let browser = env.browser
        var results: [[String: Any]] = []
        var lookNext = false
        var extracted: Any?
        var misses = 0
        let logins = env.vault.logins.map { BrowserSteps.host(of: $0.site).isEmpty ? $0.site : BrowserSteps.host(of: $0.site) }
        let context = conversation()
        let memory = env.store.memoryLines(limit: 40)
        var step = 0
        while step < Self.maxTurns {
            if Task.isCancelled { return }
            // The page closed the tab the agent was in (a sign-in or payment tab that's done): carry on
            // in the tab that opened it, or another of the run's own.
            if !browser.model.tabs.contains(where: { $0 === tab }) {
                let closed = tab
                let next = browser.tab(closed.openedBy).flatMap { $0.ownerRunID == nil || $0.ownerRunID == run.id ? $0 : nil }
                    ?? browser.tabs(ownedBy: run.id).last
                    ?? browser.openTab(activate: false)
                if next.ownerRunID != run.id { claim(next) }
                tab = next
            }
            // Paused: the page is the person's. Once they hand it back the agent looks again, no turn spent.
            if personHasIt {
                while personHasIt, !Task.isCancelled { try? await Task.sleep(nanoseconds: 300_000_000) }
                if Task.isCancelled { return }
                results = [["ok": true, "detail": "the person paused you and used the page; it may have changed — look again before acting"]]
                continue
            }
            await tab.settle(limit: 6)
            // A check only a person can pass (a captcha, "I am human", a one-time code): theirs for a
            // moment, then the agent carries on from wherever the page is. No turn spent on it.
            if let check = await PersonTurn.confirmed(on: tab) {
                guard await waitForPerson(check) else {
                    if !Task.isCancelled { finish(success: false, summary: "stopped at \(check) — it needs a person, and nobody got past it") }
                    return
                }
                results = [["ok": true, "detail": "the person got past \(check); the page may have changed, look again. If the check page is still there with its check passed, pressing its Continue button is fine."]]
                continue
            }
            let page = await tab.snapshot()
            await noteObservation(text: page.text)
            var observation: [String: Any] = ["url": page.url, "title": page.title, "elements": page.elements, "text": page.text]
            if !page.downloads.isEmpty { observation["downloads"] = page.downloads }
            if !page.dialogs.isEmpty { observation["dialogs"] = page.dialogs }
            if let loadError = page.loadError { observation["loadError"] = loadError }
            if page.more > 0 { observation["more"] = page.more }
            let tabs = tabList()
            if !tabs.isEmpty { observation["tabs"] = tabs }
            // A blank or unreadable page gets a look even if the model didn't ask.
            if lookNext || (page.count == 0 && !page.url.isEmpty && !page.url.hasPrefix("about:")),
               let shot = await tab.screenshot() {
                observation["screenshotBase64"] = shot.base64EncodedString()
            }
            lookNext = false
            var body: [String: Any] = [
                "runID": run.id, "goal": run.prompt, "step": step, "observation": observation,
                "results": results, "logins": logins, "settings": ["claudeModel": env.store.settings.claudeModel],
            ]
            if !context.isEmpty { body["context"] = context }
            if !memory.isEmpty { body["memory"] = memory }
            // What the run did, in case the brain lost its side of the conversation.
            if step > 0, let output = env.store.run(run.id)?.output {
                let done = output.split(separator: "\n").filter { $0.hasPrefix("→") || $0.hasPrefix("✗") }.suffix(30).map(String.init)
                if !done.isEmpty { body["progress"] = done }
            }
            var turnResults: [[String: Any]] = []
            var haltReason: String?
            var ended = false
            // One action of this turn. False once the run is over (finished, asked, or stopped).
            let handle: ([String: Any]) async -> Bool = { action in
                if Task.isCancelled { ended = true; return false }
                // Paused while the model was writing: nothing it planned runs on a page that's the person's now.
                if self.personHasIt { turnResults.append(["ok": false, "detail": "not run: the person paused you"]); return true }
                if let haltReason { turnResults.append(["ok": false, "detail": haltReason]); return true }
                let type = action["type"] as? String ?? ""
                switch type {
                case "finish":
                    await self.noteObservation(text: nil)
                    if let extracted { self.log("data:\n" + BrowserAgentRun.json(extracted)) }
                    self.finish(success: action["success"] as? Bool ?? false, summary: action["summary"] as? String ?? "done")
                    ended = true
                    return false
                case "ask":
                    self.ask(question: action["question"] as? String ?? "what should i do next?")
                    ended = true
                    return false
                case "screenshot":
                    lookNext = true
                    turnResults.append(["ok": true])
                case "extract":
                    extracted = action["data"]
                    turnResults.append(["ok": true])
                case "remember":
                    let fact = action["fact"] as? String ?? ""
                    if BrainService.isDurableFact(fact) {
                        // Nil here means it was already known: that's fine too.
                        if env.store.addMemory(fact, section: .aboutYou, source: "browser") != nil { self.log("→ remembered: \(fact)") }
                        turnResults.append(["ok": true])
                    } else {
                        turnResults.append(["ok": false, "detail": "not kept: only lasting facts about the user"])
                    }
                case "dialog":
                    // The next confirm/prompt the page opens is answered this way (OK otherwise).
                    let accept = action["accept"] as? Bool ?? true
                    let text = action["text"] as? String
                    self.tab.dialogAnswer = (accept, text)
                    self.learned.append(BrowserSteps.dialog(accept: accept, text: text, delay: 0.2))
                    self.log("→ the next pop-up gets \(accept ? (text.map { "“\($0)”" } ?? "OK") : "Cancel")")
                    turnResults.append(["ok": true])
                case "wait":
                    let seconds = min(10, max(1, (action["seconds"] as? NSNumber)?.doubleValue ?? 2))
                    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                    await self.tab.settle(limit: 4)
                    turnResults.append(["ok": true])
                default:
                    let outcome = await self.perform(type, action, url: page.url)
                    turnResults.append(outcome.ok ? ["ok": true] : ["ok": false, "detail": outcome.detail ?? "didn't work"])
                    if outcome.ok, let line = outcome.line { browser.updateWork(line, in: self.tab) }
                    self.log(outcome.ok ? "→ \(outcome.line ?? type)" : "✗ \(type): \(outcome.detail ?? "didn't work")")
                    if !outcome.ok { haltReason = "not run: an earlier action failed" }
                    // A click can change what's on the page (or quietly not do what was expected, like an
                    // unavailable size): what was planned after it is checked against a fresh look first.
                    else if outcome.changedPage { haltReason = "not run: the page may have changed after the previous action; check it and act again" }
                }
                return true
            }
            // Streamed: the first action starts while the model is still writing the rest of the turn.
            env.store.countModelCall(run.id)
            let turn = await BrainClient.shared.browserStepStream(body, onAction: handle)
            if ended || Task.isCancelled { return }
            guard let rest = turn.rest, turn.received > 0 || !rest.isEmpty || turn.error == nil else {
                // Nothing came back: ask again with the same page and results, a few times, before giving up.
                misses += 1
                if misses >= Self.maxMisses {
                    finish(success: false, summary: "the model stopped answering (\(turn.error ?? "no reply")), so i stopped. say “try again” and i'll pick it up from here.")
                    return
                }
                log("… the model didn't answer, asking again")
                try? await Task.sleep(nanoseconds: UInt64(misses) * 1_500_000_000)
                continue
            }
            misses = 0
            for action in rest where !(await handle(action)) { return }
            if ended || Task.isCancelled { return }
            results = turnResults
            step += 1
        }
        finish(success: false, summary: "that took more than \(Self.maxTurns) turns, so i stopped. it may be most of the way there — say “keep going” to carry on.")
    }

    /// `changedPage`: the page may now be different from what the model saw, so the rest of its turn
    /// (planned against the old page) waits for a fresh look.
    private struct Outcome { var ok: Bool; var detail: String?; var line: String?; var changedPage = false }

    /// What the page is now, written onto the learned steps that led here (the compiler turns it into
    /// anchors and checks), and the page's text kept once.
    private func noteObservation(text: String?) async {
        let pending = learned.indices.filter { learned[$0].observedAfter == nil }
        let url = tab.webView.url?.absoluteString ?? ""
        guard !pending.isEmpty || (!url.isEmpty && pageTexts[url] == nil) else { return }
        let seen = await tab.stepObservation()
        for index in pending { learned[index].observedAfter = seen }
        if !url.isEmpty, pageTexts[url] == nil {
            var body = text ?? ""
            if text == nil { body = await tab.pageText() }
            pageTexts[url] = String(body.prefix(2000))
        }
    }

    /// The run's step log, as the Live page and history show it.
    private func log(_ line: String) {
        env?.store.updateRun(run.id) { run in run.output += (run.output.isEmpty ? "" : "\n") + line }
    }

    private func perform(_ type: String, _ action: [String: Any], url: String) async -> Outcome {
        guard let env else { return Outcome(ok: false) }
        let browser = env.browser
        let gap = 0.6
        switch type {
        case "navigate":
            guard let raw = action["url"] as? String, let target = BrowserSteps.addressURL(raw) else { return Outcome(ok: false, detail: "not a URL") }
            await tab.navigate(target)
            learned.append(BrowserSteps.navigate(target.absoluteString, delay: gap))
            return Outcome(ok: true, line: "opening \(BrowserSteps.displayURL(target.absoluteString))", changedPage: true)
        case "back":
            await tab.goBack()
            // Back undoes the wrong turn: the step that led away isn't part of the skill.
            if !learned.isEmpty { learned.removeLast() }
            return Outcome(ok: true, line: "going back", changedPage: true)
        case "new_tab":
            let target = (action["url"] as? String).flatMap { BrowserSteps.addressURL($0) }
            let watching = browser.model.activeID == tab.id
            let opened = browser.openTab(activate: watching, openedBy: tab)
            claim(opened)
            tab = opened
            if let target {
                await opened.navigate(target)
                learned.append(BrowserSteps.navigate(target.absoluteString, delay: gap))
            }
            return Outcome(ok: true, line: "new tab\(target.map { " · \(BrowserSteps.displayURL($0.absoluteString))" } ?? "")", changedPage: true)
        case "switch_tab":
            guard let number = (action["tab"] as? NSNumber)?.intValue, let other = browser.tab(number: number),
                  other.ownerRunID == run.id else { return Outcome(ok: false, detail: "no such tab of yours") }
            if browser.model.activeID == tab.id { browser.select(other) }
            tab = other
            if let address = other.webView.url?.absoluteString { learned.append(BrowserSteps.navigate(address, delay: gap)) }
            return Outcome(ok: true, line: "switching to \(other.label)", changedPage: true)
        case "close_tab":
            guard let number = (action["tab"] as? NSNumber)?.intValue, let other = browser.tab(number: number),
                  other.ownerRunID == run.id else { return Outcome(ok: false, detail: "no such tab of yours") }
            let mine = browser.tabs(ownedBy: run.id)
            guard mine.count > 1 else { return Outcome(ok: false, detail: "that's your only tab") }
            let wasCurrent = other === tab
            other.ownerRunID = nil
            other.status = nil
            other.onEscape = nil
            if wasCurrent, let next = mine.last(where: { $0 !== other }) {
                if browser.model.activeID == other.id { browser.select(next) }
                tab = next
            }
            browser.closeTab(other)
            return Outcome(ok: true, line: "closing a tab", changedPage: wasCurrent)
        case "fill_login":
            // Only ever the login for the page's own site, whatever site the model names: a page that
            // talks the model into "filling the bank login" here gets nothing.
            let here = BrowserSteps.host(of: tab.webView.url?.absoluteString ?? url)
            let named = action["site"] as? String ?? here
            guard !here.isEmpty, BrowserSteps.sameSite(here, named) else {
                return Outcome(ok: false, detail: "this page is \(here.isEmpty ? "not a website" : here), not \(named); logins are only filled on their own site")
            }
            guard let login = env.vaultLogin(for: here) else {
                return Outcome(ok: false, detail: "no saved login for \(here), or the vault is locked on this Mac (turn on “remember on this Mac” in Vault)")
            }
            let result = await tab.fillLogin(username: login.username, password: login.password)
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
            let addressBefore = tab.webView.url
            let acting = tab
            let started = Date()
            let result = await acting.act(payload)
            guard result.ok else { return Outcome(ok: false, detail: result.detail) }
            // A choice in a dropdown can load a page too (a shop's size picker).
            if ["click", "press", "select"].contains(type) || payload["submit"] as? Bool == true {
                // Whatever the action set off (a new page, results arriving) gets its moment, no longer.
                await acting.settle(limit: 6, fresh: true)
            } else if type == "hover" {
                await acting.settle(limit: 1.5, fresh: true)
            }
            // A link that opened in a new tab: the agent follows it there.
            var movedTab = false
            if type == "click" || type == "press",
               let opened = browser.model.tabs.last(where: { $0.openedBy == acting.id && $0.createdAt >= started && $0.ownerRunID == run.id }) {
                tab = opened
                movedTab = true
                await opened.settle(limit: 6)
            }
            let formControl = ["checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "select"].contains(result.role ?? "")
            let changedPage = movedTab || acting.webView.url != addressBefore
                || (type == "click" && !formControl) || type == "press" || payload["submit"] as? Bool == true
            // Scrolling isn't part of the skill: a replay finds elements wherever they are.
            guard type != "scroll" else { return Outcome(ok: true, line: "scrolling") }
            var input: String? = type == "type" ? payload["text"] as? String : type == "select" ? payload["value"] as? String
                : type == "press" ? (payload["key"] as? String ?? "Enter") : nil
            // Whatever went into a password field (a code they gave in an answer, say) isn't kept in the skill.
            // A password given in the request itself is an input of the skill ({{password}}, never the text); any
            // other password goes to the vault.
            if type == "type", result.role == "password" {
                let typed = payload["text"] as? String ?? ""
                input = typed.count >= 4 && run.prompt.contains(typed) ? "{{password}}"
                    : BrowserSteps.vaultPlaceholder(site: BrowserSteps.host(of: url), field: "password")
            }
            learned.append(.browser(type, text: BrowserSteps.line(type, label: result.label, input: input), url: url,
                                    selectors: result.selectors, label: result.label, role: result.role, input: input, delay: gap))
            if type == "type", payload["submit"] as? Bool == true {
                learned.append(.browser("press", text: BrowserSteps.line("press", label: nil, input: "Enter"), url: url,
                                        selectors: result.selectors, input: "Enter", delay: 0.2))
            }
            if movedTab, let address = tab.webView.url?.absoluteString { learned.append(BrowserSteps.navigate(address, delay: gap)) }
            // Typed now from the task, not the vault; the saved skill fills it from the vault next time.
            if type == "type", result.role == "password" {
                return Outcome(ok: true, line: "type the password in \(result.label.map { "“\($0)”" } ?? "the field")", changedPage: changedPage)
            }
            let line = BrowserSteps.line(type, label: result.label, input: input) + (movedTab ? " · opened a new tab" : "")
            return Outcome(ok: true, line: line, changedPage: changedPage)
        default:
            return Outcome(ok: false, detail: "unknown action \(type)")
        }
    }

    /// A tab the agent opened is its own, with the same line and esc as the rest of its work.
    private func claim(_ opened: BrowserTab) {
        guard let env else { return }
        env.browser.beginWork(tab.status ?? "browsing · \(run.title)", in: opened, runID: run.id, threadID: run.threadID) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
    }

    private func finish(success: Bool, summary: String) {
        guard let env else { return }
        task = nil
        env.closeHandoffCard(runID: run.id)
        env.browser.endWork(runID: run.id)
        // The tab it ended in is where a follow-up in this conversation carries on.
        if let threadID = run.threadID { env.browser.noteThreadTab(threadID, tab) }
        env.store.finishRun(run.id, status: success ? .done : .failed, summary: summary)
        if let threadID = run.threadID { env.store.appendMessage(threadID: threadID, role: .assistant, text: summary, runID: run.id) }
        env.learnedPages[run.id] = pageTexts
        env.browserRunFinished(run, success: success, summary: summary, learned: success ? learned : [])
        env.store.saveNow()
        ended(run.id)
    }

    private func ask(question: String) {
        guard let env else { return }
        task = nil
        env.closeHandoffCard(runID: run.id)
        env.browser.endWork(runID: run.id)
        if let threadID = run.threadID {
            env.browserLearnedBeforeQuestion[threadID] = learned
            env.browser.noteThreadTab(threadID, tab)
        }
        env.store.finishRun(run.id, status: .asked, summary: question)
        if let threadID = run.threadID { env.store.appendMessage(threadID: threadID, role: .assistant, text: question, runID: run.id) }
        env.presentDriveQuestion(runID: run.id, question: question)
        env.store.saveNow()
        ended(run.id)
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
    /// The tab the replay runs in.
    private var tab: BrowserTab?

    init(environment: AppEnvironment) { self.env = environment }

    func begin(skill: Skill, runID: String, times: Int, values: [[String: String]]) {
        guard let env, task == nil else {
            env?.failReplay(runID: runID, reason: "another replay is running in the browser — let it finish or stop it first")
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
        let tab = browser.tabForRun(runID: runID, threadID: nil)
        self.tab = tab
        browser.beginWork("replaying “\(skill.name)”", in: tab, runID: runID, threadID: nil) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
        browser.presentForWork(tab)
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
                    // Paused from the notch: the page is the person's until play; then on with the next step.
                    while self.paused, !Task.isCancelled, self.runID == runID { try? await Task.sleep(nanoseconds: 300_000_000) }
                    if Task.isCancelled { return }
                    self.mark(index, .running, total: skill.steps.count, pass: pass, of: passes, text: ParameterFill.fill(step.text, values: given).text)
                    let outcome = await self.perform(step, values: given, tab: tab, pass: pass)
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

    private(set) var paused = false

    func pauseOrResume() {
        guard let runID, let env else { return }
        paused.toggle()
        env.store.updateRun(runID) { $0.status = paused ? .paused : .running; $0.waitingFor = nil }
        if paused, let tab { env.browser.updateWork("paused — the page is yours", in: tab) }
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
        paused = false
        if let runID { env?.browser.endWork(runID: runID) }
        runID = nil
        tab = nil
    }

    private func mark(_ index: Int, _ status: RunStatus, total: Int, pass: Int, of passes: Int, text: String) {
        guard let env, let runID else { return }
        env.store.updateRun(runID) { run in
            guard run.steps.indices.contains(index) else { return }
            if status == .running { run.steps[index].startedAt = Date() } else { run.steps[index].endedAt = Date() }
            run.steps[index].status = status
            if passes > 1 { run.summary = "pass \(pass) of \(passes)" }
        }
        if status == .running, let tab { env.browser.updateWork("\(passes > 1 ? "\(pass)/\(passes) · " : "")step \(index + 1)/\(total) · \(text)", in: tab) }
    }

    private enum StepOutcome { case done, healed([String]), failed(String) }

    private func perform(_ step: SkillStep, values: [String: String], tab browser: BrowserTab, pass: Int) async -> StepOutcome {
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
        case "dialog":
            browser.dialogAnswer = BrowserSteps.dialogAnswer(ParameterFill.fill(step.input ?? "accept", values: values).text)
            return .done
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
                guard let rescued = await rescue(step, input: input, tab: browser, pass: pass) else {
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
    private func rescue(_ step: SkillStep, input: String?, tab browser: BrowserTab, pass: Int) async -> BrowserActResult? {
        guard let runID else { return nil }
        return await rescueStep(step, input: input, tab: browser, runID: runID, pass: pass)
    }

    /// The same rescue for any replay's run (smart replay uses it too).
    func rescueStep(_ step: SkillStep, input: String?, tab browser: BrowserTab, runID: String, pass: Int) async -> BrowserActResult? {
        guard let env, env.hasKey("anthropic") else { return nil }
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
        env.store.countModelCall(runID)
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
