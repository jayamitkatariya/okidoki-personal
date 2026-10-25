import AppKit
import Combine
import SwiftUI
import OkidokiCore

enum SummonPhase: Equatable {
    case hidden
    case listening
    case typing
    case thinking
}

/// Mic level lives in its own object so audio-rate updates only redraw the meter,
/// not the whole capsule (and never the text field).
@MainActor
final class SummonLevelMeter: ObservableObject {
    @Published var level: Double = 0
}

/// Where a request typed at the cursor can go: this Mac, or the agent in one of the work account's spaces.
struct SummonScope: Identifiable, Equatable {
    var id: String
    var name: String
    var joined: Bool
}

@MainActor
final class SummonModel: ObservableObject {
    @Published var phase: SummonPhase = .hidden
    @Published var mode: InputMode = .typing
    @Published var text: String = ""
    /// Enterprise: the spaces a request can be sent to. Empty on a personal or unlinked account.
    @Published var scopes: [SummonScope] = []
    /// "" for this Mac, else a space id. Remembered between summons.
    @Published var scopeID: String = ""
    @Published var transcript: String = ""
    @Published var error: String?
    @Published var attachmentName: String = ""
    @Published var screenshotPNG: Data?
    @Published var selection: CGRect?
    @Published var cursor: CGPoint = .zero
    /// Bumped whenever the text field should take keyboard focus.
    @Published var focusTick = 0

    let meter = SummonLevelMeter()
    var level: Double {
        get { meter.level }
        set { if meter.level != newValue { meter.level = newValue } }
    }

    var onSubmit: ((String, Data?, CGRect?) -> Void)?
    var onCancel: (() -> Void)?
    var onSwitch: ((InputMode) -> Void)?
    var onStopListening: (() -> Void)?
    var onScope: ((String) -> Void)?

    var isVisible: Bool { phase != .hidden }
    var scope: SummonScope? { scopes.first { $0.id == scopeID } }
    var hasAttachment: Bool { screenshotPNG != nil || !attachmentName.isEmpty }

    func clearAttachment() {
        screenshotPNG = nil
        selection = nil
        attachmentName = ""
    }
}

final class SummonPanel: OverlayPanel {}

@MainActor
final class SummonController {
    static let width: CGFloat = 400
    static let rowHeight: CGFloat = 52

    let model = SummonModel()
    private weak var env: AppEnvironment?
    private let speech: SpeechRecognizer
    private let glow: CursorGlowController
    private var overlay: OverlayWindow?
    private var previousApp: NSRunningApplication?
    private var submitted = false
    private var clickMonitor: Any?
    /// The capsule never spins forever: past every timeout in the chain, it says so and hands the text back.
    private var thinkingWatchdog: DispatchWorkItem?
    private static let thinkingLimit: TimeInterval = 100
    private var cancellables = Set<AnyCancellable>()

    init(environment: AppEnvironment, speech: SpeechRecognizer, glow: CursorGlowController) {
        self.env = environment
        self.speech = speech
        self.glow = glow
        model.onSubmit = { [weak self] text, _, _ in self?.submit(text: text) }
        model.onCancel = { [weak self] in self?.env?.dismissSummon() }
        model.onSwitch = { [weak self] mode in self?.switchInput(to: mode) }
        model.onStopListening = { [weak self] in self?.speech.finish() }
        model.onScope = { [weak self] id in
            guard let self else { return }
            self.model.scopeID = id
            self.env?.store.settings.askScope = id
            self.model.focusTick += 1
        }

        // Speech callbacks already arrive on the main actor; wire them once.
        speech.levelObserver = { [weak self] level in
            guard let self, self.model.phase == .listening else { return }
            self.model.level = level
        }
        speech.onUpdate = { [weak self] text in
            guard let self, self.model.phase == .listening else { return }
            self.model.transcript = text
        }
        speech.onFinal = { [weak self] text in
            guard let self, self.model.phase == .listening else { return }
            self.submit(text: text)
        }
        // Surface recognizer failures instead of sitting on "Listening…" forever.
        speech.$error
            .receive(on: RunLoop.main)
            .sink { [weak self] message in
                guard let self, let message, self.model.phase == .listening else { return }
                self.showError(message)
            }
            .store(in: &cancellables)
        // Removing the attachment also wipes its circle off the screen (it used to linger).
        model.$screenshotPNG
            .dropFirst()
            .filter { $0 == nil }
            .sink { [weak self] _ in
                guard let draw = self?.env?.draw, !draw.model.strokes.isEmpty else { return }
                draw.model.strokes = []
            }
            .store(in: &cancellables)
        // Authorization is async: if the mic comes up after we've left voice mode, stop it.
        speech.$isListening
            .receive(on: RunLoop.main)
            .sink { [weak self] listening in
                guard let self, listening, self.model.phase != .listening else { return }
                self.speech.stop(keepTranscript: true)
            }
            .store(in: &cancellables)
    }

    // MARK: - Show

    func start() {
        guard let env else { return }
        if model.isVisible { dismiss(); return }
        submitted = false
        refreshScopes()
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier != Bundle.main.bundleIdentifier {
            previousApp = NSWorkspace.shared.frontmostApplication
        } else {
            previousApp = nil
        }
        model.cursor = NSEvent.mouseLocation
        model.text = ""
        model.transcript = ""
        model.error = nil
        model.clearAttachment()
        model.level = 0
        model.mode = env.store.settings.defaultInput
        model.phase = model.mode == .voice ? .listening : .typing
        present(at: model.cursor)

        env.notch.noteListening(model.mode == .voice)
        glow.show(listening: model.mode == .voice)
        env.draw.arm()
        if model.mode == .voice { beginListening() }
    }

    private func buildIfNeeded() -> OverlayWindow? {
        if let overlay { return overlay }
        guard let env else { return nil }
        let panel = SummonPanel()
        let overlay = OverlayWindow(panel: panel, width: Self.width,
                                    estimatedHeight: Self.rowHeight, radius: Self.rowHeight / 2,
                                    surface: .liquid)
        let root = OverlayRoot(radius: overlay.radius, veil: 0.30, bare: false, onHeight: { [weak overlay] height in
            overlay?.setContentHeight(height)
        }) {
            InputCapsuleView(model: model)
        }
        .environmentObject(env)
        .environment(\.colorScheme, .dark)
        overlay.setContent(root)
        overlay.onFocused = { [weak self] in
            guard let self, self.model.phase == .typing else { return }
            self.model.focusTick += 1
        }
        panel.onEscape = { [weak self] in self?.env?.dismissSummon() }
        panel.onKeyDown = { [weak self] event in self?.handleKeyDown(event) ?? false }
        self.overlay = overlay
        return overlay
    }

    private func present(at point: CGPoint) {
        guard let overlay = buildIfNeeded(),
              let screen = OverlayPlacement.screen(containing: point) else { return }
        // Pointer, then the okidoki mark just below-right of it, then the box beside the mark.
        var x = point.x + 42
        if x + Self.width > screen.visibleFrame.maxX - OverlayPlacement.margin {
            x = point.x - 42 - Self.width
        }
        let top = point.y + 2
        overlay.show(topLeft: CGPoint(x: x, y: top), on: screen, makeKey: true)
        installClickMonitor()
    }

    // MARK: - Voice / typing

    func beginListening() {
        guard model.phase == .listening else { return }
        speech.start()
        glow.show(listening: true)
        env?.notch.noteListening(true)
    }

    func switchInput(to mode: InputMode) {
        guard model.phase == .listening || model.phase == .typing else { return }
        model.error = nil
        if mode == .typing {
            let heard = speech.transcript.isEmpty ? model.transcript : speech.transcript
            speech.stop(keepTranscript: true)
            if !heard.isEmpty { model.text = heard }
            model.level = 0
            model.mode = .typing
            model.phase = .typing
            glow.setListening(false)
            env?.notch.noteListening(false)
            model.focusTick += 1
            overlay?.focus()
        } else {
            model.mode = .voice
            model.phase = .listening
            model.text = ""
            model.transcript = ""
            beginListening()
        }
    }

    private func handleKeyDown(_ event: NSEvent) -> Bool {
        switch model.phase {
        case .listening:
            switch event.keyCode {
            case 36, 76: // return / enter
                let heard = model.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !heard.isEmpty { submit(text: heard) }
                return true
            case 48: // tab
                switchInput(to: .typing)
                return true
            default:
                // Start typing straight away: drop into the field and keep the keystroke.
                guard let chars = event.characters, !chars.isEmpty,
                      chars.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
                      !(event.specialKey != nil) else { return false }
                switchInput(to: .typing)
                model.text += chars
                return true
            }
        case .typing:
            return false
        case .thinking, .hidden:
            return event.keyCode == 36 || event.keyCode == 76
        }
    }

    /// The spaces a request can go to right now. A remembered scope that's gone falls back to this Mac.
    private func refreshScopes() {
        guard let env else { return }
        let work = env.store.activeAccount.kind == .work && env.enterprise.linked
        let scopes = work ? env.enterprise.spaces.map { SummonScope(id: $0.id, name: $0.name, joined: $0.joined) } : []
        if model.scopes != scopes { model.scopes = scopes }
        let remembered = env.store.settings.askScope
        let valid = scopes.contains { $0.id == remembered } ? remembered : ""
        if model.scopeID != valid { model.scopeID = valid }
        if valid.isEmpty, !remembered.isEmpty { env.store.settings.askScope = "" }
    }

    // MARK: - Submit

    private func submit(text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !submitted, model.phase == .listening || model.phase == .typing else { return }
        // Nothing to ask: stay put instead of spinning forever.
        guard !text.isEmpty || model.screenshotPNG != nil else { return }
        submitted = true
        env?.noteSpokenInput(model.mode == .voice)
        speech.stop(keepTranscript: true)
        glow.setListening(false)
        env?.draw.disarm()
        model.transcript = text
        model.level = 0
        model.phase = .thinking
        model.error = nil
        env?.notch.noteListening(false)
        removeClickMonitor()
        armThinkingWatchdog()
        env?.submitSummon(text: text, screenshot: model.screenshotPNG, selection: model.selection,
                          attachmentName: model.attachmentName)
    }

    private func armThinkingWatchdog() {
        thinkingWatchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.model.phase == .thinking else { return }
            self.showError("the model didn't answer — try again")
        }
        thinkingWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.thinkingLimit, execute: work)
    }

    private func clearThinkingWatchdog() {
        thinkingWatchdog?.cancel()
        thinkingWatchdog = nil
    }

    func showError(_ message: String) {
        clearThinkingWatchdog()
        speech.stop(keepTranscript: true)
        glow.setListening(false)
        env?.notch.noteListening(false)
        if model.mode == .voice || model.phase == .thinking {
            if model.text.isEmpty, !model.transcript.isEmpty { model.text = model.transcript }
            model.mode = .typing
            model.phase = .typing
            submitted = false
            model.focusTick += 1
            env?.draw.arm()
        }
        model.error = message
    }

    // MARK: - Drawing

    func setAttachment(name: String, image: Data?, selection: CGRect?) {
        model.attachmentName = name
        model.screenshotPNG = image
        model.selection = selection
    }

    /// Something was circled on the canvas under the box: attach it, keep whatever
    /// mode you were in (you can talk while you circle).
    func attachSelection(name: String, image: Data?, selection: CGRect?) {
        guard model.phase == .listening || model.phase == .typing, image != nil else { return }
        setAttachment(name: name, image: image, selection: selection)
        if model.phase == .typing { model.focusTick += 1 }
        overlay?.focus()
    }

    // MARK: - Hide

    /// Hide after a request was handed off (a card or another surface takes over).
    func hideInput() {
        clearThinkingWatchdog()
        guard model.isVisible || overlay?.isShown == true else { return }
        speech.stop(keepTranscript: true)
        glow.hide()
        env?.draw.disarm()
        removeClickMonitor()
        overlay?.hide()
        env?.notch.noteListening(false)
        model.phase = .hidden
        model.level = 0
        if !(env?.answerControllerVisible ?? false) { restorePreviousApp() }
        previousApp = nil
    }

    func dismiss() {
        clearThinkingWatchdog()
        if model.phase == .thinking {
            // The user backed out mid-request: don't pop its answer up afterwards.
            env?.answerController.suppressResultsUntilIdle()
        }
        speech.stop()
        glow.hide()
        env?.draw.disarm()
        removeClickMonitor()
        overlay?.hide()
        model.phase = .hidden
        model.level = 0
        submitted = false
        env?.notch.noteListening(false)
        restorePreviousApp()
        previousApp = nil
    }

    private func restorePreviousApp() {
        guard NSApp.isActive, let previousApp,
              previousApp.bundleIdentifier != Bundle.main.bundleIdentifier,
              !previousApp.isTerminated else { return }
        previousApp.activate(options: [])
    }

    // MARK: - Click away

    private func installClickMonitor() {
        removeClickMonitor()
        // Clicking another app with nothing typed puts the capsule away (global monitors
        // only see clicks outside our own windows).
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.clickedAway() }
        }
    }

    /// A plain click outside the box (another app, or the canvas under the box):
    /// with nothing asked yet, put okidoki away.
    func clickedAway() {
        let empty: Bool
        switch model.phase {
        case .typing:
            empty = model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.hasAttachment
        case .listening:
            empty = model.transcript.isEmpty && !model.hasAttachment
        default:
            empty = false
        }
        if empty { env?.dismissSummon() }
    }

    private func removeClickMonitor() {
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
    }
}

// MARK: - Capsule view

/// One airy row: the question, and a send arrow once there's something to send.
/// The brand mark leads the row; send and close trail it. Tab flips voice/typing,
/// dragging on the screen circles something, esc closes.
struct InputCapsuleView: View {
    @ObservedObject var model: SummonModel
    @Environment(\.colorScheme) private var scheme

    private var palette: OverlayPalette { OverlayPalette(scheme) }
    private var canSend: Bool {
        !model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.screenshotPNG != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            mainRow
                .frame(height: SummonController.rowHeight)

            if model.hasAttachment && model.phase != .thinking {
                attachmentChip
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            if let error = model.error, model.phase != .thinking {
                errorRow(error)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(OKMotion.snappy, value: model.phase)
        .animation(OKMotion.snappy, value: model.error)
        .animation(OKMotion.snappy, value: model.hasAttachment)
    }

    @ViewBuilder private var mainRow: some View {
        HStack(spacing: 10) {
            leading
                .frame(width: 18, height: 18)

            Rectangle()
                .fill(palette.divider)
                .frame(width: 1, height: 16)

            if !model.scopes.isEmpty, model.phase != .thinking {
                SummonScopeChip(model: model, palette: palette)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }

            switch model.phase {
            case .typing, .hidden:
                OverlayTextField(text: $model.text,
                                 placeholder: model.hasAttachment ? "About this" : (model.scope.map { "Ask #\($0.name)" } ?? "Ask anything"),
                                 fontSize: 15,
                                 focusTick: model.focusTick,
                                 onSubmit: { model.onSubmit?(model.text, model.screenshotPNG, model.selection) },
                                 onTab: { model.onSwitch?(.voice) })
                    .frame(maxWidth: .infinity)
            case .listening:
                Text(model.transcript.isEmpty ? "Listening" : model.transcript)
                    .font(.okBody(15))
                    .foregroundStyle(model.transcript.isEmpty ? palette.tertiary : palette.ink)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentTransition(.opacity)
            case .thinking:
                OverlaySpinner(size: 14, color: palette.accent)
                Text(model.transcript.isEmpty ? "Thinking" : model.transcript)
                    .font(.okBody(15))
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            trailing
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .animation(OKMotion.snappy, value: canSend)
        .animation(OKMotion.snappy, value: model.phase)
    }

    /// The mark sits at rest and becomes a live mic orb while listening.
    @ViewBuilder private var leading: some View {
        if model.phase == .listening {
            SummonLevelDot(meter: model.meter, color: palette.accent)
                .transition(.scale(scale: 0.5).combined(with: .opacity))
        } else {
            Image(nsImage: OKBrandMark.overlayMark)
                .resizable()
                .interpolation(.high)
                .frame(width: 18, height: 18)
                .opacity(0.92)
                .transition(.opacity)
        }
    }

    @ViewBuilder private var trailing: some View {
        HStack(spacing: 4) {
            switch model.phase {
            case .listening:
                OverlayIconButton(symbol: "stop.fill", help: "Stop listening", size: 22) {
                    model.onStopListening?()
                }
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            case .typing, .hidden:
                if canSend {
                    OverlaySendButton(enabled: true, help: "Ask") {
                        model.onSubmit?(model.text, model.screenshotPNG, model.selection)
                    }
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            case .thinking:
                EmptyView()
            }
            OverlayIconButton(symbol: "xmark", help: "Close", size: 22) {
                model.onCancel?()
            }
        }
    }

    private var attachmentChip: some View {
        HStack(spacing: 8) {
            if let data = model.screenshotPNG, let image = NSImage(data: data) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 30, height: 21)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5)
                    }
            }
            Text(model.attachmentName.isEmpty ? "Selection" : model.attachmentName.overlaySentenceCased)
                .font(.okBody(12))
                .foregroundStyle(palette.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            OverlayIconButton(symbol: "xmark", help: "Remove", size: 18) {
                model.clearAttachment()
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 3)
        .padding(.vertical, 4)
        .background {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(palette.fill)
                .overlay {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(palette.hairline, lineWidth: 1)
                }
        }
    }

    private func errorRow(_ error: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(palette.danger)
            Text(error.overlaySentenceCased)
                .font(.okBody(12))
                .foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(palette.danger.opacity(0.10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(palette.danger.opacity(0.22), lineWidth: 1)
                }
        }
    }
}

/// Me / #space: where the request goes. A menu, so one click changes it and the choice sticks.
private struct SummonScopeChip: View {
    @ObservedObject var model: SummonModel
    var palette: OverlayPalette
    @State private var hovering = false

    private var label: String { model.scope.map { "#\($0.name)" } ?? "Me" }
    private var active: Bool { model.scope != nil }

    var body: some View {
        Menu {
            Button {
                model.onScope?("")
            } label: {
                Label("This Mac", systemImage: model.scopeID.isEmpty ? "checkmark" : "desktopcomputer")
            }
            Divider()
            ForEach(model.scopes) { scope in
                Button {
                    model.onScope?(scope.id)
                } label: {
                    if model.scopeID == scope.id {
                        Label("#\(scope.name)", systemImage: "checkmark")
                    } else {
                        Text("#\(scope.name)\(scope.joined ? "" : "  · not joined")")
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: active ? "number" : "person.fill")
                    .font(.system(size: 9.5, weight: .bold))
                Text(label)
                    .font(.okBody(12, .medium))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7.5, weight: .bold))
                    .opacity(0.6)
            }
            .foregroundStyle(active ? palette.accent : (hovering ? palette.ink : palette.secondary))
            .padding(.horizontal, 8)
            .frame(height: 24)
            .background {
                Capsule().fill(active ? palette.accent.opacity(0.12) : palette.fill.opacity(hovering ? 1 : 0.7))
            }
            .contentShape(Capsule())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .animation(OKMotion.snappy, value: hovering)
        .help(active ? "Sent to the agent in this space. Click to change." : "Runs on this Mac. Click to send to a space instead.")
        .accessibilityLabel("Where this goes: \(label)")
    }
}

/// A small orb that breathes with your voice.
private struct SummonLevelDot: View {
    @ObservedObject var meter: SummonLevelMeter
    var color: Color

    var body: some View {
        ZStack {
            Circle()
                .fill(color.opacity(0.20))
                .frame(width: 18, height: 18)
                .scaleEffect(0.55 + min(1, meter.level) * 0.62)
                .blur(radius: 2)
            Circle()
                .fill(color.opacity(0.55 + min(1, meter.level) * 0.45))
                .frame(width: 7, height: 7)
                .shadow(color: color.opacity(0.5), radius: 4, y: 0)
        }
        .frame(width: 18, height: 18)
        .animation(.easeOut(duration: 0.14), value: meter.level)
        .accessibilityLabel("Listening")
    }
}
