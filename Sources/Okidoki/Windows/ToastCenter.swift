import AppKit
import Combine
import SwiftUI
import OkidokiCore

// MARK: - Model

/// One notification. The island is for things that need you (a run waiting, a recording, a caption);
/// this is for what just happened — saved, failed, couldn't connect.
struct ToastNote: Identifiable {
    var id: String = UUID().uuidString
    var title: String
    var detail: String
    var kind: ToastKind
    var actionLabel: String?
    var action: (() -> Void)?
    var expiresAt: Date
}

@MainActor
final class ToastCenterModel: ObservableObject {
    @Published private(set) var notes: [ToastNote] = []

    /// Pointer is over a card: nothing expires out from under the cursor.
    var hoverHold = false

    /// Newest first, and never more than a glance's worth on screen.
    static let limit = 3

    private var expiry: [String: DispatchWorkItem] = [:]

    func add(_ note: ToastNote) {
        notes.insert(note, at: 0)
        while notes.count > Self.limit {
            let dropped = notes.removeLast()
            forget(dropped.id)
        }
        schedule(note.id, after: note.expiresAt.timeIntervalSinceNow)
    }

    func remove(_ id: String) {
        notes.removeAll { $0.id == id }
        forget(id)
    }

    func run(_ id: String) {
        let action = notes.first { $0.id == id }?.action
        remove(id)
        action?()
    }

    func clear() {
        notes.removeAll()
        expiry.values.forEach { $0.cancel() }
        expiry.removeAll()
    }

    private func forget(_ id: String) {
        expiry[id]?.cancel()
        expiry[id] = nil
    }

    private func schedule(_ id: String, after delay: TimeInterval) {
        expiry[id]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.notes.contains(where: { $0.id == id }) else { return }
                // Under the cursor it waits, then looks again a moment later.
                if self.hoverHold {
                    self.schedule(id, after: 1.4)
                } else {
                    self.remove(id)
                }
            }
        }
        expiry[id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.2, delay), execute: work)
    }
}

// MARK: - Palette

/// The same values the panel uses in `web/src/styles/shell.css`, so a notification is the app's
/// own card and not a system one. The island is dark by design; these follow the app's appearance.
private struct ToastPalette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }

    var card: Color { dark ? Color(hex: 0x1D2220) : Color(hex: 0xFFFFFF) }
    var line: Color { dark ? Color.white.opacity(0.09) : Color.black.opacity(0.07) }
    var ink: Color { dark ? Color(hex: 0xEEF2EF) : Color(hex: 0x111613) }
    var secondary: Color { dark ? Color(hex: 0x9BA49F) : Color(hex: 0x5F6964) }
    var hover: Color { dark ? Color.white.opacity(0.06) : Color.black.opacity(0.045) }
    var green: Color { dark ? Color(hex: 0x4CD774) : Color(hex: 0x0B7A45) }
    var amber: Color { dark ? Color(hex: 0xF0B14A) : Color(hex: 0xB36B00) }
    var red: Color { dark ? Color(hex: 0xF07070) : Color(hex: 0xC93C3C) }
}

private func tintColor(for kind: ToastKind, _ p: ToastPalette) -> Color {
    switch kind {
    case .success: return p.green
    case .warning, .approval: return p.amber
    case .info: return p.secondary
    }
}

private func symbol(_ kind: ToastKind) -> String {
    switch kind {
    case .success: return "checkmark"
    case .warning: return "exclamationmark"
    case .approval: return "hand.raised.fill"
    case .info: return "info"
    }
}

// MARK: - View

struct ToastCenterView: View {
    @ObservedObject var model: ToastCenterModel
    var onSize: (CGSize) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovered: String?

    private var palette: ToastPalette { ToastPalette(scheme) }

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(model.notes) { note in
                card(note)
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing).combined(with: .opacity),
                        removal: .opacity.combined(with: .scale(scale: 0.97))
                    ))
            }
        }
        .frame(width: ToastCenter.width, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
        // Room for the cards' shadow. The window is sized to this, so the shadow rolls off into
        // nothing instead of being cut into a faint rectangle at the window's edge. Above the card
        // there is only the gap to the menu bar to spend, and the shadow's upward falloff (radius
        // minus its downward offset) fits in it exactly.
        .padding(.top, ToastCenter.shadowTopInset)
        .padding(.horizontal, ToastCenter.shadowInset)
        .padding(.bottom, ToastCenter.shadowInset)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { onSize($0) }
        .onHover { inside in
            model.hoverHold = inside
            if !inside { hovered = nil }
        }
        .animation(.spring(response: 0.34, dampingFraction: 0.86), value: model.notes.map(\.id))
    }

    private func card(_ note: ToastNote) -> some View {
        let accent = tintColor(for: note.kind, palette)
        let hot = hovered == note.id
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol(note.kind))
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(accent)
                .frame(width: 20, height: 20)
                .background(Circle().fill(accent.opacity(0.14)))

            VStack(alignment: .leading, spacing: 2) {
                Text(note.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(palette.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if !note.detail.isEmpty {
                    Text(note.detail)
                        .font(.system(size: 12))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let label = note.actionLabel {
                Button(label) { model.run(note.id) }
                    .buttonStyle(ToastActionStyle(palette: palette))
            }

            Button { model.remove(note.id) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(hot ? palette.hover : .clear))
            }
            .buttonStyle(.plain)
            .opacity(hot ? 1 : 0.55)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .frame(width: ToastCenter.width - 28, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(palette.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(palette.line, lineWidth: 1)
        )
        .shadow(color: .black.opacity(palette.dark ? 0.5 : 0.12), radius: 18, y: 8)
        .onHover { hovered = $0 ? note.id : (hovered == note.id ? nil : hovered) }
    }
}

private struct ToastActionStyle: ButtonStyle {
    let palette: ToastPalette
    @State private var hovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(palette.ink)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(hovering ? palette.hover : palette.hover.opacity(0.6))
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

// MARK: - Controller

@MainActor
final class ToastCenter {
    /// Wide enough for a title, a detail and one action without crowding.
    static let width: CGFloat = 360

    /// Transparent margin around the cards so their shadow isn't clipped by the window. A shadow
    /// (radius 18, offset 8) still has visible weight ~30pt out; cutting it short paints a faint
    /// rectangle the size of the window around the notification.
    static let shadowInset: CGFloat = 32
    /// Above the card there is only the 12pt gap to the menu bar to spend: the shadow's upward
    /// falloff is radius less its downward offset, so 12pt already covers it.
    static let shadowTopInset: CGFloat = 12

    let model = ToastCenterModel()
    private var panel: NSPanel?
    private var host: ToastHostingView<ToastCenterView>?
    /// Starts at a card's worth so the first frame isn't a 1pt sliver; the content then corrects it.
    /// The view measures its full height (cards + the shadow margin), so this includes both.
    private var height: CGFloat = 96 + ToastCenter.shadowInset * 2
    private var cancellables = Set<AnyCancellable>()

    init() {
        // Any change to the notes re-fits and re-positions the window.
        model.$notes
            .receive(on: RunLoop.main)
            .sink { [weak self] notes in
                MainActor.assumeIsolated { self?.refresh(visible: !notes.isEmpty) }
            }
            .store(in: &cancellables)
    }

    func show(_ note: ToastNote) {
        model.add(note)
    }

    func hideAll() {
        model.clear()
    }

    private func refresh(visible: Bool) {
        guard visible else {
            panel?.orderOut(nil)
            return
        }
        let panel = self.panel ?? build()
        // Measure the cards before the window is placed or drawn. Showing at the old height and
        // correcting a frame later clipped a taller card for a moment — the cropped rectangle.
        if let measured = host?.measuredHeight(), measured > 0 {
            height = measured
        }
        layout(panel)
        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        } else if panel.alphaValue < 1 {
            panel.alphaValue = 1
        }
    }

    private func build() -> NSPanel {
        let panel = ToastPanel(contentRect: NSRect(x: 0, y: 0,
                                                   width: Self.width + Self.shadowInset * 2,
                                                   height: 1 + Self.shadowInset * 2),
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The card's own shadow is drawn in SwiftUI inside the window; a window shadow would
        // outline the transparent canvas as a rectangle.
        panel.hasShadow = false
        panel.level = .statusBar + 1
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.acceptsMouseMovedEvents = true
        let host = ToastHostingView(rootView: ToastCenterView(model: model) { [weak self] size in
            MainActor.assumeIsolated { self?.contentSizeChanged(size) }
        })
        panel.contentView = host
        panel.orderOut(nil)
        self.host = host
        self.panel = panel
        return panel
    }

    private func contentSizeChanged(_ size: CGSize) {
        guard abs(size.height - height) > 0.5 else { return }
        height = size.height
        if let panel, panel.isVisible { layout(panel) }
    }

    /// Top-right of the primary screen, under the menu bar. The window is larger than the card so the
    /// card's shadow has room to fade out; the card itself keeps the same 12pt margin and width, so
    /// the slide-in from the right lands where it always did.
    private func layout(_ panel: NSPanel) {
        let screen = NSScreen.okidokiPrimary
        let inset = Self.shadowInset
        let topInset = Self.shadowTopInset
        let margin: CGFloat = 12
        let cardHeight = max(1, height - topInset - inset)
        let card = NSRect(x: screen.visibleFrame.maxX - Self.width - margin,
                          y: screen.visibleFrame.maxY - cardHeight - margin,
                          width: Self.width, height: cardHeight)
        // The window's top edge sits `topInset` above the card, which is exactly the gap to the menu
        // bar, so it never rises into it and never takes clicks meant for the clock and status items.
        panel.setFrame(NSRect(x: card.minX - inset, y: card.minY - inset,
                              width: card.width + inset * 2, height: card.height + topInset + inset),
                       display: true)
    }
}

/// Never key: clicking a notification must not pull typing away from the app underneath.
final class ToastPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The window is larger than the cards so their shadow has room to fade out, and it can size the
/// cards before the window is drawn. The margin is transparent and takes no clicks, so it never
/// steals them from the app below.
final class ToastHostingView<Content: View>: NSHostingView<Content> {
    required init(rootView: Content) {
        super.init(rootView: rootView)
        // Never let SwiftUI push min/max sizes onto the window; the controller owns the frame.
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// The cards fill the window minus the shadow margin, so only they answer a click. The view is
    /// flipped, so `minY` is its top edge and the margins run in from each side.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let inset = ToastCenter.shadowInset
        let top = ToastCenter.shadowTopInset
        let cards = NSRect(x: bounds.minX + inset, y: bounds.minY + top,
                           width: bounds.width - inset * 2, height: bounds.height - top - inset)
        return cards.contains(point) ? super.hitTest(point) : nil
    }

    /// The height the content needs right now, measured synchronously.
    ///
    /// The window has to be sized *before* it is drawn: ordered on screen at a stale height and
    /// corrected a frame later, a card taller than the old one was briefly clipped into a cropped
    /// rectangle. Whether that flash showed depended on the toast that came before, which is why
    /// it only looked wrong sometimes.
    func measuredHeight() -> CGFloat {
        let options = sizingOptions
        sizingOptions = [.intrinsicContentSize]
        layoutSubtreeIfNeeded()
        let height = fittingSize.height
        sizingOptions = options
        return height
    }
}
