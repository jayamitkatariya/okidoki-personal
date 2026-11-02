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
        browser.showQuietly()
        browser.beginWork("replaying “\(skill.name)”", in: first, runID: runID, threadID: nil) { [weak self] in
            self?.cancel(reason: "you stopped me")
        }
        if browser.activeTab !== first, !browser.model.recording { browser.select(first) }

        task = Task { [weak self] in
            guard let self else { return }
            // Bind first: a form is never started that can't be finished.
            self.status("getting everyone's details ready", in: first)
            let bound = await env.bindItems(skill, passes: passes, runID: runID, request: request)
            if Task.isCancelled || self.runID != runID { return }
            let gaps = bound.filter { !$0.missing.isEmpty }
            if !gaps.isEmpty {
                let lines = gaps.map { "\($0.label): \($0.missing.joined(separator: ", "))" }
                self.end()
                env.failReplay(runID: runID, reason: "missing before starting — " + lines.joined(separator: "; ")
                               + ". Add them to the request (name=value) or put their documents in a vault folder named after them.")
                return
            }
            env.store.updateRun(runID) { run in
                run.steps = bound.map { RunStep(title: $0.label, status: .waiting) }
                if bound.count > 1 { run.summary = "\(bound.count) to do" }
            }
            var healed = skill.steps
            var outcomes: [(label: String, ok: Bool, note: String)] = []
            let limit = max(1, min(3, bound.count))
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
                for (n, tab) in tabs.enumerated() where n < bound.count { launch(n, on: tab); next = n + 1 }
                for await (index, result) in group {
                    if Task.isCancelled || self.runID != runID { group.cancelAll(); return }
                    for (source, selectors) in result.healed where healed.indices.contains(source) {
                        healed[source].selectors = selectors
                        healed[source].heals = (healed[source].heals ?? 0) + 1
                    }
                    let item = bound[index]
                    outcomes.append((item.label, result.ok, result.note))
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
                    if next < bound.count {
                        free.append(result.tab)
                        launch(next, on: free.removeFirst())
                        next += 1
                    }
                }
            }
            if Task.isCancelled || self.runID != runID { return }
            if healed != skill.steps { env.store.updateSkillSteps(skill.id, healed) }
            for tab in tabs.dropFirst() { env.browser.endWork(runID: runID); env.browser.closeTab(tab) }
            self.end()
            let done = outcomes.filter(\.ok).count
            if done == bound.count {
                env.finishReplay(runID: runID, passes: bound.count)
            } else {
                let failed = outcomes.filter { !$0.ok }.map { "\($0.label): \($0.note)" }
                env.failReplay(runID: runID, reason: "\(done) of \(bound.count) done · " + failed.joined(separator: "; "))
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

    private func end() {
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
        var skipped = false
        /// The person said stop at the gate: no more passes.
        var stop = false
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
        let prefix = total > 1 ? "\(item.label) · " : ""

        while cursor < plan.count {
            if Task.isCancelled || self.runID != runID { result.note = "stopped"; return result }
            let planned = plan[cursor]
            let step = planned.step
            let action = step.action ?? "click"
            status("\(prefix)\(cursor + 1)/\(plan.count) · \(ParameterFill.fill(step.text, values: planned.values).text)", in: tab)

            // Is this the place? Popups get cleared; a page that's further along (or behind) gets re-synced.
            if let anchor = step.anchor, !anchor.isEmpty, action != "navigate" {
                var seen = await tab.observation()
                if !HybridReplay.matches(anchor, seen) {
                    if await clearInterrupts(skill: skill, seen: seen, tab: tab) { seen = await tab.observation() }
                }
                if !HybridReplay.matches(anchor, seen) {
                    // The page may still be on its way: give it a moment before deciding it's elsewhere.
                    for _ in 0..<8 where !HybridReplay.matches(anchor, seen) {
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
            }

            // The pause before something irreversible, only when this pass has a doubt.
            if let reasons = HybridReplay.pauseReasons(before: step, skill: skill, doubts: doubts) {
                switch await askGate(item: item, step: step, reasons: reasons, tab: tab) {
                case .carryOn: break
                case .skip: result.skipped = true; result.note = "skipped at “\(step.text)”"; return result
                case .stop: result.stop = true; result.note = "stopped before “\(step.text)”"; return result
                }
            }

            var outcome = await perform(planned, skill: skill, inputs: inputs, values: values, tab: tab, item: item)
            if case .lost(let why) = outcome, step.irreversible == true {
                // The final step itself moved. Only now that it's due (and past the gate) may the model
                // look for it, and for nothing else.
                let (ok, summary) = await think(goal: "Do exactly this one final step now, on the current page: \(step.text). "
                                                  + "The control may be labelled differently now (it does the same job). Then finish with success true.",
                                                  tab: tab, maxTurns: 3, tag: "final")
                outcome = ok ? .done : .failed(summary.isEmpty ? why : summary)
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
            case .doubt(let why):
                doubts.helped.append(why)
            case .failed(let why), .lost(let why):
                result.note = "step “\(ParameterFill.fill(step.text, values: planned.values).text)”: \(why)"
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
        /// Done, but its result couldn't be confirmed.
        case doubt(String)
        case failed(String)
        /// The page isn't where the skill thinks; the agent should take over.
        case lost(String)
    }

    private func perform(_ planned: HybridReplay.Planned, skill: Skill, inputs: [String: SkillInput], values: [String: String],
                         tab: BrowserTab, item: SkillBinder.Bound) async -> StepOutcome {
        guard let env, let runID else { return .failed("okidoki quit") }
        let step = planned.step
        let action = step.action ?? "click"
        let scoped = planned.values
        switch action {
        case "navigate":
            guard let url = (step.input ?? step.url).flatMap({ BrowserSteps.addressURL(ParameterFill.fill($0, values: scoped).text) }) else {
                return .failed("no address")
            }
            await tab.navigate(url)
            await tab.settle(limit: 6)
            return .done
        case "login":
            let site = BrowserSteps.vaultReference(in: step.input ?? "")?.site ?? BrowserSteps.host(of: step.url ?? "")
            let here = BrowserSteps.host(of: tab.webView.url?.absoluteString ?? "")
            guard BrowserSteps.sameSite(here, site) else { return .lost("the page is \(here), not \(site)") }
            guard let login = env.vaultLogin(for: site) else { return .failed("no unlocked vault login for \(site)") }
            let result = await tab.fillLogin(username: login.username, password: login.password)
            return result.ok ? .done : .failed(result.detail ?? "couldn't find the login fields")
        case "think":
            let goal = describeGoal(step.text, values: scoped, inputs: inputs)
            env.replayLog(runID, "→ \(item.label): working out “\(ParameterFill.fill(step.text, values: scoped).text)”")
            let (ok, summary) = await think(goal: goal, tab: tab, maxTurns: step.maxTurns ?? 14, tag: step.id)
            return ok ? .thought : .lost(summary.isEmpty ? "couldn't do “\(step.text)”" : summary)
        case "read":
            guard let name = step.capture else { return .done }
            if let value = await read(step, inputs: inputs, tab: tab) { return .captured(name, value) }
            return .doubt("couldn't read the \(name.replacingOccurrences(of: "_", with: " "))")
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
        var payload: [String: Any] = ["action": action, "selectors": step.selectors ?? []]
        if action == "type" { payload["text"] = input ?? "" }
        if action == "type", let kind = BrowserReplayer.secretKind(step) { payload["secret"] = kind }
        if action == "select" { payload["value"] = input ?? "" }
        if action == "press" { payload["key"] = input ?? "Enter" }

        var result = await tab.act(payload)
        // A page that builds itself after load: look again every 150ms, then clear popups. On the right
        // page, already settled, a missing element is really missing (renamed): a short look is enough.
        var patience = 16
        if !result.ok, let path = step.anchor?.path, HybridReplay.matches(StepAnchor(path: path), await tab.observation()) { patience = 4 }
        var waited = 0
        while !result.ok, result.detail == "not on this page", waited < patience, !Task.isCancelled {
            if waited == min(4, patience - 1), await clearInterrupts(skill: skill, seen: await tab.observation(), tab: tab) { result = await tab.act(payload); continue }
            try? await Task.sleep(nanoseconds: 150_000_000)
            result = await tab.act(payload)
            waited += 1
        }
        var healedSelectors: [String]?
        if !result.ok {
            // None of the saved ways find it. The model picks the element that does this step's job on
            // today's page (a renamed button counts), for this one step; what it picked becomes the fix.
            if step.irreversible == true || action == "press" || action == "hover" {
                if let rescued = await env.browserReplayer.rescueStep(step, input: input, tab: tab, runID: runID, pass: planned.iteration ?? 0) {
                    result = rescued
                }
            }
            if !result.ok {
                guard let (fixed, selectors) = await rescueByPurpose(step, typed: payload["secret"] == nil ? input : nil, tab: tab) else {
                    return .lost("\(step.label.map { "“\($0)”" } ?? "the element") isn't on the page")
                }
                result = fixed
                if !selectors.isEmpty { result.selectors = selectors; result.matched = -2 }
            }
        }
        if result.matched > 0 || result.matched == -2 { healedSelectors = BrowserReplayer.reordered(step.selectors ?? [], found: result.selectors) }
        if ["click", "press"].contains(action) {
            await tab.settle(limit: 6, fresh: true)
        } else if action == "hover" {
            await tab.settle(limit: 1.5, fresh: true)
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
            if !unmet.isEmpty {
                // Slow page, or a popup in the way.
                for _ in 0..<10 where !unmet.isEmpty {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    unmet = await check(expect, tab: tab)
                }
                if !unmet.isEmpty, await clearInterrupts(skill: skill, seen: await tab.observation(), tab: tab) {
                    _ = await tab.act(payload)
                    await tab.settle(limit: 6, fresh: true)
                    unmet = await check(expect, tab: tab)
                }
                if !unmet.isEmpty {
                    // The page refused (a validation message) or went somewhere else.
                    let page = await tab.pageText()
                    let hint = page.split(separator: "\n").first { $0.lowercased().contains("should") || $0.lowercased().contains("required") || $0.lowercased().contains("invalid") || $0.lowercased().contains("fill") }
                    return .lost(unmet.joined(separator: ", ") + (hint.map { " (the page says “\($0)”)" } ?? ""))
                }
            }
        }
        if let doubt { return .doubt(doubt) }
        if let healedSelectors { return .healed(healedSelectors) }
        return .done
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
    private func rescueByPurpose(_ step: SkillStep, typed: String?, tab: BrowserTab) async -> (BrowserActResult, [String])? {
        guard let env, env.hasKey("anthropic") else { return nil }
        let action = step.action ?? "click"
        var goal = "One step of a recorded task, on the current page: \(action) the element that does what "
            + (step.label.map { "“\($0)”" } ?? "the recorded \(step.role ?? "control")") + " did when it was recorded"
        if let role = step.role { goal += " (a \(role))" }
        if let typed, action == "type" { goal += ", typing “\(typed)”" }
        if let typed, action == "select" { goal += ", choosing “\(typed)”" }
        goal += "."
        if let next = step.expect?.urlContains { goal += " It should lead to a page whose address contains “\(next)”." }
        if let landmark = step.anchor?.landmark { goal += " It's on the page headed “\(landmark)”." }
        goal += " Its label may have changed; pick the element with the same purpose. Close a popup first if one is in the way."
            + " Do only this one step, then finish with success true; if nothing on the page does this, finish with success false."
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: 3, tag: "fix-\(step.id)")
        guard result.ok, let last = result.touched.last(where: { $0.action == action || action == "click" }) else { return nil }
        if let runID { env.replayLog(runID, "→ found “\(step.label ?? action)” as “\(last.label ?? "an element")”") }
        return (BrowserActResult(ok: true, detail: nil, selectors: last.selectors, matched: -2, label: last.label, role: step.role), last.selectors)
    }

    private func check(_ expect: StepExpectation, tab: BrowserTab) async -> [String] {
        let seen = await tab.observation()
        var present: [String: Bool] = [:]
        for selector in [expect.elementPresent, expect.elementGone].compactMap({ $0 }) where !selector.isEmpty {
            present[selector] = await tab.isPresent(selector)
        }
        return HybridReplay.unmet(expect, seen, present: { present[$0] ?? false })
    }

    /// Clears whatever known popup is showing. True when something was clicked.
    private func clearInterrupts(skill: Skill, seen: HybridReplay.Observation, tab: BrowserTab) async -> Bool {
        var cleared = false
        for handler in HybridReplay.interrupts(showing: seen, skill: skill.interrupts ?? []) {
            var hit = false
            if let label = handler.clickLabel { hit = await tab.clickText(label) }
            if !hit, let selector = handler.clickSelector { hit = await tab.act(["action": "click", "selectors": [selector]]).ok }
            if !hit, let key = handler.key { hit = await tab.act(["action": "press", "key": key]).ok }
            if hit {
                cleared = true
                if let runID { env?.replayLog(runID, "→ closed a popup (\(handler.clickLabel ?? handler.key ?? "it"))") }
                await tab.settle(limit: 2, fresh: true)
                break
            }
        }
        return cleared
    }

    private func read(_ step: SkillStep, inputs: [String: SkillInput], tab: BrowserTab) async -> String? {
        guard let name = step.capture else { return nil }
        let input = inputs[ParameterFill.key(name)]
        let text = await tab.pageText()
        for _ in 0..<10 {
            if let value = HybridReplay.capture(in: text, example: input?.example, pattern: input?.pattern) { return value }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return HybridReplay.capture(in: await tab.pageText(), example: input?.example, pattern: input?.pattern)
    }

    // MARK: - The gate

    private func askGate(item: SkillBinder.Bound, step: SkillStep, reasons: [String], tab: BrowserTab) async -> GateAnswer {
        guard let env, let runID else { return .stop }
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
    struct Touched { var action: String; var selectors: [String]; var label: String? }

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
                    return (false, action["question"] as? String ?? "it needed to ask something", touched)
                case "wait":
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    results.append(["ok": true])
                case "screenshot", "remember", "extract":
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
                    if done.ok, type != "scroll" { touched.append(Touched(action: type, selectors: done.selectors, label: done.label)) }
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
        let done = plan[..<cursor].map { ParameterFill.fill($0.step.text, values: $0.values).text }.suffix(12)
        let left = plan[cursor..<(stop ?? plan.count)].filter { $0.step.capture == nil }.map { ParameterFill.fill($0.step.text, values: $0.values).text }.prefix(20)
        let ending = stop.map { "Stop right before this final step and don't do it: “\(ParameterFill.fill(plan[$0].step.text, values: plan[$0].values).text)” — when the page is ready for it, finish with success true." }
            ?? "Finish on the confirmation page with success true, and put any reference or confirmation number in your summary."
        let goal = """
        Finish this task in the current tab: \(skill.intent ?? skill.name), for \(item.label). \
        Values to use: \(given.joined(separator: "; ")). \
        A replay already did: \(done.joined(separator: " → ")). It stopped because \(reason). \
        What was left, as recorded (the page may have changed, so adapt): \(left.joined(separator: " → ")). \
        Check what the page shows now and continue from there. Never submit, pay, send or delete anything \
        unless it's in the steps above. \(ending)
        """
        let result = await thinkTouching(goal: goal, tab: tab, maxTurns: 30, tag: "rest")
        if let runID, !result.summary.isEmpty { env?.replayLog(runID, "→ \(item.label): \(result.summary)") }
        let typed = result.touched.contains { $0.action == "type" || $0.action == "select" }
        return (result.ok ? .done : .failed(result.summary.isEmpty ? reason : result.summary), typed)
    }
}
