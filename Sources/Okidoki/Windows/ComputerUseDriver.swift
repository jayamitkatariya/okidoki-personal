import AppKit
import Combine
import SwiftUI
import OkidokiCore

// MARK: - Model

@MainActor
final class DriverModel: ObservableObject {
    @Published var visible = false
    @Published var goal = ""
    @Published var stepText = "warming up"
    @Published var stepIndex = 0
    /// "script", "pointer", "keys", "app", "look", or "" while thinking.
    @Published var kind = ""
    /// Second line: the first line of a script, the key combo, or the typed text.
    @Published var detail = ""
    /// What the model last looked at, with where it aimed (0–1 in the image) for pointer steps.
    @Published var thumb: NSImage?
    @Published var aim: CGPoint?
    @Published var targetName = "this Mac"
    /// Timeline for the Live page. Kept after the run ends so the last run stays visible.
    @Published var steps: [LiveStep] = []
    @Published var runID: String?
}

final class DriverHUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Driver

@MainActor
final class ComputerUseDriver {
    let model = DriverModel()
    private weak var env: AppEnvironment?
    private var panel: DriverHUDPanel?
    private var runID: String?
    private var cancelled = false
    /// Bumped by begin() and cancel(); a loop whose number no longer matches stays out of the way.
    private var session = 0
    private var driving = false
    private var escLocal: Any?
    private var escGlobal: Any?
    private var blindVision = 0
    private var recorder: DriveRecorder?
    /// okidoki's own windows stepped aside for the run.
    private var hiddenWindows: [NSWindow] = []
    private var target: ComputerTarget = LocalComputer()
    private let cursor = DriveCursorController()
    private let glow = EdgeGlowController()

    static let pillWidth: CGFloat = 440
    static let pillHeight: CGFloat = 56

    init(environment: AppEnvironment) { self.env = environment }

    var isActive: Bool { model.visible }

    func begin(run: AgentRun, target: ComputerTarget? = nil) {
        guard let env else { return }
        guard !model.visible else {
            // execute() already marked the run running; don't leave it that way with no pill.
            env.store.finishRun(run.id, status: .failed, summary: "already driving another run — stop it first")
            return
        }
        let target = target ?? LocalComputer()
        self.target = target
        runID = run.id
        cancelled = false
        session += 1
        let current = session
        driving = false
        blindVision = 0
        model.goal = run.title
        model.stepText = "looking at the screen"
        model.stepIndex = 0
        model.kind = ""
        model.detail = ""
        model.thumb = nil
        model.aim = nil
        model.targetName = target.displayName
        model.steps = []
        model.runID = run.id
        model.visible = true
        LiveFrames.shared.clear()
        EventActuator.setPace(env.store.settings.drivePace)
        let modelName = Self.modelName(env.store.settings.claudeModel)
        let useV2 = Self.drivingProtocol(model: modelName) == "v2"
        recorder = DriveRecorder(runID: run.id, goal: run.prompt, protocolVersion: useV2 ? "v2" : "v1", model: modelName)
        ComputerUseService.shared.onPermissionPrompt = { [weak self] name in
            guard let self, self.model.visible else { return }
            self.model.stepText = "macOS is asking if okidoki may control \(name)"
            self.model.detail = "click OK in the dialog to let it"
            self.env?.speak("Mac OS is asking if I may control \(name). Click OK to let me.")
        }

        let screen = target.screen() ?? NSScreen.main ?? NSScreen.screens[0]
        let panel = DriverHUDPanel(contentRect: NSRect(x: screen.frame.midX - Self.pillWidth / 2,
                                                      y: screen.visibleFrame.minY + 18,
                                                      width: Self.pillWidth, height: Self.pillHeight),
                                   styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 6
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: DriverHUDView(model: model,
                                                                  onStop: { [weak self] in self?.cancel(reason: "you stopped me") }))
        panel.orderFrontRegardless()
        self.panel = panel

        if target.stopsOnUserEscape {
            installMonitors()
            clearOwnWindows()
        }
        if target.showsPointerOverlay {
            cursor.show(on: screen, label: "okidoki · looking")
            glow.show(on: screen)
        }
        env.speak(target.stopsOnUserEscape ? "On it. Press escape or stop if you want it back."
                  : target.isRemote ? "On it, on your private Mac." : "On it, in the background.")
        Task {
            if useV2 { await loopV2(run: run, session: current) } else { await loop(run: run, session: current) }
        }
    }

    /// "v2" (the computer use toolset, batches) unless the saved default says "v1" or the model can't take the toolset.
    nonisolated static func drivingProtocol(model: String) -> String {
        let chosen = UserDefaults.standard.string(forKey: "drivingProtocol") ?? "v2"
        return chosen == "v1" || !supportsToolset(model) ? "v1" : "v2"
    }

    /// Same list as the brain's: models that take `computer_toolset_20260801`.
    nonisolated static func supportsToolset(_ model: String) -> Bool {
        let name = model.lowercased()
        return ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8",
                "claude-fable-5-1", "claude-mythos-5-1", "claude-fable-5", "claude-mythos-5"]
            .contains { name == $0 || name.hasPrefix("\($0)-2") }
    }

    // MARK: Loop

    /// `session` tells a loop that was cancelled mid-request apart from the one that replaced it, so
    /// it never touches the newer run's pill, monitors or step list when it wakes up.
    private func loop(run: AgentRun, session: Int) async {
        defer { if session == self.session { cleanupPanels() } }
        var history: [[String: Any]] = []
        var recent: [String] = []
        // The screenshot from before the last action, so the model can see what changed.
        var previous: Data?
        var showPrevious = false
        // A magnified crop requested last step, sent alongside the next screenshot.
        var zoom: ComputerUseService.Zoom?
        let maxSteps = 60
        for step in 0..<maxSteps {
            guard session == self.session, !cancelled, let env else { return }
            guard await holdWhilePaused(run.id, session: session) else { return }
            model.kind = ""
            model.detail = ""
            if target.showsPointerOverlay, let screen = target.screen() {
                cursor.show(on: screen, label: "okidoki · thinking")
            }
            let captureClock = Stopwatch()
            let shot = await target.capture()
            let captureMs = captureClock.ms
            let fallbackScreen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(fallbackScreen?.frame.width ?? 1),
                                             height: Double(fallbackScreen?.frame.height ?? 1))
            let imageWidth = shot?.imageWidth ?? box.width
            let imageHeight = shot?.imageHeight ?? box.height
            let contextClock = Stopwatch()
            let context = await target.context(box: box, imageWidth: imageWidth, imageHeight: imageHeight)
            let contextMs = contextClock.ms
            var act: ComputerAction?
            var meta: BrainComputerMeta?
            var requestBytes = 0
            let brainClock = Stopwatch()
            // Right after launch the brain may still be starting; give it a moment instead of failing.
            if !env.sidecar.status.isReady {
                for _ in 0..<16 where !env.sidecar.status.isReady && !cancelled {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            if env.sidecar.status.isReady {
                env.store.countModelCall(run.id)
                let turn = await BrainClient.shared.computerTurn(goal: run.prompt, step: step,
                                                                 appName: context.appName,
                                                                 windowTitle: context.windowTitle,
                                                                 screen: box, imageWidth: shot?.imageWidth ?? 0,
                                                                 imageHeight: shot?.imageHeight ?? 0, history: history,
                                                                 controls: context.controls,
                                                                 scripting: context.scripting,
                                                                 screenshotPNG: shot?.png,
                                                                 previousPNG: showPrevious ? previous : nil,
                                                                 zoom: zoom,
                                                                 canClick: target.canAct,
                                                                 canSee: shot != nil,
                                                                 remote: target.isRemote,
                                                                 model: env.store.settings.claudeModel)
                act = turn.action
                meta = turn.meta
                requestBytes = turn.requestBytes
            }
            recorder?.record(DriveTelemetry.Call(index: step, model: meta?.model ?? Self.modelName(env.store.settings.claudeModel),
                                                 captureMs: captureMs, contextMs: contextMs, brainMs: brainClock.ms,
                                                 modelMs: meta?.modelMs, requestBytes: requestBytes,
                                                 actions: act == nil ? 0 : 1, stopReason: meta?.stopReason, usage: meta?.usage))
            zoom = nil
            previous = shot?.png
            // The user may have taken over while the model was thinking: a pause drops this action, and the
            // next turn looks at the screen again once they hand it back.
            guard session == self.session, !cancelled else { return }
            if env.store.run(run.id)?.status == .paused { continue }
            guard env.store.run(run.id)?.status == .running else { return }
            guard var act else {
                let brain = env.sidecar.status
                finish(success: false, summary: brain.isReady
                       ? "the model didn't answer, so i stopped. try again in a moment."
                       : "the brain isn't running (\(brain.label)), so i stopped. open Settings to restart it.")
                return
            }
            if act.say?.isEmpty ?? true { act.say = fallbackSay(for: act) }

            model.stepText = act.say ?? act.type
            model.stepIndex = step
            model.kind = Self.kind(of: act)
            model.detail = Self.detail(of: act)
            let aim = shot.flatMap { Self.aim(of: act, imageWidth: $0.imageWidth, imageHeight: $0.imageHeight) }
            if let shot, Self.isPointer(act) || act.type == "zoom" {
                model.thumb = NSImage(data: shot.png)
                model.aim = aim
            } else {
                model.aim = nil
            }
            var frameURL: String?
            if let shot {
                frameURL = LiveFrames.shared.put(shot.png, id: "\(run.id)-\(step)")
                RunThumbs.note(shot.png, runID: run.id)
            }
            let scriptSource = ["script", "shell", "applescript", "jxa"].contains(act.type) ? (act.script ?? act.text) : nil
            model.steps.append(LiveStep(index: step, say: act.say ?? act.type, kind: model.kind, detail: model.detail,
                                        result: "", frame: frameURL,
                                        aimX: Self.isPointer(act) || act.type == "zoom" ? aim.map { Double($0.x) } : nil,
                                        aimY: Self.isPointer(act) || act.type == "zoom" ? aim.map { Double($0.y) } : nil,
                                        zoomFrame: nil, script: scriptSource,
                                        status: ["done", "fail", "ask"].contains(act.type) ? "done" : "acting", at: Date()))
            cursor.update(label: "okidoki · \(act.say ?? act.type)")
            env.store.updateRun(run.id) { run in
                run.output += "→ \(act.say ?? act.type)\n"
            }

            if act.type == "done" {
                finish(success: true, summary: act.summary ?? act.say ?? "done")
                return
            }
            if act.type == "ask" {
                ask(act.text ?? act.reason ?? "what should I do next?")
                return
            }
            if act.type == "fail" {
                let reason = act.reason ?? act.summary ?? "i couldn't finish"
                if DrivePolicy.asksForDetail(reason) { ask(reason) } else { finish(success: false, summary: reason) }
                return
            }

            let needsVision = Self.isPointer(act) || act.type == "zoom"
            showPrevious = needsVision || ["type", "key"].contains(act.type)
            if shot == nil, needsVision {
                blindVision += 1
                let result = "no screenshot — use a script, open_app, or key instead"
                history.append(act.dictionary.merging(["result": result]) { current, _ in current })
                env.store.updateRun(run.id) { run in run.output += result + "\n" }
                setStepResult(result)
                if blindVision >= 2 {
                    finish(success: false, summary: ComputerUseError.screenCapture.localizedDescription)
                    return
                }
                continue
            }

            var result: String
            driving = true
            // Clicks aimed under the pill must reach the app, not the pill.
            panel?.ignoresMouseEvents = true
            if act.type == "key", let key = act.key { cursor.showKey(Self.prettyKey(key)) }
            let performClock = Stopwatch()
            do {
                result = try await target.perform(act, screen: box,
                                                  imageWidth: shot?.imageWidth ?? 1, imageHeight: shot?.imageHeight ?? 1)
            } catch {
                guard session == self.session else { return }
                driving = false
                panel?.ignoresMouseEvents = false
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                finish(success: false, summary: message)
                return
            }
            guard session == self.session else { return }
            driving = false
            panel?.ignoresMouseEvents = false
            if ["click", "double_click", "triple_click", "right_click", "middle_click"].contains(act.type),
               !result.hasPrefix("ignored"), !result.hasPrefix("couldn't") {
                cursor.clickRipple()
            }
            if act.type == "zoom", let shot, let x = act.x, let y = act.y {
                zoom = await Task.detached(priority: .userInitiated) {
                    ComputerUseService.zoom(shot, x: x, y: y, width: act.width, height: act.height)
                }.value
                if let zoom {
                    result = String(format: "zoomed into x %.0f–%.0f, y %.0f–%.0f of the screenshot — it's attached to the next turn",
                                    zoom.rect.minX, zoom.rect.maxX, zoom.rect.minY, zoom.rect.maxY)
                    let url = LiveFrames.shared.put(zoom.png, id: "\(run.id)-\(step)-zoom")
                    if let last = model.steps.indices.last { model.steps[last].zoomFrame = url }
                } else {
                    result = "couldn't zoom there"
                }
            }
            history.append(act.dictionary.merging(["result": result]) { current, _ in current })
            setStepResult(result)

            // The same action with the same outcome over and over means the plan is stuck.
            let signature = Self.signature(of: act, result: result)
            recent.append(signature)
            if recent.count > 6 { recent.removeFirst() }
            let repeats = recent.filter { $0 == signature }.count
            if repeats >= 5 {
                finish(success: false, summary: "i kept trying the same thing and it never changed anything, so i stopped.")
                return
            }
            if repeats == 3 {
                history.append(["type": "note", "result": "that exact action has now run 3 times with the same result and nothing changed. do something different: another control, a script, a keyboard shortcut, or fail with the reason."])
            }
            env.store.updateRun(run.id) { run in
                run.output += result + "\n"
                let index = min(history.count - 1, max(0, run.steps.count - 1))
                if run.steps.indices.contains(index) {
                    run.steps[index].status = .done
                }
                if run.steps.indices.contains(index + 1) {
                    run.steps[index + 1].status = .running
                }
            }
            let performMs = performClock.ms
            let pause = pauseAfter(act)
            try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
            recorder?.record(DriveTelemetry.Action(call: step, type: act.type, performMs: performMs,
                                                   settleMs: Int(pause * 1000), ok: !Self.looksFailed(result),
                                                   result: String(result.prefix(200))))
        }
        finish(success: false, summary: "this was taking too many steps — stopping here so you stay in charge.")
    }

    // MARK: Loop v2

    /// The computer use toolset: the model sends a batch of actions, the Mac runs them in order with a
    /// check after each, stops at the first failure, and answers with every result and a fresh screen.
    private func loopV2(run: AgentRun, session: Int) async {
        defer { if session == self.session { cleanupPanels() } }
        guard let env else { return }
        let executor = DriveExecutor(target: target)
        let modelName = Self.modelName(env.store.settings.claudeModel)
        let limits = ComputerUseService.ImageLimits.forModel(modelName)
        let jpeg = (UserDefaults.standard.string(forKey: "drivingImageFormat") ?? "jpeg") != "png"
        let effort = UserDefaults.standard.string(forKey: "drivingEffort") ?? "low"
        let previous = previousRun(for: run)
        var history: [[String: Any]] = []
        var results: [[String: Any]] = []
        var notes: [String] = []
        var recent: [String] = []
        var actionCount = 0
        var failedBatches = 0
        var stillBatches = 0
        var escalations = 0
        var escalate = false
        // Off unless asked for: the chosen model (Haiku 5.5 by default, for speed) drives every turn.
        let maxEscalations = UserDefaults.standard.bool(forKey: "drivingEscalate") ? 3 : 0
        var permissionErrors = 0
        var questionHolds = 0
        var startedSteps = false
        var lastFrame: String?
        let maxCalls = 40
        let maxActions = 120

        for call in 0..<maxCalls {
            guard session == self.session, !cancelled else { return }
            guard await holdWhilePaused(run.id, session: session) else { return }
            model.kind = ""
            model.detail = ""
            if target.showsPointerOverlay, let screen = target.screen() { cursor.show(on: screen, label: "okidoki · thinking") }

            // Look: the capture and the controls scan run at the same time.
            let screen = target.screen()
            let fallback = screen.map { ComputerUseService.cgGlobalRect(for: $0) }
                .map { ScreenBox(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) } ?? ScreenBox(x: 0, y: 0, width: 1, height: 1)
            let expected = screen.map { s -> (Double, Double) in
                let scale = Double(max(s.backingScaleFactor, 1))
                let size = ComputerUseService.sendSize(pixelWidth: Double(s.frame.width) * scale, pixelHeight: Double(s.frame.height) * scale,
                                                       pointWidth: Double(s.frame.width), pointHeight: Double(s.frame.height), limits: limits)
                return (Double(size.width), Double(size.height))
            } ?? (fallback.width, fallback.height)
            let captureClock = Stopwatch()
            async let shotTask = target.captureForDriving(limits: limits, jpeg: jpeg)
            async let contextTask = target.context(box: fallback, imageWidth: expected.0, imageHeight: expected.1)
            let shot = await shotTask
            let captureMs = captureClock.ms
            var context = await contextTask
            let contextMs = captureClock.ms
            if let shot, shot.box != fallback || shot.imageWidth != expected.0 || shot.imageHeight != expected.1 {
                // The display isn't what we predicted (moved to another screen, odd scale): map controls again.
                context = await target.context(box: shot.box, imageWidth: shot.imageWidth, imageHeight: shot.imageHeight)
            }
            executor.observe(shot: shot, context: context, fallback: fallback)
            if let shot { lastFrame = LiveFrames.shared.put(shot.png, id: "\(run.id)-o\(call)") }

            var observation: [String: Any] = [
                "app": context.appName,
                "windowTitle": context.windowTitle,
                "imageWidth": shot?.imageWidth ?? 0,
                "imageHeight": shot?.imageHeight ?? 0,
                "controls": context.controls,
                "scripting": context.scripting,
                "canClick": target.canAct,
                "canSee": shot != nil,
                "notes": notes,
            ]
            if let shot {
                observation["screenshotBase64"] = shot.png.base64EncodedString()
                observation["mediaType"] = shot.mediaType
            }
            var body: [String: Any] = [
                "runID": run.id,
                "goal": run.prompt,
                "step": call,
                "observation": observation,
                "results": results,
                "history": Array(history.suffix(24)),
                "remote": target.isRemote,
                "escalate": escalate,
                "effort": effort,
                "settings": ["claudeModel": env.store.settings.claudeModel],
            ]
            if let previous { body["previous"] = previous }
            if let plan = run.preview?.summary.trimmingCharacters(in: .whitespacesAndNewlines), !plan.isEmpty,
               plan.lowercased() != run.prompt.lowercased() {
                body["plan"] = plan
            }

            // Think and act. Streaming runs each action as soon as the model finishes writing it.
            if !env.sidecar.status.isReady {
                for _ in 0..<16 where !env.sidecar.status.isReady && !cancelled {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            results = []
            notes = []
            var halted = false
            var screenMoved = false
            var batchChanged = false
            var batchFailed = false
            var actedThisBatch = false
            var ended = false
            var handled = 0

            let brainClock = Stopwatch()
            let escalated = escalate
            escalate = false
            var envelope: BrainClient.BrainDriveEnvelope?
            var requestBytes = 0
            var firstActionMs: Int?
            var callRecorded = false
            /// The model request's timings, once: after the turn, or just before a finish ends the run.
            func recordCall() {
                guard !callRecorded else { return }
                callRecorded = true
                recorder?.record(DriveTelemetry.Call(index: call, model: envelope?.meta?.model ?? modelName, captureMs: captureMs,
                                                     contextMs: contextMs, brainMs: brainClock.ms, modelMs: envelope?.meta?.modelMs,
                                                     firstActionMs: firstActionMs ?? envelope?.meta?.firstActionMs, requestBytes: requestBytes,
                                                     actions: handled + (envelope?.actions?.count ?? 0), stopReason: envelope?.meta?.stopReason,
                                                     usage: envelope?.meta?.usage, escalated: escalated))
            }

            /// Runs one action of the batch. False once the run is over.
            func handle(_ act: ComputerAction) async -> Bool {
                guard session == self.session, !cancelled else { ended = true; return false }
                // Paused mid-turn: the rest of this turn was planned against a screen that's now the person's.
                if env.store.run(run.id)?.status == .paused { halted = true; return false }
                guard env.store.run(run.id)?.status == .running else { ended = true; return false }
                handled += 1
                let id = act.toolUseID ?? ""
                if act.type == "done" || act.type == "fail" || act.type == "ask" {
                    if halted || batchFailed {
                        results.append(["id": id, "result": "Not finished: an earlier action in this turn failed — check the new screenshot first.", "isError": true])
                        return true
                    }
                    // A question only the user can answer pauses the run; their reply continues it.
                    let question = act.type == "ask" ? (act.text ?? "") : (act.reason ?? act.summary ?? "")
                    if act.type == "ask" || (act.type == "fail" && DrivePolicy.asksForDetail(question)) {
                        recordCall()
                        ask(question.isEmpty ? "what should I do next?" : question)
                        ended = true
                        return false
                    }
                    // Asking whether to go on isn't a failure: the user asked for the whole task and approved the plan.
                    if act.type == "fail", questionHolds < 2, DrivePolicy.asksToContinue(act.reason ?? act.summary ?? "") {
                        questionHolds += 1
                        results.append(["id": id, "result": "Don't ask — the user already asked for the whole task and approved the plan. Keep going until it's finished. Only finish with success false if something truly blocks you (a sign-in, a payment, a permission prompt, a missing app) or several different approaches have failed.", "isError": true])
                        return true
                    }
                    // Success is only claimed from a screen the model has seen, except when the batch it
                    // planned all worked and visibly landed without replacing the screen (typed and sent,
                    // toggled, filled in). That skips a whole model turn, the usual last 2–3 s of a run.
                    let trustFinish = UserDefaults.standard.object(forKey: "drivingTrustFinish") as? Bool ?? true
                    if act.type == "done", actedThisBatch, !(trustFinish && DrivePolicy.finishLanded(failed: batchFailed, changed: batchChanged, movedALot: screenMoved)) {
                        results.append(["id": id, "result": "Not finished yet: look at the new screenshot first. If it shows the whole task is done (with the result visible), call finish again on its own.", "isError": true])
                        return true
                    }
                    if act.type == "done" {
                        recordCall()
                        finish(success: true, summary: act.summary ?? act.say ?? "done")
                    } else {
                        recordCall()
                        finish(success: false, summary: act.reason ?? act.summary ?? "i couldn't finish")
                    }
                    ended = true
                    return false
                }
                if halted {
                    results.append(["id": id, "result": "", "skipped": true])
                    return true
                }
                if screenMoved && DriveExecutor.aimsAtPixel(act) {
                    let text = "not executed: the screen changed a lot after the earlier action in this turn, so this pixel may point at something else now — aim again using the new screenshot"
                    results.append(["id": id, "result": text, "isError": true])
                    history.append(act.dictionary.merging(["result": text]) { current, _ in current })
                    halted = true
                    return true
                }

                // Show it.
                actionCount += 1
                if !["screenshot", "zoom", "cursor_position", "wait"].contains(act.type) { actedThisBatch = true }
                let say = await executor.narrate(act)
                model.stepText = say
                model.stepIndex = actionCount - 1
                model.kind = Self.kind(of: act)
                model.detail = Self.detail(of: act)
                let aim = executor.aim(of: act)
                let pointing = Self.isPointer(act) || act.type == "zoom" || act.type == "click_element"
                if pointing, let shot { model.thumb = NSImage(data: shot.png); model.aim = aim } else { model.aim = nil }
                let scriptSource = ["script", "shell", "applescript", "jxa"].contains(act.type) ? (act.script ?? act.text) : nil
                model.steps.append(LiveStep(index: actionCount - 1, say: say, kind: model.kind, detail: model.detail, result: "",
                                            frame: lastFrame, aimX: pointing ? aim.map { Double($0.x) } : nil,
                                            aimY: pointing ? aim.map { Double($0.y) } : nil, zoomFrame: nil, script: scriptSource,
                                            status: "acting", at: Date()))
                cursor.update(label: "okidoki · \(say)")
                env.store.updateRun(run.id) { run in run.output += "→ \(say)\n" }
                if act.type == "key", let key = act.key { cursor.showKey(Self.prettyKey(key)) }

                // Do it.
                driving = true
                panel?.ignoresMouseEvents = true
                let outcome = await executor.run(act)
                guard session == self.session else { ended = true; return false }
                driving = false
                panel?.ignoresMouseEvents = false
                if DriveExecutor.clickish.contains(act.type), !outcome.isError { cursor.clickRipple() }

                var result: [String: Any] = ["id": id, "result": outcome.text]
                if outcome.isError { result["isError"] = true }
                if let image = outcome.image {
                    result["imageBase64"] = image.base64EncodedString()
                    result["mediaType"] = "image/png"
                    let url = LiveFrames.shared.put(image, id: "\(run.id)-\(actionCount)-zoom")
                    if let last = model.steps.indices.last { model.steps[last].zoomFrame = url }
                }
                results.append(result)
                var entry = act.dictionary
                entry["result"] = outcome.text
                if entry["type"] as? String == "click_element", let n = act.element,
                   let label = executor.context.elements[n]?.control.label { entry["target"] = label }
                history.append(entry)
                setStepResult(outcome.text)
                // The plan's steps are coarse (get going · do it · hand back): the first one is done once
                // something worked, the middle one runs until the end, and finishing settles the rest.
                let firstWorked = !startedSteps && !outcome.isError
                if firstWorked { startedSteps = true }
                env.store.updateRun(run.id) { run in
                    run.output += outcome.text + "\n"
                    if firstWorked, run.steps.count > 1 {
                        run.steps[0].status = .done
                        run.steps[1].status = .running
                    }
                }
                recorder?.record(DriveTelemetry.Action(call: call, type: act.type, performMs: outcome.performMs,
                                                       settleMs: outcome.settleMs, changed: outcome.change?.changed,
                                                       ok: !outcome.isError, result: String(outcome.text.prefix(200))))

                if outcome.change?.large == true { screenMoved = true }
                if outcome.change?.changed == true { batchChanged = true }
                if outcome.isError { halted = true; batchFailed = true }
                if Self.isPermissionProblem(outcome.text) { permissionErrors += 1 }
                if permissionErrors >= 2 {
                    recordCall()
                    finish(success: false, summary: Self.permissionSummary(outcome.text))
                    ended = true
                    return false
                }

                // The same action with the same outcome over and over means the plan is stuck.
                let signature = Self.signature(of: act, result: outcome.text)
                recent.append(signature)
                if recent.count > 8 { recent.removeFirst() }
                let repeats = recent.filter { $0 == signature }.count
                if repeats >= 5 {
                    recordCall()
                    finish(success: false, summary: "i kept trying the same thing and it never changed anything, so i stopped.")
                    ended = true
                    return false
                }
                if repeats == 3 {
                    notes.append("That exact action has now run 3 times with the same result and nothing changed. Do something different: another control, a script, a keyboard shortcut — or finish with success false and the reason.")
                    escalate = escalations < maxEscalations
                }
                if actionCount >= maxActions {
                    recordCall()
                    finish(success: false, summary: "this was taking too many steps — stopping here so you stay in charge.")
                    ended = true
                    return false
                }
                return true
            }

            let streaming = UserDefaults.standard.object(forKey: "drivingStream") as? Bool ?? true
            for attempt in 0..<2 where !ended && handled == 0 && envelope == nil && env.sidecar.status.isReady {
                if attempt > 0 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
                guard session == self.session, !cancelled else { return }
                if let runID { env.store.countModelCall(runID) }
                if streaming {
                    let streamed = await BrainClient.shared.computerV2Stream(body) { act in
                        if firstActionMs == nil { firstActionMs = brainClock.ms }
                        return await handle(act)
                    }
                    envelope = streamed.end
                    requestBytes = streamed.requestBytes
                } else {
                    let turn = await BrainClient.shared.computerV2(body)
                    envelope = turn.envelope
                    requestBytes = turn.requestBytes
                }
            }
            let rest = envelope?.actions ?? []
            recordCall()
            if ended { return }
            guard session == self.session, !cancelled else { return }
            if env.store.run(run.id)?.status == .paused {
                notes.append("The person paused you and used the Mac; the screen may have changed. Look again before acting.")
                continue
            }
            guard env.store.run(run.id)?.status == .running else { return }
            if envelope?.fallback == "v1" {
                recorder?.setProtocol("v1")
                await loop(run: run, session: session)
                return
            }
            for act in rest where !ended {
                if !(await handle(act)) { break }
            }
            if ended { return }
            if handled == 0 {
                let brain = env.sidecar.status
                finish(success: false, summary: brain.isReady
                       ? "the model didn't answer, so i stopped. try again in a moment."
                       : "the brain isn't running (\(brain.label)), so i stopped. open Settings to restart it.")
                return
            }
            if screenMoved { notes.append("The screen changed a lot during that batch; aim only at what the new screenshot shows.") }

            // A stronger model for one turn when it's going nowhere.
            failedBatches = batchFailed ? failedBatches + 1 : 0
            stillBatches = batchChanged ? 0 : stillBatches + 1
            if escalations < maxEscalations, failedBatches >= 2 || stillBatches >= 2 || escalate {
                escalate = true
                escalations += 1
                failedBatches = 0
                stillBatches = 0
            }
        }
        finish(success: false, summary: "this was taking too many steps — stopping here so you stay in charge.")
    }

    /// The last computer-use run in the same conversation, for "again", "retry" and "continue".
    private func previousRun(for run: AgentRun) -> [String: Any]? {
        guard let env, let thread = run.threadID else { return nil }
        let prior = env.store.runs
            .filter { $0.id != run.id && $0.threadID == thread && $0.kind == .computerUse && $0.endedAt != nil }
            .max { ($0.endedAt ?? .distantPast) < ($1.endedAt ?? .distantPast) }
        guard let prior, let ended = prior.endedAt, Date().timeIntervalSince(ended) < 2 * 3600 else { return nil }
        let steps = prior.output.split(separator: "\n").map(String.init).filter { $0.hasPrefix("→") }.suffix(8)
        var previous: [String: Any] = ["goal": prior.prompt, "summary": prior.summary, "steps": Array(steps)]
        if prior.status == .asked || prior.answer != nil { previous["asked"] = true }
        return previous
    }

    nonisolated static func isPermissionProblem(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("accessibility is off") || lower.contains("not allowed assistive access")
            || lower.contains("not allowed to send keystrokes") || lower.contains("screen recording")
    }

    nonisolated static func permissionSummary(_ text: String) -> String {
        text.lowercased().contains("screen recording")
            ? ComputerUseError.screenCapture.localizedDescription
            : ComputerUseError.accessibility.localizedDescription
    }

    private func setStepResult(_ result: String) {
        guard let last = model.steps.indices.last else { return }
        model.steps[last].result = result
        model.steps[last].status = "done"
    }

    // MARK: Describing steps

    nonisolated static func isPointer(_ act: ComputerAction) -> Bool {
        ["click", "double_click", "triple_click", "right_click", "middle_click", "drag", "move", "scroll"].contains(act.type)
    }

    nonisolated static func kind(of act: ComputerAction) -> String {
        switch act.type {
        case "script", "shell", "applescript", "jxa": return "script"
        case "open_app", "activate", "open_url": return "app"
        case "type", "key": return "keys"
        case "zoom", "wait": return "look"
        case "done", "fail": return ""
        default: return isPointer(act) ? "pointer" : ""
        }
    }

    /// The pill's second line. Scripts show their first meaningful line.
    nonisolated static func detail(of act: ComputerAction) -> String {
        func clip(_ text: String, _ limit: Int = 64) -> String {
            let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
        }
        switch act.type {
        case "script", "shell", "applescript", "jxa":
            let source = act.script ?? act.text ?? ""
            let first = source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
                .first { !$0.isEmpty && !$0.hasPrefix("--") && !$0.hasPrefix("#") } ?? ""
            let lang = ScriptActuator.normalizeLanguage(act.lang ?? (act.type == "shell" ? "shell" : act.type == "jxa" ? "javascript" : nil))
            let tag = lang == "shell" ? "zsh" : lang == "javascript" ? "JXA" : "AppleScript"
            return first.isEmpty ? tag : "\(tag) · \(clip(first, 56))"
        case "type":
            return "typing “\(clip(act.text ?? "", 48))”"
        case "key":
            let times = (act.times ?? 1) > 1 ? " ×\(act.times ?? 1)" : ""
            return prettyKey(act.key ?? "") + times
        case "open_app", "activate":
            return act.app ?? act.text ?? ""
        case "open_url":
            return clip(act.text ?? act.app ?? "", 56)
        case "click", "double_click", "triple_click", "right_click", "middle_click", "move":
            if let target = act.target, !target.isEmpty { return "“\(clip(target, 44))”" }
            if let x = act.x, let y = act.y { return String(format: "at %.0f, %.0f", x, y) }
            return ""
        case "scroll":
            let dy = act.dy ?? 0
            return dy == 0 ? "sideways" : dy > 0 ? "down" : "up"
        case "wait":
            return act.reason ?? ""
        case "zoom":
            return "zooming in"
        default:
            return ""
        }
    }

    nonisolated static func prettyKey(_ combo: String) -> String {
        EventActuator.keyPieces(combo).map { piece -> String in
            switch piece {
            case "cmd": return "⌘"
            case "shift": return "⇧"
            case "opt", "alt": return "⌥"
            case "ctrl": return "⌃"
            case "return", "enter": return "↩"
            case "esc", "escape": return "esc"
            case "tab": return "⇥"
            case "space": return "space"
            case "delete", "backspace": return "⌫"
            case "up": return "↑"
            case "down": return "↓"
            case "left": return "←"
            case "right": return "→"
            default: return piece.count == 1 ? piece.uppercased() : piece
            }
        }.joined(separator: " ")
    }

    nonisolated static func aim(of act: ComputerAction, imageWidth: Double, imageHeight: Double) -> CGPoint? {
        guard imageWidth > 0, imageHeight > 0 else { return nil }
        let x = act.x ?? act.toX ?? act.fromX
        let y = act.y ?? act.toY ?? act.fromY
        guard let x, let y else { return nil }
        return CGPoint(x: min(max(x / imageWidth, 0), 1), y: min(max(y / imageHeight, 0), 1))
    }

    /// The driving model: the saved setting, or Haiku 5.5 when it is empty (the brain's default).
    nonisolated static func modelName(_ configured: String) -> String {
        let name = configured.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "claude-haiku-5-5" : name
    }

    /// Results that mean the action didn't happen.
    nonisolated static func looksFailed(_ result: String) -> Bool {
        let lower = result.lowercased()
        return ["couldn't", "ignored", "unknown ", "script failed", "script not run", "script timed out", "no screenshot",
                "needs x and y", "not executed", "nothing changed", "no app name", "nothing to type", "isn't available",
                "can't do", "a password field has the keyboard", "blocked —"].contains { lower.hasPrefix($0) || lower.contains($0) }
    }

    nonisolated static func signature(of act: ComputerAction, result: String) -> String {
        let bits: [String] = [
            act.type,
            act.x.map { String(Int($0 / 12)) } ?? "", act.y.map { String(Int($0 / 12)) } ?? "",
            act.target ?? "", act.key ?? "", act.app ?? "", act.modifiers ?? "",
            String((act.text ?? act.script ?? "").prefix(60)),
            String(result.prefix(80)),
        ]
        return bits.joined(separator: "|")
    }

    private func pauseAfter(_ act: ComputerAction) -> Double {
        switch act.type {
        case "open_app": return 1.1
        case "activate": return 0.7
        case "open_url": return 0.8
        case "script", "shell", "applescript", "jxa": return 0.7
        case "click": return 0.45
        case "double_click", "triple_click", "right_click", "middle_click": return 0.5
        case "zoom": return 0.05
        case "drag": return 0.45
        case "move": return 0.2
        case "type": return 0.3
        case "key": return 0.35
        case "scroll": return 0.4
        case "wait": return 0.1
        default: return 0.35
        }
    }

    private func fallbackSay(for act: ComputerAction) -> String? {
        switch act.type {
        case "open_app": return "opening \(act.app ?? act.text ?? "the app")"
        case "open_url": return "opening the link"
        case "script", "shell", "applescript", "jxa": return "running a script"
        case "click": return "clicking"
        case "double_click": return "double-clicking"
        case "triple_click": return "triple-clicking"
        case "zoom": return "looking closer"
        case "right_click": return "right-clicking"
        case "middle_click": return "middle-clicking"
        case "move": return "moving"
        case "drag": return "dragging"
        case "type": return "typing"
        case "key": return "pressing \(act.key ?? "a key")"
        case "scroll": return "scrolling"
        case "wait": return "waiting"
        case "done": return "done"
        default: return act.type
        }
    }

    // MARK: Finish / cancel

    private func finish(success: Bool, summary: String) {
        guard let env, let runID else { return }
        if let last = model.steps.indices.last {
            model.steps[last].status = "done"
            if model.steps[last].result.isEmpty { model.steps[last].result = summary }
        }
        recorder?.finish(outcome: success ? "done" : "failed", summary: summary, screen: target.screen())
        recorder = nil
        cleanupPanels()
        if success {
            env.store.finishRun(runID, status: .done, summary: summary)
            if let run = env.store.run(runID), let threadID = run.threadID {
                env.store.appendMessage(threadID: threadID, role: .assistant,
                                        text: "i did it — \(summary)", runID: runID)
            }
            env.toast(title: "done", detail: summary, kind: .success,
                      undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak env] in
                          env?.openDashboard(.runs, runID: runID)
                      }, runID: runID)
            env.speak(summary)
        } else {
            env.store.finishRun(runID, status: .failed, summary: summary)
            if let run = env.store.run(runID), let threadID = run.threadID {
                env.store.appendMessage(threadID: threadID, role: .assistant,
                                        text: "i couldn't finish — \(summary)", runID: runID)
            }
            env.toast(title: "couldn't finish", detail: summary, kind: .warning,
                      undoLabel: nil, onUndo: nil, editLabel: "details", onEdit: { [weak env] in
                          env?.openDashboard(.runs, runID: runID)
                      }, runID: runID)
            env.speak("I couldn't finish. \(summary)")
        }
        env.store.saveNow()
        self.runID = nil
    }

    /// The model needs something only the user knows. The run pauses on the question rather than
    /// failing; the card takes their reply and a new run in the same thread carries on from it.
    private func ask(_ question: String) {
        guard let env, let runID else { return }
        if let last = model.steps.indices.last {
            model.steps[last].status = "done"
            if model.steps[last].result.isEmpty { model.steps[last].result = question }
        }
        recorder?.finish(outcome: "asked", summary: question, screen: target.screen())
        recorder = nil
        cleanupPanels()
        env.store.finishRun(runID, status: .asked, summary: question)
        if let run = env.store.run(runID), let threadID = run.threadID {
            env.store.appendMessage(threadID: threadID, role: .assistant, text: question, runID: runID)
        }
        env.store.saveNow()
        self.runID = nil
        env.presentDriveQuestion(runID: runID, question: question)
    }

    /// Paused (the notch, a script): the Mac is the person's — no pointer, no glow, no keys — until they resume.
    /// True when the run carries on; false when it was stopped or ended meanwhile.
    private func holdWhilePaused(_ runID: String, session: Int) async -> Bool {
        guard let env else { return false }
        guard env.store.run(runID)?.status == .paused else { return env.store.run(runID)?.status == .running }
        EventActuator.stopTyping()
        await EventActuator.releaseHeldButton()
        cursor.hide()
        glow.hide()
        let said = model.stepText
        model.stepText = "paused — the Mac is yours"
        model.kind = ""
        model.detail = "press play in the notch to hand it back"
        // The person needs the keyboard: Escape while paused is theirs, not a stop.
        if let escLocal { NSEvent.removeMonitor(escLocal) }
        if let escGlobal { NSEvent.removeMonitor(escGlobal) }
        escLocal = nil; escGlobal = nil
        restoreOwnWindows()
        while session == self.session, !cancelled, env.store.run(runID)?.status == .paused {
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        guard session == self.session, !cancelled, env.store.run(runID)?.status == .running else { return false }
        model.stepText = said
        model.detail = ""
        if target.stopsOnUserEscape {
            installMonitors()
            clearOwnWindows()
        }
        if target.showsPointerOverlay, let screen = target.screen() {
            cursor.show(on: screen, label: "okidoki · looking")
            glow.show(on: screen)
        }
        env.speak("Got it back.")
        return true
    }

    func cancel(reason: String = "control is yours") {
        EventActuator.stopTyping()
        guard model.visible || runID != nil else { return }
        cancelled = true
        session += 1
        ScriptActuator.cancelRunning()
        let id = runID
        if let last = model.steps.indices.last {
            model.steps[last].status = "done"
            if model.steps[last].result.isEmpty { model.steps[last].result = "stopped — \(reason)" }
        }
        recorder?.finish(outcome: "cancelled", summary: reason, screen: target.screen())
        recorder = nil
        cleanupPanels()
        if let id, let env {
            env.cancelRun(id)
            env.toast(title: "yours again", detail: reason, kind: .info,
                      undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
        }
        runID = nil
    }

    /// okidoki's own windows are left out of every screenshot, so one on top (the dashboard the request was
    /// typed into, say) would take clicks aimed at what the model sees, and keys while okidoki is active.
    /// They step aside for the run, the app underneath gets the focus, and they come back afterwards.
    private func clearOwnWindows() {
        let own = NSApp.windows.filter { $0.isVisible && !($0 is NSPanel) && $0.level == .normal }
        guard !own.isEmpty else { return }
        hiddenWindows = own
        own.forEach { $0.orderOut(nil) }
        guard NSRunningApplication.current.isActive, let pid = Self.appUnderneath(),
              let app = NSRunningApplication(processIdentifier: pid) else { return }
        app.activate()
        AXSearch.raise(pid: pid)
    }

    private func restoreOwnWindows() {
        let windows = hiddenWindows
        hiddenWindows = []
        windows.forEach { $0.orderFront(nil) }
    }

    /// The app whose window is frontmost once okidoki's are out of the way.
    nonisolated static func appUnderneath() -> pid_t? {
        let me = ProcessInfo.processInfo.processIdentifier
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for info in list {
            guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != me,
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: Double],
                  (bounds["Width"] ?? 0) > 200, (bounds["Height"] ?? 0) > 150 else { continue }
            return pid
        }
        return nil
    }

    private func cleanupPanels() {
        Task { await EventActuator.releaseHeldButton() }
        restoreOwnWindows()
        model.visible = false
        panel?.orderOut(nil)
        panel = nil
        cursor.hide()
        glow.hide()
        if let escLocal { NSEvent.removeMonitor(escLocal) }
        if let escGlobal { NSEvent.removeMonitor(escGlobal) }
        escLocal = nil; escGlobal = nil
    }

    private func installMonitors() {
        // Escape pressed by the model (to close a menu, say) must not stop the run.
        escLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
                return nil
            }
            return event
        }
        escGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53, !EventActuator.isSynthetic(event) {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
            }
        }
    }
}

// MARK: - HUD view

struct DriverHUDView: View {
    @ObservedObject var model: DriverModel
    var onStop: () -> Void

    private var icon: String {
        switch model.kind {
        case "script": return "chevron.left.forwardslash.chevron.right"
        case "pointer": return "cursorarrow.click.2"
        case "keys": return "keyboard"
        case "app": return "macwindow"
        case "look": return "eye"
        default: return "sparkle"
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            if let thumb = model.thumb {
                ZStack {
                    Image(nsImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                    if let aim = model.aim {
                        GeometryReader { geo in
                            ZStack {
                                Circle().stroke(Color(hex: 0x1FB57A), lineWidth: 1.5).frame(width: 12, height: 12)
                                Circle().fill(Color(hex: 0x1FB57A)).frame(width: 3, height: 3)
                            }
                            .position(x: aim.x * geo.size.width, y: aim.y * geo.size.height)
                        }
                    }
                }
                .frame(width: 64, height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Color.white.opacity(0.16), lineWidth: 0.5))
            } else {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.85))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.white.opacity(0.1)))
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Driving \(model.targetName) · \(model.stepIndex + 1)")
                        .font(.okBody(11, .medium))
                        .foregroundStyle(Color.white.opacity(0.55))
                    if model.thumb != nil {
                        Image(systemName: icon)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Color.white.opacity(0.55))
                    }
                }
                Text(model.stepText)
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
                if !model.detail.isEmpty {
                    Text(model.detail)
                        .font(.system(size: 10.5, weight: .regular, design: model.kind == "script" ? .monospaced : .default))
                        .foregroundStyle(Color.white.opacity(0.5))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Stop", action: onStop)
                .buttonStyle(.plain)
                .font(.okBody(12, .medium))
                .foregroundStyle(Color.white.opacity(0.72))
        }
        .padding(.horizontal, 14)
        .frame(width: ComputerUseDriver.pillWidth, height: ComputerUseDriver.pillHeight)
        .overlayGlass(cornerRadius: 28, veil: 0.42, tone: .dark)
        .animation(.easeOut(duration: 0.18), value: model.kind)
        .animation(.easeOut(duration: 0.18), value: model.detail)
    }
}
