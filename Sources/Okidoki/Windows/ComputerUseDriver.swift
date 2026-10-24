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
    private var driving = false
    private var escLocal: Any?
    private var escGlobal: Any?
    private var blindVision = 0

    private let service = ComputerUseService.shared

    init(environment: AppEnvironment) { self.env = environment }

    var isActive: Bool { model.visible }

    func begin(run: AgentRun) {
        guard let env, !model.visible else { return }
        runID = run.id
        cancelled = false
        driving = false
        blindVision = 0
        model.goal = run.title
        model.stepText = "looking at the screen"
        model.stepIndex = 0
        model.visible = true

        let screen = service.screenForAction()
        let width: CGFloat = 380
        let height: CGFloat = 48
        let panel = DriverHUDPanel(contentRect: NSRect(x: screen.frame.midX - width / 2,
                                                      y: screen.visibleFrame.minY + 18,
                                                      width: width, height: height),
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
                                                                  onStop: { [weak self] in self?.cancel(reason: "you stopped me") })
            .environmentObject(env))
        panel.orderFrontRegardless()
        self.panel = panel

        installMonitors()
        env.speak("On it. Press escape or stop if you want it back.")
        Task { await loop(run: run, screen: screen) }
    }

    // MARK: Loop

    private func loop(run: AgentRun, screen initialScreen: NSScreen) async {
        defer { cleanupPanels() }
        var history: [[String: Any]] = []
        var recent: [String] = []
        // The screenshot from before the last action, so the model can see what changed.
        var previous: Data?
        var showPrevious = false
        // A magnified crop requested last step, sent alongside the next screenshot.
        var zoom: ComputerUseService.Zoom?
        let maxSteps = 60
        for step in 0..<maxSteps {
            guard !cancelled, let env else { return }
            guard let current = env.store.run(run.id), current.status == .running else { return }
            let screen = service.screenForAction()
            let shot = await service.capture(screen: screen)
            let box = shot?.box ?? ScreenBox(x: 0, y: 0, width: screen.frame.width, height: screen.frame.height)
            let imageWidth = shot?.imageWidth ?? box.width
            let imageHeight = shot?.imageHeight ?? box.height
            async let windowTitle = service.frontWindowTitle()
            async let controls = service.visibleControls(box: box, imageWidth: imageWidth, imageHeight: imageHeight)
            var act: ComputerAction?
            if env.sidecar.status.isReady {
                act = await BrainClient.shared.computer(goal: run.prompt, step: step,
                                                        appName: service.frontmost()?.name ?? "",
                                                        windowTitle: await windowTitle,
                                                        screen: box, imageWidth: shot?.imageWidth ?? 0,
                                                        imageHeight: shot?.imageHeight ?? 0, history: history,
                                                        controls: await controls,
                                                        screenshotPNG: shot?.png,
                                                        previousPNG: showPrevious ? previous : nil,
                                                        zoom: zoom,
                                                        canClick: EventActuator.canPost,
                                                        canSee: shot != nil,
                                                        model: env.store.settings.claudeModel)
            }
            zoom = nil
            previous = shot?.png
            // The user may have taken over while the model was thinking.
            guard !cancelled, env.store.run(run.id)?.status == .running else { return }
            guard var act else {
                finish(success: false, summary: "the model didn't answer, so i stopped. an anthropic key has to be in keys, and the brain has to be running.")
                return
            }
            if act.say?.isEmpty ?? true { act.say = fallbackSay(for: act) }

            model.stepText = act.say ?? act.type
            model.stepIndex = step
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

            let needsVision = ["click", "double_click", "triple_click", "right_click", "middle_click", "drag", "move", "scroll", "zoom"].contains(act.type)
            showPrevious = needsVision || ["type", "key"].contains(act.type)
            if shot == nil, needsVision {
                blindVision += 1
                let result = "no screenshot — use a script, open_app, or key instead"
                history.append(act.dictionary.merging(["result": result]) { current, _ in current })
                env.store.updateRun(run.id) { run in run.output += result + "\n" }
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
            do {
                result = try await service.perform(act, screen: box,
                                                    imageWidth: shot?.imageWidth ?? 1, imageHeight: shot?.imageHeight ?? 1)
            } catch {
                driving = false
                panel?.ignoresMouseEvents = false
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                finish(success: false, summary: message)
                return
            }
            driving = false
            panel?.ignoresMouseEvents = false
            if act.type == "zoom", let shot, let x = act.x, let y = act.y {
                zoom = await Task.detached(priority: .userInitiated) {
                    ComputerUseService.zoom(shot, x: x, y: y, width: act.width, height: act.height)
                }.value
                if let zoom {
                    result = String(format: "zoomed into x %.0f–%.0f, y %.0f–%.0f of the screenshot — it's attached to the next turn",
                                    zoom.rect.minX, zoom.rect.maxX, zoom.rect.minY, zoom.rect.maxY)
                } else {
                    result = "couldn't zoom there"
                }
            }
            history.append(act.dictionary.merging(["result": result]) { current, _ in current })

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
        let id = runID
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

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Driving · \(model.stepIndex + 1)")
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                Text(model.stepText)
                    .font(.okBody(11))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Stop", action: onStop)
                .buttonStyle(.plain)
                .font(.okBody(12, .medium))
                .foregroundStyle(Color.white.opacity(0.72))
        }
        .padding(.horizontal, 16)
        .frame(width: 380, height: 48)
        .overlayGlass(cornerRadius: 24, veil: 0.42, tone: .dark)
    }
}
