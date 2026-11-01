import AppKit
import OkidokiCore
import SwiftUI
import WebKit

/// What the browser's toolbar shows.
@MainActor
final class BrowserModel: ObservableObject {
    @Published var address = ""
    @Published var title = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var loading = false
    @Published var progress: Double = 0
    /// Recording a skill: what the person does here becomes its steps.
    @Published var recording = false
    @Published var recordedSteps = 0
    /// A line from the agent or a replay while one is working in this window; nil when it's yours.
    @Published var status: String?
    /// A vault login exists for the page's site.
    @Published var hasLogin = false
    /// Why the last load failed (offline, a bad address), shown over the page with a way to try again.
    @Published var loadError: String?
    /// Bumped by ⌘L to put the cursor in the address bar.
    @Published var focusAddress = 0
}

/// okidoki's own browser: one page shown on the dashboard's Browser page, its own saved logins (a
/// separate website data store, so nothing is shared with Safari), and the page script in a content
/// world of its own. The view stays in the dashboard window while other pages are showing, just
/// hidden, so a run or a replay carries on wherever the person goes.
/// The agent, recordings and replays all work through `snapshot`, `act` and `settle` here, on the
/// DOM rather than with the mouse, so the person can keep using the rest of the Mac meanwhile.
@MainActor
final class BrowserController: NSObject, WKNavigationDelegate, WKUIDelegate,
                               WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate {
    /// One profile for every launch; WebKit keeps its cookies and storage under this id.
    private static let profileID = UUID(uuidString: "6B1D9E2A-0C55-4E1F-9A0B-0D0E1D0C1B1E")!

    let model = BrowserModel()
    private(set) var webView: WKWebView!
    /// The toolbar and the page, for the dashboard to place over its Browser page.
    private(set) var view: NSView!
    private weak var env: AppEnvironment?
    private let world = WKContentWorld.world(name: BrowserPageScript.worldName)
    private var observations: [NSKeyValueObservation] = []
    private var escMonitor: Any?
    /// Called with each recorded step while recording.
    var onRecordedStep: ((SkillStep) -> Void)?
    /// Called when the person presses esc while the agent or a replay has the page.
    var onEscape: (() -> Void)?
    /// Files the page downloaded since the agent last asked, by name.
    private(set) var finishedDownloads: [String] = []
    /// Where each download in flight is being saved, so its name is known when it finishes.
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var lastRecordedAt: Date?
    /// A navigation has started and its new page hasn't appeared yet: the old page is about to go.
    private var navigating = false
    /// The navigation `navigating` is about. Callbacks for an older one (the previous page's images
    /// being cancelled) must not end the wait for this one.
    private var currentNavigation: WKNavigation?
    /// The address a failed load was for, so "Try again" can go back to it.
    private var failedURL: URL?
    /// Dialogs the page raised while the agent or a replay had it, for the agent's next look.
    private var dialogNotes: [String] = []
    /// Windows a page opened on purpose (a "Sign in with Google" popup), each with its own page.
    private var popups: [ObjectIdentifier: NSWindow] = [:]
    private var shortcutMonitor: Any?
    /// The agent or a replay has the page (dialogs are answered for it, not shown).
    private var working: Bool { model.status != nil }

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        build()
    }

    private func build() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.profileID)
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: BrowserPageScript.source, injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true, in: world))
        controller.add(self, contentWorld: world, name: BrowserPageScript.recordHandler)
        configuration.userContentController = controller
        configuration.preferences.isElementFullscreenEnabled = true
        // Safari's own user agent, kept in step with this macOS, so sites serve their full desktop page.
        configuration.applicationNameForUserAgent = Self.safariName

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        self.webView = webView
        installShortcuts()

        observations = [
            webView.observe(\.url) { [weak self] view, _ in Task { @MainActor in self?.urlChanged(view.url) } },
            webView.observe(\.title) { [weak self] view, _ in Task { @MainActor in self?.model.title = view.title ?? "" } },
            webView.observe(\.canGoBack) { [weak self] view, _ in Task { @MainActor in self?.model.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] view, _ in Task { @MainActor in self?.model.canGoForward = view.canGoForward } },
            webView.observe(\.isLoading) { [weak self] view, _ in Task { @MainActor in self?.model.loading = view.isLoading } },
            webView.observe(\.estimatedProgress) { [weak self] view, _ in Task { @MainActor in self?.model.progress = view.estimatedProgress } },
        ]

        view = NSHostingView(rootView: BrowserView(model: model, webView: webView, controller: self))
    }

    private var window: NSWindow? { webView.window }

    /// "Version/27.0 Safari/605.1.15" on macOS 27: Safari's version follows the OS from 26 on.
    private static var safariName: String {
        let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        return "Version/\(major >= 26 ? "\(major).0" : "18.0") Safari/605.1.15"
    }

    /// The browser is on screen in front of the person (not just loaded behind another page).
    private var showing: Bool { env?.browserFrame != nil && !view.isHidden && window?.isKeyWindow == true }

    /// ⌘L address, ⌘R reload, ⌘[ ⌘] back and forward, ⌘+ ⌘- ⌘0 zoom, while the browser is showing.
    private func installShortcuts() {
        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window, self.showing else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard flags == .command || flags == [.command, .shift] else { return event }
            switch event.charactersIgnoringModifiers {
            case "l": self.model.focusAddress += 1
            case "r": self.webView.reload()
            case "[": self.webView.goBack()
            case "]": self.webView.goForward()
            case "=", "+": self.webView.pageZoom = min(3, self.webView.pageZoom + 0.1)
            case "-": self.webView.pageZoom = max(0.5, self.webView.pageZoom - 0.1)
            case "0": self.webView.pageZoom = 1
            default: return event
            }
            return nil
        }
    }

    /// Loads the address the last failed load was for.
    func retryFailedLoad() {
        model.loadError = nil
        if let failedURL { load(failedURL) } else { webView.reload() }
    }

    /// The Browser page, with the dashboard in front.
    func show(url: URL? = nil) {
        env?.openDashboard(.browser)
        if let url { load(url) } else if webView.url == nil { load(URL(string: "https://www.google.com")!) }
    }

    /// The Browser page in front for the agent and replays, so the person can watch, without taking the
    /// keyboard from the app they're in.
    func showQuietly() {
        env?.showDashboardQuietly(.browser)
    }

    func load(_ url: URL) {
        load(URLRequest(url: url))
    }

    /// The whole request, so a form posted to a new window keeps its method and body.
    private func load(_ request: URLRequest) {
        // Marked before WebKit says so, so a settle that starts right away waits for the new page.
        navigating = true
        currentNavigation = webView.load(request)
    }

    private func navigationEnded(_ navigation: WKNavigation?) {
        guard currentNavigation == nil || navigation === currentNavigation else { return }
        navigating = false
        currentNavigation = nil
    }

    func go(typed: String) {
        guard let url = BrowserSteps.addressURL(typed) else { return }
        load(url)
        if model.recording { record(BrowserSteps.navigate(url.absoluteString, delay: sinceLastStep())) }
    }

    private func urlChanged(_ url: URL?) {
        model.address = url?.absoluteString ?? ""
        let site = BrowserSteps.host(of: model.address)
        model.hasLogin = !site.isEmpty && env?.vault.logins.contains { BrowserSteps.sameSite($0.site, site) } == true
    }

    // MARK: - The page, for the agent and replays

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
                               loadError: model.loadError)
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

    private static let settleReplaced = -2
    /// Ends the settle in flight when its page is being replaced: the old page never answers it.
    private var interruptSettle: (() -> Void)?

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

    /// Where an element is on screen (Quartz points, top-left origin), for scripted clicks that
    /// arrive as a person's would.
    func screenPoint(of selector: String) async -> CGPoint? {
        guard let window, let rect = await call("""
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
        let slot = "slot=\(env?.browserFrame.map { "\($0)" } ?? "hidden") viewHidden=\(view.isHidden) "
        guard let window else { return slot + "no window" }
        return slot + "visible=\(window.isVisible) onActiveSpace=\(window.isOnActiveSpace) occlusion=\(window.occlusionState.contains(.visible)) " +
            "frame=\(window.frame) screen=\(window.screen?.localizedName ?? "nil") level=\(window.level.rawValue) " +
            "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) mini=\(window.isMiniaturized) " +
            "content=\(window.contentView?.frame ?? .zero) web=\(webView.frame)"
    }

    // MARK: - Agent and replay presence

    /// Shows a line in the toolbar while the agent or a replay has the page; esc hands it back.
    func beginWork(_ line: String) {
        // Dialogs from before this task aren't this task's to hear about.
        if model.status == nil { dialogNotes = [] }
        model.status = line
        guard escMonitor == nil else { return }
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, self?.model.status != nil, event.window === self?.window else { return event }
            self?.onEscape?()
            return nil
        }
    }

    func updateWork(_ line: String) { if model.status != nil { model.status = line } }

    func endWork() {
        model.status = nil
        onEscape = nil
        if let escMonitor { NSEvent.removeMonitor(escMonitor) }
        escMonitor = nil
    }

    // MARK: - Recording

    func startRecording() {
        model.recording = true
        model.recordedSteps = 0
        lastRecordedAt = Date()
        Task { _ = await call("return window.__okidoki?.record(true)") }
        // The page they're on is where the skill starts.
        if let url = webView.url?.absoluteString, !url.isEmpty { record(BrowserSteps.navigate(url, delay: 0)) }
    }

    func stopRecording() {
        model.recording = false
        onRecordedStep = nil
        Task { _ = await call("return window.__okidoki?.record(false)") }
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
              let body = message.body as? [String: Any],
              let step = BrowserSteps.step(from: body, delay: sinceLastStep()) else { return }
        record(step)
    }

    // MARK: - Navigation

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        navigating = true
        currentNavigation = navigation
        interruptSettle?()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        navigationEnded(navigation)
        interruptSettle?()
        model.loadError = nil
        failedURL = nil
        // A new page mid-recording keeps recording from its first moment, not once every image is in.
        if model.recording { Task { _ = await call("return window.__okidoki?.record(true)") } }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        navigationEnded(navigation)
        if model.recording { Task { _ = await call("return window.__okidoki?.record(true)") } }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        navigationEnded(navigation)
        loadFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        navigationEnded(navigation)
        loadFailed(error)
    }

    private func loadFailed(_ error: Error) {
        let nsError = error as NSError
        // Not failures: a load replaced by another, and one that became a download.
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain", [102, 204].contains(nsError.code) { return }
        failedURL = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        model.loadError = nsError.localizedDescription
    }

    /// The page's process crashed or was reclaimed: bring it back rather than leave a blank page.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        navigating = true
        currentNavigation = webView.reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // A sized window is a popup the page needs to talk back to (a "Sign in with Google" window):
        // it gets a real window. Plain new-tab links open here instead, in the one page.
        if windowFeatures.width != nil || windowFeatures.height != nil {
            return openPopup(configuration: configuration, features: windowFeatures)
        }
        // A link in a popup that wants a new tab stays in the popup, so the page waiting on it keeps its place.
        if navigationAction.targetFrame == nil {
            if webView === self.webView { load(navigationAction.request) } else { webView.load(navigationAction.request) }
        }
        return nil
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

    /// The page closed its popup (sign-in done): close its window.
    func webViewDidClose(_ webView: WKWebView) {
        guard let window = popups[ObjectIdentifier(webView)] else { return }
        window.close()
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

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        if working { dialogNotes.append("alert “\(Self.short(message))”"); return }
        _ = await ask(message, buttons: ["OK"], on: webView)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        // The person already approved the task the agent is doing; the agent hears what was confirmed.
        if working { dialogNotes.append("confirm “\(Self.short(message))” → OK"); return true }
        return await ask(message, buttons: ["OK", "Cancel"], on: webView) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        if working { dialogNotes.append("prompt “\(Self.short(prompt))” → “\(defaultText ?? "")”"); return defaultText ?? "" }
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        return await ask(prompt, buttons: ["OK", "Cancel"], on: webView, accessory: field) == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        if working { dialogNotes.append("a file picker opened; nothing was chosen"); return nil }
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
        navigationAction.shouldPerformDownload ? .download : .allow
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
        downloadDestinations[ObjectIdentifier(download)] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        Task { @MainActor in
            let name = downloadDestinations.removeValue(forKey: ObjectIdentifier(download))?.lastPathComponent ?? "a file"
            finishedDownloads.append(name)
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

// MARK: - View

private struct BrowserView: View {
    @ObservedObject var model: BrowserModel
    let webView: WKWebView
    weak var controller: BrowserController?
    @Environment(\.colorScheme) private var scheme
    @FocusState private var addressFocused: Bool
    @State private var typed = ""

    var body: some View {
        let theme = OKTheme(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                OKIconButton(glyph: "chevron-left", help: "Back") { webView.goBack() }
                    .disabled(!model.canGoBack).opacity(model.canGoBack ? 1 : 0.4)
                OKIconButton(glyph: "chevron", help: "Forward") { webView.goForward() }
                    .disabled(!model.canGoForward).opacity(model.canGoForward ? 1 : 0.4)
                OKIconButton(glyph: model.loading ? "x" : "refresh", help: model.loading ? "Stop" : "Reload") {
                    if model.loading { webView.stopLoading() } else { webView.reload() }
                }
                HStack(spacing: 6) {
                    if model.hasLogin {
                        Image(systemName: "key.fill").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(OKBrand.greenInk)
                            .help("A vault login is saved for this site")
                    }
                    TextField("Search or enter a website", text: $typed)
                        .textFieldStyle(.plain)
                        .font(.okBody(13))
                        .focused($addressFocused)
                        .onSubmit {
                            controller?.go(typed: typed)
                            addressFocused = false
                        }
                }
                .padding(.horizontal, 10).frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 9).fill(theme.card))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(theme.line))
                if let status = model.status {
                    HStack(spacing: 6) {
                        BreathingGlow(color: OKBrand.green, size: 8)
                        Text(status).font(.okBody(12, .medium)).lineLimit(1)
                        Text("esc").font(.okMono(10)).foregroundStyle(theme.tertiary)
                    }
                    .padding(.horizontal, 10).frame(height: 30)
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
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8)
            ZStack(alignment: .top) {
                BrowserWebView(webView: webView)
                if let error = model.loadError {
                    VStack(spacing: 10) {
                        Text("This page didn’t load").font(.okBody(15, .semibold))
                        Text(error).font(.okBody(12)).foregroundStyle(theme.secondary)
                            .multilineTextAlignment(.center).frame(maxWidth: 360)
                        Button("Try again") { controller?.retryFailedLoad() }
                            .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(theme.card)
                }
                if model.loading {
                    GeometryReader { geo in
                        Rectangle().fill(OKBrand.green).frame(width: geo.size.width * model.progress, height: 2)
                    }
                    .frame(height: 2)
                }
            }
        }
        .onChange(of: model.address) { _, value in if !addressFocused { typed = value } }
        .onChange(of: model.focusAddress) { _, _ in addressFocused = true }
        .animation(OKMotion.quick, value: model.status)
    }
}

private struct BrowserWebView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

extension BrowserController {
    fileprivate func env_startRecording() { env?.startBrowserRecording() }
    fileprivate func env_stopRecording() { env?.stopBrowserRecording() }
}
