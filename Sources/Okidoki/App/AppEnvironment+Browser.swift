import AppKit
import OkidokiCore

/// okidoki's own browser: opening it, recording a skill in it, the vault logins it fills, and what
/// happens when the browser agent finishes a run.
extension AppEnvironment {
    func openBrowser(url: URL? = nil) {
        browser.show(url: url)
    }

    /// A task typed into a tab's address bar: the agent does it in that tab, in the conversation that
    /// tab last belonged to, so "now the cheapest one" typed after a search follows on from it.
    func startBrowserTask(_ text: String, in tab: BrowserTab) {
        let goal = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else { return }
        guard hasKey("anthropic") else {
            toast(title: "add your anthropic key first", detail: "Settings › Keys — then ask again", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "keys", onEdit: { [weak self] in self?.openDashboard(.keys) }, runID: nil)
            return
        }
        if let owner = tab.ownerRunID, browserDriver.isRunning(owner) {
            toast(title: "okidoki is still working in this tab", detail: "press esc to stop it, or ask in a new tab (⌘T)", kind: .info,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: owner)
            return
        }
        // A tab with no conversation yet starts its own: tasks in other tabs aren't this one's context.
        let thread = tab.threadID.flatMap { store.thread($0) }
            ?? store.createThread(title: String(goal.prefix(60)), app: "okidoki browser", topic: inferTopic(goal))
        // A question the agent asked in this conversation: this is the answer, and the run picks up where it was.
        if let asked = store.runs.first(where: { $0.threadID == thread.id && $0.kind == .browser }), asked.status == .asked {
            browserRunTabs[asked.id] = tab.id
            answerDriveQuestion(runID: asked.id, text: goal)
            return
        }
        store.appendMessage(threadID: thread.id, role: .user, text: goal)
        let preview = ActionPreview(summary: String(goal.prefix(80)), risk: .medium,
                                    steps: [PreviewStep("read the page"), PreviewStep("work through it"), PreviewStep("report back")],
                                    commands: [], apps: ["okidoki browser"], files: [])
        let run = store.createRun(kind: .browser, title: String(goal.prefix(54)), prompt: goal, threadID: thread.id, preview: preview,
                                  steps: preview.steps.map { RunStep(title: $0.text) }, status: .waiting, builtin: "browser")
        browserRunTabs[run.id] = tab.id
        tab.threadID = thread.id
        store.saveNow()
        let decision = BrainDecision(kind: .browser, title: run.title, answer: "", risk: .medium)
        startOrAsk(run, decision: decision, threadID: thread.id, source: "browser")
    }

    // MARK: - Recording a skill in the browser

    func startBrowserRecording() {
        guard !browser.model.recording else { return }
        var steps: [SkillStep] = []
        browser.onRecordedStep = { step in steps.append(step) }
        browser.startRecording()
        browserRecording = { steps }
        toast(title: "recording in the browser", detail: "do it once — press Save when you're done", kind: .info,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    func stopBrowserRecording() {
        guard browser.model.recording else { return }
        let steps = BrowserRecordingCleanup.tidy(browserRecording?() ?? [])
        browser.stopRecording()
        browserRecording = nil
        guard steps.contains(where: { $0.action != "navigate" }) else {
            toast(title: "nothing to save", detail: "click or type something on the page while recording", kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let site = steps.compactMap { $0.url.map(BrowserSteps.host(of:)) }.first { !$0.isEmpty } ?? "web"
        saveBrowserSkill(name: "\(site) flow", steps: steps, source: "watch me")
    }

    // MARK: - Runs

    /// A finished browser run. One that worked can be kept as a skill that replays without the model.
    func browserRunFinished(_ run: AgentRun, success: Bool, summary: String, learned: [SkillStep]) {
        let source = LearnedBrowserRun(title: run.title, goal: run.prompt, summary: summary, steps: learned,
                                       pages: learnedPages.removeValue(forKey: run.id) ?? [:],
                                       secrets: learnedSecrets.removeValue(forKey: run.id) ?? [:])
        lastBrowserRun = success && !learned.isEmpty ? source : nil
        // A lookup that only went to an address is a skill too (the address carries the data; a read step is added).
        if success, !learned.isEmpty {
            savableRuns[run.id] = source
            if savableRuns.count > 30, let oldest = savableRuns.keys.min(by: { (store.run($0)?.createdAt ?? .distantPast) < (store.run($1)?.createdAt ?? .distantPast) }) {
                savableRuns[oldest] = nil
            }
        }
        // A template's first run: kept as the person's own skill straight away, and the rest replayed with it.
        // A lookup that only went to an address (npmjs.com/package/react) is a skill too: the address is
        // what changes per item, and the reading is a read step.
        if let template = templateRuns.removeValue(forKey: run.id), success, !learned.isEmpty,
           let outline = store.skill(template.templateID),
           // Two first runs at once (both started before either was learned): the first one kept wins.
           !store.activeSkills.contains(where: { $0.learned == true && $0.templateID == outline.id }) {
            saveBrowserSkill(name: outline.name, steps: learned, source: "template:\(outline.id)", learnedFrom: source) { [weak self] id in
                guard let self, var made = self.store.skill(id) else { return }
                made.templateID = outline.id
                made.learned = true
                if made.intent == nil { made.intent = outline.intent }
                if made.tags == nil { made.tags = outline.tags }
                self.store.replaceSkill(made)
                self.store.saveNow()
                if !template.rest.isEmpty {
                    _ = self.startReplayFromChat(made, times: 1, threadID: template.threadID, source: "chat", values: template.rest, request: template.request)
                }
            }
            speak(success ? "Done." : summary)
            return
        }
        var actions: [CardAction] = []
        if success, learned.contains(where: { $0.action != "navigate" }) {
            actions.append(CardAction(title: "save as skill", kind: .primary, glyph: "wand") { [weak self] in
                self?.answerController.close(restoreApp: false)
                self?.saveBrowserSkill(name: run.title, steps: learned, source: "act", learnedFrom: source)
            })
        }
        actions.append(CardAction(title: "show browser", kind: .secondary, glyph: "globe") { [weak self] in
            self?.browser.show()
        })
        let card = AnswerCardModel(title: success ? "done" : "stopped", text: summary, actions: actions,
                                   threadTitle: run.threadID.flatMap { store.thread($0)?.title }, runID: run.id, threadID: run.threadID)
        if success, !learned.isEmpty { card.footnote = "\(learned.count) steps · save it and next time it runs without the model" }
        present(card, source: "followup")
        speak(success ? "Done." : summary)
    }

    /// Keeps a finished web run as a skill (another agent teaching okidoki). Nil when that run can't be kept.
    func saveRunAsSkill(_ runID: String, name: String?) -> String? {
        guard let learned = savableRuns.removeValue(forKey: runID) else { return nil }
        let title = (name?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? learned.title
        saveBrowserSkill(name: title, steps: learned.steps, source: "act", learnedFrom: learned)
        return title
    }

    func saveBrowserSkill(name: String, steps: [SkillStep], source: String, learnedFrom: LearnedBrowserRun? = nil,
                          then: ((String) -> Void)? = nil) {
        let actions = steps.filter { $0.action != "navigate" }.count
        let site = steps.compactMap { $0.url.map(BrowserSteps.host(of:)) }.first { !$0.isEmpty } ?? "the web"
        let skill = store.createSkill(name: name, summary: "\(actions) \(actions == 1 ? "step" : "steps") on \(site), in okidoki's browser",
                                      steps: steps, source: source)
        // A password the request gave is remembered for this skill (keys.json), so replays don't need it again.
        for (name, value) in learnedFrom?.secrets ?? [:] { SkillSecrets.remember(value, name: name, skillID: skill.id) }
        store.saveNow()
        // Smart replay: the skill is saved as recorded right away, then generalized in the background.
        // If that doesn't work out it simply stays as recorded.
        if store.settings.hybridReplay {
            let run = learnedFrom ?? LearnedBrowserRun(title: name, goal: name, summary: "", steps: steps, pages: [:])
            Task { @MainActor [weak self] in
                await self?.generalize(skillID: skill.id, from: run)
                then?(skill.id)
            }
            return
        }
        then?(skill.id)
        toast(title: "saved as a skill", detail: "\(skill.name) · replays in seconds, no model", kind: .success,
              undoLabel: "replay", onUndo: { [weak self] in self?.replaySkill(skill, times: 1) },
              editLabel: "open", onEdit: { [weak self] in self?.openDashboard(.skills) }, runID: nil)
    }

    // MARK: - Vault logins

    /// The login saved for `site`, opened with the passphrase remembered on this Mac. Nil when there's
    /// none or the vault isn't remembered here; the secret stays in memory for the one fill.
    func vaultLogin(for site: String) -> (site: String, username: String, password: String)? {
        guard let login = vault.logins.first(where: { BrowserSteps.sameSite($0.site, site) }),
              let passphrase = KeyStore.get(LocalVault.passphraseKey), !passphrase.isEmpty,
              let key = VaultCrypto.key(passphrase: passphrase, vaultID: vault.salt),
              let password = VaultCrypto.open(ciphertext: login.ciphertext, iv: login.iv, key: key) else { return nil }
        vault.touchLogin(id: login.id)
        return (login.site, login.username, password)
    }

    /// One field of a vault login, for a `{{vault:site.field}}` placeholder.
    /// Only the two fields a login holds: a one-time code or card field recorded as `secret` must never
    /// get the site's password typed into it.
    func vaultSecret(site: String, field: String) -> String? {
        switch field {
        case "username", "email", "user": return vaultLogin(for: site)?.username
        case "password": return vaultLogin(for: site)?.password
        default: return nil
        }
    }
}

/// Recorded browser steps are tidied by `BrowserRecordingCleanup` (in OkidokiCore, so it's testable).
