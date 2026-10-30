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
}

/// okidoki's own browser: a window with one page, its own saved logins (a separate website data
/// store, so nothing is shared with Safari), and the page script in a content world of its own.
/// The agent, recordings and replays all work through `snapshot`, `act` and `settle` here, on the
/// DOM rather than with the mouse, so the person can keep using the rest of the Mac meanwhile.
@MainActor
final class BrowserWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
                                     WKScriptMessageHandler, WKDownloadDelegate {
    /// One profile for every launch; WebKit keeps its cookies and storage under this id.
    private static let profileID = UUID(uuidString: "6B1D9E2A-0C55-4E1F-9A0B-0D0E1D0C1B1E")!

    let model = BrowserModel()
    private(set) var webView: WKWebView!
    private var window: NSWindow?
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
    private var lastRecordedAt: Date?

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

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        // A desktop Safari user agent, so sites don't serve a stripped-down page to an unknown browser.
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        self.webView = webView

        observations = [
            webView.observe(\.url) { [weak self] view, _ in Task { @MainActor in self?.urlChanged(view.url) } },
            webView.observe(\.title) { [weak self] view, _ in Task { @MainActor in self?.model.title = view.title ?? "" } },
            webView.observe(\.canGoBack) { [weak self] view, _ in Task { @MainActor in self?.model.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] view, _ in Task { @MainActor in self?.model.canGoForward = view.canGoForward } },
            webView.observe(\.isLoading) { [weak self] view, _ in Task { @MainActor in self?.model.loading = view.isLoading } },
            webView.observe(\.estimatedProgress) { [weak self] view, _ in Task { @MainActor in self?.model.progress = view.estimatedProgress } },
        ]

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "okidoki browser"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .okDashboardBackground
        window.minSize = NSSize(width: 640, height: 420)
        window.setFrameAutosaveName("OkidokiBrowser")
        if window.frame.origin == .zero { window.center() }
        window.contentView = NSHostingView(rootView: BrowserView(model: model, webView: webView, controller: self))
        window.delegate = self
        self.window = window
    }

    var isVisible: Bool { window?.isVisible == true }

    func show(url: URL? = nil) {
        guard let window else { return }
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        if !window.isVisible { window.okFitToScreen() }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        if let url { load(url) } else if webView.url == nil { load(URL(string: "https://www.google.com")!) }
    }

    /// Brings the window up without taking focus from the app they're in, for the agent and replays.
    func showQuietly() {
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        if !window.isVisible { window.okFitToScreen() }
        window.orderFront(nil)
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    func go(typed: String) {
        guard let url = BrowserSteps.addressURL(typed) else { return }
        load(url)
        if model.recording { record(BrowserSteps.navigate(url.absoluteString, delay: sinceLastStep())) }
    }

    private func urlChanged(_ url: URL?) {
        model.address = url?.absoluteString ?? ""
        let site = BrowserSteps.host(of: model.address)
        model.hasLogin = !site.isEmpty && env?.vault.logins.contains { BrowserSteps.host(of: $0.site).hasSuffix(site) || site.hasSuffix(BrowserSteps.host(of: $0.site)) } == true
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
        return BrowserSnapshot(url: raw?["url"] as? String ?? webView.url?.absoluteString ?? "",
                               title: raw?["title"] as? String ?? webView.title ?? "",
                               elements: raw?["elements"] as? String ?? "",
                               text: raw?["text"] as? String ?? "",
                               count: raw?["count"] as? Int ?? 0,
                               downloads: downloads)
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

    /// Waits for the page to load and stop changing, up to `limit` seconds.
    func settle(limit: Double = 8) async {
        let deadline = Date().addingTimeInterval(limit)
        while webView.isLoading, Date() < deadline { try? await Task.sleep(nanoseconds: 60_000_000) }
        let left = Int(max(0.3, deadline.timeIntervalSinceNow) * 1000)
        _ = await call("return window.__okidoki ? await window.__okidoki.settle(350, ms) : 0", ["ms": left])
    }

    /// Navigates and waits for the page.
    func navigate(_ url: URL) async {
        load(url)
        try? await Task.sleep(nanoseconds: 150_000_000)
        await settle()
    }

    func goBack() async {
        guard webView.canGoBack else { return }
        webView.goBack()
        try? await Task.sleep(nanoseconds: 150_000_000)
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
        guard let image = try? await webView.takeSnapshot(configuration: config),
              let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])
    }

    // MARK: - Agent and replay presence

    /// Shows a line in the toolbar while the agent or a replay has the page; esc hands it back.
    func beginWork(_ line: String) {
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A page loaded mid-recording keeps recording.
        if model.recording { Task { _ = await call("return window.__okidoki?.record(true)") } }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // One page: links that want a new window open here instead.
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
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
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        Task { @MainActor in
            let name = download.progress.fileURL?.lastPathComponent ?? "a file"
            finishedDownloads.append(name)
            env?.vault.rescan()
            env?.toast(title: "saved to your vault", detail: "Downloads/\(name)", kind: .success,
                       undoLabel: nil, onUndo: nil, editLabel: "vault", onEdit: { [weak self] in self?.env?.openDashboard(.vault) },
                       runID: nil)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        Task { @MainActor in
            env?.toast(title: "download failed", detail: error.localizedDescription, kind: .warning,
                       undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }

    // MARK: - Window

    func windowWillClose(_ notification: Notification) {
        if model.recording { env?.stopBrowserRecording() }
        if model.status != nil { onEscape?() }
        if env?.dashboardOpen != true, env?.onboardingOpen != true {
            NSApp.setActivationPolicy(.accessory)
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
    weak var controller: BrowserWindowController?
    @Environment(\.colorScheme) private var scheme
    @FocusState private var addressFocused: Bool
    @State private var typed = ""

    var body: some View {
        let theme = OKTheme(scheme)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                // Room for the traffic lights.
                Color.clear.frame(width: 64, height: 1)
                OKIconButton(glyph: "chevron.left", help: "Back") { webView.goBack() }
                    .disabled(!model.canGoBack).opacity(model.canGoBack ? 1 : 0.4)
                OKIconButton(glyph: "chevron.right", help: "Forward") { webView.goForward() }
                    .disabled(!model.canGoForward).opacity(model.canGoForward ? 1 : 0.4)
                OKIconButton(glyph: model.loading ? "xmark" : "arrow.clockwise", help: model.loading ? "Stop" : "Reload") {
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
                if model.loading {
                    GeometryReader { geo in
                        Rectangle().fill(OKBrand.green).frame(width: geo.size.width * model.progress, height: 2)
                    }
                    .frame(height: 2)
                }
            }
        }
        .onChange(of: model.address) { _, value in if !addressFocused { typed = value } }
        .animation(OKMotion.quick, value: model.status)
    }
}

private struct BrowserWebView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

extension BrowserWindowController {
    fileprivate func env_startRecording() { env?.startBrowserRecording() }
    fileprivate func env_stopRecording() { env?.stopBrowserRecording() }
}
