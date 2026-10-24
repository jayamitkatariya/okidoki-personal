import AppKit
import QuartzCore
import SwiftUI

private let companionMarkSize: CGFloat = 24
/// Room around the mark so the listening bob never clips.
private let companionPad: CGFloat = 6

@MainActor
final class GlowModel: ObservableObject {
    @Published var active = false
    @Published var listening = false
}

/// The ring-arrow brand mark riding just below-right of the real pointer while okidoki
/// is engaged. macOS won't let apps recolor the system cursor, so the mark tags along.
struct CursorGlowView: View {
    @ObservedObject var model: GlowModel
    @State private var markImage = OKBrandMark.image(pointSize: companionMarkSize)

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: !model.listening)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Image(nsImage: markImage)
                .resizable()
                .frame(width: companionMarkSize, height: companionMarkSize)
                .shadow(color: .black.opacity(0.18), radius: 2.5, y: 1)
                .offset(y: model.listening ? CGFloat(sin(t * 2.6)) * 2.2 : 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .scaleEffect(model.active ? 1 : 0.6)
        .opacity(model.active ? 1 : 0)
        .animation(OKMotion.snappy, value: model.active)
        .allowsHitTesting(false)
    }
}

final class GlowPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Moves a tiny click-through panel with the pointer. A display-linked spring eases the
/// mark onto the cursor so it glides instead of stepping, and catches up when you flick.
@MainActor
final class CursorGlowController {
    let model = GlowModel()
    private var panel: GlowPanel?
    private var tracker: GlowTracker?
    private var shown = CGPoint.zero
    private var velocity = CGPoint.zero
    private var primed = false
    private var hideGeneration = 0

    init() {}

    func install() {
        guard panel == nil else { return }
        let side = companionMarkSize + companionPad * 2
        let panel = GlowPanel(contentRect: NSRect(x: 0, y: 0, width: side, height: side),
                              styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Above the summon box and the drawing canvas; it never takes clicks.
        panel.level = .statusBar + 6
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.contentView = NSHostingView(rootView: CursorGlowView(model: model))
        panel.orderOut(nil)
        self.panel = panel
    }

    func show(listening: Bool) {
        install()
        hideGeneration += 1
        model.listening = listening
        if let panel {
            let origin = Self.origin(for: NSEvent.mouseLocation, panelSide: panel.frame.width)
            shown = origin
            velocity = .zero
            primed = true
            panel.setFrameOrigin(origin)
        }
        panel?.orderFrontRegardless()
        model.active = true
        startTracking()
    }

    func setListening(_ listening: Bool) {
        model.listening = listening
    }

    func hide() {
        guard model.active || panel?.isVisible == true else { return }
        model.active = false
        model.listening = false
        hideGeneration += 1
        let generation = hideGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self, self.hideGeneration == generation else { return }
            self.stopTracking()
            self.panel?.orderOut(nil)
        }
    }

    // MARK: Tracking

    private func startTracking() {
        guard let view = panel?.contentView else { return }
        if tracker == nil {
            let tracker = GlowTracker()
            tracker.controller = self
            self.tracker = tracker
        }
        tracker?.start(on: view)
    }

    private func stopTracking() {
        tracker?.stop()
        primed = false
        velocity = .zero
    }

    /// One display frame of a critically damped spring toward the pointer.
    fileprivate func integrate(dt raw: CFTimeInterval) {
        guard let panel else { return }
        let target = Self.origin(for: NSEvent.mouseLocation, panelSide: panel.frame.width)
        guard primed else {
            primed = true
            shown = target
            velocity = .zero
            panel.setFrameOrigin(target)
            return
        }
        let error = hypot(target.x - shown.x, target.y - shown.y)
        // A screen-edge flip, or the pointer warping, should not streak the mark across the display.
        if error > 180 {
            shown = target
            velocity = .zero
            panel.setFrameOrigin(target)
            return
        }
        if error < 0.15 && hypot(velocity.x, velocity.y) < 0.4 { return }

        let dt = min(max(CGFloat(raw), 1.0 / 240.0), 1.0 / 30.0)
        // Close in, glide. Far behind (a fast flick), stiffen so the mark doesn't lag off the cursor.
        let response: CGFloat = error > 28 ? 0.038 : 0.062
        let omega = 2 * CGFloat.pi / response
        let stiffness = omega * omega
        let damping = 2 * omega
        var remaining = dt
        let substep: CGFloat = 1.0 / 480.0
        while remaining > 0 {
            let h = min(substep, remaining)
            let ax = -stiffness * (shown.x - target.x) - damping * velocity.x
            let ay = -stiffness * (shown.y - target.y) - damping * velocity.y
            velocity.x += ax * h
            velocity.y += ay * h
            shown.x += velocity.x * h
            shown.y += velocity.y * h
            remaining -= h
        }
        panel.setFrameOrigin(shown)
    }

    /// Lower-right of the pointer, flipping left/up near a screen edge.
    static func origin(for mouse: CGPoint, panelSide: CGFloat) -> CGPoint {
        let gapX: CGFloat = 8
        let gapY: CGFloat = 10
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })?.frame
            ?? CGRect(origin: .zero, size: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        var x = mouse.x + gapX - companionPad
        var y = mouse.y - gapY - companionMarkSize - companionPad
        if x + panelSide > screen.maxX { x = mouse.x - gapX - companionMarkSize - companionPad }
        if y < screen.minY { y = mouse.y + gapY - companionPad }
        return CGPoint(x: x, y: y)
    }
}

/// Display-linked driver. `CADisplayLink` needs an `NSObject` target; the controller stays the owner.
@MainActor
private final class GlowTracker: NSObject {
    weak var controller: CursorGlowController?
    private var link: CADisplayLink?
    private var lastTimestamp: CFTimeInterval = 0

    func start(on view: NSView) {
        guard link == nil else { return }
        lastTimestamp = 0
        let link = view.displayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
        lastTimestamp = 0
    }

    @objc private func step(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTimestamp == 0 ? 1.0 / 120.0 : now - lastTimestamp
        lastTimestamp = now
        controller?.integrate(dt: dt)
    }
}

extension NSScreen {
    /// The notched screen, else the menu-bar screen. Not `NSScreen.main` (the screen with the
    /// key window), which changes with focus and made the notch pill hop between displays.
    static var okidokiPrimary: NSScreen {
        // Mid-reconfiguration (clamshell, display sleep) the list can be empty for a moment.
        if let screen = NSScreen.screens.first(where: { $0.okidokiHasNotch }) ?? NSScreen.screens.first ?? NSScreen.main {
            lastPrimary = screen
            return screen
        }
        return lastPrimary ?? NSScreen.screens[0]
    }
    private nonisolated(unsafe) static var lastPrimary: NSScreen?

    var okidokiHasNotch: Bool {
        if #available(macOS 12.0, *) {
            return safeAreaInsets.top > 0 && auxiliaryTopLeftArea != nil
        }
        return false
    }

    var okidokiNotchHeight: CGFloat {
        if #available(macOS 12.0, *) { return okidokiHasNotch ? safeAreaInsets.top : 0 }
        return 0
    }

    var okidokiNotchWidth: CGFloat {
        if #available(macOS 12.0, *), let left = auxiliaryTopLeftArea, let right = auxiliaryTopRightArea {
            return frame.width - left.width - right.width
        }
        return 180
    }
}
