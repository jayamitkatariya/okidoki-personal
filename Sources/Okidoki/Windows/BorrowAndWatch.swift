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
    private var runID: String?
    private var targetGlobal: CGPoint = .zero
    private var cancelled = false
    /// Bumped per takeover so a cancelled one's pending click/finish can't fire into the next.
    private var session = 0

    init(environment: AppEnvironment) { self.env = environment }

    func begin(target: String, appName: String, runID: String) {
        guard !model.visible else { return }
        self.runID = runID
        cancelled = false
        session += 1
        let session = session
        let front = NSWorkspace.shared.frontmostApplication
        let pid = front?.processIdentifier ?? 0
        let found = AccessibilityLocator.find(target: target, pid: pid)
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        // AX frames and CGEvent locations share Quartz space: top-left origin, y downward.
        // The ghost view is laid out in AppKit space, so only the drawing point is flipped.
        let quartz: CGPoint
        if let found {
            quartz = found.point
        } else if let live = CGEvent(source: nil)?.location {
            quartz = live
        } else {
            quartz = CGPoint(x: NSEvent.mouseLocation.x, y: mainHeight - NSEvent.mouseLocation.y)
        }
        model.label = found == nil ? "taking over — clicking here" : "clicking “\(found!.label)”"
        let appKit = CGPoint(x: quartz.x, y: mainHeight - quartz.y)
        targetGlobal = quartz
        screen = NSScreen.screens.first(where: { $0.frame.contains(appKit) }) ?? NSScreen.okidokiPrimary
        guard let screen else { return }
        let local = CGPoint(x: appKit.x - screen.frame.minX, y: screen.frame.maxY - appKit.y)
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
        installMonitors()
        env?.speaker.speak("taking over for a second.", voiceID: env?.store.settings.voiceID ?? "sarah",
                           speed: env?.store.settings.voiceSpeed ?? 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.05) { [weak self] in
            self?.performClick(session: session)
        }
    }

    private func performClick(session: Int) {
        guard session == self.session, !cancelled, model.visible else { return }
        guard AccessibilityActions.click(at: targetGlobal) else {
            // No permission to post events: don't animate a click that never happened.
            cancel(reason: "couldn't click — allow accessibility access, then try again")
            return
        }
        model.clicking = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            guard let self, self.session == session, !self.cancelled else { return }
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
    }

    private func removeMonitors() {
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        if let globalEsc { NSEvent.removeMonitor(globalEsc) }
        escMonitor = nil; globalEsc = nil
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
                Text(model.label)
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.black.opacity(0.55)))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.white.opacity(0.14), lineWidth: 0.5))
                    .position(x: model.point.x + 20, y: model.point.y + 58)
                Text("Press esc to take back control")
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.88))
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .background(Capsule().fill(Color.black.opacity(0.55)))
                    .overlay(Capsule().stroke(Color.white.opacity(0.14), lineWidth: 0.5))
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
        // A second show used to replace `panel` without ordering the old HUD out, leaving it stuck on screen.
        panel?.orderOut(nil)
        model.visible = true
        model.elapsed = 0
        model.steps = 0
        let screen = NSScreen.okidokiPrimary
        let width: CGFloat = 310
        let height: CGFloat = 46
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
        // First-mouse hosting so "stop" works on the first click (the HUD is never key).
        panel.contentView = OverlayHostingView(rootView: WatchHUDView(model: model, onStop: { [weak self] in self?.env?.stopWatching() })
            .environmentObject(env))
        panel.orderFrontRegardless()
        self.panel = panel
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let env = self.env else { return }
                self.model.elapsed = env.watch.startedAt.map { Date().timeIntervalSince($0) } ?? 0
                self.model.steps = env.watch.steps.count
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
    var onStop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Color(hex: 0xFF453A)).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text("Recording")
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                Text("\(timeString) · \(model.steps) steps")
                    .font(.okBody(11))
                    .foregroundStyle(Color.white.opacity(0.5))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Stop", action: onStop)
                .buttonStyle(.plain)
                .font(.okBody(12, .medium))
                .foregroundStyle(Color.white.opacity(0.72))
        }
        .padding(.horizontal, 16)
        .frame(width: 310, height: 46)
        .overlayGlass(cornerRadius: 23, veil: 0.42, tone: .dark)
    }

    private var timeString: String {
        let total = Int(model.elapsed)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
