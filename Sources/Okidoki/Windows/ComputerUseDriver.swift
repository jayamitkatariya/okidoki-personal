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
    private var target: ComputerTarget = LocalComputer()
    private let cursor = DriveCursorController()
    private let glow = EdgeGlowController()

    static let pillWidth: CGFloat = 440
    static let pillHeight: CGFloat = 56

    init(environment: AppEnvironment) { self.env = environment }

    var isActive: Bool { model.visible }

    /// Whether the user's own Escape or shake should stop the current run.
    var stopsOnUserEscape: Bool { model.visible && target.stopsOnUserEscape }

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

        if target.stopsOnUserEscape { installMonitors() }
        if target.showsPointerOverlay {
            cursor.show(on: screen, label: "okidoki · looking")
            glow.show(on: screen)
        }
        env.speak(target.stopsOnUserEscape ? "On it. Press escape or stop if you want it back."
                  : target.isRemote ? "On it, on your private Mac." : "On it, in the background.")
        Task { await loop(run: run, session: current) }
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
            guard let current = env.store.run(run.id), current.status == .running else { return }
            model.kind = ""
            model.detail = ""
            if target.showsPointerOverlay, let screen = target.screen() {
                cursor.show(on: screen, label: "okidoki · thinking")
            }
            let shot = await target.capture()
            let fallbackScreen = target.screen()
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: Double(fallbackScreen?.frame.width ?? 1),
                                             height: Double(fallbackScreen?.frame.height ?? 1))
            let imageWidth = shot?.imageWidth ?? box.width
            let imageHeight = shot?.imageHeight ?? box.height
            let context = await target.context(box: box, imageWidth: imageWidth, imageHeight: imageHeight)
            var act: ComputerAction?
            // Right after launch the brain may still be starting; give it a moment instead of failing.
            if !env.sidecar.status.isReady {
                for _ in 0..<16 where !env.sidecar.status.isReady && !cancelled {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            if env.sidecar.status.isReady {
                act = await BrainClient.shared.computer(goal: run.prompt, step: step,
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
            }
            zoom = nil
            previous = shot?.png
            // The user may have taken over while the model was thinking.
            guard session == self.session, !cancelled, env.store.run(run.id)?.status == .running else { return }
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
            }
            let scriptSource = ["script", "shell", "applescript", "jxa"].contains(act.type) ? (act.script ?? act.text) : nil
            model.steps.append(LiveStep(index: step, say: act.say ?? act.type, kind: model.kind, detail: model.detail,
                                        result: "", frame: frameURL,
                                        aimX: Self.isPointer(act) || act.type == "zoom" ? aim.map { Double($0.x) } : nil,
                                        aimY: Self.isPointer(act) || act.type == "zoom" ? aim.map { Double($0.y) } : nil,
                                        zoomFrame: nil, script: scriptSource,
                                        status: act.type == "done" || act.type == "fail" ? "done" : "acting", at: Date()))
            cursor.update(label: "okidoki · \(act.say ?? act.type)")
            env.store.updateRun(run.id) { run in
                run.output += "→ \(act.say ?? act.type)\n"
            }

            if act.type == "done" {
                finish(success: true, summary: act.summary ?? act.say ?? "done")
                return
            }
            if act.type == "fail" {
                finish(success: false, summary: act.reason ?? act.summary ?? "i couldn't finish")
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
            let pause = pauseAfter(act)
            try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
        }
        finish(success: false, summary: "this was taking too many steps — stopping here so you stay in charge.")
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

    func cancel(reason: String = "control is yours") {
        guard model.visible || runID != nil else { return }
        cancelled = true
        session += 1
        ScriptActuator.cancelRunning()
        let id = runID
        if let last = model.steps.indices.last {
            model.steps[last].status = "done"
            if model.steps[last].result.isEmpty { model.steps[last].result = "stopped — \(reason)" }
        }
        cleanupPanels()
        if let id, let env {
            env.cancelRun(id)
            env.toast(title: "yours again", detail: reason, kind: .info,
                      undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: id)
        }
        runID = nil
    }

    private func cleanupPanels() {
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
