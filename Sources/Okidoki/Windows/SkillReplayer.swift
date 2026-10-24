import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

/// Plays a recorded skill back, step by step, under the ghost cursor. Buttons are re-found by
/// their accessibility label so a moved window still works; otherwise the recorded point is used.
@MainActor
final class SkillReplayer {
    let model = BorrowModel()
    private weak var env: AppEnvironment?
    private var panel: GhostPanel?
    private var escMonitor: Any?
    private var globalEsc: Any?
    private var task: Task<Void, Never>?
    /// True while we are posting an esc ourselves, so the cancel monitor ignores it.
    private var postingEsc = false
    private(set) var runID: String?
    private(set) var isActive = false

    init(environment: AppEnvironment) { self.env = environment }

    func begin(skill: Skill, runID: String, times: Int) {
        guard !isActive else { env?.failReplay(runID: runID, reason: "a replay is already running — let it finish or stop it first"); return }
        guard AccessibilityActions.canPost else {
            env?.failReplay(runID: runID, reason: "allow accessibility access in System Settings, then try again")
            return
        }
        guard !skill.steps.isEmpty else {
            env?.failReplay(runID: runID, reason: "this skill has no steps")
            return
        }
        isActive = true
        self.runID = runID
        model.label = "replaying “\(skill.name)”"
        model.clicking = false
        showPanel()
        installMonitors()
        env?.speaker.speak("replaying \(skill.name).", voiceID: env?.store.settings.voiceID ?? "sarah",
                           speed: env?.store.settings.voiceSpeed ?? 1)
        let passes = max(1, times)
        let steps = skill.steps
        task = Task { [weak self] in
            guard let self else { return }
            var failed: String?
            outer: for pass in 1...passes {
                for (index, step) in steps.enumerated() {
                    if Task.isCancelled { break outer }
                    self.markStep(index, status: .running, pass: pass, of: passes, total: steps.count, text: step.text)
                    let wait = SkillReplayGeometry.pause(for: step)
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    if Task.isCancelled { break outer }
                    if let problem = await self.perform(step) {
                        failed = problem
                        self.markStep(index, status: .failed, pass: pass, of: passes, total: steps.count, text: step.text)
                        break outer
                    }
                    if Task.isCancelled { break outer }
                    self.markStep(index, status: .done, pass: pass, of: passes, total: steps.count, text: step.text)
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
    private func perform(_ step: SkillStep) async -> String? {
        let action = step.action ?? "click"
        let hasApp = SkillReplayGeometry.isRealApp(step.app)
        if action == "switch" {
            guard hasApp else { return nil }
            if await activate(step.app) { return nil }
            switch await rescue(step, because: "\(step.app) didn't open") {
            case .done: return nil
            case .failed(let problem): return problem
            case .unavailable: return "couldn't open \(step.app)"
            }
        }
        if hasApp, NSWorkspace.shared.frontmostApplication?.localizedName != step.app {
            _ = await activate(step.app)
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        switch action {
        case "type":
            guard let text = step.input, !text.isEmpty else { return nil }
            return await offMain { AccessibilityActions.type(text) } ? nil : "couldn't type"
        case "key":
            guard let combo = step.input, !combo.isEmpty else { return nil }
            let isEsc = combo.hasSuffix("escape")
            if isEsc { postingEsc = true }
            let ok = await offMain { AccessibilityActions.press(combo) }
            if isEsc {
                try? await Task.sleep(nanoseconds: 250_000_000)
                postingEsc = false
            }
            return ok ? nil : "couldn't press \(WatchRecorder.prettyCombo(combo))"
        case "scroll":
            guard let point = await resolvePoint(step) else { return nil }
            moveGhost(to: point)
            try? await Task.sleep(nanoseconds: 350_000_000)
            let dy = step.toY ?? 0
            return await offMain { AccessibilityActions.scroll(at: point, dy: dy) } ? nil : "couldn't scroll"
        case "drag":
            let target = await resolveTarget(step)
            guard let from = target.point, let tx = step.toX, let ty = step.toY else { return "drag has no end point" }
            // The end point moves with the window just like the start did.
            let to = CGPoint(x: tx + target.shift.width, y: ty + target.shift.height)
            moveGhost(to: from)
            try? await Task.sleep(nanoseconds: 500_000_000)
            model.clicking = true
            let ok = await offMain { AccessibilityActions.drag(from: from, to: to) }
            moveGhost(to: to)
            try? await Task.sleep(nanoseconds: 300_000_000)
            model.clicking = false
            return ok ? nil : "couldn't drag"
        default:
            let target = await resolveTarget(step)
            // The control was recorded by name and it's nowhere on screen: the app is in a different
            // state than when it was recorded. Let the brain look and do this one step, instead of
            // clicking blind at the old spot and knocking the rest of the replay off course.
            if !target.verified, SkillReplayGeometry.isCheckable(step), canRescue {
                let what = targetLabel(step).isEmpty ? "the \(step.role ?? "control")" : "“\(targetLabel(step))”"
                switch await rescue(step, because: "\(what) isn't where it was") {
                case .done: return nil
                case .failed(let problem): return problem
                case .unavailable: break
                }
            }
            guard let point = target.point else { return "can't find where to click" }
            moveGhost(to: point)
            try? await Task.sleep(nanoseconds: 650_000_000)
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

    /// Quartz-space point for the step: the recorded spot if the same control is still there, else
    /// the spot carried along with its moved window, else a label search, else the recorded spot as-is.
    private func resolvePoint(_ step: SkillStep) async -> CGPoint? {
        await resolveTarget(step).point
    }

    private func resolveTarget(_ step: SkillStep) async -> SkillTargetResolver.Resolution {
        let recorded = recordedPoint(step)
        let pid = SkillTargetResolver.ownerPid(for: step)
        return await Task.detached(priority: .userInitiated) {
            SkillTargetResolver.resolve(step, pid: pid, recorded: recorded)
        }.value
    }

    // MARK: - Rescue (the brain does one step when the screen doesn't match the recording)

    /// Only when there's a brain to ask. Without it the replay stays exactly as fast and blind as before.
    private var canRescue: Bool {
        guard let env else { return false }
        return env.hasKey("anthropic") && env.sidecar.status.isReady && CGPreflightScreenCaptureAccess()
    }

    private enum Rescue { case done, failed(String), unavailable }

    /// Asks the brain to look at the screen and do just this step. `.done` means the replay can
    /// carry on at full speed; `.unavailable` means fall back to the recorded point as before.
    private func rescue(_ step: SkillStep, because reason: String) async -> Rescue {
        guard canRescue, let env else { return .unavailable }
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
        goal += ", but \(reason). The app may be in a different state than when it was recorded (a dialog, a menu, a moved window, a different page)."
        goal += " Deal with whatever is in the way only as far as needed to do this step. Do not do any later steps. If it truly can't be done, fail with the reason."
        var history: [[String: Any]] = []
        var previous: Data?
        for turn in 0..<5 {
            if Task.isCancelled { return .failed("stopped") }
            let shot = await target.capture()
            let screen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(screen?.frame.width ?? 1), height: Double(screen?.frame.height ?? 1))
            let context = await target.context(box: box, imageWidth: shot?.imageWidth ?? box.width, imageHeight: shot?.imageHeight ?? box.height)
            guard let act = await BrainClient.shared.computer(goal: goal, step: turn, appName: context.appName,
                                                              windowTitle: context.windowTitle, screen: box,
                                                              imageWidth: shot?.imageWidth ?? 0, imageHeight: shot?.imageHeight ?? 0,
                                                              history: history, controls: context.controls,
                                                              scripting: context.scripting, screenshotPNG: shot?.png,
                                                              previousPNG: previous, canClick: target.canAct, canSee: shot != nil,
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
            try? await Task.sleep(nanoseconds: 400_000_000)
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
        guard !postingEsc else { return }
        cancel(reason: "okay, stopping")
    }

    private func tearDown() {
        isActive = false
        postingEsc = false
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
