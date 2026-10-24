import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

// MARK: - Model

@MainActor
final class TeachModel: ObservableObject {
    @Published var topic = ""
    @Published var steps: [TeachStepDisplay] = []
    @Published var index = 0
    @Published var isActive = false
    @Published var progress: CGFloat = 0
    var runID: String?
    var threadID: String?
}

struct TeachStepDisplay {
    var say: String
    var marks: [TeachMark]
}

// MARK: - Controller

final class TeachPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class TeachControlPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class TeachController {
    let model = TeachModel()
    private weak var env: AppEnvironment?
    private var highlightPanel: TeachPanel?
    private var controlPanel: TeachControlPanel?
    private var screen: NSScreen?
    private var targetPid: pid_t?
    private var targetName: String = ""

    init(environment: AppEnvironment) { self.env = environment }

    /// Legacy string-steps entry (skills, canned library): heuristic marks are derived per step.
    func start(topic: String, steps: [String], runID: String?, threadID: String?) {
        let plan = steps.map { TeachPlanStep(say: $0) }
        start(topic: topic, plan: plan, runID: runID, threadID: threadID)
    }

    /// Rich entry: plan steps carry drawing instructions from the brain.
    func start(topic: String, plan: [TeachPlanStep], runID: String?, threadID: String?) {
        guard !plan.isEmpty else { return }
        model.topic = topic
        model.steps = plan.map { step in
            TeachStepDisplay(say: step.say, marks: step.marks.isEmpty ? TeachHeuristics.marks(for: step.say) : step.marks)
        }
        model.index = 0
        model.runID = runID
        model.threadID = threadID
        model.isActive = true
        model.progress = 0
        let front = NSWorkspace.shared.frontmostApplication
        targetPid = front?.processIdentifier
        targetName = front?.localizedName ?? "your app"
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.okidokiPrimary
        self.screen = screen
        buildPanels(on: screen)
        highlightPanel?.orderFrontRegardless()
        controlPanel?.orderFrontRegardless()
        animateProgress()
    }

    private func buildPanels(on screen: NSScreen) {
        closePanels()
        let highlight = TeachPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
        highlight.isOpaque = false
        highlight.backgroundColor = .clear
        highlight.hasShadow = false
        highlight.level = .statusBar + 3
        highlight.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        highlight.ignoresMouseEvents = true
        highlight.sharingType = .none
        highlight.isReleasedWhenClosed = false
        highlight.contentView = NSHostingView(rootView: TeachHighlightView(model: model, screen: screen, targetPid: targetPid))
        highlight.setFrame(screen.frame, display: false)
        highlightPanel = highlight

        let width: CGFloat = 570
        let height: CGFloat = 132
        let control = TeachControlPanel(contentRect: NSRect(x: screen.frame.midX - width / 2,
                                                            y: screen.visibleFrame.minY + 26,
                                                            width: width, height: height),
                                        styleMask: [.borderless, .nonactivatingPanel],
                                        backing: .buffered, defer: false)
        control.isOpaque = false
        control.backgroundColor = .clear
        control.hasShadow = false
        control.level = .statusBar + 4
        control.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        control.sharingType = .none
        control.isReleasedWhenClosed = false
        let view = TeachControlView(
            model: model,
            onBack: { [weak self] in self?.back() },
            onNext: { [weak self] in self?.next() },
            onStop: { [weak self] in self?.stop(completed: false) }
        )
        .environmentObject(env!)
        control.contentView = NSHostingView(rootView: view)
        controlPanel = control
    }

    private func animateProgress() {
        model.progress = 0
        withAnimation(.easeOut(duration: 0.55)) { model.progress = 1 }
    }

    func next() {
        if model.index + 1 < model.steps.count {
            withAnimation(OKMotion.spring) { model.index += 1 }
            animateProgress()
            env?.speaker.speak(model.steps[model.index].say, voiceID: env?.store.settings.voiceID ?? "sarah",
                              speed: env?.store.settings.voiceSpeed ?? 1)
        } else {
            stop(completed: true)
        }
    }

    func back() {
        guard model.index > 0 else { return }
        withAnimation(OKMotion.spring) { model.index -= 1 }
        animateProgress()
    }

    func stop(completed: Bool) {
        guard model.isActive else { return }
        model.isActive = false
        closePanels()
        if let runID = model.runID {
            if completed {
                env?.finishTeach(runID: runID, topic: model.topic, threadID: model.threadID)
            } else {
                env?.cancelRun(runID)
            }
        }
        model.runID = nil
    }

    private func closePanels() {
        highlightPanel?.orderOut(nil)
        controlPanel?.orderOut(nil)
        highlightPanel = nil
        controlPanel = nil
    }
}

// MARK: - Heuristic marks for plain-text steps

enum TeachHeuristics {
    static func marks(for say: String) -> [TeachMark] {
        let t = say.lowercased()
        if t.contains("right panel") || t.contains("right sidebar") || t.contains("inspector") {
            return [TeachMark(kind: "box", rect: [0.68, 0.05, 0.30, 0.9])]
        }
        if t.contains("left panel") || t.contains("left sidebar") || t.contains("layers") {
            return [TeachMark(kind: "box", rect: [0.0, 0.05, 0.30, 0.9])]
        }
        if t.contains("top") || t.contains("toolbar") || t.contains("menu bar") || t.contains("menu") {
            return [TeachMark(kind: "box", rect: [0.0, 0.0, 1.0, 0.2])]
        }
        if t.contains("bottom") || t.contains("terminal") || t.contains("command line") || t.contains("status bar") {
            return [TeachMark(kind: "box", rect: [0.1, 0.58, 0.8, 0.4])]
        }
        if t.contains("drag") {
            return [TeachMark(kind: "cursor", point: [0.3, 0.5], to: [0.7, 0.5])]
        }
        if t.contains("button") || t.contains("click") || t.contains("press") || t.contains("select") || t.contains("field") {
            return [TeachMark(kind: "circle", rect: [0.3, 0.3, 0.4, 0.35])]
        }
        return [TeachMark(kind: "box", rect: [0.08, 0.08, 0.84, 0.84])]
    }
}

// MARK: - Resolved marks

struct ResolvedMark {
    var kind: String
    var rect: CGRect
    var from: CGPoint
    var to: CGPoint?
    var text: String?
    var seconds: Double
}

/// Resolve a mark's target: accessibility label first, relative rect/point on the app window second,
/// window center last. All in overlay-local coordinates (top-left origin of the highlight panel).
@MainActor
enum TeachMarkResolver {
    static func resolve(_ mark: TeachMark, screen: NSScreen, window: CGRect?, pid: pid_t?) -> ResolvedMark? {
        let fallback = window ?? CGRect(x: screen.frame.width * 0.18, y: screen.frame.height * 0.16,
                                        width: screen.frame.width * 0.64, height: screen.frame.height * 0.62)
        var rect: CGRect
        if let target = mark.target, !target.isEmpty, let pid,
           let found = AXSearch.find(target: target, pid: pid) {
            let globalTopLeft = found.rect
            let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
            let local = CGRect(x: globalTopLeft.minX - screen.frame.minX,
                               y: globalTopLeft.minY - (mainHeight - screen.frame.maxY),
                               width: globalTopLeft.width, height: globalTopLeft.height)
            rect = local
        } else if let r = mark.rect, r.count >= 4 {
            rect = CGRect(x: fallback.minX + fallback.width * CGFloat(r[0]),
                          y: fallback.minY + fallback.height * CGFloat(r[1]),
                          width: fallback.width * CGFloat(r[2]),
                          height: fallback.height * CGFloat(r[3]))
        } else if let p = mark.point, p.count >= 2 {
            let point = CGPoint(x: fallback.minX + fallback.width * CGFloat(p[0]),
                                y: fallback.minY + fallback.height * CGFloat(p[1]))
            rect = CGRect(x: point.x - 90, y: point.y - 44, width: 180, height: 88)
        } else {
            rect = fallback.insetBy(dx: fallback.width * 0.18, dy: fallback.height * 0.22)
        }
        rect = rect.insetBy(dx: -8, dy: -8)
        let from: CGPoint? = mark.point.map { p in
            CGPoint(x: fallback.minX + fallback.width * CGFloat(p.first ?? 0.5),
                    y: fallback.minY + fallback.height * CGFloat(p.count > 1 ? p[1] : 0.5))
        } ?? (mark.rect.map { r in CGPoint(x: fallback.minX + fallback.width * CGFloat(r.first ?? 0.5),
                                           y: fallback.minY + fallback.height * CGFloat(r.count > 1 ? r[1] : 0.5)) })
        let to: CGPoint? = mark.to.map { t in
            CGPoint(x: fallback.minX + fallback.width * CGFloat(t.first ?? 0.5),
                    y: fallback.minY + fallback.height * CGFloat(t.count > 1 ? t[1] : 0.5))
        }
        return ResolvedMark(kind: mark.kind, rect: rect, from: from ?? rect.center,
                            to: to, text: mark.text, seconds: mark.seconds ?? 1.1)
    }
}

extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}

// MARK: - Highlight overlay

struct TeachHighlightView: View {
    @ObservedObject var model: TeachModel
    let screen: NSScreen
    let targetPid: pid_t?

    var body: some View {
        GeometryReader { geo in
            let marks = currentMarks(in: geo.size)
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.05)
                ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                    TeachAnnotationView(mark: mark, progress: model.progress)
                }
                VStack {
                    Spacer()
                    HStack(spacing: 7) {
                        PixelGlyph(name: "wand", size: 10, color: Color(hex: 0x1FB57A))
                        Text("teaching · \(model.topic)")
                            .font(.okMono(9, .medium))
                            .textCase(.lowercase)
                            .foregroundStyle(Color.white.opacity(0.8))
                        Spacer()
                        Text("\(model.index + 1) / \(model.steps.count)")
                            .font(.okMono(9))
                            .foregroundStyle(Color(hex: 0x1FB57A))
                    }
                    .padding(.horizontal, 12)
                    .frame(width: 230, height: 30)
                    .background(Capsule().fill(Color(hex: 0x0B0B0C).opacity(0.9)))
                    .overlay(Capsule().stroke(Color.white.opacity(0.1), lineWidth: 0.6))
                    .padding(.bottom, 172)
                }
                .frame(maxWidth: .infinity)
            }
            .allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }

    private func currentMarks(in size: CGSize) -> [ResolvedMark] {
        guard model.steps.indices.contains(model.index) else { return [] }
        let window = frontWindowRect(localSize: size)
        return model.steps[model.index].marks.compactMap { mark in
            TeachMarkResolver.resolve(mark, screen: screen, window: window, pid: targetPid)
        }
    }

    private func frontWindowRect(localSize size: CGSize) -> CGRect? {
        guard let pid = targetPid else { return nil }
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        var best: CGRect?
        var bestArea: CGFloat = 0
        for window in info {
            guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
            let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0,
                              width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
            let area = rect.width * rect.height
            if area > bestArea { best = rect; bestArea = area }
        }
        guard let best else { return nil }
        let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let localX = best.minX - screen.frame.minX
        let localY = best.minY - (mainHeight - screen.frame.maxY)
        return CGRect(x: localX, y: localY, width: best.width, height: best.height)
    }
}

// MARK: - Annotation views

struct TeachAnnotationView: View {
    let mark: ResolvedMark
    let progress: CGFloat
    private let accent = Color(hex: 0x1FB57A)

    var body: some View {
        switch mark.kind {
        case "circle":
            RoughOval(seed: 3)
                .trim(from: 0, to: progress)
                .stroke(accent, style: StrokeStyle(lineWidth: 2.6, lineCap: .round, lineJoin: .round))
                .shadow(color: accent.opacity(0.55), radius: 8)
                .frame(width: mark.rect.width, height: mark.rect.height)
                .offset(x: mark.rect.minX, y: mark.rect.minY)
        case "box":
            ZStack {
                RoughRect(seed: 1)
                    .trim(from: 0, to: progress)
                    .stroke(accent, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                    .shadow(color: accent.opacity(0.55), radius: 8)
                    .frame(width: mark.rect.width, height: mark.rect.height)
                    .offset(x: mark.rect.minX, y: mark.rect.minY)
                CornerMarks()
                    .stroke(accent.opacity(0.8), style: StrokeStyle(lineWidth: 2, lineCap: .square))
                    .frame(width: mark.rect.width + 18, height: mark.rect.height + 18)
                    .offset(x: mark.rect.minX - 9, y: mark.rect.minY - 9)
            }
        case "arrow":
            if let to = mark.to {
                ArrowShape()
                    .trim(from: 0, to: progress)
                    .stroke(accent, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .shadow(color: accent.opacity(0.5), radius: 6)
                    .frame(width: max(24, abs(to.x - mark.from.x)),
                           height: max(24, abs(to.y - mark.from.y)))
                    .offset(x: min(mark.from.x, to.x), y: min(mark.from.y, to.y))
                    .scaleEffect(x: to.x < mark.from.x ? -1 : 1, y: to.y < mark.from.y ? -1 : 1,
                                 anchor: .topLeading)
            }
        case "cursor":
            CursorPathView(from: mark.from, to: mark.to ?? mark.from, progress: progress, seconds: mark.seconds)
        case "label":
            HStack(spacing: 6) {
                Rectangle().fill(accent).frame(width: 5, height: 5)
                Text(mark.text ?? "")
                    .font(.okMono(10, .medium))
                    .textCase(.lowercase)
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(Capsule().fill(Color(hex: 0x0B0B0C).opacity(0.94)))
            .overlay(Capsule().stroke(accent.opacity(0.35), lineWidth: 0.8))
            .opacity(Double(progress))
            .offset(x: mark.rect.minX + 6, y: max(30, mark.rect.minY - 30))
        case "dim":
            DimSpotlight(rect: mark.rect, progress: progress)
        case "ink":
            InkScribble(seed: 7)
                .trim(from: 0, to: progress)
                .stroke(accent, style: StrokeStyle(lineWidth: 2.8, lineCap: .round, lineJoin: .round))
                .shadow(color: accent.opacity(0.45), radius: 6)
                .frame(width: mark.rect.width, height: mark.rect.height)
                .offset(x: mark.rect.minX, y: mark.rect.minY)
        default:
            EmptyView()
        }
    }
}

/// A moving cursor dot that demonstrates a drag/click motion from one point to another.
struct CursorPathView: View {
    let from: CGPoint
    let to: CGPoint
    let progress: CGFloat
    var seconds: Double = 1.1
    @State private var t: Double = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
            let now = timeline.date.timeIntervalSinceReferenceDate
            let cycle = max(0.4, seconds + 0.5)
            let phase = (now.truncatingRemainder(dividingBy: cycle)) / cycle
            let eased = phase < 0.75 ? (phase / 0.75) * (phase / 0.75) * (3 - 2 * (phase / 0.75)) : 1
            let x = from.x + (to.x - from.x) * eased
            let y = from.y + (to.y - from.y) * eased
            let landed = phase > 0.78
            let ripples = phase > 0.78 ? (phase - 0.78) / 0.22 : 0
            ZStack {
                Path { path in
                    path.move(to: from)
                    path.addQuadCurve(to: CGPoint(x: x, y: y),
                                      control: CGPoint(x: (from.x + x) / 2, y: min(from.y, y) - 36))
                }
                .trim(from: 0, to: eased)
                .stroke(Color(hex: 0x1FB57A).opacity(0.35),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [1, 7]))
                ZStack {
                    Circle().fill(Color(hex: 0x1FB57A).opacity(0.18))
                        .frame(width: 42, height: 42)
                        .blur(radius: 7)
                    GhostArrow()
                        .fill(Color(hex: 0xFFFBF4))
                        .frame(width: 24, height: 30)
                        .overlay(GhostArrow().stroke(Color(hex: 0x1FB57A), lineWidth: 1.5).frame(width: 24, height: 30))
                        .shadow(color: .black.opacity(0.35), radius: 5, y: 2)
                    if landed {
                        Circle().stroke(Color(hex: 0x1FB57A), lineWidth: 2)
                            .frame(width: 30 + ripples * 26, height: 30 + ripples * 26)
                            .opacity(1 - ripples)
                    }
                }
                .position(x: x, y: y)
            }
        }
    }
}

struct DimSpotlight: View {
    let rect: CGRect
    let progress: CGFloat

    var body: some View {
        GeometryReader { geo in
            let hole = rect.insetBy(dx: -14, dy: -14)
            Path { path in
                path.addRect(CGRect(origin: .zero, size: geo.size))
                path.addRoundedRect(in: hole, cornerSize: CGSize(width: 14, height: 14))
            }
            .fill(Color.black.opacity(0.34 * Double(progress)), style: FillStyle(eoFill: true))
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(hex: 0x1FB57A).opacity(0.9 * Double(progress)), lineWidth: 2.2)
                .frame(width: hole.width, height: hole.height)
                .offset(x: hole.minX, y: hole.minY)
        }
    }
}

struct ArrowShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let head: CGFloat = min(18, rect.width * 0.35)
        let midY = rect.height / 2
        path.move(to: CGPoint(x: 0, y: midY))
        path.addLine(to: CGPoint(x: rect.width - head, y: midY))
        path.move(to: CGPoint(x: rect.width - head - 1, y: midY - head * 0.55))
        path.addLine(to: CGPoint(x: rect.width, y: midY))
        path.addLine(to: CGPoint(x: rect.width - head - 1, y: midY + head * 0.55))
        return path
    }
}

struct RoughOval: Shape {
    var seed: Int
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let points = 40
        for i in 0...points {
            let t = CGFloat(i) / CGFloat(points)
            let angle = t * 2 * .pi
            let wobble = 1 + sin(CGFloat(i) * 1.9 + CGFloat(seed)) * 0.022
            let x = rect.midX + cos(angle) * (rect.width / 2 - 3) * wobble
            let y = rect.midY + sin(angle) * (rect.height / 2 - 3) * wobble
            if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        path.closeSubpath()
        return path
    }
}

/// A hand-drawn scribble that underlines/sweeps across a region.
struct InkScribble: Shape {
    var seed: Int
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let sweeps = 3
        for s in 0..<sweeps {
            let y = rect.minY + rect.height * (0.35 + CGFloat(s) * 0.16)
            path.move(to: CGPoint(x: rect.minX + 6, y: y + sin(CGFloat(s)) * 3))
            let steps = 6
            for i in 1...steps {
                let x = rect.minX + 6 + (rect.width - 12) * CGFloat(i) / CGFloat(steps)
                let wobble = sin(CGFloat(i) * 2.3 + CGFloat(seed) + CGFloat(s)) * 3.4
                path.addLine(to: CGPoint(x: x, y: y + wobble))
            }
        }
        return path
    }
}

struct RoughRect: Shape {
    var seed: Int
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let points = 44
        let w = rect.width
        let h = rect.height
        for i in 0..<points {
            let t = CGFloat(i) / CGFloat(points)
            let perimeter = t * 4
            var point: CGPoint
            switch perimeter {
            case ..<1: point = CGPoint(x: rect.minX + w * perimeter, y: rect.minY)
            case 1..<2: point = CGPoint(x: rect.maxX, y: rect.minY + h * (perimeter - 1))
            case 2..<3: point = CGPoint(x: rect.maxX - w * (perimeter - 2), y: rect.maxY)
            default: point = CGPoint(x: rect.minX, y: rect.maxY - h * (perimeter - 3))
            }
            let wobble = sin(CGFloat(i) * 1.7 + CGFloat(seed)) * 1.3
            point.x += wobble
            point.y += cos(CGFloat(i) * 1.3 + CGFloat(seed)) * 1.1
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }
}

struct CornerMarks: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let len: CGFloat = 12
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + len)); path.addLine(to: CGPoint(x: rect.minX, y: rect.minY)); path.addLine(to: CGPoint(x: rect.minX + len, y: rect.minY))
        path.move(to: CGPoint(x: rect.maxX - len, y: rect.minY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + len))
        path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - len)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.maxX - len, y: rect.maxY))
        path.move(to: CGPoint(x: rect.minX + len, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - len))
        return path
    }
}

// MARK: - Control card

struct TeachControlView: View {
    @ObservedObject var model: TeachModel
    @EnvironmentObject private var env: AppEnvironment
    @Environment(\.colorScheme) private var scheme
    var onBack: () -> Void
    var onNext: () -> Void
    var onStop: () -> Void

    private var theme: OKTheme { OKTheme(scheme) }
    private var step: String { model.steps.indices.contains(model.index) ? model.steps[model.index].say : "" }

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(Color(hex: 0x1FB57A).opacity(0.12))
                    .frame(width: 42, height: 42)
                VStack(spacing: -2) {
                    Text("\(model.index + 1)")
                        .font(.okDisplay(22))
                        .foregroundStyle(Color(hex: 0x1FB57A))
                    Text("of \(model.steps.count)")
                        .font(.okMono(7))
                        .foregroundStyle(theme.tertiary)
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(model.topic)
                        .font(.okMono(8.5, .medium))
                        .textCase(.uppercase)
                        .foregroundStyle(Color(hex: 0x1FB57A))
                    Rectangle().fill(theme.line).frame(width: 1, height: 9)
                    Text("i'll wait for you")
                        .font(.okMono(8.5))
                        .foregroundStyle(theme.tertiary)
                }
                Text(step)
                    .font(.okBody(12.5, .medium))
                    .foregroundStyle(theme.ink)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(3)
                HStack(spacing: 7) {
                    Button("back") { onBack() }
                        .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                        .disabled(model.index == 0)
                        .opacity(model.index == 0 ? 0.35 : 1)
                    Spacer()
                    Button("stop") { onStop() }
                        .buttonStyle(.plain)
                        .font(.okMono(9))
                        .foregroundStyle(theme.tertiary)
                    Button(model.index + 1 == model.steps.count ? "finish" : "next") { onNext() }
                        .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
                }
            }
        }
        .padding(13)
        .frame(width: 570, height: 132, alignment: .topLeading)
        .background {
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .fill(theme.card)
                .shadow(color: .black.opacity(0.26), radius: 26, y: 12)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 17, style: .continuous)
                .stroke(theme.dark ? Color.white.opacity(0.11) : Color.black.opacity(0.1), lineWidth: 0.8)
        )
        .overlay(alignment: .top) {
            LinearGradient(colors: [Color(hex: 0x1FB57A).opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(height: 2).padding(.horizontal, 22)
        }
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
    }
}
