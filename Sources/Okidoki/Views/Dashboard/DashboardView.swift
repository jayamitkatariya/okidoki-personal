import SwiftUI
import WebKit
import AppKit
import Combine
import OkidokiCore

struct DashboardView: View {
    @EnvironmentObject private var env: AppEnvironment

    // No store observation or preferred scheme here: the web view must keep a stable identity
    // (it is never rebuilt on a theme flip), and the controller already pushes state on change.
    var body: some View {
        WebDashboardView(environment: env)
            .frame(minWidth: 900, minHeight: 600)
            .background(Color(nsColor: .okDashboardBackground))
    }
}

struct WebDashboardView: NSViewRepresentable {
    let environment: AppEnvironment

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.makeWebView()
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // State is pushed (debounced) by the coordinator's subscriptions.
    }

    func makeCoordinator() -> WebDashboardController {
        WebDashboardController(environment: environment)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: WebDashboardController) {
        // The user content controller retains its handler; break the cycle.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "okidoki")
    }
}

// MARK: - Payload

struct DashboardToolPayload: Encodable {
    var id: String
    var name: String
    var command: String
    var replaces: String
    var blurb: String
    var installed: Bool
    var installCommand: String
    var docs: String
    var license: String
    var category: String
    var examples: [String]
    var popularity: Int
}

struct DashboardWatchPayload: Encodable {
    var recording: Bool
    var startedAt: Date?
    var name: String
    var steps: [SkillStep]
    var replaying: Bool
}

struct DashboardMemorySourcePayload: Encodable {
    var id: String
    var name: String
    var blurb: String
    /// Memory files found on this Mac. Empty for hosted assistants, which need a saved export.
    var files: [String]
}

struct DashboardPayload: Encodable {
    var watching: DashboardWatchPayload
    var accounts: [Account]
    var currentAccountID: String
    var settings: AppSettings
    var runs: [AgentRun]
    var threads: [ChatThread]
    var memories: [MemoryItem]
    /// Other assistants whose memory can be brought in, with the files each keeps on this Mac.
    var memorySources: [DashboardMemorySourcePayload]
    var skills: [Skill]
    var routines: [Routine]
    var connectors: [Connector]
    var tools: [DashboardToolPayload]
    var installedAgents: [String]
    /// Each coding agent with whether it's installed and signed in, for the Settings "Agents" section.
    var agents: [AgentStatus]
    var keys: [String: Bool]
    var permissions: [String: String]
    var signedOut: Bool
    var inCall: Bool
    var onboardingOpen: Bool
    var dashboardOpen: Bool
    var sidecar: String
    var version: String
    var savings: Double
    var convexConfigured: Bool
    var mcpStatus: [String: MCPServerStatus]
    /// Names (never values) of each MCP server's stored secrets, so the page can show what's set.
    var mcpSecretNames: [String: [String]]
    /// The current or last driving run, step by step, for the Live page.
    var live: DashboardLivePayload?
    /// okidoki's private Mac: whether this Mac can run one, and where setup or the VM is right now.
    var privateMac: DashboardPrivateMacPayload
    /// Enterprise: this Mac as a worker for its spaces.
    var worker: DashboardWorkerPayload
}

struct DashboardWorkerPayload: Encodable {
    var status: String
    var activeJob: String?
    var activeSpace: String?
    var lastPollAt: Date?
    var jobsDone: Int
    var device: String
}

struct DashboardPrivateMacPayload: Encodable {
    var supported: Bool
    var phase: String
    var progress: Double
    var status: String
    var error: String?
    var needsFirstBoot: Bool
    var macOSVersion: String
    var cpuCount: Int
    var memoryGB: Int
    var bytesOnDisk: Int64
    var downloadGB: Int
}

// MARK: - Controller

@MainActor
final class WebDashboardController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private weak var env: AppEnvironment?
    private var webView: WKWebView?
    private var cancellables = Set<AnyCancellable>()
    private var pushWork: DispatchWorkItem?
    private var didLoad = false
    private var pendingAsk = false

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
        let store = environment.store
        if true {
            store.objectWillChange
                .receive(on: RunLoop.main)
                .sink { [weak self] _ in self?.schedulePush() }
                .store(in: &cancellables)
        }
        environment.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
        environment.sidecar.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
        // Live step list while a skill is being recorded.
        environment.watch.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
        // Driving steps for the Live page.
        environment.driver.model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
        environment.$askPulse
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                // On first open the page may still be loading; replay once it says it's ready.
                guard self.didLoad else { self.pendingAsk = true; return }
                self.webView?.evaluateJavaScript("window.okidokiOpenAsk && window.okidokiOpenAsk();", completionHandler: nil)
            }
            .store(in: &cancellables)
        environment.$dashboardRoute
            .receive(on: RunLoop.main)
            .sink { [weak self] route in
                self?.webView?.evaluateJavaScript("window.okidokiNavigate && window.okidokiNavigate('\(route.rawValue)');", completionHandler: nil)
            }
            .store(in: &cancellables)
        environment.$dashboardRunID
            .receive(on: RunLoop.main)
            .compactMap { $0 }
            .sink { [weak self] id in
                self?.focusRun(id)
            }
            .store(in: &cancellables)
        // Permissions are granted in System Settings; refresh their labels when the user comes back.
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.schedulePush() }
            .store(in: &cancellables)
    }

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Seed the first render with real state and the right theme; otherwise the page paints
        // demo data in the light theme until the first native push lands.
        let initialState = payloadJSON() ?? "null"
        let bootstrap = """
        (function() {
          window.__okidokiState = \(initialState);
          try {
            var appearance = window.__okidokiState && window.__okidokiState.settings && window.__okidokiState.settings.appearance;
            var theme = appearance === 'dark' || appearance === 'light' ? appearance
              : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.colorScheme = theme;
          } catch (e) {}
          window.okidokiInvoke = function(type, payload) {
            try { window.webkit.messageHandlers.okidoki.postMessage({ type: type, payload: payload || {} }); } catch (e) {}
          };
          window.okidokiNative = function(payload) {
            window.__okidokiState = payload;
            window.dispatchEvent(new CustomEvent('okidoki-native', { detail: payload }));
          };
          window.okidoki = {
            ask: function(text) { window.okidokiInvoke('ask', { text: text }); },
            openOnboarding: function() { window.okidokiInvoke('openOnboarding', {}); },
            invoke: window.okidokiInvoke
          };
        })();
        """
        let script = WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(script)
        config.userContentController.add(self, name: "okidoki")
        config.setURLSchemeHandler(LiveFrameSchemeHandler(), forURLScheme: LiveFrames.scheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isInspectable = true
        self.webView = webView
        load(into: webView)
        return webView
    }

    private func load(into webView: WKWebView) {
        if let dev = ProcessInfo.processInfo.environment["OKIDOKI_WEB_DEV_URL"], let url = URL(string: dev) {
            webView.load(URLRequest(url: url))
            return
        }
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        }
        // Running bare (`swift run`) there's no bundle; use the repo build if it exists.
        let repoBuild = URL(fileURLWithPath: "web/dist/index.html")
        if FileManager.default.fileExists(atPath: repoBuild.path) {
            webView.loadFileURL(repoBuild, allowingReadAccessTo: repoBuild.deletingLastPathComponent())
            return
        }
        let fallback = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        @font-face{font-family:PP;src:url('fonts/PPNeueBit-Bold.otf')}
        body{margin:0;background:#F4F0E8;color:#141311;font-family:-apple-system,Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
        .card{max-width:560px;padding:40px;border:1px solid #ddd6c9;border-radius:18px;background:#fffdf9;box-shadow:0 24px 60px -30px rgba(0,0,0,.25)}
        h1{font-family:PP,serif;font-size:54px;margin:0 0 10px;font-weight:normal;letter-spacing:-1px}
        p{color:#6e685e;line-height:1.6;font-size:14px} code{background:#f2ede4;padding:2px 6px;border-radius:4px;font-size:12px}
        .dot{width:8px;height:8px;border-radius:50%;background:#1FB57A;display:inline-block;margin-right:8px}
        </style></head><body><div class="card"><div><span class="dot"></span><span style="font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#948d81">control panel</span></div>
        <h1>the dashboard is still developing.</h1>
        <p>The React control panel hasn't been built into this app bundle yet. In the project folder run <code>cd web && bun install && bun run build</code>, then rebuild the app with <code>make app</code>. The native body — notch, shake, the cursor companion and voice — is already running.</p></div></body></html>
        """
        webView.loadHTMLString(fallback, baseURL: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didLoad = true
        sendState()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Without this the dashboard stays blank until the app is relaunched.
        didLoad = false
        load(into: webView)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated,
           let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "okidoki",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        Task { @MainActor in
            self.handle(type: type, payload: payload)
        }
    }

    private func sendNavigation() {
        guard let webView, let env else { return }
        webView.evaluateJavaScript("window.okidokiNavigate && window.okidokiNavigate('\(env.dashboardRoute.rawValue)');", completionHandler: nil)
        if let id = env.dashboardRunID { focusRun(id) }
    }

    private func focusRun(_ id: String) {
        guard let webView else { return }
        let escaped = id.replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("""
        (function(){
          window.__okidokiFocusRun = '\(escaped)';
          window.okidokiNavigate && window.okidokiNavigate('runs');
          window.dispatchEvent(new CustomEvent('okidoki-focus-run', { detail: '\(escaped)' }));
        })();
        """, completionHandler: nil)
    }

    private func schedulePush() {
        // Throttle: continuous terminal output must still reach the dashboard every 180 ms.
        guard pushWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.pushWork = nil
            self?.sendState()
        }
        pushWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }

    func sendState() {
        guard let webView, didLoad, let json = payloadJSON() else { return }
        webView.evaluateJavaScript("window.okidokiNative(\(json));", completionHandler: nil)
    }

    private var memorySourcesCache: (at: Date, sources: [DashboardMemorySourcePayload])?

    /// State is pushed often; the other assistants' folders are only re-scanned now and then.
    private func memorySources() -> [DashboardMemorySourcePayload] {
        if let cached = memorySourcesCache, Date().timeIntervalSince(cached.at) < 30 { return cached.sources }
        let sources = MemoryImport.sources.map { source in
            DashboardMemorySourcePayload(id: source.id, name: source.name, blurb: source.blurb,
                                         files: source.isLocal ? MemoryImport.files(for: source) : [])
        }
        memorySourcesCache = (Date(), sources)
        return sources
    }

    private func payloadJSON() -> String? {
        guard let env else { return nil }
        let payload = DashboardPayload(
            watching: DashboardWatchPayload(recording: env.watch.isRecording,
                                            startedAt: env.watch.startedAt,
                                            name: env.watch.pendingName,
                                            steps: env.watch.isRecording ? env.watch.steps.map(\.step) : [],
                                            replaying: env.replayer.isActive),
            accounts: env.store.accounts,
            currentAccountID: env.store.currentAccountID,
            settings: env.store.settings,
            runs: env.store.activeRuns.sorted { $0.createdAt > $1.createdAt },
            threads: env.store.activeThreads,
            memories: env.store.memories,
            memorySources: memorySources(),
            skills: env.store.activeSkills,
            routines: env.store.activeRoutines,
            connectors: env.store.connectors,
            tools: ToolCatalog.tools.map { tool in
                DashboardToolPayload(id: tool.id, name: tool.name, command: tool.command,
                                     replaces: tool.replaces, blurb: tool.blurb,
                                     installed: env.store.toolInstalled[tool.id] == true,
                                     installCommand: tool.installCommand, docs: tool.docs,
                                     license: tool.license, category: tool.category,
                                     examples: tool.examples, popularity: tool.popularity)
            },
            installedAgents: env.installedAgents.map(\.rawValue),
            agents: env.agentStatus,
            keys: Dictionary(uniqueKeysWithValues: KeyProviders.all.map { ($0.id, env.hasKey($0.id)) }),
            permissions: Dictionary(uniqueKeysWithValues: PermissionKind.allCases.map { ($0.rawValue, PermissionsService.shared.state($0).label) }),
            signedOut: env.signedOut,
            inCall: env.inCall,
            onboardingOpen: env.onboardingOpen,
            dashboardOpen: env.dashboardOpen,
            sidecar: env.sidecar.status.label,
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.9.1",
            savings: env.store.savings,
            convexConfigured: env.store.settings.syncEnabled && !env.store.settings.convexSiteURL.isEmpty,
            mcpStatus: env.mcpStatus,
            mcpSecretNames: Dictionary(env.store.settings.mcpServers.map { server in
                let secrets = env.mcpSecrets(server)
                return (server.id, (secrets.env.keys.map { $0 } + secrets.headers.keys.map { $0 }).sorted())
            }, uniquingKeysWith: { first, _ in first }),
            live: env.driver.model.runID == nil ? nil : DashboardLivePayload(
                active: env.driver.isActive,
                runID: env.driver.model.runID,
                target: env.driver.model.targetName,
                goal: env.driver.model.goal,
                stepIndex: env.driver.model.stepIndex,
                steps: env.driver.model.steps),
            privateMac: DashboardPrivateMacPayload(
                supported: PrivateMacService.isSupported,
                phase: env.privateMac.phase.rawValue,
                progress: env.privateMac.progress,
                status: env.privateMac.statusLine,
                error: env.privateMac.error,
                needsFirstBoot: env.privateMac.needsFirstBoot,
                macOSVersion: env.privateMac.macOSVersion,
                cpuCount: env.privateMac.cpuCount,
                memoryGB: Int(env.privateMac.memoryBytes / (1024 * 1024 * 1024)),
                bytesOnDisk: env.privateMac.isSetUp || env.privateMac.restoreImageDownloaded ? PrivateMacSpec.bytesOnDisk() : 0,
                downloadGB: Int(PrivateMacSpec.approximateDownloadBytes / 1_000_000_000)),
            worker: DashboardWorkerPayload(
                status: env.worker.status,
                activeJob: env.worker.activeJob?.prompt,
                activeSpace: env.worker.activeJob?.spaceName,
                lastPollAt: env.worker.lastPollAt,
                jobsDone: env.worker.jobsDone,
                device: Host.current().localizedName ?? "mac")
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(payload),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    // MARK: - Bridge actions

    private func handle(type: String, payload: [String: Any]) {
        guard let env else { return }
        switch type {
        case "ready", "getState":
            // The page's listeners are live once it says so — usually before didFinish fires.
            didLoad = true
            sendState()
            sendNavigation()
            if pendingAsk {
                pendingAsk = false
                webView?.evaluateJavaScript("window.okidokiOpenAsk && window.okidokiOpenAsk();", completionHandler: nil)
            }
        case "ask":
            if let text = payload["text"] as? String { env.askFromDashboard(text) }
        case "continueThread":
            if let id = payload["id"] as? String, let text = payload["text"] as? String {
                env.continueThread(id, text: text)
            }
        case "archiveThread":
            if let id = payload["id"] as? String { env.store.archiveThread(id); env.store.saveNow() }
        case "deleteThread":
            if let id = payload["id"] as? String { env.store.deleteThread(id); env.store.saveNow() }
        case "updateAccount":
            if let name = payload["name"] as? String {
                var account = env.store.activeAccount
                account.name = name
                if let email = payload["email"] as? String { account.email = email }
                if let kind = payload["kind"] as? String, let value = AccountKind(rawValue: kind) { account.kind = value }
                env.store.updateAccount(account)
                env.store.saveNow()
            }
        case "deleteAccount":
            if let id = payload["id"] as? String, env.store.accounts.count > 1 {
                env.store.deleteAccount(id)
                env.store.saveNow()
                // The Mac forgot it; Convex should too.
                Task { await env.convex.purge(accountID: id, store: env.store) }
            }
        case "previewVoice":
            if let voice = payload["voice"] as? String {
                env.speaker.speak("hey, i'm okidoki. this is what i sound like.", voiceID: voice,
                                  speed: env.store.settings.voiceSpeed)
            }
        case "summon":
            env.startSummon()
        case "openOnboarding":
            env.openOnboarding()
        case "openDashboard":
            if let raw = payload["section"] as? String, let section = DashboardSection(rawValue: raw) {
                env.openDashboard(section)
            }
        case "approveRun":
            if let id = payload["id"] as? String { env.approveRun(id) }
        case "allowAlways":
            if let id = payload["id"] as? String { env.allowAlways(id) }
        case "denyRun":
            if let id = payload["id"] as? String { env.denyRun(id) }
        case "stopRun":
            if let id = payload["id"] as? String { env.stopRun(id) }
        case "pauseRun":
            if let id = payload["id"] as? String { env.pauseRun(id) }
        case "redirectRun":
            if let id = payload["id"] as? String, let text = payload["text"] as? String {
                env.redirectRun(id, instruction: text)
            }
        case "replaySkill":
            if let id = payload["id"] as? String, let skill = env.store.skill(id) {
                env.replaySkill(skill, times: payload["times"] as? Int ?? 1)
            }
        case "startWatching":
            env.startTeaching(name: payload["name"] as? String ?? "")
        case "stopWatching":
            env.stopWatching()
        case "discardWatching":
            env.discardWatching()
        case "renameSkill":
            if let id = payload["id"] as? String {
                env.store.updateSkill(id, name: payload["name"] as? String, summary: payload["summary"] as? String)
                env.store.saveNow()
            }
        case "startSkill":
            if let id = payload["id"] as? String, let skill = env.store.skill(id) { env.startSkillWalkthrough(skill) }
        case "runRoutine":
            if let id = payload["id"] as? String, let routine = env.store.routine(id) { env.runRoutine(routine) }
        case "toggleRoutine":
            if let id = payload["id"] as? String { env.store.toggleRoutine(id); env.store.saveNow() }
        case "deleteRoutine":
            if let id = payload["id"] as? String { env.store.deleteRoutine(id); env.store.saveNow() }
        case "deleteSkill":
            if let id = payload["id"] as? String { env.store.deleteSkill(id); env.store.saveNow() }
        case "addRoutine":
            let name = payload["name"] as? String ?? "routine"
            let prompt = payload["prompt"] as? String ?? ""
            let cadence = RoutineCadence(rawValue: payload["cadence"] as? String ?? "weekly") ?? .weekly
            let weekday = payload["weekday"] as? Int ?? 6
            let hour = payload["hour"] as? Int ?? 17
            let minute = payload["minute"] as? Int ?? 0
            env.store.createRoutine(name: name, prompt: prompt, cadence: cadence,
                                    weekday: weekday, hour: hour, minute: minute)
            env.store.saveNow()
        case "updateRoutine":
            if let id = payload["id"] as? String, let routine = env.store.routine(id) {
                var updated = routine
                if let name = payload["name"] as? String { updated.name = name }
                if let prompt = payload["prompt"] as? String { updated.prompt = prompt }
                if let cadence = payload["cadence"] as? String, let value = RoutineCadence(rawValue: cadence) { updated.cadence = value }
                if let weekday = payload["weekday"] as? Int { updated.weekday = weekday }
                if let hour = payload["hour"] as? Int { updated.hour = hour }
                if let minute = payload["minute"] as? Int { updated.minute = minute }
                if let enabled = payload["enabled"] as? Bool { updated.enabled = enabled }
                env.store.updateRoutine(updated)
                env.store.saveNow()
            }
        case "addMemory":
            if let text = payload["text"] as? String {
                let section = MemorySection(rawValue: payload["section"] as? String ?? "aboutYou") ?? .aboutYou
                env.store.addMemory(text, section: section)
                env.store.saveNow()
            }
        case "updateMemory":
            if let id = payload["id"] as? String, let text = payload["text"] as? String {
                env.store.updateMemory(id, text: text)
                env.store.saveNow()
            }
        case "deleteMemory":
            if let id = payload["id"] as? String { env.store.deleteMemory(id); env.store.saveNow() }
        case "updateSettings":
            // Dates go to the page as ISO 8601 (see payloadJSON), so they come back that way.
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            if let patch = payload["patch"] as? [String: Any] {
                // Overlay only the keys the page changed, so native-side edits made meanwhile survive.
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                guard let currentData = try? encoder.encode(env.store.settings),
                      var merged = (try? JSONSerialization.jsonObject(with: currentData)) as? [String: Any] else { break }
                for (key, value) in patch { merged[key] = value }
                if let data = try? JSONSerialization.data(withJSONObject: merged),
                   let settings = try? decoder.decode(AppSettings.self, from: data) {
                    env.store.settings = settings
                    env.store.saveNow()
                    env.refreshSync()
                }
            } else if let settingsPayload = payload["settings"] as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: settingsPayload),
               let settings = try? decoder.decode(AppSettings.self, from: data) {
                env.store.settings = settings
                env.store.saveNow()
                env.refreshSync()
            }
        case "saveKey":
            if let provider = payload["provider"] as? String, let value = payload["value"] as? String {
                env.saveKey(provider: provider, value: value)
            }
        case "deleteKey":
            if let provider = payload["provider"] as? String { env.deleteKey(provider: provider) }
        case "installTool":
            if let id = payload["id"] as? String, let tool = ToolCatalog.tool(id: id) { env.installTool(tool) }
        case "connectApple":
            if let id = payload["id"] as? String {
                Task { _ = await env.connectApple(id); sendState() }
            }
        case "disconnectApple":
            if let id = payload["id"] as? String { env.disconnectApple(id) }
        case "setConnector":
            // Non-Apple connectors (Apify, MCP) have no permission probe; just record the switch.
            if let id = payload["id"] as? String, let enabled = payload["enabled"] as? Bool {
                env.store.setConnector(id, enabled: enabled)
                env.store.saveNow()
            }
        case "saveMcpServer":
            if let raw = payload["server"] as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: raw),
               let server = try? JSONDecoder().decode(MCPServer.self, from: data) {
                // Secrets arrive only when the page changed them; otherwise the saved copy stays.
                var secrets: (env: [String: String], headers: [String: String])?
                if let given = payload["secrets"] as? [String: Any] {
                    secrets = (given["env"] as? [String: String] ?? [:], given["headers"] as? [String: String] ?? [:])
                }
                env.saveMCPServer(server, secrets: secrets)
            }
        case "deleteMcpServer":
            if let id = payload["id"] as? String { env.deleteMCPServer(id) }
        case "refreshMcp":
            env.refreshMCP(reconnect: true)
        case "requestPermission":
            if let raw = payload["kind"] as? String, let kind = PermissionKind(rawValue: raw) {
                Task {
                    if kind == .automation {
                        _ = await env.connectApple("calendar")
                    } else {
                        _ = await PermissionsService.shared.request(kind)
                    }
                    sendState()
                }
            }
        case "openPermissionSettings":
            if let raw = payload["kind"] as? String, let kind = PermissionKind(rawValue: raw) {
                PermissionsService.shared.openSettings(kind)
            }
        case "privateMac":
            switch payload["action"] as? String {
            case "setUp": env.privateMac.setUp()
            case "cancelSetup": env.privateMac.cancelSetup()
            case "start": Task { await env.privateMac.start(showWindow: true) }
            case "stop": Task { await env.privateMac.stop() }
            case "show": env.privateMac.show()
            case "hide": env.privateMac.hide()
            case "firstBootDone": env.privateMac.markFirstBootDone()
            case "delete":
                Task {
                    await env.privateMac.delete()
                    if env.store.settings.computerTarget == "vm" {
                        env.store.settings.computerTarget = "mac"
                        env.store.saveNow()
                    }
                }
            default: break
            }
        case "createAccount":
            let name = payload["name"] as? String ?? "you"
            let email = payload["email"] as? String ?? ""
            let kind = AccountKind(rawValue: payload["kind"] as? String ?? "personal") ?? .personal
            env.createAccountAndSignIn(name: name, email: email, kind: kind)
        case "switchAccount":
            if let id = payload["id"] as? String { env.signIn(accountID: id) }
        case "signOut":
            env.signOut()
        case "signIn":
            if let id = payload["id"] as? String { env.signIn(accountID: id) }
        case "refreshTools":
            env.refreshInstalled()
        case "syncNow":
            env.refreshSync()
        case "shareRun":
            if let id = payload["id"] as? String { env.shareRun(id) }
        case "openExternal":
            if let value = payload["url"] as? String, let url = URL(string: value) {
                NSWorkspace.shared.open(url)
            }
        case "openDataFolder":
            let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Okidoki")
            NSWorkspace.shared.open(url)
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}
