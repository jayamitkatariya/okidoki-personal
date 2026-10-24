import AppKit
import ApplicationServices
import SwiftUI
import OkidokiCore

// MARK: - Accessibility lookup

enum AccessibilityLocator {
    static func find(target: String, pid: pid_t) -> (point: CGPoint, label: String)? {
        guard AXIsProcessTrusted(), !target.isEmpty else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var queue: [AXUIElement] = [app]
        var visited = 0
        let needle = target.lowercased()
        while !queue.isEmpty && visited < 600 {
            let element = queue.removeFirst()
            visited += 1
            var title = "", description = "", value = "", role = ""
            for (key, bucket) in [(kAXTitleAttribute, 0), (kAXDescriptionAttribute, 1), (kAXValueAttribute, 2), (kAXRoleAttribute, 3)] {
                var raw: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, key as CFString, &raw) == .success {
                    let string = (raw as? String) ?? ""
                    switch bucket {
                    case 0: title = string
                    case 1: description = string
                    case 2: value = string
                    default: role = string
                    }
                }
            }
            let haystack = "\(title) \(description) \(value) \(role)".lowercased()
            if haystack.contains(needle), let center = center(of: element) {
                let label = [title, description, value].first { !$0.isEmpty } ?? role
                return (center, label)
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(60))
            }
        }
        return nil
    }

    private static func center(of element: AXUIElement) -> CGPoint? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posValue = posRef, let sizeValue = sizeRef,
              CFGetTypeID(posValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posValue as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        guard size.width > 0, size.height > 0, size.width < 4000 else { return nil }
        return CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    }
}

// MARK: - Ghost cursor

@MainActor
final class BorrowModel: ObservableObject {
    @Published var visible = false
    @Published var point: CGPoint = .zero
    @Published var label = "okidoki is taking over"
    @Published var clicking = false
    @Published var screenFrame: CGRect = .zero
}

final class GhostPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class GhostCursorController {
    let model = BorrowModel()
    private weak var env: AppEnvironment?
    private var panel: GhostPanel?
    private var screen: NSScreen?
    private var escMonitor: Any?
    private var globalEsc: Any?
    private var moveMonitor: Any?
    private var runID: String?
    private var targetGlobal: CGPoint = .zero
    private var startMouse: CGPoint = .zero
    private var started = Date()
    private var cancelled = false

    init(environment: AppEnvironment) { self.env = environment }

    func begin(target: String, appName: String, runID: String) {
        guard !model.visible else { return }
        self.runID = runID
        cancelled = false
        let front = NSWorkspace.shared.frontmostApplication
        let pid = front?.processIdentifier ?? 0
        let found = AccessibilityLocator.find(target: target, pid: pid)
        let axPoint = found?.point ?? CGPoint(x: NSEvent.mouseLocation.x, y: (NSScreen.screens.first?.frame.height ?? 0) - NSEvent.mouseLocation.y)
        model.label = found == nil ? "taking over — clicking here" : "clicking “\(found!.label)”"
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let globalBL = CGPoint(x: axPoint.x, y: mainHeight - axPoint.y)
        targetGlobal = globalBL
        screen = NSScreen.screens.first(where: { $0.frame.contains(globalBL) }) ?? NSScreen.okidokiPrimary
        guard let screen else { return }
        let local = CGPoint(x: globalBL.x - screen.frame.minX, y: screen.frame.maxY - globalBL.y)
        model.screenFrame = screen.frame
        model.point = local
        model.visible = true
        model.clicking = false
        let panel = GhostPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 6
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: GhostCursorView(model: model))
        panel.setFrame(screen.frame, display: false)
        panel.orderFrontRegardless()
        self.panel = panel
        startMouse = NSEvent.mouseLocation
        started = Date()
        installMonitors()
        env?.speaker.speak("taking over for a second.", voiceID: env?.store.settings.voiceID ?? "sarah",
                           speed: env?.store.settings.voiceSpeed ?? 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.05) { [weak self] in
            self?.performClick()
        }
    }

    private func performClick() {
        guard !cancelled, model.visible else { return }
        if let moveMonitor {
            NSEvent.removeMonitor(moveMonitor)
            self.moveMonitor = nil
        }
        let mouse = NSEvent.mouseLocation
        if hypot(mouse.x - startMouse.x, mouse.y - startMouse.y) > 8 {
            cancel(reason: "you moved — control is yours")
            return
        }
        model.clicking = true
        AccessibilityActions.click(at: targetGlobal)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            guard let self, !self.cancelled else { return }
            self.finish()
        }
    }

    private func installMonitors() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
                return nil
            }
            return event
        }
        globalEsc = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.cancel(reason: "okay, stopping") }
            }
        }
        moveMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.model.visible, Date().timeIntervalSince(self.started) > 0.25 else { return }
                let mouse = NSEvent.mouseLocation
                if hypot(mouse.x - self.startMouse.x, mouse.y - self.startMouse.y) > 8 {
                    self.cancel(reason: "you moved — control is yours")
                }
            }
        }
    }

    private func removeMonitors() {
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        if let globalEsc { NSEvent.removeMonitor(globalEsc) }
        if let moveMonitor { NSEvent.removeMonitor(moveMonitor) }
        escMonitor = nil; globalEsc = nil; moveMonitor = nil
    }

    private func finish() {
        guard let runID else { return }
        cancelled = true
        model.visible = false
        panel?.orderOut(nil)
        panel = nil
        removeMonitors()
        env?.finishBorrow(runID: runID)
        self.runID = nil
    }

    func cancel(reason: String = "control is yours") {
        guard model.visible else { return }
        cancelled = true
        model.visible = false
        panel?.orderOut(nil)
        panel = nil
        removeMonitors()
        if let runID {
            env?.cancelRun(runID)
            env?.toast(title: "yours again", detail: reason, kind: .info,
                       undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
        }
        runID = nil
    }
}

struct GhostCursorView: View {
    @ObservedObject var model: BorrowModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            ZStack(alignment: .topLeading) {
                Color.clear
                let pulse = 0.5 + 0.5 * sin(t * 6)
                ZStack {
                    Circle().fill(Color(hex: 0x1FB57A).opacity(0.16))
                        .frame(width: model.clicking ? 90 : 54, height: model.clicking ? 90 : 54)
                        .blur(radius: 16)
                    GhostArrow()
                        .fill(Color(hex: 0xFFFBF4))
                        .frame(width: 27, height: 34)
                        .overlay(GhostArrow().stroke(Color(hex: 0x1FB57A), lineWidth: 1.6).frame(width: 27, height: 34))
                        .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
                    if model.clicking {
                        Circle().stroke(Color(hex: 0x1FB57A), lineWidth: 2)
                            .frame(width: 44 + pulse * 12, height: 44 + pulse * 12)
                            .opacity(1 - pulse)
                    }
                }
                .position(model.point)
                VStack(alignment: .leading, spacing: 2) {
                    Text("okidoki")
                        .font(.okDisplay(18))
                        .foregroundStyle(Color(hex: 0x1FB57A))
                    Text(model.label)
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.white.opacity(0.6))
                        .lineLimit(1)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x0B0B0C).opacity(0.94)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.1), lineWidth: 0.7))
                .position(x: model.point.x + 20, y: model.point.y + 62)
                Text("move your mouse or press esc to take back control")
                    .font(.okMono(9))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .padding(.horizontal, 11)
                    .frame(height: 28)
                    .background(Capsule().fill(Color(hex: 0x0B0B0C).opacity(0.9)))
                    .position(x: model.screenFrame.width / 2, y: model.screenFrame.height - 42)
            }
            .frame(width: model.screenFrame.width, height: model.screenFrame.height)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .opacity(model.visible ? 1 : 0)
        .animation(.easeOut(duration: 0.18), value: model.visible)
        .animation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.9), value: model.point)
        .animation(OKMotion.snappy, value: model.clicking)
    }
}

struct GhostArrow: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width, h = rect.height
        path.move(to: CGPoint(x: w * 0.12, y: 0))
        path.addLine(to: CGPoint(x: w * 0.12, y: h * 0.92))
        path.addLine(to: CGPoint(x: w * 0.38, y: h * 0.66))
        path.addLine(to: CGPoint(x: w * 0.56, y: h * 1.0))
        path.addLine(to: CGPoint(x: w * 0.72, y: h * 0.94))
        path.addLine(to: CGPoint(x: w * 0.54, y: h * 0.62))
        path.addLine(to: CGPoint(x: w * 0.88, y: h * 0.58))
        path.closeSubpath()
        return path
    }
}

// MARK: - Watch HUD

@MainActor
final class WatchHUDModel: ObservableObject {
    @Published var visible = false
    @Published var elapsed: TimeInterval = 0
    @Published var steps = 0
}

final class WatchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class WatchHUDController {
    let model = WatchHUDModel()
    private weak var env: AppEnvironment?
    private var panel: WatchPanel?
    private var timer: Timer?

    init(environment: AppEnvironment) { self.env = environment }

    func show() {
        guard let env else { return }
        model.visible = true
        model.elapsed = 0
        model.steps = 0
        let screen = NSScreen.okidokiPrimary
        let width: CGFloat = 310
        let height: CGFloat = 40
        let y = screen.visibleFrame.maxY - height - 12
        let panel = WatchPanel(contentRect: NSRect(x: screen.frame.midX - width / 2, y: y, width: width, height: height),
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar + 3
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: WatchHUDView(model: model, onStop: { [weak self] in self?.env?.stopWatching() })
            .environmentObject(env))
        panel.orderFrontRegardless()
        self.panel = panel
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let env = self.env else { return }
                self.model.elapsed = env.watch.startedAt.map { Date().timeIntervalSince($0) } ?? 0
                self.model.steps = max(0, env.watch.steps.count - 1)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func hide() {
        model.visible = false
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
        panel = nil
    }
}

struct WatchHUDView: View {
    @ObservedObject var model: WatchHUDModel
    @EnvironmentObject private var env: AppEnvironment
    var onStop: () -> Void
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(Color(hex: 0xFF453A).opacity(0.2)).frame(width: 20, height: 20)
                    .scaleEffect(pulse ? 1.16 : 0.9)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: pulse)
                Circle().fill(Color(hex: 0xFF453A)).frame(width: 6, height: 6)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("watching you")
                    .font(.okBody(11, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                Text("\(timeString) · \(model.steps) steps · click stop when you're done")
                    .font(.okMono(8))
                    .foregroundStyle(Color.white.opacity(0.42))
            }
            Spacer(minLength: 0)
            Button("stop") { onStop() }
                .buttonStyle(.plain)
                .font(.okMono(9, .semibold))
                .foregroundStyle(Color(hex: 0x1A120E))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Capsule().fill(Color(hex: 0x0F7A5C)))
        }
        .padding(.horizontal, 11)
        .frame(width: 310, height: 38)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(hex: 0x0B0B0C).opacity(0.96))
                .shadow(color: .black.opacity(0.3), radius: 18, y: 7)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.1), lineWidth: 0.7))
        .onAppear { pulse = true }
    }

    private var timeString: String {
        let total = Int(model.elapsed)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
