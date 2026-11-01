import AppKit
import OkidokiCore

/// okidoki's own browser: opening it, recording a skill in it, the vault logins it fills, and what
/// happens when the browser agent finishes a run.
extension AppEnvironment {
    func openBrowser(url: URL? = nil) {
        browser.show(url: url)
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
        lastBrowserRun = success && !learned.isEmpty ? (run.title, learned) : nil
        var actions: [CardAction] = []
        if success, learned.contains(where: { $0.action != "navigate" }) {
            actions.append(CardAction(title: "save as skill", kind: .primary, glyph: "wand") { [weak self] in
                self?.answerController.close(restoreApp: false)
                self?.saveBrowserSkill(name: run.title, steps: learned, source: "act")
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

    func saveBrowserSkill(name: String, steps: [SkillStep], source: String) {
        let actions = steps.filter { $0.action != "navigate" }.count
        let site = steps.compactMap { $0.url.map(BrowserSteps.host(of:)) }.first { !$0.isEmpty } ?? "the web"
        let skill = store.createSkill(name: name, summary: "\(actions) \(actions == 1 ? "step" : "steps") on \(site), in okidoki's browser",
                                      steps: steps, source: source)
        store.saveNow()
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

/// Recorded browser steps, tidied: typing the same field twice keeps the last, and a navigation the
/// next step's page already implies (a click that led there) is dropped so the replay doesn't reload.
enum BrowserRecordingCleanup {
    static func tidy(_ steps: [SkillStep]) -> [SkillStep] {
        var out: [SkillStep] = []
        for step in steps {
            if step.action == "type", let last = out.last, last.action == "type", last.selectors == step.selectors {
                out[out.count - 1] = step
                continue
            }
            out.append(step)
        }
        return out
    }
}
