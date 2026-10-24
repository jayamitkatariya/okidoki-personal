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
    private var moveMonitor: Any?
    private var anchor = CGPoint.zero

    private let service = ComputerUseService.shared

    init(environment: AppEnvironment) { self.env = environment }

    var isActive: Bool { model.visible }

    func begin(run: AgentRun) {
        guard let env, !model.visible else { return }
        runID = run.id
        cancelled = false
        driving = false
        model.goal = run.title
        model.stepText = "looking at the screen"
        model.stepIndex = 0
        model.visible = true

        let screen = service.screenForAction()
        let width: CGFloat = 380
        let height: CGFloat = 44
        let panel = DriverHUDPanel(contentRect: NSRect(x: screen.frame.midX - width / 2,
                                                      y: screen.visibleFrame.minY + 18,
                                                      width: width, height: height),
                                   styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar + 6
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: DriverHUDView(model: model,
                                                                  onStop: { [weak self] in self?.cancel(reason: "you stopped me") })
            .environmentObject(env))
        panel.orderFrontRegardless()
        self.panel = panel

        anchor = NSEvent.mouseLocation
        installMonitors()
        env.speak("taking over. Move your mouse to stop me.")
        Task { await loop(run: run, screen: screen) }
    }

    // MARK: Loop

    private func loop(run: AgentRun, screen initialScreen: NSScreen) async {
        defer { cleanupPanels() }
        var history: [[String: Any]] = []
        let maxSteps = 40
        for step in 0..<maxSteps {
            guard !cancelled, let env else { return }
            guard let current = env.store.run(run.id), current.status == .running else { return }
            let screen = service.screenForAction()
            guard let shot = service.capture(screen: screen) else {
                finish(success: false, summary: ComputerUseError.screenCapture.localizedDescription)
                return
            }
            var act: ComputerAction?
            if env.sidecar.status.isReady {
                act = await BrainClient.shared.computer(goal: run.prompt, step: step,
                                                        appName: service.frontmost()?.name ?? "",
                                                        screen: shot.box, imageWidth: shot.imageWidth,
                                                        imageHeight: shot.imageHeight, history: history,
                                                        screenshotPNG: shot.png,
                                                        model: env.store.settings.claudeModel)
            }
            if act == nil { act = localPlan(goal: run.prompt, history: history) }
            guard var act else {
                finish(success: false, summary: "the brain is offline — i can't drive apps right now.")
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

            let result: String
            driving = true
            do {
                result = try await service.perform(act, screen: shot.box,
                                                    imageWidth: shot.imageWidth, imageHeight: shot.imageHeight)
            } catch {
                driving = false
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                finish(success: false, summary: message)
                return
            }
            driving = false
            anchor = NSEvent.mouseLocation
            history.append(act.dictionary.merging(["result": result]) { current, _ in current })
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

    private func pauseAfter(_ act: ComputerAction) -> Double {
        switch act.type {
        case "open_app": return 1.4
        case "activate": return 0.9
        case "click": return 0.55
        case "double_click", "right_click": return 0.6
        case "drag": return 0.7
        case "type": return 0.35
        case "key": return 0.45
        case "scroll": return 0.45
        case "wait": return 0.15
        default: return 0.4
        }
    }

    private func fallbackSay(for act: ComputerAction) -> String? {
        switch act.type {
        case "open_app": return "opening \(act.app ?? act.text ?? "the app")"
        case "click": return "clicking"
        case "double_click": return "double-clicking"
        case "right_click": return "right-clicking"
        case "drag": return "dragging"
        case "type": return "typing"
        case "key": return "pressing \(act.key ?? "a key")"
        case "scroll": return "scrolling"
        case "wait": return "waiting"
        case "done": return "done"
        default: return act.type
        }
    }

    /// Keyless / offline fallback: handles plain "open X" goals, otherwise gives up honestly.
    private func localPlan(goal: String, history: [[String: Any]]) -> ComputerAction? {
        if let opened = history.first(where: { ($0["type"] as? String) == "open_app" }) {
            let app = (opened["app"] as? String) ?? (opened["text"] as? String) ?? "the app"
            return ComputerAction(type: "done", summary: "opened \(app)", say: "done")
        }
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = trimmed.range(of: #"^(please\s+)?(open|launch|start)\s+(the\s+)?([\w .+]+?)(\s+app)?[.!?]*$"#,
                                     options: [.regularExpression, .caseInsensitive]) {
            let match = trimmed[range]
            let name = match
                .replacingOccurrences(of: #"^(please\s+)?(open|launch|start)\s+(the\s+)?"#, with: "", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"(\s+app)?[.!?]*$"#, with: "", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                return ComputerAction(type: "open_app", app: name, say: "opening \(name)")
            }
        }
        return ComputerAction(type: "fail",
                              reason: "driving apps end-to-end needs the brain and an Anthropic key. add one in keys and try again.",
                              say: "need a key")
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
        if let moveMonitor { NSEvent.removeMonitor(moveMonitor) }
        escLocal = nil; escGlobal = nil; moveMonitor = nil
    }

    private func installMonitors() {
        escLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
                return nil
            }
            return event
        }
        escGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
            }
        }
        moveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.model.visible, !self.driving else { return }
                let mouse = NSEvent.mouseLocation
                if hypot(mouse.x - self.anchor.x, mouse.y - self.anchor.y) > 14 {
                    self.cancel(reason: "you moved — control is yours")
                }
            }
        }
    }
}

// MARK: - HUD view

struct DriverHUDView: View {
    @ObservedObject var model: DriverModel
    @EnvironmentObject private var env: AppEnvironment
    var onStop: () -> Void
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(Color(hex: 0x1FB57A).opacity(0.2)).frame(width: 20, height: 20)
                    .scaleEffect(pulse ? 1.18 : 0.9)
                    .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
                Image(systemName: "cursorarrow.click.2")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color(hex: 0x1FB57A))
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("okidoki is driving · step \(model.stepIndex + 1)")
                    .font(.okBody(11, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                Text("\(model.stepText) · esc or move your mouse to stop")
                    .font(.okMono(8))
                    .foregroundStyle(Color.white.opacity(0.42))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("stop") { onStop() }
                .buttonStyle(.plain)
                .font(.okMono(9, .semibold))
                .foregroundStyle(Color(hex: 0x1A120E))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Capsule().fill(Color(hex: 0x0F7A5C)))
        }
        .padding(.horizontal, 11)
        .frame(width: 380, height: 42)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(hex: 0x0B0B0C).opacity(0.96))
                .shadow(color: .black.opacity(0.3), radius: 18, y: 7)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(hex: 0x1FB57A).opacity(0.25), lineWidth: 0.8))
        .onAppear { pulse = true }
    }
}
