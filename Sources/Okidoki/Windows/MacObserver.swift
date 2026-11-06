import AppKit
import ApplicationServices
import OkidokiCore

/// What smart Mac replay knows about one app's screen, through Accessibility: the window and sheets in
/// front, its text, its dialogs, whether it's busy, and the step's control. The Mac's `tab.observation()`,
/// `tab.value(of:)`, `tab.dialogs()` and the rest. Every read runs off the main thread with a short
/// per-call timeout, so a hung app never freezes okidoki; a read is reused until something acts.
@MainActor
final class MacObserver {
    /// The app this replay works in: a bundle id, else a name.
    private(set) var bundleID: String?
    private(set) var appName: String
    private var cached: (at: Date, snapshot: MacAXReader.Snapshot)?

    init(bundleID: String?, appName: String) {
        self.bundleID = bundleID
        self.appName = appName
    }

    /// The app may be named differently from the step (a renamed bundle): the one that's actually running.
    var running: NSRunningApplication? {
        if let bundleID, let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first { return app }
        return NSWorkspace.shared.runningApplications.first { SkillReplayGeometry.sameApp($0.localizedName ?? "", appName) }
    }

    func retarget(bundleID: String?, appName: String) {
        guard bundleID != self.bundleID || appName != self.appName else { return }
        self.bundleID = bundleID ?? self.bundleID
        self.appName = appName
        invalidate()
    }

    /// Something was done: the next read looks again.
    func invalidate() { cached = nil }

    // MARK: Reading

    func snapshot(fresh: Bool = false) async -> MacAXReader.Snapshot? {
        if !fresh, let cached, Date().timeIntervalSince(cached.at) < 0.25 { return cached.snapshot }
        guard let pid = running?.processIdentifier else { return nil }
        let snapshot = await Task.detached(priority: .userInitiated) { MacAXReader.snapshot(pid: pid) }.value
        cached = (Date(), snapshot)
        return snapshot
    }

    func observation(fresh: Bool = false) async -> MacObservation {
        guard let snapshot = await snapshot(fresh: fresh) else { return MacObservation(app: appName, bundleID: bundleID ?? "") }
        return MacScreen.observe(snapshot.tree)
    }

    /// The step's control now, with how it was found. Nil when no saved way finds it.
    func find(_ locator: AXLocator, allowPoint: Bool = false, fresh: Bool = false) async -> (element: AXUIElement, node: MacNode, hit: MacLocator.Hit)? {
        guard let snapshot = await snapshot(fresh: fresh), let hit = MacLocator.find(locator, in: snapshot.tree, allowPoint: allowPoint) else { return nil }
        return (snapshot.elements[hit.node], snapshot.tree.nodes[hit.node], hit)
    }

    /// What the control holds now (a field's text, a pop-up's choice). Nil when it can't be read.
    func value(of locator: AXLocator) async -> String? {
        guard let found = await find(locator, fresh: true) else { return nil }
        guard !found.node.isSecure else { return nil }
        return found.node.value
    }

    /// A pop-up's or combo box's choices, when the app lists them without opening the menu.
    func options(of locator: AXLocator) async -> [String]? {
        guard let snapshot = await snapshot(fresh: true), let hit = MacLocator.find(locator, in: snapshot.tree) else { return nil }
        let items = snapshot.tree.subtree(hit.node).dropFirst().filter { snapshot.tree.nodes[$0].role == "AXMenuItem" }
            .map { snapshot.tree.nodes[$0].label }.filter { !$0.isEmpty }
        return items.isEmpty ? nil : items
    }

    func dialogs() async -> [MacDialog] {
        guard let snapshot = await snapshot() else { return [] }
        return MacScreen.dialogs(snapshot.tree)
    }

    func isBusy() async -> Bool {
        guard let snapshot = await snapshot(fresh: true) else { return false }
        return MacScreen.isBusy(snapshot.tree)
    }

    /// Whether the control sits inside a sheet or dialog (the step is answering it).
    func inDialog(_ locator: AXLocator) async -> Bool {
        guard let snapshot = await snapshot(), let hit = MacLocator.find(locator, in: snapshot.tree) else { return false }
        return snapshot.tree.inDialog(hit.node)
    }

    /// The front window's text and what its fields hold, for the shown-values check and reading.
    func windowText() async -> String {
        guard let snapshot = await snapshot(fresh: true), let front = snapshot.tree.front else { return "" }
        return MacScreen.windowText(snapshot.tree, window: front)
    }

    func fieldValues() async -> String {
        guard let snapshot = await snapshot(fresh: true), let front = snapshot.tree.front else { return "" }
        return MacScreen.fieldValues(snapshot.tree, window: front)
    }

    func present(_ label: String) async -> Bool {
        guard let snapshot = await snapshot() else { return false }
        return MacScreen.present(label, in: snapshot.tree)
    }

    /// Waits until the app stops changing (two reads in a row alike) or `limit` seconds pass.
    func settle(limit: TimeInterval = 2) async {
        let deadline = Date().addingTimeInterval(limit)
        var last = await observation(fresh: true)
        while Date() < deadline, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 120_000_000)
            let now = await observation(fresh: true)
            if now == last, !now.busy { return }
            last = now
        }
    }

    // MARK: Acting through Accessibility (no pointer, no keys)

    /// Presses a button, ticks a box, opens a pop-up.
    func press(_ element: AXUIElement) async -> Bool {
        defer { invalidate() }
        return await Self.off { AXUIElementPerformAction(element, kAXPressAction as CFString) == .success }
    }

    /// Puts text into a field and, for a pop-up that allows it, sets its choice.
    func setValue(_ element: AXUIElement, _ text: String) async -> Bool {
        defer { invalidate() }
        return await Self.off { AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success }
    }

    func focus(_ element: AXUIElement) async -> Bool {
        defer { invalidate() }
        return await Self.off { AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success }
    }

    func isSettable(_ element: AXUIElement) async -> Bool {
        await Self.off {
            var settable = DarwinBoolean(false)
            return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        }
    }

    /// Return / Escape in a window without a key press: its default or cancel button.
    func pressWindowButton(_ which: String) async -> Bool {
        guard let snapshot = await snapshot(fresh: true) else { return false }
        let key = which == "cancel" ? kAXCancelButtonAttribute : kAXDefaultButtonAttribute
        // The sheet in front first: Return answers it, not the window behind.
        let windows = MacScreen.dialogs(snapshot.tree).map(\.node) + [snapshot.tree.front].compactMap { $0 }
        for index in windows {
            let element = snapshot.elements[index]
            let found: UncheckedAX? = await Self.off { () -> UncheckedAX? in
                MacAXReader.attributeElement(key, of: element).map { UncheckedAX($0) }
            }
            if let found { return await press(found.element) }
        }
        // A focused field's own confirm (a search field).
        if which != "cancel", let focused = snapshot.tree.nodes.firstIndex(where: \.focused) {
            let element = snapshot.elements[focused]
            return await Self.off { AXUIElementPerformAction(element, kAXConfirmAction as CFString) == .success }
        }
        return false
    }

    /// Chooses `option` in a pop-up: by setting its value when the app allows it, else by opening its
    /// menu and pressing the item (closing the menu again if the item isn't there).
    func choose(_ option: String, in element: AXUIElement) async -> String? {
        if await isSettable(element), await setValue(element, option) {
            return option
        }
        guard await press(element) else { return nil }
        for _ in 0..<10 {
            try? await Task.sleep(nanoseconds: 80_000_000)
            let items: [(UncheckedAX, String)] = await Self.off {
                MacAXReader.snapshotChildren(of: element, role: "AXMenuItem").map { (UncheckedAX($0), MacAXReader.read($0).label) }
            }
            guard !items.isEmpty else { continue }
            let titles = items.map(\.1).filter { !$0.isEmpty }
            let picked = SkillBinder.choice(option, in: titles)
            if let item = items.first(where: { $0.1 == picked }) {
                _ = await press(item.0.element)
                return picked
            }
            // Not one of its choices: close the menu, change nothing.
            _ = await Self.off { AXUIElementPerformAction(element, kAXCancelAction as CFString) == .success }
            return nil
        }
        return nil
    }

    // MARK: Apps

    /// Starts the app if it isn't running. `activate` brings it to the front (the pointer path needs that;
    /// Accessibility doesn't, and leaves the person's front app alone).
    func launch(activate: Bool) async -> Bool {
        if let app = running {
            if activate, !app.isActive { app.activate() }
            return true
        }
        let url: URL? = bundleID.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }
            ?? AppResolver.resolve(name: appName)?.url
        guard let url else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = activate
        _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        for _ in 0..<40 where running == nil { try? await Task.sleep(nanoseconds: 100_000_000) }
        // The app's first window takes a moment after launch.
        for _ in 0..<30 {
            if let tree = await snapshot(fresh: true)?.tree, !tree.windows.isEmpty { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return running != nil
    }

    nonisolated static func off<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await Task.detached(priority: .userInitiated) { work() }.value
    }
}

/// An accessibility element carried across a detached task. AX calls are thread-safe.
struct UncheckedAX: @unchecked Sendable {
    let element: AXUIElement
    init(_ element: AXUIElement) { self.element = element }
}
