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
        guard !isActive else { return }
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
                    let wait = min(max(step.delay ?? 0.6, 0.45), 2.5)
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
        let hasApp = !step.app.isEmpty && step.app != "mac" && step.app != "app"
        if action == "switch" {
            guard hasApp else { return nil }
            return await activate(step.app) ? nil : "couldn't open \(step.app)"
        }
        if hasApp, NSWorkspace.shared.frontmostApplication?.localizedName != step.app {
            _ = await activate(step.app)
            try? await Task.sleep(nanoseconds: 450_000_000)
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
            guard let from = await resolvePoint(step), let tx = step.toX, let ty = step.toY else { return "drag has no end point" }
            let to = CGPoint(x: tx, y: ty)
            moveGhost(to: from)
            try? await Task.sleep(nanoseconds: 500_000_000)
            model.clicking = true
            let ok = await offMain { AccessibilityActions.drag(from: from, to: to) }
            moveGhost(to: to)
            try? await Task.sleep(nanoseconds: 300_000_000)
            model.clicking = false
            return ok ? nil : "couldn't drag"
        default:
            guard let point = await resolvePoint(step) else { return "can't find where to click" }
            moveGhost(to: point)
            try? await Task.sleep(nanoseconds: 650_000_000)
            model.clicking = true
            let button = action == "right-click" ? "right" : (action == "middle-click" ? "middle" : "left")
            let count = action == "double-click" ? 2 : 1
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
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) {
            app.activate()
            return true
        }
        return await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", name]
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch {
                return false
            }
        }.value
    }

    // MARK: - Finding the target

    /// Quartz-space point for the step. Order: the recorded spot if the same control is still there,
    /// else an element in the front app whose label matches exactly, else the recorded spot as-is.
    private func resolvePoint(_ step: SkillStep) async -> CGPoint? {
        let recorded = recordedPoint(step)
        let label = targetLabel(step)
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        guard !label.isEmpty, pid != 0, AXIsProcessTrusted() else { return recorded }
        return await Task.detached(priority: .userInitiated) {
            if let recorded, ElementFinder.label(in: pid, at: recorded).caseInsensitiveCompare(label) == .orderedSame {
                return recorded
            }
            if let found = ElementFinder.find(label: label, in: pid, near: recorded) {
                return found
            }
            return recorded
        }.value
    }

    private func targetLabel(_ step: SkillStep) -> String {
        if let label = step.label, !label.isEmpty { return label }
        guard step.action == nil else { return "" }
        // Legacy steps only have the sentence; pull the quoted part out of “…”.
        if let open = step.text.firstIndex(of: "“"), let close = step.text[open...].dropFirst().firstIndex(of: "”") {
            return String(step.text[step.text.index(after: open)..<close])
        }
        return ""
    }

    private func recordedPoint(_ step: SkillStep) -> CGPoint? {
        guard let x = step.x, let y = step.y else { return nil }
        if step.action == nil {
            // Legacy recordings stored AppKit points (bottom-left origin).
            let height = NSScreen.screens.first?.frame.height ?? 0
            return CGPoint(x: x, y: height - y)
        }
        return CGPoint(x: x, y: y)
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
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.escPressed() }
                return nil
            }
            return event
        }
        globalEsc = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
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

// MARK: - Element lookup

/// Accessibility lookups scoped to one app, so the ghost overlay never gets in the way.
enum ElementFinder {
    /// Label of whatever the app has at a Quartz point.
    static func label(in pid: pid_t, at point: CGPoint) -> String {
        let app = AXUIElementCreateApplication(pid)
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &element) == .success,
              let element else { return "" }
        return AccessibilityLabel.of(element)
    }

    /// Centre of the element whose label matches exactly (case-insensitive). When several match,
    /// the one closest to `near` wins. Substring matches are deliberately not accepted.
    static func find(label: String, in pid: pid_t, near: CGPoint?) -> CGPoint? {
        let app = AXUIElementCreateApplication(pid)
        var queue: [AXUIElement] = [app]
        var visited = 0
        var best: (point: CGPoint, distance: Double)?
        while !queue.isEmpty && visited < 3000 {
            let element = queue.removeFirst()
            visited += 1
            if AccessibilityLabel.of(element).caseInsensitiveCompare(label) == .orderedSame, let center = center(of: element) {
                let distance = near.map { hypot(center.x - $0.x, center.y - $0.y) } ?? 0
                if best == nil || distance < best!.distance { best = (center, distance) }
                if near == nil { break }
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120))
            }
        }
        return best?.point
    }

    private static func center(of element: AXUIElement) -> CGPoint? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posValue = posRef, let sizeValue = sizeRef,
              CFGetTypeID(posValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posValue as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        guard size.width > 0, size.height > 0, size.width < 4000, size.height < 4000 else { return nil }
        return CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    }
}
