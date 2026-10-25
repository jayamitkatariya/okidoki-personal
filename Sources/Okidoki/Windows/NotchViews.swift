import AppKit
import SwiftUI
import OkidokiCore

// MARK: - Motion + palette

enum NotchMotion {
    /// Content reflow inside an open island (rows arriving, expand / collapse).
    static let content = Animation.spring(response: 0.38, dampingFraction: 0.86)
    /// Hover is a spring, not a fade. A fade reads as a still image that briefly
    /// changed colour; a spring reads as a surface that responded to you.
    static let hover = Animation.spring(response: 0.26, dampingFraction: 0.8)
    static let rowRemoval = Animation.easeOut(duration: 0.12)
}

private enum NotchInk {
    static let primary = Color.white.opacity(0.95)
    static let secondary = Color.white.opacity(0.58)
    static let tertiary = Color.white.opacity(0.38)
    static let onMint = Color(hex: 0x04130D)
    static let amber = Color(hex: 0xFFC95C)
    static let coral = Color(hex: 0xFF6B5E)
}

private extension String {
    /// Sentence case for copy that arrives lowercase from the brain ("not now" → "Not now").
    var notchSentence: String {
        guard let first = first else { return self }
        return first.uppercased() + dropFirst()
    }
}

// MARK: - Root

/// Fills the (transparent) window and pins the island to its top-centre.
struct NotchRootView: View {
    @ObservedObject var model: NotchModel
    let env: AppEnvironment
    @State private var contentHeight: CGFloat = 0

    private var m: NotchMetrics { model.metrics }

    var body: some View {
        island
            .padding(.top, m.topGap)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .environment(\.colorScheme, .dark)
    }

    private var openRadius: CGFloat {
        if model.expanded { return 26 }
        return model.hasBody ? 22 : (m.hasNotch ? 14 : 18)
    }

    private var island: some View {
        let presented = model.presented
        let width = presented ? model.islandWidth : m.closedWidth
        let height = presented ? max(contentHeight, m.bandHeight) : m.closedHeight
        let shape = NotchIslandShape(shoulder: presented ? m.shoulder : m.shoulder * 0.6,
                                     bottomRadius: presented ? openRadius : m.closedRadius,
                                     flushTop: m.hasNotch)
        return NotchContent(model: model, env: env)
            .frame(width: model.islandWidth)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGSize.self) { proxy in
                proxy.size
            } action: { size in
                // Height changes always spring — the content is never larger or smaller than its shape at rest.
                withAnimation(NotchMotion.content) { contentHeight = size.height }
                model.onIslandSize?(CGSize(width: size.width, height: max(size.height, m.bandHeight)))
            }
            .opacity(presented ? 1 : 0)
            .blur(radius: presented ? 0 : 3)
            .frame(width: width, height: height, alignment: .top)
            .background(NotchIslandBackground(clearTop: m.bandHeight))
            .clipShape(shape)
            .overlay {
                // A lip only on the floating pill. The hardware notch stays flush with the menu bar.
                if !m.hasNotch {
                    shape.stroke(Color.white.opacity(presented ? 0.16 : 0.1), lineWidth: 1)
                        .allowsHitTesting(false)
                }
            }
            .shadow(color: .black.opacity(presented ? 0.16 : 0), radius: presented ? 8 : 0, y: presented ? 3 : 0)
            .shadow(color: .black.opacity(presented ? 0.30 : 0), radius: presented ? 32 : 0, y: presented ? 20 : 0)
            .opacity(m.hasNotch || presented ? 1 : 0)
            .animation(NotchMotion.content, value: model.layoutKey)
    }
}

// MARK: - Shape + background

/// Flat top that flares into the menu bar with concave shoulders (like the hardware notch),
/// rounded bottom. On screens without a notch it's a plain floating rounded rectangle.
struct NotchIslandShape: Shape {
    var shoulder: CGFloat
    var bottomRadius: CGFloat
    var flushTop: Bool

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(shoulder, bottomRadius) }
        set { shoulder = newValue.first; bottomRadius = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        guard flushTop else {
            let radius = min(bottomRadius, rect.height / 2, rect.width / 2)
            return Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
        }
        let t = max(0, min(shoulder, rect.width / 4, rect.height / 2))
        let b = max(0, min(bottomRadius, (rect.width - t * 2) / 2, rect.height - t))
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t, y: rect.minY + t),
                       control: CGPoint(x: rect.minX + t, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX + t, y: rect.maxY - b))
        p.addQuadCurve(to: CGPoint(x: rect.minX + t + b, y: rect.maxY),
                       control: CGPoint(x: rect.minX + t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t - b, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - t, y: rect.maxY - b),
                       control: CGPoint(x: rect.maxX - t, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.maxX - t, y: rect.minY + t))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY),
                       control: CGPoint(x: rect.maxX - t, y: rect.minY))
        p.closeSubpath()
        return p
    }
}


/// Black with a faint dot grid. The band under the menu bar stays pure black, so the island
/// still reads as a continuation of the hardware notch; the dots fade in below it.
private struct NotchIslandBackground: View {
    var clearTop: CGFloat
    private static let spacing: CGFloat = 11
    private static let dot: CGFloat = 1.3

    var body: some View {
        ZStack {
            Color.black
            Canvas { context, size in
                let s = Self.spacing
                // Centre the grid so the dots sit symmetrically around the camera.
                let offsetX = size.width.truncatingRemainder(dividingBy: s) / 2
                var y = s / 2
                while y < size.height {
                    var x = offsetX + s / 2
                    while x < size.width {
                        let rect = CGRect(x: x - Self.dot / 2, y: y - Self.dot / 2, width: Self.dot, height: Self.dot)
                        context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.12)))
                        x += s
                    }
                    y += s
                }
            }
            .mask {
                VStack(spacing: 0) {
                    Color.clear.frame(height: clearTop)
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: 56)
                    Color.black
                }
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Content

private struct NotchContent: View {
    @ObservedObject var model: NotchModel
    let env: AppEnvironment

    private var m: NotchMetrics { model.metrics }
    private var inset: CGFloat { m.shoulder + 14 }

    var body: some View {
        VStack(alignment: .center, spacing: 0) {
            band
            if model.hasBody {
                stage
                    .padding(.horizontal, inset)
                    .padding(.top, model.expanded ? 8 : (m.hasNotch ? 10 : 6))
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Band

    /// Closed, logo and status sit against the camera so the pair reads as one centered mark.
    /// Open, the band becomes a control bar: input mode on the left, quiet and settings on the right.
    @ViewBuilder private var band: some View {
        if model.expanded {
            HStack(spacing: 0) {
                HStack(spacing: 0) {
                    NotchModeSwitch(mode: model.inputMode) { env.store.settings.defaultInput = $0 }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
                if m.hasNotch {
                    Color.clear.frame(width: m.notchWidth)
                } else {
                    OKLogo(size: 14)
                }
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    NotchIconButton(symbol: model.quiet ? "moon.fill" : "moon",
                                    help: model.quiet ? "Turn off quiet" : "Quiet",
                                    size: 24, filled: true, active: model.quiet) {
                        env.store.settings.quietMode.toggle()
                    }
                    NotchIconButton(symbol: "gearshape.fill", help: "Settings", size: 24, filled: true) {
                        model.onClose?()
                        env.openDashboard(.settings)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, m.shoulder + 12)
            .frame(height: m.bandHeight)
            .transition(.opacity)
        } else if m.hasNotch {
            HStack(spacing: 0) {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    OKLogo(size: 14)
                        .padding(.trailing, 14)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                Color.clear.frame(width: m.notchWidth)
                HStack(spacing: 0) {
                    statusCluster
                        .padding(.leading, 14)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(.horizontal, m.shoulder + 6)
            .frame(height: m.bandHeight)
        } else {
            HStack(spacing: 8) {
                OKLogo(size: 14)
                Text(statusText)
                    .font(.okBody(12, .medium))
                    .foregroundStyle(NotchInk.secondary)
                    .lineLimit(1)
                statusIndicator
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .frame(height: m.bandHeight)
        }
    }

    /// One thing in the ear: a word when nothing is live, otherwise the live mark.
    @ViewBuilder private var statusCluster: some View {
        if model.listening || model.recording != nil || !model.waiting.isEmpty || !model.live.isEmpty {
            statusIndicator
        } else {
            Text(statusText)
                .font(.okBody(12, .medium))
                .foregroundStyle(NotchInk.secondary)
                .lineLimit(1)
        }
    }

    private var statusText: String {
        if model.quiet { return "Quiet" }
        if model.listening { return "Listening" }
        if model.recording != nil { return "Recording" }
        if model.caption != nil { return "Speaking" }
        if !model.waiting.isEmpty { return "Needs you" }
        if !model.live.isEmpty { return "Working" }
        if !model.toasts.isEmpty { return "Just now" }
        return "Okidoki"
    }

    @ViewBuilder private var statusIndicator: some View {
        if model.quiet {
            EmptyView()
        } else if model.listening {
            WaveformView(level: 0.5, active: model.presented, color: OKBrand.mint, bars: 7, height: 12)
                .frame(width: 28)
        } else if let recording = model.recording {
            HStack(spacing: 5) {
                RecordingDot(size: 6)
                if recording.steps > 0 {
                    Text("\(recording.steps)")
                        .font(.okBody(12, .semibold))
                        .foregroundStyle(NotchInk.coral)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
            }
        } else if !model.waiting.isEmpty {
            HStack(spacing: 5) {
                Circle().fill(NotchInk.amber).frame(width: 5, height: 5)
                Text("\(model.waiting.count)")
                    .font(.okBody(12, .semibold))
                    .foregroundStyle(NotchInk.amber)
                    .monospacedDigit()
            }
        } else if !model.live.isEmpty {
            HStack(spacing: 5) {
                NotchSpinner(tint: OKBrand.mint, size: 11, active: model.presented)
                if model.live.count > 1 {
                    Text("\(model.live.count)")
                        .font(.okBody(12, .semibold))
                        .foregroundStyle(OKBrand.mint)
                        .monospacedDigit()
                }
            }
        }
    }

    // MARK: Stage
    //
    // One layout for both compact and expanded, so a card keeps its identity (and position)
    // when the island expands. Nothing crossfades over anything else. Compact shows one
    // surface: an approval takes the stage (with the newest toast queued under it), else the
    // toast stack, else the top live run.

    private var isEmpty: Bool { model.waiting.isEmpty && model.toasts.isEmpty && model.live.isEmpty && model.recording == nil }

    private var shownWaiting: [NotchRunItem] { Array(model.waiting.prefix(model.expanded ? 3 : 1)) }

    private var shownToasts: [NotchToast] {
        let newestFirst = Array(model.toasts.reversed())
        if !model.expanded && !model.waiting.isEmpty { return Array(newestFirst.prefix(1)) }
        return newestFirst
    }

    private var shownLive: [NotchRunItem] {
        if model.expanded { return Array(model.live.prefix(4)) }
        return model.waiting.isEmpty && model.toasts.isEmpty && model.recording == nil ? Array(model.live.prefix(1)) : []
    }

    private var stage: some View {
        VStack(alignment: .center, spacing: 0) {
            NotchScrollArea(maxHeight: m.maxBodyHeight) {
                VStack(alignment: .center, spacing: 8) {
                    if let caption = model.caption {
                        Text(caption)
                            .font(.okBody(13.5, .medium))
                            .foregroundStyle(NotchInk.primary)
                            .multilineTextAlignment(.center)
                            .lineLimit(model.expanded ? 8 : 3)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .transition(rowTransition)
                    }
                    if let recording = model.recording {
                        NotchRecordingRow(recording: recording, env: env, detailed: model.expanded)
                            .transition(rowTransition)
                    }
                    ForEach(shownWaiting) { run in
                        NotchApprovalCard(run: run, env: env, compact: !model.expanded)
                            .transition(rowTransition)
                    }
                    if model.waiting.count > shownWaiting.count {
                        moreLink("\(model.waiting.count - shownWaiting.count) more waiting") { env.openDashboard(.runs) }
                    }
                    ForEach(shownToasts) { toast in
                        NotchToastRow(toast: toast, model: model, env: env)
                            .transition(rowTransition)
                    }
                    ForEach(shownLive) { run in
                        NotchLiveRow(run: run, env: env, animating: model.presented)
                            .transition(rowTransition)
                    }
                    if model.live.count > shownLive.count && model.expanded {
                        moreLink("\(model.live.count - shownLive.count) more working") { env.openDashboard(.runs) }
                    }
                    if model.expanded && isEmpty && model.caption == nil {
                        greeting.transition(.opacity)
                    }
                }
            }
            if model.expanded {
                footer
                    .padding(.top, isEmpty && model.caption == nil ? 2 : 12)
                    .transition(.opacity)
            }
        }
    }

    // MARK: Home

    /// The island at rest, open: who it's for and how to reach for it.
    private var greeting: some View {
        VStack(spacing: 6) {
            Text(greetingTitle)
                .font(.okBody(22, .semibold))
                .tracking(-0.3)
                .foregroundStyle(NotchInk.primary)
                .lineLimit(1)
            Text(model.quiet
                 ? "Quiet is on. I'll hold everything until you're back."
                 : "Shake your mouse and tell me what to take off your plate.")
                .font(.okBody(13.5))
                .foregroundStyle(NotchInk.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 10)
        .padding(.bottom, 18)
    }

    private var greetingTitle: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part: String
        switch hour {
        case 5..<12: part = "Morning"
        case 12..<17: part = "Afternoon"
        case 17..<22: part = "Evening"
        default: part = "Up late"
        }
        let name = env.store.activeAccount.firstName.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "\(part)." : "\(part), \(name)."
    }

    /// Quick ways in: ask on the left, the places okidoki keeps its tricks on the right.
    private var footer: some View {
        HStack(spacing: 8) {
            NotchButton(title: "Ask okidoki", symbol: "sparkle", kind: .accent, height: 30) {
                model.onClose?()
                env.startSummon()
            }
            Spacer(minLength: 0)
            NotchButton(title: "Skills", symbol: "wand.and.stars", kind: .secondary, height: 30) {
                model.onClose?()
                env.openDashboard(.skills)
            }
            NotchButton(title: "Toolbox", trailingSymbol: "plus", kind: .secondary, height: 30) {
                model.onClose?()
                env.openDashboard(.toolbox)
            }
        }
    }

    // MARK: Helpers

    private var rowTransition: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .offset(y: -6)),
                    removal: .opacity.animation(NotchMotion.rowRemoval))
    }

    private func moreLink(_ title: String, action: @escaping () -> Void) -> some View {
        NotchButton(title: title, trailingSymbol: "chevron.right", kind: .plain, action: action)
            .frame(maxWidth: .infinity)
    }
}

/// Scrolls only when the content is taller than `maxHeight`; otherwise hugs it exactly.
private struct NotchScrollArea<Content: View>: View {
    var maxHeight: CGFloat
    @ViewBuilder var content: Content
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            content
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { value in
                    withAnimation(NotchMotion.content) { height = value }
                }
        }
        .scrollDisabled(height <= maxHeight)
        .frame(height: min(max(height, 1), maxHeight))
    }
}

// MARK: - Cards
//
// Every row is the same card: a tinted badge that says what kind of thing it is, a title and
// one line of detail, and its controls on the trailing edge. Only the badge carries colour.

private struct NotchToastRow: View {
    var toast: NotchToast
    let model: NotchModel
    let env: AppEnvironment
    @State private var hovering = false

    private var badge: (String, Color) {
        switch toast.kind {
        case .success: return ("checkmark", OKBrand.mint)
        case .warning: return ("exclamationmark", NotchInk.amber)
        case .approval: return ("hand.raised.fill", NotchInk.amber)
        case .info: return ("sparkle", NotchInk.primary)
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            NotchBadge(symbol: badge.0, tint: badge.1)
            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title.notchSentence)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                if !toast.detail.isEmpty {
                    Text(toast.detail.notchSentence)
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { open() }

            if let label = toast.undoLabel {
                NotchButton(title: label.notchSentence, kind: .secondary) { model.undo(toast.id) }
            }
            if let label = toast.editLabel {
                NotchButton(title: label.notchSentence, kind: .plain) { model.edit(toast.id) }
            }
        }
        .notchCard(hovering: hovering)
        .overlay(alignment: .topTrailing) {
            // Dismiss floats on the corner, so it never shifts the row's own controls.
            NotchIconButton(symbol: "xmark", help: "Dismiss", size: 18, filled: true) {
                model.removeToast(toast.id)
            }
            .offset(x: 5, y: -5)
            .opacity(hovering ? 1 : 0)
            .allowsHitTesting(hovering)
        }
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    private func open() {
        if let runID = toast.runID { env.openDashboard(.runs, runID: runID) }
    }
}

/// A skill being recorded: red dot, running clock and step count, Save / Discard.
/// Save is the primary action — stopping is what the user is reaching for.
private struct NotchRecordingRow: View {
    var recording: NotchRecording
    let env: AppEnvironment
    var detailed: Bool
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle().fill(NotchInk.coral.opacity(0.16))
                RecordingDot(size: 8)
            }
            .frame(width: NotchBadge.size, height: NotchBadge.size)
            VStack(alignment: .leading, spacing: 2) {
                Text(recording.name.isEmpty ? "Recording a skill" : recording.name.notchSentence)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                TimelineView(.periodic(from: recording.startedAt, by: 1)) { context in
                    Text("\(Self.clock(since: recording.startedAt, now: context.date)) · \(recording.steps) \(recording.steps == 1 ? "step" : "steps")")
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                if detailed {
                    Text("Do it once at a normal pace. Press Save when you're done.")
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.tertiary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { env.openDashboard(.skills) }

            HStack(spacing: 8) {
                NotchIconButton(symbol: "trash", help: "Discard", filled: true) { env.discardWatching() }
                NotchButton(title: "Save", symbol: "stop.fill", kind: .primary) { env.stopWatching() }
            }
        }
        .notchCard(hovering: hovering)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    private static func clock(since start: Date, now: Date) -> String {
        let total = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// The red "live" dot. Breathes on its own so it reads as recording even in the closed band.
private struct RecordingDot: View {
    var size: CGFloat
    @State private var bright = false

    var body: some View {
        Circle()
            .fill(NotchInk.coral)
            .frame(width: size, height: size)
            .shadow(color: NotchInk.coral.opacity(bright ? 0.7 : 0.15), radius: bright ? size * 0.9 : 1)
            .opacity(bright ? 1 : 0.65)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { bright = true }
            }
            .accessibilityLabel("Recording")
    }
}

private struct NotchLiveRow: View {
    var run: NotchRunItem
    let env: AppEnvironment
    var animating: Bool
    @State private var hovering = false

    private var paused: Bool { run.status == .paused }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if paused {
                NotchBadge(symbol: "pause.fill", tint: NotchInk.secondary)
            } else {
                ZStack {
                    Circle().fill(OKBrand.mint.opacity(0.12))
                    NotchSpinner(tint: OKBrand.mint, size: 16, active: animating)
                }
                .frame(width: NotchBadge.size, height: NotchBadge.size)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(run.title.notchSentence)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                Text(paused ? "Paused" : (run.step.isEmpty ? "Working on it" : run.step.notchSentence))
                    .font(.okBody(12))
                    .foregroundStyle(paused ? NotchInk.tertiary : NotchInk.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { env.openDashboard(.runs, runID: run.id) }

            HStack(spacing: 6) {
                NotchIconButton(symbol: paused ? "play.fill" : "pause.fill", help: paused ? "Resume" : "Pause",
                                filled: true) { env.pauseRun(run.id) }
                NotchIconButton(symbol: "stop.fill", help: "Stop", filled: true) { env.stopRun(run.id) }
            }
        }
        .notchCard(hovering: hovering)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }
}

private struct NotchApprovalCard: View {
    var run: NotchRunItem
    let env: AppEnvironment
    var compact: Bool
    @State private var showCommands = false
    @State private var hovering = false

    private var riskColor: Color {
        switch run.risk {
        case .low: return OKBrand.mint
        case .medium: return NotchInk.amber
        case .high: return NotchInk.coral
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                NotchBadge(symbol: "hand.raised.fill", tint: riskColor)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(run.title.notchSentence)
                            .font(.okBody(13, .medium))
                            .foregroundStyle(NotchInk.primary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        riskChip
                    }
                    if !run.summary.isEmpty {
                        Text(run.summary.notchSentence)
                            .font(.okBody(12))
                            .foregroundStyle(NotchInk.secondary)
                            .lineLimit(compact ? 2 : 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !compact && !run.commands.isEmpty && showCommands {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(run.commands.prefix(4).enumerated()), id: \.offset) { _, command in
                        Text(command)
                            .font(.okMono(11))
                            .foregroundStyle(NotchInk.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                    if run.commands.count > 4 {
                        Text("+\(run.commands.count - 4) more")
                            .font(.okBody(11))
                            .foregroundStyle(NotchInk.tertiary)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.black.opacity(0.45)))
                .transition(.opacity)
            }

            HStack(spacing: 4) {
                if !compact {
                    if !run.commands.isEmpty {
                        NotchButton(title: showCommands ? "Hide commands" : "Commands",
                                    trailingSymbol: showCommands ? "chevron.up" : "chevron.down", kind: .plain) {
                            withAnimation(NotchMotion.content) { showCommands.toggle() }
                        }
                    }
                    NotchButton(title: "Always allow", kind: .plain) { env.allowAlways(run.id) }
                    NotchButton(title: "Review", kind: .plain) { env.openDashboard(.runs, runID: run.id) }
                }
                Spacer(minLength: 0)
                NotchButton(title: "Not now", kind: .secondary) { env.denyRun(run.id) }
                    .padding(.trailing, 4)
                NotchButton(title: run.kind == .borrow ? "Allow once" : "Do it", kind: .primary) {
                    env.approveRun(run.id)
                }
            }
            .padding(.leading, compact ? NotchBadge.size + 12 : -6)
        }
        .notchCard(hovering: hovering, padding: 14)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    private var riskChip: some View {
        HStack(spacing: 4) {
            Circle().fill(riskColor).frame(width: 5, height: 5)
            Text("\(run.risk.label.notchSentence) risk")
        }
        .font(.okBody(11, .medium))
        .foregroundStyle(run.risk == .low ? NotchInk.secondary : riskColor)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(Capsule().fill((run.risk == .low ? Color.white : riskColor).opacity(0.1)))
        .fixedSize()
    }
}

// MARK: - Controls

enum NotchButtonKind { case primary, accent, secondary, plain }

/// A button in the notch.
///
/// Primary rests white and warms to mint under the pointer. Accent is the island's one
/// invitation: mint at rest. Secondary sits on a soft plate. Plain stays quiet until you
/// reach for it.
struct NotchButton: View {
    var title: String
    var symbol: String?
    var trailingSymbol: String?
    var kind: NotchButtonKind = .secondary
    var height: CGFloat = 28
    var action: () -> Void
    @State private var hovering = false

    private var foreground: Color {
        switch kind {
        case .primary, .accent: return NotchInk.onMint
        case .secondary: return hovering ? NotchInk.primary : Color.white.opacity(0.84)
        case .plain: return hovering ? NotchInk.primary : NotchInk.secondary
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 10.5, weight: .bold))
                }
                Text(title)
                    .font(.okBody(12.5, kind == .primary || kind == .accent ? .semibold : .medium))
                    .lineLimit(1)
                if let trailingSymbol {
                    Image(systemName: trailingSymbol)
                        .font(.system(size: 9, weight: .bold))
                        .opacity(0.7)
                }
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .plain ? 9 : 13)
            .frame(height: kind == .plain ? height - 4 : height)
            .background { plate }
            .contentShape(Capsule())
        }
        .buttonStyle(NotchPressStyle())
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    @ViewBuilder private var plate: some View {
        switch kind {
        case .primary:
            Capsule()
                .fill(hovering ? OKBrand.mint : Color.white)
                .shadow(color: (hovering ? OKBrand.mint : Color.white).opacity(hovering ? 0.45 : 0.12),
                        radius: hovering ? 10 : 4, y: 1)
        case .accent:
            Capsule()
                .fill(hovering ? OKBrand.greenBright : OKBrand.mint)
                .shadow(color: OKBrand.mint.opacity(hovering ? 0.45 : 0.22), radius: hovering ? 12 : 6, y: 1)
        case .secondary:
            Capsule()
                .fill(Color.white.opacity(hovering ? 0.14 : 0.08))
        case .plain:
            Capsule().fill(Color.white.opacity(hovering ? 0.08 : 0))
        }
    }
}

struct NotchIconButton: View {
    var symbol: String
    var help: String = ""
    var size: CGFloat = 26
    /// Sits on a soft plate at rest instead of appearing only on hover.
    var filled: Bool = false
    /// A toggle that's on: lit in mint.
    var active: Bool = false
    var action: () -> Void
    @State private var hovering = false

    private var ink: Color {
        if active { return OKBrand.mint }
        return hovering ? NotchInk.primary : Color.white.opacity(0.7)
    }

    private var plate: Color {
        if active { return OKBrand.mint.opacity(hovering ? 0.22 : 0.15) }
        if filled { return Color.white.opacity(hovering ? 0.15 : 0.08) }
        return Color.white.opacity(hovering ? 0.12 : 0)
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.4, weight: .bold))
                .foregroundStyle(ink)
                .frame(width: size, height: size)
                .background(Circle().fill(plate))
                .contentShape(Circle())
        }
        .buttonStyle(NotchPressStyle())
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// Talk or type: how a summon starts. The selected half wears a plate that slides between them.
private struct NotchModeSwitch: View {
    var mode: InputMode
    var onChange: (InputMode) -> Void
    @Namespace private var plate

    var body: some View {
        HStack(spacing: 0) {
            segment(.voice, symbol: "waveform", help: "Talk")
            segment(.typing, symbol: "bubble.left.fill", help: "Type")
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.08)))
        .animation(NotchMotion.hover, value: mode)
    }

    private func segment(_ value: InputMode, symbol: String, help: String) -> some View {
        let selected = mode == value
        return Button { onChange(value) } label: {
            Image(systemName: symbol)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(selected ? NotchInk.primary : NotchInk.tertiary)
                .frame(width: 30, height: 20)
                .background {
                    if selected {
                        Capsule()
                            .fill(Color.white.opacity(0.16))
                            .matchedGeometryEffect(id: "plate", in: plate)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(NotchPressStyle())
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// What kind of thing a card is, in one tinted circle.
private struct NotchBadge: View {
    static let size: CGFloat = 30
    var symbol: String
    var tint: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 11.5, weight: .bold))
            .foregroundStyle(tint)
            .frame(width: Self.size, height: Self.size)
            .background(Circle().fill(tint.opacity(0.14)))
    }
}

/// A short arc that turns: work in progress, without pretending to know how far along it is.
private struct NotchSpinner: View {
    var tint: Color
    var size: CGFloat
    var active: Bool
    @State private var turning = false

    var body: some View {
        ZStack {
            Circle().stroke(tint.opacity(0.18), lineWidth: 2)
            Circle()
                .trim(from: 0, to: 0.3)
                .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(turning ? 360 : 0))
        }
        .frame(width: size, height: size)
        .onAppear { spin(active) }
        .onChange(of: active) { _, value in spin(value) }
    }

    private func spin(_ on: Bool) {
        if on {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turning = true }
        } else {
            withAnimation(.linear(duration: 0)) { turning = false }
        }
    }
}

private struct NotchPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

private extension View {
    /// The one card surface every row shares. It brightens a touch under the pointer;
    /// nothing moves, so a list of cards never jitters as you cross it.
    func notchCard(hovering: Bool, padding: CGFloat = 12) -> some View {
        self
            .padding(.horizontal, padding)
            .padding(.vertical, padding - 2)
            .frame(maxWidth: .infinity)
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(hovering ? 0.075 : 0.05))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.white.opacity(hovering ? 0.1 : 0.06), lineWidth: 1)
                    }
            }
    }
}
