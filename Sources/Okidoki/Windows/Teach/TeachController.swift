import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

// MARK: - Step bookkeeping

/// Something on screen the tutor can name: from accessibility or from on-device OCR.
struct TeachElement: Equatable {
    var id: Int
    var label: String
    var role: String
    /// Quartz global points, origin top-left of the main display.
    var rect: CGRect
    var source: String
}

/// A screenshot and the numbers needed to map between its pixels and the screen.
struct TeachShot: @unchecked Sendable {
    var full: CGImage
    var box: ScreenBox
    var fullWidth: Double
    var fullHeight: Double
    /// Pixels of the downscaled image the model saw.
    var sentWidth: Double
    var sentHeight: Double
    var windowRect: CGRect?

    func global(_ px: Double, _ py: Double) -> CGPoint {
        CGPoint(x: box.x + px / sentWidth * box.width, y: box.y + py / sentHeight * box.height)
    }

    func sentPixels(_ global: CGPoint) -> CGPoint {
        CGPoint(x: (global.x - box.x) / box.width * sentWidth, y: (global.y - box.y) / box.height * sentHeight)
    }

    func sentRect(_ global: CGRect) -> CGRect {
        let origin = sentPixels(global.origin)
        return CGRect(x: origin.x, y: origin.y, width: global.width / pointsPerSentPixelX, height: global.height / pointsPerSentPixelY)
    }

    func fullPixels(_ global: CGPoint) -> CGPoint {
        CGPoint(x: (global.x - box.x) / box.width * fullWidth, y: (global.y - box.y) / box.height * fullHeight)
    }

    func globalFromFull(_ px: CGPoint) -> CGPoint {
        CGPoint(x: box.x + px.x / fullWidth * box.width, y: box.y + px.y / fullHeight * box.height)
    }

    var pointsPerSentPixelX: Double { box.width / sentWidth }
    var pointsPerSentPixelY: Double { box.height / sentHeight }
    var fullPixelsPerPoint: Double { fullWidth / box.width }
}

struct TeachShownStep: Equatable {
    var id = UUID()
    var live: TeachLiveStep
    var number: Int
    var scene: TeachScene?
    /// Quartz global rect that counts as "on the target" for a click.
    var hitRect: CGRect?
    var dragTo: CGPoint?
    /// Global center, for "do it for me".
    var actGlobal: CGPoint?
    var actFrom: CGPoint?
    var retry: Bool
    var snapped: Bool
}

// MARK: - Panels

final class TeachPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Never key: the learner's next keystroke has to reach their app, not this bar.
final class TeachControlPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Controller

/// A live tutor. Each turn it looks at the real screen, asks the model for one step, draws it,
/// then watches what the learner does before looking again. The learner is the hands; the lesson
/// moves on by itself the moment a step lands. Nothing to press — esc stops.
@MainActor
final class TeachController {
    let model = TeachModel()
    private weak var env: AppEnvironment?
    private var stagePanel: TeachPanel?
    private var barPanel: TeachControlPanel?
    private var stage: TeachStageView?
    private var bubbleHost: NSHostingView<AnyView>?
    private var screen: NSScreen?
    private var targetApp: NSRunningApplication?
    private var outline: [String] = []
    private var log: [TeachLogEntry] = []
    private var generation = 0
    private var monitors: [Any] = []
    private var appObserver: NSObjectProtocol?
    private var spaceObserver: NSObjectProtocol?
    private var resignObserver: NSObjectProtocol?
    private var pendingVerify: DispatchWorkItem?
    private var idleWork: [DispatchWorkItem] = []
    private var followTimer: Timer?
    private var scrollSettle: DispatchWorkItem?
    private var mouseDownAt: CGPoint?
    private var typedCount = 0
    private var performingForThem = false
    private var lastShot: TeachShot?
    private var elements: [TeachElement] = []
    private var stepsShown = 0
    private var cleanHits = 0
    private var doItInARow = 0
    private var modelRetries = 0
    private var confirmContinuation: CheckedContinuation<Bool, Never>?
    private var current: TeachShownStep?
    private var askingQuestion = false
    private var practiceRound = false
    private var lab: TeachLab?
    private var lastPointerUpdate: TimeInterval = 0

    private static let barSize = CGSize(width: TeachBarView.width, height: 56)

    init(environment: AppEnvironment) { self.env = environment }

    var isActive: Bool { model.isActive }

    // MARK: Entry points

    /// Legacy string-steps entry (skills, canned library). The steps become the outline.
    func start(topic: String, steps: [String], runID: String?, threadID: String?) {
        start(topic: topic, outline: steps, appBundleID: "", requestText: "", runID: runID, threadID: threadID)
    }

    func start(topic: String, outline: [String], appBundleID: String, requestText: String, runID: String?, threadID: String?,
               mode forced: TeachMode? = nil) {
        if model.isActive { stop(completed: false, quiet: true) }
        guard let env else { return }
        self.outline = outline.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        log = []
        stepsShown = 0
        cleanHits = 0
        doItInARow = 0
        modelRetries = 0
        lastShot = nil
        elements = []
        typedCount = 0
        mouseDownAt = nil
        performingForThem = false
        askingQuestion = false
        practiceRound = false
        current = nil

        targetApp = resolveApp(bundleID: appBundleID)
        if let app = targetApp, !app.isActive { app.activate(options: []) }

        model.topic = topic
        model.appName = targetApp?.localizedName ?? "your screen"
        model.say = ""
        model.why = ""
        model.hint = ""
        model.stepNumber = 0
        model.remaining = nil
        model.milestones = []
        model.milestone = 0
        model.stuck = false
        model.provisional = false
        model.summary = ""
        model.offerPractice = false
        model.runID = runID
        model.threadID = threadID
        model.voice = env.store.settings.teachVoice
        model.mode = forced ?? .guide
        model.phase = .looking
        model.isActive = true

        let screen = screenFor(app: targetApp)
        self.screen = screen
        buildPanels(on: screen)
        stagePanel?.orderFrontRegardless()
        barPanel?.orderFrontRegardless()
        installMonitors()
        requestStep(after: 0.2, settle: false)
    }

    private func resolveApp(bundleID: String) -> NSRunningApplication? {
        let own = Bundle.main.bundleIdentifier
        if !bundleID.isEmpty, bundleID != own,
           let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleID && !$0.isTerminated }) {
            return app
        }
        if let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier != own {
            return front
        }
        return nil
    }

    private func screenFor(app: NSRunningApplication?) -> NSScreen {
        if let pid = app?.processIdentifier, let window = TeachGeometry.frontWindowGlobal(pid: pid) {
            let center = CGPoint(x: window.midX, y: window.midY)
            if let screen = NSScreen.screens.first(where: { TeachGeometry.quartzRect(of: $0).contains(center) }) {
                return screen
            }
        }
        return NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.okidokiPrimary
    }

    private var accent: NSColor {
        NSColor(Color(hexString: env?.store.settings.drawingColorHex ?? "", fallback: 0x44E45E))
    }

    private func buildPanels(on screen: NSScreen) {
        closePanels()
        guard let env else { return }
        let panel = TeachPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 3
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Panels hide themselves when the app deactivates by default, and a lesson deactivates
        // okidoki the moment it brings the learner's app forward. Stay put.
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        // Hidden from screenshots so the model never sees its own rings; the lab (and a scripted
        // test run with OKIDOKI_TEACH_CAPTURE=1) keeps them visible to check the visuals.
        panel.sharingType = capturable ? .readOnly : .none
        panel.isReleasedWhenClosed = false
        let stage = TeachStageView(frame: NSRect(origin: .zero, size: screen.frame.size))
        stage.accent = accent
        panel.contentView = stage
        panel.setFrame(screen.frame, display: false)
        stagePanel = panel
        self.stage = stage

        let bubble = NSHostingView(rootView: AnyView(TeachBubbleView(model: model, accent: Color(accent)).environmentObject(env)))
        bubble.sizingOptions = [.intrinsicContentSize]
        bubbleHost = bubble

        let size = Self.barSize
        let bar = TeachControlPanel(contentRect: NSRect(x: screen.frame.midX - size.width / 2, y: screen.visibleFrame.minY + 22,
                                                        width: size.width, height: size.height),
                                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        bar.isOpaque = false
        bar.backgroundColor = .clear
        bar.hasShadow = false
        bar.level = .statusBar + 4
        bar.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        bar.hidesOnDeactivate = false
        bar.sharingType = capturable ? .readOnly : .none
        bar.isReleasedWhenClosed = false
        let view = TeachBarView(
            model: model,
            accent: Color(accent),
            onConfirm: { [weak self] in self?.resolveConfirm(true) },
            onSkip: { [weak self] in self?.resolveConfirm(false) },
            onVoice: { [weak self] in self?.toggleVoice() },
            onPractice: { [weak self] in self?.startPractice() },
            onStop: { [weak self] in self?.stop(completed: self?.model.phase == .done) }
        )
        .environmentObject(env)
        .environment(\.colorScheme, .dark)
        // First-mouse hosting: the panel is never key while you work in your app, and a plain
        // NSHostingView swallowed the first click on the buttons.
        bar.contentView = OverlayHostingView(rootView: view)
        barPanel = bar
    }

    // MARK: Loop

    /// Look at the screen and ask for the next step. `settle` waits for the app to stop changing first.
    private func requestStep(after delay: Double, settle: Bool) {
        guard model.isActive, let env else { return }
        generation += 1
        let gen = generation
        pendingVerify?.cancel()
        pendingVerify = nil
        clearIdle()
        stopFollowing()
        model.phase = .looking
        model.stuck = false
        model.hint = stepsShown == 0 ? "looking at \(model.appName)…" : "checking…"
        stage?.setThinking(true)
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            guard gen == self.generation, self.model.isActive else { return }
            let screen = self.screen ?? NSScreen.okidokiPrimary
            let pid = self.targetApp?.processIdentifier
            let bounds = TeachGeometry.quartzRect(of: screen)
            let windowRect = pid.flatMap { TeachGeometry.frontWindowGlobal(pid: $0) }

            // In a browser the lesson is about the site, so the tutor is told which tab is in front.
            async let page = BrowserContext.current(app: self.targetApp)
            async let inventory: [AXSeenControl] = Task.detached(priority: .userInitiated) {
                guard let pid else { return [] }
                return AXInventory.controls(pid: pid, within: bounds, limit: 110)
            }.value
            guard var captured = await ComputerUseService.shared.capture(screen: screen) else {
                guard gen == self.generation else { return }
                self.model.phase = .waiting
                self.model.hint = "i can't see the screen — allow screen recording for okidoki"
                self.stage?.setThinking(false)
                return
            }
            if settle {
                // Two frames that agree mean the app has finished repainting after what they did.
                var tries = 0
                var previous = TeachImage.settleHash(captured.full)
                while tries < 3 {
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    guard gen == self.generation, self.model.isActive else { return }
                    guard let again = await ComputerUseService.shared.capture(screen: screen) else { break }
                    let hash = TeachImage.settleHash(again.full)
                    captured = again
                    if TeachImage.hammingDistance(previous, hash) <= 3 { break }
                    previous = hash
                    tries += 1
                }
            }
            let found = await inventory
            guard gen == self.generation, self.model.isActive else { return }

            let fit = ImageFit.tier(for: env.store.settings.claudeModel)
            let prepared = await Task.detached(priority: .userInitiated) { () -> (shot: TeachShot, elements: [TeachElement], base64: String)? in
                let fullW = captured.full.width
                let fullH = captured.full.height
                let size = fit.resized(width: fullW, height: fullH, longEdgeCap: 2000)
                let shot = TeachShot(full: captured.full, box: captured.box, fullWidth: Double(fullW), fullHeight: Double(fullH),
                                     sentWidth: Double(size.width), sentHeight: Double(size.height), windowRect: windowRect)
                let words = await TeachImage.recognizeText(in: captured.full, fast: true)
                var list: [TeachElement] = []
                for control in found {
                    list.append(TeachElement(id: list.count, label: control.label, role: control.role, rect: control.rect, source: "ax"))
                }
                for word in words where list.count < 120 {
                    let origin = shot.globalFromFull(word.rect.origin)
                    let rect = CGRect(x: origin.x, y: origin.y, width: word.rect.width / shot.fullPixelsPerPoint, height: word.rect.height / shot.fullPixelsPerPoint)
                    guard bounds.contains(CGPoint(x: rect.midX, y: rect.midY)) else { continue }
                    let covered = list.contains { existing in
                        existing.rect.insetBy(dx: -4, dy: -4).contains(CGPoint(x: rect.midX, y: rect.midY))
                            && existing.label.lowercased() == word.text.lowercased()
                    }
                    if covered { continue }
                    list.append(TeachElement(id: list.count, label: word.text, role: "text", rect: rect, source: "ocr"))
                }
                guard let scaled = TeachImage.scaled(captured.full, to: size) else { return nil }
                let markers = list.map { TeachImage.Marker(id: $0.id, rect: shot.sentRect($0.rect)) }
                let marked = TeachImage.drawMarkers(on: scaled, markers: markers) ?? scaled
                guard let png = TeachImage.png(marked) else { return nil }
                return (shot, list, png.base64EncodedString())
            }.value
            guard gen == self.generation, self.model.isActive, let prepared else { return }
            self.lastShot = prepared.shot
            self.elements = prepared.elements
            self.stage?.setScreenshot(prepared.shot.full, pixelsPerPoint: prepared.shot.fullPixelsPerPoint)

            let app = self.currentAppName()
            self.model.appName = app
            let hints = prepared.elements.map { element -> TeachControlHint in
                let r = prepared.shot.sentRect(element.rect)
                return TeachControlHint(id: element.id, label: element.label, role: element.role,
                                        x: r.midX.rounded(), y: r.midY.rounded(), w: r.width.rounded(), h: r.height.rounded())
            }
            let known = env.store.memories.map(\.text).filter { $0.lowercased().contains("knows ") && $0.lowercased().contains(app.lowercased()) }
            let pageInfo = await page
            guard gen == self.generation, self.model.isActive else { return }
            let request = TeachStepRequest(topic: self.model.topic, app: app, outline: self.outline,
                                           log: Array(self.log.suffix(14)), stepNumber: self.stepsShown + 1,
                                           imageWidth: prepared.shot.sentWidth, imageHeight: prepared.shot.sentHeight,
                                           screenshotBase64: prepared.base64, controls: hints,
                                           mode: self.model.mode.rawValue, known: Array(known.prefix(12)),
                                           milestones: self.model.milestones, language: Self.language(),
                                           model: env.store.settings.claudeModel,
                                           pageTitle: pageInfo?.title, pageURL: pageInfo?.url)
            let step = await self.stepProvider(request)
            guard gen == self.generation, self.model.isActive else { return }
            guard let step else {
                self.retryAfterSilence()
                return
            }
            self.modelRetries = 0
            if step.waiting, self.stepsShown < 40 {
                self.model.say = step.say.isEmpty ? "waiting for it to load…" : step.say
                self.model.hint = "waiting for the screen"
                self.requestStep(after: 0.9, settle: true)
                return
            }
            self.apply(step)
        }
    }

    /// No answer from the model: try again on our own, backing off, so nobody has to press anything.
    private func retryAfterSilence() {
        modelRetries += 1
        if modelRetries <= 3 {
            model.hint = "one sec — asking again"
            requestStep(after: [1.0, 2.0, 4.0][modelRetries - 1], settle: false)
            return
        }
        model.phase = .waiting
        model.hint = "i couldn't reach the model — say \"next\" to retry, or esc to stop"
        stage?.setThinking(false)
    }

    /// The model behind each step; the lab swaps in scripted steps.
    private func stepProvider(_ request: TeachStepRequest) async -> TeachLiveStep? {
        if let lab { return lab.next(for: request, elements: elements, shot: lastShot) }
        return await env?.teachStep(request)
    }

    private static func language() -> String? {
        let code = Locale.preferredLanguages.first ?? "en"
        guard !code.hasPrefix("en") else { return nil }
        return Locale.current.localizedString(forLanguageCode: String(code.prefix(2))) ?? code
    }

    private func apply(_ step: TeachLiveStep) {
        if step.action == "done" {
            finish(summary: step.summary ?? step.say, say: step.say)
            return
        }
        let retry = !step.previousDone && !log.isEmpty
        if retry { cleanHits = 0 } else { stepsShown += 1 }
        log.append(TeachLogEntry(say: step.say, action: step.action, label: step.label, outcome: ""))
        if let milestones = step.milestones, !milestones.isEmpty, model.milestones.isEmpty {
            model.milestones = milestones
        }
        if let milestone = step.milestone { model.milestone = max(0, min(max(0, model.milestones.count - 1), milestone)) }

        let resolved = resolve(step)
        let shown = TeachShownStep(live: step, number: stepsShown, scene: resolved.scene, hitRect: resolved.hit,
                                   dragTo: resolved.dragTo, actGlobal: resolved.actGlobal, actFrom: resolved.actFrom,
                                   retry: retry, snapped: resolved.snapped)
        typedCount = 0
        mouseDownAt = nil
        current = shown

        withAnimation(OKMotion.spring) {
            model.say = step.say
            model.why = step.why ?? ""
            model.stepNumber = stepsShown
            model.remaining = step.remaining
            model.phase = .waiting
            model.stuck = false
            model.provisional = false
            model.hint = retry ? "not quite — try this" : Self.hint(for: step, mode: model.mode)
        }
        stage?.setThinking(false)
        stage?.present(resolved.scene, animated: true)
        placeBubble(animated: true)
        if model.mode == .guide, let scene = resolved.scene, scene.hasTarget, step.isPointerStep || step.action == "drag" {
            showGuide(to: scene)
        }
        speak(step.say)
        armIdle()
        startFollowing()
        if let scene = resolved.scene, !shown.snapped, scene.kind == "ring", step.hasPoint, step.element == nil {
            refine(shown)
        }

        if lab != nil {
            // The lab only looks: scenes advance on their own and never act in the real app.
            let id = shown.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.current?.id == id, self.model.isActive else { return }
                self.setOutcome("lab: next scene")
                self.requestStep(after: 0.1, settle: false)
            }
            return
        }
        if step.action == "look" {
            armLookDwell()
        } else if step.action == "open_app", let app = step.app, !app.isEmpty {
            // Bringing the right app forward isn't the lesson; do it so the real first step can start.
            let id = shown.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                guard let self, self.current?.id == id, self.model.phase == .waiting, !self.performingForThem else { return }
                Task { await self.perform(shown, narrated: "okidoki brought it forward") }
            }
        }
    }

    private static func hint(for step: TeachLiveStep, mode: TeachMode) -> String {
        if mode == .practice { return "your turn" }
        switch step.action {
        case "click": return "your move — click it"
        case "double_click": return "double-click it"
        case "right_click": return "right-click it"
        case "drag": return "drag it over"
        case "type": return "type it in"
        case "key": return "press it"
        case "scroll": return "scroll there"
        case "open_app": return "open it"
        default: return "take a look"
        }
    }

    private func placeBubble(animated: Bool) {
        guard let stage, let bubbleHost else { return }
        model.hasBubble = true
        stage.placeBubble(bubbleHost, near: current?.scene, animated: animated)
    }

    private func showGuide(to scene: TeachScene) {
        guard let screen else { return }
        let from = TeachGeometry.local(TeachGeometry.quartz(NSEvent.mouseLocation), on: screen)
        let to = scene.kind == "arrow" ? scene.from : scene.center
        guard hypot(to.x - from.x, to.y - from.y) > 140 else { return }
        stage?.showGuide(from: from, to: to)
    }

    private func speak(_ text: String) {
        guard let env, model.voice, !text.isEmpty else { return }
        guard !env.store.settings.quietMode else { return }
        env.speaker.speak(text, voiceID: env.store.settings.voiceID, speed: env.store.settings.voiceSpeed)
    }

    /// A "look" step has nothing to do; hold long enough to hear it, then move on.
    private func armLookDwell() {
        let gen = generation
        let words = model.say.split { $0.isWhitespace }.count
        let dwell = min(12, max(3.5, Double(words) * 0.38 + 2.2))
        DispatchQueue.main.asyncAfter(deadline: .now() + dwell) { [weak self] in
            guard let self, gen == self.generation, self.model.isActive, self.model.phase == .waiting,
                  self.current?.live.action == "look" else { return }
            self.setOutcome("they had a look")
            self.requestStep(after: 0.1, settle: false)
        }
    }

    /// Nobody likes being rushed, but a long silence means they're lost. First show the move
    /// (a ghost cursor walks from their pointer to the ring), then ask the model for a smaller step.
    private func armIdle() {
        clearIdle()
        guard let step = current, step.live.action != "look" else { return }
        let id = step.id
        let show = DispatchWorkItem { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .waiting, self.current?.id == id,
                  self.log.last?.outcome.isEmpty ?? false else { return }
            withAnimation(OKMotion.spring) {
                self.model.stuck = true
                if step.scene?.hasTarget == true { self.model.hint = "it's right here" }
            }
            self.pantomime(step)
        }
        let nudge = DispatchWorkItem { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .waiting, self.current?.id == id,
                  self.log.last?.outcome.isEmpty ?? false else { return }
            self.setOutcome("nothing yet after 20 seconds — they seem stuck; make it smaller and point again")
            self.requestStep(after: 0.1, settle: false)
        }
        idleWork = [show, nudge]
        DispatchQueue.main.asyncAfter(deadline: .now() + 9, execute: show)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: nudge)
    }

    /// Walk a ghost cursor from where their pointer is to the target, once.
    private func pantomime(_ shown: TeachShownStep) {
        guard let scene = shown.scene, scene.hasTarget, let screen else { return }
        let from = TeachGeometry.local(TeachGeometry.quartz(NSEvent.mouseLocation), on: screen)
        stage?.demoGhostOnce(to: scene.kind == "arrow" ? scene.from : scene.center, from: from)
        showGuide(to: scene)
    }

    private func clearIdle() {
        for work in idleWork { work.cancel() }
        idleWork = []
    }

    private func currentAppName() -> String {
        let front = NSWorkspace.shared.frontmostApplication
        if let front, front.bundleIdentifier != Bundle.main.bundleIdentifier {
            targetApp = front
            return front.localizedName ?? "the app"
        }
        return targetApp?.localizedName ?? "the app"
    }

    // MARK: Pointing

    private struct Resolution {
        var scene: TeachScene?
        var hit: CGRect?
        var dragTo: CGPoint?
        var actGlobal: CGPoint?
        var actFrom: CGPoint?
        var snapped: Bool
    }

    private func elementRect(_ id: Int?) -> CGRect? {
        guard let id, elements.indices.contains(id) else { return nil }
        return elements[id].rect
    }

    private func resolve(_ step: TeachLiveStep) -> Resolution {
        guard let screen, let shot = lastShot, shot.sentWidth > 0, shot.sentHeight > 0 else {
            return Resolution(scene: nil, hit: nil, dragTo: nil, actGlobal: nil, actFrom: nil, snapped: false)
        }
        let keys = step.action == "key" ? TeachKeys.caps(step.key) : []
        let also = alsoRegion(step, shot: shot, screen: screen)
        let drawings = step.annotations.compactMap { drawing($0, shot: shot, screen: screen) }

        if step.action == "drag" {
            var from: CGPoint? = nil
            if let fx = step.fromX, let fy = step.fromY { from = shot.global(fx, fy) }
            var to: CGPoint? = nil
            if let rect = elementRect(step.toElement) { to = CGPoint(x: rect.midX, y: rect.midY) }
            else if let tx = step.toX, let ty = step.toY { to = shot.global(tx, ty) }
            guard let from, let to else {
                return Resolution(scene: nil, hit: nil, dragTo: nil, actGlobal: nil, actFrom: nil, snapped: false)
            }
            var start = from
            if let snapped = TeachGeometry.snap(center: from, target: nil, pid: nil, elements: elements, screen: screen, region: false) {
                start = CGPoint(x: snapped.midX, y: snapped.midY)
            }
            var end = to
            if step.toElement == nil,
               let snapped = TeachGeometry.snap(center: to, target: step.target, pid: nil, elements: elements, screen: screen, region: false),
               hypot(snapped.midX - to.x, snapped.midY - to.y) < 60 {
                end = CGPoint(x: snapped.midX, y: snapped.midY)
            }
            let scene = TeachScene(kind: "arrow", from: TeachGeometry.local(start, on: screen), to: TeachGeometry.local(end, on: screen),
                                   label: step.label, keys: keys, also: also.rect, alsoLabel: also.label, drawings: drawings)
            let hit = CGRect(x: end.x - 60, y: end.y - 60, width: 120, height: 120)
            return Resolution(scene: scene, hit: hit, dragTo: end, actGlobal: end, actFrom: start, snapped: true)
        }

        var rect: CGRect
        var snapped = false
        let region = (step.w ?? 0) > 0 && (step.h ?? 0) > 0
        if let fromElement = elementRect(step.element) {
            rect = fromElement
            snapped = true
        } else if let x = step.x, let y = step.y {
            let center = shot.global(x, y)
            if region, let w = step.w, let h = step.h {
                rect = CGRect(x: center.x - w * shot.pointsPerSentPixelX / 2, y: center.y - h * shot.pointsPerSentPixelY / 2,
                              width: w * shot.pointsPerSentPixelX, height: h * shot.pointsPerSentPixelY)
            } else {
                rect = CGRect(x: center.x - 20, y: center.y - 20, width: 40, height: 40)
            }
            if let exact = TeachGeometry.snap(center: center, target: step.target, pid: targetApp?.processIdentifier,
                                              elements: elements, screen: screen, region: region) {
                rect = exact
                snapped = true
            } else if !region, let box = TeachImage.iconSnap(in: shot.full, around: shot.fullPixels(center), maxSize: 96 * shot.fullPixelsPerPoint) {
                let origin = shot.globalFromFull(box.origin)
                rect = CGRect(x: origin.x, y: origin.y, width: box.width / shot.fullPixelsPerPoint, height: box.height / shot.fullPixelsPerPoint)
                snapped = true
            }
        } else if let alsoRect = also.rect {
            let scene = TeachScene(kind: "box", rect: alsoRect, from: CGPoint(x: alsoRect.midX, y: alsoRect.midY),
                                   label: also.label ?? step.label, keys: keys, drawings: drawings)
            return Resolution(scene: scene, hit: nil, dragTo: nil, actGlobal: nil, actFrom: nil, snapped: true)
        } else if !drawings.isEmpty || !keys.isEmpty {
            let scene = TeachScene(kind: "none", label: step.label, keys: keys, drawings: drawings)
            return Resolution(scene: scene, hit: nil, dragTo: nil, actGlobal: nil, actFrom: nil, snapped: true)
        } else {
            return Resolution(scene: nil, hit: nil, dragTo: nil, actGlobal: nil, actFrom: nil, snapped: false)
        }
        let built = buildScene(rect: rect, region: region, screen: screen, label: step.label, keys: keys, also: also, drawings: drawings)
        return Resolution(scene: built.scene, hit: built.hit, dragTo: nil, actGlobal: CGPoint(x: rect.midX, y: rect.midY),
                          actFrom: nil, snapped: snapped)
    }

    private func buildScene(rect: CGRect, region: Bool, screen: NSScreen, label: String?, keys: [String],
                            also: (rect: CGRect?, label: String?), drawings: [TeachDrawing]) -> (scene: TeachScene?, hit: CGRect?) {
        let screenArea = screen.frame.width * screen.frame.height
        let isBox = rect.width * rect.height > 160 * 90 || region
        guard rect.width * rect.height < screenArea * 0.6 else { return (nil, nil) }
        let pad: CGFloat = isBox ? 6 : 10
        var drawn = rect.insetBy(dx: -pad, dy: -pad)
        if !isBox {
            let side = max(50, max(drawn.width, drawn.height))
            if drawn.width < 50 || drawn.height < 50 {
                drawn = CGRect(x: drawn.midX - side / 2, y: drawn.midY - side / 2, width: side, height: side)
            }
        }
        var hit = rect.insetBy(dx: -14, dy: -14)
        if hit.width < 44 || hit.height < 44 {
            let side = max(44, max(hit.width, hit.height))
            hit = CGRect(x: hit.midX - side / 2, y: hit.midY - side / 2, width: side, height: side)
        }
        let scene = TeachScene(kind: isBox ? "box" : "ring", rect: TeachGeometry.local(drawn, on: screen),
                               from: TeachGeometry.local(CGPoint(x: rect.midX, y: rect.midY), on: screen), to: nil,
                               label: label, keys: keys, also: also.rect, alsoLabel: also.label, drawings: drawings)
        return (scene, hit)
    }

    private func alsoRegion(_ step: TeachLiveStep, shot: TeachShot, screen: NSScreen) -> (rect: CGRect?, label: String?) {
        guard let ax = step.alsoX, let ay = step.alsoY, let aw = step.alsoW, let ah = step.alsoH, aw > 0, ah > 0 else {
            return (nil, nil)
        }
        let center = shot.global(ax, ay)
        let rect = CGRect(x: center.x - aw * shot.pointsPerSentPixelX / 2, y: center.y - ah * shot.pointsPerSentPixelY / 2,
                          width: aw * shot.pointsPerSentPixelX, height: ah * shot.pointsPerSentPixelY)
        guard rect.width * rect.height < screen.frame.width * screen.frame.height * 0.5 else { return (nil, nil) }
        return (TeachGeometry.local(rect.insetBy(dx: -4, dy: -4), on: screen), step.alsoLabel)
    }

    private func drawing(_ a: TeachAnnotation, shot: TeachShot, screen: NSScreen) -> TeachDrawing? {
        var rect: CGRect?
        if let fromElement = elementRect(a.element) {
            rect = fromElement
        } else if let x = a.x, let y = a.y {
            let center = shot.global(x, y)
            if let w = a.w, let h = a.h, w > 0, h > 0 {
                rect = CGRect(x: center.x - w * shot.pointsPerSentPixelX / 2, y: center.y - h * shot.pointsPerSentPixelY / 2,
                              width: w * shot.pointsPerSentPixelX, height: h * shot.pointsPerSentPixelY)
            } else {
                rect = CGRect(x: center.x - 12, y: center.y - 12, width: 24, height: 24)
            }
        }
        let to: CGPoint? = {
            guard let tx = a.toX, let ty = a.toY else { return nil }
            return TeachGeometry.local(shot.global(tx, ty), on: screen)
        }()
        switch a.kind {
        case "ghost":
            return TeachDrawing(kind: "ghost", rect: .zero, to: nil, text: nil, n: nil)
        case "typing":
            guard let text = a.text, !text.isEmpty else { return nil }
            let anchor = rect ?? current?.scene?.rect ?? CGRect(x: screen.frame.width / 2, y: screen.frame.height / 2, width: 1, height: 1)
            return TeachDrawing(kind: "typing", rect: rect.map { TeachGeometry.local($0, on: screen) } ?? anchor, to: nil, text: text, n: nil)
        default:
            guard let rect else { return nil }
            let local = TeachGeometry.local(rect, on: screen)
            guard local.width * local.height < screen.frame.width * screen.frame.height * 0.7 else { return nil }
            return TeachDrawing(kind: a.kind, rect: local, to: to, text: a.text, n: a.n)
        }
    }

    /// Accessibility and the icon snap both passed, so take a zoomed second look and glide the ring onto it.
    private func refine(_ shown: TeachShownStep) {
        guard let env, let shot = lastShot, let screen, let x = shown.live.x, let y = shown.live.y else { return }
        let gen = generation
        let center = shot.global(x, y)
        let cropPoints = CGSize(width: 340, height: 230)
        let ppp = shot.fullPixelsPerPoint
        var crop = CGRect(x: (center.x - shot.box.x - cropPoints.width / 2) * ppp, y: (center.y - shot.box.y - cropPoints.height / 2) * ppp,
                          width: cropPoints.width * ppp, height: cropPoints.height * ppp)
        crop.origin.x = max(0, min(crop.origin.x, shot.fullWidth - crop.width))
        crop.origin.y = max(0, min(crop.origin.y, shot.fullHeight - crop.height))
        let describe = [shown.live.target, shown.live.label].compactMap { $0 }.filter { !$0.isEmpty }.first ?? shown.live.say
        let say = shown.live.say
        Task { [weak self] in
            let cropped = await Task.detached(priority: .utility) { () -> Data? in
                guard let image = TeachImage.crop(shot.full, to: crop) else { return nil }
                return TeachImage.png(image)
            }.value
            guard let cropped else { return }
            let request = TeachRefineRequest(cropBase64: cropped.base64EncodedString(), cropWidth: crop.width, cropHeight: crop.height,
                                             describe: "“\(describe)” — the control for this step: \(say)", model: env.fastModel)
            let result = await env.teachRefine(request)
            guard let self, gen == self.generation, self.model.isActive, self.current?.id == shown.id,
                  result.found, let rx = result.x, let ry = result.y else { return }
            let global = CGPoint(x: shot.box.x + (crop.origin.x + rx) / ppp, y: shot.box.y + (crop.origin.y + ry) / ppp)
            // Far from the first guess means the crop found something else; keep the first guess.
            guard hypot(global.x - center.x, global.y - center.y) < 120 else { return }
            let w = max(16, (result.w ?? 28) / ppp)
            let h = max(16, (result.h ?? 28) / ppp)
            var rect = CGRect(x: global.x - w / 2, y: global.y - h / 2, width: min(w, 240), height: min(h, 160))
            if let exact = TeachGeometry.snap(center: global, target: shown.live.target, pid: nil, elements: self.elements, screen: screen, region: false) {
                rect = exact
            }
            guard var updated = self.current, updated.id == shown.id, let old = updated.scene else { return }
            let built = self.buildScene(rect: rect, region: false, screen: screen, label: old.label, keys: old.keys,
                                        also: (old.also, old.alsoLabel), drawings: old.drawings)
            guard let scene = built.scene else { return }
            updated.scene = scene
            updated.hitRect = built.hit
            updated.actGlobal = CGPoint(x: rect.midX, y: rect.midY)
            updated.snapped = true
            self.current = updated
            self.stage?.present(scene, animated: true)
            self.placeBubble(animated: true)
        }
    }

    // MARK: Lookahead

    /// Show the model's guess at the next step the instant this one lands, while the real check runs.
    private func showLookahead(_ guess: TeachNextGuess) {
        guard let screen, let shot = lastShot else { return }
        var rect: CGRect?
        if let fromElement = elementRect(guess.element) { rect = fromElement }
        else if let x = guess.x, let y = guess.y {
            let center = shot.global(x, y)
            rect = TeachGeometry.snap(center: center, target: guess.label, pid: nil, elements: elements, screen: screen, region: false)
                ?? CGRect(x: center.x - 20, y: center.y - 20, width: 40, height: 40)
        }
        let keys = guess.action == "key" ? TeachKeys.caps(guess.key) : []
        var scene: TeachScene?
        if let rect {
            scene = buildScene(rect: rect, region: false, screen: screen, label: guess.label, keys: keys, also: (nil, nil), drawings: []).scene
            scene?.provisional = true
        }
        withAnimation(OKMotion.spring) {
            model.say = guess.say
            model.why = ""
            model.provisional = true
            model.hint = "next, probably"
        }
        var provisional = current
        provisional?.scene = scene
        current = provisional
        stage?.present(scene, animated: true)
        stage?.setThinking(true)
        placeBubble(animated: true)
    }

    // MARK: Following the window

    private var capturable: Bool {
        lab != nil || ProcessInfo.processInfo.environment["OKIDOKI_TEACH_CAPTURE"] == "1"
    }

    private func startFollowing() {
        stopFollowing()
        guard let pid = targetApp?.processIdentifier, let origin = lastShot?.windowRect else { return }
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.model.isActive, self.model.phase == .waiting,
                      let now = TeachGeometry.frontWindowGlobal(pid: pid) else { return }
                let dx = now.minX - origin.minX
                let dy = now.minY - origin.minY
                guard abs(dx) > 1 || abs(dy) > 1 else { return }
                // The window moved: slide every mark by the same amount and remember the new home.
                self.lastShot?.windowRect = now
                self.shiftScene(dx: dx, dy: dy)
            }
        }
    }

    private func stopFollowing() {
        followTimer?.invalidate()
        followTimer = nil
    }

    private func shiftScene(dx: CGFloat, dy: CGFloat) {
        guard var shown = current else { return }
        if var scene = shown.scene {
            scene.rect = scene.rect.offsetBy(dx: dx, dy: dy)
            scene.from = CGPoint(x: scene.from.x + dx, y: scene.from.y + dy)
            scene.to = scene.to.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
            scene.also = scene.also?.offsetBy(dx: dx, dy: dy)
            scene.drawings = scene.drawings.map { d in
                var copy = d
                copy.rect = d.rect.offsetBy(dx: dx, dy: dy)
                copy.to = d.to.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
                return copy
            }
            shown.scene = scene
            stage?.present(scene, animated: false)
            placeBubble(animated: false)
        }
        shown.hitRect = shown.hitRect?.offsetBy(dx: dx, dy: dy)
        shown.dragTo = shown.dragTo.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
        shown.actGlobal = shown.actGlobal.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
        shown.actFrom = shown.actFrom.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }
        current = shown
        // Local geometry already moved with the window; the follow origin is now the new rect.
        if let rect = lastShot?.windowRect { startFollowingFrom(rect) }
    }

    private func startFollowingFrom(_ rect: CGRect) {
        lastShot?.windowRect = rect
        startFollowing()
    }

    // MARK: Watching the learner

    private func installMonitors() {
        removeMonitors()
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .keyDown, .scrollWheel, .mouseMoved, .leftMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            if event.type == .keyDown, event.keyCode == 53 {
                Task { @MainActor in self?.handle(event) }
                return nil
            }
            if event.type == .mouseMoved { Task { @MainActor in self?.handle(event) } }
            return event
        }) {
            monitors.append(local)
        }
        appObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            Task { @MainActor in self?.handleActivation(app) }
        }
        // Whatever happens to spaces, full-screen apps or okidoki's own activation, the marks stay on top.
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.bringPanelsForward() }
        }
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.bringPanelsForward() }
        }
    }

    private func removeMonitors() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let appObserver { NSWorkspace.shared.notificationCenter.removeObserver(appObserver) }
        appObserver = nil
        if let spaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(spaceObserver) }
        spaceObserver = nil
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        resignObserver = nil
    }

    private func bringPanelsForward() {
        guard model.isActive else { return }
        stagePanel?.orderFrontRegardless()
        barPanel?.orderFrontRegardless()
    }

    private func handle(_ event: NSEvent) {
        guard model.isActive, !askingQuestion else { return }
        if event.type == .keyDown, event.keyCode == 53, !expectsEscape {
            if model.phase == .confirm { resolveConfirm(false); return }
            stop(completed: model.phase == .done)
            return
        }
        let cocoa = NSEvent.mouseLocation
        let point = TeachGeometry.quartz(cocoa)
        if event.type == .mouseMoved || event.type == .leftMouseDragged {
            let now = CACurrentMediaTime()
            if now - lastPointerUpdate > 0.033, let screen, model.phase == .waiting {
                lastPointerUpdate = now
                stage?.pointer(at: TeachGeometry.local(point, on: screen))
            }
            return
        }
        guard !performingForThem else { return }
        if let panel = barPanel, panel.frame.contains(cocoa) { return }

        if event.type == .scrollWheel {
            guard let step = current, step.scene?.hasTarget == true, model.phase == .waiting else { return }
            // Scrolling moves the control: dim, then look again once they stop.
            stage?.setThinking(true)
            scrollSettle?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.model.isActive, self.model.phase == .waiting else { return }
                self.setOutcome("scrolled; the view moved")
                self.requestStep(after: 0.1, settle: true)
            }
            scrollSettle = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
            return
        }

        guard model.phase == .waiting, let step = current else { return }
        stage?.cancelGuide()

        switch event.type {
        case .leftMouseDown, .rightMouseDown:
            mouseDownAt = point
            if step.live.action == "drag" { return }
            let right = event.type == .rightMouseDown
            let verb = right ? "right-clicked" : (event.clickCount >= 2 ? "double-clicked" : "clicked")
            let onTarget = step.hitRect?.contains(point) ?? false
            let label = TeachGeometry.axLabel(at: cocoa)
            let name = step.live.label ?? step.live.target ?? label
            if onTarget, step.live.isPointerStep {
                if step.live.action == "type" {
                    setOutcome("clicked into “\(name)”, typing next")
                    return
                }
                cleanHits += 1
                doItInARow = 0
                celebrate(at: point)
                setOutcome("\(verb) the target “\(name)” at \(Int(point.x)),\(Int(point.y))")
                let wantsSecond = step.live.action == "double_click" && event.clickCount < 2
                if let next = step.live.next, !wantsSecond { showLookahead(next) }
                scheduleVerify(after: wantsSecond ? 1.0 : 0.3)
            } else {
                cleanHits = 0
                let where_ = label.isEmpty ? "" : " on “\(label)”"
                setOutcome("\(verb) elsewhere at \(Int(point.x)),\(Int(point.y))\(where_)")
                scheduleVerify(after: 0.9)
            }

        case .leftMouseUp:
            guard step.live.action == "drag", let down = mouseDownAt else { return }
            let distance = hypot(point.x - down.x, point.y - down.y)
            guard distance > 12 else { return }
            let landed = step.dragTo.map { hypot($0.x - point.x, $0.y - point.y) < 90 } ?? false
            if landed { celebrate(at: point); cleanHits += 1; if let next = step.live.next { showLookahead(next) } } else { cleanHits = 0 }
            setOutcome("dragged from \(Int(down.x)),\(Int(down.y)) to \(Int(point.x)),\(Int(point.y))\(landed ? " (onto the target)" : "")")
            scheduleVerify(after: 0.4)

        case .keyDown:
            let combo = TeachKeys.combo(for: event)
            switch step.live.action {
            case "key":
                if TeachKeys.matches(combo, expected: step.live.key) {
                    cleanHits += 1
                    celebrate(at: step.scene.map { TeachGeometry.quartz(local: $0.center, on: screen) })
                    setOutcome("pressed \(combo) — the shortcut")
                    if let next = step.live.next { showLookahead(next) }
                    scheduleVerify(after: 0.3)
                } else {
                    setOutcome("pressed \(combo)")
                    scheduleVerify(after: 1.2)
                }
            case "type":
                if combo == "return" {
                    setOutcome("typed \(typedCount) characters and pressed return")
                    scheduleVerify(after: 0.4)
                } else {
                    typedCount += 1
                    setOutcome("typed \(typedCount) characters so far")
                    scheduleVerify(after: 1.8)
                }
            default:
                setOutcome("pressed \(combo)")
                scheduleVerify(after: 1.2)
            }

        default:
            break
        }
    }

    private var expectsEscape: Bool {
        guard let step = current, step.live.action == "key" else { return false }
        return TeachKeys.matches("esc", expected: step.live.key)
    }

    private func handleActivation(_ app: NSRunningApplication?) {
        guard model.isActive, !performingForThem, !askingQuestion, let app,
              app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        let name = app.localizedName ?? "an app"
        targetApp = app
        model.appName = name
        guard model.phase == .waiting, let step = current else { return }
        if step.live.action == "open_app", let wanted = step.live.app,
           name.lowercased().contains(wanted.lowercased()) || wanted.lowercased().contains(name.lowercased()) {
            celebrate(at: nil)
            setOutcome("opened \(name)")
        } else {
            setOutcome("switched to \(name)")
        }
        let newScreen = screenFor(app: app)
        if newScreen != screen {
            screen = newScreen
            buildPanels(on: newScreen)
            stagePanel?.orderFrontRegardless()
            barPanel?.orderFrontRegardless()
        }
        scheduleVerify(after: 0.8)
    }

    private func setOutcome(_ text: String) {
        guard !log.isEmpty else { return }
        log[log.count - 1].outcome = text
        clearIdle()
        if model.stuck { withAnimation(OKMotion.spring) { model.stuck = false } }
    }

    private func scheduleVerify(after delay: Double) {
        pendingVerify?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .waiting || self.model.phase == .looking else { return }
            self.requestStep(after: 0.05, settle: true)
        }
        pendingVerify = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func celebrate(at point: CGPoint?, big: Bool = false) {
        guard let screen, let stage else { return }
        let local: CGPoint
        if let point {
            local = TeachGeometry.local(point, on: screen)
        } else if let scene = current?.scene, scene.hasTarget {
            local = scene.center
        } else {
            local = CGPoint(x: screen.frame.width / 2, y: screen.frame.height * 0.42)
        }
        stage.celebrate(at: local, big: big)
        model.hint = "nice"
    }

    // MARK: Doing a step for them

    private func askConfirm() async -> Bool {
        withAnimation(OKMotion.spring) { model.phase = .confirm }
        return await withCheckedContinuation { continuation in
            confirmContinuation = continuation
        }
    }

    private func resolveConfirm(_ yes: Bool) {
        guard let continuation = confirmContinuation else { return }
        confirmContinuation = nil
        withAnimation(OKMotion.spring) { model.phase = .waiting }
        continuation.resume(returning: yes)
    }

    /// Perform the step on the learner's behalf. Accessibility press first (no pointer theft), then
    /// real events, putting the pointer back afterwards.
    private func perform(_ shown: TeachShownStep, narrated: String) async {
        guard let shot = lastShot else { return }
        let live = shown.live
        guard EventActuator.canPost || live.action == "open_app" else {
            model.hint = "turn on accessibility for okidoki and i can do it"
            return
        }
        performingForThem = true
        pendingVerify?.cancel()
        clearIdle()
        withAnimation(OKMotion.spring) { model.stuck = false; model.hint = "doing it…" }
        let before = TeachGeometry.quartz(NSEvent.mouseLocation)
        var results: [String] = []
        var pressed = false
        if live.action == "click", let center = shown.actGlobal, let element = AXInventory.control(at: center),
           element.rect.contains(center), AXInventory.press(at: center) {
            pressed = true
            results.append("pressed “\(element.label)”")
        }
        if !pressed {
            var actions: [ComputerAction] = []
            func sent(_ p: CGPoint) -> CGPoint { shot.sentPixels(p) }
            switch live.action {
            case "click", "double_click", "right_click":
                guard let center = shown.actGlobal else { break }
                let p = sent(center)
                actions.append(ComputerAction(type: live.action, x: p.x, y: p.y, target: live.target))
            case "scroll":
                guard let center = shown.actGlobal else { break }
                let p = sent(center)
                // The scroll annotation says which way; default to down, the common case.
                let up = live.annotations.contains { $0.kind == "scroll" && $0.text?.lowercased() == "up" }
                actions.append(ComputerAction(type: "scroll", x: p.x, y: p.y, dy: up ? -400 : 400, target: live.target))
            case "drag":
                guard let from = shown.actFrom, let to = shown.actGlobal else { break }
                let a = sent(from), b = sent(to)
                actions.append(ComputerAction(type: "drag", fromX: a.x, fromY: a.y, toX: b.x, toY: b.y))
            case "type":
                if let center = shown.actGlobal { let p = sent(center); actions.append(ComputerAction(type: "click", x: p.x, y: p.y, target: live.target)) }
                actions.append(ComputerAction(type: "type", text: live.text ?? ""))
            case "key":
                if let key = live.key, !key.isEmpty { actions.append(ComputerAction(type: "key", key: key)) }
            case "open_app":
                if let app = live.app, !app.isEmpty { actions.append(ComputerAction(type: "open_app", app: app)) }
            default:
                break
            }
            for action in actions {
                let result = (try? await ComputerUseService.shared.perform(action, screen: shot.box,
                                                                            imageWidth: shot.sentWidth, imageHeight: shot.sentHeight)) ?? "couldn't"
                results.append(result)
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            if ["click", "double_click", "right_click", "drag", "scroll"].contains(live.action) {
                // Hand the pointer back where it was.
                try? await Task.sleep(nanoseconds: 250_000_000)
                CGWarpMouseCursorPosition(before)
            }
        }
        performingForThem = false
        guard model.isActive, current?.id == shown.id else { return }
        celebrate(at: nil)
        setOutcome("\(narrated): \(results.joined(separator: "; ").prefix(160))")
        if let next = live.next { showLookahead(next) }
        requestStep(after: 0.5, settle: true)
    }

    // MARK: Voice commands

    /// "next" / "skip": move past the current step without doing it. Also retries after the model went quiet.
    func skipStep() {
        guard model.isActive, !askingQuestion else { return }
        switch model.phase {
        case .looking, .confirm:
            return
        case .done:
            stop(completed: true)
        case .waiting:
            if current != nil { setOutcome("skipped — move on") }
            modelRetries = 0
            requestStep(after: 0.1, settle: false)
        }
    }

    /// "do it": borrow their hands for this one step, then keep teaching.
    func doItForThem() {
        guard model.isActive, model.phase == .waiting, let shown = current else { return }
        guard shown.live.isDoable, shown.actGlobal != nil || shown.live.action == "key" || shown.live.action == "open_app" else {
            skipStep()
            return
        }
        doItInARow += 1
        Task { [weak self] in
            guard let self else { return }
            if shown.live.risky {
                let yes = await self.askConfirm()
                guard self.model.isActive, self.current?.id == shown.id else { return }
                guard yes else { self.setOutcome("skipped — they didn't want that done"); self.requestStep(after: 0.1, settle: false); return }
            }
            await self.perform(shown, narrated: "okidoki did it")
        }
    }

    /// "again": the narration and the pantomime once more, no model call.
    func replayCurrent() {
        guard model.isActive, model.phase == .waiting, let shown = current else { return }
        stage?.present(shown.scene, animated: false)
        pantomime(shown)
        speak(shown.live.say)
    }

    func toggleVoice() {
        guard let env else { return }
        model.voice.toggle()
        env.store.settings.teachVoice = model.voice
        env.store.saveNow()
        if !model.voice { env.speaker.stop() }
    }

    // MARK: Questions mid-lesson

    /// Hold the lesson while answering a question.
    func pauseForQuestion() {
        guard model.isActive else { return }
        askingQuestion = true
        pendingVerify?.cancel()
        clearIdle()
        env?.speaker.stop()
        if model.phase == .waiting {
            model.hint = "ask away — i'll hold the step"
        }
    }

    func resumeAfterQuestion() {
        guard model.isActive, askingQuestion else { return }
        askingQuestion = false
        guard let shown = current, model.phase == .waiting else { return }
        model.hint = Self.hint(for: shown.live, mode: model.mode)
        armIdle()
    }

    /// What the lesson is about right now, for a question's context.
    var questionContext: String {
        guard model.isActive else { return "" }
        let step = current?.live.say ?? ""
        return "They're in an okidoki lesson on \"\(model.topic)\" in \(model.appName), step \(model.stepNumber)\(step.isEmpty ? "" : ": \(step)"). Answer briefly in that context; the lesson resumes after."
    }

    /// Spoken or typed commands during a lesson. Returns true when handled.
    func handleCommand(_ text: String) -> Bool {
        guard model.isActive else { return false }
        let t = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        switch t {
        case "next", "skip", "move on", "go on", "continue":
            askingQuestion = false
            skipStep()
            return true
        case "do it", "do it for me", "you do it", "just do it":
            askingQuestion = false
            if model.phase == .confirm { resolveConfirm(true) } else { doItForThem() }
            return true
        case "go back", "back", "again", "show that again", "repeat":
            askingQuestion = false
            replayCurrent()
            return true
        case "stop", "stop the lesson", "quit", "enough", "cancel":
            stop(completed: false)
            return true
        default:
            return false
        }
    }

    // MARK: Finish

    private func finish(summary: String, say: String) {
        generation += 1
        pendingVerify?.cancel()
        clearIdle()
        stopFollowing()
        withAnimation(OKMotion.spring) {
            model.summary = summary
            model.say = say
            model.why = ""
            model.phase = .done
            model.hint = "that's it"
            model.remaining = 0
            model.milestone = max(0, model.milestones.count - 1)
            let watched = model.mode == .guide && doItInARow > 0
            model.offerPractice = watched && stepsShown >= 3 && !practiceRound
        }
        stage?.present(nil, animated: true)
        celebrate(at: nil, big: true)
        placeBubble(animated: true)
        speak(say)
        let runID = model.runID
        let linger: Double = model.offerPractice ? 14 : 4
        DispatchQueue.main.asyncAfter(deadline: .now() + linger) { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .done, self.model.runID == runID else { return }
            self.stop(completed: true)
        }
    }

    /// "your turn?": the same lesson again with hints held back.
    func startPractice() {
        guard model.isActive, model.phase == .done else { return }
        let topic = model.topic
        let bundle = targetApp?.bundleIdentifier ?? ""
        let steps = log.map(\.say)
        let runID = model.runID
        let threadID = model.threadID
        practiceRound = true
        stop(completed: true, keepRun: true)
        start(topic: topic, outline: steps, appBundleID: bundle, requestText: "", runID: runID, threadID: threadID, mode: .practice)
        practiceRound = true
    }

    func stop(completed: Bool, quiet: Bool = false, keepRun: Bool = false) {
        guard model.isActive else { return }
        generation += 1
        pendingVerify?.cancel()
        pendingVerify = nil
        scrollSettle?.cancel()
        clearIdle()
        stopFollowing()
        removeMonitors()
        if let continuation = confirmContinuation { confirmContinuation = nil; continuation.resume(returning: false) }
        model.isActive = false
        model.phase = .looking
        model.hasBubble = false
        stage?.clear()
        closePanels()
        env?.speaker.stop()
        lab = nil
        if let runID = model.runID, !keepRun {
            if completed {
                env?.finishTeach(runID: runID, topic: model.topic, threadID: model.threadID, summary: model.summary,
                                 stepsDone: stepsShown, app: model.appName, log: log, quiet: quiet)
            } else {
                env?.cancelRun(runID)
            }
        }
        if !keepRun { model.runID = nil }
        current = nil
    }

    private func closePanels() {
        stagePanel?.orderOut(nil)
        barPanel?.orderOut(nil)
        stagePanel = nil
        barPanel = nil
        stage = nil
        bubbleHost = nil
    }

    // MARK: Lab

    /// A scripted lesson that cycles every drawing without a model, to check the visuals.
    func startLab() {
        lab = TeachLab()
        start(topic: "teach lab", outline: [], appBundleID: "", requestText: "", runID: nil, threadID: nil, mode: .guide)
    }
}

// MARK: - Geometry

/// Three coordinate spaces meet here: Cocoa (origin bottom-left of the main display, y up),
/// Quartz global (origin top-left of the main display, y down — what screenshots, AX and CGEvent
/// use), and overlay-local (Quartz, offset to the display the overlay covers).
@MainActor
enum TeachGeometry {
    static var mainHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    static func quartz(_ cocoa: NSPoint) -> CGPoint {
        CGPoint(x: cocoa.x, y: mainHeight - cocoa.y)
    }

    static func quartzRect(of screen: NSScreen) -> CGRect {
        CGRect(x: screen.frame.minX, y: mainHeight - screen.frame.maxY,
               width: screen.frame.width, height: screen.frame.height)
    }

    static func local(_ global: CGPoint, on screen: NSScreen) -> CGPoint {
        let origin = quartzRect(of: screen).origin
        return CGPoint(x: global.x - origin.x, y: global.y - origin.y)
    }

    static func local(_ global: CGRect, on screen: NSScreen) -> CGRect {
        let origin = quartzRect(of: screen).origin
        return global.offsetBy(dx: -origin.x, dy: -origin.y)
    }

    static func quartz(local: CGPoint, on screen: NSScreen?) -> CGPoint {
        guard let screen else { return local }
        let origin = quartzRect(of: screen).origin
        return CGPoint(x: local.x + origin.x, y: local.y + origin.y)
    }

    static func frontWindowGlobal(pid: pid_t) -> CGRect? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        var best: CGRect?
        var bestArea: CGFloat = 0
        for window in info {
            guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
            let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0,
                              width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
            let area = rect.width * rect.height
            if area > bestArea { best = rect; bestArea = area }
        }
        return best
    }

    /// The model's pixel guess is close; accessibility and OCR know the real edges. In order: the
    /// element with that exact label near the guess, the control under the point (lifted to its
    /// button), then a wider search by name.
    static func snap(center: CGPoint, target: String?, pid: pid_t?, elements: [TeachElement], screen: NSScreen, region: Bool) -> CGRect? {
        let maxW = screen.frame.width * (region ? 0.7 : 0.45)
        let maxH = screen.frame.height * (region ? 0.7 : 0.3)
        func plausible(_ rect: CGRect, slack: CGFloat = 90) -> Bool {
            rect.width >= 6 && rect.height >= 6 && rect.width < maxW && rect.height < maxH
                && (rect.insetBy(dx: -28, dy: -28).contains(center)
                    || hypot(rect.midX - center.x, rect.midY - center.y) < slack)
        }
        func distance(_ r: CGRect) -> CGFloat { hypot(r.midX - center.x, r.midY - center.y) }
        let needle = (target ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if !needle.isEmpty {
            let exact = elements.filter { $0.label.lowercased() == needle }
            if let near = exact.filter({ plausible($0.rect, slack: exact.count == 1 ? 260 : 120) }).min(by: { distance($0.rect) < distance($1.rect) }) {
                return near.rect
            }
            let loose = elements.filter { e in
                let l = e.label.lowercased()
                return l.contains(needle) || (needle.contains(l) && l.count > 2)
            }
            if let hit = loose.filter({ plausible($0.rect, slack: 120) }).min(by: { distance($0.rect) < distance($1.rect) }) {
                return hit.rect
            }
        }
        // Any small element right under the guess.
        if !region, let under = elements.filter({ $0.rect.insetBy(dx: -6, dy: -6).contains(center) && $0.rect.width < 320 && $0.rect.height < 140 })
            .min(by: { $0.rect.width * $0.rect.height < $1.rect.width * $1.rect.height }) {
            return under.rect
        }
        guard AXIsProcessTrusted() else { return nil }
        if let live = AXInventory.control(at: center), !region {
            let name = live.label.lowercased()
            let named = !needle.isEmpty && !name.isEmpty && (name.contains(needle) || needle.contains(name))
            let small = live.rect.width < 320 && live.rect.height < 140
            if plausible(live.rect), named || small {
                return live.rect
            }
        }
        if let pid, !needle.isEmpty, let found = AXSearch.find(target: needle, pid: pid), plausible(found.rect, slack: 160) {
            return found.rect
        }
        return nil
    }

    static func axLabel(at cocoa: NSPoint) -> String {
        AXInventory.control(at: quartz(cocoa))?.label ?? ""
    }
}
