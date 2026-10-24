import AppKit
import SwiftUI

// MARK: - Model

@MainActor
final class DriveCursorModel: ObservableObject {
    @Published var visible = false
    /// Pointer position in the panel's own coordinates (AppKit, origin bottom-left of the screen).
    @Published var point: CGPoint = .zero
    @Published var label = ""
    /// Bumped on every click so the ripple restarts.
    @Published var ripple = 0
    @Published var keyText = ""
    @Published var screenFrame: CGRect = .zero
}

// MARK: - Controller

/// A ring and a small label that ride along with the real pointer while okidoki drives, so the
/// user can always tell which moves are okidoki's. Clicks ripple; key presses show briefly.
@MainActor
final class DriveCursorController {
    let model = DriveCursorModel()
    private var panel: GhostPanel?
    private var screen: NSScreen?
    private var timer: Timer?
    private var keyHide: DispatchWorkItem?

    func show(on screen: NSScreen, label: String) {
        if self.screen?.frame != screen.frame || panel == nil {
            panel?.orderOut(nil)
            let panel = GhostPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                                   backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.level = .statusBar + 5
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.ignoresMouseEvents = true
            panel.sharingType = .none
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: DriveCursorView(model: model))
            panel.setFrame(screen.frame, display: false)
            panel.orderFrontRegardless()
            self.panel = panel
            self.screen = screen
            model.screenFrame = screen.frame
        }
        model.label = label
        model.visible = true
        track()
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.track() }
            }
        }
    }

    func update(label: String) {
        model.label = label
    }

    func clickRipple() {
        model.ripple += 1
    }

    func showKey(_ text: String) {
        model.keyText = text
        keyHide?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.model.keyText = "" }
        keyHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1, execute: work)
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        keyHide?.cancel()
        model.visible = false
        model.keyText = ""
        panel?.orderOut(nil)
        panel = nil
        screen = nil
    }

    private func track() {
        guard let screen else { return }
        let mouse = NSEvent.mouseLocation
        model.point = CGPoint(x: mouse.x - screen.frame.minX, y: screen.frame.maxY - mouse.y)
    }
}

// MARK: - View

struct DriveCursorView: View {
    @ObservedObject var model: DriveCursorModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ZStack {
                Circle().stroke(Color(hex: 0x1FB57A).opacity(0.9), lineWidth: 2)
                    .frame(width: 34, height: 34)
                Circle().fill(Color(hex: 0x1FB57A).opacity(0.10))
                    .frame(width: 34, height: 34)
                RippleRing(key: model.ripple)
            }
            .position(x: model.point.x + 4, y: model.point.y + 6)
            if !model.label.isEmpty {
                Text(model.label)
                    .font(.okBody(12, .medium))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.black.opacity(0.6)))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.white.opacity(0.14), lineWidth: 0.5))
                    .fixedSize()
                    .position(x: model.point.x + 24, y: model.point.y + 44)
            }
            if !model.keyText.isEmpty {
                Text(model.keyText)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.black.opacity(0.85))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(hex: 0xF7F2E9)))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Color.black.opacity(0.2), lineWidth: 0.6))
                    .fixedSize()
                    .position(x: model.point.x + 24, y: model.point.y + 76)
                    .transition(.opacity)
            }
        }
        .frame(width: model.screenFrame.width, height: model.screenFrame.height)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .opacity(model.visible ? 1 : 0)
        .animation(.easeOut(duration: 0.15), value: model.visible)
        .animation(.easeOut(duration: 0.2), value: model.keyText)
    }
}

/// One expanding ring per click.
private struct RippleRing: View {
    let key: Int
    @State private var scale: CGFloat = 0.4
    @State private var opacity: Double = 0

    var body: some View {
        Circle().stroke(Color(hex: 0x1FB57A), lineWidth: 2)
            .frame(width: 34, height: 34)
            .scaleEffect(scale)
            .opacity(opacity)
            .onChange(of: key) { _, _ in
                scale = 0.4
                opacity = 0.9
                withAnimation(.easeOut(duration: 0.55)) {
                    scale = 2.4
                    opacity = 0
                }
            }
    }
}
