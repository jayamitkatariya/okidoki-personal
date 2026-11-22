import Foundation
import OkidokiCore

/// Smart replay in okidoki's browser. The same skill, done once per person, invoice or row:
///
/// 1. **Bind:** every pass's values are settled before anything is touched (given values first, the
///    item's documents for the rest, one model call per item).
/// 2. **Plan:** each pass's steps with its conditions applied and its loops unrolled, in code.
/// 3. **Run:** each step as recorded, then checked: anchors (is this the page?), read-back (did the
///    field take the value?), expectations (did it lead where it should?). Popups get cleared by known
///    handlers; a page further along gets skipped to.
/// 4. **Help, only on evidence:** a step that can't be found or didn't take gets one model rescue; a
///    think step does the part no recording covers; a pass that's lost its way is finished by the agent
///    from where it is. A pass that goes perfectly makes no model calls at all.
///
/// With smart replay off, `BrowserReplayer` runs instead, untouched.
@MainActor
final class HybridBrowserReplayer {
    private weak var env: AppEnvironment?
    private var task: Task<Void, Never>?
    private(set) var runID: String?
    var isActive: Bool { task != nil }
    /// Waiting on the person at the unsure gate: resumes with carry on · skip · stop.
    private var gate: CheckedContinuation<GateAnswer, Never>?
    enum GateAnswer: String { case carryOn = "carry", skip, stop }

    init(environment: AppEnvironment) { self.env = environment }

    // MARK: - Start

    func begin(skill: Skill, runID: String, passes given: [[String: String]], times: Int, request: String = "") {
        guard let env, task == nil else {
            env?.failReplay(runID: runID, reason: "another replay is running in the browser — let it finish or stop it first")
            return
        }
        self.runID = runID
        let builtins = ParameterFill.builtins()
        let raw = given.isEmpty ? Array(repeating: [String: String](), count: max(1, times)) : given
        let passes = raw.map { builtins.merging($0) { _, mine in mine } }
        let browser = env.browser
        // One tab per item, so items can run side by side; the first is the one in front.
        let first = browser.tabForRun(runID: runID, threadID: nil)
        browser.beginWork("replaying “\(skill.name)”", in: first, runID: runID, threadID: nil) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
        browser.presentForWork(first)

        task = Task { [weak self] in
            guard let self else { return }
            // Bind first: a form is never started that can't be finished.
            self.status("getting everyone's details ready", in: first)
            let bound = await env.bindItems(skill, passes: passes, runID: runID, request: request)
            if Task.isCancelled || self.runID != runID { return }
            // A pass that can't be finished is never started; the others still go.
            let gaps = bound.filter { !$0.missing.isEmpty }
            let howToFix = "Add them to the request (name=value) or put their documents in a vault folder named after them."
            let ready = bound.indices.filter { bound[$0].missing.isEmpty }
            if ready.isEmpty {
                let lines = gaps.map { "\($0.label): \($0.missing.joined(separator: ", "))" }
                self.end()
                env.failReplay(runID: runID, reason: "missing before starting — " + lines.joined(separator: "; ") + ". " + howToFix)
                return
            }
            var outcomes: [(label: String, ok: Bool, note: String)] = []
            // The passes worth trying again, as they were given: failed ones, never one that may have gone through.
            var retryable: [[String: String]] = []
            env.store.updateRun(runID) { run in
                run.steps = bound.map { item in
                    var step = RunStep(title: item.label, status: item.missing.isEmpty ? .waiting : .failed)
                    if !item.missing.isEmpty { step.detail = "missing \(item.missing.joined(separator: ", "))" }
                    return step
                }
                if bound.count > 1 { run.summary = "\(ready.count) to do" }
            }
            for (n, item) in bound.enumerated() where !item.missing.isEmpty {
                if raw.indices.contains(n) { retryable.append(raw[n]) }
                let note = "not started — missing \(item.missing.joined(separator: ", "))"
                outcomes.append((item.label, false, note))
                env.replayLog(runID, "✗ \(item.label): \(note). \(howToFix)")
            }
            var healed = skill.steps
            var promotions: [Int: [SkillStep]] = [:]
            var taught: (before: Int, steps: [SkillStep], values: [String: String])?
            self.learnedInterrupts = []
            let limit = max(1, min(3, ready.count))
            var tabs: [BrowserTab] = [first]
            for _ in 1..<limit { tabs.append(browser.openTab(activate: false)); self.claim(tabs.last!, runID: runID, skill: skill) }
            // Items run in parallel tabs, a few at a time; each pass's fixes are shared with the next ones.
            var next = 0
            await withTaskGroup(of: (Int, PassResult).self) { group in
                func launch(_ index: Int, on tab: BrowserTab) {
                    let item = bound[index]
                    let steps = healed
                    group.addTask { @MainActor in
                        env.store.updateRun(runID) { run in
                            if run.steps.indices.contains(index) { run.steps[index].status = .running; run.steps[index].startedAt = Date() }
                        }
                        let result = await self.runPass(skill: skill, steps: steps, item: item, index: index, of: bound.count, tab: tab)
                        return (index, result)
                    }
                }
                var free: [BrowserTab] = []
                for (n, tab) in tabs.enumerated() where n < ready.count { launch(ready[n], on: tab); next = n + 1 }
                for await (index, result) in group {
                    if Task.isCancelled || self.runID != runID { group.cancelAll(); return }
                    for (source, steps) in result.promotions where promotions[source] == nil {
                        promotions[source] = steps
                        // Applied to the working copy at once, not only written out at the end: a pass that
                        // launches later (and every later iteration of a loop, which shares one source
                        // index) then runs the plain steps instead of paying for the same rescue again. In
                        // a three-pass run this was three rescues of the same step.
                        healed = SkillPromoter.replacing(healed, at: source, with: steps)
                    }
                    if taught == nil, result.ok, let lesson = result.taught { taught = lesson }
                    for source in result.echoes where healed.indices.contains(source) && healed[source].echoes != true {
                        healed[source].echoes = true
                    }
                    for (source, selectors) in result.healed where healed.indices.contains(source) {
                        // A step inside a loop keeps its template. Its selectors carry `{{item.index}}`,
                        // and a rescue on one row returns that row's own id ("#section-2-ermq"); saving it
                        // either points every row at row 2 or, merged once per iteration, grows a list of
                        // every row's id that no later page has. Left alone, the template keeps working.
                        let templatedStep = (healed[source].selectors ?? []).contains { $0.contains("{{") }
                        guard !templatedStep else { continue }
                        healed[source].selectors = selectors
                        healed[source].heals = (healed[source].heals ?? 0) + 1
                    }
                    let item = bound[index]
                    outcomes.append((item.label, result.ok, result.note))
                    if !result.ok, !result.skipped, !result.stop, !result.unconfirmed, raw.indices.contains(index) { retryable.append(raw[index]) }
                    env.store.updateRun(runID) { run in
                        guard run.steps.indices.contains(index) else { return }
                        run.steps[index].status = result.ok ? .done : (result.skipped ? .cancelled : .failed)
                        run.steps[index].endedAt = Date()
                        run.steps[index].detail = result.note
                    }
                    if result.ok || result.skipped {
                        env.replayLog(runID, (result.ok ? "" : "skipped ") + "\(item.label)" + (result.note.isEmpty ? "" : " · \(result.note)"), receipt: result.ok)
                    } else {
                        env.replayLog(runID, "✗ \(item.label): \(result.note)")
                    }
                    if result.stop { group.cancelAll(); break }
                    if next < ready.count {
                        free.append(result.tab)
                        launch(ready[next], on: free.removeFirst())
                        next += 1
                    }
                }
            }
            // The extra tabs go either way, stopped or finished; the first one stays, showing where it ended.
            // (Released first: closing a tab a run still owns would stop that run.)
            if tabs.count > 1 { env.browser.endWork(runID: runID) }
            for tab in tabs.dropFirst() { env.browser.closeTab(tab) }
            if Task.isCancelled || self.runID != runID { return }
            let popups = self.learnedInterrupts
            if !promotions.isEmpty || !popups.isEmpty, var current = env.store.skill(skill.id) {
                // What the model worked out becomes plain steps and rules: next time, these parts need no
                // model. They are already in `healed` (each was applied as it arrived, so the passes that
                // launched afterwards used them); this is only the log and the prune.
                for source in promotions.keys.sorted(by: >) where skill.steps.indices.contains(source) {
                    env.replayLog(runID, "→ learned “\(skill.steps[source].text.prefix(60))…” as \(promotions[source]?.count ?? 0) plain steps")
                }
                // Re-pruned, always. What a rescue promotes is a verbatim trace of what the model did
                // ("click Departure, click 18, click Done") — the same date-picker walk and duplicate
                // clicks the compiler prunes, and writing it back unpruned put them back into the skill.
                // The next replay then paid for them again, and healed, and wrote them back again.
                current.steps = SkillCompiler.pruneStale(steps: SkillCompiler.deriveChecks(healed))
                if !popups.isEmpty {
                    let known = current.interrupts ?? []
                    current.interrupts = known + popups.filter { new in !known.contains { $0.whenText == new.whenText } }
                    env.replayLog(runID, "→ learned how to close \(popups.count == 1 ? "a popup" : "\(popups.count) popups")")
                }
                env.store.replaceSkill(current)
            } else if healed != skill.steps {
                env.store.updateSkillSteps(skill.id, SkillCompiler.pruneStale(steps: healed))
            }
            // What the person did by hand while paused, that the skill doesn't do: theirs to add or not.
            if let taught, promotions.isEmpty, let current = env.store.skill(skill.id), current.steps.indices.contains(taught.before) {
                let known = Set(current.steps.flatMap { $0.selectors ?? [] })
                let fresh = taught.steps.filter { step in
                    guard let selectors = step.selectors, !selectors.isEmpty else { return step.action == "press" }
                    return Set(selectors).isDisjoint(with: known)
                }
                let actions = fresh.map { SkillPromoter.Action(action: $0.action ?? "click", selectors: $0.selectors ?? [], label: $0.label,
                                                               role: $0.role, input: $0.input, url: $0.url) }
                if !fresh.isEmpty, !env.unattendedRuns.contains(runID),
                   let steps = SkillPromoter.fromPerson(actions, values: taught.values, inputs: current.inputs ?? [], near: current.steps[taught.before]) {
                    env.offerPersonSteps(skillID: skill.id, before: taught.before, steps: steps, runID: runID)
                }
            }
            self.end()
            let done = outcomes.filter(\.ok).count
            if done == bound.count {
                env.finishReplay(runID: runID, passes: bound.count)
            } else {
                let failed = outcomes.filter { !$0.ok }.map { "\($0.label): \($0.note)" }
                env.failReplay(runID: runID, reason: "\(done) of \(bound.count) done · " + failed.joined(separator: "; "),
                               retry: retryable.isEmpty ? nil : (skill.id, retryable))
            }
        }
    }

    private func claim(_ tab: BrowserTab, runID: String, skill: Skill) {
        env?.browser.beginWork("replaying “\(skill.name)”", in: tab, runID: runID, threadID: nil) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
    }

    func cancel(reason: String) {
        guard let runID, let env else { return }
        task?.cancel()
        gate?.resume(returning: .stop)
        gate = nil
        end()
        env.store.finishRun(runID, status: .cancelled, summary: reason)
        env.store.saveNow()
    }

    /// The person's answer at the unsure gate (the card, or `gate carry|skip|stop` from a script).
    func answerGate(_ answer: GateAnswer) {
        gate?.resume(returning: answer)
        gate = nil
    }

    // MARK: - Hand-off: the person steps in, then hands it back

    /// The person took over (pause): every pass waits at its next step until they take it back.
    private(set) var personHasIt = false
    /// Set by "take back" (the card, the notch, a script): whoever is waiting carries on.
    private var takeBackAsked = false
    /// One "your turn" card at a time; other passes needing the person queue behind it.
    private(set) var handingOff = false
    /// The person has the page, paused or passing a check: the notch's play button hands it back.
    var personsTurn: Bool { personHasIt || handingOff }
    /// What the person did by hand in the tab in front while paused, and that tab: offered to the skill later.
    private var personSteps: [SkillStep] = []
    private weak var personTab: BrowserTab?

    /// Pause: the page is the person's until they take it back. The run stays alive.
    func pauseForPerson(from source: String = "") {
        guard let env, let runID, !personHasIt else { return }
        if handingOff { takeBack(); return }
        personHasIt = true
        takeBackAsked = false
        env.store.updateRun(runID) { $0.status = .paused; $0.waitingFor = nil }
        env.replayLog(runID, "→ paused — the page is yours" + (source.isEmpty ? "" : " (\(source))"))
        // What they do in the tab in front is watched once that tab's pass has stopped (its own last action
        // done), so nothing okidoki typed is taken for theirs.
        personSteps = []
        personTab = env.browser.activeTab.ownerRunID == runID ? env.browser.activeTab : nil
        if let personTab { env.browser.watchPerson(in: personTab) { [weak self] step in self?.personSteps.append(step) } }
        // A question already on screen (the check before submitting) stays the only card.
        guard gate == nil else { return }
        env.browser.show()
        env.presentHandoff(runID: runID, title: "paused · the page is yours",
                           text: "Do what you need to on the page. When you take it back, okidoki picks up from wherever the page is.",
                           takeBack: { [weak self] in self?.takeBack() }, stop: { [weak self] in self?.cancel(reason: "you stopped me") })
    }

    /// The person is done: carry on from wherever the page is now.
    func takeBack() {
        guard personHasIt || handingOff, let runID else { return }
        env?.store.updateRun(runID) { $0.status = .running; $0.waitingFor = nil }
        if personHasIt { env?.replayLog(runID, "→ taken back — carrying on from where the page is") }
        env?.browser.stopWatchingPerson()
        personHasIt = false
        takeBackAsked = true
        env?.closeHandoffCard(runID: runID)
    }

    /// A check only the person can pass (a captcha, a code): bring the tab to them, wait until the check
    /// is gone (or they take it back), then carry on. False when stopped, timed out, or nobody is here.
    private func handOff(_ why: String, label: String, tab: BrowserTab) async -> Bool {
        guard let env, let runID else { return false }
        if env.unattendedRuns.contains(runID) {
            env.replayLog(runID, "✗ \(label): needs a person (\(why)), and nobody is at this Mac")
            return false
        }
        // Behind another pass's card, a question, or a pause: by the time it's this pass's turn the check
        // may be gone (the person passed it in that tab too).
        var waited = false
        while handingOff || gate != nil || personHasIt {
            if Task.isCancelled || self.runID != runID { return false }
            waited = true
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        if waited, await tab.humanCheck() == nil { return true }
        handingOff = true
        defer { handingOff = false }
        takeBackAsked = false
        let who = label.isEmpty ? "" : "\(label) · "
        env.store.updateRun(runID) { $0.status = .paused; $0.waitingFor = why }
        env.replayLog(runID, "→ \(who)your turn: \(why)")
        status("\(who)your turn: \(why) — okidoki carries on when it's done", in: tab)
        env.browser.show()
        env.browser.select(tab)
        let checkURL = tab.webView.url?.absoluteString ?? ""
        env.presentHandoff(runID: runID, title: "your turn · \(why)",
                           text: "\(label.isEmpty ? "This page" : label + "'s page") needs a person: \(why). Do it in the browser; "
                               + "okidoki notices when it's done and carries on, or press take back.",
                           takeBack: { [weak self] in self?.takeBack() }, stop: { [weak self] in self?.cancel(reason: "you stopped me") })
        let ending = await PersonTurn.waitPast(tab: tab, takenBack: { self.takeBackAsked },
                                               alive: { !Task.isCancelled && self.runID == runID })
        takeBackAsked = false
        switch ending {
        case .stopped:
            return false
        case .timedOut:
            env.closeHandoffCard(runID: runID)
            env.replayLog(runID, "✗ \(who)waited 10 minutes for you")
            return false
        case .cleared, .takenBack:
            env.store.updateRun(runID) { if $0.status == .paused { $0.status = .running }; $0.waitingFor = nil }
            env.closeHandoffCard(runID: runID)
            env.replayLog(runID, "→ \(who)thanks — taking it from here")
            status("\(who)carrying on", in: tab)
            await tab.settle(limit: 4)
            if let pressed = await PersonTurn.continuePast(on: tab, checkURL: checkURL) {
                env.replayLog(runID, "→ \(who)pressed “\(pressed)” on the check page")
            }
            return true
        }
    }

    private func end() {
        if let runID { env?.closeHandoffCard(runID: runID) }
        env?.browser.stopWatchingPerson()
        personSteps = []
        personTab = nil
        personHasIt = false
        handingOff = false
        task = nil
        if let runID { env?.browser.endWork(runID: runID) }
        runID = nil
    }

    private func status(_ line: String, in tab: BrowserTab) {
        env?.browser.updateWork(line, in: tab)
    }

    // MARK: - One pass

    struct PassResult {
        var ok: Bool
        var note: String
        var tab: BrowserTab
        /// Recorded step index → selectors that work now.
        var healed: [Int: [String]] = [:]
        /// Think step index → the plain steps that did it on this pass.
        var promotions: [Int: [SkillStep]] = [:]
        var skipped = false
        /// The person said stop at the gate: no more passes.
        var stop = false
        /// Irreversible steps whose page showed this pass's details.
        var echoes: Set<Int> = []
        /// Something irreversible was done but never confirmed: it may have gone through, so it's never
        /// offered for a retry.
        var unconfirmed = false
        /// What the person did by hand on this pass's page while paused, before which step of the skill,
        /// with this pass's values (for turning what they typed back into inputs).
        var taught: (before: Int, steps: [SkillStep], values: [String: String])?
    }

    private func runPass(skill: Skill, steps: [SkillStep], item: SkillBinder.Bound, index: Int, of total: Int, tab: BrowserTab) async -> PassResult {
        guard let env, let runID else { return PassResult(ok: false, note: "stopped", tab: tab) }
        var values = item.values
        let inputs = Dictionary((skill.inputs ?? []).map { (ParameterFill.key($0.name), $0) }, uniquingKeysWith: { first, _ in first })
        var plan = HybridReplay.plan(steps, values: values)
        var doubts = HybridReplay.PassDoubts(values: item.doubts)
        var result = PassResult(ok: false, note: "", tab: tab)
        var captured: [String] = []
        var cursor = 0
        var jumps = 0
        var rescues = 0
        var fixes = 0
        /// The page came out differently and only reading is left: read it where it is, no re-syncing.
        var readingAnyway = false
        let prefix = total > 1 ? "\(item.label) · " : ""

        while cursor < plan.count {
            if Task.isCancelled || self.runID != runID { result.note = "stopped"; return result }
            // The person has the page (paused): wait for them to hand it back, then pick up from where it is.
            if personHasIt {
                let at = cursor
                while personHasIt, !Task.isCancelled, self.runID == runID { try? await Task.sleep(nanoseconds: 300_000_000) }
                // Theirs was this page: what they did by hand is kept to offer to the skill.
                if personTab === tab, !personSteps.isEmpty {
                    // Not theirs: what okidoki itself did in this field with this value (its own last step was
                    // still finishing when they pressed pause; the browser reports that as typed).
                    let mine = plan[..<min(at + 1, plan.count)].map { planned -> (Set<String>, String) in
                        (Set(planned.step.selectors ?? []), ParameterFill.fill(planned.step.input ?? "", values: planned.values).text)
                    }
                    let did = BrowserRecordingCleanup.tidy(personSteps).filter { step in
                        guard step.action != "navigate" else { return false }
                        let selectors = Set(step.selectors ?? [])
                        return !mine.contains { own in !own.0.isDisjoint(with: selectors) && (own.1 == (step.input ?? "") || step.action == "type" && HybridReplay.sameValue(typed: own.1, field: step.input ?? "")) }
                    }
                    personSteps = []
                    personTab = nil
                    if !did.isEmpty, plan.indices.contains(at) {
                        env.replayLog(runID, "→ \(prefix)while paused you: " + did.map(\.text).joined(separator: " · "))
                        if result.taught == nil { result.taught = (plan[at].source, did, values) }
                    }
                }
                continue
            }
            // A check only a person can pass: theirs for a moment.
            if plan[cursor].step.action != "navigate", let check = await PersonTurn.confirmed(on: tab) {
                guard await handOff(check, label: item.label, tab: tab) else {
                    result.note = "needed you for \(check)"
                    return result
                }
                continue
            }
            let planned = plan[cursor]
            let step = planned.step
            let action = step.action ?? "click"
            status("\(prefix)\(cursor + 1)/\(plan.count) · \(ParameterFill.fill(step.text, values: planned.values).text)", in: tab)

            // Is this the place? Popups get cleared; a page that's further along (or behind) gets re-synced.
            //
            // A read is exempt: "read the cheapest fare on the results page" works on whatever page the
            // action before it produced. Gating it on the address the run happened to be at (Google
            // Flights navigates to /travel/flights?q=… while the recording expected /travel/flights/search)
            // made a finished replay declare the page wrong and hand the whole tail to the agent.
            if let anchor = step.anchor, !anchor.isEmpty, action != "navigate", action != "read", !readingAnyway {
                var seen = await tab.observation()
                if !HybridReplay.matches(anchor, seen) {
                    if await clearInterrupts(skill: skill, seen: seen, tab: tab) { seen = await tab.observation() }
                }
                if !HybridReplay.matches(anchor, seen) {
                    // The page may still be on its way: give it a moment before deciding it's elsewhere.
                    for _ in 0..<8 {
                        guard !HybridReplay.matches(anchor, seen) else { break }
                        try? await Task.sleep(nanoseconds: 200_000_000)
                        seen = await tab.observation()
                    }
                }
                if !HybridReplay.matches(anchor, seen), jumps < 6, let target = HybridReplay.resync(plan, current: cursor, seen: seen) {
                    jumps += 1
                    env.replayLog(runID, "→ \(prefix)already on “\(seen.title)”, picking up at “\(plan[target].step.text)”")
                    cursor = target
                    continue
                }
                if !HybridReplay.matches(anchor, seen), jumps < 6, await passUnknownPage(skill: skill, plan: plan, tab: tab, prefix: prefix) {
                    jumps += 1
                    continue
                }
            }

            // Before something irreversible, on a page that shows what was entered (a review page): if none
            // of this pass's details are there, something was lost on the way (a reset, an undo), and it
            // isn't submitted without asking.
            if step.irreversible == true {
                // One bounded wait, not two: `perform` waits for the page and the control itself just
                // before acting, and a `for … in 0..<N where await cond` loop evaluates `cond` N times
                // even when it's already false — 40 wasted JS round-trips on every replay of a submit.
                var idle = 0
                while idle < 40, await tab.isBusy() {
                    if Task.isCancelled { break }
                    idle += 1
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
                var looks = 0
                while looks < 25, await tab.label(of: step.selectors ?? []) == nil {
                    if Task.isCancelled { break }
                    looks += 1
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
                let page = await tab.pageText() + "\n" + (await tab.fieldValues())
                let seen = HybridReplay.shownValues(values, inputs: skill.inputs ?? [], on: page)
                let key = "\(skill.id)#\(planned.source)"
                if seen.checked > 0, seen.shown > 0 {
                    result.echoes.insert(planned.source)
                    echoing.insert(key)
                } else if seen.checked > 0, step.echoes == true || echoing.contains(key) {
                    env.replayLog(runID, "✗ \(item.label): the page before “\(step.text)” shows none of their details")
                    doubts.helped.append("the page before “\(step.text)” shows none of \(item.label)'s details — they may have been lost on the way")
                }
            }

            // The pause before something irreversible, only when this pass has a doubt.
            if let reasons = HybridReplay.pauseReasons(before: step, skill: skill, doubts: doubts) {
                switch await askGate(item: item, step: step, reasons: reasons, tab: tab) {
                case .carryOn: break
                case .skip: result.skipped = true; result.note = "skipped at “\(step.text)”"; return result
                case .stop: result.stop = true; result.note = "stopped before “\(step.text)”"; return result
                }
            }

            let stepStarted = Date()
            // No single step may hold the whole replay hostage. A page that never goes idle (Google
            // Flights keeps loading trackers) once held `click "Search"` for 400 seconds — a replay that
            // hangs is worse than one that moves on and lets the next step decide.
            let worked: StepOutcome? = await withTimeout(seconds: 45) { [self] in
                await perform(planned, skill: skill, inputs: inputs, values: values, tab: tab, item: item,
                              next: cursor + 1 < plan.count ? plan[cursor + 1].step : nil)
            }
            let timedOut = worked == nil
            // A step that ran out of time did not do its job. Reporting it as done claimed work that never
            // happened, and nothing was learned from it either — so the next replay paid for the same
            // stuck step again. An irreversible step is still `.done` (partially pressed is not undone).
            var outcome: StepOutcome = worked ?? (step.irreversible == true ? .done : .doubt("took more than 45s and was skipped"))
            if timedOut {
                env.replayLog(runID, "✗ \(prefix)“\(step.text)” took more than 45s — moving on")
            }
            // How long each step took, in the run's own log: the only way to see where a replay spends its
            // seconds (a fixed wait, a settle, a model call) without a debugger attached.
            let stepTook = Date().timeIntervalSince(stepStarted)
            if stepTook >= 0.75 {
                env.replayLog(runID, "· \(prefix)\(String(format: "%.1f", stepTook))s · \(step.text.prefix(60))")
            }
            // A lookup whose page came out differently (a wrong password's "invalid" message instead of the
            // secure area): when all that's left is reading, what the page says now is the answer.
            if case .lost(let why) = outcome, step.irreversible != true, cursor + 1 < plan.count,
               plan[(cursor + 1)...].allSatisfy({ $0.step.action == "read" }), await tab.humanCheck() == nil {
                env.replayLog(runID, "→ \(prefix)\(why) — reading what the page says instead")
                readingAnyway = true
                outcome = .done
            }
            if case .lost = outcome, let human = await tab.humanCheck() {
                // Not lost: a person is needed. Once they're through, the page tells where to pick up.
                guard await handOff(human.text, label: item.label, tab: tab) else {
                    result.note = "needed you for \(human.text)"
                    return result
                }
                continue
            } else if case .lost(let why) = outcome, step.irreversible == true,
               let expect = step.expect, !expect.isEmpty, (await check(expect, tab: tab)).isEmpty {
                // A rescue that pressed it, then gave up: it's done, and must not be done twice.
                outcome = .done
            } else if case .lost(let why) = outcome, step.irreversible == true {
                // The final step itself moved. Only now that it's due (and past the gate) may the model
                // look for it, and for nothing else.
                let (ok, summary) = await think(goal: "Do exactly this one final step now, on the current page: \(step.text). "
                                                  + "The control may be labelled differently now (it does the same job). Then finish with success true.",
                                                  tab: tab, maxTurns: 3, tag: "final")
                outcome = ok ? .done : .failed(summary.isEmpty ? why : summary)
            } else if case .lost(let lostWhy) = outcome, jumps < 6, let page = step.anchor?.path,
                      case let seen = await tab.observation(), !HybridReplay.matches(StepAnchor(path: page), seen),
                      let target = HybridReplay.resync(plan, current: cursor, seen: seen), target != cursor {
                // It went to a page the skill knows, just not the one expected next (signed in again and
                // sent straight back to where it was): carry on from there, no agent needed.
                jumps += 1
                env.replayLog(runID, "→ \(prefix)“\(step.text)”: \(lostWhy) — now on “\(await tab.observation().title)”, picking up at “\(plan[target].step.text)”")
                cursor = target
                continue
            } else if case .lost = outcome, jumps < 6, await passUnknownPage(skill: skill, plan: plan, tab: tab, prefix: prefix) {
                jumps += 1
                continue
            } else if case .lost(let why) = outcome {
                // Lost the thread: the agent carries this pass on from where the page is, up to (never
                // through) the next irreversible step, which the replay does itself under the gate.
                env.replayLog(runID, "→ \(prefix)\(why) — handing over to the agent")
                let stopAt = plan[cursor...].firstIndex { $0.step.irreversible == true }
                let handed = await escalate(skill: skill, plan: plan, from: cursor, until: stopAt, values: values, item: item, tab: tab, reason: why)
                outcome = handed.outcome
                // Values the agent typed on a changed page weren't checked the way replayed ones are.
                if handed.typed { doubts.helped.append("the agent filled in fields after “\(step.text)”") }
                if case .done = outcome, let stopAt {
                    env.replayLog(runID, "→ \(prefix)back on the recording at “\(plan[stopAt].step.text)”")
                    cursor = stopAt
                    continue
                }
                if case .done = outcome {
                    // Whatever the remaining plan still reads off the page is read now.
                    for later in plan[cursor...] where later.step.capture != nil {
                        if let value = await read(later.step, inputs: inputs, tab: tab) { captured.append(value) }
                    }
                    cursor = plan.count
                    continue
                }
            }
            switch outcome {
            case .done:
                break
            case .healed(let selectors):
                result.healed[planned.source] = selectors
                rescues += 1
            case .captured(let name, let value):
                values[name] = value
                captured.append(value)
                // Later steps that type it (a confirmation field) see it now.
                plan = plan.enumerated().map { offset, later in
                    guard offset > cursor else { return later }
                    var copy = later
                    copy.values[name] = value
                    return copy
                }
            case .thought:
                rescues += 1
            case .learned(let actions):
                rescues += 1
                if result.promotions[planned.source] == nil {
                    if let plain = SkillPromoter.promote(step, actions: actions, values: values, inputs: skill.inputs ?? []) {
                        result.promotions[planned.source] = plain
                    } else {
                        // Say so. A silent nil here is why a rescue could be paid for on every replay
                        // forever: nothing was learned, and nothing said why.
                        env.replayLog(runID, "→ \(prefix)what the model did at “\(step.text.prefix(50))” can't be kept as plain steps (a value picked for this pass, or a control without selectors) — it will look again next time")
                    }
                }
            case .doubt(let why):
                doubts.helped.append(why)
            case .failed(let why), .lost(let why):
                result.note = "step “\(ParameterFill.fill(step.text, values: planned.values).text)”: \(why)"
                return result
            case .refused(let said):
                // Nothing went through. The model does only what the site asks (tick the box, fix the
                // field), with this pass's values; the replay presses the step again, after the gate.
                if fixes < 2 {
                    fixes += 1
                    let shown = ParameterFill.fill(step.text, values: planned.values).text
                    env.replayLog(runID, "→ \(prefix)the site said “\(said)” — putting that right")
                    let goal = "On this page, the site turned down “\(shown)” and says: “\(said)”. Do only what it asks to put that right "
                        + "(tick a box, fill in or correct a field), using these values: \(spelled(skill: skill, values: values)). "
                        + "Never press “\(shown)” or submit anything yourself. Then finish with success true. If it asks for something "
                        + "these values don't cover, finish with success false and say what."
                    let (ok, summary) = await think(goal: goal, tab: tab, maxTurns: 5, tag: "fix")
                    if ok {
                        doubts.helped.append("the site asked “\(said)”")
                        continue
                    }
                    result.note = "the site turned down “\(shown)”: \(said)" + (summary.isEmpty ? "" : " — \(summary)")
                    return result
                }
                result.note = "the site turned down “\(ParameterFill.fill(step.text, values: planned.values).text)”: \(said)"
                return result
            case .unconfirmed(let why):
                result.unconfirmed = true
                result.note = "did “\(ParameterFill.fill(step.text, values: planned.values).text)” but the site didn't confirm it — \(why). "
                    + "It may have gone through: check the site before doing it again"
                return result
            }
            cursor += 1
        }
        result.ok = true
        result.note = captured.joined(separator: " · ")
        if rescues > 0, result.note.isEmpty { result.note = "done" }
        return result
    }

    // MARK: - One step

    private enum StepOutcome {
        case done
        case healed([String])
        case captured(String, String)
        case thought
        /// A think step that worked, with what it did, so it can become plain steps.
        case learned([SkillPromoter.Action])
        /// Done, but its result couldn't be confirmed.
        case doubt(String)
        case failed(String)
        /// The page isn't where the skill thinks; the agent should take over.
        case lost(String)
        /// An irreversible step was done, but the page never confirmed it. Never retried or handed on:
        /// it may have gone through.
        case unconfirmed(String)
        /// An irreversible step the page turned down, saying what it wants ("Please confirm the declaration").
        /// Nothing went through.
        case refused(String)
    }

    private func perform(_ planned: HybridReplay.Planned, skill: Skill, inputs: [String: SkillInput], values: [String: String],
                         tab: BrowserTab, item: SkillBinder.Bound, next: SkillStep? = nil) async -> StepOutcome {
        guard let env, let runID else { return .failed("okidoki quit") }
        let step = planned.step
        let action = step.action ?? "click"
        let scoped = planned.values
        switch action {
        case "navigate":
            guard let url = (step.input ?? step.url).flatMap({ BrowserSteps.addressURL(ParameterFill.fill($0, values: scoped).text) }) else {
                return .failed("no address")
            }
            // `navigate` already settles the new page (BrowserTab.navigate awaits settle with a longer
            // limit), so settling again here was a second wait for the same quiet on every replay.
            await tab.navigate(url)
            // A search address that the site answers with its home page instead of results (Google
            // Flights' `?q=…` often lands on the form with the fields filled in) leaves the next step
            // staring at a page with no results. Say so once, cheaply, so the read that follows waits on
            // content rather than on an address.
            return .done
        case "login":
            let site = BrowserSteps.vaultReference(in: step.input ?? "")?.site ?? BrowserSteps.host(of: step.url ?? "")
            let here = BrowserSteps.host(of: tab.webView.url?.absoluteString ?? "")
            guard BrowserSteps.sameSite(here, site) else { return .lost("the page is \(here), not \(site)") }
            guard let login = env.vaultLogin(for: site) else { return .failed("no unlocked vault login for \(site)") }
            let result = await tab.fillLogin(username: login.username, password: login.password)
            return result.ok ? .done : .failed(result.detail ?? "couldn't find the login fields")
        case "dialog":
            tab.dialogAnswer = BrowserSteps.dialogAnswer(ParameterFill.fill(step.input ?? "accept", values: scoped).text)
            return .done
        case "think":
            let goal = describeGoal(step.text, values: scoped, inputs: inputs)
            env.replayLog(runID, "→ \(item.label): working out “\(ParameterFill.fill(step.text, values: scoped).text)”")
            let result = await thinkTouching(goal: goal, tab: tab, maxTurns: step.maxTurns ?? 14, tag: step.id)
            guard result.ok else { return .lost(result.summary.isEmpty ? "couldn't do “\(step.text)”" : result.summary) }
            return .learned(result.touched.map {
                SkillPromoter.Action(action: $0.action, selectors: $0.selectors, label: $0.label, role: $0.role, input: $0.input, url: $0.url)
            })
        case "read":
            // A read with nothing to capture isn't a step at all; saying done would claim work it didn't do.
            guard let name = step.capture else { return .failed("this read step doesn't say what to read") }
            if let value = await read(step, inputs: inputs, tab: tab, values: scoped, label: item.label) { return .captured(name, value) }
            // The steps ran but the answer is missing: that is the whole job of a read, so it fails,
            // loudly and in the log. As a "doubt" it was invisible — the pass reported done and the run
            // said "replayed once" with no answer in it.
            return .failed("the steps ran, but couldn't read the \(name.replacingOccurrences(of: "_", with: " ")) from the page")
        default:
            break
        }

        // click · type · select · press · hover: the recorded element, checked.
        var input = step.input
        var typed: String?
        if let raw = input {
            if let ref = BrowserSteps.vaultReference(in: raw) {
                let here = BrowserSteps.host(of: tab.webView.url?.absoluteString ?? "")
                guard BrowserSteps.sameSite(here, ref.site) else { return .lost("the page is \(here), not \(ref.site), so the secret wasn't typed") }
                guard let secret = env.vaultSecret(site: ref.site, field: ref.field) else {
                    return .failed(["username", "email", "user", "password"].contains(ref.field)
                                   ? "no unlocked vault login for \(ref.site)" : "this field needs a code or card number only you have")
                }
                input = secret
            } else {
                let filled = render(raw, values: scoped, inputs: inputs)
                input = filled
                typed = filled
            }
        }
        // Loop rows find their own element: `#amount-{{item.index}}` → `#amount-2`.
        let templated = (step.selectors ?? []).contains { $0.contains("{{") } || (step.label ?? "").contains("{{")
        var selectors = (step.selectors ?? []).map { $0.contains("{{") ? ParameterFill.fill($0, values: scoped).text : $0 }
        // A click named after a value ("Friday, December 18, 2026", "Seville"): selectors kept from the run
        // it was learned on point at that run's element ("the cell that says 10"). Only ones whose element
        // carries this pass's values are tried; none fitting means the model finds it, never the old one.
        if action == "click", let label = step.label, label.contains("{{") {
            let wanted = ParameterFill.names(in: label).compactMap { name -> String? in
                let raw = scoped[name] ?? scoped[ParameterFill.key(name)]
                return raw.map { render("{{\(name)}}", values: [name: $0], inputs: inputs) }
            }.filter { !$0.isEmpty }
            var kept: [String] = []
            for (n, raw) in (step.selectors ?? []).enumerated() {
                if raw.contains("{{") { kept.append(selectors[n]); continue }
                guard let found = await tab.label(of: [raw]) else { continue }
                if HybridReplay.carries(found, all: wanted) { kept.append(raw) }
            }
            selectors = kept
        }
        var payload: [String: Any] = ["action": action, "selectors": selectors]
        if action == "type" { payload["text"] = input ?? "" }
        if action == "type", let kind = BrowserReplayer.secretKind(step) { payload["secret"] = kind }
        if action == "select" { payload["value"] = input ?? "" }
        if action == "press" { payload["key"] = input ?? "Enter" }
        // A value written differently from the dropdown's option ("24(b)" for "24B"): pick the option it means.
        if action == "select", let wanted = input, let options = await tab.options(of: selectors), !options.isEmpty {
            let picked = SkillBinder.choice(wanted, in: options)
            payload["value"] = picked
            if typed != nil { typed = picked }
        }

        // A page that says it's still loading isn't ready: its buttons may not do anything yet. Bounded and
        // polled properly — the element lookup below retries anyway, so this only covers the start of a load.
        var busyWaits = 0
        while busyWaits < 8, await tab.isBusy() {
            if Task.isCancelled { break }
            busyWaits += 1
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        if step.irreversible == true, let want = step.label.map({ ParameterFill.fill($0, values: scoped).text }), !want.isEmpty {
            // Something that can't be undone is pressed once, so only once it's really the control it was:
            // a button the page hasn't finished setting up yet (no label, no handler) would swallow it.
            let same: (String?) -> Bool = { got in got.map { HybridReplay.sameValue(typed: want, field: $0) } ?? false }
            var labelWaits = 0
            while labelWaits < 25, !same(await tab.label(of: selectors)) {
                if Task.isCancelled { break }
                labelWaits += 1
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            await tab.settle(limit: 2)
        }
        await clearBefore(step, selectors: selectors, skill: skill, tab: tab)
        let textBefore = step.irreversible == true ? await tab.pageText() : ""
        let urlBefore = tab.webView.url?.absoluteString ?? ""
        var result = await tab.act(payload)
        // A page that builds itself after load: look again every 150ms, then clear popups. On the right
        // page, already settled, a missing element is really missing (renamed): a short look is enough.
        // A page that says it's loading gets up to 8s more.
        var patience = 16
        if !result.ok, let path = step.anchor?.path, HybridReplay.matches(StepAnchor(path: path), await tab.observation()) { patience = 10 }
        var waited = 0
        var cleared = false
        // Not found yet, or the page mid-navigation (its script not there yet, or the call failing).
        let notYet: (BrowserActResult) -> Bool = { r in
            !r.ok && (r.detail == nil || r.detail == "not on this page" || r.detail == "the page is still loading")
        }
        while notYet(result), !Task.isCancelled {
            if waited >= patience {
                // Past the budget, only a page that still says it's loading is worth more time. One JS
                // call, and bailing at once when the page is idle is what stops a step whose control is
                // simply gone (a stale recorded button) from spending ten seconds on it and then two
                // model rescues on top.
                guard waited < patience + 53, await tab.isBusy() else { break }
            }
            if waited == min(4, patience - 1), !cleared,
               await clearInterrupts(skill: skill, seen: await tab.observation(), tab: tab, allowModel: false) {
                cleared = true
                result = await tab.act(payload)
                continue
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            result = await tab.act(payload)
            waited += 1
        }
        var healedSelectors: [String]?
        // What the rescue pressed first to bring the element into view (a "Next" that shows the rest of the
        // same form): kept as plain steps before this one, so the next replay needs no model here.
        var revealedBy: [Touched] = []
        // A click that only got you to the next step's element (a "Next" learned on a form that showed
        // everything at once again): when that element is already showing here, the click isn't needed.
        if !result.ok, action == "click", step.irreversible != true, let next, ["type", "select", "click"].contains(next.action ?? ""),
           next.mode != "think", let wanted = next.selectors, !wanted.isEmpty, step.anchor?.path == next.anchor?.path {
            var showing = false
            for selector in wanted.prefix(4) where !selector.contains("{{") { if await tab.isPresent(selector) { showing = true; break } }
            if showing {
                env.replayLog(runID, "→ \(item.label): “\(step.label ?? "that click")” isn't needed here — the next field is already showing")
                return .done
            }
        }
        if !result.ok {
            // None of the saved ways find it. The model picks the element that does this step's job on
            // today's page (a renamed button counts), for this one step; what it picked becomes the fix.
            //
            // One rescue, not two: `rescueByPurpose` is the stronger of the two (it is told what the step
            // is for and can scope by row), and running the weaker ref-based one first only added a model
            // call's latency before the same work was done again.
            guard let (fixed, selectors, before) = await rescueByPurpose(step, typed: payload["secret"] == nil ? (payload["value"] as? String ?? input) : nil,
                                                                 row: planned.iteration.map { $0 + 1 }, values: scoped, tab: tab) else {
                return .lost("\(step.label.map { "“\($0)”" } ?? "the element") isn't on the page")
            }
            if planned.iteration == nil { revealedBy = before }
            result = fixed
            if !selectors.isEmpty { result.selectors = selectors; result.matched = -2 }
        }
        if !templated, result.matched > 0 || result.matched == -2 { healedSelectors = BrowserReplayer.reordered(step.selectors ?? [], found: result.selectors) }
        // A rescue inside a loop finds *one row's* control ("#v2-section-1"), and saving that as-is would
        // point every later iteration at row 1. Replacing the row number with the template's placeholder
        // sounds right and is not: the rescue's own selector list also carries the controls it pressed to
        // get there, and rewriting digits across all of them produced selectors for the wrong elements
        // (a submit button filed under "the section dropdown"), which is far worse than a repeated rescue.
        // So a templated step keeps its template; only a non-templated step takes a healed selector.
        if ["click", "press"].contains(action) {
            // Only a click that took the page somewhere needs a real wait. A same-page click (a dropdown
            // opening, a checkbox) is followed by the next step's own anchor check, which waits properly:
            // six seconds here on every click was most of a replay's wall clock.
            let movedPage = (tab.webView.url?.absoluteString ?? "") != urlBefore
            await tab.settle(limit: movedPage ? 6 : 1.2, fresh: true)
        } else if action == "hover" {
            await tab.settle(limit: 1.2, fresh: true)
        }

        // Did the field take it? Masks reformat, so this compares what matters.
        var doubt: String?
        if let typed, ["type", "select"].contains(action), payload["secret"] == nil {
            let selectors = result.selectors.isEmpty ? (step.selectors ?? []) : result.selectors
            if let now = await tab.value(of: selectors) {
                let ok = HybridReplay.sameValue(typed: typed, field: now.value) || HybridReplay.sameValue(typed: typed, field: now.text)
                if !ok {
                    _ = await tab.act(payload)
                    if let again = await tab.value(of: selectors),
                       !(HybridReplay.sameValue(typed: typed, field: again.value) || HybridReplay.sameValue(typed: typed, field: again.text)) {
                        doubt = "“\(step.label ?? "a field")” shows “\(again.text)”, not “\(typed)”"
                        env.replayLog(runID, "✗ \(item.label): \(doubt!)")
                    }
                }
            }
        }

        // Did it lead where it should?
        if let expect = step.expect, !expect.isEmpty {
            var unmet = await check(expect, tab: tab)
            if !unmet.isEmpty, step.irreversible == true {
                // Something that can't be undone is never simply done again: it may be on its way (a slow
                // submit). Only when the site says it failed for a passing reason ("busy, try again") is it
                // pressed once more, the way a person would.
                var retries = 0
                let deadline = Date().addingTimeInterval(25)
                while !unmet.isEmpty, Date() < deadline, !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    unmet = await check(expect, tab: tab)
                    guard !unmet.isEmpty else { break }
                    let now = await tab.pageText()
                    if let said = HybridReplay.refusal(before: textBefore, after: now) { return .refused(said) }
                    if retries < 2, let said = HybridReplay.transientError(in: now) {
                        retries += 1
                        env.replayLog(runID, "→ \(item.label): the site said “\(said)” — trying again")
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        if !(await check(expect, tab: tab)).isEmpty {
                            _ = await tab.act(payload)
                            await tab.settle(limit: 6, fresh: true)
                        }
                    }
                }
                if !unmet.isEmpty {
                    let page = await tab.pageText()
                    let said = page.split(separator: "\n").first { line in
                        let l = line.lowercased()
                        return ["error", "failed", "couldn't", "could not", "try again", "wrong", "invalid", "sure"].contains { l.contains($0) }
                    }
                    return .unconfirmed(unmet.joined(separator: ", ") + (said.map { " (the page says “\($0)”)" } ?? ""))
                }
            } else if !unmet.isEmpty {
                // Slow page, or a popup in the way. A settle already waited for the page to stop moving,
                // so a short look is enough: a single-page app that never changes its address was costing
                // the full four seconds on every click (and a re-press on top of that).
                var deadline = Date().addingTimeInterval(1.2)
                while !unmet.isEmpty, !Task.isCancelled {
                    if await tab.humanCheck() != nil { break }
                    if Date() >= deadline {
                        let loading = await tab.isBusy()
                        guard loading else { break }
                        // It really is still loading: give the page the rest of its time.
                        deadline = Date().addingTimeInterval(6)
                    }
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    unmet = await check(expect, tab: tab)
                }
                if !unmet.isEmpty, await clearInterrupts(skill: skill, seen: await tab.observation(), tab: tab, allowModel: true) {
                    _ = await tab.act(payload)
                    await tab.settle(limit: 6, fresh: true)
                    unmet = await check(expect, tab: tab)
                }
                if !unmet.isEmpty {
                    // The page refused (a validation message) or went somewhere else. For an ordinary
                    // click this is not a lost step: the page may simply be a single-page app that keeps
                    // its address (Google Flights' Search stays on /travel/flights and fills the results
                    // in place), and the next step finds its own element and checks the page itself.
                    // Only an irreversible step treats this as a refusal, and that is above.
                    let page = await tab.pageText()
                    let refused = page.split(separator: "\n").first { line in
                        let l = line.lowercased()
                        return ["required", "invalid", "must ", "wrong", "can't be", "cannot be"].contains { l.contains($0) }
                    }
                    guard let refused else { return .done }
                    return .lost(unmet.joined(separator: ", ") + " (the page says “\(refused)”)")
                }
            }
        }
        if let doubt { return .doubt(doubt) }
        if !revealedBy.isEmpty {
            // A reveal (a "Next" the rescue pressed to show more fields) is the bigger lesson, and it is
            // returned as the promoted steps. The repaired selector rides along inside them: the last
            // action is this step on the element the rescue used, so `SkillPromoter.promote` learns it
            // too and the next replay doesn't rescue the same step again.
            let actions = revealedBy + [Touched(action: action, selectors: result.selectors, label: result.label ?? step.label,
                                                role: result.role ?? step.role, input: typed ?? input, url: tab.webView.url?.absoluteString)]
            return .learned(actions.map { SkillPromoter.Action(action: $0.action, selectors: $0.selectors, label: $0.label, role: $0.role, input: $0.input, url: $0.url) })
        }
        if let healedSelectors { return .healed(healedSelectors) }
        return .done
    }

    /// Runs `work`, giving up after `seconds` (nil). The work itself is cancelled: it holds the tab, and
    /// a step still running in the background would fight the next one.
    private func withTimeout(seconds: Double, _ work: @escaping () async -> StepOutcome) async -> StepOutcome? {
        let task = Task { await work() }
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            task.cancel()
        }
        let outcome = await task.value
        timer.cancel()
        return task.isCancelled ? nil : outcome
    }

    /// The text a step types: placeholders filled, and when the whole input is one value, that value
    /// rendered for its input (money grouped or plain, a date in the field's format, a choice's exact text).
    private func render(_ raw: String, values: [String: String], inputs: [String: SkillInput]) -> String {
        let names = ParameterFill.names(in: raw)
        if names.count == 1, raw.trimmingCharacters(in: .whitespaces) == "{{\(names[0])}}", let input = inputs[ParameterFill.key(names[0])] {
            let value = ParameterFill.fill(raw, values: values).text
            if input.kind == "choice" { return SkillBinder.choice(value, in: input.choices) }
            return HybridReplay.render(value, as: input)
        }
        return ParameterFill.fill(raw, values: values).text
    }

    /// One step by the model, told what the step is for: the label it had, the page it was on, and
    /// where it should lead. Returns the act result and the selectors of the element it used.
    private func rescueByPurpose(_ step: SkillStep, typed: String?, row: Int? = nil, values: [String: String] = [:],
                                 tab: BrowserTab) async -> (BrowserActResult, [String], [Touched])? {
        guard let env, env.hasKey("anthropic") else { return nil }
        let action = step.action ?? "click"
        var goal = "One step of a recorded task, on the current page: \(action) the element that does what "
            + (step.label.map { "“\(ParameterFill.fill($0, values: values).text)”" } ?? "the recorded \(step.role ?? "control")") + " did when it was recorded"
        if let role = step.role { goal += " (a \(role))" }
        if let typed, action == "type" { goal += ", typing “\(typed)”" }
        if let typed, action == "select" { goal += ", choosing “\(typed)”" }
        goal += "."
        if let next = step.expect?.urlContains { goal += " It should lead to a page whose address contains “\(next)”." }
        if let landmark = step.anchor?.landmark { goal += " It's on the page headed “\(landmark)”." }
        if let row { goal += " This is entry \(row) of a list: use the control that belongs to entry \(row) (its label or row number is \(row)), not another row's." }
        goal += " Its label may have changed; pick the element with the same purpose. Close a popup first if one is in the way."
            + " If it isn't showing because the form now comes in parts on this same page, press the control that shows the next part"
            + " (a “Next” that reveals more fields without submitting anything or leaving the page) first."
            + " Do only this one step, then finish with success true; if nothing on the page does this, finish with success false."
        let startPath = URLComponents(string: tab.webView.url?.absoluteString ?? "")?.path
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: 4, tag: "fix-\(step.id)")
        // The element the rescue used for *this* step. The fallback to any click is only for a step that
        // was itself a click: for a select or a type, a click the model made on the way (to reach the review
        // page, to submit) is not this step's control — taking the last one filed a "Submit return" button
        // under "the section dropdown", and the replay then submitted with the dropdown untouched.
        let wanted = result.touched.lastIndex { $0.action == action }
            ?? (action == "click" ? result.touched.lastIndex { $0.action == "click" } : nil)
        guard result.ok, let index = wanted else { return nil }
        let last = result.touched[index]
        // Clicks before it that only showed more of the page (same address, nothing risky) are kept as steps.
        let before = Array(result.touched[..<index])
        let revealing = !before.isEmpty && before.allSatisfy { touched in
            touched.action == "click" && !touched.selectors.isEmpty && !MacReplay.isRisky(touched.label ?? "")
                && URLComponents(string: touched.url ?? "")?.path == startPath
        } && URLComponents(string: tab.webView.url?.absoluteString ?? "")?.path == startPath
        if let runID {
            let shown = revealing ? before.compactMap(\.label).map { "“\($0)”, then " }.joined() : ""
            env.replayLog(runID, "→ found “\(step.label ?? action)” as \(shown)“\(last.label ?? "an element")”")
        }
        return (BrowserActResult(ok: true, detail: nil, selectors: last.selectors, matched: -2, label: last.label, role: step.role), last.selectors,
                revealing ? before : [])
    }

    private func check(_ expect: StepExpectation, tab: BrowserTab) async -> [String] {
        let seen = await tab.observation()
        var present: [String: Bool] = [:]
        for selector in [expect.elementPresent, expect.elementGone].compactMap({ $0 }) where !selector.isEmpty {
            present[selector] = await tab.isPresent(selector)
        }
        return HybridReplay.unmet(expect, seen, present: { present[$0] ?? false })
    }

    /// Popups the model closed on this run, kept on the skill at the end so code closes them next time.
    private var learnedInterrupts: [InterruptHandler] = []
    /// "skill#step" for irreversible steps seen showing a pass's details, this session.
    private var echoing: Set<String> = []

    /// Gets a popup out of the way. True when something was clicked. In order: the skill's own and the
    /// built-in rules; a button that only closes it ("Maybe later", "Stay signed in"; with `generic`, also
    /// "Close" and "×"); and, with `allowModel`, one look by the model at a real modal, whose choice
    /// becomes a rule. Rules click inside the popup only, never a button on the page behind it.
    private func clearInterrupts(skill: Skill, seen: HybridReplay.Observation, tab: BrowserTab,
                                 generic: Bool = true, allowModel: Bool = false) async -> Bool {
        let boxes = await tab.dialogs()
        guard !boxes.isEmpty else { return false }
        let dialogText = boxes.map(\.text).joined(separator: "\n")
        for handler in HybridReplay.interrupts(showing: seen, skill: (skill.interrupts ?? []) + learnedInterrupts, dialogText: dialogText) {
            var hit = false
            if let label = handler.clickLabel { hit = await tab.clickInDialog(label) }
            if !hit, let selector = handler.clickSelector { hit = await tab.act(["action": "click", "selectors": [selector]]).ok }
            if !hit, let key = handler.key { hit = await tab.act(["action": "press", "key": key]).ok }
            if hit {
                if let runID { env?.replayLog(runID, "→ closed a popup (\(handler.clickLabel ?? handler.key ?? "it"))") }
                await tab.settle(limit: 2, fresh: true)
                return true
            }
        }
        for box in boxes {
            if let label = HybridReplay.safeDismissal(in: box.buttons, generic: generic), await tab.clickInDialog(label) {
                if let runID { env?.replayLog(runID, "→ closed a popup (\(label))") }
                await tab.settle(limit: 2, fresh: true)
                return true
            }
        }
        guard allowModel, let modal = boxes.first(where: \.modal), let env, env.hasKey("anthropic") else { return false }
        let goal = "A popup is covering the page in the middle of a task. Close it the way a careful person would to get back to "
            + "what they were doing: stay signed in, decline tours, offers and surveys, accept cookies. Never sign out, buy, pay, "
            + "submit, delete or confirm anything, and don't leave the page. The popup says: “\(modal.text.prefix(300))”, with buttons "
            + modal.buttons.map { "“\($0)”" }.joined(separator: ", ") + ". Do only that, then finish with success true."
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: 2, tag: "popup")
        guard result.ok, let clicked = result.touched.last(where: { $0.action == "click" })?.label, !clicked.isEmpty else { return false }
        if let runID { env.replayLog(runID, "→ closed a popup (\(clicked)) — remembered for next time") }
        let risky = ["sign out", "log out", "logout", "delete", "buy", "pay", "submit", "confirm", "remove", "cancel"]
        if let key = HybridReplay.dialogKey(modal.text), !risky.contains(where: { clicked.lowercased().contains($0) }),
           !learnedInterrupts.contains(where: { $0.whenText == key }) {
            learnedInterrupts.append(InterruptHandler(whenText: key, clickLabel: clicked, source: "learned"))
        }
        await tab.settle(limit: 2, fresh: true)
        return true
    }

    /// On a page no step of this skill is on (a "verify your email" step put into the flow): the rule
    /// learned for that page, or a button that only moves past it ("Skip for now"). True when one was pressed.
    private func passUnknownPage(skill: Skill, plan: [HybridReplay.Planned], tab: BrowserTab, prefix: String) async -> Bool {
        let norm: (String) -> String = { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
        guard let path = URLComponents(string: tab.webView.url?.absoluteString ?? "")?.path, !norm(path).isEmpty else { return false }
        let known = Set(plan.compactMap { $0.step.anchor?.path }.map(norm))
        guard !known.isEmpty, !known.contains(norm(path)) else { return false }
        let rules = ((skill.interrupts ?? []) + learnedInterrupts)
            .filter { $0.source == "learned-page" && norm(String(($0.whenText ?? "").dropFirst(5))) == norm(path) }.compactMap(\.clickLabel)
        for label in rules + HybridReplay.pageSkips where await tab.clickText(label) {
            if let runID { env?.replayLog(runID, "→ \(prefix)on a page the skill doesn't know (“\(tab.webView.title ?? path)”), pressed “\(label)”") }
            await tab.settle(limit: 6, fresh: true)
            return true
        }
        return false
    }

    /// Before acting: a popup in front of the page swallows clicks, so it goes first. Not when the
    /// step's own element is in it (the step is answering that dialog).
    private func clearBefore(_ step: SkillStep, selectors: [String], skill: Skill, tab: BrowserTab) async {
        let boxes = await tab.dialogs()
        guard !boxes.isEmpty, !(await tab.inDialog(selectors)) else { return }
        _ = await clearInterrupts(skill: skill, seen: await tab.observation(), tab: tab, generic: false,
                                  allowModel: boxes.contains(where: \.modal))
    }

    /// The value a read step captures. A token with a shape (a reference number) is matched in code; an
    /// answer (a population, a price with its context) is read by the model from the page, in one call.
    private func read(_ step: SkillStep, inputs: [String: SkillInput], tab: BrowserTab,
                      values: [String: String] = [:], label: String = "") async -> String? {
        guard let name = step.capture else { return nil }
        let input = inputs[ParameterFill.key(name)]
        if HybridReplay.needsReading(input) {
            await tab.settle(limit: 4)
            return await readByModel(step, input: input, name: name, values: values, label: label, tab: tab)
        }
        for _ in 0..<10 {
            if let value = HybridReplay.capture(in: await tab.pageText(), example: input?.example, pattern: input?.pattern) { return value }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        // The page writes it another way ("9.2" and "/10" on separate lines): the model reads it instead.
        return await readByModel(step, input: input, name: name, values: values, label: label, tab: tab)
    }

    private func readByModel(_ step: SkillStep, input: SkillInput?, name: String, values: [String: String], label: String,
                             tab: BrowserTab) async -> String? {
        guard let env, let runID, env.hasKey("anthropic") else { return nil }
        // Wait for the page to hold what is being read. "results are on the page and it has stopped saying
        // it's fetching" is the real condition; poll it directly so the read starts the moment it's true
        // instead of sleeping out a fixed settle first.
        //
        // Readiness must not assume a price: a reference number, a confirmation code or an address is just
        // as much a thing to read off a page, and requiring a currency symbol made those reads wait the
        // whole budget and then answer nothing.
        let wantsPrice = step.text.lowercased().contains("price") || step.text.lowercased().contains("fare")
            || step.text.lowercased().contains("cost") || (input?.description.lowercased().contains("price") ?? false)
        var ready = false
        var stable = 0
        var lastLength = -1
        let startedAt = Date()
        for _ in 0..<80 {
            // The cheap probe, not pageText(): polling innerText stalls the page being waited for.
            let probe = await tab.fill()
            let priced = !wantsPrice || probe.priced
            let enough = probe.len > 600 && priced
            // "Enough content, and it stopped growing": true for a fare list, a confirmation and a code
            // alike. A live page (a list still filling in) never stops growing, so after 2.5s enough
            // content and the prices being there is enough — waiting for stillness would read nothing.
            stable = (enough && probe.len == lastLength) ? stable + 1 : 0
            lastLength = probe.len
            if !probe.loading, (stable >= 2 || (enough && Date().timeIntervalSince(startedAt) > 2.5)) { ready = true; break }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        if !ready { await tab.settle(limit: 3) }
        // The address carried the search but the site answered with its form, or with a "best flights"
        // strip that has no route rows (Google Flights' `?q=` free text). Fill the form and press Search:
        // the values are right here, and it costs a second against a model call that reads nothing.
        // Checked even when the probe looked ready: Google's "best flights" strip carries prices but no
        // route rows, and a `?q=` address can render a half-built page that still says "Loading results"
        // with the trip type back at "Round trip". What counts is a row: a time, a duration and the word
        // nonstop or stops, all present.
        let pageText = await tab.readText()
        let hasTime = pageText.range(of: #"\d{1,2}:\d{2}"#, options: .regularExpression) != nil
        let hasDuration = pageText.range(of: #"\d+\s*hr"#, options: .regularExpression) != nil
        let hasStops = pageText.range(of: #"(?i)nonstop|\bstops?\b"#, options: .regularExpression) != nil
        // A page that still says it's fetching, or whose trip type is back at "Round trip" when this skill
        // asked for one way, hasn't answered the address: the rows on it are from a previous search.
        let stillLoading = pageText.range(of: #"(?i)loading results|fetching results|searching flights"#, options: .regularExpression) != nil
        let looksLikeResults = ready && hasTime && hasDuration && hasStops && !stillLoading
        if !looksLikeResults {
            if await fillSearchForm(tab: tab, values: values) {
                env.replayLog(runID, "→ \(label): no route rows on the page, so filled the form and searched")
                await tab.settle(limit: 6, fresh: true)
                for _ in 0..<50 {
                    let probe = await tab.fill()
                    if probe.len > 600, probe.priced { ready = true; break }
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
            }
        }
        // A token with a shape (a reference number) is read in code, no model needed.
        if let pattern = input?.pattern, !pattern.isEmpty,
           let value = HybridReplay.capture(in: await tab.pageText(), example: input?.example, pattern: pattern) { return value }
        // Content-first text: the fare list has to be inside the cap the model is given.
        let content = await tab.readText()
        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                // A results list that hasn't arrived after the first look: ask the page for it again. A
                // reload is what a person does when a page sits on "Loading results", and it costs one
                // second against the model call the alternative spends.
                let probe = await tab.fill()
                if probe.loading, attempt == 1 {
                    tab.webView.reload()
                    await tab.settle(limit: 6)
                }
            }
            // The third look gives the model the page in its own order and unfiltered: a read that keeps
            // coming back empty on a page that clearly has the content is usually the filtered text
            // losing the one line that mattered.
            let text = attempt < 2 ? content : await tab.pageText()
            if let value = await readOnce(step, input: input, name: name, values: values, label: label, tab: tab,
                                          env: env, runID: runID, page: text) {
                return value
            }
        }
        return nil
    }

    /// Fills a search page's own form and presses its Search button, with the values this pass was given.
    ///
    /// A recorded `?q=` address is a search box's words, not a result page: Google Flights answers it with
    /// the form filled in and a "best flights" strip that has no route rows. When a read finds no results
    /// on a page that is clearly a search form, this does what a person would — type the trip in and
    /// press Search — rather than spending a model call reading a page that has nothing on it.
    private func fillSearchForm(tab: BrowserTab, values: [String: String]) async -> Bool {
        func value(matching words: [String]) -> String? {
            for (name, raw) in values where !raw.isEmpty {
                let key = ParameterFill.key(name)
                if words.contains(where: { key.contains($0) }) { return raw }
            }
            return nil
        }
        let origin = value(matching: ["origin", "from", "departure_city", "departure_airport"])
        let destination = value(matching: ["destination", "to_city", "arrival_city", "arrival_airport"])
        guard origin != nil || destination != nil else { return false }

        var typedSomething = false
        if let origin {
            let result = await tab.act(["action": "type", "selectors": ["input[aria-label=\"Where from?\"]",
                                                                        "input[aria-label*=\"Where from\"]"],
                                        "text": origin])
            typedSomething = typedSomething || result.ok
        }
        if let destination {
            let result = await tab.act(["action": "type", "selectors": ["input[aria-label=\"Where to? \"]",
                                                                        "input[aria-label*=\"Where to\"]"],
                                        "text": destination])
            typedSomething = typedSomething || result.ok
        }
        // A date is written the way the field's own placeholder shows it, so a bound ISO date still lands.
        if let date = value(matching: ["date", "depart"]) {
            _ = await tab.act(["action": "type", "selectors": ["input[aria-label=\"Departure\"]",
                                                               "input[placeholder=\"Departure\"]"],
                               "text": date])
        }
        guard typedSomething else { return false }
        await tab.settle(limit: 2, fresh: true)
        let pressed = await tab.act(["action": "click", "selectors": ["role=button|Search",
                                                                      "button[aria-label=\"Search\"]",
                                                                      "role=button|Search for flights",
                                                                      "text=button|Search"]])
        return pressed.ok
    }

    private func readOnce(_ step: SkillStep, input: SkillInput?, name: String, values: [String: String], label: String,
                          tab: BrowserTab, env: AppEnvironment, runID: String, page text: String? = nil) async -> String? {
        // Content-first text: the fare list has to be inside the cap the model is given.
        var page = ""
        if let text { page = text } else { page = await tab.readText() }
        guard !page.isEmpty else { return nil }
        let what = ParameterFill.fill(input?.description.isEmpty == false ? input!.description : step.text, values: values).text
        let given = values.filter { !$0.key.hasPrefix("today") && !$0.key.hasPrefix("item.") && $0.key != "ref" && !$0.value.isEmpty }
            .sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "; ")
        let payload: [String: Any] = [
            // A page to read, not documents to fill a form from: a rendered list puts a fare, its airline
            // and the word "Nonstop" on separate lines, which the document prompt refuses to group.
            "read": true,
            "item": label.isEmpty ? name : label,
            "inputs": [["name": name, "description": what, "kind": "text", "required": true,
                        "hint": "Answer it the way a person would tell someone: the value with its unit and context, one or two short sentences, exactly as the page says."]],
            "documents": [["name": "the page (\(tab.webView.title ?? ""))", "text": String(page.prefix(18_000))]],
            "request": what,
        ]
        env.store.countModelCall(runID)
        guard let reply = await BrainClient.shared.smartReplay("skill/resolve", body: payload) else {
            env.replayLog(runID, "✗ \(label): the reading model didn't answer")
            return nil
        }
        guard let found = (reply["values"] as? [String: [String: Any]])?[name], let value = found["value"] as? String else {
            // Saying why is the difference between "it read nothing" and "the page had nothing to read".
            let said = (reply["error"] as? String) ?? "no value for \(name) in the answer"
            env.replayLog(runID, "✗ \(label): \(said) · page \(page.count) chars, \(page.contains("$") ? "with prices" : "no prices")")
            return nil
        }
        guard !value.trimmingCharacters(in: .whitespaces).isEmpty else {
            env.replayLog(runID, "✗ \(label): the reading model returned an empty value · page \(page.count) chars")
            return nil
        }
        return value
    }

    // MARK: - The gate

    private func askGate(item: SkillBinder.Bound, step: SkillStep, reasons: [String], tab: BrowserTab) async -> GateAnswer {
        guard let env, let runID else { return .stop }
        // One question to the person at a time: passes running side by side queue here, so no answer is lost.
        while gate != nil || handingOff {
            if Task.isCancelled || self.runID != runID { return .stop }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        if Task.isCancelled || self.runID != runID { return .stop }
        env.replayLog(runID, "→ \(item.label): paused before “\(step.text)” · \(reasons.joined(separator: "; "))")
        status("\(item.label) · waiting for your okay", in: tab)
        let shown = item.values.filter { key, _ in !key.hasPrefix("today") && key != "ref" && key != "id" }
            .sorted { (item.doubts[$0.key] != nil ? 0 : 1, $0.key) < (item.doubts[$1.key] != nil ? 0 : 1, $1.key) }
            .prefix(12)
            .map { key, value in
                let sensitive = false
                return "· \(key): \(sensitive ? "••••" : value)" + (item.sources[key].map { " — \($0)" } ?? "") + (item.doubts[key].map { " ⚠︎ \($0)" } ?? "")
            }
        let text = "before “\(step.text)” for \(item.label), a check:\n" + reasons.map { "· \($0)" }.joined(separator: "\n")
            + "\n\nvalues:\n" + shown.joined(separator: "\n")
        return await withCheckedContinuation { continuation in
            self.gate = continuation
            env.presentReplayGate(runID: runID, title: "\(item.label) · check before \(step.text.lowercased())", text: text) { [weak self] answer in
                self?.answerGate(answer)
            }
        }
    }

    // MARK: - The model, only where needed

    private func describeGoal(_ text: String, values: [String: String], inputs: [String: SkillInput]) -> String {
        var goal = ParameterFill.fill(text, values: values).text
            .replacingOccurrences(of: #"\{\{\s*item\.([A-Za-z0-9_ ]+?)\s*\}\}"#, with: "its $1", options: .regularExpression)
        // List values read better spelled out than as JSON.
        for (key, input) in inputs where input.kind == "list" {
            let entries = HybridReplay.listValue(values[input.name] ?? values[key] ?? "")
            let spelled = entries.isEmpty ? "none" : entries.enumerated().map { n, e in
                "\(n + 1)) " + e.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
            }.joined(separator: "; ")
            goal = goal.replacingOccurrences(of: values[input.name] ?? "\u{0}", with: spelled)
        }
        return "Do only this part of a task, on the current page, then call finish with success true (or false if it truly can't be done): \(goal). "
            + "Don't submit, pay or leave the page unless this part says to."
    }

    /// A bounded run of the browser agent on this tab: the part of a pass that no recording covers.
    /// What a think run touched, in order: its successful page actions with the element's selectors.
    struct Touched { var action: String; var selectors: [String]; var label: String?; var role: String?; var input: String?; var url: String? }

    func think(goal: String, tab: BrowserTab, maxTurns: Int, tag: String) async -> (ok: Bool, summary: String) {
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: maxTurns, tag: tag)
        return (result.ok, result.summary)
    }

    func thinkTouching(goal: String, tab: BrowserTab, maxTurns: Int, tag: String) async -> (ok: Bool, summary: String, touched: [Touched]) {
        var touched: [Touched] = []
        guard let env, let runID else { return (false, "stopped", touched) }
        let conversation = "\(runID)-think-\(tag.prefix(8))-\(UUID().uuidString.prefix(6))"
        var results: [[String: Any]] = []
        for turn in 0..<maxTurns {
            if Task.isCancelled { return (false, "stopped", touched) }
            await tab.settle(limit: 4)
            let page = await tab.snapshot()
            let body: [String: Any] = [
                "runID": conversation, "goal": goal, "step": turn, "results": results,
                "observation": ["url": page.url, "title": page.title, "elements": page.elements, "text": String(page.text.prefix(6000))],
                "settings": ["claudeModel": env.store.settings.claudeModel],
            ]
            env.store.countModelCall(runID)
            guard let actions = await BrainClient.shared.browserStep(body), !actions.isEmpty else { return (false, "the model didn't answer", touched) }
            results = []
            var halted = false
            for action in actions {
                let type = action["type"] as? String ?? ""
                if halted { results.append(["ok": false, "detail": "not run: the page changed; look again"]); continue }
                switch type {
                case "finish":
                    return (action["success"] as? Bool ?? false, action["summary"] as? String ?? "", touched)
                case "ask":
                    // The model is stuck on a check only a person can pass: theirs for a moment, then on.
                    if let human = await tab.humanCheck(), await handOff(human.text, label: "", tab: tab) {
                        results.append(["ok": true, "detail": "the person got past \(human.text); look again"])
                        halted = true
                        continue
                    }
                    return (false, action["question"] as? String ?? "it needed to ask something", touched)
                case "wait":
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    results.append(["ok": true])
                case "screenshot", "remember", "extract":
                    results.append(["ok": true])
                case "dialog":
                    let answer = (accept: action["accept"] as? Bool ?? true, text: action["text"] as? String)
                    tab.dialogAnswer = answer
                    let step = BrowserSteps.dialog(accept: answer.accept, text: answer.text)
                    touched.append(Touched(action: "dialog", selectors: [], label: nil, role: nil, input: step.input, url: tab.webView.url?.absoluteString))
                    results.append(["ok": true])
                case "navigate":
                    if let raw = action["url"] as? String, let url = BrowserSteps.addressURL(raw) { await tab.navigate(url); halted = true; results.append(["ok": true]) }
                    else { results.append(["ok": false, "detail": "not a URL"]) }
                case "back":
                    await tab.goBack(); halted = true; results.append(["ok": true])
                case "fill_login":
                    let here = BrowserSteps.host(of: tab.webView.url?.absoluteString ?? "")
                    if let login = env.vaultLogin(for: here) {
                        let filled = await tab.fillLogin(username: login.username, password: login.password)
                        results.append(filled.ok ? ["ok": true] : ["ok": false, "detail": filled.detail ?? "no login fields"])
                    } else { results.append(["ok": false, "detail": "no saved login for \(here)"]) }
                case "click", "hover", "type", "select", "press", "scroll":
                    var payload: [String: Any] = ["action": type]
                    for key in ["ref", "text", "submit", "value", "key", "direction"] { if let v = action[key] { payload[key] = v } }
                    let before = tab.webView.url
                    let done = await tab.act(payload)
                    results.append(done.ok ? ["ok": true] : ["ok": false, "detail": done.detail ?? "didn't work"])
                    if done.ok, type != "scroll" {
                        let typed = (payload["text"] ?? payload["value"] ?? (type == "press" ? payload["key"] : nil)) as? String
                        touched.append(Touched(action: type, selectors: done.selectors, label: done.label, role: done.role,
                                               input: typed, url: before?.absoluteString))
                    }
                    env.replayLog(runID, done.ok ? "→ " + BrowserSteps.line(type, label: done.label, input: payload["text"] as? String ?? payload["value"] as? String)
                                              : "✗ \(type): \(done.detail ?? "didn't work")")
                    if ["click", "press", "select"].contains(type) { await tab.settle(limit: 4, fresh: true) }
                    if !done.ok || tab.webView.url != before || type == "press" { halted = true }
                default:
                    results.append(["ok": false, "detail": "not available here"])
                }
            }
        }
        return (false, "took more than \(maxTurns) turns", touched)
    }

    /// The rest of a pass by the agent, from where the page is, with this pass's values and what's left
    /// of the recording as a guide.
    private func escalate(skill: Skill, plan: [HybridReplay.Planned], from cursor: Int, until stop: Int?, values: [String: String],
                          item: SkillBinder.Bound, tab: BrowserTab, reason: String) async -> (outcome: StepOutcome, typed: Bool) {
        let done = plan[..<cursor].map { ParameterFill.fill($0.step.text, values: $0.values).text }.suffix(12)
        let left = plan[cursor..<(stop ?? plan.count)].filter { $0.step.capture == nil }.map { ParameterFill.fill($0.step.text, values: $0.values).text }.prefix(20)
        let ending = stop.map { "Stop right before this final step and don't do it: “\(ParameterFill.fill(plan[$0].step.text, values: plan[$0].values).text)” — when the page is ready for it, finish with success true." }
            ?? "Finish on the confirmation page with success true, and put any reference or confirmation number in your summary."
        let goal = """
        Finish this task in the current tab: \(skill.intent ?? skill.name), for \(item.label). \
        Values to use: \(spelled(skill: skill, values: values)). \
        A replay already did: \(done.joined(separator: " → ")). It stopped because \(reason). \
        What was left, as recorded (the page may have changed, so adapt): \(left.joined(separator: " → ")). \
        Check what the page shows now and continue from there. Never submit, pay, send or delete anything \
        unless it's in the steps above. \(ending)
        """
        let startPath = URLComponents(string: tab.webView.url?.absoluteString ?? "")?.path ?? ""
        let known = Set(plan.compactMap { $0.step.anchor?.path })
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: 30, tag: "rest")
        if let runID, !result.summary.isEmpty { env?.replayLog(runID, "→ \(item.label): \(result.summary)") }
        // A page nobody recorded that the agent got past with one click ("Skip for now"): a rule for next time.
        if result.ok, !startPath.isEmpty, !known.contains(startPath), let first = result.touched.first, first.action == "click",
           let label = first.label, !label.isEmpty, URLComponents(string: first.url ?? "")?.path == startPath,
           !["submit", "pay", "buy", "delete", "sign out", "confirm"].contains(where: { label.lowercased().contains($0) }),
           !learnedInterrupts.contains(where: { $0.whenText == "page:" + startPath }) {
            learnedInterrupts.append(InterruptHandler(whenText: "page:" + startPath, clickLabel: label, source: "learned-page"))
            env?.replayLog(runID ?? "", "→ remembered: on \(startPath), “\(label)” moves on")
        }
        let typed = result.touched.contains { $0.action == "type" || $0.action == "select" }
        return (result.ok ? .done : .failed(result.summary.isEmpty ? reason : result.summary), typed)
    }

    /// This pass's values, spelled out for the model (lists as entries, choices as their option, secrets left out).
    private func spelled(skill: Skill, values: [String: String]) -> String {
        let inputs = skill.inputs ?? []
        let given = inputs.filter { $0.source != "page" }.compactMap { input -> String? in
            guard let value = values[input.name], !value.isEmpty else { return "\(input.description): none" }
            if input.isSensitive { return nil }
            if input.kind == "list" {
                let entries = HybridReplay.listValue(value)
                return "\(input.description): " + (entries.isEmpty ? "none" : entries.map { $0.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ") }.joined(separator: "; "))
            }
            let rendered = input.kind == "choice" ? SkillBinder.choice(value, in: input.choices) : HybridReplay.render(value, as: input)
            return "\(input.description): \(rendered)"
        }
        return given.joined(separator: "; ")
    }
}
