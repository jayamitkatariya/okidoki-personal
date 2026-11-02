import AppKit
import OkidokiCore
import SwiftUI
import WebKit

/// What the browser's chrome shows across tabs: the tab strip, recording, and the address bar's focus.
@MainActor
final class BrowserModel: ObservableObject {
    @Published var tabs: [BrowserTab] = []
    @Published var activeID: UUID?
    /// Recording a skill: what the person does here becomes its steps.
    @Published var recording = false
    @Published var recordedSteps = 0
    /// Bumped by ⌘L and ⌘T to put the cursor in the address bar.
    @Published var focusAddress = 0

    var active: BrowserTab? { tabs.first { $0.id == activeID } ?? tabs.first }
}

/// One tab: its own page, its own load state, and whoever is working in it (the agent, a replay, or
/// nobody, which means the person). Every tab shares the browser's profile, so a login in one is a
/// login in all of them.
@MainActor
final class BrowserTab: NSObject, ObservableObject, Identifiable {
    let id = UUID()
    /// Small and stable for the tab's life: what the agent calls it ("tab 2").
    let number: Int
    let webView: WKWebView
    /// The tab whose link or script opened this one, if any.
    let openedBy: UUID?
    let createdAt = Date()

    @Published var address = ""
    @Published var title = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var loading = false
    @Published var progress: Double = 0
    /// A line from the agent or a replay while one is working in this tab; nil when it's the person's.
    @Published var status: String?
    /// A vault login exists for the page's site.
    @Published var hasLogin = false
    /// Why the last load failed (offline, a bad address), shown over the page with a way to try again.
    @Published var loadError: String?

    /// The run working in this tab right now.
    var ownerRunID: String?
    /// The conversation that last worked here, so a follow-up carries on in the same tab.
    var threadID: String?
    /// Called when the person presses esc while this tab is in front and someone is working in it.
    var onEscape: (() -> Void)?

    // Load state the agent waits on.
    fileprivate var navigating = false
    fileprivate var currentNavigation: WKNavigation?
    fileprivate var failedURL: URL?
    fileprivate var dialogNotes: [String] = []
    fileprivate var finishedDownloads: [String] = []
    fileprivate var interruptSettle: (() -> Void)?
    fileprivate var observations: [NSKeyValueObservation] = []
    private let world: WKContentWorld

    var working: Bool { status != nil }
    var isBlank: Bool { webView.url == nil || webView.url?.absoluteString == "about:blank" }
    /// What the strip shows: the page title, else its site, else "New tab".
    var label: String {
        if !title.isEmpty { return title }
        let site = BrowserSteps.displayURL(address)
        return site.isEmpty || address == "about:blank" ? "New tab" : site
    }

    fileprivate init(number: Int, webView: WKWebView, world: WKContentWorld, openedBy: UUID?) {
        self.number = number
        self.webView = webView
        self.world = world
        self.openedBy = openedBy
        super.init()
    }

    // MARK: The page, for the agent and replays

    /// Runs one of the page script's functions in okidoki's world. Nil when the page isn't ready.
    func call(_ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
        try? await webView.callAsyncJavaScript(body, arguments: arguments, in: nil, contentWorld: world)
    }

    /// The page as the agent reads it. Numbers in `elements` are what `act(ref:)` takes.
    func snapshot() async -> BrowserSnapshot {
        let raw = await call("return window.__okidoki ? window.__okidoki.snapshot() : null") as? [String: Any]
        let downloads = finishedDownloads
        finishedDownloads = []
        let dialogs = dialogNotes
        dialogNotes = []
        return BrowserSnapshot(url: raw?["url"] as? String ?? webView.url?.absoluteString ?? "",
                               title: raw?["title"] as? String ?? webView.title ?? "",
                               elements: raw?["elements"] as? String ?? "",
                               text: raw?["text"] as? String ?? "",
                               count: raw?["count"] as? Int ?? 0,
                               downloads: downloads,
                               dialogs: dialogs,
                               loadError: loadError,
                               more: raw?["more"] as? Int ?? 0)
    }

    /// One action on the page. `action` is the page script's: click · type · select · press · scroll · locate.
    func act(_ action: [String: Any]) async -> BrowserActResult {
        let raw = await call("return window.__okidoki ? window.__okidoki.act(a) : {ok: false, detail: 'the page is still loading'}",
                             ["a": action]) as? [String: Any]
        return BrowserActResult(ok: raw?["ok"] as? Bool ?? false,
                                detail: raw?["detail"] as? String,
                                selectors: raw?["selectors"] as? [String] ?? [],
                                matched: raw?["matched"] as? Int ?? -1,
                                label: (raw?["label"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                                role: raw?["role"] as? String)
    }

    /// Waits until the page is readable and has stopped changing, up to `limit` seconds: a navigation's
    /// new page has appeared and been parsed, and nothing has changed for a moment. It doesn't wait for
    /// every image and tracker to finish, which is most of a heavy page's load time. `fresh` is for right
    /// after an action: the quiet moment is measured from now, so whatever the action set off can start.
    func settle(limit: Double = 8, fresh: Bool = false) async {
        let deadline = Date().addingTimeInterval(limit)
        var measureFromNow = fresh
        var replaced = false
        repeat {
            // The old page is still there until the new one commits; reading it now would be stale.
            // WebKit not loading anything for a while means there's no new page coming (a jump within
            // the same page, a load that was dropped), so stop waiting for one.
            var idle = 0
            while navigating, Date() < deadline {
                idle = webView.isLoading ? 0 : idle + 1
                if idle >= 10 { navigating = false; currentNavigation = nil; break }
                try? await Task.sleep(nanoseconds: 30_000_000)
            }
            let left = Int(max(0.2, deadline.timeIntervalSinceNow) * 1000)
            // Its own deadline too: a page replaced mid-wait may never answer.
            let waited = await settleCall(ms: left, fresh: measureFromNow, within: Double(left) / 1000 + 1)
            measureFromNow = false
            // A navigation began or committed mid-wait: the page waited on is gone, so settle the new one.
            replaced = waited == Self.settleReplaced
            // The page script isn't in yet (the new document is only just starting): give it a beat.
            if waited == nil || waited == -1, Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
            // An action that set off a navigation while we waited: wait for that page instead.
        } while (navigating || replaced) && Date() < deadline
    }

    fileprivate static let settleReplaced = -2

    /// The page script's settle, given up on after `seconds` if the page never answers, and at once
    /// (with `settleReplaced`) if a navigation starts or commits meanwhile.
    private func settleCall(ms: Int, fresh: Bool, within seconds: Double) async -> Int? {
        final class Once { var done = false }
        let once = Once()
        defer { interruptSettle = nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Int?, Never>) in
            interruptSettle = {
                if !once.done { once.done = true; continuation.resume(returning: Self.settleReplaced) }
            }
            Task { @MainActor in
                let waited = await self.call("return window.__okidoki ? await window.__okidoki.settle(250, ms, fresh) : -1",
                                             ["ms": ms, "fresh": fresh]) as? Int
                if !once.done { once.done = true; continuation.resume(returning: waited) }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if !once.done { once.done = true; continuation.resume(returning: nil) }
            }
        }
    }

    func load(_ url: URL) { load(URLRequest(url: url)) }

    /// The whole request, so a form posted to a new window keeps its method and body.
    fileprivate func load(_ request: URLRequest) {
        // Marked before WebKit says so, so a settle that starts right away waits for the new page.
        navigating = true
        currentNavigation = webView.load(request)
    }

    /// Navigates and waits for the page.
    func navigate(_ url: URL) async {
        load(url)
        await settle()
    }

    func goBack() async {
        guard webView.canGoBack else { return }
        navigating = true
        currentNavigation = webView.goBack()
        await settle()
    }

    fileprivate func navigationEnded(_ navigation: WKNavigation?) {
        guard currentNavigation == nil || navigation === currentNavigation else { return }
        navigating = false
        currentNavigation = nil
    }

    func fillLogin(username: String, password: String) async -> BrowserActResult {
        let raw = await call("return window.__okidoki ? window.__okidoki.fillLogin(u, p) : {ok: false, detail: 'the page is still loading'}",
                             ["u": username, "p": password]) as? [String: Any]
        return BrowserActResult(ok: raw?["ok"] as? Bool ?? false, detail: raw?["detail"] as? String,
                                selectors: [], matched: -1, label: nil, role: nil)
    }

    /// A JPEG of what's showing, for the turns where the agent asks to look.
    func screenshot() async -> Data? {
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = 1024
        // Straight from the bitmap: going through TIFF first costs a full extra encode and decode.
        guard let image = try? await webView.takeSnapshot(configuration: config),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.7])
    }

    /// Loads the address the last failed load was for.
    func retryFailedLoad() {
        loadError = nil
        if let failedURL { load(failedURL) } else { webView.reload() }
    }
}

/// okidoki's own browser: tabs shown on the dashboard's Browser page, its own saved logins (a separate
/// website data store, so nothing is shared with Safari), and the page script in a content world of its
/// own. The view stays in the dashboard window while other pages are showing, just hidden, so a run or
/// a replay carries on wherever the person goes.
/// The agent, recordings and replays all work on a tab through `snapshot`, `act` and `settle`, on the
/// DOM rather than with the mouse, so the person can keep using the rest of the Mac (or another tab)
/// meanwhile. Several agents can work at once, each in its own tabs.
@MainActor
final class BrowserController: NSObject, WKNavigationDelegate, WKUIDelegate,
                               WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate {
    /// One profile for every launch; WebKit keeps its cookies and storage under this id.
    private static let profileID = UUID(uuidString: "6B1D9E2A-0C55-4E1F-9A0B-0D0E1D0C1B1E")!
    static let maxTabs = 24

    let model = BrowserModel()
    /// The tabs and the page, for the dashboard to place over its Browser page.
    private(set) var view: NSView!
    private weak var env: AppEnvironment?
    private let world = WKContentWorld.world(name: BrowserPageScript.worldName)
    private let contentController = WKUserContentController()
    private lazy var dataStore = WKWebsiteDataStore(forIdentifier: Self.profileID)
    private let processPool = WKProcessPool()
    private var escMonitor: Any?
    private var shortcutMonitor: Any?
    private var nextNumber = 1
    /// Holds every tab's page, the one in front on top.
    private let stack = TabStackView()
    /// Called with each recorded step while recording.
    var onRecordedStep: ((SkillStep) -> Void)?
    /// The tab a recording is watching: steps from other tabs aren't part of it.
    private weak var recordingTab: BrowserTab?
    /// Where each download in flight is being saved, and the tab that started it.
    private var downloadDestinations: [ObjectIdentifier: (url: URL, tab: UUID?)] = [:]
    private var lastRecordedAt: Date?
    /// Windows a page opened on purpose (a "Sign in with Google" popup), each with its own page.
    private var popups: [ObjectIdentifier: NSWindow] = [:]

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        build()
    }

    private func build() {
        contentController.addUserScript(WKUserScript(source: BrowserPageScript.source, injectionTime: .atDocumentStart,
                                                     forMainFrameOnly: true, in: world))
        contentController.add(self, contentWorld: world, name: BrowserPageScript.recordHandler)
        installShortcuts()
        installEscape()
        view = NSHostingView(rootView: BrowserView(model: model, stack: stack, controller: self))
        _ = openTab(activate: true)
    }

    // MARK: - Tabs

    /// The tab in front. There is always one.
    var activeTab: BrowserTab {
        if let tab = model.active { return tab }
        return openTab(activate: true)
    }

    /// The page in front, for recording, scripts and the toolbar.
    var webView: WKWebView { activeTab.webView }

    func tab(_ id: UUID?) -> BrowserTab? { model.tabs.first { $0.id == id } }
    func tab(number: Int) -> BrowserTab? { model.tabs.first { $0.number == number } }
    private func tab(for webView: WKWebView) -> BrowserTab? { model.tabs.first { $0.webView === webView } }

    private func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.processPool = processPool
        configuration.userContentController = contentController
        configuration.preferences.isElementFullscreenEnabled = true
        // Safari's own user agent, kept in step with this macOS, so sites serve their full desktop page.
        configuration.applicationNameForUserAgent = Self.safariName
        return configuration
    }

    /// A new tab, after the one in front (or after its opener). `configuration` is WebKit's, for a page
    /// that opened this one and wants to keep talking to it.
    @discardableResult
    func openTab(url: URL? = nil, activate: Bool, openedBy: BrowserTab? = nil,
                 configuration: WKWebViewConfiguration? = nil) -> BrowserTab {
        let webView = WKWebView(frame: stack.bounds, configuration: configuration ?? makeConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.autoresizingMask = [.width, .height]
        let tab = BrowserTab(number: nextNumber, webView: webView, world: world, openedBy: openedBy?.id)
        nextNumber += 1
        tab.observations = [
            webView.observe(\.url) { [weak self, weak tab] view, _ in Task { @MainActor in if let tab { self?.urlChanged(tab, view.url) } } },
            webView.observe(\.title) { [weak tab] view, _ in Task { @MainActor in tab?.title = view.title ?? "" } },
            webView.observe(\.canGoBack) { [weak tab] view, _ in Task { @MainActor in tab?.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward) { [weak tab] view, _ in Task { @MainActor in tab?.canGoForward = view.canGoForward } },
            webView.observe(\.isLoading) { [weak tab] view, _ in Task { @MainActor in tab?.loading = view.isLoading } },
            webView.observe(\.estimatedProgress) { [weak tab] view, _ in Task { @MainActor in tab?.progress = view.estimatedProgress } },
        ]
        let anchor = openedBy ?? model.active
        if let anchor, let index = model.tabs.firstIndex(where: { $0.id == anchor.id }) {
            // After the opener and any tabs it already opened, the way browsers line them up.
            var at = index + 1
            while at < model.tabs.count, model.tabs[at].openedBy == anchor.id { at += 1 }
            model.tabs.insert(tab, at: at)
        } else {
            model.tabs.append(tab)
        }
        stack.add(webView)
        if activate || model.activeID == nil { select(tab) } else { stack.bringToFront(model.active?.webView) }
        if let url { tab.load(url) }
        trimTabs()
        return tab
    }

    /// Too many tabs: the oldest the person isn't looking at and nobody's working in goes.
    private func trimTabs() {
        while model.tabs.count > Self.maxTabs,
              let idle = model.tabs.first(where: { $0.id != model.activeID && $0.ownerRunID == nil && !$0.working }) {
            closeTab(idle)
        }
    }

    /// The glow follows the tab in front: on while someone works there.
    private func refreshGlow(pulse: Bool = false) {
        let active = model.active?.working ?? false
        if stack.glow.active != active { stack.glow.active = active }
        if pulse, active { stack.glow.pulse += 1 }
    }

    func select(_ tab: BrowserTab) {
        guard model.tabs.contains(where: { $0.id == tab.id }) else { return }
        model.activeID = tab.id
        stack.bringToFront(tab.webView)
        refreshGlow()
        if tab.isBlank { model.focusAddress += 1 }
    }

    func select(offset: Int) {
        guard let index = model.tabs.firstIndex(where: { $0.id == model.activeID }), !model.tabs.isEmpty else { return }
        select(model.tabs[(index + offset + model.tabs.count) % model.tabs.count])
    }

    /// Closes a tab. A run working in it is stopped first; the last tab is replaced by a new one.
    func closeTab(_ tab: BrowserTab) {
        if let owner = tab.ownerRunID { env?.stopRun(owner) }
        guard let index = model.tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        if recordingTab === tab { env?.stopBrowserRecording() }
        let wasActive = model.activeID == tab.id
        model.tabs.remove(at: index)
        tab.observations = []
        tab.interruptSettle?()
        tab.webView.stopLoading()
        tab.webView.navigationDelegate = nil
        tab.webView.uiDelegate = nil
        tab.webView.removeFromSuperview()
        if model.tabs.isEmpty {
            model.activeID = nil
            _ = openTab(activate: true)
        } else if wasActive {
            // Back to the tab that opened this one if it's still there, else the neighbour.
            let next = tab.openedBy.flatMap { self.tab($0) } ?? model.tabs[min(index, model.tabs.count - 1)]
            select(next)
        }
    }

    /// A tab for a run to work in: the one it already has, the one its conversation last used, the tab
    /// in front if nobody else is working there, or a new one.
    func tabForRun(runID: String, threadID: String?, preferred: UUID? = nil) -> BrowserTab {
        if let owned = model.tabs.first(where: { $0.ownerRunID == runID }) { return owned }
        if let preferred = tab(preferred), preferred.ownerRunID == nil { return preferred }
        if let threadID, let ended = tab(threadTabs[threadID]), ended.ownerRunID == nil { return ended }
        if let threadID, let previous = model.tabs.last(where: { $0.threadID == threadID && $0.ownerRunID == nil }) { return previous }
        // A blank tab in front is free to use; a page the person has open stays theirs.
        let front = activeTab
        if front.isBlank, front.ownerRunID == nil, !front.working, recordingTab !== front { return front }
        return openTab(activate: false, openedBy: nil)
    }

    /// The tabs a run has: the ones it works in.
    func tabs(ownedBy runID: String) -> [BrowserTab] { model.tabs.filter { $0.ownerRunID == runID } }

    /// "Version/27.0 Safari/605.1.15" on macOS 27: Safari's version follows the OS from 26 on.
    private static var safariName: String {
        let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        return "Version/\(major >= 26 ? "\(major).0" : "18.0") Safari/605.1.15"
    }

    private var window: NSWindow? { view.window }

    /// The browser is on screen in front of the person (not just loaded behind another page).
    private var showing: Bool { env?.browserFrame != nil && !view.isHidden && window?.isKeyWindow == true }

    /// ⌘L address, ⌘T new tab, ⌘W close tab, ⌘1…9 and ⌘⇧[ ⌘⇧] tabs, ⌘R reload, ⌘[ ⌘] back and forward,
    /// ⌘+ ⌘- ⌘0 zoom, while the browser is showing.
    private func installShortcuts() {
        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window, self.showing else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags == .control, event.keyCode == 48 { self.select(offset: 1); return nil }               // ⌃⇥
            if flags == [.control, .shift], event.keyCode == 48 { self.select(offset: -1); return nil }    // ⌃⇧⇥
            guard flags == .command || flags == [.command, .shift] else { return event }
            let tab = self.activeTab
            switch event.charactersIgnoringModifiers {
            case "l": self.model.focusAddress += 1
            case "t": self.openTab(activate: true)
            case "w": self.closeTab(tab)
            case "r": tab.webView.reload()
            case "[": tab.webView.goBack()
            case "]": tab.webView.goForward()
            case "{": self.select(offset: -1)
            case "}": self.select(offset: 1)
            case "=", "+": tab.webView.pageZoom = min(3, tab.webView.pageZoom + 0.1)
            case "-": tab.webView.pageZoom = max(0.5, tab.webView.pageZoom - 0.1)
            case "0": tab.webView.pageZoom = 1
            case let digit? where digit.count == 1 && ("1"..."9").contains(digit):
                let n = Int(digit)!
                guard !self.model.tabs.isEmpty else { return nil }
                // ⌘9 is always the last tab, as in every browser.
                self.select(n == 9 ? self.model.tabs[self.model.tabs.count - 1] : self.model.tabs[min(n, self.model.tabs.count) - 1])
            default: return event
            }
            return nil
        }
    }

    /// Esc while a tab someone is working in is in front hands it back.
    private func installEscape() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.keyCode == 53, event.window === self.window,
                  let tab = self.model.active, tab.working, let stop = tab.onEscape,
                  // Typing in the address bar: esc there just dismisses it.
                  !(self.window?.firstResponder is NSTextView) else { return event }
            stop()
            return nil
        }
    }

    /// The Browser page, with the dashboard in front. A URL opens in the tab in front unless someone is
    /// working there, in which case it gets a tab of its own.
    func show(url: URL? = nil) {
        env?.openDashboard(.browser)
        guard let url else {
            if activeTab.isBlank { model.focusAddress += 1 }
            return
        }
        let front = activeTab
        if front.working || front.ownerRunID != nil { openTab(url: url, activate: true) } else { front.load(url) }
    }

    /// The Browser page in front for the agent and replays, so the person can watch, without taking the
    /// keyboard from the app they're in.
    func showQuietly() {
        env?.showDashboardQuietly(.browser)
    }

    /// What the address bar does with what was typed: open it, search for it, or hand it to the agent.
    func go(typed: String, in tab: BrowserTab, choice: BrowserAddressChoice) {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch choice {
        case .ask:
            env?.startBrowserTask(text, in: tab)
        case .open, .search:
            let url = choice == .search ? BrowserSteps.searchURL(text) : BrowserSteps.addressURL(text)
            guard let url else { return }
            if tab.working {
                openTab(url: url, activate: true)
                return
            }
            tab.load(url)
            if model.recording, recordingTab === tab { record(BrowserSteps.navigate(url.absoluteString, delay: sinceLastStep())) }
        }
    }

    private func urlChanged(_ tab: BrowserTab, _ url: URL?) {
        tab.address = url?.absoluteString ?? ""
        let site = BrowserSteps.host(of: tab.address)
        tab.hasLogin = !site.isEmpty && env?.vault.logins.contains { BrowserSteps.sameSite($0.site, site) } == true
    }

    // MARK: - Sign-ins from other browsers

    /// Puts cookies into okidoki's profile, shared by every tab.
    func importCookies(_ cookies: [HTTPCookie]) async {
        let store = dataStore.httpCookieStore
        for cookie in cookies { await store.setCookie(cookie) }
    }

    /// Reloads the pages nobody is working in, so they pick up new sign-ins.
    func reloadIdleTabs() {
        for tab in model.tabs where !tab.isBlank && !tab.working && tab.ownerRunID == nil { tab.webView.reload() }
    }

    // MARK: - For scripts/dev-browser.sh

    /// Runs one of the page script's functions in the tab in front.
    func call(_ body: String, _ arguments: [String: Any] = [:]) async -> Any? {
        await activeTab.call(body, arguments)
    }

    /// Where an element is on screen (Quartz points, top-left origin), for scripted clicks that
    /// arrive as a person's would.
    func screenPoint(of selector: String) async -> CGPoint? {
        let webView = activeTab.webView
        guard let window, let rect = await activeTab.call("""
            const el = document.querySelector(s); if (!el) return null;
            el.scrollIntoView({block: 'center'}); const r = el.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
            """, ["s": selector]) as? [Double], rect.count == 2 else { return nil }
        let inView = NSPoint(x: rect[0], y: webView.isFlipped ? rect[1] : webView.bounds.height - rect[1])
        let inWindow = webView.convert(inView, to: nil)
        let onScreen = window.convertPoint(toScreen: inWindow)
        let primary = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: onScreen.x, y: primary - onScreen.y)
    }

    /// For scripts/dev-browser.sh: where the window is and whether macOS thinks it can be seen.
    func windowInfo() -> String {
        let webView = activeTab.webView
        let slot = "slot=\(env?.browserFrame.map { "\($0)" } ?? "hidden") viewHidden=\(view.isHidden) tabs=\(model.tabs.count) "
        guard let window else { return slot + "no window" }
        return slot + "visible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace) occlusion=\(window.occlusionState.contains(.visible)) " +
            "frame=\(window.frame) screen=\(window.screen?.localizedName ?? "nil") level=\(window.level.rawValue) " +
            "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) mini=\(window.isMiniaturized) " +
            "content=\(window.contentView?.frame ?? .zero) web=\(webView.frame)"
    }

    // MARK: - Agent and replay presence

    /// Marks a tab as worked in by a run: a line in its toolbar, and esc (with the tab in front) hands it back.
    func beginWork(_ line: String, in tab: BrowserTab, runID: String, threadID: String?, onEscape: @escaping () -> Void) {
        // Dialogs from before this task aren't this task's to hear about.
        if tab.status == nil { tab.dialogNotes = [] }
        tab.status = line
        tab.ownerRunID = runID
        if let threadID { tab.threadID = threadID }
        tab.onEscape = onEscape
        objectChanged()
        refreshGlow()
    }

    func updateWork(_ line: String, in tab: BrowserTab) {
        guard tab.status != nil else { return }
        tab.status = line
        if tab.id == model.activeID { refreshGlow(pulse: true) }
    }

    /// The tab each conversation's last run ended in, where its follow-ups carry on.
    private var threadTabs: [String: UUID] = [:]

    func noteThreadTab(_ threadID: String, _ tab: BrowserTab) {
        threadTabs[threadID] = tab.id
        tab.threadID = threadID
    }

    /// The run is done with every tab it had.
    func endWork(runID: String) {
        for tab in model.tabs where tab.ownerRunID == runID {
            tab.status = nil
            tab.ownerRunID = nil
            tab.onEscape = nil
        }
        objectChanged()
        refreshGlow()
    }

    /// The strip shows who's working where; tabs are classes, so the list itself has to say it changed.
    private func objectChanged() { model.objectWillChange.send() }

    // MARK: - Recording

    func startRecording() {
        let tab = activeTab
        recordingTab = tab
        model.recording = true
        model.recordedSteps = 0
        lastRecordedAt = Date()
        Task { _ = await tab.call("return window.__okidoki?.record(true)") }
        // The page they're on is where the skill starts.
        if let url = tab.webView.url?.absoluteString, !url.isEmpty, url != "about:blank" { record(BrowserSteps.navigate(url, delay: 0)) }
    }

    func stopRecording() {
        model.recording = false
        onRecordedStep = nil
        let tab = recordingTab
        recordingTab = nil
        Task { _ = await tab?.call("return window.__okidoki?.record(false)") }
    }

    private func sinceLastStep() -> Double {
        let now = Date()
        defer { lastRecordedAt = now }
        return lastRecordedAt.map { now.timeIntervalSince($0) } ?? 0
    }

    private func record(_ step: SkillStep) {
        model.recordedSteps += 1
        onRecordedStep?(step)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard model.recording, message.name == BrowserPageScript.recordHandler,
              let recordingTab, message.webView === recordingTab.webView,
              let body = message.body as? [String: Any],
              let step = BrowserSteps.step(from: body, delay: sinceLastStep()) else { return }
        record(step)
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard let tab = tab(for: webView) else { return }
        tab.navigating = true
        tab.currentNavigation = navigation
        tab.interruptSettle?()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard let tab = tab(for: webView) else { return }
        tab.navigationEnded(navigation)
        tab.interruptSettle?()
        tab.loadError = nil
        tab.failedURL = nil
        // A new page mid-recording keeps recording from its first moment, not once every image is in.
        if model.recording, recordingTab === tab { Task { _ = await tab.call("return window.__okidoki?.record(true)") } }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let tab = tab(for: webView) else { return }
        tab.navigationEnded(navigation)
        if model.recording, recordingTab === tab { Task { _ = await tab.call("return window.__okidoki?.record(true)") } }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let tab = tab(for: webView) else { return }
        tab.navigationEnded(navigation)
        loadFailed(error, in: tab)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let tab = tab(for: webView) else { return }
        tab.navigationEnded(navigation)
        loadFailed(error, in: tab)
    }

    private func loadFailed(_ error: Error, in tab: BrowserTab) {
        let nsError = error as NSError
        // Not failures: a load replaced by another, and one that became a download.
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain", [102, 204].contains(nsError.code) { return }
        tab.failedURL = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? tab.webView.url
        tab.loadError = nsError.localizedDescription
    }

    /// The page's process crashed or was reclaimed: bring it back rather than leave a blank page.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let tab = tab(for: webView) else { return }
        tab.navigating = true
        tab.currentNavigation = webView.reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // A sized window is a popup the page needs to talk back to (a "Sign in with Google" window):
        // it gets a real window.
        if windowFeatures.width != nil || windowFeatures.height != nil {
            return openPopup(configuration: configuration, features: windowFeatures)
        }
        // A link in a popup that wants a new tab stays in the popup, so the page waiting on it keeps its place.
        guard let source = tab(for: webView) else {
            webView.load(navigationAction.request)
            return nil
        }
        // A new-tab link gets a tab of its own, next to the page that opened it. The person's tab comes
        // to the front; one opened by the agent's work stays with the run, in front only if its opener was.
        let tab = openTab(activate: model.activeID == source.id, openedBy: source, configuration: configuration)
        if let owner = source.ownerRunID {
            tab.ownerRunID = owner
            tab.threadID = source.threadID
            tab.onEscape = source.onEscape
            tab.status = source.status
            refreshGlow()
        }
        tab.navigating = true
        return tab.webView
    }

    private func openPopup(configuration: WKWebViewConfiguration, features: WKWindowFeatures) -> WKWebView {
        let size = NSSize(width: CGFloat(features.width?.doubleValue ?? 520), height: CGFloat(features.height?.doubleValue ?? 640))
        let popup = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        popup.uiDelegate = self
        popup.navigationDelegate = self
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = popup
        window.title = "okidoki"
        if let parent = self.window {
            let frame = parent.frame
            window.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2))
        } else {
            window.center()
        }
        window.makeKeyAndOrderFront(nil)
        popups[ObjectIdentifier(popup)] = window
        return popup
    }

    /// The page closed its popup (sign-in done) or its own tab (`window.close()`).
    func webViewDidClose(_ webView: WKWebView) {
        if let window = popups[ObjectIdentifier(webView)] {
            window.close()
            return
        }
        // Only a tab a page opened may close itself, as in other browsers. A run working there isn't
        // stopped: it carries on in another of its tabs.
        if let tab = tab(for: webView), tab.openedBy != nil {
            tab.ownerRunID = nil
            tab.status = nil
            tab.onEscape = nil
            closeTab(tab)
        }
    }

    /// A popup's window is closing, by the page or by the person: let its page go, so the page that
    /// opened it sees it closed (a sign-in that was cancelled stops waiting).
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let key = popups.first(where: { $0.value === window })?.key else { return }
        popups[key] = nil
        if let popup = window.contentView as? WKWebView {
            popup.stopLoading()
            popup.uiDelegate = nil
            popup.navigationDelegate = nil
        }
        window.delegate = nil
        window.contentView = nil
    }

    // MARK: - Dialogs and file pickers

    /// Someone (the agent or a replay) has this page: dialogs are answered for it, not shown.
    private func workedIn(_ webView: WKWebView) -> BrowserTab? {
        guard let tab = tab(for: webView), tab.working else { return nil }
        return tab
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        if let tab = workedIn(webView) { tab.dialogNotes.append("alert “\(Self.short(message))”"); return }
        _ = await ask(message, buttons: ["OK"], on: webView)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        // The person already approved the task the agent is doing; the agent hears what was confirmed.
        if let tab = workedIn(webView) { tab.dialogNotes.append("confirm “\(Self.short(message))” → OK"); return true }
        return await ask(message, buttons: ["OK", "Cancel"], on: webView) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        if let tab = workedIn(webView) {
            tab.dialogNotes.append("prompt “\(Self.short(prompt))” → “\(defaultText ?? "")”")
            return defaultText ?? ""
        }
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        return await ask(prompt, buttons: ["OK", "Cancel"], on: webView, accessory: field) == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        if let tab = workedIn(webView) { tab.dialogNotes.append("a file picker opened; nothing was chosen"); return nil }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.directoryURL = env?.vault.folderURL
        guard let host = webView.window else { return panel.runModal() == .OK ? panel.urls : nil }
        return await panel.beginSheetModal(for: host) == .OK ? panel.urls : nil
    }

    private func ask(_ message: String, buttons: [String], on webView: WKWebView, accessory: NSView? = nil) async -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = BrowserSteps.host(of: webView.url?.absoluteString ?? "").isEmpty
            ? "This page says" : "\(BrowserSteps.host(of: webView.url?.absoluteString ?? "")) says"
        alert.informativeText = message
        for title in buttons { alert.addButton(withTitle: title) }
        alert.accessoryView = accessory
        guard let host = webView.window else { return alert.runModal() }
        return await alert.beginSheetModal(for: host)
    }

    private static func short(_ text: String) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        return flat.count > 160 ? String(flat.prefix(160)) + "…" : flat
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.shouldPerformDownload { return .download }
        // ⌘-click opens a link in a background tab, as in other browsers.
        if navigationAction.navigationType == .linkActivated, navigationAction.modifierFlags.contains(.command),
           let url = navigationAction.request.url, let source = tab(for: webView) {
            openTab(url: url, activate: navigationAction.modifierFlags.contains(.shift), openedBy: source)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - Downloads go to the vault

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        guard let env else { return nil }
        let folder = (try? env.vault.subfolder("Downloads")) ?? env.vault.folderURL
        let name = LocalVault.safeFileName(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        var url = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            url = folder.appendingPathComponent("\(base) \(n)" + (ext.isEmpty ? "" : ".\(ext)"))
            n += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = (url, download.webView.flatMap { tab(for: $0)?.id })
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        Task { @MainActor in
            let saved = downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
            let name = saved?.url.lastPathComponent ?? "a file"
            // The agent working in that tab hears about it on its next look.
            (tab(saved?.tab) ?? model.active)?.finishedDownloads.append(name)
            env?.vault.rescan()
            env?.toast(title: "saved to your vault", detail: "Downloads/\(name)", kind: .success,
                       undoLabel: nil, onUndo: nil, editLabel: "vault", onEdit: { [weak self] in self?.env?.openDashboard(.vault) },
                       runID: nil)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        Task { @MainActor in
            downloadDestinations[ObjectIdentifier(download)] = nil
            env?.toast(title: "download failed", detail: error.localizedDescription, kind: .warning,
                       undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }
}

struct BrowserSnapshot {
    var url: String
    var title: String
    var elements: String
    var text: String
    var count: Int
    var downloads: [String]
    var dialogs: [String] = []
    var loadError: String?
    /// Elements further down the page than the list reaches.
    var more: Int = 0
}

struct BrowserActResult {
    var ok: Bool
    var detail: String?
    var selectors: [String]
    /// Which recorded selector found the element; above 0 means the first ones no longer work.
    var matched: Int
    var label: String?
    var role: String?
}

/// What Return does with the address bar's text.
enum BrowserAddressChoice: Equatable {
    case open, search, ask
}

// MARK: - View

/// Every tab's page, stacked, the one in front on top. Pages behind stay in the window rather than
/// being removed or hidden, so WebKit keeps running them at full speed for an agent working there.
final class TabStackView: NSView {
    override var isFlipped: Bool { true }
    /// The glow while the agent works in the tab in front: always the top layer, never in the way of a click.
    let glow = BrowserGlowModel()
    private lazy var glowView: NSView = {
        let view = PassThroughHostingView(rootView: BrowserWorkGlow(model: glow))
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        return view
    }()

    func add(_ webView: WKWebView) {
        webView.frame = bounds
        webView.autoresizingMask = [.width, .height]
        addSubview(webView, positioned: .below, relativeTo: nil)
        keepGlowOnTop()
    }

    func bringToFront(_ webView: WKWebView?) {
        guard let webView, webView.superview === self else { return }
        addSubview(webView, positioned: .above, relativeTo: nil)
        for page in subviews { page.isHidden = false }
        keepGlowOnTop()
    }

    private func keepGlowOnTop() {
        addSubview(glowView, positioned: .above, relativeTo: nil)
    }

    override func layout() {
        super.layout()
        for page in subviews { page.frame = bounds }
    }
}

/// A hosting view that clicks, scrolls and hovers go straight through.
private final class PassThroughHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

@MainActor
final class BrowserGlowModel: ObservableObject {
    /// Someone is working in the tab in front.
    @Published var active = false
    /// Bumped on each action, for a brief brightening.
    @Published var pulse = 0
}

/// The computer-use glow, brought inside the page: the same violet → pink → orange light around the
/// edges, plus a fine grid of translucent dots in those colours that fades out toward the middle, so
/// the page stays readable. It breathes slowly and brightens for a moment on each action.
private struct BrowserWorkGlow: View {
    @ObservedObject var model: BrowserGlowModel
    @State private var breathing = false
    @State private var flare = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let colors = [
        Color(hex: 0x6D3BF5), Color(hex: 0x9B2EC6), Color(hex: 0xE0339A),
        Color(hex: 0xFF9147), Color(hex: 0xE0339A), Color(hex: 0x9B2EC6), Color(hex: 0x6D3BF5),
    ]
    private static let gradient = AngularGradient(colors: colors, center: .center)

    var body: some View {
        ZStack {
            // The dots: a grid masked to the edges, tinted by the gradient.
            Rectangle()
                .fill(Self.gradient)
                .mask(dots)
                .mask(
                    Rectangle().strokeBorder(Color.white, lineWidth: 64).blur(radius: 26)
                )
                .opacity(0.42)
            // The light: a soft haze that bleeds in from the frame, a little denser at the edge.
            Rectangle()
                .strokeBorder(Self.gradient, lineWidth: 14)
                .blur(radius: 18)
                .opacity(0.34)
            Rectangle()
                .strokeBorder(Self.gradient, lineWidth: 3)
                .blur(radius: 5)
                .opacity(0.55)
            Rectangle()
                .strokeBorder(Color.white, lineWidth: 1.5)
                .blur(radius: 4)
                .opacity(0.16)
        }
        .compositingGroup()
        .opacity(flare ? 1 : (breathing ? 0.85 : 0.55))
        .opacity(model.active ? 1 : 0)
        .animation(.easeOut(duration: 0.5), value: model.active)
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { breathing = true; return }
            withAnimation(.easeInOut(duration: 2.6).repeatForever(autoreverses: true)) { breathing = true }
        }
        .onChange(of: model.pulse) { _, _ in
            guard model.active, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 0.18)) { flare = true }
            withAnimation(.easeIn(duration: 0.7).delay(0.18)) { flare = false }
        }
    }

    /// Small round dots on an even grid, drawn once.
    private var dots: some View {
        Canvas { context, size in
            let spacing: CGFloat = 13, radius: CGFloat = 0.9
            var path = Path()
            var y = spacing / 2
            while y < size.height {
                var x = spacing / 2
                while x < size.width {
                    path.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
                    x += spacing
                }
                y += spacing
            }
            context.fill(path, with: .color(.white))
        }
    }
}

private struct BrowserView: View {
    @ObservedObject var model: BrowserModel
    let stack: TabStackView
    weak var controller: BrowserController?

    var body: some View {
        VStack(spacing: 0) {
            BrowserTabStrip(model: model, controller: controller)
            if let tab = model.active {
                BrowserToolbar(tab: tab, model: model, controller: controller)
                    .id(tab.id)
            }
            ZStack(alignment: .top) {
                TabStackRepresentable(stack: stack)
                if let tab = model.active { BrowserPageOverlay(tab: tab, controller: controller).id(tab.id) }
            }
        }
    }
}

private struct BrowserTabStrip: View {
    @ObservedObject var model: BrowserModel
    weak var controller: BrowserController?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = OKTheme(scheme)
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.tabs) { tab in
                        BrowserTabChip(tab: tab, active: tab.id == model.active?.id, closable: true,
                                       select: { controller?.select(tab) }, close: { controller?.closeTab(tab) })
                    }
                }
                .padding(.horizontal, 1)
            }
            OKIconButton(glyph: "plus", size: 24, help: "New tab (⌘T)") { controller?.openTab(activate: true) }
        }
        .padding(.horizontal, 12).padding(.top, 8)
        .background(theme.card.opacity(0.0001))
    }
}

private struct BrowserTabChip: View {
    @ObservedObject var tab: BrowserTab
    let active: Bool
    let closable: Bool
    let select: () -> Void
    let close: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        let theme = OKTheme(scheme)
        HStack(spacing: 6) {
            if tab.working {
                BreathingGlow(color: OKBrand.green, size: 7)
            } else if tab.loading {
                PixelGlyph(name: "spinner", size: 9, color: theme.secondary)
            } else {
                PixelGlyph(name: "globe", size: 9, color: theme.tertiary)
            }
            Text(tab.label)
                .font(.okBody(12, active ? .medium : .regular))
                .foregroundStyle(active ? theme.ink : theme.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if closable {
                Button(action: close) {
                    PixelGlyph(name: "x", size: 8, color: theme.secondary)
                        .frame(width: 16, height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(hovering || active ? 1 : 0)
                .help(tab.ownerRunID != nil ? "Close tab and stop the agent working here" : "Close tab (⌘W)")
            }
        }
        .padding(.leading, 9).padding(.trailing, 4)
        .frame(width: 168, height: 28)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(active ? theme.card : (hovering ? Color.primary.opacity(0.05) : .clear))
        )
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(active ? theme.line : .clear))
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .onHover { hovering = $0 }
        .help(tab.status ?? tab.address)
    }
}

private struct BrowserToolbar: View {
    @ObservedObject var tab: BrowserTab
    @ObservedObject var model: BrowserModel
    weak var controller: BrowserController?
    @Environment(\.colorScheme) private var scheme
    @FocusState private var addressFocused: Bool
    @State private var typed = ""
    /// Which suggestion Return takes, while typing; nil follows the default for what's typed.
    @State private var picked: BrowserAddressChoice?

    private var choices: [BrowserAddressChoice] {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard addressFocused, !text.isEmpty, text != tab.address else { return [] }
        if BrowserSteps.looksLikeAddress(text) { return [.open, .ask] }
        return BrowserSteps.looksLikeTask(text) ? [.ask, .search] : [.search, .ask]
    }

    private var chosen: BrowserAddressChoice {
        let options = choices
        if let picked, options.contains(picked) { return picked }
        return options.first ?? .open
    }

    var body: some View {
        let theme = OKTheme(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                OKIconButton(glyph: "chevron-left", help: "Back") { tab.webView.goBack() }
                    .disabled(!tab.canGoBack).opacity(tab.canGoBack ? 1 : 0.4)
                OKIconButton(glyph: "chevron", help: "Forward") { tab.webView.goForward() }
                    .disabled(!tab.canGoForward).opacity(tab.canGoForward ? 1 : 0.4)
                OKIconButton(glyph: tab.loading ? "x" : "refresh", help: tab.loading ? "Stop" : "Reload") {
                    if tab.loading { tab.webView.stopLoading() } else { tab.webView.reload() }
                }
                HStack(spacing: 6) {
                    if tab.hasLogin {
                        Image(systemName: "key.fill").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(OKBrand.greenInk)
                            .help("A vault login is saved for this site")
                    }
                    TextField("Search, enter a website, or ask okidoki to do something", text: $typed)
                        .textFieldStyle(.plain)
                        .font(.okBody(13))
                        .focused($addressFocused)
                        .onSubmit { submit(chosen) }
                        .onKeyPress(.downArrow) { move(1) }
                        .onKeyPress(.upArrow) { move(-1) }
                        .onKeyPress(.escape) {
                            guard addressFocused else { return .ignored }
                            typed = tab.address
                            addressFocused = false
                            return .handled
                        }
                }
                .padding(.horizontal, 10).frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 9).fill(theme.card))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(addressFocused ? theme.lineStrong : theme.line))
                if let status = tab.status {
                    HStack(spacing: 6) {
                        BreathingGlow(color: OKBrand.green, size: 8)
                        Text(status).font(.okBody(12, .medium)).lineLimit(1)
                        Text("esc").font(.okMono(10)).foregroundStyle(theme.tertiary)
                    }
                    .padding(.horizontal, 10).frame(height: 30)
                    .frame(maxWidth: 320)
                    .background(Capsule().fill(OKBrand.green.opacity(0.16)))
                    .transition(.opacity)
                }
                Button {
                    model.recording ? controller?.env_stopRecording() : controller?.env_startRecording()
                } label: {
                    HStack(spacing: 5) {
                        Circle().fill(model.recording ? Color.red : theme.secondary).frame(width: 8, height: 8)
                        Text(model.recording ? "Save · \(model.recordedSteps)" : "Record").font(.okBody(12, .medium))
                    }
                }
                .buttonStyle(OKButtonStyle(kind: model.recording ? .primary : .secondary, compact: true))
                .help(model.recording ? "Stop and save these steps as a skill" : "Record what you do here as a skill")
            }
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            if !choices.isEmpty {
                VStack(spacing: 2) {
                    ForEach(choices, id: \.self) { choice in
                        suggestion(choice, selected: choice == chosen, theme: theme)
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
                .transition(.opacity)
            }
        }
        .onAppear { typed = tab.address; if tab.isBlank { addressFocused = true } }
        .onChange(of: tab.address) { _, value in if !addressFocused { typed = value } }
        .onChange(of: typed) { _, _ in picked = nil }
        .onChange(of: model.focusAddress) { _, _ in addressFocused = true }
        .animation(OKMotion.quick, value: tab.status)
        .animation(OKMotion.quick, value: choices)
    }

    private func move(_ by: Int) -> KeyPress.Result {
        let options = choices
        guard options.count > 1, let index = options.firstIndex(of: chosen) else { return .ignored }
        picked = options[(index + by + options.count) % options.count]
        return .handled
    }

    private func submit(_ choice: BrowserAddressChoice) {
        let text = typed
        controller?.go(typed: text, in: tab, choice: choice)
        addressFocused = false
        if choice == .ask { typed = tab.address }
    }

    private func suggestion(_ choice: BrowserAddressChoice, selected: Bool, theme: OKTheme) -> some View {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let (glyph, verb, hint): (String, String, String) = switch choice {
        case .ask: ("bolt", "Ask okidoki to do it", "the agent works in this tab")
        case .search: ("search", "Search Google", "")
        case .open: ("globe", "Open", BrowserSteps.addressURL(text).map { BrowserSteps.displayURL($0.absoluteString) } ?? "")
        }
        return Button { submit(choice) } label: {
            HStack(spacing: 8) {
                PixelGlyph(name: glyph, size: 11, color: choice == .ask ? OKBrand.greenInk : theme.secondary)
                Text(verb).font(.okBody(12.5, .medium)).foregroundStyle(theme.ink)
                Text(choice == .open ? hint : "“\(text)”").font(.okBody(12.5)).foregroundStyle(theme.secondary).lineLimit(1)
                Spacer(minLength: 8)
                if choice == .ask, !hint.isEmpty { Text(hint).font(.okBody(11)).foregroundStyle(theme.tertiary) }
                if selected { Text("↩").font(.okMono(11)).foregroundStyle(theme.tertiary) }
            }
            .padding(.horizontal, 10).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.primary.opacity(0.06) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Over the page: why it didn't load, a blank tab's hint, and the load progress.
private struct BrowserPageOverlay: View {
    @ObservedObject var tab: BrowserTab
    weak var controller: BrowserController?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let theme = OKTheme(scheme)
        ZStack(alignment: .top) {
            if let error = tab.loadError {
                VStack(spacing: 10) {
                    Text("This page didn’t load").font(.okBody(15, .semibold))
                    Text(error).font(.okBody(12)).foregroundStyle(theme.secondary)
                        .multilineTextAlignment(.center).frame(maxWidth: 360)
                    Button("Try again") { tab.retryFailedLoad() }
                        .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.card)
            } else if tab.isBlank, !tab.loading, tab.status == nil {
                VStack(spacing: 8) {
                    PixelGlyph(name: "globe", size: 22, color: theme.tertiary)
                    Text("Type a website, a search, or a task").font(.okBody(14, .semibold))
                    Text("“book a table for two at 8 tonight” — okidoki does it right here, in this tab.")
                        .font(.okBody(12)).foregroundStyle(theme.secondary)
                        .multilineTextAlignment(.center).frame(maxWidth: 380)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.card)
                .allowsHitTesting(false)
            }
            if tab.loading {
                GeometryReader { geo in
                    Rectangle().fill(OKBrand.green).frame(width: geo.size.width * tab.progress, height: 2)
                }
                .frame(height: 2)
            }
        }
    }
}

private struct TabStackRepresentable: NSViewRepresentable {
    let stack: TabStackView
    func makeNSView(context: Context) -> TabStackView { stack }
    func updateNSView(_ nsView: TabStackView, context: Context) {}
}

extension BrowserController {
    fileprivate func env_startRecording() { env?.startBrowserRecording() }
    fileprivate func env_stopRecording() { env?.stopBrowserRecording() }
}
