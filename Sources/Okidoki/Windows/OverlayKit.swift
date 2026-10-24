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
        sharingType = .none
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
        if settled { window.invalidateShadow() }
    }
}

// MARK: - Window controller

/// Owns one overlay panel: frosted-glass container, content-hugging height,
/// top-left anchoring, flash-free show/hide.
@MainActor
final class OverlayWindow {
    let panel: OverlayPanel
    let radius: CGFloat
    private let animator: OverlayFrameAnimator
    private let effect = NSVisualEffectView()
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

    init(panel: OverlayPanel, width: CGFloat, estimatedHeight: CGFloat, radius: CGFloat) {
        self.panel = panel
        self.width = width
        self.contentHeight = estimatedHeight
        self.radius = radius
        self.animator = OverlayFrameAnimator(window: panel)

        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.isEmphasized = false
        effect.maskImage = OverlayWindow.maskImage(radius: radius)
        effect.autoresizingMask = [.width, .height]
        panel.contentView = effect
    }

    func setContent<Content: View>(_ view: Content) {
        let host = OverlayHostingView(rootView: view)
        host.frame = effect.bounds
        host.autoresizingMask = [.width, .height]
        host.wantsLayer = true
        host.layer?.cornerRadius = radius
        host.layer?.cornerCurve = .continuous
        host.layer?.masksToBounds = true
        hosting?.removeFromSuperview()
        effect.addSubview(host)
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

    func move(topLeft: CGPoint, on screen: NSScreen) {
        anchor = topLeft
        self.screen = screen
        guard isShown else { return }
        animator.set(targetFrame(), animated: revealed)
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
    var fillHover: Color { dark ? Color.white.opacity(0.10) : Color.black.opacity(0.07) }
    var accent: Color { dark ? OKBrand.mint : OKBrand.greenInk }
    var danger: Color { dark ? Color(hex: 0xFF7A6B) : Color(hex: 0xD4372A) }
}

/// Root wrapper: lays the content out at its natural height, reports it, and paints
/// the tint + hairline over the window's frosted glass.
struct OverlayRoot<Content: View>: View {
    var radius: CGFloat
    var onHeight: (CGFloat) -> Void
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

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
                ZStack {
                    if palette.dark {
                        Color(hex: 0x08100D).opacity(0.5)
                        LinearGradient(colors: [OKBrand.matDeep.opacity(0.32), .clear],
                                       startPoint: .top, endPoint: .bottom)
                    } else {
                        Color.white.opacity(0.58)
                        LinearGradient(colors: [OKBrand.mint.opacity(0.05), .clear],
                                       startPoint: .top, endPoint: .bottom)
                    }
                }
            }
            .overlay {
                shape.strokeBorder(palette.hairline, lineWidth: max(0.5, 1 / max(displayScale, 1)))
            }
            .overlay {
                if palette.dark {
                    shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.07), .clear],
                                                      startPoint: .top, endPoint: .center),
                                       lineWidth: 1)
                }
            }
            .clipShape(shape)
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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = NSFont(name: "Inter-Regular", size: fontSize) ?? .systemFont(ofSize: fontSize)
        field.textColor = .labelColor
        field.usesSingleLineMode = true
        field.lineBreakMode = .byClipping
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.delegate = context.coordinator
        applyPlaceholder(to: field)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    private func applyPlaceholder(to field: NSTextField) {
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [
            .font: field.font as Any,
            .foregroundColor: NSColor.placeholderTextColor,
        ])
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.parent = self
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
                if let editor = field.currentEditor() {
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

struct OverlayIconButton: View {
    let symbol: String
    var help: String
    var size: CGFloat = 26
    var action: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let palette = OverlayPalette(scheme)
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.46, weight: .medium))
                .foregroundStyle(hovering ? palette.ink : palette.secondary)
                .frame(width: size, height: size)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(hovering ? palette.fillHover : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct OverlaySendButton: View {
    var enabled: Bool
    var help: String = "Send"
    var action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = OverlayPalette(scheme)
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(enabled ? OKBrand.ink : palette.tertiary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(enabled ? OKBrand.green : palette.fill))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .animation(OKMotion.snappy, value: enabled)
        .help(help)
        .accessibilityLabel(help)
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

/// "↵ Ask" style hint: key in secondary, word in tertiary.
struct OverlayKeyHint: View {
    var key: String
    var label: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = OverlayPalette(scheme)
        HStack(spacing: 4) {
            Text(key).font(.okBody(11, .medium)).foregroundStyle(palette.secondary)
            Text(label).font(.okBody(11)).foregroundStyle(palette.tertiary)
        }
        .fixedSize()
    }
}

struct OverlayButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost, danger }
    var kind: Kind
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        let palette = OverlayPalette(scheme)
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        configuration.label
            .font(.okBody(12.5, .medium))
            .foregroundStyle(foreground(palette))
            .padding(.horizontal, kind == .ghost ? 8 : 12)
            .frame(height: 28)
            .background(shape.fill(background(palette)))
            .overlay(shape.strokeBorder(border(palette), lineWidth: 1))
            .contentShape(shape)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(OKMotion.snappy, value: configuration.isPressed)
    }

    private func foreground(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return OKBrand.ink
        case .secondary: return p.ink
        case .ghost: return p.secondary
        case .danger: return p.danger
        }
    }

    private func background(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return OKBrand.green
        case .secondary: return p.fill
        case .ghost, .danger: return .clear
        }
    }

    private func border(_ p: OverlayPalette) -> Color {
        switch kind {
        case .primary: return Color.white.opacity(0.12)
        case .secondary: return p.hairline
        case .ghost: return .clear
        case .danger: return p.danger.opacity(0.35)
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
