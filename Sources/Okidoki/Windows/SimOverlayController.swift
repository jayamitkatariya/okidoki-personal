import AppKit
import Combine
import SwiftUI
import WebKit

// MARK: - Model

@MainActor
final class SimModel: ObservableObject {
    @Published var visible = false
    @Published var title = ""
}

final class SimPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class SimControlPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - Controller

@MainActor
final class SimOverlayController: NSObject, WKNavigationDelegate {
    let model = SimModel()
    private weak var env: AppEnvironment?
    private var panel: SimPanel?
    private var controlPanel: SimControlPanel?
    private var webView: WKWebView?
    private var escLocal: Any?
    private var escGlobal: Any?
    private var moveObserver: NSObjectProtocol?
    private var lastControlOrigin: NSPoint = .zero

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
    }

    var isVisible: Bool { model.visible }

    func show(html: String, title: String, width: Int, height: Int, near point: CGPoint?) {
        guard let env, !html.isEmpty else { return }
        dismiss()
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point ?? NSEvent.mouseLocation) })
            ?? NSScreen.okidokiPrimary
        let clampedWidth = min(max(CGFloat(width), 240), min(920, screen.visibleFrame.width - 40))
        let clampedHeight = min(max(CGFloat(height), 180), min(660, screen.visibleFrame.height - 120))
        let anchor = point ?? CGPoint(x: screen.frame.midX, y: screen.frame.midY + screen.frame.height * 0.10)
        var origin = CGPoint(x: anchor.x - clampedWidth / 2, y: anchor.y - clampedHeight / 2)
        origin.x = min(max(screen.visibleFrame.minX + 20, origin.x), screen.visibleFrame.maxX - clampedWidth - 20)
        origin.y = min(max(screen.visibleFrame.minY + 90, origin.y), screen.visibleFrame.maxY - clampedHeight - 60)

        let panel = SimPanel(contentRect: NSRect(x: origin.x, y: origin.y, width: clampedWidth, height: clampedHeight),
                             styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar + 3
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: clampedWidth, height: clampedHeight), configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        panel.contentView = webView
        webView.loadHTMLString(html, baseURL: nil)

        let controlWidth: CGFloat = 320
        let controlHeight: CGFloat = 40
        let control = SimControlPanel(contentRect: NSRect(x: screen.frame.midX - controlWidth / 2,
                                                         y: screen.visibleFrame.minY + 16,
                                                         width: controlWidth, height: controlHeight),
                                      styleMask: [.borderless, .nonactivatingPanel],
                                      backing: .buffered, defer: false)
        control.isOpaque = false
        control.backgroundColor = .clear
        control.hasShadow = true
        control.level = .statusBar + 4
        control.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        control.isMovableByWindowBackground = true
        control.isReleasedWhenClosed = false
        // First-mouse hosting so "close" works on the first click while another app is active.
        control.contentView = OverlayHostingView(rootView: SimControlView(model: model,
                                                                     onClose: { [weak self] in self?.dismiss() })
            .environmentObject(env))
        lastControlOrigin = control.frame.origin

        model.title = title.isEmpty ? "overlay" : title
        model.visible = true

        panel.orderFrontRegardless()
        control.orderFrontRegardless()
        self.panel = panel
        self.controlPanel = control
        self.webView = webView
        installMonitors()
        moveObserver = NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification,
                                                              object: control, queue: .main) { [weak self] note in
            Task { @MainActor in self?.controlDidMove(note) }
        }
    }

    func dismiss() {
        model.visible = false
        panel?.orderOut(nil)
        controlPanel?.orderOut(nil)
        panel = nil
        controlPanel = nil
        webView = nil
        if let escLocal { NSEvent.removeMonitor(escLocal) }
        if let escGlobal { NSEvent.removeMonitor(escGlobal) }
        escLocal = nil; escGlobal = nil
        if let moveObserver {
            NotificationCenter.default.removeObserver(moveObserver)
            self.moveObserver = nil
        }
    }

    private func controlDidMove(_ note: Notification) {
        guard let control = note.object as? SimControlPanel, let panel else { return }
        let origin = control.frame.origin
        let delta = CGSize(width: origin.x - lastControlOrigin.x, height: origin.y - lastControlOrigin.y)
        lastControlOrigin = origin
        panel.setFrameOrigin(panel.frame.origin.applying(.init(translationX: delta.width, y: delta.height)))
    }

    private func installMonitors() {
        escLocal = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.dismiss() }
                return nil
            }
            return event
        }
        escGlobal = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {
                Task { @MainActor in self?.dismiss() }
            }
        }
    }

    // MARK: WKNavigationDelegate — only the injected HTML may load; nothing else.

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        if navigationAction.navigationType == .other && (url.isEmpty || url == "about:blank" || url.hasPrefix("about:")) {
            decisionHandler(.allow, preferences)
            return
        }
        decisionHandler(.cancel, preferences)
    }
}

// MARK: - Control pill

struct SimControlView: View {
    @ObservedObject var model: SimModel
    @EnvironmentObject private var env: AppEnvironment
    var onClose: () -> Void
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(Color(hex: 0x1FB57A).opacity(0.2)).frame(width: 20, height: 20)
                    .scaleEffect(pulse ? 1.16 : 0.9)
                    .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
                PixelGlyph(name: "wand", size: 10, color: Color(hex: 0x1FB57A))
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("overlay · \(model.title)")
                    .font(.okBody(11, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                Text("drawn on your screen · esc closes · drag to move")
                    .font(.okMono(8))
                    .foregroundStyle(Color.white.opacity(0.42))
            }
            Spacer(minLength: 0)
            Button("close") { onClose() }
                .buttonStyle(.plain)
                .font(.okMono(9, .semibold))
                .foregroundStyle(Color(hex: 0x1A120E))
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Capsule().fill(Color(hex: 0x0F7A5C)))
        }
        .padding(.horizontal, 11)
        .frame(width: 320, height: 38)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(hex: 0x0B0B0C).opacity(0.96))
                .shadow(color: .black.opacity(0.3), radius: 18, y: 7)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.1), lineWidth: 0.7))
        .onAppear { pulse = true }
    }
}
