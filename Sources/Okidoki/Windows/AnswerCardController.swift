import AppKit
import Combine
import SwiftUI
import OkidokiCore

enum CardActionKind {
    case primary, secondary, ghost, danger
}

@MainActor
final class CardAction: Identifiable {
    let id = UUID()
    var title: String
    var kind: CardActionKind
    var glyph: String?
    var handler: () -> Void

    init(title: String, kind: CardActionKind = .secondary, glyph: String? = nil, handler: @escaping () -> Void) {
        self.title = title
        self.kind = kind
        self.glyph = glyph
        self.handler = handler
    }
}

@MainActor
final class AnswerCardModel: ObservableObject {
    let id = UUID().uuidString
    @Published var title: String
    @Published var text: String
    @Published var footnote: String
    @Published var actions: [CardAction]
    @Published var isThinking = false
    @Published var followUpEnabled = true
    @Published var terminalCommands: [String] = []
    @Published var terminalOutput = ""
    @Published var draft = ""
    @Published var threadTitle: String?
    @Published var runID: String?
    var threadID: String?
    var onSubmitFollowUp: ((String) -> Void)?
    var onClose: (() -> Void)?

    init(title: String, text: String, footnote: String = "", actions: [CardAction] = [],
         threadTitle: String? = nil, runID: String? = nil, threadID: String? = nil) {
        self.title = title
        self.text = text
        self.footnote = footnote
        self.actions = actions
        self.threadTitle = threadTitle
        self.runID = runID
        self.threadID = threadID
    }
}

extension AnswerCardModel {
    var primaryAction: CardAction? {
        guard !isThinking else { return nil }
        return actions.prefix(3).first(where: { $0.kind == .primary })
    }
}

final class CardPanel: OverlayPanel {}

/// What the card window is showing right now.
@MainActor
final class AnswerCardState: ObservableObject {
    @Published var card: AnswerCardModel
    @Published var bodyCap: CGFloat = 360
    @Published var focusTick = 0

    init(card: AnswerCardModel) { self.card = card }
}

@MainActor
final class AnswerCardController {
    static let width: CGFloat = 440

    private weak var env: AppEnvironment?
    private var overlay: OverlayWindow?
    private let state = AnswerCardState(card: AnswerCardModel(title: "", text: ""))
    private var current: AnswerCardModel?
    private var previousApp: NSRunningApplication?
    private var cancellables = Set<AnyCancellable>()

    /// Last place a card sat, so follow-ups reappear in the same spot instead of jumping.
    private var lastTopLeft: CGPoint?
    private var lastShownAt: Date?
    /// A follow-up is in flight; the card is showing a thinking placeholder.
    private var pending: AnswerCardModel?
    private var holdingForFollowUp = false
    /// The user dismissed while a request was running: drop its result card.
    private var suppressUntilIdle = false

    init(environment: AppEnvironment) {
        self.env = environment
        environment.$isBusy
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] busy in
                guard let self, !busy else { return }
                self.suppressUntilIdle = false
                // The request finished without producing a card: clear the placeholder.
                if let pending = self.pending, self.current === pending {
                    self.close(restoreApp: false)
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Show

    func show(_ model: AnswerCardModel, near cursor: CGPoint? = nil, makeKey: Bool = true) {
        if suppressUntilIdle, env?.isBusy == true {
            return
        }
        guard let overlay = buildIfNeeded() else { return }
        let wasShowing = overlay.isShown
        if !wasShowing || current == nil {
            let front = NSWorkspace.shared.frontmostApplication
            previousApp = front?.bundleIdentifier == Bundle.main.bundleIdentifier ? nil : front
        }
        pending = nil
        current = model
        withAnimation(wasShowing ? OKMotion.snappy : nil) {
            state.card = model
        }

        let (topLeft, screen) = placement(near: cursor, keepCurrent: wasShowing)
        guard let screen else { return }
        state.bodyCap = bodyCap(on: screen)
        overlay.show(topLeft: topLeft, on: screen, makeKey: makeKey)
        remember(topLeft)

        // The summon capsule hands its spot over to the card.
        if let summon = env?.summon, summon.model.isVisible {
            summon.hideInput()
        }
    }

    private func buildIfNeeded() -> OverlayWindow? {
        if let overlay { return overlay }
        guard let env else { return nil }
        let panel = CardPanel()
        let overlay = OverlayWindow(panel: panel, width: Self.width, estimatedHeight: 180, radius: 20,
                                    surface: .liquid)
        let root = OverlayRoot(radius: overlay.radius, veil: 0.30, bare: false,
                               accent: OKBrand.mint,
                               onHeight: { [weak overlay] height in
            overlay?.setContentHeight(height)
        }) {
            AnswerCardRoot(state: state, controller: self)
        }
        .environmentObject(env)
        .environment(\.colorScheme, .dark)
        overlay.setContent(root)
        overlay.onFocused = { [weak self] in
            guard let self, self.state.card.followUpEnabled, !self.state.card.isThinking else { return }
            self.state.focusTick += 1
        }
        panel.onEscape = { [weak self] in self?.userClosed() }
        panel.onKeyEquivalent = { [weak self] event in
            guard let self else { return false }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            // ⌘↩ runs the primary action.
            if flags == .command, event.keyCode == 36 || event.keyCode == 76,
               let action = self.primaryAction {
                action.handler()
                return true
            }
            return false
        }
        self.overlay = overlay
        return overlay
    }

    var primaryAction: CardAction? { state.card.primaryAction }

    private func placement(near cursor: CGPoint?, keepCurrent: Bool) -> (CGPoint, NSScreen?) {
        // 1. Already on screen: stay exactly where we are.
        if keepCurrent, let frame = overlay?.frame {
            let topLeft = CGPoint(x: frame.minX, y: frame.maxY)
            return (topLeft, overlay?.anchorScreen ?? OverlayPlacement.screen(containing: topLeft))
        }
        // 2. Take over the summon capsule's spot.
        if let frame = summonCapsuleFrame {
            let topLeft = CGPoint(x: frame.minX, y: frame.maxY)
            return (topLeft, OverlayPlacement.screen(containing: CGPoint(x: frame.midX, y: frame.midY)))
        }
        // 3. Near the pointer.
        if let cursor {
            let screen = OverlayPlacement.screen(containing: cursor)
            var x = cursor.x + 22
            if let screen, x + Self.width > screen.visibleFrame.maxX - OverlayPlacement.margin {
                x = cursor.x - 22 - Self.width
            }
            return (CGPoint(x: x, y: cursor.y - 12), screen)
        }
        // 4. Where the last card was, if that was recent (follow-ups).
        if let last = lastTopLeft, let at = lastShownAt, Date().timeIntervalSince(at) < 180,
           let screen = OverlayPlacement.screen(containing: CGPoint(x: last.x + 1, y: last.y - 1)) {
            return (last, screen)
        }
        // 5. Upper-middle of the screen the pointer is on.
        let screen = OverlayPlacement.mouseScreen
        guard let visible = screen?.visibleFrame else { return (.zero, screen) }
        return (CGPoint(x: visible.midX - Self.width / 2, y: visible.maxY - visible.height * 0.2), screen)
    }

    /// The on-screen summon capsule, found by window type so the card doesn't depend on
    /// SummonController internals.
    private var summonCapsuleFrame: NSRect? {
        guard env?.summon.model.isVisible == true else { return nil }
        return NSApp.windows.first(where: {
            $0 is SummonPanel && $0.isVisible && $0.alphaValue > 0.01
        })?.frame
    }

    private func remember(_ topLeft: CGPoint) {
        lastTopLeft = topLeft
        lastShownAt = Date()
    }

    private func bodyCap(on screen: NSScreen?) -> CGFloat {
        let available = (screen?.visibleFrame.height ?? 800) - 2 * OverlayPlacement.margin
        let maxCard = min(600, available)
        // Header, actions, follow-up and footer take roughly this much.
        return max(120, maxCard - 210)
    }

    // MARK: - Close

    func close(restoreApp: Bool = true) {
        if holdingForFollowUp, let card = current, !card.isThinking {
            // A follow-up was just sent from this card: keep the window and show a
            // thinking placeholder until the next answer replaces it.
            beginPending(after: card)
            return
        }
        if let frame = overlay?.frame { remember(CGPoint(x: frame.minX, y: frame.maxY)) }
        pending = nil
        current = nil
        overlay?.hide()
        if restoreApp, NSApp.isActive, let previousApp,
           previousApp.bundleIdentifier != Bundle.main.bundleIdentifier, !previousApp.isTerminated {
            previousApp.activate(options: [])
        }
        previousApp = nil
    }

    /// Drop the next result card(s) until the in-flight request finishes.
    func suppressResultsUntilIdle() {
        if env?.isBusy == true { suppressUntilIdle = true }
    }

    fileprivate func userClosed() {
        if pending != nil, current === pending {
            suppressResultsUntilIdle()
        }
        let card = current
        card?.onClose?()
        if current === card, overlay?.isShown == true { close() }
    }

    fileprivate func submitFollowUp(from card: AnswerCardModel, text: String) {
        holdingForFollowUp = true
        card.onSubmitFollowUp?(text)
        holdingForFollowUp = false
        // If nothing started (or it finished synchronously), don't leave the placeholder up.
        if let pending, current === pending {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self, self.current === pending, self.env?.isBusy != true else { return }
                self.close(restoreApp: false)
            }
        }
    }

    private func beginPending(after card: AnswerCardModel) {
        let placeholder = AnswerCardModel(title: lastFollowUp, text: "", threadTitle: card.threadTitle,
                                          runID: card.runID, threadID: card.threadID)
        placeholder.isThinking = true
        placeholder.followUpEnabled = false
        placeholder.onClose = { [weak self] in self?.close() }
        pending = placeholder
        current = placeholder
        withAnimation(OKMotion.snappy) { state.card = placeholder }
        // Safety net: never leave a spinner up forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            guard let self, self.current === placeholder else { return }
            self.close(restoreApp: false)
        }
    }

    fileprivate var lastFollowUp = ""
}

// MARK: - Views

private struct AnswerCardRoot: View {
    @ObservedObject var state: AnswerCardState
    let controller: AnswerCardController

    var body: some View {
        ZStack(alignment: .top) {
            AnswerCardView(model: state.card, bodyCap: state.bodyCap, focusTick: state.focusTick,
                           onClose: { controller.userClosed() },
                           onFollowUp: { card, text in
                               controller.lastFollowUp = text
                               controller.submitFollowUp(from: card, text: text)
                           })
                .id(state.card.id)
                // The outgoing card leaves almost at once: a full crossfade overlapped two cards'
                // text and held the window at the taller card's height until it finished.
                .transition(.asymmetric(insertion: .opacity,
                                        removal: .opacity.animation(.easeOut(duration: 0.06))))
        }
    }
}

struct AnswerCardView: View {
    @ObservedObject var model: AnswerCardModel
    var bodyCap: CGFloat = 360
    var focusTick: Int = 0
    var onClose: () -> Void = {}
    var onFollowUp: (AnswerCardModel, String) -> Void = { _, _ in }

    @EnvironmentObject private var env: AppEnvironment
    @Environment(\.colorScheme) private var scheme
    @State private var bodyHeight: CGFloat = 0
    @State private var copied = false
    @State private var followUpFocused = false

    private var palette: OverlayPalette { OverlayPalette(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 13)

            content
                .padding(.top, 4)

            if !model.actions.isEmpty && !model.isThinking {
                actionsRow
                    .padding(.horizontal, 18)
                    .padding(.top, 14)
            }

            if model.followUpEnabled && !model.isThinking {
                Rectangle()
                    .fill(palette.divider)
                    .frame(height: 1)
                    .padding(.top, 14)
                followUpField
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }

            if !model.footnote.isEmpty {
                Text(model.footnote.overlaySentenceCased)
                    .font(.okBody(11))
                    .foregroundStyle(palette.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
            }
        }
        .padding(.bottom, 12)
        .frame(width: AnswerCardController.width)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            if let title = model.threadTitle, !title.isEmpty {
                HStack(spacing: 6) {
                    Circle()
                        .fill(palette.accent)
                        .frame(width: 5, height: 5)
                        .shadow(color: palette.accent.opacity(0.5), radius: 3, y: 0)
                    Text(title.overlaySentenceCased)
                        .font(.okBody(11.5, .medium))
                        .tracking(0.2)
                        .foregroundStyle(palette.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            if !model.isThinking {
                OverlayIconButton(symbol: copied ? "checkmark" : "doc.on.doc",
                                  help: copied ? "Copied" : "Copy answer",
                                  size: 24,
                                  tint: copied ? palette.accent : nil) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.text, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { copied = false }
                }
                if env.store.settings.voiceEnabled {
                    OverlayIconButton(symbol: "speaker.wave.2", help: "Read aloud", size: 24) {
                        env.speaker.speak(model.text, voiceID: env.store.settings.voiceID,
                                          speed: env.store.settings.voiceSpeed)
                    }
                }
            }
            OverlayIconButton(symbol: "xmark", help: "Close", size: 24, tint: palette.danger) { onClose() }
        }
    }

    // MARK: Body

    @ViewBuilder private var content: some View {
        if model.isThinking {
            HStack(spacing: 10) {
                OverlaySpinner(size: 14, color: palette.accent)
                Text(model.title.isEmpty ? "Thinking" : model.title.overlaySentenceCased)
                    .font(.okBody(14))
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            if bodyHeight > bodyCap + 0.5 {
                ScrollView(.vertical) { answerText }
                    .scrollIndicators(.automatic)
                    .frame(height: bodyCap)
                    .mask {
                        VStack(spacing: 0) {
                            Color.black
                            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                                .frame(height: 18)
                        }
                    }
            } else {
                answerText
            }
        }
    }

    /// Title + markdown at natural height; measured so long answers switch to a capped scroll.
    private var answerText: some View {
        VStack(alignment: .leading, spacing: 9) {
            if !model.title.isEmpty {
                Text(model.title.overlaySentenceCased)
                    .font(.okBody(17.5, .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.text.isEmpty {
                OKMarkdown(text: model.text, size: 14, color: palette.ink, lineSpacing: 4.4)
                    .textSelection(.enabled)
            }
            if !model.terminalCommands.isEmpty {
                DisclosureGroup("Show commands") {
                    Text(model.terminalCommands.map { "$ " + $0 }.joined(separator: "\n\n"))
                        .font(.okMono(11)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.okBody(12)).foregroundStyle(palette.ink)
            }
            if !model.terminalOutput.isEmpty {
                DisclosureGroup("Show output") {
                    Text(String(model.terminalOutput.suffix(6000)))
                        .font(.okMono(11)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.okBody(12)).foregroundStyle(palette.ink)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.top, 7)
        .padding(.bottom, 2)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            bodyHeight = height
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 8) {
            ForEach(Array(model.actions.prefix(3))) { action in
                Button {
                    action.handler()
                } label: {
                    HStack(spacing: 5) {
                        if let glyph = action.glyph {
                            Image(systemName: glyph)
                                .font(.system(size: 10.5, weight: .semibold))
                        }
                        Text(action.title.overlaySentenceCased)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(OverlayButtonStyle(kind: kind(action.kind)))
            }
            Spacer(minLength: 0)
        }
    }

    /// The composer. It lights up when it has focus, so you always know where
    /// your keystrokes are going.
    private var followUpField: some View {
        HStack(spacing: 8) {
            OverlayTextField(text: $model.draft,
                             placeholder: "Follow up",
                             fontSize: 13,
                             focusTick: focusTick,
                             onSubmit: submitFollowUp,
                             onFocusChange: { followUpFocused = $0 })
                .frame(maxWidth: .infinity)
            OverlaySendButton(enabled: !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                              help: "Send follow-up",
                              size: 24,
                              action: submitFollowUp)
                .scaleEffect(0.9)
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 38)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(palette.fill.opacity(followUpFocused ? 1 : 0.65))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(followUpFocused ? palette.accent.opacity(0.55) : .clear, lineWidth: 1.5)
        }
        .shadow(color: followUpFocused ? palette.accent.opacity(0.16) : .clear, radius: 10, y: 0)
        .animation(OKMotion.snappy, value: followUpFocused)
    }

    private func submitFollowUp() {
        let text = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.draft = ""
        onFollowUp(model, text)
    }

    private func kind(_ kind: CardActionKind) -> OverlayButtonStyle.Kind {
        switch kind {
        case .primary: return .primary
        case .secondary: return .secondary
        case .ghost: return .ghost
        case .danger: return .danger
        }
    }
}
