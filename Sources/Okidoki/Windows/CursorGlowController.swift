import AppKit
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

/// Moves a tiny click-through panel with the pointer. Mouse monitors give instant updates;
/// a display-rate timer catches anything they miss (drags inside our own windows,
/// other spaces), so the mark never gets left behind — on any screen.
@MainActor
final class CursorGlowController {
    let model = GlowModel()
    private var panel: GlowPanel?
    private var timer: Timer?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var lastMouse = CGPoint(x: CGFloat.nan, y: .nan)
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
        lastMouse = CGPoint(x: CGFloat.nan, y: .nan)
        track()
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
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            MainActor.assumeIsolated { self?.track() }
            return event
        }
    }

    private func stopTracking() {
        timer?.invalidate()
        timer = nil
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        globalMonitor = nil
        localMonitor = nil
    }

    private func track() {
        guard let panel else { return }
        let mouse = NSEvent.mouseLocation
        guard mouse != lastMouse else { return }
        lastMouse = mouse
        panel.setFrameOrigin(Self.origin(for: mouse, panelSide: panel.frame.width))
    }

    /// Lower-right of the pointer, flipping left/up near a screen edge.
    static func origin(for mouse: CGPoint, panelSide: CGFloat) -> CGPoint {
        let gapX: CGFloat = 10
        let gapY: CGFloat = 12
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })?.frame
            ?? CGRect(origin: .zero, size: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        var x = mouse.x + gapX - companionPad
        var y = mouse.y - gapY - companionMarkSize - companionPad
        if x + panelSide > screen.maxX { x = mouse.x - gapX - companionMarkSize - companionPad }
        if y < screen.minY { y = mouse.y + gapY - companionPad }
        return CGPoint(x: x, y: y)
    }
}

extension NSScreen {
    static var okidokiTarget: NSScreen? {
        if let notched = NSScreen.screens.first(where: { $0.okidokiHasNotch }) { return notched }
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main ?? NSScreen.screens.first
    }

    /// The notched screen, else the menu-bar screen. Not `NSScreen.main` (the screen with the
    /// key window), which changes with focus and made the notch pill hop between displays.
    static var okidokiPrimary: NSScreen {
        NSScreen.screens.first(where: { $0.okidokiHasNotch }) ?? NSScreen.screens.first ?? NSScreen.main!
    }

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
