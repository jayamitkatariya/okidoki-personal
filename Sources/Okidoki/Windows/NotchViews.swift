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
    static let secondary = Color.white.opacity(0.56)
    static let tertiary = Color.white.opacity(0.4)
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
        model.hasBody ? 22 : (m.hasNotch ? 14 : 18)
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
            .background(NotchIslandBackground())
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

/// Flat black. The island is a continuation of the hardware notch, not a panel.
private struct NotchIslandBackground: View {
    var body: some View {
        Color.black.allowsHitTesting(false)
    }
}

// MARK: - Content

private struct NotchContent: View {
    @ObservedObject var model: NotchModel
    let env: AppEnvironment

    private var m: NotchMetrics { model.metrics }
    private var inset: CGFloat { m.shoulder + 18 }
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        VStack(alignment: .center, spacing: 0) {
            band
            if model.hasBody {
                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 1 / max(displayScale, 1))
                    .padding(.horizontal, inset)
                stage
                    .padding(.horizontal, inset)
                    .padding(.top, m.hasNotch ? 16 : 10)
                    .padding(.bottom, 18)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Band

    /// Logo and status sit against the camera, so the pair reads as one centered mark.
    @ViewBuilder private var band: some View {
        if m.hasNotch {
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
        if model.listening || !model.waiting.isEmpty || !model.live.isEmpty {
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
        } else if !model.waiting.isEmpty {
            HStack(spacing: 5) {
                Circle().fill(OKBrand.mint).frame(width: 5, height: 5)
                Text("\(model.waiting.count)")
                    .font(.okBody(12, .semibold))
                    .foregroundStyle(OKBrand.mint)
                    .monospacedDigit()
            }
        } else if !model.live.isEmpty {
            HStack(spacing: 5) {
                Circle().fill(OKBrand.mint).frame(width: 5, height: 5)
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
    // when the island expands — it just gains a section label above it. Nothing crossfades
    // over anything else. Compact shows one surface: an approval takes the stage (with the
    // newest toast queued under it), else the toast stack, else the top live run.

    private var isEmpty: Bool { model.waiting.isEmpty && model.toasts.isEmpty && model.live.isEmpty }

    private var shownWaiting: [NotchRunItem] { Array(model.waiting.prefix(model.expanded ? 3 : 1)) }

    private var shownToasts: [NotchToast] {
        let newestFirst = Array(model.toasts.reversed())
        if !model.expanded && !model.waiting.isEmpty { return Array(newestFirst.prefix(1)) }
        return newestFirst
    }

    private var shownLive: [NotchRunItem] {
        if model.expanded { return Array(model.live.prefix(4)) }
        return model.waiting.isEmpty && model.toasts.isEmpty ? Array(model.live.prefix(1)) : []
    }

    private var stage: some View {
        VStack(alignment: .center, spacing: 0) {
            NotchScrollArea(maxHeight: m.maxBodyHeight) {
                VStack(alignment: .center, spacing: model.expanded ? 18 : 8) {
                    if let caption = model.caption {
                        Text(caption)
                            .font(.okBody(13, .medium))
                            .foregroundStyle(NotchInk.primary)
                            .multilineTextAlignment(.center)
                            .lineLimit(model.expanded ? 8 : 3)
                            .fixedSize(horizontal: false, vertical: true)
                            .transition(rowTransition)
                    }
                    if !shownWaiting.isEmpty {
                        section(nil) {
                            ForEach(shownWaiting) { run in
                                NotchApprovalCard(run: run, env: env, compact: !model.expanded)
                                    .transition(rowTransition)
                            }
                            if model.waiting.count > shownWaiting.count {
                                moreLink("\(model.waiting.count - shownWaiting.count) more waiting") { env.openDashboard(.runs) }
                            }
                        }
                    }
                    if !shownToasts.isEmpty {
                        section(nil) {
                            ForEach(shownToasts) { toast in
                                NotchToastRow(toast: toast, model: model, env: env)
                                    .transition(rowTransition)
                            }
                        }
                    }
                    if !shownLive.isEmpty {
                        section(nil) {
                            ForEach(shownLive) { run in
                                NotchLiveRow(run: run, env: env, detailed: model.expanded, animating: model.presented)
                                    .transition(rowTransition)
                            }
                            if model.live.count > shownLive.count {
                                moreLink("\(model.live.count - shownLive.count) more working") { env.openDashboard(.runs) }
                            }
                        }
                    }
                    if model.expanded && isEmpty {
                        emptyState.transition(.opacity)
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        Text(model.quiet ? "Quiet" : "Shake to ask")
            .font(.okBody(13))
            .foregroundStyle(NotchInk.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
    }

    // MARK: Helpers

    private var rowTransition: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .offset(y: -6)),
                    removal: .opacity.animation(NotchMotion.rowRemoval))
    }

    private func section<Content: View>(_ title: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .center, spacing: 10) {
            if let title {
                Text(title)
                    .font(.okBody(11.5, .medium))
                    .foregroundStyle(NotchInk.tertiary)
                    .transition(.opacity)
            }
            content()
        }
        .frame(maxWidth: .infinity)
    }

    private func moreLink(_ title: String, action: @escaping () -> Void) -> some View {
        HStack {
            Spacer(minLength: 0)
            NotchButton(title: title, kind: .plain, action: action)
            Spacer(minLength: 0)
        }
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

// MARK: - Rows

private struct NotchToastRow: View {
    var toast: NotchToast
    let model: NotchModel
    let env: AppEnvironment
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
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

            if let label = toast.editLabel {
                NotchButton(title: label.notchSentence, kind: .plain) { model.edit(toast.id) }
            }
            if let label = toast.undoLabel {
                NotchButton(title: label.notchSentence, kind: .plain) { model.undo(toast.id) }
            }
            NotchIconButton(glyph: "x", help: "Dismiss", size: 22) {
                model.removeToast(toast.id)
            }
            .opacity(hovering ? 1 : 0)
            .allowsHitTesting(hovering)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .notchRow()
        .onHover { hovering = $0 }
    }

    private func open() {
        if let runID = toast.runID { env.openDashboard(.runs, runID: runID) }
    }
}

private struct NotchLiveRow: View {
    var run: NotchRunItem
    let env: AppEnvironment
    var detailed: Bool
    var animating: Bool

    private var paused: Bool { run.status == .paused }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(run.title.notchSentence)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                if paused {
                    Text("Paused")
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.tertiary)
                } else if detailed, !run.step.isEmpty {
                    Text(run.step.notchSentence)
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.secondary)
                        .lineLimit(1)
                }
                NotchProgressBar(active: animating && !paused)
                    .padding(.top, 3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { env.openDashboard(.runs, runID: run.id) }

            NotchButton(title: paused ? "Resume" : "Pause", kind: .plain) { env.pauseRun(run.id) }
            NotchButton(title: "Stop", kind: .plain) { env.stopRun(run.id) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .notchRow()
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
        VStack(alignment: .center, spacing: 10) {
            Text(run.title.notchSentence)
                .font(.okBody(13, .medium))
                .foregroundStyle(NotchInk.primary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)

            if !run.summary.isEmpty {
                Text(run.summary.notchSentence)
                    .font(.okBody(12))
                    .foregroundStyle(NotchInk.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(compact ? 2 : 4)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
            }

            HStack(spacing: 5) {
                Circle()
                    .fill(riskColor)
                    .frame(width: 4, height: 4)
                    .opacity(run.risk == .low ? 0.55 : 1)
                Text("\(run.risk.label.notchSentence) risk")
            }
            .font(.okBody(11))
            .foregroundStyle(run.risk == .low ? NotchInk.tertiary : riskColor)

            if !compact && !run.commands.isEmpty {
                Button {
                    withAnimation(NotchMotion.content) { showCommands.toggle() }
                } label: {
                    Text(showCommands ? "Hide commands" : "Show commands")
                        .font(.okBody(12))
                        .foregroundStyle(NotchInk.secondary)
                }
                .buttonStyle(.plain)

                if showCommands {
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                }
            }

            HStack(spacing: 8) {
                NotchButton(title: "Not now", kind: .secondary) { env.denyRun(run.id) }
                NotchButton(title: run.kind == .borrow ? "Allow once" : "Do it", kind: .primary) {
                    env.approveRun(run.id)
                }
            }
            .padding(.top, 2)

            if !compact {
                HStack(spacing: 16) {
                    Button("Always allow") { env.allowAlways(run.id) }
                        .buttonStyle(.plain)
                    Button("Review") { env.openDashboard(.runs, runID: run.id) }
                        .buttonStyle(.plain)
                }
                .font(.okBody(12))
                .foregroundStyle(NotchInk.tertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background {
            // A graded surface, not one flat sheet — the card should read as sitting
            // above the island rather than being cut out of it.
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(hovering ? 0.06 : 0.032))
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(hovering ? 0.15 : 0.07), lineWidth: 1)
            }
        }
        .shadow(color: .black.opacity(hovering ? 0.32 : 0.18), radius: hovering ? 18 : 10, y: hovering ? 6 : 3)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }
}

// MARK: - Controls

enum NotchButtonKind { case primary, secondary, plain }

/// A button in the notch.
///
/// The primary action is the island's one moment of brand: it rests white and
/// warms to mint under the pointer, throwing a soft glow. Secondary grows a
/// surface and an edge. Plain stays quiet until you reach for it, then lifts.
struct NotchButton: View {
    var title: String
    var glyph: String?
    var kind: NotchButtonKind = .secondary
    var action: () -> Void
    @State private var hovering = false

    private var foreground: Color {
        switch kind {
        case .primary: return NotchInk.onMint
        case .secondary: return hovering ? NotchInk.primary : NotchInk.secondary
        case .plain: return hovering ? NotchInk.primary : NotchInk.secondary
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let glyph {
                    PixelGlyph(name: glyph, size: 9, color: foreground)
                }
                Text(title)
                    .font(.okBody(12, kind == .primary ? .semibold : .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .plain ? 8 : 12)
            .frame(height: kind == .plain ? 24 : 27)
            .background { plate }
            .contentShape(Capsule())
        }
        .buttonStyle(NotchPressStyle())
        .offset(y: hovering ? -1 : 0)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    @ViewBuilder private var plate: some View {
        switch kind {
        case .primary:
            Capsule()
                .fill(hovering ? OKBrand.mint : Color.white)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.85), lineWidth: 0.5))
                .shadow(color: (hovering ? OKBrand.mint : Color.white).opacity(hovering ? 0.5 : 0.16),
                        radius: hovering ? 12 : 5, y: hovering ? 2 : 1)
        case .secondary:
            Capsule()
                .fill(Color.white.opacity(hovering ? 0.12 : 0.05))
                .overlay(Capsule().strokeBorder(Color.white.opacity(hovering ? 0.14 : 0), lineWidth: 1))
        case .plain:
            Capsule().fill(Color.white.opacity(hovering ? 0.07 : 0))
        }
    }
}

struct NotchIconButton: View {
    var glyph: String
    var help: String = ""
    var size: CGFloat = 26
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            PixelGlyph(name: glyph, size: 10, color: hovering ? NotchInk.primary : NotchInk.secondary)
                .frame(width: size, height: size)
                .background {
                    Circle()
                        .fill(Color.white.opacity(hovering ? 0.12 : 0))
                        .overlay(Circle().strokeBorder(Color.white.opacity(hovering ? 0.12 : 0), lineWidth: 1))
                }
                .contentShape(Circle())
        }
        .buttonStyle(NotchPressStyle())
        .scaleEffect(hovering ? 1.1 : 1)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
        .help(help)
        .accessibilityLabel(help)
    }
}

private struct NotchPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

private struct NotchProgressBar: View {
    var active: Bool

    var body: some View {
        Capsule()
            .fill(Color.white.opacity(0.1))
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(OKBrand.mint.opacity(active ? 0.9 : 0.25))
                    .scaleEffect(x: active ? 1 : 0.2, anchor: .leading)
            }
            .frame(height: 1.5)
            .animation(.easeInOut(duration: 0.4), value: active)
    }
}

private extension View {
    /// A row lights up on hover: a soft surface, a hairline edge and a hair of lift.
    /// No border at rest — borders made every line look like a widget.
    func notchRow(hoverable: Bool = true) -> some View {
        modifier(NotchRowModifier(enabled: hoverable))
    }
}

/// Owns the hover state for a notch row, so every row answers the pointer the
/// same way instead of each hand-rolling its own fill.
private struct NotchRowModifier: ViewModifier {
    var enabled: Bool = true
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(hovering ? 0.075 : 0))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Color.white.opacity(hovering ? 0.09 : 0), lineWidth: 1)
                    }
            }
            .offset(y: hovering ? -1 : 0)
            .animation(NotchMotion.hover, value: hovering)
            .onHover { hovering = enabled && $0 }
    }
}
