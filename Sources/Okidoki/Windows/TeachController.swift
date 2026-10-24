import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

// MARK: - Model

enum TeachPhase: Equatable {
    /// Screenshot in flight, model deciding the next step.
    case looking
    /// A step is on screen; the learner does it.
    case waiting
    /// The lesson wrapped up; the card lingers for a beat.
    case done
}

/// Overlay-local geometry for the one thing this step points at. Origin top-left of the display.
struct ResolvedMark: Equatable {
    /// "ring" hugs a control, "box" hugs a region, "arrow" is a drag.
    var kind: String
    var rect: CGRect
    var from: CGPoint
    var to: CGPoint?
    var label: String?
    var keys: [String] = []
    /// A second region worth a glance, e.g. where the result shows up.
    var also: CGRect?
    var alsoLabel: String?
    /// True when accessibility confirmed the edges; false means a pixel guess worth refining.
    var snapped = false

    var center: CGPoint { to ?? CGPoint(x: rect.midX, y: rect.midY) }
}

struct TeachShownStep: Equatable {
    var id = UUID()
    var live: TeachLiveStep
    var number: Int
    var mark: ResolvedMark?
    /// Quartz global rect that counts as "on the target" for a click.
    var hitRect: CGRect?
    var dragTo: CGPoint?
    /// The model said the previous try didn't land, so this is the same step with a clearer hint.
    var retry: Bool
}

struct TeachCheck: Equatable {
    var id = UUID()
    var point: CGPoint
    var big = false
}

/// A one-shot guide from where the pointer is to where it should go.
struct TeachGuide: Equatable {
    var id = UUID()
    var from: CGPoint
    var to: CGPoint
}

@MainActor
final class TeachModel: ObservableObject {
    @Published var topic = ""
    @Published var appName = ""
    @Published var isActive = false
    @Published var phase: TeachPhase = .looking
    @Published var step: TeachShownStep?
    @Published var stepNumber = 0
    @Published var remaining: Int?
    @Published var progress: CGFloat = 0
    @Published var check: TeachCheck?
    @Published var guide: TeachGuide?
    @Published var hint = ""
    @Published var summary = ""
    @Published var stuck = false
    var runID: String?
    var threadID: String?
}

// MARK: - Panels

final class TeachPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Never key: the learner's next keystroke has to reach their app, not this card.
final class TeachControlPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// A screenshot and the numbers needed to map between its pixels and the screen.
struct TeachShot {
    var png: Data
    var box: ScreenBox
    /// Pixels of the full capture.
    var fullWidth: Double
    var fullHeight: Double
    /// Pixels of the downscaled image the model saw.
    var sentWidth: Double
    var sentHeight: Double

    func global(_ px: Double, _ py: Double) -> CGPoint {
        CGPoint(x: box.x + px / sentWidth * box.width, y: box.y + py / sentHeight * box.height)
    }

    func sentPixels(_ global: CGPoint) -> CGPoint {
        CGPoint(x: (global.x - box.x) / box.width * sentWidth, y: (global.y - box.y) / box.height * sentHeight)
    }

    var pointsPerSentPixelX: Double { box.width / sentWidth }
    var pointsPerSentPixelY: Double { box.height / sentHeight }
}

// MARK: - Controller

/// A live tutor. Each turn it looks at the real screen, asks the model for one step, draws it,
/// then watches what the learner actually does before looking again. The learner is the hands;
/// "do it for me" borrows them for a single step.
@MainActor
final class TeachController {
    let model = TeachModel()
    private weak var env: AppEnvironment?
    private var highlightPanel: TeachPanel?
    private var controlPanel: TeachControlPanel?
    private var screen: NSScreen?
    private var targetApp: NSRunningApplication?
    private var outline: [String] = []
    private var log: [TeachLogEntry] = []
    private var generation = 0
    private var monitors: [Any] = []
    private var appObserver: NSObjectProtocol?
    private var pendingVerify: DispatchWorkItem?
    private var idleWork: [DispatchWorkItem] = []
    private var mouseDownAt: CGPoint?
    private var typedCount = 0
    private var performingForThem = false
    private var lastShot: TeachShot?
    private var controls: [AXSeenControl] = []
    private var stepsShown = 0
    private var cleanHits = 0

    private static let controlSize = CGSize(width: 560, height: 176)

    init(environment: AppEnvironment) { self.env = environment }

    /// Legacy string-steps entry (skills, canned library). The steps become the outline.
    func start(topic: String, steps: [String], runID: String?, threadID: String?) {
        start(topic: topic, outline: steps, appBundleID: "", runID: runID, threadID: threadID)
    }

    /// Rich entry: the planner's steps are only an outline; the live loop does the pointing.

    func start(topic: String, outline: [String], appBundleID: String, runID: String?, threadID: String?) {
        if model.isActive { stop(completed: false) }
        self.outline = outline.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        log = []
        stepsShown = 0
        cleanHits = 0
        lastShot = nil
        controls = []
        typedCount = 0
        mouseDownAt = nil
        performingForThem = false

        targetApp = resolveApp(bundleID: appBundleID)
        if let app = targetApp, !app.isActive { app.activate(options: []) }

        model.topic = topic
        model.appName = targetApp?.localizedName ?? "your screen"
        model.step = nil
        model.stepNumber = 0
        model.remaining = nil
        model.check = nil
        model.guide = nil
        model.summary = ""
        model.hint = ""
        model.stuck = false
        model.runID = runID
        model.threadID = threadID
        model.phase = .looking
        model.isActive = true
        model.progress = 0

        let screen = screenFor(app: targetApp)
        self.screen = screen
        buildPanels(on: screen)
        highlightPanel?.orderFrontRegardless()
        controlPanel?.orderFrontRegardless()
        installMonitors()
        requestStep(after: 0.45)
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

    private func buildPanels(on screen: NSScreen) {
        closePanels()
        let highlight = TeachPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        highlight.isOpaque = false
        highlight.backgroundColor = .clear
        highlight.hasShadow = false
        highlight.level = .statusBar + 3
        highlight.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        highlight.ignoresMouseEvents = true
        highlight.sharingType = .none
        highlight.isReleasedWhenClosed = false
        highlight.contentView = NSHostingView(rootView: TeachHighlightView(model: model, screen: screen)
            .environmentObject(env!))
        highlight.setFrame(screen.frame, display: false)
        highlightPanel = highlight

        let size = Self.controlSize
        let control = TeachControlPanel(contentRect: NSRect(x: screen.frame.midX - size.width / 2,
                                                            y: screen.visibleFrame.minY + 26,
                                                            width: size.width, height: size.height),
                                        styleMask: [.borderless, .nonactivatingPanel],
                                        backing: .buffered, defer: false)
        control.isOpaque = false
        control.backgroundColor = .clear
        control.hasShadow = false
        control.level = .statusBar + 4
        control.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        control.sharingType = .none
        control.isReleasedWhenClosed = false
        let view = TeachControlView(
            model: model,
            onDoIt: { [weak self] in self?.doItForThem() },
            onNext: { [weak self] in self?.next() },
            onStop: { [weak self] in self?.stop(completed: false) }
        )
        .environmentObject(env!)
        .environment(\.colorScheme, .dark)
        // First-mouse hosting: the panel is never key while you work in your app, and a plain
        // NSHostingView swallowed the first click on the buttons.
        control.contentView = OverlayHostingView(rootView: view)
        controlPanel = control
    }

    // MARK: Loop

    /// Look at the screen and ask for the next step. The delay lets the app repaint after what they just did.
    private func requestStep(after delay: Double) {
        guard model.isActive, let env else { return }
        generation += 1
        let gen = generation
        pendingVerify?.cancel()
        pendingVerify = nil
        clearIdle()
        model.phase = .looking
        model.stuck = false
        model.hint = stepsShown == 0 ? "looking at \(model.appName)…" : "checking…"
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            guard gen == self.generation, self.model.isActive else { return }
            let screen = self.screen ?? NSScreen.okidokiPrimary
            let pid = self.targetApp?.processIdentifier
            let bounds = TeachGeometry.quartzRect(of: screen)
            async let inventory: [AXSeenControl] = Task.detached(priority: .userInitiated) {
                guard let pid else { return [] }
                return AXInventory.controls(pid: pid, within: bounds)
            }.value
            let captured = await ComputerUseService.shared.capture(screen: screen)
            let found = await inventory
            guard gen == self.generation, self.model.isActive else { return }
            var base64: String?
            var shot: TeachShot?
            if let captured {
                let scaled = TeachScreenshot.scaled(captured.png, maxEdge: 1568)
                base64 = scaled.data.base64EncodedString()
                shot = TeachShot(png: captured.png, box: captured.box,
                                 fullWidth: captured.imageWidth, fullHeight: captured.imageHeight,
                                 sentWidth: scaled.width, sentHeight: scaled.height)
                self.lastShot = shot
            }
            self.controls = found
            let hints: [TeachControlHint] = shot.map { shot in
                found.map { control in
                    let center = shot.sentPixels(CGPoint(x: control.rect.midX, y: control.rect.midY))
                    return TeachControlHint(label: control.label, role: control.role,
                                            x: center.x.rounded(), y: center.y.rounded(),
                                            w: (control.rect.width / shot.pointsPerSentPixelX).rounded(),
                                            h: (control.rect.height / shot.pointsPerSentPixelY).rounded())
                }
            } ?? []
            let app = self.currentAppName()
            self.model.appName = app
            let request = TeachStepRequest(topic: self.model.topic, app: app, outline: self.outline,
                                           log: Array(self.log.suffix(14)), stepNumber: self.stepsShown + 1,
                                           imageWidth: shot?.sentWidth ?? 0, imageHeight: shot?.sentHeight ?? 0,
                                           screenshotBase64: base64, controls: hints,
                                           model: env.store.settings.claudeModel)
            let step = await env.teachStep(request)
            guard gen == self.generation, self.model.isActive else { return }
            guard let step else {
                self.model.phase = .waiting
                self.model.hint = "the model didn't answer — press next to try again"
                return
            }
            self.apply(step)
        }
    }

    private func apply(_ step: TeachLiveStep) {
        if step.action == "done" {
            finish(summary: step.summary ?? step.say, say: step.say)
            return
        }
        let retry = !step.previousDone && !log.isEmpty
        if retry { cleanHits = 0 } else { stepsShown += 1 }
        log.append(TeachLogEntry(say: step.say, action: step.action, label: step.label, outcome: ""))
        let resolved = resolve(step)
        let shown = TeachShownStep(live: step, number: stepsShown, mark: resolved.mark,
                                   hitRect: resolved.hit, dragTo: resolved.dragTo, retry: retry)
        typedCount = 0
        mouseDownAt = nil

        let previous = model.step?.mark
        let redraw = previous == nil || previous?.kind != resolved.mark?.kind
        withAnimation(OKMotion.spring) {
            model.step = shown
            model.stepNumber = stepsShown
            model.remaining = step.remaining
            model.phase = .waiting
            model.stuck = false
            model.hint = retry ? "not quite — try this" : Self.hint(for: step)
        }
        if redraw { animateProgress() } else { model.progress = 1 }
        showGuide(to: resolved.mark, for: step)
        env?.speak(step.say)
        armIdle()
        if step.action == "look" {
            armLookDwell()
        }
        if let mark = resolved.mark, !mark.snapped, mark.kind == "ring", step.hasPoint {
            refine(shown)
        }
    }

    private static func hint(for step: TeachLiveStep) -> String {
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

    /// A short trail from the pointer to the control, so the eye knows where to go.
    private func showGuide(to mark: ResolvedMark?, for step: TeachLiveStep) {
        guard let mark, let screen, step.isPointerStep || step.action == "drag" else { return }
        let from = TeachGeometry.local(TeachGeometry.quartz(NSEvent.mouseLocation), on: screen)
        let to = mark.kind == "arrow" ? mark.from : mark.center
        guard hypot(to.x - from.x, to.y - from.y) > 140 else { return }
        model.guide = TeachGuide(from: from, to: to)
    }

    /// A "look" step has nothing to do; hold long enough to hear it, then move on.
    private func armLookDwell() {
        let gen = generation
        let words = (model.step?.live.say ?? "").split { $0.isWhitespace }.count
        let dwell = min(14, max(5, Double(words) * 0.42 + 3.2))
        DispatchQueue.main.asyncAfter(deadline: .now() + dwell) { [weak self] in
            guard let self, gen == self.generation, self.model.isActive, self.model.phase == .waiting,
                  self.model.step?.live.action == "look" else { return }
            self.setOutcome("they had a look")
            self.requestStep(after: 0.1)
        }
    }

    /// Nobody likes being rushed, but a long silence means they're lost. Offer a hand first,
    /// then ask the model for a smaller, clearer step.
    private func armIdle() {
        clearIdle()
        guard let step = model.step, step.live.action != "look" else { return }
        let id = step.id
        let offer = DispatchWorkItem { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .waiting, self.model.step?.id == id,
                  self.log.last?.outcome.isEmpty ?? false else { return }
            withAnimation(OKMotion.spring) {
                self.model.stuck = true
                self.model.hint = "stuck? i can do this one"
            }
        }
        let nudge = DispatchWorkItem { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .waiting, self.model.step?.id == id,
                  self.log.last?.outcome.isEmpty ?? false else { return }
            self.setOutcome("nothing yet after 25 seconds — they seem stuck; make it smaller and point again")
            self.requestStep(after: 0.1)
        }
        idleWork = [offer, nudge]
        DispatchQueue.main.asyncAfter(deadline: .now() + 11, execute: offer)
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: nudge)
    }

    private func clearIdle() {
        for work in idleWork { work.cancel() }
        idleWork = []
    }

    private func animateProgress() {
        // Reset without animation and let that render first: setting 0 then animating to 1 in
        // the same turn coalesced into 1 → 1, so marks never drew in (they just popped).
        var reset = Transaction()
        reset.disablesAnimations = true
        withTransaction(reset) { model.progress = 0 }
        let id = model.step?.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            guard let self, self.model.isActive, self.model.step?.id == id else { return }
            withAnimation(.easeOut(duration: 0.65)) { self.model.progress = 1 }
        }
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

    private func resolve(_ step: TeachLiveStep) -> (mark: ResolvedMark?, hit: CGRect?, dragTo: CGPoint?) {
        guard let screen, let shot = lastShot, shot.sentWidth > 0, shot.sentHeight > 0 else {
            return (nil, nil, nil)
        }
        let keys = step.action == "key" ? TeachKeys.caps(step.key) : []
        let also = alsoRegion(step, shot: shot, screen: screen)

        if step.action == "drag", let fx = step.fromX, let fy = step.fromY, let tx = step.toX, let ty = step.toY {
            var from = shot.global(fx, fy)
            var to = shot.global(tx, ty)
            if let snapped = TeachGeometry.snap(center: from, target: nil, pid: nil, controls: controls, screen: screen, region: false) {
                from = CGPoint(x: snapped.midX, y: snapped.midY)
            }
            if let snapped = TeachGeometry.snap(center: to, target: step.target, pid: nil, controls: controls, screen: screen, region: false),
               hypot(snapped.midX - to.x, snapped.midY - to.y) < 60 {
                to = CGPoint(x: snapped.midX, y: snapped.midY)
            }
            let mark = ResolvedMark(kind: "arrow", rect: .zero,
                                    from: TeachGeometry.local(from, on: screen),
                                    to: TeachGeometry.local(to, on: screen),
                                    label: step.label, keys: keys, also: also.rect, alsoLabel: also.label, snapped: true)
            let hit = CGRect(x: to.x - 60, y: to.y - 60, width: 120, height: 120)
            return (mark, hit, to)
        }

        guard let x = step.x, let y = step.y else {
            if let alsoRect = also.rect {
                let mark = ResolvedMark(kind: "box", rect: alsoRect, from: CGPoint(x: alsoRect.midX, y: alsoRect.midY),
                                        label: also.label ?? step.label, keys: keys, snapped: true)
                return (mark, nil, nil)
            }
            return (nil, nil, nil)
        }
        let center = shot.global(x, y)
        var rect: CGRect
        let region = (step.w ?? 0) > 0 && (step.h ?? 0) > 0
        if region, let w = step.w, let h = step.h {
            rect = CGRect(x: center.x - w * shot.pointsPerSentPixelX / 2, y: center.y - h * shot.pointsPerSentPixelY / 2,
                          width: w * shot.pointsPerSentPixelX, height: h * shot.pointsPerSentPixelY)
        } else {
            rect = CGRect(x: center.x - 20, y: center.y - 20, width: 40, height: 40)
        }
        var snapped = false
        if let exact = TeachGeometry.snap(center: center, target: step.target, pid: targetApp?.processIdentifier,
                                          controls: controls, screen: screen, region: region) {
            rect = exact
            snapped = true
        }
        let built = buildMark(rect: rect, center: center, region: region, screen: screen, label: step.label, keys: keys,
                              also: also, snapped: snapped)
        return (built.mark, built.hit, nil)
    }

    private func buildMark(rect: CGRect, center: CGPoint, region: Bool, screen: NSScreen, label: String?, keys: [String],
                           also: (rect: CGRect?, label: String?), snapped: Bool) -> (mark: ResolvedMark?, hit: CGRect?) {
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
        let mark = ResolvedMark(kind: isBox ? "box" : "ring",
                                rect: TeachGeometry.local(drawn, on: screen),
                                from: TeachGeometry.local(center, on: screen),
                                to: nil, label: label, keys: keys, also: also.rect, alsoLabel: also.label, snapped: snapped)
        return (mark, hit)
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

    /// Accessibility couldn't confirm a small target, so take a zoomed second look and glide the ring onto it.
    private func refine(_ shown: TeachShownStep) {
        guard let env, let shot = lastShot, let screen, let x = shown.live.x, let y = shown.live.y else { return }
        let gen = generation
        let center = shot.global(x, y)
        let cropPoints = CGSize(width: 340, height: 230)
        let pxPerPointX = shot.fullWidth / shot.box.width
        let pxPerPointY = shot.fullHeight / shot.box.height
        var crop = CGRect(x: (center.x - shot.box.x - cropPoints.width / 2) * pxPerPointX,
                          y: (center.y - shot.box.y - cropPoints.height / 2) * pxPerPointY,
                          width: cropPoints.width * pxPerPointX, height: cropPoints.height * pxPerPointY)
        crop.origin.x = max(0, min(crop.origin.x, shot.fullWidth - crop.width))
        crop.origin.y = max(0, min(crop.origin.y, shot.fullHeight - crop.height))
        guard let cropped = TeachScreenshot.crop(shot.png, to: crop) else { return }
        let describe = [shown.live.target, shown.live.label].compactMap { $0 }.filter { !$0.isEmpty }.first
            ?? shown.live.say
        let request = TeachRefineRequest(cropBase64: cropped.base64EncodedString(),
                                         cropWidth: crop.width, cropHeight: crop.height,
                                         describe: "“\(describe)” — the control for this step: \(shown.live.say)",
                                         model: env.store.settings.claudeModel)
        Task { [weak self] in
            let result = await env.teachRefine(request)
            guard let self, gen == self.generation, self.model.isActive, self.model.step?.id == shown.id,
                  result.found, let rx = result.x, let ry = result.y else { return }
            let global = CGPoint(x: shot.box.x + (crop.origin.x + rx) / pxPerPointX,
                                 y: shot.box.y + (crop.origin.y + ry) / pxPerPointY)
            // Far from the first guess means the crop found something else; keep the first guess.
            guard hypot(global.x - center.x, global.y - center.y) < 120 else { return }
            let w = max(16, (result.w ?? 28) / pxPerPointX)
            let h = max(16, (result.h ?? 28) / pxPerPointY)
            var rect = CGRect(x: global.x - w / 2, y: global.y - h / 2, width: min(w, 240), height: min(h, 160))
            if let exact = TeachGeometry.snap(center: global, target: shown.live.target, pid: nil,
                                              controls: self.controls, screen: screen, region: false) {
                rect = exact
            }
            let built = self.buildMark(rect: rect, center: global, region: false, screen: screen,
                                       label: shown.live.label, keys: shown.mark?.keys ?? [],
                                       also: (shown.mark?.also, shown.mark?.alsoLabel), snapped: true)
            guard var current = self.model.step, current.id == shown.id, let mark = built.mark else { return }
            current.mark = mark
            current.hitRect = built.hit
            withAnimation(.spring(response: 0.5, dampingFraction: 0.82)) {
                self.model.step = current
            }
        }
    }

    // MARK: Watching the learner

    private func installMonitors() {
        removeMonitors()
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .keyDown]
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
    }

    private func removeMonitors() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let appObserver { NSWorkspace.shared.notificationCenter.removeObserver(appObserver) }
        appObserver = nil
    }

    private func handle(_ event: NSEvent) {
        guard model.isActive, !performingForThem else { return }
        if event.type == .keyDown, event.keyCode == 53, !expectsEscape {
            stop(completed: false)
            return
        }
        guard model.phase == .waiting, let step = model.step else { return }
        let cocoa = NSEvent.mouseLocation
        if let panel = controlPanel, panel.frame.contains(cocoa) { return }
        let point = TeachGeometry.quartz(cocoa)
        if model.guide != nil { withAnimation(.easeOut(duration: 0.25)) { model.guide = nil } }

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
                celebrate(at: point)
                setOutcome("\(verb) the target “\(name)” at \(Int(point.x)),\(Int(point.y))")
                let wantsSecond = step.live.action == "double_click" && event.clickCount < 2
                scheduleVerify(after: wantsSecond ? 1.4 : 0.8)
            } else {
                cleanHits = 0
                let where_ = label.isEmpty ? "" : " on “\(label)”"
                setOutcome("\(verb) elsewhere at \(Int(point.x)),\(Int(point.y))\(where_)")
                scheduleVerify(after: 1.3)
            }

        case .leftMouseUp:
            guard step.live.action == "drag", let down = mouseDownAt else { return }
            let distance = hypot(point.x - down.x, point.y - down.y)
            guard distance > 12 else { return }
            let landed = step.dragTo.map { hypot($0.x - point.x, $0.y - point.y) < 90 } ?? false
            if landed { celebrate(at: point); cleanHits += 1 } else { cleanHits = 0 }
            setOutcome("dragged from \(Int(down.x)),\(Int(down.y)) to \(Int(point.x)),\(Int(point.y))\(landed ? " (onto the target)" : "")")
            scheduleVerify(after: 0.9)

        case .keyDown:
            let combo = TeachKeys.combo(for: event)
            switch step.live.action {
            case "key":
                if TeachKeys.matches(combo, expected: step.live.key) {
                    cleanHits += 1
                    celebrate(at: step.mark.map { TeachGeometry.quartz(local: $0.center, on: screen) })
                    setOutcome("pressed \(combo) — the shortcut")
                    scheduleVerify(after: 0.8)
                } else {
                    setOutcome("pressed \(combo)")
                    scheduleVerify(after: 1.6)
                }
            case "type":
                if combo == "return" {
                    setOutcome("typed \(typedCount) characters and pressed return")
                    scheduleVerify(after: 0.9)
                } else {
                    typedCount += 1
                    setOutcome("typed \(typedCount) characters so far")
                    scheduleVerify(after: 2.4)
                }
            default:
                setOutcome("pressed \(combo)")
                scheduleVerify(after: 1.6)
            }

        default:
            break
        }
    }

    private var expectsEscape: Bool {
        guard let step = model.step, step.live.action == "key" else { return false }
        return TeachKeys.matches("esc", expected: step.live.key)
    }

    private func handleActivation(_ app: NSRunningApplication?) {
        guard model.isActive, !performingForThem, let app,
              app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        let name = app.localizedName ?? "an app"
        targetApp = app
        model.appName = name
        guard model.phase == .waiting, let step = model.step else { return }
        if step.live.action == "open_app", let wanted = step.live.app,
           name.lowercased().contains(wanted.lowercased()) || wanted.lowercased().contains(name.lowercased()) {
            celebrate(at: nil)
            setOutcome("opened \(name)")
        } else {
            setOutcome("switched to \(name)")
        }
        screen = screenFor(app: app)
        if let screen, highlightPanel?.frame != screen.frame {
            buildPanels(on: screen)
            highlightPanel?.orderFrontRegardless()
            controlPanel?.orderFrontRegardless()
        }
        scheduleVerify(after: 1.2)
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
            guard let self, self.model.isActive, self.model.phase == .waiting else { return }
            self.requestStep(after: 0.25)
        }
        pendingVerify = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func celebrate(at point: CGPoint?, big: Bool = false) {
        guard let screen else { return }
        let local: CGPoint
        if let point {
            local = TeachGeometry.local(point, on: screen)
        } else if let mark = model.step?.mark {
            local = mark.center
        } else {
            local = CGPoint(x: screen.frame.width / 2, y: screen.frame.height * 0.42)
        }
        model.check = TeachCheck(point: local, big: big)
        model.hint = "nice"
    }

    // MARK: Buttons

    /// Skip ahead, or retry after the model went quiet.
    func next() {
        guard model.isActive, model.phase != .looking else { return }
        if model.phase == .done { stop(completed: true); return }
        setOutcome("skipped — move on")
        requestStep(after: 0.1)
    }

    /// Borrow their hands for this one step, then keep teaching.
    func doItForThem() {
        guard model.isActive, model.phase == .waiting, let step = model.step, let shot = lastShot else { return }
        guard EventActuator.canPost else {
            model.hint = "turn on accessibility for okidoki and i can do it"
            return
        }
        let live = step.live
        var actions: [ComputerAction] = []
        switch live.action {
        case "click", "double_click", "right_click", "scroll":
            guard live.hasPoint else { next(); return }
            actions.append(ComputerAction(type: live.action == "scroll" ? "click" : live.action,
                                          x: live.x, y: live.y, target: live.target))
        case "drag":
            actions.append(ComputerAction(type: "drag", fromX: live.fromX, fromY: live.fromY, toX: live.toX, toY: live.toY))
        case "type":
            if live.hasPoint { actions.append(ComputerAction(type: "click", x: live.x, y: live.y, target: live.target)) }
            actions.append(ComputerAction(type: "type", text: live.text ?? ""))
        case "key":
            guard let key = live.key, !key.isEmpty else { next(); return }
            actions.append(ComputerAction(type: "key", key: key))
        case "open_app":
            guard let app = live.app, !app.isEmpty else { next(); return }
            actions.append(ComputerAction(type: "open_app", app: app))
        default:
            next()
            return
        }
        performingForThem = true
        pendingVerify?.cancel()
        clearIdle()
        withAnimation(OKMotion.spring) {
            model.stuck = false
            model.hint = "doing it for you…"
        }
        Task { [weak self] in
            guard let self else { return }
            var results: [String] = []
            for action in actions {
                let result = (try? await ComputerUseService.shared.perform(action, screen: shot.box,
                                                                            imageWidth: shot.sentWidth,
                                                                            imageHeight: shot.sentHeight)) ?? "couldn't"
                results.append(result)
                try? await Task.sleep(nanoseconds: 350_000_000)
            }
            self.performingForThem = false
            guard self.model.isActive, self.model.step?.id == step.id else { return }
            self.celebrate(at: nil)
            self.setOutcome("okidoki did it: \(results.joined(separator: "; ").prefix(160))")
            self.requestStep(after: 0.8)
        }
    }

    // MARK: Finish

    private func finish(summary: String, say: String) {
        generation += 1
        pendingVerify?.cancel()
        clearIdle()
        withAnimation(OKMotion.spring) {
            model.summary = summary
            model.phase = .done
            model.hint = "that's it"
            model.remaining = 0
            model.guide = nil
        }
        celebrate(at: nil, big: true)
        env?.speak(say)
        let runID = model.runID
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { [weak self] in
            guard let self, self.model.isActive, self.model.phase == .done, self.model.runID == runID else { return }
            self.stop(completed: true)
        }
    }

    func stop(completed: Bool) {
        guard model.isActive else { return }
        generation += 1
        pendingVerify?.cancel()
        pendingVerify = nil
        clearIdle()
        removeMonitors()
        model.isActive = false
        model.phase = .looking
        model.check = nil
        model.guide = nil
        closePanels()
        env?.speaker.stop()
        if let runID = model.runID {
            if completed {
                env?.finishTeach(runID: runID, topic: model.topic, threadID: model.threadID,
                                 summary: model.summary, stepsDone: stepsShown)
            } else {
                env?.cancelRun(runID)
            }
        }
        model.runID = nil
        model.step = nil
    }

    private func closePanels() {
        highlightPanel?.orderOut(nil)
        controlPanel?.orderOut(nil)
        highlightPanel = nil
        controlPanel = nil
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

    /// The model's pixel guess is close; accessibility knows the real edges. In order: the control
    /// in the inventory with that exact label near the guess, the control under the point (lifted
    /// to its button), then a wider search by name.
    static func snap(center: CGPoint, target: String?, pid: pid_t?, controls: [AXSeenControl], screen: NSScreen, region: Bool) -> CGRect? {
        let maxW = screen.frame.width * (region ? 0.7 : 0.45)
        let maxH = screen.frame.height * (region ? 0.7 : 0.3)
        func plausible(_ rect: CGRect, slack: CGFloat = 90) -> Bool {
            rect.width >= 6 && rect.height >= 6 && rect.width < maxW && rect.height < maxH
                && (rect.insetBy(dx: -28, dy: -28).contains(center)
                    || hypot(rect.midX - center.x, rect.midY - center.y) < slack)
        }
        let needle = (target ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if !needle.isEmpty {
            let exact = controls.filter { $0.label.lowercased() == needle }
            let near = exact
                .filter { plausible($0.rect, slack: exact.count == 1 ? 260 : 120) }
                .min { hypot($0.rect.midX - center.x, $0.rect.midY - center.y) < hypot($1.rect.midX - center.x, $1.rect.midY - center.y) }
            if let near { return near.rect }
            let loose = controls.filter { $0.label.lowercased().contains(needle) || needle.contains($0.label.lowercased()) && $0.label.count > 2 }
            if let hit = loose.filter({ plausible($0.rect, slack: 120) })
                .min(by: { hypot($0.rect.midX - center.x, $0.rect.midY - center.y) < hypot($1.rect.midX - center.x, $1.rect.midY - center.y) }) {
                return hit.rect
            }
        }
        guard AXIsProcessTrusted() else { return nil }
        if let under = AXInventory.control(at: center), !region {
            let name = under.label.lowercased()
            let named = !needle.isEmpty && !name.isEmpty && (name.contains(needle) || needle.contains(name))
            let small = under.rect.width < 320 && under.rect.height < 140
            if plausible(under.rect), named || small {
                return under.rect
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

// MARK: - Keys

enum TeachKeys {
    private static let names: [UInt16: String] = [
        36: "return", 76: "return", 48: "tab", 49: "space", 51: "delete", 117: "delete", 53: "esc",
        123: "left", 124: "right", 125: "up", 126: "down", 115: "home", 119: "end", 116: "pageup", 121: "pagedown",
        122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8", 101: "f9",
        109: "f10", 103: "f11", 111: "f12",
    ]

    static func combo(for event: NSEvent) -> String {
        var parts: [String] = []
        let flags = event.modifierFlags
        if flags.contains(.control) { parts.append("ctrl") }
        if flags.contains(.option) { parts.append("alt") }
        if flags.contains(.shift) { parts.append("shift") }
        if flags.contains(.command) { parts.append("cmd") }
        let key = names[event.keyCode] ?? (event.charactersIgnoringModifiers ?? "").lowercased()
        parts.append(key.isEmpty ? "key\(event.keyCode)" : key)
        return parts.joined(separator: "+")
    }

    static func normalize(_ expected: String) -> [String] {
        let aliases: [String: String] = [
            "command": "cmd", "⌘": "cmd", "cmd": "cmd", "meta": "cmd",
            "option": "alt", "opt": "alt", "⌥": "alt", "alt": "alt",
            "control": "ctrl", "ctrl": "ctrl", "⌃": "ctrl",
            "shift": "shift", "⇧": "shift",
            "enter": "return", "↩": "return", "return": "return",
            "escape": "esc", "esc": "esc", "backspace": "delete", "del": "delete",
            "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right",
            "spacebar": "space",
        ]
        let pieces = expected.lowercased()
            .replacingOccurrences(of: " ", with: "+")
            .split { $0 == "+" || $0 == "-" }
            .map(String.init)
            .filter { !$0.isEmpty }
        return pieces.map { aliases[$0] ?? $0 }
    }

    static func matches(_ combo: String, expected: String?) -> Bool {
        guard let expected, !expected.isEmpty else { return false }
        let modifiers: Set<String> = ["cmd", "alt", "ctrl", "shift"]
        let want = normalize(expected)
        let got = combo.split(separator: "+").map(String.init)
        guard let wantKey = want.last(where: { !modifiers.contains($0) }),
              let gotKey = got.last(where: { !modifiers.contains($0) }) else { return false }
        let wantMods = Set(want.filter { modifiers.contains($0) })
        let gotMods = Set(got.filter { modifiers.contains($0) })
        // A bare letter still counts when shift is the only extra, e.g. "A" typed as shift+a.
        return wantKey == gotKey && (wantMods == gotMods || (wantMods.isEmpty && gotMods == ["shift"]))
    }

    static func caps(_ expected: String?) -> [String] {
        guard let expected, !expected.isEmpty else { return [] }
        let glyphs: [String: String] = [
            "cmd": "⌘", "alt": "⌥", "ctrl": "⌃", "shift": "⇧", "return": "↩", "tab": "⇥",
            "delete": "⌫", "esc": "esc", "space": "space", "up": "↑", "down": "↓", "left": "←", "right": "→",
        ]
        return normalize(expected).map { glyphs[$0] ?? $0.uppercased() }
    }
}

// MARK: - Highlight overlay

struct TeachHighlightView: View {
    @ObservedObject var model: TeachModel
    @EnvironmentObject private var env: AppEnvironment
    let screen: NSScreen

    private var accent: Color {
        Color(hexString: env.store.settings.drawingColorHex, fallback: 0x44E45E)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let step = model.step, let mark = step.mark, model.phase != .done {
                // One persistent view: a new step glides the ring to its next home instead of popping.
                TeachMarkView(mark: mark, progress: model.progress, accent: accent, quiet: model.phase == .looking)
                    .transition(.opacity)
            }
            if let guide = model.guide {
                TeachGuideTrail(from: guide.from, to: guide.to, accent: accent)
                    .id(guide.id)
                    .transition(.opacity)
            }
            if let check = model.check {
                TeachCheckBurst(point: check.point, accent: accent, big: check.big)
                    .id(check.id)
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

/// The glow ring, region box, or drag arrow, plus its tag. Geometry changes animate.
struct TeachMarkView: View {
    let mark: ResolvedMark
    let progress: CGFloat
    var accent: Color
    var quiet: Bool

    private var gesture: (CGPoint, CGPoint)? {
        guard mark.kind == "arrow", let to = mark.to else { return nil }
        return hypot(to.x - mark.from.x, to.y - mark.from.y) > 20 ? (mark.from, to) : nil
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let breathe = CGFloat(0.5 + 0.5 * sin(t * 2.4))
            let march = CGFloat(t.truncatingRemainder(dividingBy: 1.4) / 1.4)
            GeometryReader { geo in
                ZStack(alignment: .topLeading) {
                    Color.clear
                    if let (from, to) = gesture {
                        TeachArrow(from: from, to: to, progress: progress, phase: march, accent: accent)
                            .frame(width: geo.size.width, height: geo.size.height)
                        dashedTarget(at: to, breathe: breathe, phase: march)
                    } else {
                        ring(breathe: breathe)
                    }
                    if let also = mark.also {
                        alsoBox(also, phase: march)
                    }
                    tag(in: geo.size)
                }
            }
        }
        .opacity(quiet ? 0.42 : 1)
        .animation(.easeInOut(duration: 0.3), value: quiet)
        .animation(.spring(response: 0.55, dampingFraction: 0.8), value: mark)
        .allowsHitTesting(false)
    }

    private var shape: AnyShape {
        mark.kind == "box"
            ? AnyShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            : AnyShape(RoundedRectangle(cornerRadius: min(mark.rect.width, mark.rect.height) / 2, style: .continuous))
    }

    @ViewBuilder private func ring(breathe: CGFloat) -> some View {
        ZStack {
            shape.fill(accent.opacity(0.07 + 0.04 * breathe))
            shape.stroke(accent.opacity(0.28 + 0.3 * breathe), lineWidth: 11)
                .blur(radius: 11)
            shape.stroke(accent.opacity(0.38), lineWidth: 5)
                .blur(radius: 2.5)
            shape
                .trim(from: 0, to: max(0.02, progress))
                .stroke(accent, style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
        }
        .frame(width: mark.rect.width, height: mark.rect.height)
        .scaleEffect(1 + 0.03 * breathe)
        .offset(x: mark.rect.minX, y: mark.rect.minY)
    }

    @ViewBuilder private func dashedTarget(at point: CGPoint, breathe: CGFloat, phase: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(accent.opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [7, 5], dashPhase: -phase * 24))
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(accent.opacity(0.06 + 0.05 * breathe)))
            .frame(width: 64, height: 46)
            .scaleEffect(1 + 0.04 * breathe)
            .opacity(progress > 0.7 ? 1 : 0)
            .position(point)
    }

    @ViewBuilder private func alsoBox(_ rect: CGRect, phase: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(accent.opacity(0.6), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [6, 6], dashPhase: -phase * 24))
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
            if let label = mark.alsoLabel, !label.isEmpty {
                Text(label)
                    .font(.okBody(11, .medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .overlayGlass(cornerRadius: 9, veil: 0.5, tone: .dark)
                    .fixedSize()
                    .offset(x: rect.minX + 6, y: rect.minY - 24 < 4 ? rect.maxY + 6 : rect.minY - 24)
            }
        }
        .opacity(Double(min(1, max(0, progress) * 1.4)) * 0.9)
    }

    @ViewBuilder private func tag(in size: CGSize) -> some View {
        let hasLabel = !(mark.label ?? "").isEmpty
        if hasLabel || !mark.keys.isEmpty {
            let anchor = tagPoint(in: size)
            let pivot = gesture.map { ($0.0, $0.1) }.map { CGPoint(x: ($0.0.x + $0.1.x) / 2, y: ($0.0.y + $0.1.y) / 2) }
                ?? CGPoint(x: mark.rect.midX, y: mark.rect.midY)
            // When the tag had to move away from the ring, a hairline keeps them attached.
            if hypot(anchor.x - pivot.x, anchor.y - pivot.y) > 110 {
                Path { path in
                    path.move(to: pivot)
                    path.addLine(to: anchor)
                }
                .stroke(accent.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            }
            HStack(spacing: 8) {
                if hasLabel { TeachPill(text: mark.label ?? "", accent: accent) }
                if !mark.keys.isEmpty { TeachKeyCaps(keys: mark.keys, accent: accent) }
            }
            .fixedSize()
            .position(anchor)
            .opacity(Double(min(1, max(0, progress) * 1.4)))
        }
    }

    private func tagPoint(in size: CGSize) -> CGPoint {
        let anchor: CGPoint
        if let (from, to) = gesture {
            let mid = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
            let dx = to.x - from.x
            let dy = to.y - from.y
            let length = max(1, hypot(dx, dy))
            anchor = CGPoint(x: mid.x + (-dy / length) * 30, y: mid.y + (dx / length) * 30)
        } else {
            let above = mark.rect.minY - 24
            anchor = CGPoint(x: mark.rect.midX, y: above < 26 ? mark.rect.maxY + 24 : above)
        }
        return CGPoint(x: min(max(90, anchor.x), size.width - 90),
                       y: min(max(20, anchor.y), max(20, size.height - 20)))
    }
}

struct TeachPill: View {
    let text: String
    var accent: Color

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(accent)
                .frame(width: 7, height: 7)
                .shadow(color: accent.opacity(0.8), radius: 4)
            Text(text)
                .font(.okBody(13, .semibold))
                .textCase(.lowercase)
                .foregroundStyle(Color.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .overlayGlass(cornerRadius: 13, veil: 0.55, tone: .dark)
    }
}

struct TeachKeyCaps: View {
    let keys: [String]
    var accent: Color

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                Text(key)
                    .font(.okMono(11.5, .medium))
                    .foregroundStyle(Color.white.opacity(0.95))
                    .padding(.horizontal, key.count > 1 ? 7 : 0)
                    .frame(minWidth: 24, minHeight: 24)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.white.opacity(0.12))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .stroke(accent.opacity(0.7), lineWidth: 1))
                    )
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .overlayGlass(cornerRadius: 11, veil: 0.55, tone: .dark)
    }
}

/// A curved stroke from the start of a drag to its end: soft glow, a comet running along it, a filled head.
struct TeachArrow: View {
    let from: CGPoint
    let to: CGPoint
    let progress: CGFloat
    let phase: CGFloat
    var accent: Color

    var body: some View {
        Canvas { context, _ in
            let travel = max(0, min(1, progress))
            let dx = to.x - from.x
            let dy = to.y - from.y
            let length = max(1, hypot(dx, dy))
            let control = CGPoint(x: (from.x + to.x) / 2 + (-dy / length) * length * 0.18,
                                  y: (from.y + to.y) / 2 + (dx / length) * length * 0.18)
            var full = Path()
            full.move(to: from)
            full.addQuadCurve(to: to, control: control)
            let shaft = full.trimmedPath(from: 0, to: travel)
            context.stroke(shaft, with: .color(accent.opacity(0.28)),
                           style: StrokeStyle(lineWidth: 12, lineCap: .round))
            context.stroke(shaft, with: .color(accent.opacity(0.85)),
                           style: StrokeStyle(lineWidth: 3.2, lineCap: .round))
            if travel >= 1 {
                let head = phase
                let tail = max(0, head - 0.22)
                let comet = full.trimmedPath(from: tail, to: head)
                context.stroke(comet, with: .color(Color.white.opacity(0.55)),
                               style: StrokeStyle(lineWidth: 5, lineCap: .round))
                context.stroke(comet, with: .color(Color.white.opacity(0.9)),
                               style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            context.fill(Path(ellipseIn: CGRect(x: from.x - 5, y: from.y - 5, width: 10, height: 10)),
                         with: .color(accent))
            guard travel > 0.72 else { return }
            let tip = to
            let angle = atan2(to.y - control.y, to.x - control.x)
            let wing = CGPoint(x: tip.x - cos(angle) * 17, y: tip.y - sin(angle) * 17)
            let left = CGPoint(x: wing.x + cos(angle + .pi / 2) * 7, y: wing.y + sin(angle + .pi / 2) * 7)
            let right = CGPoint(x: wing.x - cos(angle + .pi / 2) * 7, y: wing.y - sin(angle + .pi / 2) * 7)
            var head = Path()
            head.move(to: tip)
            head.addLine(to: left)
            head.addLine(to: right)
            head.closeSubpath()
            context.fill(head, with: .color(accent))
        }
        .allowsHitTesting(false)
    }
}

/// A dot that runs from the pointer to the control once, leaving a trail that fades behind it.
struct TeachGuideTrail: View {
    let from: CGPoint
    let to: CGPoint
    var accent: Color
    @State private var t: CGFloat = 0
    @State private var fade: CGFloat = 1

    var body: some View {
        Canvas { context, _ in
            let dx = to.x - from.x
            let dy = to.y - from.y
            let length = max(1, hypot(dx, dy))
            let bend = min(90, length * 0.16)
            let control = CGPoint(x: (from.x + to.x) / 2 + (-dy / length) * bend,
                                  y: (from.y + to.y) / 2 + (dx / length) * bend)
            var full = Path()
            full.move(to: from)
            full.addQuadCurve(to: to, control: control)
            let head = min(1, t)
            let trail = full.trimmedPath(from: max(0, head - 0.45), to: head)
            context.stroke(trail, with: .linearGradient(
                Gradient(colors: [accent.opacity(0), accent.opacity(0.75)]),
                startPoint: from, endPoint: to),
                style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
            // The dot itself; the ring takes over once it arrives.
            guard head < 0.985 else { return }
            let dot = full.trimmedPath(from: max(0, head - 0.001), to: head).currentPoint ?? to
            context.fill(Path(ellipseIn: CGRect(x: dot.x - 5, y: dot.y - 5, width: 10, height: 10)),
                         with: .color(accent))
            context.fill(Path(ellipseIn: CGRect(x: dot.x - 10, y: dot.y - 10, width: 20, height: 20)),
                         with: .color(accent.opacity(0.25)))
        }
        .opacity(Double(fade))
        .allowsHitTesting(false)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.8).delay(0.15)) { t = 1 }
            withAnimation(.easeOut(duration: 0.5).delay(1.25)) { fade = 0 }
        }
    }
}

/// A quick tick where the learner landed it.
struct TeachCheckBurst: View {
    let point: CGPoint
    var accent: Color
    var big: Bool
    @State private var t: CGFloat = 0
    @State private var pop: CGFloat = 0.4

    var body: some View {
        let size: CGFloat = big ? 64 : 34
        ZStack {
            Circle()
                .stroke(accent.opacity(0.9), lineWidth: 2)
                .frame(width: size, height: size)
                .scaleEffect(0.7 + t * (big ? 2.2 : 1.6))
                .opacity(Double(1 - t))
            Circle()
                .stroke(accent.opacity(0.5), lineWidth: 1)
                .frame(width: size, height: size)
                .scaleEffect(0.7 + t * (big ? 3.2 : 2.3))
                .opacity(Double(0.7 - t * 0.7))
            Circle()
                .fill(accent)
                .frame(width: size, height: size)
                .shadow(color: accent.opacity(0.7), radius: big ? 18 : 10)
                .overlay(
                    Image(systemName: "checkmark")
                        .font(.system(size: big ? 30 : 16, weight: .bold))
                        .foregroundStyle(Color.black.opacity(0.85))
                )
                .scaleEffect(pop)
                .opacity(t < 0.7 ? 1 : Double(1 - (t - 0.7) / 0.3))
        }
        .position(point)
        .allowsHitTesting(false)
        .onAppear {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.55)) { pop = 1 }
            withAnimation(.easeOut(duration: big ? 1.7 : 1.05)) { t = 1 }
        }
    }
}

// MARK: - Control card

struct TeachControlView: View {
    @ObservedObject var model: TeachModel
    @Environment(\.colorScheme) private var scheme
    var onDoIt: () -> Void
    var onNext: () -> Void
    var onStop: () -> Void
    @State private var blink = false

    private var theme: OKTheme { OKTheme(scheme) }
    private var step: TeachLiveStep? { model.step?.live }

    private var statusText: String {
        switch model.phase {
        case .looking: return model.hint.isEmpty ? "looking…" : model.hint
        case .waiting: return model.hint
        case .done: return "done"
        }
    }

    private var sayText: String {
        if model.phase == .done { return model.summary.isEmpty ? "that's \(model.topic)." : model.summary }
        if let step { return step.say }
        return "taking a look at \(model.appName) so i can point at the real thing."
    }

    private var canDoIt: Bool {
        model.phase == .waiting && step != nil && step?.action != "look"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(OKBrand.green.opacity(0.12))
                    .frame(width: 42, height: 42)
                if model.phase == .done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(OKBrand.green)
                        .transition(.scale.combined(with: .opacity))
                } else {
                    VStack(spacing: -2) {
                        Text(model.stepNumber == 0 ? "·" : "\(model.stepNumber)")
                            .font(.okDisplay(22))
                            .foregroundStyle(OKBrand.green)
                            .contentTransition(.numericText())
                        if let remaining = model.remaining, model.stepNumber > 0 {
                            Text(remaining == 0 ? "last" : "~\(remaining) left")
                                .font(.okMono(7))
                                .foregroundStyle(theme.tertiary)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(model.topic)
                        .font(.okMono(8.5, .medium))
                        .textCase(.uppercase)
                        .foregroundStyle(OKBrand.green)
                        .lineLimit(1)
                    Rectangle().fill(theme.line).frame(width: 1, height: 9)
                    Text(model.appName)
                        .font(.okMono(8.5))
                        .foregroundStyle(theme.tertiary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    HStack(spacing: 5) {
                        if model.phase == .looking {
                            Circle().fill(OKBrand.green).frame(width: 5, height: 5)
                                .opacity(blink ? 1 : 0.25)
                        }
                        Text(statusText)
                            .font(.okMono(8.5))
                            .foregroundStyle(model.hint == "nice" ? OKBrand.green : (model.stuck ? theme.ink : theme.tertiary))
                            .lineLimit(1)
                            .contentTransition(.opacity)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(sayText)
                        .font(.okBody(13, .medium))
                        .foregroundStyle(theme.ink)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(3)
                    if let why = step?.why, !why.isEmpty, model.phase != .done {
                        Text(why)
                            .font(.okBody(11.5))
                            .foregroundStyle(theme.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .id(model.step?.id ?? UUID(uuidString: "00000000-0000-0000-0000-000000000000"))
                .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                Spacer(minLength: 0)
                HStack(spacing: 7) {
                    if model.phase == .done {
                        Button("done") { onNext() }
                            .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
                    } else {
                        Button("do it for me") { onDoIt() }
                            .buttonStyle(OKButtonStyle(kind: model.stuck ? .primary : .secondary, compact: true))
                            .disabled(!canDoIt)
                            .opacity(canDoIt ? 1 : 0.4)
                        Button("next") { onNext() }
                            .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                            .disabled(model.phase == .looking)
                            .opacity(model.phase == .looking ? 0.4 : 1)
                    }
                    Spacer()
                    Text("esc")
                        .font(.okMono(8))
                        .foregroundStyle(theme.tertiary.opacity(0.7))
                    Button("stop") { onStop() }
                        .buttonStyle(.plain)
                        .font(.okMono(9))
                        .foregroundStyle(theme.tertiary)
                }
            }
        }
        .padding(13)
        .frame(width: 560, height: 176, alignment: .topLeading)
        .overlayGlass(cornerRadius: 18, veil: 0.42, tone: .dark)
        .animation(OKMotion.spring, value: model.step?.id)
        .animation(OKMotion.spring, value: model.phase)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { blink = true }
        }
    }
}

// MARK: - Screenshot

enum TeachScreenshot {
    /// Downscale so the long edge fits `maxEdge`; the model answers in these pixels.
    static func scaled(_ data: Data, maxEdge: CGFloat) -> (data: Data, width: Double, height: Double) {
        guard let rep = NSBitmapImageRep(data: data), let image = rep.cgImage else { return (data, 0, 0) }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let edge = max(width, height)
        guard edge > maxEdge, width > 0, height > 0 else { return (data, Double(width), Double(height)) }
        let scale = maxEdge / edge
        let pixelW = Int((width * scale).rounded())
        let pixelH = Int((height * scale).rounded())
        guard let context = CGContext(data: nil, width: pixelW, height: pixelH, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return (data, Double(width), Double(height))
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: pixelW, height: pixelH))
        guard let scaledImage = context.makeImage(),
              let png = NSBitmapImageRep(cgImage: scaledImage).representation(using: .png, properties: [:]) else {
            return (data, Double(width), Double(height))
        }
        return (png, Double(pixelW), Double(pixelH))
    }

    /// A full-resolution crop, in pixels of the original capture.
    static func crop(_ data: Data, to rect: CGRect) -> Data? {
        guard let rep = NSBitmapImageRep(data: data), let image = rep.cgImage,
              let cropped = image.cropping(to: rect.integral) else { return nil }
        return NSBitmapImageRep(cgImage: cropped).representation(using: .png, properties: [:])
    }
}
