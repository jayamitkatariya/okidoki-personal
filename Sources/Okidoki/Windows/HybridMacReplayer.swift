import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

/// Smart replay in the Mac's own apps. The same skill, done once per person, invoice or row:
///
/// 1. **Bind:** every pass's values are settled before anything is touched (while the app opens).
/// 2. **Plan:** each pass's steps with conditions applied and loops unrolled, in code.
/// 3. **Run:** each step as recorded, then checked: anchors (is this the window?), readiness (busy, the
///    real control), read-back (did the field take it?), expectations (did it lead where it should?).
///    Sheets get cleared by known rules; a window further along (or back) gets re-synced to.
/// 4. **Help, only on evidence:** a control that can't be found gets one model look, a think step does
///    the part no recording covers, a pass that lost its way is finished by the model up to (never
///    through) the next irreversible step. A pass that goes as recorded makes no model calls.
///
/// Passes run one after another: there's one desktop. With smart replay off, `SkillReplayer.begin`
/// runs instead, untouched. `accessibilityOnly` (a developer switch) acts through Accessibility alone:
/// no pointer, no keys, no screenshots, no app brought to the front.
@MainActor
final class HybridMacReplayer {
    private weak var env: AppEnvironment?
    private var task: Task<Void, Never>?
    private(set) var runID: String?
    var isActive: Bool { task != nil }
    private var gate: CheckedContinuation<HybridBrowserReplayer.GateAnswer, Never>?
    private var observer: MacObserver!
    private(set) var accessibilityOnly = false

    // The ghost, on the pointer path.
    let model = BorrowModel()
    private var panel: GhostPanel?
    private var escMonitor: Any?
    private var globalEsc: Any?

    /// The field the last click put the cursor in: where an Accessibility-only type step types.
    private var typingTarget: AXUIElement?

    init(environment: AppEnvironment) { self.env = environment }

    // MARK: - Start

    func begin(skill: Skill, runID: String, passes given: [[String: String]], times: Int, request: String = "") {
        guard let env, task == nil else {
            env?.failReplay(runID: runID, reason: "another replay is running — let it finish or stop it first")
            return
        }
        accessibilityOnly = env.macAccessibilityOnly
        guard accessibilityOnly ? AXIsProcessTrusted() : AccessibilityActions.canPost else {
            env.failReplay(runID: runID, reason: "allow accessibility access in System Settings, then try again")
            return
        }
        guard !skill.steps.isEmpty else { env.failReplay(runID: runID, reason: "this skill has no steps"); return }
        self.runID = runID
        let appName = skill.steps.first { SkillReplayGeometry.isRealApp($0.app) }?.app ?? skill.startApp ?? ""
        let bundleID = skill.steps.lazy.compactMap { $0.axLocator?.bundleID }.first
        observer = MacObserver(bundleID: bundleID, appName: appName)
        learnedInterrupts = []
        typingTarget = nil
        model.label = "getting everything ready for “\(skill.name)”"
        model.clicking = false
        if !accessibilityOnly {
            showGhost()
            installMonitors()
        }
        let builtins = ParameterFill.builtins()
        let raw = given.isEmpty ? Array(repeating: [String: String](), count: max(1, times)) : given
        let passes = raw.map { builtins.merging($0) { _, mine in mine } }

        task = Task { [weak self] in
            guard let self else { return }
            // The app opens while the values are bound: neither waits for the other.
            let observer = self.observer!
            let activate = !self.accessibilityOnly
            let opening = Task { @MainActor in await observer.launch(activate: activate) }
            let bound = await env.bindItems(skill, passes: passes, runID: runID, request: request)
            _ = await opening.value
            if Task.isCancelled || self.runID != runID { return }
            let gaps = bound.filter { !$0.missing.isEmpty }
            let howToFix = "Add them to the request (name=value) or put their documents in a vault folder named after them."
            let ready = bound.indices.filter { bound[$0].missing.isEmpty }
            if ready.isEmpty {
                let lines = gaps.map { "\($0.label): \($0.missing.joined(separator: ", "))" }
                self.end()
                env.failReplay(runID: runID, reason: "missing before starting — " + lines.joined(separator: "; ") + ". " + howToFix)
                return
            }
            env.speak("Replaying \(skill.name).")
            var outcomes: [(label: String, ok: Bool, note: String)] = []
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
            for (order, index) in ready.enumerated() {
                if Task.isCancelled || self.runID != runID { return }
                let item = bound[index]
                env.store.updateRun(runID) { run in
                    if run.steps.indices.contains(index) { run.steps[index].status = .running; run.steps[index].startedAt = Date() }
                }
                // Each pass starts from the skill's start: whatever the last one left open is closed first.
                if order > 0 { await self.closeLeftovers(skill: skill) }
                let result = await self.runPass(skill: skill, steps: healed, item: item, index: index, of: bound.count)
                if Task.isCancelled || self.runID != runID { return }
                for (source, steps) in result.promotions where promotions[source] == nil { promotions[source] = steps }
                for source in result.echoes where healed.indices.contains(source) && healed[source].echoes != true { healed[source].echoes = true }
                for (source, locator) in result.healed where healed.indices.contains(source) {
                    healed[source].axLocator = locator
                    healed[source].heals = (healed[source].heals ?? 0) + 1
                }
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
                if result.stop { break }
            }
            if Task.isCancelled || self.runID != runID { return }
            let popups = self.learnedInterrupts
            if !promotions.isEmpty || !popups.isEmpty, var current = env.store.skill(skill.id) {
                // What the model worked out becomes plain steps and rules: next time, these parts need no model.
                var steps = healed
                for (source, plain) in promotions.sorted(by: { $0.key > $1.key }) {
                    env.replayLog(runID, "→ learned “\(skill.steps[source].text.prefix(60))…” as \(plain.count) plain steps")
                    steps = SkillPromoter.replacing(steps, at: source, with: plain)
                }
                current.steps = steps
                if !popups.isEmpty {
                    let known = current.interrupts ?? []
                    current.interrupts = known + popups.filter { new in !known.contains { $0.whenText == new.whenText } }
                    env.replayLog(runID, "→ learned how to get past \(popups.count == 1 ? "a popup" : "\(popups.count) popups")")
                }
                env.store.replaceSkill(current)
            } else if healed != skill.steps {
                env.store.updateSkillSteps(skill.id, healed)
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

    func cancel(reason: String) {
        guard let runID, let env else { return }
        EventActuator.stopTyping()
        task?.cancel()
        gate?.resume(returning: .stop)
        gate = nil
        end()
        env.store.finishRun(runID, status: .cancelled, summary: reason)
        env.store.saveNow()
    }

    func answerGate(_ answer: HybridBrowserReplayer.GateAnswer) {
        gate?.resume(returning: answer)
        gate = nil
    }

    private func end() {
        if let runID { env?.closeHandoffCard(runID: runID) }
        personHasIt = false
        handingOff = false
        task = nil
        hideGhost()
        runID = nil
        typingTarget = nil
    }

    private func status(_ line: String) {
        model.label = line
    }

    // MARK: - Pause and hand-off: the Mac is the person's, then theirs to hand back

    /// Paused: every step waits at its top until the person takes it back.
    private(set) var personHasIt = false
    private var takeBackAsked = false
    private(set) var handingOff = false
    var personsTurn: Bool { personHasIt || handingOff }
    /// Bumped by every pause, so a model turn that was in flight when it came is thrown away.
    private var pauseEpoch = 0

    func pauseForPerson(from source: String = "") {
        guard let env, let runID, !personHasIt else { return }
        if handingOff { takeBack(); return }
        personHasIt = true
        pauseEpoch += 1
        takeBackAsked = false
        EventActuator.stopTyping()
        env.store.updateRun(runID) { $0.status = .paused; $0.waitingFor = nil }
        env.replayLog(runID, "→ paused — the Mac is yours" + (source.isEmpty ? "" : " (\(source))"))
        stepAside()
        guard gate == nil else { return }
        env.presentHandoff(runID: runID, title: "paused · the Mac is yours",
                           text: "Do what you need to in \(observer?.appName ?? "the app"). When you take it back, okidoki picks up from wherever the app is.",
                           takeBack: { [weak self] in self?.takeBack() }, stop: { [weak self] in self?.cancel(reason: "you stopped me") })
    }

    func takeBack() {
        guard personHasIt || handingOff, let runID else { return }
        env?.store.updateRun(runID) { $0.status = .running; $0.waitingFor = nil }
        if personHasIt { env?.replayLog(runID, "→ taken back — carrying on from where the app is") }
        personHasIt = false
        takeBackAsked = true
        env?.closeHandoffCard(runID: runID)
    }

    /// No ghost, no Escape monitor, no keys: the person has the Mac.
    private func stepAside() {
        EventActuator.stopTyping()
        model.visible = false
        panel?.orderOut(nil)
        removeMonitors()
    }

    private func stepBackIn() {
        guard !accessibilityOnly, runID != nil else { return }
        model.visible = true
        panel?.orderFrontRegardless()
        installMonitors()
    }

    /// At the top of a step: wait while the person has the Mac, then carry on from wherever it is.
    private func holdWhilePaused() async {
        guard personHasIt, let runID else { return }
        stepAside()
        let said = model.label
        model.label = "paused — the Mac is yours"
        while personHasIt, !Task.isCancelled, self.runID == runID { try? await Task.sleep(nanoseconds: 300_000_000) }
        guard !Task.isCancelled, self.runID == runID else { return }
        model.label = said
        observer.invalidate()
        typingTarget = nil
        stepBackIn()
    }

    /// Something only the person can answer is up (a macOS password prompt, a permission prompt, a code):
    /// nil, or what it is.
    private func personCheck() async -> String? {
        for dialog in await observer.dialogs() {
            if let why = MacReplay.personOnly(text: dialog.title + "\n" + dialog.text, buttons: dialog.buttons) { return why }
        }
        for agent in NSWorkspace.shared.runningApplications where MacReplay.systemAgents.contains(agent.bundleIdentifier ?? "") {
            let pid = agent.processIdentifier
            let tree = await MacObserver.off { MacAXReader.snapshot(pid: pid, maxDepth: 6, maxNodes: 120, budget: 0.4).tree }
            guard !tree.windows.isEmpty else { continue }
            let text = tree.windows.map { MacScreen.windowText(tree, window: $0) }.joined(separator: "\n")
            let buttons = tree.nodes.filter { $0.role == "AXButton" }.map(\.label)
            return MacReplay.personOnly(text: text, buttons: buttons, owner: agent.bundleIdentifier ?? "") ?? "a macOS prompt"
        }
        return nil
    }

    /// Hands the Mac to the person for `why`, then waits until it's gone and the app has been quiet for
    /// 1.5 s (or they take it back). False when stopped, timed out, or nobody is at this Mac.
    private func handOff(_ why: String, label: String) async -> Bool {
        guard let env, let runID else { return false }
        if env.unattendedRuns.contains(runID) {
            env.replayLog(runID, "✗ \(label): needs a person (\(why)), and nobody is at this Mac")
            return false
        }
        while handingOff || gate != nil || personHasIt {
            if Task.isCancelled || self.runID != runID { return false }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        handingOff = true
        defer { handingOff = false }
        takeBackAsked = false
        let who = label.isEmpty ? "" : "\(label) · "
        env.store.updateRun(runID) { $0.status = .paused; $0.waitingFor = why }
        env.replayLog(runID, "→ \(who)your turn: \(why)")
        stepAside()
        env.presentHandoff(runID: runID, title: "your turn · \(why)",
                           text: "\(observer.appName) needs a person: \(why). Answer it yourself; okidoki notices when it's done and carries on, or press take back.",
                           takeBack: { [weak self] in self?.takeBack() }, stop: { [weak self] in self?.cancel(reason: "you stopped me") })
        let deadline = Date().addingTimeInterval(600)
        var quiet = MacReplay.QuietClock()
        var ending = "timedOut"
        while Date() < deadline {
            if Task.isCancelled || self.runID != runID { ending = "stopped"; break }
            if takeBackAsked { ending = "takenBack"; break }
            try? await Task.sleep(nanoseconds: 400_000_000)
            let check = await personCheck()
            let seen = await observer.observation(fresh: true)
            if quiet.note(clear: check == nil, signature: seen.window + "|" + seen.sheets.joined(separator: "|") + "|" + seen.text.prefix(400)) {
                ending = "cleared"
                break
            }
        }
        takeBackAsked = false
        guard ending != "stopped" else { return false }
        env.closeHandoffCard(runID: runID)
        guard ending != "timedOut" else {
            env.replayLog(runID, "✗ \(who)waited 10 minutes for you")
            return false
        }
        env.store.updateRun(runID) { if $0.status == .paused { $0.status = .running }; $0.waitingFor = nil }
        env.replayLog(runID, "→ \(who)thanks — taking it from here")
        observer.invalidate()
        typingTarget = nil
        stepBackIn()
        return true
    }

    // MARK: - One pass

    struct PassResult {
        var ok: Bool
        var note: String
        /// Recorded step index → the locator that finds it now (a renamed control the model found).
        var healed: [Int: AXLocator] = [:]
        /// Think step index → the plain steps that did it on this pass.
        var promotions: [Int: [SkillStep]] = [:]
        var skipped = false
        var stop = false
        var echoes: Set<Int> = []
        /// Something irreversible was done but never confirmed: never retried, never offered again.
        var unconfirmed = false
    }

    private func runPass(skill: Skill, steps: [SkillStep], item: SkillBinder.Bound, index: Int, of total: Int) async -> PassResult {
        guard let env, let runID else { return PassResult(ok: false, note: "stopped") }
        var values = item.values
        let inputs = Dictionary((skill.inputs ?? []).map { (ParameterFill.key($0.name), $0) }, uniquingKeysWith: { first, _ in first })
        var plan = HybridReplay.plan(steps, values: values)
        var doubts = HybridReplay.PassDoubts(values: item.doubts)
        var result = PassResult(ok: false, note: "")
        var captured: [String] = []
        var cursor = 0
        var jumps = 0
        var rescues = 0
        var fixes = 0
        var readingAnyway = false
        let prefix = total > 1 ? "\(item.label) · " : ""
        typingTarget = nil
        skillInHand = skill

        while cursor < plan.count {
            if Task.isCancelled || self.runID != runID { result.note = "stopped"; return result }
            if personHasIt {
                await holdWhilePaused()
                continue
            }
            // Something only the person can answer (a password prompt, a permission prompt): theirs.
            if let check = await personCheck() {
                guard await handOff(check, label: item.label) else { result.note = "needed you for \(check)"; return result }
                continue
            }
            let planned = plan[cursor]
            let step = planned.step
            let action = step.action ?? "click"
            status("\(prefix)\(cursor + 1)/\(plan.count) · \(ParameterFill.fill(step.text, values: planned.values).text)")

            // Is this the window? Sheets get cleared; a window that's further along (or back) gets re-synced.
            if let anchor = step.anchor, !anchor.isEmpty, action != "switch", !(readingAnyway && action == "read") {
                var seen = await observer.observation(fresh: true)
                if !HybridReplay.matches(anchor, seen.hybrid), await clearInterrupts(skill: skill, seen: seen) {
                    seen = await observer.observation(fresh: true)
                }
                // The window may still be on its way, or busy: a moment before deciding it's elsewhere.
                var waited = 0
                while !HybridReplay.matches(anchor, seen.hybrid), !Task.isCancelled, waited < 8 || (seen.busy && waited < 48) {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    seen = await observer.observation(fresh: true)
                    waited += 1
                }
                if !HybridReplay.matches(anchor, seen.hybrid), jumps < 6, let target = HybridReplay.resync(plan, current: cursor, seen: seen.hybrid) {
                    jumps += 1
                    env.replayLog(runID, "→ \(prefix)already on “\(seen.hybrid.title)”, picking up at “\(plan[target].step.text)”")
                    cursor = target
                    continue
                }
                if !HybridReplay.matches(anchor, seen.hybrid), jumps < 6, await passUnknownScreen(skill: skill, plan: plan, prefix: prefix) {
                    jumps += 1
                    continue
                }
            }

            // Before something irreversible on a screen that shows what was entered (a review sheet): if none
            // of this pass's details are there, something was lost on the way, and it isn't submitted unasked.
            if step.irreversible == true {
                for _ in 0..<40 where await observer.isBusy() {
                    if Task.isCancelled { break }
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
                let shownText = await observer.windowText() + "\n" + (await observer.fieldValues())
                let seen = HybridReplay.shownValues(values, inputs: skill.inputs ?? [], on: shownText)
                let key = "\(skill.id)#\(planned.source)"
                if seen.checked > 0, seen.shown > 0 {
                    result.echoes.insert(planned.source)
                    echoing.insert(key)
                } else if seen.checked > 0, step.echoes == true || echoing.contains(key) {
                    env.replayLog(runID, "✗ \(item.label): the screen before “\(step.text)” shows none of their details")
                    doubts.helped.append("the screen before “\(step.text)” shows none of \(item.label)'s details — they may have been lost on the way")
                }
            }

            if let reasons = HybridReplay.pauseReasons(before: step, skill: skill, doubts: doubts) {
                switch await askGate(item: item, step: step, reasons: reasons) {
                case .carryOn: break
                case .skip: result.skipped = true; result.note = "skipped at “\(step.text)”"; return result
                case .stop: result.stop = true; result.note = "stopped before “\(step.text)”"; return result
                }
            }

            var outcome = await perform(planned, skill: skill, inputs: inputs, values: values, item: item)
            if case .lost(let why) = outcome, step.irreversible != true, cursor + 1 < plan.count,
               plan[(cursor + 1)...].allSatisfy({ $0.step.action == "read" }), await personCheck() == nil {
                env.replayLog(runID, "→ \(prefix)\(why) — reading what the window says instead")
                readingAnyway = true
                outcome = .done
            }
            if case .lost = outcome, let check = await personCheck() {
                guard await handOff(check, label: item.label) else { result.note = "needed you for \(check)"; return result }
                continue
            } else if case .lost = outcome, step.irreversible == true, let expect = step.expect, !expect.isEmpty, (await check(expect)).isEmpty {
                // A rescue that pressed it, then gave up: it's done, and must not be done twice.
                outcome = .done
            } else if case .lost(let why) = outcome, step.irreversible == true {
                // The final step itself moved. Only now that it's due (and past the gate) may the model look
                // for it, and for nothing else.
                let (ok, summary, _) = await think(goal: "Do exactly this one final step now, in the window in front: \(step.text). "
                                                   + "The control may be labelled differently now (it does the same job). Then finish with success true.",
                                                   maxTurns: 3, tag: "final")
                outcome = ok ? .done : .failed(summary.isEmpty ? why : summary)
                if ok, let expect = step.expect, !expect.isEmpty {
                    // Pressed by the model: confirmed like any irreversible step, never pressed again.
                    outcome = await confirmIrreversible(step, expect: expect, textBefore: "", press: nil, label: item.label)
                }
            } else if case .lost(let lostWhy) = outcome, jumps < 6, let anchor = step.anchor, !anchor.isEmpty,
                      case let seen = await observer.observation(fresh: true), !HybridReplay.matches(anchor, seen.hybrid) || step.expect != nil,
                      let target = HybridReplay.resync(plan, current: cursor, seen: seen.hybrid), target != cursor {
                // It went to a window the skill knows, just not the one expected next (signed in again and sent
                // straight back to where it was): carry on from there, no model needed.
                jumps += 1
                env.replayLog(runID, "→ \(prefix)“\(step.text)”: \(lostWhy) — now on “\(seen.hybrid.title)”, picking up at “\(plan[target].step.text)”")
                cursor = target
                continue
            } else if case .lost = outcome, jumps < 6, await passUnknownScreen(skill: skill, plan: plan, prefix: prefix) {
                jumps += 1
                continue
            } else if case .lost(let why) = outcome {
                env.replayLog(runID, "→ \(prefix)\(why) — handing over to the model")
                let stopAt = plan[cursor...].firstIndex { $0.step.irreversible == true }
                let handed = await escalate(skill: skill, plan: plan, from: cursor, until: stopAt, values: values, item: item, reason: why)
                outcome = handed.outcome
                if handed.typed { doubts.helped.append("the model filled in fields after “\(step.text)”") }
                if case .done = outcome, let stopAt {
                    env.replayLog(runID, "→ \(prefix)back on the recording at “\(plan[stopAt].step.text)”")
                    cursor = stopAt
                    continue
                }
                if case .done = outcome {
                    for later in plan[cursor...] where later.step.capture != nil {
                        if let value = await read(later.step, inputs: inputs, values: later.values, label: item.label) { captured.append(value) }
                    }
                    cursor = plan.count
                    continue
                }
            }
            switch outcome {
            case .done:
                break
            case .healed(let locator):
                result.healed[planned.source] = locator
                rescues += 1
            case .captured(let name, let value):
                values[name] = value
                captured.append(value)
                plan = plan.enumerated().map { offset, later in
                    guard offset > cursor else { return later }
                    var copy = later
                    copy.values[name] = value
                    return copy
                }
            case .thought:
                rescues += 1
            case .learned:
                rescues += 1
            case .doubt(let why):
                doubts.helped.append(why)
            case .failed(let why), .lost(let why):
                result.note = "step “\(ParameterFill.fill(step.text, values: planned.values).text)”: \(why)"
                return result
            case .refused(let said):
                // Nothing went through. The model does only what the app asks (tick a box, fix a field);
                // the replay presses the step again, after the gate.
                if fixes < 2 {
                    fixes += 1
                    let shown = ParameterFill.fill(step.text, values: planned.values).text
                    env.replayLog(runID, "→ \(prefix)the app said “\(said)” — putting that right")
                    let goal = "In this window, the app turned down “\(shown)” and says: “\(said)”. Do only what it asks to put that right "
                        + "(tick a box, fill in or correct a field), using these values: \(spelled(skill: skill, values: values)). "
                        + "Never press “\(shown)” or submit anything yourself. Then finish with success true. If it asks for something "
                        + "these values don't cover, finish with success false and say what."
                    let (ok, summary, _) = await think(goal: goal, maxTurns: 5, tag: "fix")
                    if ok {
                        doubts.helped.append("the app asked “\(said)”")
                        continue
                    }
                    result.note = "the app turned down “\(shown)”: \(said)" + (summary.isEmpty ? "" : " — \(summary)")
                    return result
                }
                result.note = "the app turned down “\(ParameterFill.fill(step.text, values: planned.values).text)”: \(said)"
                return result
            case .unconfirmed(let why):
                result.unconfirmed = true
                result.note = "did “\(ParameterFill.fill(step.text, values: planned.values).text)” but the app didn't confirm it — \(why). "
                    + "It may have gone through: check before doing it again"
                return result
            }
            cursor += 1
        }
        result.ok = true
        result.note = captured.joined(separator: " · ")
        if rescues > 0, result.note.isEmpty { result.note = "done" }
        return result
    }

    /// Sheets the last pass left open in the skill's app are cancelled (never in another app, never one
    /// that would lose work or that only the person may answer).
    private func closeLeftovers(skill: Skill) async {
        for dialog in await observer.dialogs() {
            let text = dialog.title + "\n" + dialog.text
            guard MacReplay.personOnly(text: text, buttons: dialog.buttons) == nil,
                  !MacReplay.neverDismiss(text: text, buttons: dialog.buttons) else { continue }
            let label = HybridReplay.safeDismissal(in: dialog.buttons) ?? dialog.buttons.first { $0.lowercased() == "cancel" }
            if let label, await pressInDialogs(label) {
                if let runID { env?.replayLog(runID, "→ closed “\(dialog.title)” the last pass left open") }
            }
        }
    }

    // MARK: - One step

    private enum StepOutcome {
        case done
        case healed(AXLocator)
        case captured(String, String)
        case thought
        case learned([MacReplay.Touch])
        case doubt(String)
        case failed(String)
        case lost(String)
        case unconfirmed(String)
        case refused(String)
    }

    private func perform(_ planned: HybridReplay.Planned, skill: Skill, inputs: [String: SkillInput], values: [String: String],
                         item: SkillBinder.Bound) async -> StepOutcome {
        guard let env, let runID else { return .failed("okidoki quit") }
        let step = planned.step
        let action = step.action ?? "click"
        let scoped = planned.values
        switch action {
        case "switch", "open":
            observer.retarget(bundleID: step.axLocator?.bundleID, appName: step.app.isEmpty ? observer.appName : step.app)
            return await observer.launch(activate: !accessibilityOnly) ? .done : .failed("couldn't open \(step.app)")
        case "think":
            let goal = describeGoal(step.text, values: scoped, inputs: inputs)
            env.replayLog(runID, "→ \(item.label): working out “\(ParameterFill.fill(step.text, values: scoped).text)”")
            let result = await think(goal: goal, maxTurns: step.maxTurns ?? 14, tag: step.id)
            guard result.ok else { return .lost(result.summary.isEmpty ? "couldn't do “\(step.text)”" : result.summary) }
            return .learned(result.touched.map(\.touch))
        case "read":
            guard let name = step.capture else { return .done }
            if let value = await read(step, inputs: inputs, values: scoped, label: item.label) { return .captured(name, value) }
            return .doubt("couldn't read the \(name.replacingOccurrences(of: "_", with: " "))")
        case "key":
            let combo = step.input ?? "return"
            await waitWhileBusy()
            if !accessibilityOnly, !(await frontIsStepApp(step)) { return .failed("couldn't bring \(observer.appName) to the front, so no key was pressed") }
            guard await key(combo) else { return .lost("couldn't press \(WatchRecorder.prettyCombo(combo))") }
            observer.invalidate()
            return await checkAfter(step, label: item.label, textBefore: "", press: { [weak self] in _ = await self?.key(combo) })
        case "type":
            return await type(step, scoped: scoped, inputs: inputs, item: item, skill: skill)
        case "scroll":
            // Accessibility finds controls wherever they are scrolled to; the pointer scrolls as recorded.
            if accessibilityOnly { return .done }
            guard let point = (await target(step, scoped: scoped, patient: false))?.node.frame.map({ CGPoint(x: $0.midX, y: $0.midY) }) ?? step.x.map({ CGPoint(x: $0, y: step.y ?? 0) }) else { return .done }
            moveGhost(to: point)
            if Task.isCancelled { return .failed("stopped") }
            let dy = step.toY ?? 0
            _ = await MacObserver.off { AccessibilityActions.scroll(at: point, dy: dy) }
            return .done
        default:
            break
        }

        // click · double-click · right-click · select: the recorded control, checked.
        guard var found = await target(step, scoped: scoped, patient: true, skill: skill) else {
            // None of the saved ways find it. The model picks the control that does this step's job in
            // today's window (a renamed button counts), for this one step; what it picked becomes the fix.
            guard let (locator, element) = await rescueByPurpose(step, values: scoped, row: planned.iteration.map { $0 + 1 }) else {
                return .lost("\(describe(step, scoped)) isn't in \(observer.appName)")
            }
            if step.irreversible == true {
                // The model only pointed at it; the replay presses it, under the same rules as always.
                return await press(element, step: step, healed: locator, label: item.label)
            }
            observer.invalidate()
            if action == "select" { return await select(step, element: element, scoped: scoped, inputs: inputs, item: item, healed: locator) }
            return await afterClick(step, label: item.label, healed: locator, element: element)
        }
        if action == "select" { return await select(step, element: found.element, scoped: scoped, inputs: inputs, item: item, healed: nil) }
        if step.irreversible == true {
            // Something that can't be undone is pressed once, so only once it's really the control it was:
            // a button the app hasn't finished setting up yet (disabled, renamed for now) would swallow it.
            let want = ParameterFill.fill(step.axLocator?.label ?? step.label ?? "", values: scoped).text
            for _ in 0..<25 {
                if Task.isCancelled { break }
                if found.node.enabled, want.isEmpty || MacLocator.sameLabel(found.node.label, want) { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
                if let again = await target(step, scoped: scoped, patient: false, fresh: true) { found = again }
            }
            await observer.settle(limit: 1)
            return await press(found.element, step: step, healed: nil, label: item.label)
        }
        await clearBefore(step, scoped: scoped, skill: skill)
        guard await click(found.element, node: found.node, step: step) else { return .lost("couldn't click \(describe(step, scoped))") }
        return await checkAfter(step, label: item.label, textBefore: "", press: { [weak self] in
            guard let self, let again = await self.target(step, scoped: scoped, patient: false, fresh: true) else { return }
            _ = await self.click(again.element, node: again.node, step: step)
        })
    }

    /// The step's control: its locator (filled for this pass), looked for again while the app catches up.
    /// After a few looks, popups get cleared; an app that says it's busy gets up to 8 s more.
    private func target(_ step: SkillStep, scoped: [String: String], patient: Bool, fresh: Bool = false, skill: Skill? = nil)
        async -> (element: AXUIElement, node: MacNode, hit: MacLocator.Hit)? {
        guard let locator = MacLocator.implied(by: step)?.filled(scoped) else { return nil }
        if let hit = await observer.find(locator, fresh: fresh || patient) { return hit }
        guard patient else { return nil }
        // On the right window, settled, a missing control is really missing (renamed): a short look is enough.
        var patience = 16
        let seen = await observer.observation(fresh: true)
        if let anchor = step.anchor, HybridReplay.matches(anchor, seen.hybrid), !seen.busy { patience = 8 }
        var cleared = false
        for look in 0..<(patience + 40) {
            if Task.isCancelled { return nil }
            if look >= patience {
                guard await observer.isBusy() else { break }
            }
            if look == 3, !cleared, let skill, await clearInterrupts(skill: skill, seen: await observer.observation(fresh: true), allowModel: true) {
                cleared = true
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if let hit = await observer.find(locator, fresh: true) { return hit }
        }
        return nil
    }

    private func describe(_ step: SkillStep, _ scoped: [String: String]) -> String {
        let label = ParameterFill.fill(step.axLocator?.label ?? step.label ?? "", values: scoped).text
        return label.isEmpty ? "the \(step.role?.replacingOccurrences(of: "AX", with: "").lowercased() ?? "control")" : "“\(label)”"
    }

    private func type(_ step: SkillStep, scoped: [String: String], inputs: [String: SkillInput], item: SkillBinder.Bound, skill: Skill) async -> StepOutcome {
        guard let env, let runID else { return .failed("stopped") }
        guard let raw = step.input, !raw.isEmpty else { return .done }
        var text: String
        var secret = false
        if let ref = BrowserSteps.vaultReference(in: raw) {
            guard let value = env.vaultSecret(site: ref.site, field: ref.field) else { return .failed("this field needs a password only you have") }
            text = value
            secret = true
        } else {
            let filled = ParameterFill.fill(raw, values: scoped)
            guard filled.missing.isEmpty else { return .failed("no value for \(filled.missing.joined(separator: ", "))") }
            text = render(raw, values: scoped, inputs: inputs)
        }
        guard !text.isEmpty else { return .done }
        await waitWhileBusy()
        // The field the last step clicked, or whatever has the focus in the app.
        let field = await typingField()
        await clearBefore(step, scoped: scoped, skill: skill)
        guard await enter(text, into: field?.element, current: field?.node.value ?? "", whole: MacReplay.isWholeValue(raw), step: step) else {
            return .lost(accessibilityOnly ? "there's no field to type into" : "couldn't type into \(observer.appName)")
        }
        // Did the field take it? Masks reformat ("1250000" → "12,50,000"), so this compares what matters.
        guard !secret, let field else { return .done }
        try? await Task.sleep(nanoseconds: 120_000_000)
        observer.invalidate()
        guard let now = await readValue(field.element), !(field.node.isSecure) else { return .done }
        if HybridReplay.sameValue(typed: text, field: now) { return .done }
        // A popup that swallowed the typing goes first, then once more.
        _ = await clearInterrupts(skill: skill, seen: await observer.observation(fresh: true), allowModel: true)
        let again = await typingField(prefer: field.element)
        _ = await enter(text, into: again?.element ?? field.element, current: again?.node.value ?? now, whole: true, step: step)
        try? await Task.sleep(nanoseconds: 120_000_000)
        if let after = await readValue(again?.element ?? field.element), HybridReplay.sameValue(typed: text, field: after) { return .done }
        let shown = await readValue(again?.element ?? field.element) ?? ""
        let doubt = "“\(step.label ?? "a field")” shows “\(shown)”, not “\(text)”"
        env.replayLog(runID, "✗ \(item.label): \(doubt)")
        return .doubt(doubt)
    }

    private func select(_ step: SkillStep, element: AXUIElement, scoped: [String: String], inputs: [String: SkillInput],
                        item: SkillBinder.Bound, healed: AXLocator?) async -> StepOutcome {
        guard let env, let runID else { return .failed("stopped") }
        let wanted = render(step.input ?? "", values: scoped, inputs: inputs)
        guard !wanted.isEmpty else { return .done }
        let locator = (healed ?? MacLocator.implied(by: step))?.filled(scoped)
        let options = locator == nil ? nil : await observer.options(of: locator!)
        if !accessibilityOnly, let frame = await MacObserver.off({ MacAXReader.frame(of: element) }) { moveGhost(to: CGPoint(x: frame.midX, y: frame.midY)) }
        if Task.isCancelled { return .failed("stopped") }
        guard let picked = await observer.choose(wanted, in: element, options: options, mayOpenMenu: !accessibilityOnly) else {
            return .lost("“\(wanted)” isn't one of \(describe(step, scoped))'s choices")
        }
        try? await Task.sleep(nanoseconds: 120_000_000)
        if let now = await readValue(element), !HybridReplay.sameValue(typed: picked, field: now) {
            let doubt = "\(describe(step, scoped)) shows “\(now)”, not “\(picked)”"
            env.replayLog(runID, "✗ \(item.label): \(doubt)")
            return .doubt(doubt)
        }
        if let healed { return .healed(healed) }
        return .done
    }

    /// A click a model rescue found: done like any click, then checked; the locator becomes the fix.
    private func afterClick(_ step: SkillStep, label: String, healed: AXLocator, element: AXUIElement) async -> StepOutcome {
        let outcome = await checkAfter(step, label: label, textBefore: "", press: nil)
        if case .done = outcome { return .healed(healed) }
        return outcome
    }

    /// An irreversible step's control, pressed once and confirmed by its expectation.
    private func press(_ element: AXUIElement, step: SkillStep, healed: AXLocator?, label: String) async -> StepOutcome {
        let textBefore = await observer.windowText()
        let node = await MacObserver.off { MacAXReader.read(element) }
        guard await click(element, node: node, step: step) else { return .lost("couldn't press “\(step.label ?? step.text)”") }
        guard let expect = step.expect, !expect.isEmpty else { return healed.map { .healed($0) } ?? .done }
        let outcome = await confirmIrreversible(step, expect: expect, textBefore: textBefore, press: { [weak self] in
            _ = await self?.click(element, node: node, step: step)
        }, label: label)
        if case .done = outcome, let healed { return .healed(healed) }
        return outcome
    }

    /// Something irreversible was pressed: wait for it to show (25 s), press again only when the app says
    /// so for a passing reason ("busy, try again"), stop on a refusal ("please confirm…"); otherwise it's
    /// unconfirmed and never pressed again. A slow submit looks exactly like a dead one.
    private func confirmIrreversible(_ step: SkillStep, expect: StepExpectation, textBefore: String,
                                     press: (() async -> Void)?, label: String) async -> StepOutcome {
        var unmet = await check(expect)
        var retries = 0
        let deadline = Date().addingTimeInterval(25)
        while !unmet.isEmpty, Date() < deadline, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 300_000_000)
            unmet = await check(expect)
            guard !unmet.isEmpty else { break }
            let now = await observer.windowText()
            if !textBefore.isEmpty, let said = HybridReplay.refusal(before: textBefore, after: now) { return .refused(said) }
            if retries < 2, let press, let said = HybridReplay.transientError(in: now), !(textBefore.contains(said)) || retries > 0 {
                retries += 1
                if let runID { env?.replayLog(runID, "→ \(label): the app said “\(said)” — trying again") }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if !(await check(expect)).isEmpty, !Task.isCancelled {
                    await press()
                    observer.invalidate()
                }
            }
        }
        if Task.isCancelled { return .failed("stopped") }
        if !unmet.isEmpty {
            let page = await observer.windowText()
            let said = page.split(separator: "\n").first { line in
                let l = line.lowercased()
                return ["error", "failed", "couldn't", "could not", "try again", "wrong", "invalid", "sure"].contains { l.contains($0) }
            }
            return .unconfirmed(unmet.joined(separator: ", ") + (said.map { " (the app says “\($0)”)" } ?? ""))
        }
        return .done
    }

    /// After a step that isn't irreversible: did it lead where it should? A slow app gets 4 s (+8 s while
    /// busy); a popup in the way is cleared and the step done once more; then it's lost.
    private func checkAfter(_ step: SkillStep, label: String, textBefore: String, press: (() async -> Void)?) async -> StepOutcome {
        observer.invalidate()
        guard let expect = step.expect, !expect.isEmpty else { return .done }
        var unmet = await check(expect)
        let deadline = Date().addingTimeInterval(4)
        while !unmet.isEmpty, !Task.isCancelled {
            if await personCheck() != nil { break }
            if Date() >= deadline {
                guard await observer.isBusy(), Date() < deadline.addingTimeInterval(8) else { break }
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
            unmet = await check(expect)
        }
        if !unmet.isEmpty, let skill = currentSkill(), await clearInterrupts(skill: skill, seen: await observer.observation(fresh: true), allowModel: true) {
            if let press { await press() }
            observer.invalidate()
            try? await Task.sleep(nanoseconds: 300_000_000)
            for _ in 0..<10 where !(await check(expect)).isEmpty { try? await Task.sleep(nanoseconds: 200_000_000) }
            unmet = await check(expect)
        }
        if !unmet.isEmpty {
            let text = await observer.windowText()
            let hint = text.split(separator: "\n").first { l in ["should", "required", "invalid", "fill", "wrong", "expired"].contains { l.lowercased().contains($0) } }
            return .lost(unmet.joined(separator: ", ") + (hint.map { " (the app says “\($0)”)" } ?? ""))
        }
        return .done
    }

    private func check(_ expect: StepExpectation) async -> [String] {
        let seen = await observer.observation(fresh: true)
        var present: [String: Bool] = [:]
        if let label = expect.labelPresent, !label.isEmpty { present[label] = await observer.present(label) }
        return HybridReplay.unmet(expect, seen.hybrid, present: { present[$0] ?? false }, focusedRole: seen.focusedRole.isEmpty ? nil : seen.focusedRole,
                                  sheets: seen.sheets, fileExists: { path in
            FileManager.default.fileExists(atPath: (path as NSString).expandingTildeInPath)
        })
    }

    private var skillInHand: Skill?
    private func currentSkill() -> Skill? { skillInHand }

    private func waitWhileBusy() async {
        for _ in 0..<40 where await observer.isBusy() {
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    private func render(_ raw: String, values: [String: String], inputs: [String: SkillInput]) -> String {
        let names = ParameterFill.names(in: raw)
        if names.count == 1, raw.trimmingCharacters(in: .whitespaces) == "{{\(names[0])}}", let input = inputs[ParameterFill.key(names[0])] {
            let value = ParameterFill.fill(raw, values: values).text
            if input.kind == "choice" { return SkillBinder.choice(value, in: input.choices) }
            return HybridReplay.render(value, as: input)
        }
        return ParameterFill.fill(raw, values: values).text
    }

    // MARK: - Acting: the pointer, or Accessibility alone

    /// Clicks a control. Accessibility alone presses buttons and boxes, and puts the cursor in fields.
    private func click(_ element: AXUIElement, node: MacNode, step: SkillStep) async -> Bool {
        defer { observer.invalidate() }
        if Task.isCancelled { return false }
        let fieldRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
        if accessibilityOnly {
            if fieldRoles.contains(node.role) {
                typingTarget = element
                _ = await observer.focus(element)
                return true
            }
            typingTarget = nil
            return await observer.press(element)
        }
        guard let frame = await MacObserver.off({ MacAXReader.frame(of: element) }) else {
            return await observer.press(element)
        }
        _ = await frontIsStepApp(step)
        let point = CGPoint(x: frame.midX, y: frame.midY)
        moveGhost(to: point)
        try? await Task.sleep(nanoseconds: 120_000_000)
        // No event is ever posted after a stop.
        if Task.isCancelled { return false }
        model.clicking = true
        let (button, count) = SkillReplayGeometry.clickShape(step.action)
        let ok = await MacObserver.off { AccessibilityActions.click(at: point, button: button, count: count) }
        try? await Task.sleep(nanoseconds: 200_000_000)
        model.clicking = false
        typingTarget = fieldRoles.contains(node.role) ? element : nil
        return ok
    }

    /// The field a type step types into: the one the last click put the cursor in, else the focused one.
    private func typingField(prefer: AXUIElement? = nil) async -> (element: AXUIElement, node: MacNode)? {
        if let element = prefer ?? typingTarget {
            let node = await MacObserver.off { MacAXReader.read(element) }
            if !node.role.isEmpty { return (element, node) }
        }
        guard let snapshot = await observer.snapshot(fresh: true), let index = snapshot.tree.nodes.lastIndex(where: { $0.focused }) else { return nil }
        return (snapshot.elements[index], snapshot.tree.nodes[index])
    }

    /// Types `text`. Accessibility alone sets the field's value (replacing it for a whole value); the
    /// pointer path types real keys into the step's app, and only when that app is in front.
    private func enter(_ text: String, into element: AXUIElement?, current: String, whole: Bool, step: SkillStep) async -> Bool {
        defer { observer.invalidate() }
        if Task.isCancelled { return false }
        if accessibilityOnly {
            guard let element else { return false }
            return await observer.setValue(element, MacReplay.typedValue(current: current, typed: text, wholeValue: whole))
        }
        guard await frontIsStepApp(step) else { return false }
        guard EventActuator.canPost else { return false }
        // A whole value goes into an emptied field: a second pass over the same form must not double it.
        if whole, !current.isEmpty {
            if Task.isCancelled { return false }
            _ = await EventActuator.pressKey("cmd+a")
        }
        if Task.isCancelled { return false }
        await EventActuator.typeText(text)
        return !Task.isCancelled
    }

    private func key(_ combo: String) async -> Bool {
        defer { observer.invalidate() }
        if Task.isCancelled { return false }
        if accessibilityOnly {
            switch MacReplay.meaning(ofKey: combo) {
            case .defaultButton: return await observer.pressWindowButton("default")
            case .cancelButton: return await observer.pressWindowButton("cancel")
            case .nextField:
                guard let snapshot = await observer.snapshot(fresh: true), let front = snapshot.tree.front else { return false }
                let fields = snapshot.tree.subtree(front).filter { ["AXTextField", "AXTextArea", "AXComboBox"].contains(snapshot.tree.nodes[$0].role) }
                guard !fields.isEmpty else { return false }
                let at = fields.firstIndex { snapshot.tree.nodes[$0].focused } ?? -1
                let next = fields[(at + 1) % fields.count]
                typingTarget = snapshot.elements[next]
                return await observer.focus(snapshot.elements[next])
            case .unsupported:
                return false
            }
        }
        var ok = await EventActuator.pressKey(combo)
        if !ok, EventActuator.canPost, !Task.isCancelled { ok = await MacObserver.off { AccessibilityActions.press(combo) } }
        return ok
    }

    private func readValue(_ element: AXUIElement) async -> String? {
        let node = await MacObserver.off { MacAXReader.read(element) }
        return node.role.isEmpty || node.isSecure ? nil : node.value
    }

    /// Keys go to whatever is in front: typing is only ever done into the step's own app.
    private func frontIsStepApp(_ step: SkillStep) async -> Bool {
        let front = NSWorkspace.shared.frontmostApplication
        if let bundle = observer.bundleID, front?.bundleIdentifier == bundle { return true }
        if SkillReplayGeometry.sameApp(front?.localizedName ?? "", step.app.isEmpty ? observer.appName : step.app) { return true }
        _ = await observer.launch(activate: true)
        try? await Task.sleep(nanoseconds: 250_000_000)
        let now = NSWorkspace.shared.frontmostApplication
        return now?.bundleIdentifier == observer.bundleID || SkillReplayGeometry.sameApp(now?.localizedName ?? "", observer.appName)
    }

    // MARK: - Popups and screens nobody recorded

    private var learnedInterrupts: [InterruptHandler] = []
    private var echoing: Set<String> = []

    /// Gets a sheet or dialog out of the way. True when something was pressed. In order: the skill's own
    /// and the built-in rules (inside the dialog only); a button that only closes it ("Not Now"; with
    /// `generic`, also "Close"); and, with `allowModel`, one look by the model at a modal, whose choice
    /// becomes a rule. Never a dialog that would lose work, and never one only the person may answer.
    private func clearInterrupts(skill: Skill, seen: MacObservation, generic: Bool = true, allowModel: Bool = false) async -> Bool {
        skillInHand = skill
        let boxes = seen.dialogs.filter { box in
            let text = box.title + "\n" + box.text
            return MacReplay.personOnly(text: text, buttons: box.buttons) == nil && !MacReplay.neverDismiss(text: text, buttons: box.buttons)
        }
        guard !boxes.isEmpty else { return false }
        let dialogText = boxes.map { $0.title + "\n" + $0.text }.joined(separator: "\n")
        var shown = seen.hybrid
        shown.text = dialogText
        for handler in HybridReplay.interrupts(showing: shown, skill: (skill.interrupts ?? []) + learnedInterrupts, dialogText: dialogText) {
            var hit = false
            if let label = handler.clickLabel, !MacReplay.isRisky(label) { hit = await pressInDialogs(label) }
            if !hit, let key = handler.key { hit = await self.key(key) }
            if hit {
                if let runID { env?.replayLog(runID, "→ closed a popup (\(handler.clickLabel ?? handler.key ?? "it"))") }
                await observer.settle(limit: 1.5)
                return true
            }
        }
        for box in boxes {
            if let label = HybridReplay.safeDismissal(in: box.buttons, generic: generic), await pressInDialogs(label) {
                if let runID { env?.replayLog(runID, "→ closed a popup (\(label))") }
                await observer.settle(limit: 1.5)
                return true
            }
        }
        guard allowModel, let modal = boxes.first(where: \.modal), let env, env.hasKey("anthropic") else { return false }
        let goal = "A sheet is covering the window in the middle of a task. Close it the way a careful person would to get back to "
            + "what they were doing: stay signed in, decline tours, offers and surveys, carry on to the app. Never sign out, buy, pay, "
            + "submit, delete or confirm anything. The sheet says: “\((modal.title + " " + modal.text).prefix(300))”, with buttons "
            + modal.buttons.map { "“\($0)”" }.joined(separator: ", ") + ". Press only the one button that does that, then finish with success true."
        let result = await think(goal: goal, maxTurns: 2, tag: "popup")
        guard result.ok, let clicked = result.touched.last(where: { $0.touch.action == "click" })?.touch.label, !clicked.isEmpty else { return false }
        if let runID { env.replayLog(runID, "→ closed a popup (\(clicked)) — remembered for next time") }
        if let key = HybridReplay.dialogKey(modal.title + " " + modal.text), !MacReplay.isRisky(clicked),
           !learnedInterrupts.contains(where: { $0.whenText == key }) {
            learnedInterrupts.append(InterruptHandler(whenText: key, clickLabel: clicked, source: "learned"))
        }
        await observer.settle(limit: 1.5)
        return true
    }

    /// Presses the button called `label` inside a sheet or dialog, never one in the window behind.
    private func pressInDialogs(_ label: String) async -> Bool {
        guard !label.isEmpty, let snapshot = await observer.snapshot(fresh: true) else { return false }
        for dialog in MacScreen.dialogs(snapshot.tree) {
            let inside = snapshot.tree.subtree(dialog.node)
            if let button = inside.first(where: { snapshot.tree.nodes[$0].role == "AXButton" && MacLocator.sameLabel(snapshot.tree.nodes[$0].label, label) }) {
                let element = snapshot.elements[button]
                return await click(element, node: snapshot.tree.nodes[button], step: SkillStep(text: label, app: observer.appName, action: "click"))
            }
        }
        return false
    }

    /// On a screen no step is on (an inserted "Verify your email"): the rule learned for it, or a button
    /// that only moves past it ("Skip for now"). True when one was pressed.
    private func passUnknownScreen(skill: Skill, plan: [HybridReplay.Planned], prefix: String) async -> Bool {
        let seen = await observer.observation(fresh: true)
        guard MacReplay.unknownScreen(plan, seen: seen.hybrid) else { return false }
        let key = MacReplay.screenKey(window: seen.window, sheets: seen.sheets)
        let rules = ((skill.interrupts ?? []) + learnedInterrupts).filter { $0.source == "learned-page" && $0.whenText == key }.compactMap(\.clickLabel)
        guard let snapshot = await observer.snapshot(fresh: true), let front = snapshot.tree.front else { return false }
        for label in rules + HybridReplay.pageSkips {
            guard let button = snapshot.tree.subtree(front).first(where: {
                snapshot.tree.nodes[$0].role == "AXButton" && MacLocator.sameLabel(snapshot.tree.nodes[$0].label, label)
            }) else { continue }
            if await click(snapshot.elements[button], node: snapshot.tree.nodes[button], step: SkillStep(text: label, app: observer.appName, action: "click")) {
                if let runID { env?.replayLog(runID, "→ \(prefix)on a screen the skill doesn't know (“\(seen.window)”), pressed “\(snapshot.tree.nodes[button].label)”") }
                await observer.settle(limit: 3)
                return true
            }
        }
        return false
    }

    /// Before acting: a sheet in front swallows clicks, so it goes first. Not when the step's own control is
    /// in it (the step is answering that sheet).
    private func clearBefore(_ step: SkillStep, scoped: [String: String], skill: Skill) async {
        let seen = await observer.observation(fresh: true)
        guard !seen.dialogs.isEmpty else { return }
        if let locator = MacLocator.implied(by: step)?.filled(scoped), await observer.inDialog(locator) { return }
        _ = await clearInterrupts(skill: skill, seen: seen, generic: false, allowModel: seen.dialogs.contains(where: \.modal))
    }

    // MARK: - Reading

    private func read(_ step: SkillStep, inputs: [String: SkillInput], values: [String: String], label: String) async -> String? {
        guard let name = step.capture else { return nil }
        let input = inputs[ParameterFill.key(name)]
        if !HybridReplay.needsReading(input) {
            for _ in 0..<15 {
                if let value = HybridReplay.capture(in: await observer.windowText(), example: input?.example, pattern: input?.pattern) { return value }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
        guard let env, let runID, env.hasKey("anthropic") else { return nil }
        await waitWhileBusy()
        let text = await observer.windowText()
        guard !text.isEmpty else { return nil }
        let what = ParameterFill.fill(input?.description.isEmpty == false ? input!.description : step.text, values: values).text
        let payload: [String: Any] = [
            "item": label.isEmpty ? name : label,
            "inputs": [["name": name, "description": what, "kind": "text", "required": true,
                        "hint": "Answer it the way a person would tell someone: the value with its unit and context, exactly as the window says."]],
            "documents": [["name": "the window (\(observer.appName))", "text": String(text.prefix(18_000))]],
            "request": "Read from this window: \(what)",
        ]
        env.store.countModelCall(runID)
        guard let reply = await BrainClient.shared.smartReplay("skill/resolve", body: payload),
              let found = (reply["values"] as? [String: [String: Any]])?[name], let value = found["value"] as? String,
              !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    // MARK: - The gate

    private func askGate(item: SkillBinder.Bound, step: SkillStep, reasons: [String]) async -> HybridBrowserReplayer.GateAnswer {
        guard let env, let runID else { return .stop }
        // The person is often away from a Mac run: unattended, a doubt means stop before the step and say why.
        if env.unattendedRuns.contains(runID) {
            env.replayLog(runID, "✗ \(item.label): stopped before “\(step.text)” to check with you · \(reasons.joined(separator: "; "))")
            return .skip
        }
        while gate != nil || handingOff {
            if Task.isCancelled || self.runID != runID { return .stop }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        if Task.isCancelled || self.runID != runID { return .stop }
        env.replayLog(runID, "→ \(item.label): paused before “\(step.text)” · \(reasons.joined(separator: "; "))")
        status("\(item.label) · waiting for your okay")
        let sensitive = Set((skillInHand?.inputs ?? []).filter(\.isSensitive).map(\.name))
        let shown = item.values.filter { key, _ in !key.hasPrefix("today") && key != "ref" && key != "id" }
            .sorted { (item.doubts[$0.key] != nil ? 0 : 1, $0.key) < (item.doubts[$1.key] != nil ? 0 : 1, $1.key) }
            .prefix(12)
            .map { key, value in
                "· \(key): \(sensitive.contains(key) ? "••••" : value)" + (item.sources[key].map { " — \($0)" } ?? "") + (item.doubts[key].map { " ⚠︎ \($0)" } ?? "")
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
        for (key, input) in inputs where input.kind == "list" {
            let entries = HybridReplay.listValue(values[input.name] ?? values[key] ?? "")
            let spelled = entries.isEmpty ? "none" : entries.enumerated().map { n, e in
                "\(n + 1)) " + e.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
            }.joined(separator: "; ")
            goal = goal.replacingOccurrences(of: values[input.name] ?? "\u{0}", with: spelled)
        }
        return "Do only this part of a task, in the window in front, then finish with success true (or false if it truly can't be done): \(goal). "
            + "Don't submit, send, pay or delete anything unless this part says to."
    }

    /// One step by the model, told what the step is for: what it was called, the window it was in, and
    /// where it should lead. The control it picked, and its locator for next time.
    private func rescueByPurpose(_ step: SkillStep, values: [String: String], row: Int?) async -> (AXLocator, AXUIElement)? {
        guard let env, env.hasKey("anthropic") else { return nil }
        let action = step.action ?? "click"
        let label = ParameterFill.fill(step.axLocator?.label ?? step.label ?? "", values: values).text
        var goal = "One step of a recorded task, in the window in front: \(action == "select" ? "find the pop-up" : "click the control") that does what "
            + (label.isEmpty ? "the recorded \(step.role?.replacingOccurrences(of: "AX", with: "").lowercased() ?? "control")" : "“\(label)”")
            + " did when it was recorded"
        if let role = step.role { goal += " (a \(role.replacingOccurrences(of: "AX", with: "")))" }
        goal += "."
        if let next = step.expect?.windowTitleContains { goal += " It should lead to the “\(next)” screen." }
        if let window = step.anchor?.window { goal += " It's in the window “\(window)”." }
        if let row { goal += " This is entry \(row) of a list: use the control that belongs to entry \(row), not another row's." }
        goal += action == "select"
            ? " Only click it to say which one it is; finish with success true right after."
            : " Its label may have changed; pick the control with the same purpose. Close a sheet first if one is in the way."
        goal += " Do only this one step, then finish with success true; if nothing here does it, finish with success false."
        if step.irreversible == true || action == "select" {
            // Pointing only: the replay itself presses it (under the gate) or chooses the option.
            goal += " Don't press it: answer with click on its number and finish in the same turn."
        }
        let pointOnly = step.irreversible == true || action == "select"
        let result = await think(goal: goal, maxTurns: 3, tag: "fix-\(step.id)", pointOnly: pointOnly)
        guard result.ok, let last = result.touched.last(where: { $0.touch.action == "click" || $0.touch.action == "select" }),
              let locator = last.touch.locator, let element = last.element else { return nil }
        if let runID { env.replayLog(runID, "→ found \(label.isEmpty ? action : "“\(label)”") as “\(last.touch.label ?? "a control")”") }
        // A loop row's control can't be pinned to this row's: the fix is kept for this pass only.
        if let original = step.axLocator, original.isTemplated { return (original, element) }
        return (locator, element)
    }

    /// A control the model acted on, and the live element behind it.
    struct Touched { var touch: MacReplay.Touch; var element: AXUIElement? }

    /// A bounded run of the model on the app, through its controls: the part of a pass no recording covers.
    /// `pointOnly`: a click is recorded but not done (the replay does it). On the pointer path, an app that
    /// lists no controls is worked from the screen instead.
    private func think(goal: String, maxTurns: Int, tag: String, pointOnly: Bool = false) async -> (ok: Bool, summary: String, touched: [Touched]) {
        var touched: [Touched] = []
        guard let env, let runID else { return (false, "stopped", touched) }
        var results: [[String: Any]] = []
        var turn = 0
        while turn < maxTurns {
            if Task.isCancelled { return (false, "stopped", touched) }
            if personHasIt { await holdWhilePaused(); continue }
            await observer.settle(limit: 2)
            guard let snapshot = await observer.snapshot(fresh: true) else { return (false, "\(observer.appName) isn't running", touched) }
            let controls = MacScreen.controls(snapshot.tree)
            if controls.isEmpty {
                guard !accessibilityOnly else { return (false, "\(observer.appName) lists no controls", touched) }
                let failed = await thinkByScreen(goal: goal, turns: maxTurns - turn)
                return (failed == nil, failed ?? "", touched)
            }
            let seen = MacScreen.observe(snapshot.tree)
            let body: [String: Any] = [
                "goal": goal, "step": turn, "app": snapshot.tree.app, "window": seen.window, "sheets": seen.sheets,
                "text": String(seen.text.prefix(3000)), "controls": controls.map { ["id": $0.id, "line": $0.line] },
                "results": results,
            ]
            let epoch = pauseEpoch
            env.store.countModelCall(runID)
            let reply = await BrainClient.shared.smartReplay("mac/step", body: body, timeout: 70)
            // A turn that was in flight when the person paused is thrown away, never acted on.
            if epoch != pauseEpoch || personHasIt { continue }
            turn += 1
            guard let reply, reply["ok"] as? Bool == true, let actions = reply["actions"] as? [[String: Any]], !actions.isEmpty else {
                return (false, (reply?["error"] as? String) ?? "the model didn't answer", touched)
            }
            results = []
            var halted = false
            for act in actions {
                let type = act["type"] as? String ?? ""
                if halted { results.append(["ok": false, "detail": "not done: the window changed; look again"]); continue }
                if Task.isCancelled || personHasIt { break }
                switch type {
                case "finish":
                    return (act["success"] as? Bool ?? false, act["summary"] as? String ?? "", touched)
                case "ask":
                    if let check = await personCheck(), await handOff(check, label: "") {
                        results.append(["ok": true, "detail": "the person got past \(check); look again"])
                        halted = true
                        continue
                    }
                    return (false, act["text"] as? String ?? "it needed to ask something", touched)
                case "wait":
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    results.append(["ok": true])
                case "key":
                    let combo = act["key"] as? String ?? ""
                    let ok = await key(combo)
                    results.append(ok ? ["ok": true] : ["ok": false, "detail": "that key can't be pressed here"])
                    if ok { touched.append(.init(touch: MacReplay.Touch(action: "key", locator: nil, input: combo, window: seen.window), element: nil)) }
                    env.replayLog(runID, ok ? "→ pressed \(WatchRecorder.prettyCombo(combo))" : "✗ couldn't press \(combo)")
                    halted = ok
                case "click", "type", "select":
                    guard let id = act["id"] as? Int, let control = controls.first(where: { $0.id == id }) else {
                        results.append(["ok": false, "detail": "no control has that number"])
                        continue
                    }
                    let element = snapshot.elements[control.node]
                    let node = snapshot.tree.nodes[control.node]
                    // Its locator, taken before acting: the screen may change once it's pressed.
                    let locator = MacLocator.make(control.node, in: snapshot.tree)
                    let text = act["text"] as? String
                    var ok = false
                    if type == "click" {
                        ok = pointOnly ? true : await click(element, node: node, step: SkillStep(text: node.label, app: observer.appName, action: "click"))
                    } else if type == "type", let text {
                        ok = await enter(text, into: element, current: node.value, whole: true, step: SkillStep(text: node.label, app: observer.appName, action: "type"))
                        if !accessibilityOnly, ok == false, await click(element, node: node, step: SkillStep(text: node.label, app: observer.appName, action: "click")) {
                            ok = await enter(text, into: element, current: node.value, whole: true, step: SkillStep(text: node.label, app: observer.appName, action: "type"))
                        }
                    } else if type == "select", let text {
                        ok = pointOnly ? true : (await observer.choose(text, in: element, options: nil, mayOpenMenu: !accessibilityOnly)) != nil
                    }
                    results.append(ok ? ["ok": true] : ["ok": false, "detail": "didn't work"])
                    if ok {
                        touched.append(.init(touch: MacReplay.Touch(action: type, locator: locator, label: node.label, role: node.role,
                                                                    input: type == "click" ? nil : text, window: seen.window), element: element))
                    }
                    env.replayLog(runID, ok ? "→ \(type) “\(node.label.isEmpty ? node.role : node.label)”" + (type == "type" && !node.isSecure ? " ← “\(text ?? "")”" : "")
                                         : "✗ \(type) “\(node.label)” didn't work")
                    if type != "type" || !ok { halted = true }
                    if pointOnly, type == "click" { return (true, "", touched) }
                default:
                    results.append(["ok": false, "detail": "not available here"])
                }
            }
        }
        return (false, "took more than \(maxTurns) turns", touched)
    }

    /// The pointer path's last resort, for an app that lists no controls: the screen-based computer use the
    /// classic replay rescues with. Nil when it reported done.
    private func thinkByScreen(goal: String, turns: Int) async -> String? {
        guard let env, let runID, env.hasKey("anthropic"), env.sidecar.status.isReady, CGPreflightScreenCaptureAccess() else { return "no model to work it out" }
        let target = LocalComputer()
        var history: [[String: Any]] = []
        var previous: Data?
        for turn in 0..<max(1, turns) {
            if Task.isCancelled { return "stopped" }
            let shot = await target.capture()
            let screen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(screen?.frame.width ?? 1), height: Double(screen?.frame.height ?? 1))
            let context = await target.context(box: box, imageWidth: shot?.imageWidth ?? box.width, imageHeight: shot?.imageHeight ?? box.height)
            env.store.countModelCall(runID)
            guard let act = await BrainClient.shared.computer(goal: goal, step: turn, appName: context.appName, windowTitle: context.windowTitle, screen: box,
                                                              imageWidth: shot?.imageWidth ?? 0, imageHeight: shot?.imageHeight ?? 0, history: history,
                                                              controls: context.controls, scripting: context.scripting, screenshotPNG: shot?.png,
                                                              previousPNG: previous, referencePNG: nil, canClick: target.canAct, canSee: shot != nil,
                                                              model: env.store.settings.claudeModel) else { return "the model didn't answer" }
            previous = shot?.png
            if act.type == "done" { return nil }
            if act.type == "fail" { return act.reason ?? act.summary ?? "it couldn't be done" }
            if Task.isCancelled || personHasIt { return "stopped" }
            do {
                let result = try await target.perform(act, screen: box, imageWidth: shot?.imageWidth ?? 1, imageHeight: shot?.imageHeight ?? 1)
                history.append(act.dictionary.merging(["result": result]) { current, _ in current })
            } catch {
                return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            observer.invalidate()
        }
        return "took more than \(turns) tries"
    }

    /// The rest of a pass by the model, from wherever the app is, up to (never through) the next
    /// irreversible step, with this pass's values and what's left of the recording as a guide.
    private func escalate(skill: Skill, plan: [HybridReplay.Planned], from cursor: Int, until stop: Int?, values: [String: String],
                          item: SkillBinder.Bound, reason: String) async -> (outcome: StepOutcome, typed: Bool) {
        let done = plan[..<cursor].map { ParameterFill.fill($0.step.text, values: $0.values).text }.suffix(12)
        let left = plan[cursor..<(stop ?? plan.count)].filter { $0.step.capture == nil }.map { ParameterFill.fill($0.step.text, values: $0.values).text }.prefix(20)
        let ending = stop.map { "Stop right before this final step and don't do it: “\(ParameterFill.fill(plan[$0].step.text, values: plan[$0].values).text)” — when the window is ready for it, finish with success true." }
            ?? "Finish once the last step is done, with success true, and put any reference or confirmation number in your summary."
        let goal = """
        Finish this task in \(observer.appName): \(skill.intent ?? skill.name), for \(item.label). \
        Values to use: \(spelled(skill: skill, values: values)). \
        A replay already did: \(done.joined(separator: " → ")). It stopped because \(reason). \
        What was left, as recorded (the app may have changed, so adapt): \(left.joined(separator: " → ")). \
        Check what the window shows now and continue from there. Never submit, send, pay or delete anything \
        unless it's in the steps above. \(ending)
        """
        let before = await observer.observation(fresh: true)
        let unknown = MacReplay.unknownScreen(plan, seen: before.hybrid)
        let result = await think(goal: goal, maxTurns: 30, tag: "rest")
        if let runID, !result.summary.isEmpty { env?.replayLog(runID, "→ \(item.label): \(result.summary)") }
        // A screen nobody recorded that the model got past with one click: a rule for next time.
        if result.ok, unknown, let first = result.touched.first, first.touch.action == "click", let label = first.touch.label, !label.isEmpty,
           first.touch.window == before.window, !MacReplay.isRisky(label),
           let key = MacReplay.screenKey(window: before.window, sheets: before.sheets),
           !learnedInterrupts.contains(where: { $0.whenText == key }) {
            learnedInterrupts.append(InterruptHandler(whenText: key, clickLabel: label, source: "learned-page"))
            if let runID { env?.replayLog(runID, "→ remembered: on “\(before.window)”, “\(label)” moves on") }
        }
        let typed = result.touched.contains { $0.touch.action == "type" || $0.touch.action == "select" }
        return (result.ok ? .done : .failed(result.summary.isEmpty ? reason : result.summary), typed)
    }

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

    // MARK: - Ghost and Escape (the pointer path)

    private func showGhost() {
        let screen = NSScreen.okidokiPrimary
        model.screenFrame = screen.frame
        let live = CGEvent(source: nil)?.location ?? .zero
        model.point = localPoint(quartz: live, on: screen)
        model.visible = true
        let panel = GhostPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 6
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: GhostCursorView(model: model))
        panel.setFrame(screen.frame, display: false)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    private func hideGhost() {
        model.visible = false
        model.clicking = false
        panel?.orderOut(nil)
        panel = nil
        removeMonitors()
    }

    private func moveGhost(to quartz: CGPoint) {
        guard !accessibilityOnly else { return }
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let appKit = CGPoint(x: quartz.x, y: mainHeight - quartz.y)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(appKit) }) ?? NSScreen.okidokiPrimary
        if screen.frame != model.screenFrame, let panel {
            model.screenFrame = screen.frame
            panel.setFrame(screen.frame, display: true)
        }
        model.point = localPoint(quartz: quartz, on: screen)
        AccessibilityActions.move(to: quartz)
    }

    private func localPoint(quartz: CGPoint, on screen: NSScreen) -> CGPoint {
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let appKit = CGPoint(x: quartz.x, y: mainHeight - quartz.y)
        return CGPoint(x: appKit.x - screen.frame.minX, y: screen.frame.maxY - appKit.y)
    }

    private func installMonitors() {
        guard escMonitor == nil, globalEsc == nil else { return }
        // A key okidoki presses itself is stamped synthetic and never reads as the person stopping it.
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
                return nil
            }
            return event
        }
        globalEsc = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
            }
        }
    }

    private func removeMonitors() {
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        if let globalEsc { NSEvent.removeMonitor(globalEsc) }
        escMonitor = nil
        globalEsc = nil
    }
}
