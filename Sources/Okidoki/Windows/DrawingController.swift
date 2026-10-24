import AppKit
import SwiftUI
import OkidokiCore

@MainActor
final class DrawingModel: ObservableObject {
    @Published var strokes: [[CGPoint]] = []
    @Published var active: [CGPoint] = []
    @Published var colorHex = "44E45E"
    @Published var style: DrawingStyle = .ink
}

final class DrawingPanel: NSPanel {
    // Never key: the summon box keeps the keyboard while you circle things.
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class DrawingHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// While the summon box is up, the screen under it is a quiet canvas: drag to circle
/// something and it rides along with the question; a plain click puts okidoki away.
@MainActor
final class DrawingController {
    let model = DrawingModel()
    private weak var env: AppEnvironment?
    private var panel: DrawingPanel?
    private var screen: NSScreen?
    private var captureGeneration = 0

    init(environment: AppEnvironment) { self.env = environment }

    var isArmed: Bool { panel != nil }

    func arm() {
        guard let env else { return }
        model.colorHex = env.store.settings.drawingColorHex
        model.style = env.store.settings.drawingStyle
        let screen = OverlayPlacement.mouseScreen ?? NSScreen.okidokiPrimary
        if let panel, self.screen?.frame == screen.frame {
            panel.orderFrontRegardless()
            return
        }
        disarm()
        self.screen = screen
        let panel = DrawingPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                 backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 3 // just under the summon box
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        let view = DrawingView(model: model, onStroke: { [weak self] points in
            self?.finish(points: points)
        }, onTap: { [weak self] in
            self?.env?.summon.clickedAway()
        })
        panel.contentView = DrawingHostingView(rootView: view)
        panel.setFrame(screen.frame, display: false)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    func disarm() {
        captureGeneration += 1
        panel?.orderOut(nil)
        panel = nil
        screen = nil
        model.strokes = []
        model.active = []
    }

    func dismissAll() { disarm() }

    private func finish(points: [CGPoint]) {
        guard points.count > 2, let screen else { return }
        model.strokes = [points]
        let xs = points.map(\.x)
        let ys = points.map(\.y)
        let localRect = CGRect(x: xs.min()!, y: ys.min()!, width: max(8, xs.max()! - xs.min()!), height: max(8, ys.max()! - ys.min()!))
        let padded = localRect.insetBy(dx: -18, dy: -18).intersection(CGRect(origin: .zero, size: screen.frame.size))
        let globalSelection = CGRect(x: screen.frame.minX + padded.minX,
                                     y: screen.frame.maxY - padded.maxY,
                                     width: padded.width, height: padded.height)
        captureGeneration += 1
        let generation = captureGeneration
        // Our overlays are excluded from capture (sharingType = .none), so nothing has to hide.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.captureGeneration == generation else { return }
            let image = ScreenCaptureService.capture(rect: padded, on: screen)
            self.env?.summon.attachSelection(name: "Selection", image: image, selection: globalSelection)
            if image == nil {
                self.model.strokes = []
                self.env?.toast(title: "couldn't capture the screen",
                                detail: "grant screen recording in onboarding, then try again",
                                kind: .warning,
                                undoLabel: nil,
                                onUndo: nil,
                                editLabel: nil,
                                onEdit: nil,
                                runID: nil)
            }
        }
    }
}

struct DrawingView: View {
    @ObservedObject var model: DrawingModel
    var onStroke: ([CGPoint]) -> Void
    var onTap: () -> Void

    private var color: Color { Color(hexString: model.colorHex) }

    var body: some View {
        ZStack {
            // Practically invisible, but it has to be hit-testable.
            Color.black.opacity(0.001)
            Canvas { context, _ in
                for stroke in model.strokes { draw(stroke, context: &context) }
                if !model.active.isEmpty { draw(model.active, context: &context) }
            }
            .shadow(color: .black.opacity(0.12), radius: 1.5, y: 1)
            .allowsHitTesting(false)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .local)
                .onChanged { value in
                    if model.active.isEmpty {
                        model.active = [value.location]
                    } else if let last = model.active.last,
                              hypot(value.location.x - last.x, value.location.y - last.y) > 1.2 {
                        model.active.append(value.location)
                    }
                }
                .onEnded { _ in
                    let stroke = model.active
                    model.active = []
                    let length = zip(stroke, stroke.dropFirst()).reduce(CGFloat(0)) { sum, pair in
                        sum + hypot(pair.1.x - pair.0.x, pair.1.y - pair.0.y)
                    }
                    if length > 30 {
                        onStroke(stroke)
                    } else if length < 6 {
                        onTap()
                    }
                }
        )
    }

    private func draw(_ points: [CGPoint], context: inout GraphicsContext) {
        guard points.count > 1 else {
            if let point = points.first {
                let rect = CGRect(x: point.x - 2, y: point.y - 2, width: 4, height: 4)
                context.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.8)))
            }
            return
        }
        var path = Path()
        path.move(to: points[0])
        for index in 1..<points.count {
            let point = points[index]
            let previous = points[index - 1]
            let mid = CGPoint(x: (point.x + previous.x) / 2, y: (point.y + previous.y) / 2)
            let jitter = CGFloat(sin(Double(index) * 1.7)) * (model.style == .pencil ? 1.3 : 0.45)
            path.addQuadCurve(to: CGPoint(x: mid.x + jitter, y: mid.y - jitter), control: previous)
        }
        if let last = points.last { path.addLine(to: last) }
        let width: CGFloat = model.style == .marker ? 9 : (model.style == .pencil ? 1.8 : 3.2)
        let opacity: Double = model.style == .marker ? 0.45 : 0.95
        context.stroke(path, with: .color(color.opacity(opacity)),
                       style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }
}

enum ScreenCaptureService {
    static func capture(rect: CGRect, on screen: NSScreen) -> Data? {
        guard CGPreflightScreenCaptureAccess() else {
            let _ = CGRequestScreenCaptureAccess()
            return nil
        }
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-capture-\(UUID().uuidString).png")
        let mainHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let topY = mainHeight - screen.frame.maxY + rect.minY
        let x = screen.frame.minX + rect.minX
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-R", "\(Int(x)),\(Int(topY)),\(Int(rect.width)),\(Int(rect.height))", temp.path]
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  let data = try? Data(contentsOf: temp) else { return nil }
            try? FileManager.default.removeItem(at: temp)
            return data
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return nil
        }
    }
}
