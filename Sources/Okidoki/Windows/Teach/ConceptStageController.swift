import AppKit
import SwiftUI
import WebKit
import OkidokiCore

// MARK: - Model

@MainActor
final class ConceptModel: ObservableObject {
    enum Phase: Equatable { case building, playing, thinking, done, failed }
    @Published var title = ""
    @Published var phase: Phase = .building
    @Published var caption = ""
    @Published var beat = 0
    @Published var beatCount = 0
    @Published var hoverPart = ""
    @Published var photo: ConceptPhoto?
    @Published var showPhoto = true
    @Published var voice = true
    @Published var speed: Double = 1
    @Published var error = ""
    var runID: String?
    var threadID: String?
}

// MARK: - Panels

final class ConceptPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The strip you grab to move the stage; the web view below it orbits instead.
final class ConceptDragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { bounds.contains(point) ? self : nil }
}

/// Dragging the model orbits it, so the web view never moves the panel; the strip above does.
final class ConceptWebView: WKWebView {
    override var mouseDownCanMoveWindow: Bool { false }
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) { menu.removeAllItems() }
}

// MARK: - Controller

/// A narrated 2D/3D lesson on a floating stage beside what the learner is looking at. The model
/// writes a scene and beats; the web runtime (Resources/stage) animates them; this controller
/// narrates, captions, circles things on the real screen, and turns part clicks into follow-ups.
/// It plays itself through: the only navigation is clicking a beat dot. Esc or a shake closes it.
@MainActor
final class ConceptStageController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let model = ConceptModel()
    private weak var env: AppEnvironment?
    private var panel: ConceptPanel?
    private var webView: ConceptWebView?
    private var pointPanel: TeachPanel?
    private var pointStage: TeachStageView?
    private var screen: NSScreen?
    private var lesson: ConceptLesson?
    private var topic = ""
    private var beats: [ConceptBeat] = []
    private var sceneSummary = ""
    private var stageReady = false
    private var pendingLoad: String?
    private var generation = 0
    private var escMonitors: [Any] = []
    private var spaceObservers: [NSObjectProtocol] = []
    private var beatDoneContinuation: CheckedContinuation<Void, Never>?
    private var saidSoFar: [String] = []
    private var introSpoken = false

    init(environment: AppEnvironment) {
        self.env = environment
        super.init()
    }

    var isActive: Bool { panel?.isVisible == true }

    // MARK: Begin

    /// Show the stage right away (building…), then stream the lesson: the title and intro are
    /// spoken as soon as the model has written them, while the scene keeps coming.
    func begin(topic: String, requestText: String, appBundleID: String, screenshotPNG: Data?, runID: String?, threadID: String?) {
        guard let env else { return }
        let front = prepare(topic: topic, appBundleID: appBundleID, runID: runID, threadID: threadID)
        let gen = generation
        let screen = self.screen ?? NSScreen.okidokiPrimary

        Task { [weak self] in
            guard let self else { return }
            // Context: page title/url from the browser, plus a screenshot sized for the model.
            async let page = BrowserContext.current(app: front)
            var base64: String?
            var width = 0.0
            var height = 0.0
            if let shot = await ComputerUseService.shared.capture(screen: screen) {
                let fit = ImageFit.tier(for: env.store.settings.claudeModel)
                let prepared = await Task.detached(priority: .userInitiated) { () -> (String, Double, Double)? in
                    let size = fit.resized(width: shot.full.width, height: shot.full.height, longEdgeCap: 1200)
                    guard let scaled = TeachImage.scaled(shot.full, to: size), let png = TeachImage.png(scaled) else { return nil }
                    return (png.base64EncodedString(), Double(size.width), Double(size.height))
                }.value
                if let prepared { base64 = prepared.0; width = prepared.1; height = prepared.2 }
            } else if let screenshotPNG {
                base64 = screenshotPNG.base64EncodedString()
            }
            let pageInfo = await page
            guard gen == self.generation else { return }
            let context = [requestText, pageInfo?.title ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
            let stream = await env.teachConceptStream(topic: topic, context: context, pageTitle: pageInfo?.title, pageURL: pageInfo?.url,
                                                      screenshotBase64: base64, imageWidth: width, imageHeight: height)
            guard gen == self.generation else { return }
            for await event in stream {
                guard gen == self.generation else { return }
                switch event {
                case .intro(let title, let intro):
                    if !title.isEmpty { self.model.title = title }
                    if !intro.isEmpty {
                        self.model.caption = intro
                        self.introSpoken = true
                        self.speak(intro)
                    }
                case .lesson(let lesson):
                    self.load(lesson)
                case .error(let message):
                    self.fail(message)
                }
            }
        }
    }

    /// Everything `begin` and the lab share: state, placement, panels, keys, the stage watchdog.
    @discardableResult
    private func prepare(topic: String, appBundleID: String, runID: String?, threadID: String?) -> NSRunningApplication? {
        guard let env else { return nil }
        if isActive { dismiss(completed: false, quiet: true) }
        self.topic = topic
        generation += 1
        let gen = generation
        model.title = topic
        model.phase = .building
        model.caption = "drawing it out…"
        model.beat = 0
        model.beatCount = 0
        model.photo = nil
        model.error = ""
        model.runID = runID
        model.threadID = threadID
        model.voice = env.store.settings.teachVoice
        saidSoFar = []
        beats = []
        lesson = nil
        stageReady = false
        pendingLoad = nil
        introSpoken = false

        let front = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == appBundleID && !appBundleID.isEmpty }
            ?? NSWorkspace.shared.frontmostApplication
        let screen = screenFor(app: front)
        self.screen = screen
        let windowRect = front.flatMap { TeachGeometry.frontWindowGlobal(pid: $0.processIdentifier) }
        buildPanels(on: screen, beside: windowRect)
        installKeys()

        // A stage that never says ready (missing files, a broken build) must not sit on "drawing…" forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, gen == self.generation, !self.stageReady, self.model.phase == .building else { return }
            self.fail("the stage didn't start — try again, or reinstall okidoki")
        }
        return front
    }

    private func fail(_ message: String) {
        env?.speaker.stop()
        model.phase = .failed
        model.error = message
        model.caption = "couldn't draw this one — \(message)"
    }

    private func load(_ lesson: ConceptLesson) {
        self.lesson = lesson
        beats = lesson.beats
        model.title = lesson.title
        model.beatCount = beats.count
        model.photo = lesson.photo
        model.showPhoto = lesson.photo != nil
        sceneSummary = "parts: " + lesson.parts.joined(separator: "; ")
        let script = "window.okidokiStage.load(\(lesson.sceneJSON));"
        if stageReady {
            webView?.evaluateJavaScript(script) { [weak self] _, _ in
                Task { @MainActor in self?.startPlaying() }
            }
        } else {
            pendingLoad = script
        }
    }

    private func startPlaying() {
        guard let lesson else { return }
        model.phase = .playing
        let gen = generation
        Task { [weak self] in
            guard let self else { return }
            if self.introSpoken {
                // Already talking from the stream; let the sentence land, then go.
                self.model.caption = lesson.intro.isEmpty ? self.model.caption : lesson.intro
                await self.waitForSpeech(minimum: 0.4)
            } else if !lesson.intro.isEmpty {
                self.model.caption = lesson.intro
                self.speak(lesson.intro)
                await self.waitForSpeech(minimum: 1.2)
            }
            guard gen == self.generation else { return }
            await self.play(from: 0)
        }
    }

    // MARK: Playback

    private func play(from index: Int) async {
        let gen = generation
        var i = index
        while i < beats.count {
            guard gen == generation, model.phase == .playing else { return }
            let beat = beats[i]
            model.beat = i
            model.caption = beat.caption ?? beat.say
            saidSoFar.append(beat.say)
            speak(beat.say)
            flash(beat.points)
            await runBeat(i)
            await waitForSpeech(minimum: beat.duration ?? 1.4)
            guard gen == generation, model.phase == .playing, model.beat == i else { return }
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard gen == generation, model.phase == .playing, model.beat == i else { return }
            i += 1
        }
        guard gen == generation, model.phase == .playing else { return }
        finishLesson()
    }

    /// Ask the stage to play a beat; resolves on its beatDone (or a timeout).
    private func runBeat(_ index: Int) async {
        guard let webView else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            beatDoneContinuation?.resume()
            beatDoneContinuation = continuation
            // play() returns a Promise, which WebKit can't hand back; `void` keeps the call from
            // reporting an error and resolving the beat before it has run.
            webView.evaluateJavaScript("void window.okidokiStage.play(\(index));") { _, error in
                if error != nil {
                    Task { @MainActor in self.resolveBeat() }
                }
            }
            // A beat that never reports back shouldn't hang the lesson; only this beat's timer may resolve it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                guard let self, self.model.beat == index else { return }
                self.resolveBeat()
            }
        }
    }

    private func resolveBeat() {
        beatDoneContinuation?.resume()
        beatDoneContinuation = nil
    }

    private func waitForSpeech(minimum: Double) async {
        var elapsed = 0.0
        while true {
            try? await Task.sleep(nanoseconds: 100_000_000)
            elapsed += 0.1
            let speaking = model.voice && (env?.speaker.isSpeaking ?? false)
            if elapsed >= minimum / model.speed, !speaking { return }
            if elapsed > 30 { return }
        }
    }

    private func speak(_ text: String) {
        guard let env, model.voice, !text.isEmpty, !env.store.settings.quietMode else { return }
        env.speaker.speak(text, voiceID: env.store.settings.voiceID, speed: env.store.settings.voiceSpeed * model.speed)
    }

    private func flash(_ points: [[Double]]) {
        guard let screen, let pointStage, !points.isEmpty else { return }
        let local = points.compactMap { p -> CGPoint? in
            guard p.count >= 2 else { return nil }
            return CGPoint(x: CGFloat(p[0]) * screen.frame.width, y: CGFloat(p[1]) * screen.frame.height)
        }
        pointPanel?.orderFrontRegardless()
        pointStage.flashPoints(local)
    }

    // MARK: Controls

    /// Click a beat dot: rebuild up to there and play from it.
    func goTo(beat index: Int) {
        guard model.phase == .playing || model.phase == .done, beats.indices.contains(index) else { return }
        env?.speaker.stop()
        jump(to: index, restore: true)
    }

    /// Voice "next": skip ahead one beat. On the last one, close.
    func next() {
        guard model.phase == .playing else {
            if model.phase == .done { dismiss(completed: true) }
            return
        }
        env?.speaker.stop()
        jump(to: model.beat + 1)
    }

    /// Voice "back".
    func back() {
        guard model.phase == .playing || model.phase == .done, model.beat > 0 else { return }
        env?.speaker.stop()
        jump(to: model.beat - 1, restore: true)
    }

    private func jump(to index: Int, restore: Bool = false) {
        generation += 1
        resolveBeat()
        model.phase = .playing
        let target = max(0, min(beats.count, index))
        if target >= beats.count { finishLesson(); return }
        let gen = generation
        Task { [weak self] in
            guard let self else { return }
            if restore, let webView = self.webView {
                _ = try? await webView.evaluateJavaScript("window.okidokiStage.restoreTo(\(target));")
            }
            guard gen == self.generation else { return }
            await self.play(from: target)
        }
    }

    func toggleVoice() {
        guard let env else { return }
        model.voice.toggle()
        env.store.settings.teachVoice = model.voice
        env.store.saveNow()
        if !model.voice { env.speaker.stop() }
    }

    func setSpeed(_ speed: Double) {
        model.speed = speed
        webView?.evaluateJavaScript("window.okidokiStage.setSpeed(\(speed));")
    }

    func resetView() {
        webView?.evaluateJavaScript("window.okidokiStage.resetView();")
    }

    // MARK: Questions and parts

    /// A click on a part, or a spoken question: answer in place with new beats on the same model.
    func ask(_ question: String, partID: String? = nil, partName: String? = nil) {
        guard let env, lesson != nil, model.phase != .building else { return }
        generation += 1
        resolveBeat()
        env.speaker.stop()
        model.phase = .thinking
        model.caption = partName.map { "about the \($0)…" } ?? "thinking…"
        let gen = generation
        let summary = sceneSummary + "\nsaid so far: " + saidSoFar.suffix(8).joined(separator: " / ")
        Task { [weak self] in
            guard let self else { return }
            let follow = await env.teachConceptFollow(topic: self.topic, question: question, partID: partID, partName: partName, sceneSummary: summary)
            guard gen == self.generation else { return }
            guard let follow else {
                self.model.phase = .playing
                self.model.caption = "i couldn't work that out — ask again?"
                return
            }
            if let webView = self.webView {
                _ = try? await webView.evaluateJavaScript("window.okidokiStage.append(\(follow.appendJSON));")
            }
            guard gen == self.generation else { return }
            let start = self.beats.count
            self.beats.append(contentsOf: follow.beats)
            self.model.beatCount = self.beats.count
            self.model.phase = .playing
            if !follow.answer.isEmpty {
                self.model.caption = follow.answer
                self.speak(follow.answer)
                await self.waitForSpeech(minimum: 1.0)
            }
            guard gen == self.generation else { return }
            if start < self.beats.count {
                await self.play(from: start)
            } else {
                self.finishLesson()
            }
        }
    }

    var questionContext: String {
        guard isActive else { return "" }
        return "They're watching an okidoki 3D lesson on \"\(topic)\" (\(model.title)); current beat: \(model.caption). Answer briefly in that context."
    }

    // MARK: Web bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let type = payload["type"] as? String else { return }
        let safe = payload.compactMapValues { value -> Any? in
            switch value {
            case let s as String: return s
            case let n as NSNumber: return n
            default: return nil
            }
        }
        handleMessage(type: type, body: safe)
    }

    private func handleMessage(type: String, body: [String: Any]) {
        switch type {
        case "ready":
            stageReady = true
            if let accent = env?.store.settings.drawingColorHex, !accent.isEmpty {
                let hex = accent.hasPrefix("#") ? accent : "#\(accent)"
                webView?.evaluateJavaScript("window.okidokiStage.setAccent(\(Self.jsString(hex)));")
            }
            if let pending = pendingLoad {
                pendingLoad = nil
                webView?.evaluateJavaScript(pending) { [weak self] _, _ in
                    Task { @MainActor in self?.startPlaying() }
                }
            } else if model.phase == .building {
                webView?.evaluateJavaScript("window.okidokiStage.setBuilding(true);")
            }
        case "beatDone":
            if let index = body["index"] as? Int, index == model.beat { resolveBeat() }
        case "partClick":
            guard model.phase == .playing || model.phase == .done else { return }
            let id = body["id"] as? String
            let name = (body["name"] as? String) ?? id ?? "that"
            ask("tell me about the \(name)", partID: id, partName: name)
        case "partHover":
            model.hoverPart = (body["name"] as? String) ?? ""
        case "error":
            let message = (body["message"] as? String) ?? "stage error"
            model.error = message
            if model.phase == .building { fail(message) }
        default:
            break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == StageSchemeHandler.scheme ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if model.phase == .building { fail("the stage didn't load") }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if model.phase == .building { fail("the stage didn't load") }
    }

    private static func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data()
        let text = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(text.dropFirst().dropLast())
    }

    // MARK: Finish

    private func finishLesson() {
        guard model.phase != .done else { return }
        model.phase = .done
        model.caption = "that's \(model.title). click any part to ask about it."
        pointStage?.celebrate(at: CGPoint(x: (screen?.frame.width ?? 800) / 2, y: (screen?.frame.height ?? 600) * 0.42), big: true)
        if let env, let runID = model.runID {
            let recap = ([lesson?.intro ?? ""] + beats.map { "· \($0.say)" }).filter { !$0.isEmpty }.joined(separator: "\n")
            env.finishConcept(runID: runID, topic: topic, title: model.title, threadID: model.threadID, recap: recap)
        }
    }

    func dismiss(completed: Bool, quiet: Bool = false) {
        generation += 1
        resolveBeat()
        env?.speaker.stop()
        for monitor in escMonitors { NSEvent.removeMonitor(monitor) }
        escMonitors = []
        for observer in spaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer); NotificationCenter.default.removeObserver(observer) }
        spaceObservers = []
        webView?.evaluateJavaScript("window.okidokiStage && window.okidokiStage.dispose && window.okidokiStage.dispose();")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "stage")
        panel?.orderOut(nil)
        pointPanel?.orderOut(nil)
        panel = nil
        webView = nil
        pointPanel = nil
        pointStage = nil
        if let runID = model.runID, !completed, model.phase != .done {
            env?.cancelRun(runID)
        }
        model.runID = nil
        lesson = nil
    }

    // MARK: Panels

    private func screenFor(app: NSRunningApplication?) -> NSScreen {
        if let pid = app?.processIdentifier, let window = TeachGeometry.frontWindowGlobal(pid: pid) {
            let center = CGPoint(x: window.midX, y: window.midY)
            if let screen = NSScreen.screens.first(where: { TeachGeometry.quartzRect(of: $0).contains(center) }) { return screen }
        }
        return NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.okidokiPrimary
    }

    /// Beside the window when there's room (the side with more space), otherwise over its corner.
    private func placement(on screen: NSScreen, beside window: CGRect?) -> NSRect {
        let width = min(620, max(420, screen.frame.width * 0.4))
        let height = width * 0.68 + 96
        let visible = screen.visibleFrame
        let quartzScreen = TeachGeometry.quartzRect(of: screen)
        guard let window else {
            return NSRect(x: visible.maxX - width - 24, y: visible.minY + 24 + 70, width: width, height: height)
        }
        let rightRoom = quartzScreen.maxX - window.maxX
        let leftRoom = window.minX - quartzScreen.minX
        let cocoaCenterY = TeachGeometry.mainHeight - window.midY
        var y = cocoaCenterY - height / 2
        y = min(max(visible.minY + 80, y), visible.maxY - height - 12)
        if rightRoom >= width + 32 {
            return NSRect(x: window.maxX + 16, y: y, width: width, height: height)
        }
        if leftRoom >= width + 32 {
            return NSRect(x: window.minX - width - 16, y: y, width: width, height: height)
        }
        // No free side: sit over the window's right half, leaving the left visible.
        let x = min(visible.maxX - width - 20, max(visible.minX + 20, window.maxX - width - 20))
        return NSRect(x: x, y: max(visible.minY + 80, TeachGeometry.mainHeight - window.maxY + 24), width: width, height: height)
    }

    private func buildPanels(on screen: NSScreen, beside window: CGRect?) {
        guard let env else { return }
        panel?.orderOut(nil)
        pointPanel?.orderOut(nil)
        let frame = placement(on: screen, beside: window)
        let panel = ConceptPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar + 3
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // Panels hide themselves when the app deactivates by default, and okidoki deactivates the
        // moment the summon box goes away. Stay put.
        panel.hidesOnDeactivate = false
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        // The stage is always a dark card, whatever the Mac's appearance or what's behind it.
        panel.appearance = NSAppearance(named: .darkAqua)

        let root = NSView(frame: NSRect(origin: .zero, size: frame.size))
        root.wantsLayer = true
        root.layer?.cornerRadius = 22
        root.layer?.masksToBounds = true
        root.layer?.borderColor = NSColor.white.withAlphaComponent(0.1).cgColor
        root.layer?.borderWidth = 1
        let blur = NSVisualEffectView(frame: root.bounds)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.autoresizingMask = [.width, .height]
        root.addSubview(blur)
        let tint = NSView(frame: root.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = NSColor(white: 0.03, alpha: 0.72).cgColor
        tint.autoresizingMask = [.width, .height]
        root.addSubview(tint)

        let barHeight: CGFloat = 96
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "stage")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The stage is an ES-module page. WebKit refuses module imports from a file:// origin, so the
        // files are served through a private scheme, which gives them a real origin and makes the
        // page's `'self'` policy work.
        if let dir = Self.stageURL()?.deletingLastPathComponent() {
            config.setURLSchemeHandler(StageSchemeHandler(directory: dir), forURLScheme: StageSchemeHandler.scheme)
        }
        if #available(macOS 13.3, *) { config.preferences.isElementFullscreenEnabled = false }
        let web = ConceptWebView(frame: NSRect(x: 0, y: barHeight, width: frame.width, height: frame.height - barHeight), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        root.addSubview(web)
        webView = web
        if #available(macOS 13.3, *) { web.isInspectable = ProcessInfo.processInfo.environment["OKIDOKI_STAGE_INSPECT"] == "1" }
        Self.installOfflineRules(on: web) { [weak self] in
            guard Self.stageURL() != nil, let url = URL(string: "\(StageSchemeHandler.scheme)://stage/stage.html") else {
                self?.fail("the stage files are missing from this build")
                return
            }
            web.load(URLRequest(url: url))
        }

        let strip = ConceptDragStrip(frame: NSRect(x: 0, y: frame.height - 34, width: frame.width, height: 34))
        strip.autoresizingMask = [.width, .minYMargin]
        root.addSubview(strip)

        let bar = OverlayHostingView(rootView: AnyView(
            ConceptBarView(model: model, accent: Color(hexString: env.store.settings.drawingColorHex, fallback: 0x44E45E),
                           onBeat: { [weak self] index in self?.goTo(beat: index) },
                           onReset: { [weak self] in self?.resetView() },
                           onVoice: { [weak self] in self?.toggleVoice() },
                           onSpeed: { [weak self] in
                               guard let self else { return }
                               self.setSpeed(self.model.speed >= 1.5 ? 1 : 1.5)
                           },
                           onPhoto: { [weak self] in self?.model.showPhoto.toggle() },
                           onClose: { [weak self] in self?.dismiss(completed: self?.model.phase == .done) })
                .environmentObject(env)
                .environment(\.colorScheme, .dark)
        ))
        bar.frame = NSRect(x: 0, y: 0, width: frame.width, height: barHeight)
        bar.autoresizingMask = [.width, .maxYMargin]
        root.addSubview(bar)

        let title = OverlayHostingView(rootView: AnyView(ConceptTitleView(model: model).environment(\.colorScheme, .dark)))
        title.frame = NSRect(x: 0, y: frame.height - 34, width: frame.width, height: 34)
        title.autoresizingMask = [.width, .minYMargin]
        root.addSubview(title, positioned: .below, relativeTo: strip)

        panel.contentView = root
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.35
            panel.animator().alphaValue = 1
        }
        self.panel = panel

        let point = TeachPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        point.isOpaque = false
        point.backgroundColor = .clear
        point.hasShadow = false
        point.level = .statusBar + 2
        point.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        point.hidesOnDeactivate = false
        point.ignoresMouseEvents = true
        point.sharingType = .none
        point.isReleasedWhenClosed = false
        let stage = TeachStageView(frame: NSRect(origin: .zero, size: screen.frame.size))
        stage.accent = NSColor(Color(hexString: env.store.settings.drawingColorHex, fallback: 0x44E45E))
        point.contentView = stage
        point.orderFrontRegardless()
        pointPanel = point
        pointStage = stage

        // Whatever happens to spaces, full-screen apps or okidoki's own activation, the stage stays on top.
        for observer in spaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer); NotificationCenter.default.removeObserver(observer) }
        spaceObservers = [
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.bringPanelsForward() }
            },
            NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.bringPanelsForward() }
            },
        ]
    }

    private func bringPanelsForward() {
        guard let panel else { return }
        panel.orderFrontRegardless()
        pointPanel?.orderFrontRegardless()
    }

    private func installKeys() {
        for monitor in escMonitors { NSEvent.removeMonitor(monitor) }
        escMonitors = []
        if let local = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            if event.keyCode == 53 { Task { @MainActor in self?.dismiss(completed: self?.model.phase == .done) }; return nil }
            return event
        }) { escMonitors.append(local) }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { [weak self] event in
            if event.keyCode == 53 { Task { @MainActor in self?.dismiss(completed: self?.model.phase == .done) } }
        }) { escMonitors.append(global) }
    }

    /// The stage lives in `Resources/stage` inside the app; in a dev build, next to the sources.
    static func stageURL() -> URL? {
        if let env = ProcessInfo.processInfo.environment["OKIDOKI_STAGE_DIR"], !env.isEmpty {
            let url = URL(fileURLWithPath: env).appendingPathComponent("stage.html")
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("stage/stage.html"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        // Dev builds: .build/debug/Okidoki → repo root/Resources/stage.
        var dir = Bundle.main.bundleURL
        for _ in 0..<6 {
            dir.deleteLastPathComponent()
            let candidate = dir.appendingPathComponent("Resources/stage/stage.html")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Nothing in the stage may touch the network: block every http(s)/ws scheme before the first load.
    private static func installOfflineRules(on webView: WKWebView, then: @escaping () -> Void) {
        let rules = """
        [{"trigger":{"url-filter":"^https?://.*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^wss?://.*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^ftp://.*"},"action":{"type":"block"}}]
        """
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "okidoki-stage-offline", encodedContentRuleList: rules) { list, _ in
            DispatchQueue.main.async {
                if let list { webView.configuration.userContentController.add(list) }
                then()
            }
        }
    }

}

// MARK: - Stage files

/// Serves Resources/stage over a private scheme. A custom scheme is a real origin, so the page's
/// module imports and `'self'` content-security policy work; file:// is an opaque origin and WebKit
/// blocks module scripts there.
final class StageSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "okidoki-stage"
    private let directory: URL

    init(directory: URL) {
        self.directory = directory.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { task.didFailWithError(URLError(.badURL)); return }
        let name = url.path.split(separator: "/").map(String.init).joined(separator: "/")
        let file = directory.appendingPathComponent(name.isEmpty ? "stage.html" : name).standardizedFileURL
        // Never leave the stage folder.
        guard file.path.hasPrefix(directory.path), let data = FileManager.default.contents(atPath: file.path) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didFinish()
            return
        }
        let type: String
        switch file.pathExtension.lowercased() {
        case "html": type = "text/html; charset=utf-8"
        case "js", "mjs": type = "text/javascript; charset=utf-8"
        case "json": type = "application/json"
        case "css": type = "text/css"
        case "png": type = "image/png"
        case "jpg", "jpeg": type = "image/jpeg"
        case "svg": type = "image/svg+xml"
        default: type = "application/octet-stream"
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": "\(data.count)", "Cache-Control": "no-store"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Views

struct ConceptTitleView: View {
    @ObservedObject var model: ConceptModel

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Color.white.opacity(0.25)).frame(width: 6, height: 6)
            Text(model.title)
                .font(.okMono(9, .medium))
                .textCase(.uppercase)
                .foregroundStyle(Color.white.opacity(0.75))
                .lineLimit(1)
            Spacer()
            if !model.hoverPart.isEmpty {
                Text(model.hoverPart)
                    .font(.okBody(11, .medium))
                    .foregroundStyle(Color.white.opacity(0.85))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.white.opacity(0.1)))
                    .transition(.opacity)
            }
            Text("drag the model to orbit · click a part to ask · esc closes")
                .font(.okMono(8))
                .foregroundStyle(Color.white.opacity(0.35))
                .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .frame(height: 34)
        .animation(OKMotion.spring, value: model.hoverPart)
    }
}

/// Caption, the beat dots (click one to jump there), and the few things worth a button:
/// speed, reset view, voice, close. The lesson plays itself.
struct ConceptBarView: View {
    @ObservedObject var model: ConceptModel
    var accent: Color
    var onBeat: (Int) -> Void
    var onReset: () -> Void
    var onVoice: () -> Void
    var onSpeed: () -> Void
    var onPhoto: () -> Void
    var onClose: () -> Void
    @State private var blink = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                if model.phase == .building || model.phase == .thinking {
                    Circle().fill(accent).frame(width: 6, height: 6).opacity(blink ? 1 : 0.25).padding(.top, 6)
                } else {
                    Circle().fill(model.phase == .failed ? Color.white.opacity(0.5) : accent).frame(width: 6, height: 6).padding(.top, 6)
                }
                Text(model.caption.isEmpty ? " " : model.caption)
                    .font(.okBody(13, .medium))
                    .foregroundStyle(Color.white.opacity(0.94))
                    .lineSpacing(2)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(model.caption)
                    .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                if let photo = model.photo, model.showPhoto, let image = Self.image(from: photo.dataURL) {
                    VStack(alignment: .leading, spacing: 3) {
                        Image(nsImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 96, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        Text(photo.credit)
                            .font(.okMono(7))
                            .foregroundStyle(Color.white.opacity(0.4))
                            .lineLimit(1)
                    }
                    .frame(width: 96)
                    .onTapGesture { onPhoto() }
                    .transition(.scale.combined(with: .opacity))
                }
            }
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(0..<max(1, model.beatCount), id: \.self) { i in
                        Capsule()
                            .fill(i < model.beat ? accent : (i == model.beat && model.phase != .building ? accent.opacity(0.9) : Color.white.opacity(0.18)))
                            .frame(width: i == model.beat ? 18 : 8, height: 4)
                            .contentShape(Rectangle().size(width: 14, height: 20))
                            .onTapGesture { onBeat(i) }
                            .help(model.beatCount > 0 ? "beat \(i + 1)" : "")
                    }
                }
                .animation(OKMotion.spring, value: model.beat)
                Text(model.beatCount > 0 ? "\(min(model.beat + 1, model.beatCount)) / \(model.beatCount)" : "")
                    .font(.okMono(8.5))
                    .foregroundStyle(Color.white.opacity(0.45))
                Spacer()
                if model.phase == .done {
                    Button("done") { onClose() }
                        .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
                }
                Button { onSpeed() } label: {
                    Text(model.speed >= 1.5 ? "1.5×" : "1×").font(.okMono(9, .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.white.opacity(0.6))
                .help("narration speed")
                Button { onReset() } label: { Image(systemName: "scope").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.white.opacity(0.6))
                    .help("reset the view")
                Button { onVoice() } label: {
                    Image(systemName: model.voice ? "speaker.wave.2.fill" : "speaker.slash.fill").font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(model.voice ? Color.white.opacity(0.85) : Color.white.opacity(0.4))
                Text("esc")
                    .font(.okMono(8))
                    .foregroundStyle(Color.white.opacity(0.3))
                Button { onClose() } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.white.opacity(0.6))
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .help("close · esc")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(height: 96, alignment: .top)
        .animation(OKMotion.spring, value: model.phase)
        .animation(OKMotion.spring, value: model.caption)
        .animation(OKMotion.spring, value: model.showPhoto)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { blink = true }
        }
    }

    private static func image(from dataURL: String) -> NSImage? {
        guard let comma = dataURL.firstIndex(of: ","), let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }
}
