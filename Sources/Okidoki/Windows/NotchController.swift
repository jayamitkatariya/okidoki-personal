import AppKit
import Combine
import SwiftUI
import OkidokiCore

// MARK: - Model

struct NotchToast: Identifiable, Equatable {
    var id: String = UUID().uuidString
    var title: String
    var detail: String
    var kind: ToastKind
    var undoLabel: String?
    var editLabel: String?
    var runID: String?
    var expiresAt: Date
}

/// A lightweight, render-only copy of an `AgentRun`. The notch never observes the whole
/// store (whose runs change on every streamed byte); it only re-renders when one of these
/// fields actually changes.
struct NotchRunItem: Identifiable, Equatable {
    var id: String
    var title: String
    var kind: RunKind
    var status: RunStatus
    var step: String
    var summary: String
    var risk: RiskLevel
    var commands: [String]

    init(_ run: AgentRun) {
        id = run.id
        title = run.title
        kind = run.kind
        status = run.status
        step = run.steps.first(where: { $0.status == .running })?.title
            ?? run.steps.first(where: { $0.status == .previewing })?.title
            ?? run.summary
        summary = run.preview?.summary ?? ""
        risk = run.preview?.risk ?? .low
        commands = run.preview?.commands ?? []
    }
}

/// A skill being recorded right now. Replaces the generic live row for the `.watch` run.
struct NotchRecording: Equatable {
    var name: String
    var startedAt: Date
    var steps: Int
}

/// Geometry of the screen the notch lives on. Recomputed whenever displays change.
struct NotchMetrics: Equatable {
    var hasNotch: Bool
    var notchWidth: CGFloat
    var notchHeight: CGFloat
    var screenWidth: CGFloat
    var screenHeight: CGFloat

    init(screen: NSScreen) {
        hasNotch = screen.okidokiHasNotch
        notchWidth = hasNotch ? screen.okidokiNotchWidth : 0
        notchHeight = hasNotch ? screen.okidokiNotchHeight : 0
        screenWidth = screen.frame.width
        screenHeight = screen.frame.height
    }

    /// Concave "shoulder" that flares the island into the menu bar, like the hardware notch.
    var shoulder: CGFloat { hasNotch ? 10 : 0 }
    /// Height of the top band: the hardware notch on notched screens, a header row otherwise.
    var bandHeight: CGFloat { hasNotch ? notchHeight : 36 }
    /// Gap between the menu bar and the floating pill on screens without a notch.
    var topGap: CGFloat { hasNotch ? 0 : 6 }

    var closedWidth: CGFloat { hasNotch ? notchWidth + shoulder * 2 : 180 }
    var closedHeight: CGFloat { hasNotch ? notchHeight : 12 }
    var closedRadius: CGFloat { hasNotch ? 9 : 6 }

    var maxWidth: CGFloat { max(280, screenWidth - 48) }
    var maxBodyHeight: CGFloat { min(420, max(220, screenHeight * 0.5)) }
    /// Room for the body plus the expanded footer row under it.
    var maxIslandHeight: CGFloat { bandHeight + maxBodyHeight + 84 }
    /// Wide enough that the controls either side of the camera have real room.
    var expandedWidth: CGFloat { clampWidth(520 + shoulder * 2) }

    static func even(_ value: CGFloat) -> CGFloat { (value / 2).rounded(.up) * 2 }

    func clampWidth(_ width: CGFloat) -> CGFloat { NotchMetrics.even(min(width, maxWidth)) }
}

@MainActor
final class NotchModel: ObservableObject {
    @Published var toasts: [NotchToast] = []
    @Published var expanded = false
    @Published var listening = false
    @Published var quiet = false
    /// Mirrors `settings.defaultInput` so the mode switch can render without observing the store.
    @Published var inputMode: InputMode = .typing
    /// What okidoki is saying right now, while captions are on.
    @Published var caption: String?

    /// True while the island is open (drives the open / close spring).
    @Published var presented = false
    @Published var waiting: [NotchRunItem] = []
    @Published var live: [NotchRunItem] = []
    @Published var recording: NotchRecording?
    @Published var metrics: NotchMetrics

    var undoActions: [String: () -> Void] = [:]
    var editActions: [String: () -> Void] = [:]

    /// Pointer is over the island: toasts don't expire out from under the cursor.
    var hoverHold = false
    /// Measured island size (presented target), reported by the view.
    var onIslandSize: ((CGSize) -> Void)?
    /// Folds the expanded island back up, e.g. after one of its actions opens something else.
    var onClose: (() -> Void)?
    private var expiryWork: [String: DispatchWorkItem] = [:]

    static let maxToasts = 3

    init(metrics: NotchMetrics = NotchMetrics(screen: NSScreen.okidokiPrimary)) {
        self.metrics = metrics
    }

    // MARK: Toasts

    func addToast(_ toast: NotchToast, undo: (() -> Void)? = nil, edit: (() -> Void)? = nil) {
        if let undo { undoActions[toast.id] = undo }
        if let edit { editActions[toast.id] = edit }
        toasts.append(toast)
        while toasts.count > Self.maxToasts {
            // Drop the oldest, and its closures + timer, so nothing leaks.
            forget(toasts.removeFirst().id)
        }
        scheduleExpiry(toast.id, after: toast.expiresAt.timeIntervalSinceNow)
    }

    func removeToast(_ id: String) {
        toasts.removeAll { $0.id == id }
        forget(id)
    }

    func undo(_ id: String) {
        let action = undoActions[id]
        removeToast(id)
        action?()
    }

    func edit(_ id: String) {
        let action = editActions[id]
        removeToast(id)
        action?()
    }

    func clear() {
        toasts.removeAll()
        undoActions.removeAll()
        editActions.removeAll()
        expiryWork.values.forEach { $0.cancel() }
        expiryWork.removeAll()
    }


    private func forget(_ id: String) {
        undoActions[id] = nil
        editActions[id] = nil
        expiryWork[id]?.cancel()
        expiryWork[id] = nil
    }

    private func scheduleExpiry(_ id: String, after delay: TimeInterval) {
        expiryWork[id]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.toasts.contains(where: { $0.id == id }) else { return }
                if self.hoverHold {
                    self.scheduleExpiry(id, after: 1.6)
                } else {
                    self.removeToast(id)
                }
            }
        }
        expiryWork[id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.2, delay), execute: work)
    }

    // MARK: Derived layout

    /// Everything that wants an answer.
    var needsYou: Int { waiting.count }
    var hasContent: Bool { !toasts.isEmpty || !waiting.isEmpty || !live.isEmpty || recording != nil || listening || caption != nil }
    var hasBody: Bool { expanded || !toasts.isEmpty || !waiting.isEmpty || !live.isEmpty || recording != nil || caption != nil }

    /// Closed with something to show: wide enough for one card.
    var compactWidth: CGFloat { metrics.clampWidth(360 + metrics.shoulder * 2) }

    var islandWidth: CGFloat {
        let m = metrics
        if expanded { return m.expandedWidth }
        if hasBody { return compactWidth }
        return m.clampWidth(m.hasNotch ? m.notchWidth + m.shoulder * 2 + 148 : 236)
    }

    /// Anything that changes the island's shape. Drives the content spring.
    var layoutKey: [String] {
        // The recording row's presence changes the shape; its ticking counters don't.
        [expanded ? "x" : "c", listening ? "l" : "", quiet ? "q" : "", caption == nil ? "" : "s", recording == nil ? "" : "r"]
            + toasts.map(\.id)
            + waiting.map(\.id)
            + live.map { $0.id + $0.status.rawValue }
    }
}

// MARK: - AppKit plumbing

/// Never key: a click on Pause or Dismiss must not pull typing away from the app you're in.
/// HoverHostingView accepts first mouse, so its buttons still work on the first click.
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Hosting view whose hover tracking covers only the visible island, not the transparent
/// (click-through) margin around it.
final class HoverHostingView<Content: View>: NSHostingView<Content> {
    var onEnter: (() -> Void)?
    var onExit: (() -> Void)?
    var hoverSize: CGSize = .zero { didSet { if hoverSize != oldValue { updateTrackingAreas() } } }
    var hoverTopInset: CGFloat = 0
    private var tracking: NSTrackingArea?

    var hoverRect: NSRect {
        let width = min(hoverSize.width, bounds.width)
        let height = min(hoverSize.height, bounds.height - hoverTopInset)
        let x = (bounds.width - width) / 2
        let y = isFlipped ? hoverTopInset : bounds.height - hoverTopInset - height
        return NSRect(x: x, y: y, width: max(0, width), height: max(0, height))
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        tracking = nil
        guard hoverSize.width > 0, hoverSize.height > 0 else { return }
        let area = NSTrackingArea(rect: hoverRect, options: [.mouseEnteredAndExited, .activeAlways],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func mouseExited(with event: NSEvent) { onExit?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Keeps the fixed-size SwiftUI canvas pinned top-centre however the window is resized.
/// Autoresizing masks can't do this: once the canvas is wider than the window (negative
/// margins) AppKit pins it to the left edge instead, which shoved the island off-centre
/// until the next time the window grew.
final class NotchCanvasContainer: NSView {
    var onResize: (() -> Void)?
    override func resizeSubviews(withOldSize oldSize: NSSize) { onResize?() }
}

final class HoverView: NSView {
    var onEnter: (() -> Void)?
    var onExit: (() -> Void)?
    private var tracking: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }
    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func mouseExited(with event: NSEvent) { onExit?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Controller

/// Owns the notch island. The window is a transparent, click-through canvas pinned to the
/// top-centre of the screen; SwiftUI draws the island inside it and springs its size to the
/// measured content. The window grows immediately when the island needs more room and is
/// trimmed back to hug the island once the spring settles, so there is never visible slack.
@MainActor
final class NotchController {
    private let env: AppEnvironment
    private var screen: NSScreen
    let model: NotchModel
    private var panel: NotchPanel?
    private var host: HoverHostingView<NotchRootView>?
    private var container: NotchCanvasContainer?
    private var hotZone: NSWindow?

    private var hideWork: DispatchWorkItem?
    private var showWork: DispatchWorkItem?
    private var refreshWork: DispatchWorkItem?
    private var closeWork: DispatchWorkItem?
    private var settleWork: DispatchWorkItem?
    private var openWork: DispatchWorkItem?
    private var escapeMonitor: Any?
    private var globalEscapeMonitor: Any?
    private var clickMonitor: Any?
    private var cancellables = Set<AnyCancellable>()
    private var islandSize: CGSize = .zero
    private var lastManualClose = Date.distantPast
    private(set) var isVisible = false

    /// Transparent margin around the island so its shadow isn't clipped by the window.
    /// The soft shadow (radius 32, offset 20) still has visible weight 40pt out; cutting it
    /// short paints a faint rectangle the size of the window around the island.
    private let marginX: CGFloat = 64
    private let marginBottom: CGFloat = 92

    static let openSpring = Animation.spring(response: 0.42, dampingFraction: 0.8)
    static let closeSpring = Animation.spring(response: 0.3, dampingFraction: 1)

    init(environment: AppEnvironment) {
        self.env = environment
        let screen = NSScreen.okidokiPrimary
        self.screen = screen
        self.model = NotchModel(metrics: NotchMetrics(screen: screen))
    }

    func install() {
        model.onIslandSize = { [weak self] size in self?.islandSizeChanged(size) }
        model.onClose = { [weak self] in
            self?.lastManualClose = Date()
            self?.setExpanded(false)
        }
        buildPanel()
        buildHotZone()
        observe()
        refresh()
        // Dev-only: hold the island open so its expanded layout can be reviewed without hovering.
        if ProcessInfo.processInfo.environment["OKIDOKI_NOTCH_PREVIEW"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.setExpanded(true) }
        }
        if let directory = ProcessInfo.processInfo.environment["OKIDOKI_NOTCH_SNAPSHOT"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self else { return }
                NotchSnapshots.run(env: self.env, metrics: self.model.metrics, into: directory)
            }
        }
    }

    private func buildPanel() {
        let panel = NotchPanel(contentRect: windowFrame(for: CGSize(width: model.islandWidth, height: model.metrics.bandHeight)),
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.hidesOnDeactivate = false
        panel.level = .statusBar + 1
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The island draws its own shadow; a window shadow would outline the transparent canvas.
        panel.hasShadow = false
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.animationBehavior = .none
        panel.isReleasedWhenClosed = false
        let preview = ["OKIDOKI_OVERLAY_PREVIEW", "OKIDOKI_NOTCH_PREVIEW"].contains { ProcessInfo.processInfo.environment[$0] == "1" }
        panel.sharingType = preview ? .readOnly : .none
        panel.acceptsMouseMovedEvents = true

        let host = HoverHostingView(rootView: NotchRootView(model: model, env: env))
        // Never let SwiftUI's ideal size resize or constrain the window; the controller owns the frame.
        host.sizingOptions = []
        host.hoverTopInset = model.metrics.topGap
        host.onEnter = { [weak self] in self?.pointerEnteredIsland() }
        host.onExit = { [weak self] in self?.pointerExitedIsland() }
        // The SwiftUI canvas keeps a fixed size, pinned top-centre inside a plain container.
        // Resizing the window then only changes how much of the canvas is shown — SwiftUI never
        // re-lays out mid-spring, so the island can't slide or jump when the window grows/shrinks.
        let container = NotchCanvasContainer(frame: NSRect(origin: .zero, size: panel.frame.size))
        container.wantsLayer = true
        container.onResize = { [weak self] in self?.layoutCanvas() }
        host.autoresizingMask = []
        container.addSubview(host)
        panel.contentView = container
        self.panel = panel
        self.host = host
        self.container = container
        layoutCanvas()
        panel.orderOut(nil)
    }

    private func buildHotZone() {
        let zone = NSWindow(contentRect: hotZoneFrame(), styleMask: .borderless, backing: .buffered, defer: false)
        zone.isOpaque = false
        zone.backgroundColor = .clear
        zone.hasShadow = false
        zone.level = .statusBar + 2
        zone.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        zone.ignoresMouseEvents = false
        zone.isReleasedWhenClosed = false
        zone.sharingType = .none
        let view = HoverView()
        view.onEnter = { [weak self] in self?.scheduleExpand() }
        view.onExit = { [weak self] in self?.pointerLeftHotZone() }
        zone.contentView = view
        zone.orderFrontRegardless()
        hotZone = zone
    }

    private func observe() {
        model.objectWillChange
            .sink { [weak self] _ in self?.scheduleRefresh() }
            .store(in: &cancellables)
        env.store.objectWillChange
            .sink { [weak self] _ in self?.scheduleRefresh() }
            .store(in: &cancellables)
        env.watch.objectWillChange
            .sink { [weak self] _ in self?.scheduleRefresh() }
            .store(in: &cancellables)
        env.store.$settings
            .receive(on: RunLoop.main)
            .sink { [weak self] settings in
                guard let self else { return }
                let quiet = settings.quietMode || self.env.inCall
                if self.model.quiet != quiet { self.model.quiet = quiet }
                if self.model.inputMode != settings.defaultInput { self.model.inputMode = settings.defaultInput }
                self.scheduleRefresh()
            }
            .store(in: &cancellables)
        env.$inCall
            .receive(on: RunLoop.main)
            .sink { [weak self] inCall in
                guard let self else { return }
                let quiet = self.env.store.settings.quietMode || inCall
                if self.model.quiet != quiet { self.model.quiet = quiet }
                self.scheduleRefresh()
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.screensChanged() }
            .store(in: &cancellables)
    }

    private func scheduleRefresh() {
        refreshWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.refresh() }
        }
        refreshWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03, execute: work)
    }

    // MARK: State

    func refresh() {
        guard panel != nil else { return }
        syncRuns()
        let enabled = env.store.settings.notchEnabled
        if !enabled, model.expanded { setExpanded(false, refreshAfter: false) }
        let shouldShow = enabled && (model.expanded || (!model.quiet && model.hasContent))
        if shouldShow { present() } else { dismiss() }
        // The hover strip sits over the menu bar; with the notch off it must not eat clicks there.
        if enabled { hotZone?.orderFrontRegardless() } else { hotZone?.orderOut(nil) }
        reconcileRecordingHUD()
    }

    /// True when a recording in progress is visible here, so the separate HUD pill can stay away.
    var showsRecording: Bool {
        env.store.settings.notchEnabled && !model.quiet
    }

    /// The HUD pill and the island share the top-centre of the screen. Exactly one of them
    /// shows the recording: the island when it can, the pill when the notch is off or quiet.
    private func reconcileRecordingHUD() {
        guard env.watch.isRecording else { return }
        if showsRecording {
            if env.watchHUD.model.visible { env.watchHUD.hide() }
        } else if !env.watchHUD.model.visible {
            env.watchHUD.show()
        }
    }

    /// Copies only what the notch renders out of the store. `liveRuns` also contains
    /// previewing / waiting runs, which the live row can't show (the old empty-panel bug).
    /// The `.watch` run is left out: a recording gets its own row with Save / Discard
    /// instead of a Pause / Stop pair that can't control the recorder.
    private func syncRuns() {
        let waiting = env.store.waitingRuns.map(NotchRunItem.init)
        let live = env.store.liveRuns
            .filter { ($0.status == .running || $0.status == .paused) && $0.kind != .watch }
            .map(NotchRunItem.init)
        if model.waiting != waiting { model.waiting = waiting }
        if model.live != live { model.live = live }
        let recording: NotchRecording? = env.watch.isRecording
            ? NotchRecording(name: env.watch.pendingName, startedAt: env.watch.startedAt ?? Date(), steps: env.watch.steps.count)
            : nil
        if model.recording != recording { model.recording = recording }
    }

    private func present() {
        guard let panel else { return }
        closeWork?.cancel()
        closeWork = nil
        if isVisible {
            if !model.presented { withAnimation(Self.openSpring) { model.presented = true } }
            return
        }
        isVisible = true
        // Start from a generous canvas; it is trimmed to hug the island once the spring settles.
        if !panel.isVisible {
            model.presented = false
            panel.setFrame(windowFrame(for: CGSize(width: model.metrics.maxWidth, height: model.metrics.maxIslandHeight)),
                           display: false)
            panel.orderFrontRegardless()
        } else {
            growWindow(to: CGSize(width: model.metrics.maxWidth, height: model.metrics.maxIslandHeight))
        }
        host?.hoverSize = islandSize
        // Let the closed (notch-sized) state render once, then spring open from it.
        openWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isVisible else { return }
                withAnimation(Self.openSpring) { self.model.presented = true }
                self.scheduleSettle(after: 0.7)
            }
        }
        openWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02, execute: work)
    }

    private func dismiss() {
        guard isVisible else { return }
        isVisible = false
        openWork?.cancel()
        settleWork?.cancel()
        showWork?.cancel()
        hideWork?.cancel()
        removeMonitors()
        model.hoverHold = false
        host?.hoverSize = .zero
        withAnimation(Self.closeSpring) {
            model.expanded = false
            model.presented = false
        }
        closeWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.isVisible else { return }
                self.panel?.orderOut(nil)
            }
        }
        closeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.42, execute: work)
    }

    private func setExpanded(_ value: Bool, refreshAfter: Bool = true) {
        if value {
            guard env.store.settings.notchEnabled else { return }
            hideWork?.cancel()
            if !model.expanded { model.expanded = true }
            installMonitors()
        } else {
            if model.expanded { model.expanded = false }
            removeMonitors()
        }
        if refreshAfter { refresh() }
    }

    // MARK: Geometry

    private var panelTop: CGFloat {
        model.metrics.hasNotch ? screen.frame.maxY : screen.visibleFrame.maxY
    }

    private func windowFrame(for island: CGSize) -> NSRect {
        let width = NotchMetrics.even(min(island.width + marginX * 2, screen.frame.width))
        let height = (island.height + model.metrics.topGap + marginBottom).rounded(.up)
        let x = (screen.frame.midX - width / 2).rounded()
        return NSRect(x: x, y: panelTop - height, width: width, height: height)
    }

    /// The island in screen coordinates (for pointer checks).
    private var islandScreenRect: NSRect {
        let size = islandSize
        return NSRect(x: screen.frame.midX - size.width / 2,
                      y: panelTop - model.metrics.topGap - size.height,
                      width: size.width, height: size.height)
    }

    private func hotZoneFrame() -> NSRect {
        let m = model.metrics
        if m.hasNotch {
            // Barely wider than the notch: the zone takes clicks, so anything wider swallows
            // clicks on the menu bar items that sit right beside the notch.
            let width = m.notchWidth + 12
            return NSRect(x: (screen.frame.midX - width / 2).rounded(), y: screen.frame.maxY - m.notchHeight,
                          width: width, height: m.notchHeight)
        }
        let width: CGFloat = 220
        return NSRect(x: (screen.frame.midX - width / 2).rounded(), y: screen.frame.maxY - 6, width: width, height: 6)
    }

    /// Fixed canvas big enough for the largest island (expanded, full scroll height) + shadow margin.
    private var canvasSize: CGSize {
        let m = model.metrics
        return CGSize(width: NotchMetrics.even(min(m.expandedWidth + marginX * 2, screen.frame.width)),
                      height: (m.maxIslandHeight + m.topGap + marginBottom).rounded(.up))
    }

    private func layoutCanvas() {
        guard let host, let container else { return }
        let size = canvasSize
        host.frame = NSRect(x: ((container.bounds.width - size.width) / 2).rounded(),
                            y: container.bounds.height - size.height,
                            width: size.width, height: size.height)
    }

    private func islandSizeChanged(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        islandSize = size
        guard isVisible else { return }
        host?.hoverSize = size
        // Called from inside a SwiftUI update; resize the window on the next turn, outside it.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isVisible else { return }
            self.growWindow(to: self.islandSize)
            self.scheduleSettle(after: 0.6)
        }
    }

    /// Grow at once (never clip the island mid-spring); shrinking waits for `scheduleSettle`.
    private func growWindow(to island: CGSize) {
        guard let panel else { return }
        let target = windowFrame(for: island)
        let current = panel.frame
        let sameAnchor = abs(current.maxY - target.maxY) < 0.5 && abs(current.midX - target.midX) < 1
        guard !sameAnchor || target.width > current.width + 0.5 || target.height > current.height + 0.5 else { return }
        let width = sameAnchor ? max(target.width, current.width) : target.width
        let height = sameAnchor ? max(target.height, current.height) : target.height
        let frame = NSRect(x: (screen.frame.midX - width / 2).rounded(), y: target.maxY - height, width: width, height: height)
        panel.setFrame(frame, display: true)
    }

    private func scheduleSettle(after delay: TimeInterval) {
        settleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isVisible, let panel = self.panel, self.islandSize.width > 0 else { return }
                let target = self.windowFrame(for: self.islandSize)
                if !NSEqualRects(panel.frame, target) { panel.setFrame(target, display: true) }
            }
        }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func screensChanged() {
        guard !NSScreen.screens.isEmpty else { return }
        let next = NSScreen.okidokiPrimary
        screen = next
        let metrics = NotchMetrics(screen: next)
        if model.metrics != metrics { model.metrics = metrics }
        host?.hoverTopInset = metrics.topGap
        layoutCanvas()
        hotZone?.setFrame(hotZoneFrame(), display: false)
        hotZone?.orderFrontRegardless()
        if isVisible, let panel {
            panel.setFrame(windowFrame(for: CGSize(width: metrics.maxWidth, height: metrics.maxIslandHeight)), display: true)
            scheduleSettle(after: 0.6)
        }
    }

    // MARK: Hover

    private func scheduleExpand() {
        guard env.store.settings.notchEnabled else { return }
        guard Date().timeIntervalSince(lastManualClose) > 0.6 else { return }
        model.hoverHold = true
        hideWork?.cancel()
        showWork?.cancel()
        // A short dwell so sweeping to the menu bar doesn't pop the island open.
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let pointer = NSEvent.mouseLocation
                let inZone = self.hotZone?.frame.insetBy(dx: -2, dy: -2).contains(pointer) ?? false
                guard inZone || (self.isVisible && self.islandScreenRect.contains(pointer)) else { return }
                self.setExpanded(true)
            }
        }
        showWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    private func pointerLeftHotZone() {
        showWork?.cancel()
        if !pointerInIsland { model.hoverHold = false }
        if model.expanded { scheduleCollapse(after: 0.35) }
    }

    private func pointerEnteredIsland() {
        hideWork?.cancel()
        model.hoverHold = true
    }

    private func pointerExitedIsland() {
        model.hoverHold = false
        if model.expanded { scheduleCollapse(after: 0.35) }
    }

    private var pointerInIsland: Bool {
        isVisible && islandScreenRect.insetBy(dx: -4, dy: -4).contains(NSEvent.mouseLocation)
    }

    private func scheduleCollapse(after delay: TimeInterval) {
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let pointer = NSEvent.mouseLocation
                if self.pointerInIsland { return }
                if let zone = self.hotZone, zone.frame.contains(pointer) { return }
                self.model.hoverHold = false
                self.setExpanded(false)
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: Monitors (only while expanded)

    private func installMonitors() {
        if escapeMonitor == nil {
            escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                // Only swallow Esc aimed at the notch itself, never the dashboard's or summon's.
                guard event.keyCode == 53 else { return event }
                let handled: Bool = MainActor.assumeIsolated {
                    guard let self, let panel = self.panel, event.window === panel, self.model.expanded else { return false }
                    self.lastManualClose = Date()
                    self.setExpanded(false)
                    return true
                }
                return handled ? nil : event
            }
        }
        if globalEscapeMonitor == nil {
            // The island opens on hover and never takes key (that would steal typing from the
            // app you're in), so Esc usually goes to another app: watch for it there too.
            // Global key monitors need Accessibility, which okidoki already asks for.
            globalEscapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.keyCode == 53 else { return }
                MainActor.assumeIsolated {
                    guard let self, self.model.expanded else { return }
                    self.lastManualClose = Date()
                    self.setExpanded(false)
                }
            }
        }
        if clickMonitor == nil {
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.model.expanded, !self.pointerInIsland else { return }
                    self.lastManualClose = Date()
                    self.setExpanded(false)
                }
            }
        }
    }

    private func removeMonitors() {
        if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
        escapeMonitor = nil
        if let globalEscapeMonitor { NSEvent.removeMonitor(globalEscapeMonitor) }
        globalEscapeMonitor = nil
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
    }

    // MARK: Public API

    /// Collapses the island and clears its toasts (same behaviour as before the redesign).
    func collapse() {
        lastManualClose = Date()
        model.clear()
        setExpanded(false)
    }

    func noteListening(_ listening: Bool) {
        if model.listening != listening { model.listening = listening }
        scheduleRefresh()
    }
}
