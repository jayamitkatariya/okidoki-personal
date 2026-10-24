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
        window.title = "Okidoki"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.minSize = NSSize(width: 1080, height: 720)
        window.collectionBehavior = [.fullScreenPrimary]
        window.setFrameAutosaveName("OkidokiDashboard")
        if window.frame.origin == .zero {
            window.center()
        }

        let root = DashboardView()
            .environmentObject(env)
            .environmentObject(env.store)
            .okPreferredScheme(env.store.settings.appearance)
        window.contentView = NSHostingView(rootView: root)
        window.delegate = self
        self.window = window
    }

    func show(section: DashboardSection? = nil, runID: String? = nil) {
        guard let env else { return }
        if let section { env.dashboardRoute = section }
        if let runID { env.dashboardRunID = runID }
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        env.dashboardOpen = true
    }

    func windowWillClose(_ notification: Notification) {
        env?.dashboardOpen = false
        NSApp.setActivationPolicy(.accessory)
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
        guard let env else { return }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 880, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Welcome to okidoki"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.minSize = NSSize(width: 760, height: 640)
        window.center()
        let root = OnboardingView()
            .environmentObject(env)
            .environmentObject(env.store)
            .okPreferredScheme(env.store.settings.appearance)
        window.contentView = NSHostingView(rootView: root)
        window.delegate = self
        self.window = window
    }

    func show() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
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
    }
}
