import AppKit
import SwiftUI

@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate {
    private weak var env: AppEnvironment?
    private(set) var window: NSWindow?

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        build()
    }

    private func build() {
        guard let env else { return }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // We keep this window for the app's lifetime and re-show it; the AppKit default would
        // free it on close and the next "open dashboard" would message a dead window.
        window.isReleasedWhenClosed = false
        window.title = "Okidoki"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // Dragging inside the web view (text selection, sliders) must not move the window;
        // the transparent title bar strip still drags it.
        window.isMovableByWindowBackground = false
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .okDashboardBackground
        window.isOpaque = true
        window.hasShadow = true
        window.minSize = NSSize(width: 900, height: 600)
        window.collectionBehavior = [.fullScreenPrimary]
        window.setFrameAutosaveName("OkidokiDashboard")
        if window.frame.origin == .zero {
            window.center()
        }

        // Appearance follows NSApp.appearance (driven by settings), so no scheme is pinned here.
        let root = DashboardView()
            .environmentObject(env)
            .environmentObject(env.store)
        window.contentView = NSHostingView(rootView: root)
        window.delegate = self
        self.window = window
    }

    func show(section: DashboardSection? = nil, runID: String? = nil) {
        guard let env, let window else { return }
        if let section { env.dashboardRoute = section }
        if let runID { env.dashboardRunID = runID }
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        if !window.isVisible { window.okFitToScreen() }
        window.makeKeyAndOrderFront(nil)
        // Accessory → regular apps don't always come forward on activate alone.
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        env.dashboardOpen = true
    }

    func windowWillClose(_ notification: Notification) {
        env?.dashboardOpen = false
        if env?.onboardingOpen != true {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        env?.dashboardOpen = true
    }
}

@MainActor
final class OnboardingWindowController: NSObject, NSWindowDelegate {
    private weak var env: AppEnvironment?
    private(set) var window: NSWindow?

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        build()
    }

    private func build() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = "Welcome to okidoki"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // The "circle something" practice canvas is a drag gesture; a movable background
        // would drag the whole window instead of drawing.
        window.isMovableByWindowBackground = false
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = NSColor(srgbRed: 0xEE / 255, green: 0xF2 / 255, blue: 0xEF / 255, alpha: 1)
        window.isOpaque = true
        window.hasShadow = true
        // Onboarding is a light-only design (white fields, ink text); pin it so dark mode
        // doesn't render white text inside the white fields.
        window.appearance = NSAppearance(named: .aqua)
        window.minSize = NSSize(width: 760, height: 720)
        window.center()
        window.delegate = self
        self.window = window
        installContent()
    }

    /// A fresh view each time the window is opened, so reopening from the menu starts at the
    /// first step instead of the stale "You're all set" screen.
    private func installContent() {
        guard let env, let window else { return }
        let root = OnboardingView()
            .environmentObject(env)
            .environmentObject(env.store)
        window.contentView = NSHostingView(rootView: root)
    }

    func show() {
        guard let window else { return }
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        if !window.isVisible {
            installContent()
            window.center()
            window.okFitToScreen()
        }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        env?.onboardingOpen = true
    }

    func hide() {
        window?.orderOut(nil)
        env?.onboardingOpen = false
        if env?.dashboardOpen != true {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    func windowWillClose(_ notification: Notification) {
        env?.onboardingOpen = false
        env?.suspendSummonForTour = false
        if env?.dashboardOpen != true {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

extension NSWindow {
    /// Keeps the window on a connected screen and no larger than its visible area — a saved
    /// frame from an unplugged display or a small/scaled screen would otherwise open it
    /// off-screen or under the menu bar and Dock.
    func okFitToScreen() {
        let offscreen = screen == nil
        guard let visible = (screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        var frame = self.frame
        frame.size.width = min(frame.width, visible.width)
        frame.size.height = min(frame.height, visible.height)
        if offscreen {
            frame.origin = NSPoint(x: visible.midX - frame.width / 2, y: visible.midY - frame.height / 2)
        } else {
            frame.origin.x = min(max(frame.minX, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.minY, visible.minY), visible.maxY - frame.height)
        }
        if frame != self.frame { setFrame(frame, display: false) }
    }
}
