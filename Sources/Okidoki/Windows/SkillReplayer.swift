import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

/// Plays a recorded skill back, step by step, under the ghost cursor. Controls are re-found by
/// their accessibility label, then by the picture saved when they were recorded, so a moved
/// window or a reordered list still works; only when neither finds them does the brain look.
@MainActor
final class SkillReplayer {
    let model = BorrowModel()
    private weak var env: AppEnvironment?
    private var panel: GhostPanel?
    private var escMonitor: Any?
    private var globalEsc: Any?
    private var task: Task<Void, Never>?
    /// True while we are posting an esc ourselves, so the cancel monitor ignores it.
    /// Whether the step in hand needed the brain; a step that didn't ends a run of rescues.
    private var rescuedThisStep = false
    private(set) var runID: String?
    private(set) var isActive = false

    init(environment: AppEnvironment) { self.env = environment }

    /// `values` holds one set of `{{placeholder}}` values per pass (a record each); when it's empty,
    /// every pass gets only the built-ins (today's date).
    func begin(skill: Skill, runID: String, times: Int, values: [[String: String]] = []) {
        guard !isActive else { env?.failReplay(runID: runID, reason: "a replay is already running — let it finish or stop it first"); return }
        guard AccessibilityActions.canPost else {
            env?.failReplay(runID: runID, reason: "allow accessibility access in System Settings, then try again")
            return
        }
        guard !skill.steps.isEmpty else {
            env?.failReplay(runID: runID, reason: "this skill has no steps")
            return
        }
        let builtins = ParameterFill.builtins()
        let passValues = values.isEmpty ? [builtins] : values.map { builtins.merging($0) { _, given in given } }
        // Every pass must have what the skill types before anything is touched: stopping halfway
        // through a form leaves it worse than not starting.
        let needed = ParameterFill.names(in: skill.steps)
        if !needed.isEmpty {
            for given in passValues {
                let missing = ParameterFill.fill(needed.map { "{{\($0)}}" }.joined(separator: " "), values: given).missing
                guard missing.isEmpty else {
                    let which = given["ref"].map { " for \($0)" } ?? ""
                    env?.failReplay(runID: runID, reason: "“\(skill.name)” needs \(missing.joined(separator: ", "))\(which) — name a record (“\(skill.name) for <record id>”) or add \(missing[0])=… to the request")
                    return
                }
            }
        }
        isActive = true
        self.runID = runID
        rescuesInARow = 0
        preparedPids = []
        model.label = "replaying “\(skill.name)”"
        model.clicking = false
        showPanel()
        installMonitors()
        env?.speaker.speak("replaying \(skill.name).", voiceID: env?.store.settings.voiceID ?? "sarah",
                           speed: env?.store.settings.voiceSpeed ?? 1)
        let passes = values.isEmpty ? max(1, times) : values.count
        let steps = skill.steps
        task = Task { [weak self] in
            guard let self else { return }
            var failed: String?
            outer: for pass in 1...passes {
                let given = passValues[(pass - 1) % passValues.count]
                let ref = values.isEmpty ? nil : given["ref"]
                for (index, step) in steps.enumerated() {
                    if Task.isCancelled { break outer }
                    let text = (ref.map { "\($0) · " } ?? "") + ParameterFill.fill(step.text, values: given).text
                    self.markStep(index, status: .running, pass: pass, of: passes, total: steps.count, text: text)
                    let wait = SkillReplayGeometry.pause(for: step)
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    if Task.isCancelled { break outer }
                    self.rescuedThisStep = false
                    if let problem = await self.perform(step, index: index, of: steps, values: given) {
                        failed = ref.map { "\($0): \(problem)" } ?? problem
                        self.markStep(index, status: .failed, pass: pass, of: passes, total: steps.count, text: text)
                        break outer
                    }
                    if Task.isCancelled { break outer }
                    self.markStep(index, status: .done, pass: pass, of: passes, total: steps.count, text: text)
                    // "In a row" means consecutive: any step that went through on its own (a type, a key,
                    // a scroll, not only a click) resets the count.
                    if !self.rescuedThisStep { self.rescuesInARow = 0 }
                }
                if let ref {
                    self.env?.replayPassFinished(runID: runID, ref: ref, pass: pass, of: passes)
                }
                if pass < passes {
                    self.model.label = "pass \(pass) of \(passes) done — going again"
                    try? await Task.sleep(nanoseconds: 900_000_000)
                }
            }
            if Task.isCancelled { return }
            self.finish(failed: failed, passes: passes)
        }
    }

    // MARK: - Smart replay (settings.hybridReplay)

    /// The same replay with smart replay's extras: each pass's values bound first (given values, then the
    /// item's documents), conditions and loops planned in code, think steps done by the model only where
    /// no recording covers them, and a lost pass handed to the model up to (never through) an
    /// irreversible step. `begin` above is left exactly as it was.
    func beginSmart(skill: Skill, runID: String, passes given: [[String: String]], times: Int, request: String) {
        guard !isActive else { env?.failReplay(runID: runID, reason: "a replay is already running — let it finish or stop it first"); return }
        guard AccessibilityActions.canPost else {
            env?.failReplay(runID: runID, reason: "allow accessibility access in System Settings, then try again")
            return
        }
        guard let env, !skill.steps.isEmpty else { env?.failReplay(runID: runID, reason: "this skill has no steps"); return }
        isActive = true
        self.runID = runID
        rescuesInARow = 0
        preparedPids = []
        model.label = "getting everything ready for “\(skill.name)”"
        model.clicking = false
        showPanel()
        installMonitors()
        let builtins = ParameterFill.builtins()
        let raw = given.isEmpty ? Array(repeating: [String: String](), count: max(1, times)) : given
        task = Task { [weak self] in
            guard let self else { return }
            let bound = await env.bindItems(skill, passes: raw.map { builtins.merging($0) { _, mine in mine } }, runID: runID, request: request)
            if Task.isCancelled || self.runID != runID { return }
            // A pass that can't be finished is never started; the others still go.
            let gaps = bound.filter { !$0.missing.isEmpty }
            let gapNote = gaps.isEmpty ? nil : "not started (missing values) — " + gaps.map { "\($0.label): \($0.missing.joined(separator: ", "))" }.joined(separator: "; ")
            if gaps.count == bound.count {
                self.finish(failed: "missing before starting — " + gaps.map { "\($0.label): \($0.missing.joined(separator: ", "))" }.joined(separator: "; "),
                            passes: bound.count)
                return
            }
            env.speaker.speak("replaying \(skill.name).", voiceID: env.store.settings.voiceID, speed: env.store.settings.voiceSpeed)
            var failed: String?
            var done = 0
            outer: for (n, item) in bound.enumerated() where item.missing.isEmpty {
                let pass = n + 1
                let plan = HybridReplay.plan(skill.steps, values: item.values)
                let steps = plan.map(\.step)
                var doubts = HybridReplay.PassDoubts(values: item.doubts)
                let prefix = bound.count > 1 ? "\(item.label) · " : ""
                var index = 0
                while index < plan.count {
                    if Task.isCancelled { break outer }
                    let planned = plan[index]
                    let step = planned.step
                    let text = prefix + ParameterFill.fill(step.text, values: planned.values).text
                    self.markStep(planned.source, status: .running, pass: pass, of: bound.count, total: plan.count, text: text)
                    try? await Task.sleep(nanoseconds: UInt64(min(SkillReplayGeometry.pause(for: step), 0.6) * 1_000_000_000))
                    if let reasons = HybridReplay.pauseReasons(before: step, skill: skill, doubts: doubts) {
                        // Nobody to ask mid-ghost: stop before it, with the reason, rather than guess.
                        failed = "\(item.label): stopped before “\(step.text)” to check with you — \(reasons.joined(separator: "; "))"
                        break outer
                    }
                    self.rescuedThisStep = false
                    var problem: String?
                    if step.mode == "think" {
                        let goal = "Do only this part of a task, then report done: " + ParameterFill.fill(step.text, values: planned.values).text
                        problem = await self.thinkStep(goal: goal, turns: step.maxTurns ?? 12)
                    } else if step.action == "read" {
                        problem = nil
                    } else {
                        problem = await self.perform(step, index: index, of: steps, values: planned.values)
                    }
                    if let lost = problem {
                        // The recording lost its way: the model carries this pass on from here, up to the next
                        // irreversible step, which the replay then does itself.
                        let stop = plan[index...].firstIndex { $0.step.irreversible == true && $0.source != planned.source }
                        let left = plan[index..<(stop ?? plan.count)].map { ParameterFill.fill($0.step.text, values: $0.values).text }
                        let goal = "Carry on with “\(skill.intent ?? skill.name)” for \(item.label). The recorded steps left: \(left.joined(separator: " → ")). "
                            + "The last one didn't work (\(lost)); the app may have changed, so adapt. Never submit, send, pay or delete unless it's one of those steps. Report done when they're done."
                        env.replayLog(runID, "→ \(prefix)\(lost) — handing over to the model")
                        if let stillLost = await self.thinkStep(goal: goal, turns: 25) {
                            failed = "\(item.label): \(stillLost)"
                            self.markStep(planned.source, status: .failed, pass: pass, of: bound.count, total: plan.count, text: text)
                            break outer
                        }
                        doubts.helped.append(step.text)
                        index = stop ?? plan.count
                        continue
                    }
                    self.markStep(planned.source, status: .done, pass: pass, of: bound.count, total: plan.count, text: text)
                    if !self.rescuedThisStep { self.rescuesInARow = 0 }
                    index += 1
                }
                done += 1
                env.replayLog(runID, "\(item.label) · done", receipt: true)
            }
            if Task.isCancelled { return }
            let problems = [failed, gapNote].compactMap { $0 }
            self.finish(failed: problems.isEmpty ? nil : "\(done) of \(bound.count) done · " + problems.joined(separator: "; "), passes: bound.count)
        }
    }

    /// The model drives the Mac for a bounded stretch (a think step, or the rest of a lost pass).
    /// Nil when it reported done; otherwise why not.
    private func thinkStep(goal: String, turns: Int) async -> String? {
        guard canRescue, let env else { return "no model to work it out" }
        model.label = "working it out — \(goal.prefix(60))"
        let target = LocalComputer()
        var history: [[String: Any]] = []
        var previous: Data?
        for turn in 0..<turns {
            if Task.isCancelled { return "stopped" }
            let shot = await target.capture()
            let screen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(screen?.frame.width ?? 1), height: Double(screen?.frame.height ?? 1))
            let context = await target.context(box: box, imageWidth: shot?.imageWidth ?? box.width, imageHeight: shot?.imageHeight ?? box.height)
            if let runID { env.store.countModelCall(runID) }
            guard let act = await BrainClient.shared.computer(goal: goal, step: turn, appName: context.appName,
                                                              windowTitle: context.windowTitle, screen: box,
                                                              imageWidth: shot?.imageWidth ?? 0, imageHeight: shot?.imageHeight ?? 0,
                                                              history: history, controls: context.controls,
                                                              scripting: context.scripting, screenshotPNG: shot?.png,
                                                              previousPNG: previous, referencePNG: nil,
                                                              canClick: target.canAct, canSee: shot != nil,
                                                              model: env.store.settings.claudeModel) else { return "the model didn't answer" }
            previous = shot?.png
            if act.type == "done" { return nil }
            if act.type == "fail" { return act.reason ?? act.summary ?? "it couldn't be done" }
            if let say = act.say, !say.isEmpty { model.label = say }
            if let x = act.x, let y = act.y, let shot, shot.imageWidth > 0, shot.imageHeight > 0 {
                moveGhost(to: CGPoint(x: box.x + x / shot.imageWidth * box.width, y: box.y + y / shot.imageHeight * box.height))
            }
            do {
                let result = try await target.perform(act, screen: box, imageWidth: shot?.imageWidth ?? 1, imageHeight: shot?.imageHeight ?? 1)
                history.append(act.dictionary.merging(["result": result]) { current, _ in current })
            } catch {
                return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        return "took more than \(turns) tries"
    }

    private func markStep(_ index: Int, status: RunStatus, pass: Int, of passes: Int, total: Int, text: String) {
        guard let env, let runID else { return }
        env.store.updateRun(runID) { run in
            guard run.steps.indices.contains(index) else { return }
            if status == .running {
                // A new pass resets the earlier steps so the list reads top to bottom again.
                if index == 0 { for i in run.steps.indices { run.steps[i].status = .waiting; run.steps[i].endedAt = nil } }
                run.steps[index].startedAt = Date()
            } else {
                run.steps[index].endedAt = Date()
            }
            run.steps[index].status = status
            if passes > 1 { run.summary = "pass \(pass) of \(passes)" }
        }
        if status == .running {
            let prefix = passes > 1 ? "\(pass)/\(passes) · " : ""
            model.label = "\(prefix)step \(index + 1)/\(total) · \(text)"
        }
    }

    /// Returns a reason when the step couldn't be done.
    private func perform(_ step: SkillStep, index: Int, of steps: [SkillStep], values: [String: String]) async -> String? {
        let action = step.action ?? "click"
        let hasApp = SkillReplayGeometry.isRealApp(step.app)
        let around = Neighbours(previous: index > 0 ? steps[index - 1] : nil,
                                next: index + 1 < steps.count ? steps[index + 1] : nil)
        if action == "switch" {
            guard hasApp else { return nil }
            if await activate(step.app) { return nil }
            switch await rescue(step, around: around, because: "\(step.app) didn't open") {
            case .done: return nil
            case .failed(let problem): return problem
            case .unavailable: return "couldn't open \(step.app)"
            }
        }
        if hasApp, !SkillReplayGeometry.sameApp(NSWorkspace.shared.frontmostApplication?.localizedName ?? "", step.app) {
            _ = await activate(step.app)
            try? await Task.sleep(nanoseconds: 250_000_000)
            // Keys go to whatever is in front. If that still isn't the step's app, typing now would
            // land in someone else's window (a terminal, a chat), so stop instead.
            if action == "type" || action == "key",
               !SkillReplayGeometry.sameApp(NSWorkspace.shared.frontmostApplication?.localizedName ?? "", step.app) {
                return "couldn't bring \(step.app) to the front, so nothing was typed"
            }
        }
        switch action {
        case "type":
            guard let raw = step.input, !raw.isEmpty else { return nil }
            let filled = ParameterFill.fill(raw, values: values)
            guard filled.missing.isEmpty else { return "no value for \(filled.missing.joined(separator: ", "))" }
            let text = filled.text
            guard !text.isEmpty else { return nil }
            // Real keys from the live layout, the way computer use types: some fields (Safari's
            // address bar) ignore characters that arrive without a key behind them.
            guard EventActuator.canPost else { return "couldn't type" }
            // Typing right after clicking a field: give a slow page the moment it needs to put the
            // field there and focus it, rather than sending the text into nothing.
            if index > 0, let role = steps[index - 1].role, AXSearch.textInputRoles.contains(role),
               let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier {
                for _ in 0..<15 {
                    if let focused = await Task.detached(operation: { AXSearch.focusedInput(pid: pid) }).value,
                       AXSearch.textInputRoles.contains(focused.role) { break }
                    if Task.isCancelled { return nil }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            // Esc during the wait above: `try? Task.sleep` returns at once, so check before typing.
            if Task.isCancelled { return nil }
            await EventActuator.typeText(text)
            return nil
        case "key":
            guard let combo = step.input, !combo.isEmpty else { return nil }
            // The skill's own escape goes out stamped synthetic, so the Esc monitor can tell it from the
            // user's: a real Esc stops the replay even in the instant the skill presses one.
            // pressKey follows the live keyboard layout (⌘A must stay ⌘A on AZERTY, not become ⌘Q) and
            // stamps the event synthetic; raw key codes it can't resolve go out the old way.
            if Task.isCancelled { return nil }
            var ok = await EventActuator.pressKey(combo)
            if !ok, EventActuator.canPost { ok = await offMain { AccessibilityActions.press(combo) } }
            return ok ? nil : "couldn't press \(WatchRecorder.prettyCombo(combo))"
        case "scroll":
            // Scrolling somewhere near the right place is fine; it isn't worth waiting for.
            guard let point = await locate(step, patient: false).point else { return nil }
            moveGhost(to: point)
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return nil }
            let dy = step.toY ?? 0
            return await offMain { AccessibilityActions.scroll(at: point, dy: dy) } ? nil : "couldn't scroll"
        case "drag":
            let target = await locate(step, patient: true)
            if !target.verified, hasEvidence(step) {
                switch await rescue(step, around: around, because: "\(describe(step)) isn't where it was") {
                case .done: return nil
                case .failed(let problem): return problem
                case .unavailable: return "\(describe(step)) isn't on screen"
                }
            }
            guard let from = target.point, let tx = step.toX, let ty = step.toY else { return "drag has no end point" }
            // The end point moves with the window just like the start did.
            let to = CGPoint(x: tx + target.shift.width, y: ty + target.shift.height)
            moveGhost(to: from)
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return nil }
            model.clicking = true
            let ok = await offMain { AccessibilityActions.drag(from: from, to: to) }
            moveGhost(to: to)
            try? await Task.sleep(nanoseconds: 300_000_000)
            model.clicking = false
            return ok ? nil : "couldn't drag"
        default:
            let target = await locate(step, patient: true)
            if !target.verified, hasEvidence(step) {
                // We know what this control is called or looks like, and it's nowhere on screen:
                // the app is in a different state than when it was recorded. Clicking the old spot
                // blind would knock the rest of the replay off course, so the brain looks instead.
                switch await rescue(step, around: around, because: "\(describe(step)) isn't where it was") {
                case .done: return nil
                case .failed(let problem): return problem
                case .unavailable: return "\(describe(step)) isn't on screen"
                }
            }
            guard let point = target.point else { return "can't find where to click" }
            moveGhost(to: point)
            try? await Task.sleep(nanoseconds: 650_000_000)
            if Task.isCancelled { return nil }
            model.clicking = true
            let (button, count) = SkillReplayGeometry.clickShape(action)
            let ok = await offMain { AccessibilityActions.click(at: point, button: button, count: count) }
            try? await Task.sleep(nanoseconds: 350_000_000)
            model.clicking = false
            return ok ? nil : "couldn't click"
        }
    }

    /// Event posting sleeps between events; keep that off the main thread so the ghost keeps animating.
    private func offMain(_ work: @escaping @Sendable () -> Bool) async -> Bool {
        await Task.detached(priority: .userInitiated) { work() }.value
    }

    private func activate(_ name: String) async -> Bool {
        await SkillTargetResolver.activate(name)
    }

    // MARK: - Finding the target

    /// Something to check a candidate against before acting: a label, a role, or a picture.
    private func hasEvidence(_ step: SkillStep) -> Bool {
        SkillReplayGeometry.isCheckable(step) || hasPicture(step)
    }

    private func hasPicture(_ step: SkillStep) -> Bool {
        step.frameRect != nil && SkillFrames.has(step.id)
    }

    private func describe(_ step: SkillStep) -> String {
        let label = targetLabel(step)
        return label.isEmpty ? "the \(step.role?.replacingOccurrences(of: "AX", with: "").lowercased() ?? "control")" : "“\(label)”"
    }

    /// Where the step's control is now. Cheapest first: accessibility at the recorded spot, carried
    /// with its window, by label; then by its recorded picture; and when `patient`, the same again
    /// every little while for a couple of seconds, since the app may simply not have caught up yet.
    private func locate(_ step: SkillStep, patient: Bool) async -> SkillTargetResolver.Resolution {
        let recorded = recordedPoint(step)
        let pid = SkillTargetResolver.ownerPid(for: step)
        prepareTree(pid)
        let picture = hasPicture(step)
        var result = await resolveTarget(step, pid: pid, recorded: recorded, quick: false)
        if result.verified {
            // A match on a generic role alone is a guess: after a list reorders, the old spot
            // still holds *a* cell, just not this one. With a picture, the picture decides.
            guard picture, SkillReplayGeometry.isWeakEvidence(step) else { return result }
            if let seen = await resolveByPicture(step, pid: pid, recorded: recorded, near: result.point) { return seen }
            result.verified = false
        }
        guard hasEvidence(step) else { return result }
        let deadline = Date().addingTimeInterval(patient ? SkillReplayGeometry.patience : 0)
        let before = model.label
        defer { model.label = before }
        var looks = 0
        while !Task.isCancelled {
            if picture, let seen = await resolveByPicture(step, pid: pid, recorded: recorded, near: result.point ?? recorded) {
                return seen
            }
            guard Date() < deadline else { return result }
            if looks == 0 { model.label = "waiting for \(describe(step))" }
            looks += 1
            try? await Task.sleep(nanoseconds: UInt64(SkillReplayGeometry.lookInterval * 1_000_000_000))
            // The tree walk is the slow part; every third look is enough for it.
            result = await resolveTarget(step, pid: pid, recorded: recorded, quick: looks % 3 != 0)
            if result.verified { return result }
        }
        return result
    }

    private var preparedPids: Set<pid_t> = []

    /// Electron and Chromium apps keep their accessibility tree empty until asked once.
    private func prepareTree(_ pid: pid_t) {
        guard pid != 0, !preparedPids.contains(pid) else { return }
        preparedPids.insert(pid)
        AXSearch.enableTree(pid: pid)
    }

    private func resolveTarget(_ step: SkillStep, pid: pid_t, recorded: CGPoint?, quick: Bool) async -> SkillTargetResolver.Resolution {
        await Task.detached(priority: .userInitiated) {
            SkillTargetResolver.resolve(step, pid: pid, recorded: recorded, quick: quick)
        }.value
    }

    /// One capture of the display the control should be on, matched against the step's picture;
    /// then the other displays, in case the window went there.
    private func resolveByPicture(_ step: SkillStep, pid: pid_t, recorded: CGPoint?, near: CGPoint?) async -> SkillTargetResolver.Resolution? {
        let anchor = near ?? recorded
        let first = anchor.flatMap { screenContaining(quartz: $0) } ?? NSScreen.okidokiPrimary
        let screens = [first] + NSScreen.screens.filter { $0 != first }
        for screen in screens {
            if Task.isCancelled { return nil }
            guard let raw = await ComputerUseService.shared.captureRaw(screen: screen) else { continue }
            let found = await Task.detached(priority: .userInitiated) {
                SkillTargetResolver.resolveByPicture(step, pid: pid, shot: raw.image, box: raw.box, recorded: recorded, near: near)
            }.value
            if let found { return found }
        }
        return nil
    }

    private func screenContaining(quartz: CGPoint) -> NSScreen? {
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let appKit = CGPoint(x: quartz.x, y: mainHeight - quartz.y)
        return NSScreen.screens.first { $0.frame.contains(appKit) }
    }

    // MARK: - Rescue (the brain does one step when the screen doesn't match the recording)

    /// Only when there's a brain to ask. Without it the replay stays exactly as fast and blind as before.
    private var canRescue: Bool {
        guard let env else { return false }
        return env.hasKey("anthropic") && env.sidecar.status.isReady && CGPreflightScreenCaptureAccess()
    }

    private enum Rescue { case done, failed(String), unavailable }

    private struct Neighbours {
        var previous: SkillStep?
        var next: SkillStep?
    }

    /// Steps the brain has had to do back to back. A replay that needs help on every step has
    /// lost the thread, and it's better to say so than to keep guessing.
    private var rescuesInARow = 0
    private let rescueLimit = 3

    /// Asks the brain to look at the screen and do just this step. `.done` means the replay can
    /// carry on at full speed; `.unavailable` means there is no brain to ask.
    private func rescue(_ step: SkillStep, around: Neighbours, because reason: String) async -> Rescue {
        guard canRescue, let env else { return .unavailable }
        guard rescuesInARow < rescueLimit else {
            return .failed("lost track — needed help on \(rescueLimit) steps in a row and \(describe(step)) still isn't on screen")
        }
        rescuesInARow += 1
        rescuedThisStep = true
        let before = model.label
        model.label = "looking closer — \(reason)"
        defer { model.label = before }
        let target = LocalComputer()
        let name = env.store.run(runID ?? "")?.prompt ?? "a recorded skill"
        var goal = "You are finishing ONE step of a recorded skill called “\(name)”. Do only this step, then report done: \(step.text)."
        goal += " It was recorded as “\(step.action ?? "click")”"
        if let x = step.x, let y = step.y { goal += " at screen point (\(Int(x)), \(Int(y)))" }
        let label = targetLabel(step)
        if !label.isEmpty { goal += " on a control labelled “\(label)”" }
        if let role = step.role, !role.isEmpty { goal += " (accessibility role \(role))" }
        if let title = step.winTitle, !title.isEmpty { goal += " in a window titled “\(title)”" }
        goal += ", but \(reason). The app may be in a different state than when it was recorded (a dialog, a menu, a moved window, a different page, a list that reordered)."
        if let previous = around.previous { goal += " The step before this one was: \(previous.text). It may not have taken effect — if so, get the app to the state it should have produced first." }
        if let next = around.next { goal += " The step after this one will be: \(next.text) — leave the app ready for it, but do not do it." }
        let reference = SkillFrames.png(step.id)
        if reference != nil { goal += " A picture of what the target looked like when it was recorded is attached; find the same thing on the screen now." }
        goal += " Deal with whatever is in the way only as far as needed to do this step. Do not do any later steps. If it truly can't be done, fail with the reason."
        var history: [[String: Any]] = []
        var previous: Data?
        for turn in 0..<5 {
            if Task.isCancelled { return .failed("stopped") }
            let shot = await target.capture()
            let screen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(screen?.frame.width ?? 1), height: Double(screen?.frame.height ?? 1))
            let context = await target.context(box: box, imageWidth: shot?.imageWidth ?? box.width, imageHeight: shot?.imageHeight ?? box.height)
            if let runID { env.store.countModelCall(runID) }
            guard let act = await BrainClient.shared.computer(goal: goal, step: turn, appName: context.appName,
                                                              windowTitle: context.windowTitle, screen: box,
                                                              imageWidth: shot?.imageWidth ?? 0, imageHeight: shot?.imageHeight ?? 0,
                                                              history: history, controls: context.controls,
                                                              scripting: context.scripting, screenshotPNG: shot?.png,
                                                              previousPNG: previous, referencePNG: reference,
                                                              canClick: target.canAct, canSee: shot != nil,
                                                              model: env.store.settings.claudeModel) else {
                // No answer on the first look: nothing was touched, so the plain replay can go on.
                return turn == 0 ? .unavailable : .failed("the brain stopped answering mid-step")
            }
            previous = shot?.png
            if Task.isCancelled { return .failed("stopped") }
            if act.type == "done" { return .done }
            if act.type == "fail" { return .failed(act.reason ?? act.summary ?? "couldn't do “\(step.text)”") }
            if let say = act.say, !say.isEmpty { model.label = say }
            if let x = act.x, let y = act.y, let shot, shot.imageWidth > 0, shot.imageHeight > 0 {
                moveGhost(to: CGPoint(x: box.x + x / shot.imageWidth * box.width, y: box.y + y / shot.imageHeight * box.height))
            }
            let result: String
            do {
                result = try await target.perform(act, screen: box, imageWidth: shot?.imageWidth ?? 1, imageHeight: shot?.imageHeight ?? 1)
            } catch {
                return .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
            history.append(act.dictionary.merging(["result": result]) { current, _ in current })
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        return .failed("“\(step.text)” took too many tries")
    }

    private func targetLabel(_ step: SkillStep) -> String {
        SkillReplayGeometry.targetLabel(step)
    }

    private func recordedPoint(_ step: SkillStep) -> CGPoint? {
        SkillReplayGeometry.recordedPoint(step, mainDisplayHeight: Double(NSScreen.screens.first?.frame.height ?? 0))
    }

    // MARK: - Ghost

    private func showPanel() {
        let screen = NSScreen.okidokiPrimary
        model.screenFrame = screen.frame
        let live = CGEvent(source: nil)?.location ?? .zero
        model.point = localPoint(quartz: live, on: screen)
        model.visible = true
        let panel = GhostPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
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

    private func moveGhost(to quartz: CGPoint) {
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
        // An escape the brain presses during a rescue (to close a menu, say) is stamped synthetic
        // and must not read as the user stopping the replay.
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.escPressed() }
                return nil
            }
            return event
        }
        globalEsc = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.escPressed() }
            }
        }
    }

    private func escPressed() {
        cancel(reason: "okay, stopping")
    }

    private func tearDown() {
        isActive = false
        model.visible = false
        model.clicking = false
        panel?.orderOut(nil)
        panel = nil
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        if let globalEsc { NSEvent.removeMonitor(globalEsc) }
        escMonitor = nil
        globalEsc = nil
    }

    private func finish(failed: String?, passes: Int) {
        guard let runID else { return }
        tearDown()
        task = nil
        if let failed {
            env?.failReplay(runID: runID, reason: failed)
        } else {
            env?.finishReplay(runID: runID, passes: passes)
        }
        self.runID = nil
    }

    func cancel(reason: String = "control is yours") {
        EventActuator.stopTyping()
        guard isActive else { return }
        task?.cancel()
        task = nil
        tearDown()
        if let runID {
            env?.cancelRun(runID)
            env?.toast(title: "yours again", detail: reason, kind: .info,
                       undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
        }
        runID = nil
    }
}
