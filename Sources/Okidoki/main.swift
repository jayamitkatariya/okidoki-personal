import AppKit

MainActor.assumeIsolated {
    let app = NSApplication.shared
    retireOtherCopies()
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    installMainMenu(app)
    app.run()
}

// Two copies of okidoki (a rebuild launched over a running one, an old copy in /Applications)
// would both write state.json, both fight over the brain's port, both show a notch, and the
// newer one would mark the older one's live runs as lost. The newest launch wins: earlier
// copies are asked to quit and given a moment to save, before this one reads state.json.
private func retireOtherCopies() {
    guard let bundleID = Bundle.main.bundleIdentifier else { return }
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    guard !others.isEmpty else { return }
    for app in others { app.terminate() }
    // A copy shutting down a private Mac waits up to 12 s before it quits (AppDelegate); give it that.
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline, others.contains(where: { !$0.isTerminated }) {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    for app in others where !app.isTerminated { app.forceTerminate() }
}

// Accessory apps show no menu bar, but ⌘V/⌘C/⌘X/⌘A/⌘Z/⌘Q only work when a main menu
// with the standard Edit selectors exists — otherwise pasting into onboarding,
// dashboard and any titled window silently does nothing.
private func installMainMenu(_ app: NSApplication) {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Okidoki", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Okidoki", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    app.mainMenu = main
}
