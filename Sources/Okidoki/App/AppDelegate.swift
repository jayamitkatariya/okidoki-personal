import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let environment = AppEnvironment()
    private var launchedAsLoginItem = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The launch Apple event says whether we were started by the user (Finder, Dock,
        // Launchpad, `open`) or silently at login.
        let launchedAsLoginItemCode: OSType = 0x6C67_6974 // 'lgit', keyAELaunchedAsLoginItem
        let event = NSAppleEventManager.shared().currentAppleEvent
        launchedAsLoginItem = event?.eventID == AEEventID(kAEOpenApplication)
            && event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == launchedAsLoginItemCode
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        OKRegistry.registerFonts()
        installWindowMenu()
        environment.start()

        // A user-initiated launch should show something. start() already opens onboarding when
        // it isn't finished (and honours the OKIDOKI_OPEN_* overrides); otherwise open the dashboard.
        let overrides = ProcessInfo.processInfo.environment
        let forced = overrides["OKIDOKI_OPEN_DASHBOARD"] == "1" || overrides["OKIDOKI_OPEN_ONBOARDING"] == "1"
        if !launchedAsLoginItem, !forced, environment.store.settings.onboardingComplete {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.environment.openDashboard(.home)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        environment.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // `flag` is always true here — the notch panel and cursor glow are permanently visible
        // windows — so ignore it: clicking the app icon or re-opening Okidoki.app should always
        // bring the main window forward.
        if environment.onboardingOpen || !environment.store.settings.onboardingComplete {
            environment.openOnboarding()
        } else if environment.dashboardOpen {
            environment.dashboard.show()
        } else {
            environment.openDashboard(.home)
        }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// main.swift installs App + Edit menus; without a Window menu ⌘W and ⌘M do nothing in the
    /// dashboard and onboarding windows.
    private func installWindowMenu() {
        guard let main = NSApp.mainMenu, !main.items.contains(where: { $0.submenu?.title == "Window" }) else { return }
        let item = NSMenuItem()
        let menu = NSMenu(title: "Window")
        menu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        menu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        item.submenu = menu
        main.addItem(item)
        NSApp.windowsMenu = menu
    }
}
