import AppKit
import QuartzCore
import SwiftUI

// Shared chrome for the floating overlays (summon input + answer card):
// a frosted-glass panel that hugs its SwiftUI content, springs between sizes,
// fades in/out without flashes, and handles its own keyboard (esc, edit shortcuts).

// MARK: - Panel

class OverlayPanel: NSPanel {
    /// Esc pressed while this panel is key (and no IME composition is in progress).
    var onEscape: (() -> Void)?
    /// Plain key presses not consumed by a text field. Return true to swallow.
    var onKeyDown: ((NSEvent) -> Bool)?
    /// ⌘-shortcuts. Return true to swallow.
    var onKeyEquivalent: ((NSEvent) -> Bool)?
    /// The panel's corner radius. The window shadow is shaped with it — a borderless
    /// transparent window otherwise wears a square halo around a rounded panel.
    var cornerRadius: CGFloat = 0

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 320, height: 60),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar + 4
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        isReleasedWhenClosed = false
        sharingType = ProcessInfo.processInfo.environment["OKIDOKI_OVERLAY_PREVIEW"] == "1" ? .readOnly : .none
        animationBehavior = .none
        isMovable = false
        isFloatingPanel = true
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        worksWhenModal = true
        alphaValue = 0
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            let composing = (firstResponder as? NSTextView)?.hasMarkedText() ?? false
            if !composing {
                if event.keyCode == 53, let onEscape {
                    onEscape()
                    return
                }
                let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                if flags.intersection([.command, .control]).isEmpty, let onKeyDown, onKeyDown(event) {
                    return
                }
            }
        }
        super.sendEvent(event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.type == .keyDown else { return super.performKeyEquivalent(with: event) }
        if let onKeyEquivalent, onKeyEquivalent(event) { return true }
        // The app is an accessory with no Edit menu, so wire the standard edit shortcuts by hand.
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command || flags == [.command, .shift] {
            var action: Selector?
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "x": action = #selector(NSText.cut(_:))
            case "c": action = #selector(NSText.copy(_:))
            case "v": action = #selector(NSText.paste(_:))
            case "a": action = #selector(NSText.selectAll(_:))
            case "z": action = flags.contains(.shift) ? Selector(("redo:")) : Selector(("undo:"))
            default: break
            }
            if let action, let responder = firstResponder, responder.tryToPerform(action, with: self) {
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class OverlayHostingView<Content: View>: NSHostingView<Content> {
    required init(rootView: Content) {
        super.init(rootView: rootView)
        // Never let SwiftUI push min/max sizes onto the window; the controller owns the frame.
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// MARK: - Spring frame animator

/// Drives a window's frame with a damped spring on the display link, so size changes
/// retarget smoothly mid-flight instead of snapping or restarting a fixed-duration curve.
@MainActor
final class OverlayFrameAnimator: NSObject {
    private weak var window: NSWindow?
    private var link: CADisplayLink?
    private var value: [CGFloat] = [0, 0, 0, 0]
    private var velocity: [CGFloat] = [0, 0, 0, 0]
    private var target: [CGFloat] = [0, 0, 0, 0]
    private var lastTimestamp: CFTimeInterval = 0

    var response: CGFloat = 0.36
    var dampingFraction: CGFloat = 0.9
    /// The panel's corner radius. The window shadow is shaped with it, so the
    /// overlay never wears a square halo around a rounded body.
    var cornerRadius: CGFloat = 0

    init(window: NSWindow) {
        self.window = window
        super.init()
    }

    var targetFrame: NSRect { NSRect(x: target[0], y: target[1], width: target[2], height: target[3]) }

    func set(_ frame: NSRect, animated: Bool) {
        guard let window else { return }
        target = [frame.minX, frame.minY, frame.width, frame.height]
        guard animated, window.isVisible, let view = window.contentView else {
            stop()
            value = target
            velocity = [0, 0, 0, 0]
            if window.frame != frame { window.setFrame(frame, display: true) }
            shapeShadow()
            return
        }
        if link == nil {
            let current = window.frame
            value = [current.minX, current.minY, current.width, current.height]
            velocity = [0, 0, 0, 0]
            lastTimestamp = 0
            let link = view.displayLink(target: self, selector: #selector(step(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    /// AppKit draws a borderless transparent window's shadow from its frame, which
    /// leaves a square halo around a rounded panel. Point the shadow at the
    /// panel's own rounded outline so the halo follows the shape.
    private func shapeShadow() {
        guard let window, cornerRadius > 0, let view = window.contentView else { return }
        let size = view.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        view.layer?.masksToBounds = false
        view.layer?.shadowPath = CGPath(roundedRect: CGRect(origin: .zero, size: size),
                                        cornerWidth: cornerRadius, cornerHeight: cornerRadius,
                                        transform: nil)
        view.layer?.shadowColor = NSColor.black.cgColor
        view.layer?.shadowOpacity = 0.42
        view.layer?.shadowRadius = 14
        view.layer?.shadowOffset = CGSize(width: 0, height: -5)
    }

    @objc private func step(_ link: CADisplayLink) {
        guard let window else { stop(); return }
        let now = link.timestamp
        var dt = lastTimestamp == 0 ? 1.0 / 120.0 : now - lastTimestamp
        lastTimestamp = now
        dt = min(max(dt, 1.0 / 240.0), 1.0 / 30.0)

        let omega = 2 * CGFloat.pi / response
        let stiffness = omega * omega
        let damping = 2 * dampingFraction * omega
        var remaining = CGFloat(dt)
        let substep: CGFloat = 1.0 / 480.0
        while remaining > 0 {
            let h = min(substep, remaining)
            for i in 0..<4 {
                let accel = -stiffness * (value[i] - target[i]) - damping * velocity[i]
                velocity[i] += accel * h
                value[i] += velocity[i] * h
            }
            remaining -= h
        }

        var settled = true
        for i in 0..<4 where abs(value[i] - target[i]) > 0.2 || abs(velocity[i]) > 1.5 {
            settled = false
        }
        if settled {
            value = target
            velocity = [0, 0, 0, 0]
            stop()
        }
        window.setFrame(NSRect(x: value[0], y: value[1], width: value[2], height: value[3]), display: true)
        shapeShadow()
        if settled { window.invalidateShadow() }
    }
}

// MARK: - Window controller

/// What the panel is made of. Liquid glass is the macOS 26+ material; clear is the
/// more transparent of the two. Older systems fall back to a light blur.
enum OverlaySurface {
    case blur(NSVisualEffectView.Material)
    case liquid
    case liquidClear
}

/// Owns one overlay panel: frosted-glass container, content-hugging height,
/// top-left anchoring, flash-free show/hide.
@MainActor
final class OverlayWindow {
    let panel: OverlayPanel
    let radius: CGFloat
    /// True when the panel itself is system liquid glass, so SwiftUI should not paint a wash over it.
    let isLiquidGlass: Bool
    private let animator: OverlayFrameAnimator
    private let backdrop: NSView
    private var hosting: NSView?

    private(set) var isShown = false
    private var revealed = false
    private var generation = 0
    private var anchor: CGPoint = .zero
    private var screen: NSScreen?

    var width: CGFloat
    private(set) var contentHeight: CGFloat
    /// Called once the panel is key after a show (focus the text field here).
    var onFocused: (() -> Void)?

    init(panel: OverlayPanel, width: CGFloat, estimatedHeight: CGFloat, radius: CGFloat,
         surface: OverlaySurface = .blur(.popover)) {
        self.panel = panel
        self.width = width
        self.contentHeight = estimatedHeight
        self.radius = radius
        self.animator = OverlayFrameAnimator(window: panel)
        self.animator.cornerRadius = radius
        panel.cornerRadius = radius

        switch surface {
        case .liquid, .liquidClear:
            if #available(macOS 26.0, *) {
                let glass = NSGlassEffectView()
                // Regular is the frosted material. Clear lets the page through and the type disappears.
                glass.style = .regular
                glass.cornerRadius = radius
                // Light enough that the material's own highlights survive the SwiftUI wash
                // on top — a heavy tint turns the whole panel into a flat dark sheet.
                glass.tintColor = NSColor(srgbRed: 0.05, green: 0.06, blue: 0.06, alpha: 0.34)
                if #available(macOS 27.0, *) {
                    glass.effectIsInteractive = true
                }
                glass.autoresizingMask = [.width, .height]
                backdrop = glass
                isLiquidGlass = true
                panel.appearance = NSAppearance(named: .darkAqua)
                panel.hasShadow = true
                panel.contentView = glass
            } else {
                backdrop = Self.blurView(material: .popover, radius: radius)
                isLiquidGlass = false
                panel.contentView = backdrop
            }
        case .blur(let material):
            backdrop = Self.blurView(material: material, radius: radius)
            isLiquidGlass = false
            panel.contentView = backdrop
        }
    }

    private static func blurView(material: NSVisualEffectView.Material, radius: CGFloat) -> NSVisualEffectView {
        let effect = NSVisualEffectView()
        effect.material = material
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.isEmphasized = false
        effect.maskImage = maskImage(radius: radius)
        effect.autoresizingMask = [.width, .height]
        return effect
    }

    func setContent<Content: View>(_ view: Content) {
        let host = OverlayHostingView(rootView: view)
        host.frame = backdrop.bounds
        host.autoresizingMask = [.width, .height]
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        if !isLiquidGlass {
            host.layer?.cornerRadius = radius
            host.layer?.cornerCurve = .continuous
            host.layer?.masksToBounds = true
        }
        hosting?.removeFromSuperview()
        if #available(macOS 26.0, *), let glass = backdrop as? NSGlassEffectView {
            glass.contentView = host
        } else {
            backdrop.addSubview(host)
        }
        hosting = host
    }

    /// The frame the panel is at, or heading to.
    var frame: NSRect? {
        guard panel.isVisible, isShown else { return nil }
        return animator.targetFrame.isEmpty ? panel.frame : animator.targetFrame
    }

    var anchorScreen: NSScreen? { screen }

    // MARK: Show / hide

    func show(topLeft: CGPoint, on screen: NSScreen, makeKey: Bool) {
        generation += 1
        let gen = generation
        anchor = topLeft
        self.screen = screen
        panel.ignoresMouseEvents = false
        let wasOnScreen = panel.isVisible && panel.alphaValue > 0.01
        isShown = true

        if wasOnScreen {
            // Already up (or mid fade-out): retarget instead of re-presenting.
            revealed = true
            animator.set(targetFrame(), animated: true)
            fadeIn()
            if makeKey { focus() }
            return
        }

        revealed = false
        animator.stop()
        panel.alphaValue = 0
        animator.set(targetFrame().offsetBy(dx: 0, dy: -8), animated: false)
        panel.orderFrontRegardless()
        if makeKey { focus() }
        hosting?.layoutSubtreeIfNeeded()
        // Reveal a couple of turns later, once SwiftUI has settled on its real height.
        DispatchQueue.main.async { [weak self] in
          DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == gen, self.isShown else { return }
            self.revealed = true
            self.animator.set(self.targetFrame().offsetBy(dx: 0, dy: -8), animated: false)
            self.animator.set(self.targetFrame(), animated: true)
            self.fadeIn()
            self.panel.invalidateShadow()
          }
        }
    }

    func hide(animated: Bool = true, completion: (() -> Void)? = nil) {
        guard isShown || panel.isVisible else { completion?(); return }
        isShown = false
        revealed = false
        generation += 1
        let gen = generation
        panel.ignoresMouseEvents = true
        if !animated || panel.alphaValue < 0.01 {
            animator.stop()
            panel.alphaValue = 0
            panel.orderOut(nil)
            completion?()
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.14
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.generation == gen else { return }
                self.animator.stop()
                self.panel.orderOut(nil)
                completion?()
            }
        })
    }

    func focus() {
        panel.makeKeyAndOrderFront(nil)
        let gen = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == gen, self.isShown else { return }
            if !self.panel.isKeyWindow {
                // Some spaces (full-screen apps, secure input) refuse a non-activating key panel.
                NSApp.activate()
                self.panel.makeKeyAndOrderFront(nil)
            }
            self.onFocused?()
        }
    }

    // MARK: Sizing

    func setContentHeight(_ height: CGFloat) {
        let height = ceil(max(1, height))
        guard abs(height - contentHeight) > 0.5 else { return }
        contentHeight = height
        guard isShown else { return }
        if revealed {
            animator.set(targetFrame(), animated: true)
        } else {
            animator.set(targetFrame().offsetBy(dx: 0, dy: -8), animated: false)
        }
    }

    private func targetFrame() -> NSRect {
        let rect = NSRect(x: anchor.x, y: anchor.y - contentHeight, width: width, height: contentHeight)
        guard let screen = screen ?? OverlayPlacement.screen(containing: anchor) else { return rect }
        return OverlayPlacement.fit(rect, on: screen)
    }

    private func fadeIn() {
        guard panel.alphaValue < 1 else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    private static func maskImage(radius: CGFloat) -> NSImage {
        let cap = ceil(radius * 1.6)
        let side = cap * 2 + 1
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let path = RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(path)
            context.fillPath()
            return true
        }
        image.capInsets = NSEdgeInsets(top: cap, left: cap, bottom: cap, right: cap)
        image.resizingMode = .stretch
        return image
    }
}

// MARK: - Placement

enum OverlayPlacement {
    static let margin: CGFloat = 12

    @MainActor
    static func screen(containing point: CGPoint) -> NSScreen? {
        NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) })
            ?? NSScreen.main ?? NSScreen.screens.first
    }

    @MainActor
    static var mouseScreen: NSScreen? { screen(containing: NSEvent.mouseLocation) }

    /// The area at the top-center that the notch island owns on its screen
    /// (including room for its listening strip), so overlays never sit under it.
    @MainActor
    static func notchKeepOut(on screen: NSScreen) -> NSRect? {
        let primary = NSScreen.okidokiPrimary
        guard primary.frame == screen.frame else { return nil }
        let width: CGFloat = 600
        let reserved: CGFloat = screen.okidokiHasNotch
            ? screen.okidokiNotchHeight + 10 + 64
            : (screen.frame.maxY - screen.visibleFrame.maxY) + 10 + 64
        var rect = NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - reserved,
                          width: width, height: reserved)
        for window in NSApp.windows where !(window is OverlayPanel) && window.isVisible
            && window.level.rawValue > NSWindow.Level.normal.rawValue
            && !window.ignoresMouseEvents // skip full-screen click-through layers (cursor glow etc.)
            && window.frame.height > 30
            && window.frame.width <= 720 && window.frame.height <= screen.frame.height * 0.6
            && window.frame.maxY >= screen.frame.maxY - 12
            && abs(window.frame.midX - screen.frame.midX) < 4 {
            rect = rect.union(window.frame)
        }
        return rect.insetBy(dx: -margin, dy: -margin)
    }

    /// Clamp into the visible frame and step out from under the notch island.
    @MainActor
    static func fit(_ rect: NSRect, on screen: NSScreen) -> NSRect {
        let bounds = screen.visibleFrame.insetBy(dx: margin, dy: margin)
        var frame = clamp(rect, to: bounds)
        if let keepOut = notchKeepOut(on: screen), frame.intersects(keepOut) {
            var below = frame
            below.origin.y = keepOut.minY - frame.height
            if below.minY >= bounds.minY {
                frame = below
            } else {
                // Not enough room underneath: slide to whichever side is closer.
                var side = frame
                side.origin.x = frame.midX < keepOut.midX ? keepOut.minX - frame.width : keepOut.maxX
                frame = clamp(side, to: bounds)
            }
        }
        return frame
    }

    private static func clamp(_ rect: NSRect, to bounds: NSRect) -> NSRect {
        var frame = rect
        frame.size.height = min(frame.height, bounds.height)
        frame.size.width = min(frame.width, bounds.width)
        frame.origin.x = min(max(bounds.minX, frame.minX), bounds.maxX - frame.width)
        frame.origin.y = min(max(bounds.minY, frame.minY), bounds.maxY - frame.height)
        return frame
    }
}

// MARK: - SwiftUI chrome

struct OverlayPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }

    var ink: Color { dark ? Color(hex: 0xF2F5F3) : OKBrand.ink }
    var secondary: Color { dark ? Color.white.opacity(0.62) : OKBrand.ink.opacity(0.62) }
    var tertiary: Color { dark ? Color.white.opacity(0.40) : OKBrand.ink.opacity(0.42) }
    var hairline: Color { dark ? Color.white.opacity(0.11) : Color.black.opacity(0.10) }
    var divider: Color { dark ? Color.white.opacity(0.07) : Color.black.opacity(0.06) }
    var fill: Color { dark ? Color.white.opacity(0.06) : Color.black.opacity(0.045) }
    var accent: Color { dark ? OKBrand.mint : OKBrand.greenInk }
    var danger: Color { dark ? Color(hex: 0xFF7A6B) : Color(hex: 0xD4372A) }

    // MARK: Hover

    /// Hover reads as *light*, not as a gray box: a faint wash plus a hairline edge.
    var hoverFill: Color { dark ? Color.white.opacity(0.11) : Color.black.opacity(0.055) }
    /// The edge that appears when a control is live.
    var hoverEdge: Color { dark ? Color.white.opacity(0.17) : Color.black.opacity(0.10) }
    /// Glyph colour on hover — full-strength ink instead of the resting grey.
    var hoverInk: Color { dark ? Color(hex: 0xFFFFFF) : OKBrand.ink }
    /// Light catching the top edge of the glass.
    var edgeLight: Color { dark ? Color.white.opacity(0.18) : Color.white.opacity(0.55) }
}

/// Root wrapper: natural height, reported upward, over the panel's blur.
///
/// The surface is *graded*, never one flat sheet of black. A flat wash paints
/// over every highlight the material has and leaves a dead rectangle behind —
/// that was what made the overlays read as dull. Instead the panel gets a
/// top-to-bottom falloff, a specular bloom where light catches the top-left
/// corner, and a hairline of light along the top edge.
struct OverlayRoot<Content: View>: View {
    var radius: CGFloat
    var veil: Double = 0.1
    /// The window is already liquid glass. Don't paint a wash over it.
    var bare: Bool = false
    /// A colour that bleeds into the panel from the bottom-right.
    var accent: Color? = nil
    var onHeight: (CGFloat) -> Void
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale
    @State private var hovering = false

    var body: some View {
        let palette = OverlayPalette(scheme)
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { height in
                onHeight(height)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background {
                if !bare {
                    surface(palette: palette)
                }
            }
            .overlay {
                if !bare {
                    shape.strokeBorder(
                        LinearGradient(stops: [
                            .init(color: palette.edgeLight.opacity(hovering ? 1.25 : 1), location: 0),
                            .init(color: palette.hairline, location: 0.42),
                            .init(color: palette.hairline.opacity(0.55), location: 1),
                        ], startPoint: .top, endPoint: .bottom),
                        lineWidth: max(0.5, 1 / max(displayScale, 1))
                    )
                }
            }
            .clipShape(shape)
            .onHover { hovering = $0 }
            .animation(OKMotion.quick, value: hovering)
    }

    /// Three layers: a graded wash, a specular bloom, and an optional accent bleed.
    @ViewBuilder
    private func surface(palette: OverlayPalette) -> some View {
        let base = palette.dark ? Color.black : Color.white
        let top = min(0.46, veil * 1.2)
        let bottom = max(0.10, veil * 0.72)
        ZStack {
            LinearGradient(colors: [base.opacity(top), base.opacity(bottom)],
                           startPoint: .top, endPoint: .bottom)
            // The room light catching the top-left corner of the glass.
            RadialGradient(colors: [Color.white.opacity(palette.dark ? 0.085 : 0.5), Color.white.opacity(0)],
                           center: .topLeading, startRadius: 0, endRadius: radius * 3.4)
            if let accent {
                RadialGradient(colors: [accent.opacity(0.15), accent.opacity(0)],
                               center: .bottomTrailing, startRadius: 0, endRadius: radius * 4.4)
            }
        }
    }
}

// MARK: - Glass surface for panels that aren't already an NSVisualEffectView

enum OverlayGlassTone {
    /// Follows light / dark. Text should use the overlay palette.
    case adaptive
    /// Dark frost with white text. Still translucent — the blur shows the screen through.
    case dark
}

extension View {
    /// Frosted, see-through surface. The hosting panel has to be non-opaque.
    func overlayGlass(cornerRadius: CGFloat, veil: Double = 0.2, tone: OverlayGlassTone = .adaptive) -> some View {
        modifier(OverlayGlassModifier(cornerRadius: cornerRadius, veil: veil, tone: tone))
    }
}

private struct OverlayGlassModifier: ViewModifier {
    var cornerRadius: CGFloat
    var veil: Double
    var tone: OverlayGlassTone
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let dark = tone == .dark || scheme == .dark
        let material: NSVisualEffectView.Material = tone == .dark ? .hudWindow : .popover
        let base = dark ? Color.black : Color.white
        content
            .background {
                ZStack {
                    VisualEffectBlur(material: material, blending: .behindWindow)
                    // Graded, never flat: the bottom of the panel is lighter than the top.
                    LinearGradient(colors: [base.opacity(min(0.78, veil * 1.15)),
                                            base.opacity(max(0.14, veil * 0.66))],
                                   startPoint: .top, endPoint: .bottom)
                    RadialGradient(colors: [Color.white.opacity(dark ? 0.075 : 0.4), Color.white.opacity(0)],
                                   center: .topLeading, startRadius: 0, endRadius: cornerRadius * 3.2)
                }
                .clipShape(shape)
            }
            .overlay {
                shape.strokeBorder(
                    LinearGradient(colors: [Color.white.opacity(dark ? 0.24 : 0.5),
                                            Color.white.opacity(dark ? 0.05 : 0.14)],
                                   startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.5)
            }
            .clipShape(shape)
            .shadow(color: .black.opacity(0.2), radius: 18, y: 8)
            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
    }
}

/// Single-line field that keeps its type optically centered in a tall capsule.
private final class OverlayTextCell: NSTextFieldCell {
    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        let bounds = super.drawingRect(forBounds: rect)
        let font = self.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let textHeight = ceil(font.boundingRectForFont.height)
        let delta = bounds.height - textHeight
        guard delta > 1 else { return bounds }
        return NSRect(x: bounds.minX, y: bounds.minY + delta / 2, width: bounds.width, height: textHeight)
    }

    override func titleRect(forBounds rect: NSRect) -> NSRect { drawingRect(forBounds: rect) }

    override func select(withFrame rect: NSRect, in controlView: NSView, editor textObj: NSText,
                         delegate: Any?, start selStart: Int, length selLength: Int) {
        super.select(withFrame: drawingRect(forBounds: rect), in: controlView, editor: textObj,
                     delegate: delegate, start: selStart, length: selLength)
    }
}

/// AppKit text field so first-responder, Return, Tab and paste behave like a real Mac field.
struct OverlayTextField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var fontSize: CGFloat = 15
    var focusTick: Int
    var onSubmit: () -> Void
    var onTab: (() -> Void)?
    /// Reports when the field takes and loses focus, so the composer can light up.
    var onFocusChange: ((Bool) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        let cell = OverlayTextCell(textCell: text)
        cell.isEditable = true
        cell.isSelectable = true
        cell.isBordered = false
        cell.isBezeled = false
        cell.drawsBackground = false
        cell.usesSingleLineMode = true
        cell.wraps = false
        cell.isScrollable = true
        cell.lineBreakMode = .byClipping
        cell.font = NSFont(name: "Inter-Regular", size: fontSize) ?? .systemFont(ofSize: fontSize)
        field.cell = cell
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = cell.font
        field.textColor = NSColor(calibratedWhite: 0.97, alpha: 1)
        field.appearance = NSAppearance(named: .darkAqua)
        field.usesSingleLineMode = true
        field.lineBreakMode = .byClipping
        field.delegate = context.coordinator
        applyPlaceholder(to: field)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    private func applyPlaceholder(to field: NSTextField) {
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
            .font: field.font as Any,
            .foregroundColor: NSColor(calibratedWhite: 1, alpha: 0.48),
        ])
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.parent = self
        field.textColor = NSColor(calibratedWhite: 0.97, alpha: 1)
        if field.stringValue != text {
            field.stringValue = text
        }
        // The placeholder changes with state ("Ask anything" → "Ask about this").
        if field.placeholderAttributedString?.string != placeholder {
            applyPlaceholder(to: field)
        }
        if context.coordinator.lastFocusTick != focusTick {
            context.coordinator.lastFocusTick = focusTick
            DispatchQueue.main.async { [weak field] in
                guard let field, let window = field.window else { return }
                if window.firstResponder !== field.currentEditor() {
                    window.makeFirstResponder(field)
                }
                if let editor = field.currentEditor() as? NSTextView {
                    editor.insertionPointColor = NSColor(calibratedWhite: 0.97, alpha: 1)
                    editor.selectedRange = NSRange(location: (field.stringValue as NSString).length, length: 0)
                }
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: OverlayTextField
        var lastFocusTick = Int.min

        init(_ parent: OverlayTextField) { self.parent = parent }

        func controlTextDidBeginEditing(_ notification: Notification) {
            guard let field = notification.object as? NSTextField,
                  let editor = field.currentEditor() as? NSTextView else { return }
            let ink = NSColor(calibratedWhite: 0.97, alpha: 1)
            editor.textColor = ink
            editor.insertionPointColor = ink
            editor.selectedTextAttributes = [
                .backgroundColor: NSColor.white.withAlphaComponent(0.22),
                .foregroundColor: NSColor.white,
            ]
            parent.onFocusChange?(true)
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            parent.onFocusChange?(false)
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            if parent.text != field.stringValue { parent.text = field.stringValue }
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                parent.onSubmit()
                return true
            case #selector(NSResponder.insertTab(_:)):
                if let onTab = parent.onTab { onTab(); return true }
                return false
            case #selector(NSResponder.cancelOperation(_:)):
                return true // esc is handled by the panel
            default:
                return false
            }
        }
    }
}

/// Press feedback for the overlay's flat controls: a small, quick squeeze.
struct OverlayPressStyle: ButtonStyle {
    var pressedScale: CGFloat = 0.96
    var pressedOpacity: Double = 1

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? pressedScale : 1)
            .opacity(configuration.isPressed ? pressedOpacity : 1)
            .animation(OKMotion.snappy, value: configuration.isPressed)
    }
}

/// A square icon control that wakes up on hover.
///
/// Resting state is a quiet glyph; hover lights a soft plate behind it, brings
/// the glyph to full ink and lets the whole thing breathe up a touch. The
/// spring (not a linear fade) is what makes it feel alive rather than blinked.
struct OverlayIconButton: View {
    let symbol: String
    var help: String
    var size: CGFloat = 26
    /// Colour of the hover plate and the lit glyph. `nil` uses plain white.
    var tint: Color? = nil
    var action: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let palette = OverlayPalette(scheme)
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.44, weight: .medium))
                .foregroundStyle(hovering ? (tint ?? palette.hoverInk) : palette.secondary)
                .frame(width: size, height: size)
                .background { plate(palette) }
                .contentShape(Rectangle())
        }
        .buttonStyle(OverlayPressStyle(pressedScale: 0.88))
        .scaleEffect(hovering ? 1.08 : 1)
        .onHover { hovering = $0 }
        .animation(OKMotion.snappy, value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    private func plate(_ palette: OverlayPalette) -> some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        let tone = tint ?? .white
        ZStack {
            shape.fill(hovering ? tone.opacity(0.13) : .clear)
            shape.strokeBorder(hovering ? tone.opacity(0.16) : .clear, lineWidth: 1)
        }
        .shadow(color: .black.opacity(hovering ? 0.16 : 0), radius: 6, y: 2)
    }
}

/// The primary action: a green disc that lifts and glows when you reach for it.
struct OverlaySendButton: View {
    var enabled: Bool
    var help: String = "Send"
    var size: CGFloat = 26
    var action: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let palette = OverlayPalette(scheme)
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: size * 0.46, weight: .semibold))
                .foregroundStyle(enabled ? OKBrand.ink : palette.tertiary)
                .offset(y: hovering && enabled ? -0.5 : 0)
                .frame(width: size, height: size)
                .background { disc(palette) }
                .contentShape(Circle())
        }
        .buttonStyle(OverlayPressStyle(pressedScale: 0.86))
        .scaleEffect(hovering && enabled ? 1.08 : 1)
        .disabled(!enabled)
        .onHover { hovering = $0 }
        .animation(OKMotion.snappy, value: hovering)
        .animation(OKMotion.snappy, value: enabled)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    private func disc(_ palette: OverlayPalette) -> some View {
        if enabled {
            Circle()
                .fill(hovering ? OKBrand.greenBright : OKBrand.green)
                .shadow(color: OKBrand.green.opacity(hovering ? 0.55 : 0.28),
                        radius: hovering ? 11 : 6, y: hovering ? 3 : 1)
        } else {
            Circle().fill(palette.fill)
        }
    }
}

/// A calm, smooth activity indicator (no pixel art, no state-driven repeatForever glitches).
struct OverlaySpinner: View {
    var size: CGFloat = 14
    var color: Color = OKBrand.green

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Circle()
                .trim(from: 0, to: 0.72)
                .stroke(color, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                .rotationEffect(.degrees(t.truncatingRemainder(dividingBy: 0.9) / 0.9 * 360))
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Working")
    }
}

/// A labelled action button for the answer card.
///
/// Hover is the whole point: a ghost button grows a surface, a secondary
/// button's edge lights up, a primary button brightens and throws a soft
/// green glow. All of them lift by a pixel so the panel feels tactile.
struct OverlayButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost, danger }
    var kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        OverlayHoverSurface(kind: kind) { configuration.label }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(OKMotion.snappy, value: configuration.isPressed)
    }
}

/// Owns the hover state for `OverlayButtonStyle` — a `ButtonStyle` can't hold
/// `@State` itself, so the surface is a view that does.
private struct OverlayHoverSurface<Content: View>: View {
    let kind: OverlayButtonStyle.Kind
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    private var palette: OverlayPalette { OverlayPalette(scheme) }
    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
    }

    var body: some View {
        let p = palette
        content
            .font(.okBody(12.5, .medium))
            .foregroundStyle(foreground(p))
            .padding(.horizontal, kind == .ghost ? 9 : 13)
            .frame(height: 28)
            .background {
                ZStack {
                    shape.fill(background(p))
                    shape.strokeBorder(border(p), lineWidth: 1)
                }
            }
            .contentShape(shape)
            .offset(y: hovering ? -1 : 0)
            .shadow(color: shadow(p), radius: hovering ? 10 : 0, y: hovering ? 4 : 0)
            .onHover { hovering = $0 }
            .animation(OKMotion.snappy, value: hovering)
    }

    private func foreground(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return OKBrand.ink
        case .secondary: return p.ink
        case .ghost: return hovering ? p.ink : p.secondary
        case .danger: return hovering ? p.danger : p.danger.opacity(0.85)
        }
    }

    private func background(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return hovering ? OKBrand.greenBright : OKBrand.green
        case .secondary: return hovering ? p.hoverFill : p.fill
        case .ghost: return hovering ? p.fill : .clear
        case .danger: return hovering ? p.danger.opacity(0.13) : .clear
        }
    }

    private func border(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return Color.white.opacity(0.18)
        case .secondary: return hovering ? p.hoverEdge : p.hairline
        case .ghost: return hovering ? p.hairline : .clear
        case .danger: return p.danger.opacity(hovering ? 0.5 : 0.3)
        }
    }

    private func shadow(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return OKBrand.green.opacity(hovering ? 0.4 : 0.18)
        case .danger: return p.danger.opacity(hovering ? 0.18 : 0)
        default: return .clear
        }
    }
}

extension String {
    /// "got it." → "Got it." (leaves the rest alone).
    var overlaySentenceCased: String {
        guard let first = first, first.isLowercase else { return self }
        return first.uppercased() + dropFirst()
    }
}
