import AppKit
import SwiftUI

// MARK: - Model

@MainActor
final class EdgeGlowModel: ObservableObject {
    @Published var visible = false
}

// MARK: - Controller

/// A faint gradient glow around the edges of the screen while okidoki drives this Mac,
/// so it's obvious from anywhere on screen that the pointer isn't yours right now.
/// Click-through and hidden from screen capture, so the model never sees it.
@MainActor
final class EdgeGlowController {
    let model = EdgeGlowModel()
    private var panel: GhostPanel?
    private var screen: NSScreen?
    private var hideWork: DispatchWorkItem?

    func show(on screen: NSScreen) {
        hideWork?.cancel()
        hideWork = nil
        if self.screen?.frame != screen.frame || panel == nil {
            panel?.orderOut(nil)
            let panel = GhostPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.level = .statusBar + 3
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.ignoresMouseEvents = true
            panel.sharingType = .none
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: EdgeGlowView(model: model))
            panel.setFrame(screen.frame, display: false)
            self.panel = panel
            self.screen = screen
        }
        panel?.orderFrontRegardless()
        withAnimation(.easeOut(duration: 0.6)) { model.visible = true }
    }

    func hide() {
        guard model.visible else { return }
        withAnimation(.easeIn(duration: 0.45)) { model.visible = false }
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.model.visible else { return }
                self.panel?.orderOut(nil)
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }
}

// MARK: - View

/// The dashboard's Key insight gradient (violet → purple → pink → orange), wrapped around the
/// screen and blurred into a soft light. It breathes slowly; opacity is the only thing that
/// animates, so the blur is rendered once rather than every frame.
private struct EdgeGlowView: View {
    @ObservedObject var model: EdgeGlowModel
    @State private var breathing = false

    private static let gradient = AngularGradient(
        colors: [
            Color(hex: 0x6D3BF5), Color(hex: 0x9B2EC6), Color(hex: 0xE0339A),
            Color(hex: 0xFF9147), Color(hex: 0xE0339A), Color(hex: 0x9B2EC6), Color(hex: 0x6D3BF5),
        ],
        center: .center)

    var body: some View {
        ZStack {
            // A wide, very soft haze that bleeds in from the bezel...
            Rectangle()
                .strokeBorder(Self.gradient, lineWidth: 36)
                .blur(radius: 44)
                .opacity(0.5)
            // ...a little denser right at the edge so it reads as light, not tint...
            Rectangle()
                .strokeBorder(Self.gradient, lineWidth: 8)
                .blur(radius: 12)
                .opacity(0.45)
            // ...and a whisper of white on top to keep it pastel.
            Rectangle()
                .strokeBorder(Color.white, lineWidth: 2)
                .blur(radius: 6)
                .opacity(0.18)
        }
        .compositingGroup()
        // Two modifiers: the show/hide fade and the endless pulse must not retarget each other.
        .opacity(model.visible ? 1 : 0)
        .opacity(breathing ? 0.95 : 0.6)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .onAppear {
            withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true)) { breathing = true }
        }
    }
}
