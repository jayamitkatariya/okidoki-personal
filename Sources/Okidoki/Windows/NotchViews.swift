import AppKit
import SwiftUI
import OkidokiCore

// MARK: - Motion + palette

enum NotchMotion {
    /// Content reflow inside an open island (rows arriving, expand / collapse).
    static let content = Animation.spring(response: 0.38, dampingFraction: 0.86)
    static let hover = Animation.easeOut(duration: 0.14)
    static let rowRemoval = Animation.easeOut(duration: 0.12)
}

private enum NotchInk {
    static let primary = Color.white.opacity(0.95)
    static let secondary = Color.white.opacity(0.56)
    static let tertiary = Color.white.opacity(0.4)
    static let onMint = Color(hex: 0x04130D)
    static let amber = Color(hex: 0xFFC95C)
    static let sky = Color(hex: 0x8FB7FF)
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
        model.hasBody ? 24 : (m.hasNotch ? 13 : 18)
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
            .background(NotchIslandBackground(bandHeight: m.bandHeight, hasNotch: m.hasNotch,
                                              listening: model.listening && presented))
            .clipShape(shape)
            .overlay(shape.stroke(Color.white.opacity(m.hasNotch ? 0 : 0.1), lineWidth: 1))
            .shadow(color: .black.opacity(presented ? 0.42 : 0), radius: 18, y: 10)
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

/// Grid anchored on the centre line so it doesn't slide while the island springs wider.
private struct NotchGridLines: Shape {
    var spacing: CGFloat = 22

    func path(in rect: CGRect) -> Path {
        var path = Path()
        var offset: CGFloat = 0
        while rect.midX - offset >= rect.minX {
            for x in Set([rect.midX - offset, rect.midX + offset]) {
                path.move(to: CGPoint(x: x, y: rect.minY))
                path.addLine(to: CGPoint(x: x, y: rect.maxY))
            }
            offset += spacing
        }
        var y = rect.minY
        while y <= rect.maxY {
            path.move(to: CGPoint(x: rect.minX, y: y))
            path.addLine(to: CGPoint(x: rect.maxX, y: y))
            y += spacing
        }
        return path
    }
}

/// Pure black band (merges with the hardware notch), then a calm black body with a faint
/// grid, grain and a whisper of mat green at the bottom.
private struct NotchIslandBackground: View {
    var bandHeight: CGFloat
    var hasNotch: Bool
    var listening: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Color.black
            ZStack {
                NotchGridLines(spacing: 22)
                    .stroke(Color.white.opacity(0.032), lineWidth: 0.5)
                if let noise = OKNoise.image {
                    Image(nsImage: noise)
                        .resizable(resizingMode: .tile)
                        .interpolation(.none)
                        .opacity(0.22)
                        .blendMode(.screen)
                }
                LinearGradient(colors: [OKBrand.mat.opacity(0), OKBrand.mat.opacity(0.2)],
                               startPoint: .center, endPoint: .bottom)
            }
            .mask(
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: 34)
                    Color.black
                }
            )
            .padding(.top, hasNotch ? bandHeight : 0)

            if listening {
                RadialGradient(colors: [OKBrand.mint.opacity(0.2), .clear],
                               center: .top, startRadius: 0, endRadius: 140)
                    .frame(height: 90)
                    .padding(.top, hasNotch ? bandHeight - 12 : 0)
                    .transition(.opacity)
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
        VStack(alignment: .leading, spacing: 0) {
            band
            if model.hasBody {
                stage
                    .padding(.horizontal, inset)
                    .padding(.top, m.hasNotch ? 10 : 2)
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }
        }
    }

    // MARK: Band

    @ViewBuilder private var band: some View {
        if m.hasNotch {
            HStack(spacing: 0) {
                HStack(spacing: 7) {
                    OKLogo(size: 16, glow: model.listening)
                    if model.hasBody {
                        Text("okidoki")
                            .font(.okBody(12, .semibold))
                            .foregroundStyle(NotchInk.primary)
                            .lineLimit(1)
                            .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Color.clear.frame(width: m.notchWidth)
                statusIndicator
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.horizontal, m.shoulder + 12)
            .frame(height: m.bandHeight)
        } else {
            HStack(spacing: 8) {
                OKLogo(size: 16, glow: model.listening)
                Text(statusText)
                    .font(.okBody(12, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                statusIndicator
            }
            .padding(.horizontal, 14)
            .frame(height: m.bandHeight)
        }
    }

    private var statusText: String {
        if model.quiet { return "Quiet" }
        if model.listening { return "Listening" }
        if !model.waiting.isEmpty { return "Needs you" }
        if !model.live.isEmpty { return "Working" }
        if !model.toasts.isEmpty { return "Just now" }
        return "Okidoki"
    }

    @ViewBuilder private var statusIndicator: some View {
        if model.quiet {
            PixelGlyph(name: "moon", size: 10, color: NotchInk.tertiary)
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
                if model.presented {
                    PixelSpinner(size: 11, color: OKBrand.mint)
                } else {
                    Circle().fill(OKBrand.mint).frame(width: 5, height: 5)
                }
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
        VStack(alignment: .leading, spacing: 12) {
            NotchScrollArea(maxHeight: m.maxBodyHeight) {
                VStack(alignment: .leading, spacing: model.expanded ? 16 : 8) {
                    if !shownWaiting.isEmpty {
                        section(model.expanded ? "Needs you" : nil) {
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
                        section(model.expanded ? "Just now" : nil) {
                            ForEach(shownToasts) { toast in
                                NotchToastRow(toast: toast, model: model, env: env)
                                    .transition(rowTransition)
                            }
                        }
                    }
                    if !shownLive.isEmpty {
                        section(model.expanded ? "Working" : nil) {
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
            if model.expanded {
                footer.transition(.opacity)
            }
        }
    }

    private var emptyState: some View {
        HStack(spacing: 12) {
            OKOrb(size: 40, intensity: 0.7)
            VStack(alignment: .leading, spacing: 3) {
                Text(model.quiet ? "Quiet mode is on" : "Nothing needs you")
                    .font(.okBody(14, .semibold))
                    .foregroundStyle(NotchInk.primary)
                Text("Shake your mouse anywhere to ask, do or learn.")
                    .font(.okBody(12))
                    .foregroundStyle(NotchInk.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            NotchButton(title: "Ask okidoki", glyph: "spark", kind: isEmpty ? .primary : .secondary) {
                env.openDashboard(.home)
                env.requestAsk()
            }
            Spacer(minLength: 0)
            NotchIconButton(glyph: "grid", help: "Open dashboard") { env.openDashboard(.home) }
            NotchIconButton(glyph: "gear", help: "Settings") { env.openDashboard(.settings) }
        }
    }

    // MARK: Helpers

    private var rowTransition: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .offset(y: -6)),
                    removal: .opacity.animation(NotchMotion.rowRemoval))
    }

    private func section<Content: View>(_ title: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.okBody(11.5, .medium))
                    .foregroundStyle(NotchInk.tertiary)
                    .padding(.leading, 2)
                    .transition(.opacity)
            }
            content()
        }
    }

    private func moreLink(_ title: String, action: @escaping () -> Void) -> some View {
        NotchButton(title: title, kind: .plain, action: action)
            .padding(.leading, -4)
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

    private var color: Color {
        switch toast.kind {
        case .success: return OKBrand.mint
        case .warning: return NotchInk.amber
        case .approval: return OKBrand.green
        case .info: return NotchInk.sky
        }
    }

    private var glyph: String {
        switch toast.kind {
        case .success: return "check"
        case .warning: return "bolt"
        case .approval: return "hand"
        case .info: return "spark"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(color.opacity(0.15))
                PixelGlyph(name: glyph, size: 10, color: color)
            }
            .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title.notchSentence)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(NotchInk.primary)
                    .lineLimit(1)
                if !toast.detail.isEmpty {
                    Text(toast.detail.notchSentence)
                        .font(.okBody(11.5))
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
                NotchButton(title: label.notchSentence, kind: .secondary) { model.undo(toast.id) }
            }
            NotchIconButton(glyph: "x", help: "Dismiss", size: 22) { model.removeToast(toast.id) }
                .opacity(hovering ? 1 : 0.45)
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 9)
        .notchCard(hovered: hovering)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }

    private func open() {
        if let runID = toast.runID { env.openDashboard(.runs, runID: runID) } else { env.openDashboard(.home) }
    }
}

private struct NotchLiveRow: View {
    var run: NotchRunItem
    let env: AppEnvironment
    var detailed: Bool
    var animating: Bool
    @State private var hovering = false

    private var paused: Bool { run.status == .paused }

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(OKBrand.mint.opacity(0.13))
                if animating && !paused {
                    PixelSpinner(size: 11, color: OKBrand.mint)
                } else {
                    PixelGlyph(name: paused ? "pause" : "play", size: 9, color: OKBrand.mint)
                }
            }
            .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(run.title.notchSentence)
                        .font(.okBody(13, .medium))
                        .foregroundStyle(NotchInk.primary)
                        .lineLimit(1)
                    Text(paused ? "Paused" : run.kind.label.notchSentence)
                        .font(.okBody(11))
                        .foregroundStyle(NotchInk.tertiary)
                        .lineLimit(1)
                        .fixedSize()
                }
                if detailed, !run.step.isEmpty {
                    Text(run.step.notchSentence)
                        .font(.okBody(11.5))
                        .foregroundStyle(NotchInk.secondary)
                        .lineLimit(1)
                }
                NotchProgressBar(active: animating && !paused)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { env.openDashboard(.runs, runID: run.id) }

            HStack(spacing: 2) {
                NotchIconButton(glyph: paused ? "play" : "pause", help: paused ? "Resume" : "Pause", size: 22) {
                    env.pauseRun(run.id)
                }
                NotchIconButton(glyph: "stop", help: "Stop", size: 22) { env.stopRun(run.id) }
            }
            .opacity(hovering ? 1 : 0.5)
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .padding(.vertical, 9)
        .notchCard(hovered: hovering)
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(OKBrand.mint.opacity(0.13))
                    PixelGlyph(name: run.kind == .borrow ? "hand" : "bolt", size: 11, color: OKBrand.mint)
                }
                .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(run.title.notchSentence)
                        .font(.okBody(13, .semibold))
                        .foregroundStyle(NotchInk.primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(run.kind.label.notchSentence)
                            .foregroundStyle(NotchInk.tertiary)
                        Circle().fill(riskColor).frame(width: 5, height: 5)
                        Text("\(run.risk.label.notchSentence) risk")
                            .foregroundStyle(riskColor.opacity(0.9))
                    }
                    .font(.okBody(11.5))
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }

            if !run.summary.isEmpty {
                Text(run.summary.notchSentence)
                    .font(.okBody(12))
                    .foregroundStyle(NotchInk.secondary)
                    .lineLimit(compact ? 2 : 4)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !run.commands.isEmpty {
                Button {
                    withAnimation(NotchMotion.content) { showCommands.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        PixelGlyph(name: "terminal", size: 9, color: NotchInk.tertiary)
                        Text(showCommands ? "Hide commands" : "Show commands")
                            .font(.okBody(11.5, .medium))
                            .foregroundStyle(NotchInk.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if showCommands {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(run.commands.prefix(4).enumerated()), id: \.offset) { _, command in
                            Text("$ " + command)
                                .font(.okMono(10.5))
                                .foregroundStyle(Color(hex: 0xD8E2DC))
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
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.black.opacity(0.6)))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.07), lineWidth: 1))
                    .transition(.opacity)
                }
            }

            HStack(spacing: 4) {
                NotchButton(title: "Review", kind: .plain) { env.openDashboard(.runs, runID: run.id) }
                NotchButton(title: "Always allow", kind: .plain) { env.allowAlways(run.id) }
                Spacer(minLength: 6)
                NotchButton(title: "Not now", kind: .secondary) { env.denyRun(run.id) }
                NotchButton(title: run.kind == .borrow ? "Allow once" : "Do it", kind: .primary) {
                    env.approveRun(run.id)
                }
            }
            .padding(.leading, -4)
        }
        .padding(12)
        .notchCard(hovered: hovering, radius: 16)
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
    }
}

// MARK: - Controls

enum NotchButtonKind { case primary, secondary, plain }

struct NotchButton: View {
    var title: String
    var glyph: String?
    var kind: NotchButtonKind = .secondary
    var action: () -> Void
    @State private var hovering = false

    private var foreground: Color {
        switch kind {
        case .primary: return NotchInk.onMint
        case .secondary: return NotchInk.primary
        case .plain: return hovering ? NotchInk.primary : NotchInk.secondary
        }
    }

    private var fill: Color {
        switch kind {
        case .primary: return hovering ? Color(hex: 0x5BE7AA) : OKBrand.mint
        case .secondary: return Color.white.opacity(hovering ? 0.14 : 0.08)
        case .plain: return Color.white.opacity(hovering ? 0.06 : 0)
        }
    }

    private var stroke: Color {
        switch kind {
        case .primary: return .clear
        case .secondary: return Color.white.opacity(hovering ? 0.5 : 0.1)
        case .plain: return .clear
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
            .padding(.horizontal, kind == .plain ? 7 : 12)
            .frame(height: 28)
            .background(Capsule().fill(fill))
            .overlay(Capsule().strokeBorder(stroke, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(NotchPressStyle())
        .fixedSize()
        .onHover { hovering = $0 }
        .animation(NotchMotion.hover, value: hovering)
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
                .background(Circle().fill(Color.white.opacity(hovering ? 0.1 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(NotchPressStyle())
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
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                if active {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                        let width = geo.size.width
                        let segment = max(36, width * 0.35)
                        let phase = CGFloat((timeline.date.timeIntervalSinceReferenceDate * 0.6)
                            .truncatingRemainder(dividingBy: 1))
                        Capsule()
                            .fill(LinearGradient(colors: [OKBrand.mint.opacity(0), OKBrand.mint, OKBrand.mint.opacity(0)],
                                                 startPoint: .leading, endPoint: .trailing))
                            .frame(width: segment)
                            .offset(x: -segment + phase * (width + segment))
                    }
                }
            }
            // Clip the track, not the moving segment (the old bar only ever showed its left half).
            .clipShape(Capsule())
        }
        .frame(height: 2)
    }
}

private extension View {
    /// Card surface: faint fill, hairline edge; a crisp white hairline when hovered (Bucket-style focus).
    func notchCard(hovered: Bool, radius: CGFloat = 14) -> some View {
        self
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Color.white.opacity(hovered ? 0.07 : 0.045)))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.white.opacity(hovered ? 0.85 : 0.08), lineWidth: 1))
    }
}
