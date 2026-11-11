import AppKit
import OkidokiCore

@MainActor
final class StatusBarController: NSObject, NSMenuDelegate {
    private weak var env: AppEnvironment?
    private var item: NSStatusItem?
    private let menu = NSMenu()

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        build()
    }

    private func build() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = OKLogo.nsImage(size: 18)
            button.imagePosition = .imageOnly
            button.toolTip = Self.tooltip(env?.store.settings)
        }
        menu.delegate = self
        item.menu = menu
        self.item = item
        rebuildMenu()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
        item?.button?.toolTip = Self.tooltip(env?.store.settings)
    }

    /// Says how to summon, given what's turned on.
    static func tooltip(_ settings: AppSettings?) -> String {
        guard let settings else { return "Okidoki" }
        let key = SummonHotKey.label(settings.summonHotkey)
        switch (settings.shakeToSummon, key.isEmpty) {
        case (true, true): return "Okidoki — shake your mouse to summon"
        case (true, false): return "Okidoki — shake your mouse or press \(key) to summon"
        case (false, false): return "Okidoki — press \(key) to summon"
        case (false, true): return "Okidoki — summon from here or the notch"
        }
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        guard let env else { return }
        let name = env.store.activeAccount.firstName
        let header = NSMenuItem(title: "okidoki · \(name)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let dashboard = NSMenuItem(title: "open dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        dashboard.keyEquivalentModifierMask = [.command, .shift]
        dashboard.target = self
        menu.addItem(dashboard)

        let summon = NSMenuItem(title: "summon okidoki", action: #selector(summonNow), keyEquivalent: "")
        summon.target = self
        let key = SummonHotKey.label(env.store.settings.summonHotkey)
        if !key.isEmpty { summon.toolTip = key }
        menu.addItem(summon)

        let ask = NSMenuItem(title: "ask okidoki", action: #selector(ask), keyEquivalent: "")
        ask.target = self
        menu.addItem(ask)

        menu.addItem(.separator())

        let enabled = NSMenuItem(title: "okidoki on", action: #selector(toggleEnabled), keyEquivalent: "")
        enabled.state = env.store.settings.okidokiEnabled ? .on : .off
        enabled.target = self
        menu.addItem(enabled)

        let quiet = NSMenuItem(title: "quiet mode", action: #selector(toggleQuiet), keyEquivalent: "")
        quiet.state = env.store.settings.quietMode ? .on : .off
        quiet.target = self
        menu.addItem(quiet)

        let background = NSMenuItem(title: "background mode", action: #selector(toggleBackground), keyEquivalent: "")
        background.state = env.store.settings.backgroundMode ? .on : .off
        background.target = self
        menu.addItem(background)

        let borrowing = NSMenuItem(title: "screen borrowing", action: #selector(toggleBorrow), keyEquivalent: "")
        borrowing.state = env.store.settings.screenBorrowing ? .on : .off
        borrowing.target = self
        menu.addItem(borrowing)

        menu.addItem(.separator())

        let permissions = NSMenuItem(title: "onboarding & permissions", action: #selector(openOnboarding), keyEquivalent: "")
        permissions.target = self
        menu.addItem(permissions)

        let settings = NSMenuItem(title: "settings", action: #selector(openSettings), keyEquivalent: ",")
        settings.keyEquivalentModifierMask = [.command]
        settings.target = self
        menu.addItem(settings)

        if env.store.settings.shakeToSummon {
            let reset = NSMenuItem(title: "practise the shake", action: #selector(practiseShake), keyEquivalent: "")
            reset.target = self
            menu.addItem(reset)
        }

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "quit okidoki", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    @objc private func openDashboard() { env?.openDashboard(.home) }
    /// After the menu closes, so the capsule opens where the pointer is and keeps the keyboard.
    @objc private func summonNow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.env?.startSummon() }
    }
    @objc private func openSettings() { env?.openDashboard(.settings) }
    @objc private func openOnboarding() { env?.openOnboarding() }
    @objc private func ask() {
        env?.openDashboard(.home)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.env?.requestAsk() }
    }
    @objc private func toggleEnabled() {
        env?.store.settings.okidokiEnabled.toggle()
        env?.store.saveNow()
    }
    @objc private func toggleQuiet() {
        env?.store.settings.quietMode.toggle()
        env?.store.saveNow()
    }
    @objc private func toggleBackground() {
        env?.store.settings.backgroundMode.toggle()
        env?.store.saveNow()
    }
    @objc private func toggleBorrow() {
        env?.store.settings.screenBorrowing.toggle()
        env?.store.saveNow()
    }
    @objc private func practiseShake() {
        env?.openOnboarding()
    }
    @objc private func quit() {
        env?.store.saveNow()
        NSApp.terminate(nil)
    }
}
