import SwiftUI
import Combine
import OkidokiCore

struct OnboardingView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore

    @State private var step: OnboardStep = .welcome
    @State private var forward = true
    @State private var name = ""
    @State private var inputMode: InputMode = .typing
    @State private var about = ""
    @State private var permissions: [PermissionKind: PermissionState] = [:]
    @State private var connecting: String?
    @State private var didShake = false
    @State private var didCircle = false
    @State private var workspace = "mac"
    @State private var mode = "personal"
    @State private var anthropicKey = ""
    @State private var keyCheck: String?
    @State private var checkingKey = false
    // "Bring your stuff": the vault passphrase typed here (kept only for this window unless remembered).
    @State private var vaultPass = ""
    @State private var vaultPassAgain = ""
    @State private var rememberVault = true
    @State private var sessionVaultPass = ""
    @State private var vaultPassNote: String?
    @State private var memorySources: [MemorySource] = []
    @State private var memoryAdded: [String: Int] = [:]
    @FocusState private var focusedField: Field?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Field: Hashable { case name, key, about, vault, vaultAgain }
    private var t: OKShell { OKShell(scheme) }

    var body: some View {
        ZStack {
            OnboardingDesk()
            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 16)
                card
                Spacer(minLength: 24)
            }
            .padding(.horizontal, 32)
        }
        .frame(minWidth: 760, minHeight: 620)
        .onAppear {
            name = store.activeAccount.name == "you" ? "" : store.activeAccount.name
            inputMode = store.settings.defaultInput
            workspace = store.settings.computerTarget
            mode = store.settings.useMode
            refreshPermissions()
        }
        .onDisappear { env.suspendSummonForTour = false }
        .onReceive(env.$shakePulse.dropFirst()) { _ in
            guard step == .tour else { return }
            withAnimation(stateChange) { didShake = true }
        }
        // Permissions are granted in System Settings; re-check whenever the user comes back.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            refreshPermissions()
        }
        .onChange(of: step) { _, newValue in
            env.suspendSummonForTour = newValue == .tour
            if newValue == .access { refreshPermissions() }
            if newValue == .bring {
                env.refreshVaultImportSources()
                memorySources = MemoryImport.available().map(\.source)
            }
        }
    }

    // MARK: - Chrome

    private var topBar: some View {
        ZStack {
            HStack(spacing: 6) {
                ForEach(OnboardStep.allCases, id: \.self) { item in
                    Capsule()
                        .fill(item.rawValue <= step.rawValue ? t.accent : t.lineStrong)
                        .frame(width: item == step ? 18 : 6, height: 6)
                }
            }
            .animation(reduceMotion ? nil : OKShell.easeOut(0.24), value: step)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(step.rawValue + 1) of \(OnboardStep.allCases.count)")
            HStack {
                Spacer()
                if step != .done {
                    Button("Skip setup") { finish() }
                        .buttonStyle(ShellLinkButtonStyle())
                }
            }
        }
        .frame(height: 28)
        .padding(.top, 18)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepContent
                .id(step)
                .transition(stepTransition)
            footer.padding(.top, 28)
        }
        .padding(.horizontal, 36)
        .padding(.top, 34)
        .padding(.bottom, 26)
        .frame(width: 540)
        // The composer-box surface: --c-bg at r16 with --lift (one ring on dark ground).
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(t.dark ? t.soft : t.card))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(t.dark ? t.lineStrong : Color.black.opacity(0.05), lineWidth: 1))
        .shadow(color: .black.opacity(t.dark ? 0 : 0.04), radius: 1.5, y: 1)
        .shadow(color: Color(hex: 0x102018).opacity(t.dark ? 0 : 0.16), radius: 16, y: 12)
    }

    /// Steps trade places with a short fade and an 8pt nudge in the direction of travel:
    /// ease-out in, a quicker symmetric curve out. Reduce Motion keeps only the fade.
    private var stepTransition: AnyTransition {
        let shift: CGFloat = reduceMotion ? 0 : 8
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(x: forward ? shift : -shift))
                .animation(OKShell.easeOut(0.24)),
            removal: .opacity.combined(with: .offset(x: forward ? -shift : shift))
                .animation(OKShell.easeExit(0.15))
        )
    }

    /// In-step state changes (a choice picked, a gesture done): one quick ease-out.
    private var stateChange: Animation? { reduceMotion ? nil : OKShell.easeOut(0.2) }

    private var footer: some View {
        HStack(spacing: 10) {
            if step != .welcome && step != .done {
                Button("Back") { go(to: OnboardStep(rawValue: step.rawValue - 1) ?? .welcome) }
                    .buttonStyle(ShellButtonStyle(kind: .ghost))
            }
            Spacer()
            Button(primaryTitle) { primaryAction() }
                .buttonStyle(ShellButtonStyle(kind: .primary))
                .keyboardShortcut(.defaultAction)
        }
    }

    @ViewBuilder private var stepContent: some View {
        switch step {
        case .welcome: welcomeStep
        case .mode: modeStep
        case .access: accessStep
        case .workspace: workspaceStep
        case .brain: brainStep
        case .about: aboutStep
        case .bring: bringStep
        case .tour: tourStep
        case .done: doneStep
        }
    }

    // MARK: - Steps

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            OKLogo(size: 52, glow: true)
                .padding(.bottom, 22)
            title("Hi, I'm okidoki.")
            subtitle("Shake your mouse anywhere and I'll answer, act, or show you how. Then I get out of the way.")
            fieldLabel("What should I call you?").padding(.top, 26)
            TextField("Your name", text: $name)
                .textFieldStyle(.plain)
                .font(.shellUI(14))
                .foregroundStyle(t.ink)
                .focused($focusedField, equals: .name)
                .padding(.horizontal, 13)
                .frame(height: 40)
                .shellField(t, focused: focusedField == .name)
                .onSubmit { primaryAction() }
        }
    }

    private var accessStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Give okidoki access")
            subtitle("macOS asks once. Change any of these later in System Settings.")
            VStack(spacing: 0) {
                accessRow(symbol: "rectangle.dashed", title: "Screen", detail: "See what you're looking at", granted: permissions[.screen] == .granted) {
                    request(.screen)
                }
                divider
                accessRow(symbol: "mic", title: "Microphone", detail: "Talk instead of type", granted: permissions[.microphone] == .granted) {
                    request(.microphone)
                }
                divider
                accessRow(symbol: "cursorarrow.click.2", title: "Accessibility", detail: "Click and type, only when you say yes", granted: permissions[.accessibility] == .granted) {
                    request(.accessibility)
                }
            }
            .groupBox(t)
            .padding(.top, 22)

            fieldLabel("Apple apps").padding(.top, 20)
            VStack(spacing: 0) {
                appleRow("calendar", symbol: "calendar", title: "Calendar", connected: store.settings.appleCalendar)
            }
            .groupBox(t)
        }
    }

    /// The one question that shapes everything else: solo, or shared sessions with the people
    /// around you. Either way it's the same loop — show it once, it does it forever.
    private var modeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Who's okidoki for?")
            subtitle("You can switch anytime in Settings — it only changes what's offered there.")
            VStack(spacing: 10) {
                modeCard(id: "personal", symbol: "person.crop.circle",
                         title: "Just me",
                         detail: "Your own teammate. Skills, replays and memory — everything stays on this Mac.")
                modeCard(id: "collab", symbol: "person.2.crop.square.stack",
                         title: "Me and my people",
                         detail: "Everything personal has, plus live shared sessions on your WiFi: one Mac hosts, everyone joins in a browser and watches okidoki work.")
            }
            .padding(.top, 22)
            if mode == "collab" {
                HStack(spacing: 10) {
                    Image(systemName: "macwindow.on.rectangle")
                        .foregroundStyle(t.green)
                    Text("A shared session drives okidoki's private Mac — never anyone's own screen. Pick it on the next step.")
                        .font(.shellUI(12.5))
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
                .padding(.top, 14)
            }
        }
    }

    private func modeCard(id: String, symbol: String, title: String, detail: String) -> some View {
        let selected = mode == id
        return Button {
            withAnimation(stateChange) { mode = id }
        } label: {
            HStack(spacing: 12) {
                iconTile(symbol, active: selected)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                    Text(detail).font(.shellUI(12.5)).foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                ZStack {
                    Circle().strokeBorder(selected ? t.accent : t.lineStrong, lineWidth: 1.5)
                        .frame(width: 18, height: 18)
                    if selected { Circle().fill(t.accent).frame(width: 8, height: 8) }
                }
            }
            .padding(.vertical, 12)
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .shellRow(t, selected: selected)
            .contentShape(RoundedRectangle(cornerRadius: OKShell.radiusCard, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var workspaceStep: some View {
        let supported = PrivateMacService.isSupported
        let phase = env.privateMac.phase
        let busy = phase == .downloading || phase == .installing
        return VStack(alignment: .leading, spacing: 0) {
            title("Where should okidoki work?")
            subtitle("When you ask it to do something in an app, it needs a screen to do it on.")
            VStack(spacing: 10) {
                workspaceCard(id: "mac", symbol: "macbook", title: "This Mac",
                              detail: "Shares your screen and cursor. Press Esc to take over anytime.",
                              enabled: true)
                workspaceCard(id: "vm", symbol: "macwindow.on.rectangle", title: "A private Mac",
                              detail: supported
                                  ? "Its own macOS in a window. You keep working while it does.\(mode == "collab" ? " Shared sessions drive this one." : "") A one-time \(Int(PrivateMacSpec.approximateDownloadBytes / 1_000_000_000)) GB download."
                                  : "Needs a Mac with Apple silicon.",
                              enabled: supported)
            }
            .padding(.top, 22)
            if workspace == "vm" || busy {
                HStack(spacing: 10) {
                    if busy {
                        ProgressView(value: env.privateMac.progress)
                            .progressViewStyle(.linear)
                            .tint(t.green)
                            .frame(width: 120)
                    } else {
                        Image(systemName: phase == .running || phase == .stopped ? "checkmark.circle.fill" : "arrow.down.circle")
                            .foregroundStyle(t.green)
                    }
                    Text(workspaceHint(phase: phase))
                        .font(.shellUI(12.5))
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                }
                .padding(.top, 14)
            }
        }
    }

    private func workspaceHint(phase: PrivateMacService.Phase) -> String {
        switch phase {
        case .downloading, .installing: return env.privateMac.detail + " — keep going, this runs in the background."
        case .stopped, .running, .starting, .stopping: return "Your private Mac is ready. It starts the first time a run needs it."
        case .failed: return env.privateMac.error ?? "Setup didn't finish. You can retry in Settings."
        case .unsupported: return "Needs a Mac with Apple silicon."
        case .notSetUp: return "Setup starts when you continue and runs in the background. You can finish it later in Settings."
        }
    }

    private func workspaceCard(id: String, symbol: String, title: String, detail: String, enabled: Bool) -> some View {
        let selected = workspace == id
        return Button {
            guard enabled else { return }
            withAnimation(stateChange) { workspace = id }
        } label: {
            HStack(spacing: 12) {
                iconTile(symbol, active: selected)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                    Text(detail).font(.shellUI(12.5)).foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                ZStack {
                    Circle().strokeBorder(selected ? t.accent : t.lineStrong, lineWidth: 1.5)
                        .frame(width: 18, height: 18)
                    if selected { Circle().fill(t.accent).frame(width: 8, height: 8) }
                }
            }
            .padding(.vertical, 12)
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .shellRow(t, selected: selected)
            .opacity(enabled ? 1 : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: OKShell.radiusCard, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var brainStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("How do you want to ask?")
            subtitle("Bring your own Anthropic key: it stays in a private file on this Mac. Typing stays quiet until the next time you speak.")
            HStack {
                fieldLabel("Default")
                Spacer()
                ShellSegmented(options: InputMode.allCases, label: { $0 == .voice ? "Voice" : "Typing" }, selection: $inputMode)
            }
            .padding(.top, 24)
            fieldLabel(env.hasKey("anthropic") ? "Anthropic key · set" : "Anthropic key").padding(.top, 22)
            SecureField(env.hasKey("anthropic") ? "Saved — paste a new one to replace it" : "sk-ant-…", text: $anthropicKey)
                .textFieldStyle(.plain)
                .font(.shellUI(14))
                .foregroundStyle(t.ink)
                .focused($focusedField, equals: .key)
                .padding(.horizontal, 13)
                .frame(height: 40)
                .shellField(t, focused: focusedField == .key)
                .onSubmit { primaryAction() }
            Text(checkingKey ? "Checking the key…" : keyCheck ?? "Get one at console.anthropic.com. You can add it later in Settings › Keys.")
                .font(.shellUI(12.5))
                .foregroundStyle(t.muted)
                .padding(.top, 8)
        }
    }

    private var aboutStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Tell me about you")
            subtitle("Just once. It shapes every answer, and you can edit it in Memory.")
            ZStack(alignment: .topLeading) {
                if about.isEmpty {
                    Text("I'm a designer, I live in Figma, keep answers short…")
                        .font(.shellUI(14))
                        .foregroundStyle(t.faint)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 13)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $about)
                    .font(.shellUI(14))
                    .foregroundStyle(t.ink)
                    .scrollContentBackground(.hidden)
                    .focused($focusedField, equals: .about)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            }
            .frame(height: 112)
            .shellField(t, focused: focusedField == .about, radius: OKShell.radiusTile)
            .padding(.top, 24)
            HStack(spacing: 6) {
                ForEach(["I'm a student", "I use Figma", "Keep it short", "I'm building a startup"], id: \.self) { suggestion in
                    Button {
                        about = about.isEmpty ? suggestion : about + ", " + suggestion.lowercasedFirst
                    } label: {
                        Text(suggestion)
                    }
                    .buttonStyle(ShellChipButtonStyle())
                }
            }
            .padding(.top, 12)
        }
    }

    // MARK: - Bring your stuff

    /// The passphrase imports are sealed with: remembered on this Mac, or typed in this window.
    private var importPassphrase: String {
        _ = env.keysVersion
        if !sessionVaultPass.isEmpty { return sessionVaultPass }
        return KeyStore.get(LocalVault.passphraseKey) ?? ""
    }

    private var bringStep: some View {
        let status = env.vaultImport
        let ready = !importPassphrase.isEmpty
        return VStack(alignment: .leading, spacing: 0) {
            title("Bring your stuff")
            subtitle("Optional. Passwords from your browsers go into the vault, sealed on this Mac; Sign-ins keep you logged in to your sites in okidoki's browser. What other assistants know about you goes into Memory.")
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    fieldLabel("Passwords").padding(.top, 20)
                    if !ready { vaultPassphraseBox }
                    VStack(spacing: 0) {
                        if status.sources.isEmpty {
                            HStack(spacing: 12) {
                                iconTile("globe", active: false)
                                Text(status.scanned ? "No browsers with saved passwords found." : "Looking for browsers…")
                                    .font(.shellUI(12.5)).foregroundStyle(t.muted)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            .frame(height: 52)
                        }
                        ForEach(Array(status.sources.enumerated()), id: \.element.id) { index, browser in
                            if index > 0 { divider }
                            browserRow(browser, status: status, ready: ready)
                        }
                        divider
                        HStack(spacing: 12) {
                            iconTile("doc.text", active: false)
                            VStack(alignment: .leading, spacing: 1) {
                                Text("From a CSV file").font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                                Text(csvDetail(status)).font(.shellUI(12.5)).foregroundStyle(t.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            if status.csvToTrash != nil {
                                Button("Trash CSV") { env.finishVaultImportCSV(trash: true) }
                                    .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
                            } else {
                                Button(status.busy == "csv" ? "Importing…" : "Choose…") { env.importPasswordCSV(passphrase: importPassphrase) }
                                    .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
                                    .disabled(!ready || status.busy != nil)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                    }
                    .groupBox(t)

                    fieldLabel("Memory").padding(.top, 20)
                    VStack(spacing: 0) {
                        if memorySources.isEmpty {
                            HStack(spacing: 12) {
                                iconTile("brain", active: false)
                                Text("No other assistants' notes on this Mac. You can import an export later from Memory.")
                                    .font(.shellUI(12.5)).foregroundStyle(t.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                        }
                        ForEach(Array(memorySources.enumerated()), id: \.element.id) { index, source in
                            if index > 0 { divider }
                            memoryRow(source)
                        }
                    }
                    .groupBox(t)
                }
            }
            .frame(maxHeight: 380)
        }
    }

    private var vaultPassphraseBox: some View {
        let setting = env.vault.logins.isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            Text(setting ? "Pick a vault passphrase first. Passwords are sealed with it before they're saved."
                         : "Unlock your vault so imported passwords are sealed with the same passphrase.")
                .font(.shellUI(12.5)).foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
            passField(setting ? "Vault passphrase" : "Your vault passphrase", text: $vaultPass, field: .vault)
            if setting { passField("Same passphrase again", text: $vaultPassAgain, field: .vaultAgain) }
            HStack {
                Toggle("Remember on this Mac", isOn: $rememberVault)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .tint(t.accent)
                    .font(.shellUI(12.5))
                    .foregroundStyle(t.ink2)
                Spacer()
                Button(setting ? "Set passphrase" : "Unlock") { useVaultPassphrase() }
                    .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
                    .disabled(vaultPass.isEmpty || (setting && vaultPassAgain.isEmpty))
            }
            if let vaultPassNote {
                Text(vaultPassNote).font(.shellUI(12.5)).foregroundStyle(t.muted)
            }
        }
        .padding(.bottom, 12)
    }

    private func passField(_ placeholder: String, text: Binding<String>, field: Field) -> some View {
        SecureField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(.shellUI(13.5))
            .foregroundStyle(t.ink)
            .focused($focusedField, equals: field)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .shellField(t, focused: focusedField == field)
            .onSubmit { useVaultPassphrase() }
    }

    /// Same rules as the Vault page: a new passphrase is typed twice; an existing one must open the logins.
    private func useVaultPassphrase() {
        let value = vaultPass
        guard !value.isEmpty else { return }
        if env.vault.logins.isEmpty {
            guard value == vaultPassAgain else { vaultPassNote = "Those don't match. Type the same passphrase in both fields."; return }
        } else {
            guard let key = VaultCrypto.key(passphrase: value, vaultID: env.vault.salt),
                  BrowserPasswordImport.keyOpensVault(key, logins: env.vault.logins) else {
                vaultPassNote = "That isn't the passphrase your vault logins are sealed with."
                return
            }
        }
        if rememberVault {
            KeyStore.set(value, for: LocalVault.passphraseKey)
            env.keysVersion += 1
        }
        sessionVaultPass = value
        vaultPass = ""
        vaultPassAgain = ""
        vaultPassNote = nil
    }

    private func browserRow(_ browser: DetectedBrowser, status: VaultImportStatus, ready: Bool) -> some View {
        let report = status.last?.source == browser.name ? status.last : nil
        let done = report.map { $0.imported + $0.updated > 0 } ?? false
        let detail: String
        let signins = status.lastCookies?.source == browser.name ? status.lastCookies : nil
        if let error = browser.error {
            detail = error
        } else if let signins, signins.cookies > 0 {
            detail = (report.map { "\($0.summary) · " } ?? "") + "signed in to \(signins.sites) \(signins.sites == 1 ? "site" : "sites")"
        } else if let signins, let error = signins.errors.first {
            detail = error
        } else if let report {
            detail = report.errors.isEmpty ? report.summary : "\(report.summary) · \(report.errors[0])"
        } else {
            let count = browser.logins.map { "\($0) saved \($0 == 1 ? "password" : "passwords")" } ?? "Saved passwords"
            detail = browser.profiles.count > 1 ? "\(count) · \(browser.profiles.count) profiles" : count
        }
        return HStack(spacing: 12) {
            iconTile(done ? "checkmark" : "key", active: done)
            VStack(alignment: .leading, spacing: 1) {
                Text(browser.name).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                Text(detail).font(.shellUI(12.5)).foregroundStyle(done ? t.green : t.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if signins.map({ $0.cookies > 0 }) != true {
                Button(status.cookiesBusy == browser.id ? "Signing in…" : "Sign-ins") {
                    env.importBrowserCookies(id: browser.id)
                }
                .buttonStyle(ShellButtonStyle(kind: .ghost, small: true))
                .disabled(status.cookiesBusy != nil || browser.error != nil)
                .help("Stay signed in to your sites in okidoki's browser")
            }
            if done {
                statusPill("Imported")
            } else {
                Button(status.busy == browser.id ? "Importing…" : "Import") {
                    env.importBrowserPasswords(id: browser.id, passphrase: importPassphrase)
                }
                .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
                .disabled(!ready || status.busy != nil || browser.error != nil || browser.logins == 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private func csvDetail(_ status: VaultImportStatus) -> String {
        if let name = status.csvToTrash {
            let summary = status.last.map { "\($0.summary) · " } ?? ""
            return "\(summary)\(name) still has your passwords in plain text — move it to the Trash."
        }
        if status.busy == nil, let last = status.last, last.source.lowercased().hasSuffix(".csv") {
            return last.errors.first ?? last.summary
        }
        return "Passwords app: File › Export All Passwords to File. Firefox: about:logins › ⋯ › Export Passwords."
    }

    private func memoryRow(_ source: MemorySource) -> some View {
        let added = memoryAdded[source.id]
        return HStack(spacing: 12) {
            iconTile(added != nil ? "checkmark" : "brain", active: added != nil)
            VStack(alignment: .leading, spacing: 1) {
                Text(source.name).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                Text(added.map { $0 == 0 ? "Nothing new to remember." : "\($0) \($0 == 1 ? "memory" : "memories") added." } ?? source.blurb)
                    .font(.shellUI(12.5)).foregroundStyle(added != nil ? t.green : t.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if added != nil {
                statusPill("Imported")
            } else {
                Button("Import") { memoryAdded[source.id] = env.importMemory(sourceID: source.id) ?? 0 }
                    .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var tourStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Try it")
            subtitle("Two gestures are all you need.")
            VStack(spacing: 10) {
                if env.store.settings.shakeToSummon {
                    tourCard(symbol: "cursorarrow.motionlines", title: "Shake your mouse",
                             detail: didShake ? "That's it. Shake again or press Esc to dismiss." : "Anywhere on screen, like scribbling out a mistake.",
                             done: didShake) {
                        if !didShake {
                            // Shaking isn't for everyone: the shortcut does the same, and the mouse is left alone.
                            Button("Use \(SummonHotKey.label(env.store.settings.summonHotkey.isEmpty ? "option+space" : env.store.settings.summonHotkey)) instead") {
                                if env.store.settings.summonHotkey.isEmpty { env.store.settings.summonHotkey = "option+space" }
                                env.store.settings.shakeToSummon = false
                                env.store.saveNow()
                                withAnimation(stateChange) { didShake = true }
                            }
                            .buttonStyle(ShellButtonStyle(kind: .ghost, small: true))
                            .padding(.top, 8)
                        }
                    }
                } else {
                    tourCard(symbol: "keyboard", title: "Press \(SummonHotKey.label(env.store.settings.summonHotkey))",
                             detail: "Your shortcut opens okidoki in any app. Shake to summon is off; turn it on in Settings › Summon.",
                             done: true) { EmptyView() }
                }
                tourCard(symbol: "lasso", title: "Circle something",
                         detail: didCircle ? "Nice. That's how you point at things." : "Draw around the dot to show what you mean.",
                         done: didCircle) {
                    TourCanvas(done: $didCircle)
                        .frame(height: 104)
                        .padding(.top, 12)
                }
            }
            .padding(.top, 22)
        }
    }

    private var doneStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(t.greenSoft).frame(width: 56, height: 56)
                Image(systemName: "checkmark")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(t.green)
            }
            .padding(.bottom, 22)
            title("You're all set\(name.isEmpty ? "" : ", \(firstName)").")
            subtitle("okidoki lives in your notch. It's there whenever you need it.")
            VStack(spacing: 0) {
                hintRow(keys: env.store.settings.shakeToSummon ? "Shake" : SummonHotKey.label(env.store.settings.summonHotkey), detail: "Summon okidoki")
                divider
                hintRow(keys: "Esc", detail: "Dismiss")
                divider
                hintRow(keys: "⌘K", detail: "Ask from the dashboard")
                if mode == "collab" {
                    divider
                    hintRow(keys: "Settings", detail: "Shared session — invite people with the code")
                }
            }
            .groupBox(t)
            .padding(.top, 24)
        }
    }

    // MARK: - Actions

    private var primaryTitle: String {
        switch step {
        case .welcome: return "Get started"
        case .brain: return "Continue"
        case .tour: return ((didShake || !env.store.settings.shakeToSummon) && didCircle) ? "Continue" : "Skip"
        case .done: return "Start using okidoki"
        default: return "Continue"
        }
    }

    private func primaryAction() {
        switch step {
        case .welcome:
            var account = store.activeAccount
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { account.name = trimmed }
            store.updateAccount(account)
            store.saveNow()
        case .mode:
            store.settings.useMode = mode
            store.saveNow()
        case .workspace:
            store.settings.computerTarget = workspace
            store.saveNow()
            if workspace == "vm" { env.privateMac.setUp() }
        case .brain:
            store.settings.defaultInput = inputMode
            store.saveNow()
            let key = anthropicKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                // Saved and checked straight away, so a typo shows up here and not on the first request.
                env.saveKey(provider: "anthropic", value: key)
                anthropicKey = ""
                checkingKey = true
                Task {
                    let check = await AnthropicKeyCheck.run(key: key)
                    checkingKey = false
                    keyCheck = check.ok ? "Key works." : "That key didn't work: \(check.detail)"
                    if !check.ok { go(to: .brain) }
                }
            }
        case .about:
            let trimmed = about.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { env.addOnboardingMemories(trimmed) }
        case .done:
            finish()
            return
        default:
            break
        }
        go(to: OnboardStep(rawValue: step.rawValue + 1) ?? .done)
    }

    private func go(to next: OnboardStep) {
        forward = next.rawValue > step.rawValue
        // The step views carry their own curves (stepTransition); this frames the rest of the change.
        withAnimation(reduceMotion ? .linear(duration: 0.15) : OKShell.easeOut(0.24)) { step = next }
    }

    private func finish() {
        store.settings.onboardingComplete = true
        store.settings.tourComplete = true
        store.saveNow()
        env.suspendSummonForTour = false
        env.completeOnboarding()
    }

    private func request(_ kind: PermissionKind) {
        Task {
            _ = await PermissionsService.shared.request(kind)
            refreshPermissions()
        }
    }

    private func refreshPermissions() {
        var result: [PermissionKind: PermissionState] = [:]
        for kind in PermissionKind.allCases { result[kind] = PermissionsService.shared.state(kind) }
        permissions = result
    }

    private var firstName: String {
        name.split(separator: " ").first.map(String.init) ?? name
    }

    // MARK: - Pieces

    private func title(_ text: String) -> some View {
        Text(text)
            .font(.shellUI(26, .semibold))
            .tracking(-0.45)
            .foregroundStyle(t.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func subtitle(_ text: String) -> some View {
        Text(text)
            .font(.shellUI(14))
            .foregroundStyle(t.muted)
            .lineSpacing(2.5)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.shellUI(13, .semibold))
            .foregroundStyle(t.ink2)
            .padding(.bottom, 8)
    }

    private var divider: some View {
        Rectangle().fill(t.line).frame(height: 1).padding(.leading, 56)
    }

    private func iconTile(_ symbol: String, active: Bool) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(active ? t.green : t.muted)
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: OKShell.radiusControl, style: .continuous).fill(active ? t.greenSoft : t.well))
    }

    private func statusPill(_ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "checkmark").font(.system(size: 9.5, weight: .bold))
            Text(text).font(.shellUI(12, .semibold))
        }
        .foregroundStyle(t.green)
        .padding(.horizontal, 9)
        .frame(height: 24)
        .background(Capsule().fill(t.greenSoft))
    }

    private func accessRow(symbol: String, title: String, detail: String, granted: Bool, grant: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            iconTile(symbol, active: granted)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                Text(detail).font(.shellUI(12.5)).foregroundStyle(t.muted)
            }
            Spacer(minLength: 8)
            if granted {
                statusPill("Allowed")
            } else {
                Button("Allow", action: grant).buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 58)
    }

    private func appleRow(_ id: String, symbol: String, title: String, connected: Bool) -> some View {
        HStack(spacing: 12) {
            iconTile(symbol, active: connected)
            Text(title).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
            Spacer(minLength: 8)
            if connected {
                statusPill("Connected")
            } else {
                Button(connecting == id ? "Connecting…" : "Connect") {
                    connecting = id
                    Task {
                        _ = await env.connectApple(id)
                        connecting = nil
                        refreshPermissions()
                    }
                }
                .buttonStyle(ShellButtonStyle(kind: .secondary, small: true))
                .disabled(connecting != nil)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
    }

    private func tourCard<Content: View>(symbol: String, title: String, detail: String, done: Bool,
                                         @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                iconTile(done ? "checkmark" : symbol, active: done)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.shellUI(14, .semibold)).foregroundStyle(t.ink)
                    Text(detail).font(.shellUI(12.5)).foregroundStyle(done ? t.green : t.muted)
                }
                Spacer()
            }
            content()
        }
        .padding(12)
        .shellRow(t, selected: done)
        .animation(stateChange, value: done)
    }

    private func hintRow(keys: String, detail: String) -> some View {
        HStack(spacing: 12) {
            Text(keys)
                .font(.shellUI(12, .semibold))
                .foregroundStyle(t.ink2)
                .padding(.horizontal, 8)
                .frame(minWidth: 46)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(t.soft))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(t.lineStrong))
            Text(detail).font(.shellUI(13.5)).foregroundStyle(t.muted)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
    }
}

private extension View {
    /// A list of rows on the card: --c-bg with the 1px ring (the shell's need-row / settings group).
    func groupBox(_ t: OKShell) -> some View {
        shellRow(t, selected: false)
    }

    /// One bordered surface at the card radius. Selected adds the green ring the shell uses
    /// for a picked option, so the choice also reads without colour alone (radio dot / check).
    func shellRow(_ t: OKShell, selected: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: OKShell.radiusCard, style: .continuous)
        return background(shape.fill(t.card))
            .overlay(shape.strokeBorder(selected ? t.green.opacity(0.55) : t.ring, lineWidth: selected ? 1.25 : 1))
            .background(
                shape.fill(Color.black.opacity(0.0001))
                    .shadow(color: .black.opacity(t.dark ? 0 : 0.04), radius: 2, y: 1)
            )
    }

    /// Text input chrome: --c-bg, a strong hairline at rest, the --focus halo when editing.
    func shellField(_ t: OKShell, focused: Bool, radius: CGFloat = OKShell.radiusControl) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background(shape.fill(t.card))
            .overlay(shape.strokeBorder(focused ? t.greenBright.opacity(0.9) : t.lineStrong, lineWidth: 1))
            .overlay(shape.inset(by: -3).strokeBorder(focused ? t.focus : .clear, lineWidth: 3))
            .animation(OKShell.easeOut(0.16), value: focused)
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

/// The shell's ground: the --desk gradient over behind-window vibrancy, so the window frosts
/// like the dashboard does. No grid; dark mode swaps in the dark desk.
private struct OnboardingDesk: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            VisualEffectBlur(material: .underWindowBackground, blending: .behindWindow)
            OKShell(scheme).desk.opacity(scheme == .dark ? 0.9 : 0.86)
        }
        .ignoresSafeArea()
    }
}

// MARK: - Shell controls (onboarding-local; other surfaces keep OKButtonStyle)

enum ShellButtonKind { case primary, secondary, ghost }

/// The shell's .btn family: r9 (r8 small), 13 / 550, solid --ok-accent primary, --c-bg +
/// strong hairline secondary, quiet ghost. Press is a 0.97 scale on a 120ms ease-out.
struct ShellButtonStyle: ButtonStyle {
    var kind: ShellButtonKind = .primary
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        ShellButtonBody(configuration: configuration, kind: kind, small: small)
    }
}

private struct ShellButtonBody: View {
    let configuration: ButtonStyle.Configuration
    let kind: ShellButtonKind
    let small: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let t = OKShell(scheme)
        let shape = RoundedRectangle(cornerRadius: small ? 8 : OKShell.radiusControl, style: .continuous)
        let pressed = configuration.isPressed && enabled
        configuration.label
            .font(.shellUI(small ? 12.5 : 13, .medium))
            .lineLimit(1)
            .foregroundStyle(foreground(t))
            .padding(.horizontal, small ? 10 : 15)
            .frame(height: small ? 28 : 36)
            .background(shape.fill(fill(t, pressed: pressed)))
            .overlay(shape.strokeBorder(border(t), lineWidth: 1))
            .contentShape(shape)
            .opacity(enabled ? 1 : 0.42)
            .scaleEffect(pressed && !reduceMotion ? (small ? 0.96 : 0.97) : 1)
            .animation(OKShell.easeOut(0.12), value: pressed)
            .animation(OKShell.easeOut(0.15), value: hovering)
            .onHover { hovering = $0 }
    }

    private func foreground(_ t: OKShell) -> Color {
        switch kind {
        case .primary: return t.onAccent
        case .secondary: return t.ink
        case .ghost: return hovering ? t.ink : t.muted
        }
    }

    private func fill(_ t: OKShell, pressed: Bool) -> Color {
        switch kind {
        case .primary: return hovering || pressed ? t.accentHover : t.accent
        case .secondary: return pressed ? t.well : (hovering ? t.soft : t.card)
        case .ghost: return pressed ? t.press : (hovering ? t.hover : .clear)
        }
    }

    private func border(_ t: OKShell) -> Color {
        switch kind {
        case .primary, .ghost: return .clear
        case .secondary: return hovering ? t.ink.opacity(0.22) : t.lineStrong
        }
    }
}

/// The shell's .link-btn: 13pt muted text that darkens on hover.
struct ShellLinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ShellLinkBody(configuration: configuration)
    }
}

private struct ShellLinkBody: View {
    let configuration: ButtonStyle.Configuration
    @State private var hovering = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let t = OKShell(scheme)
        configuration.label
            .font(.shellUI(13))
            .foregroundStyle(hovering ? t.ink : t.muted)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hovering ? t.hover : .clear))
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(OKShell.easeOut(0.15), value: hovering)
            .onHover { hovering = $0 }
    }
}

/// The shell's .starter chip: --c-soft, r10, 13pt ink-2.
struct ShellChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ShellChipBody(configuration: configuration)
    }
}

private struct ShellChipBody: View {
    let configuration: ButtonStyle.Configuration
    @State private var hovering = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let t = OKShell(scheme)
        configuration.label
            .font(.shellUI(12.5))
            .foregroundStyle(t.ink2)
            .lineLimit(1)
            .padding(.horizontal, 11)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering ? t.well : t.soft))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(OKShell.easeOut(0.12), value: configuration.isPressed)
            .animation(OKShell.easeOut(0.15), value: hovering)
            .onHover { hovering = $0 }
    }
}

/// A two-up segmented control in the shell's tokens: a --c-well track with a raised --c-bg thumb.
struct ShellSegmented<T: Hashable>: View {
    let options: [T]
    let label: (T) -> String
    @Binding var selection: T
    @Namespace private var namespace
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let t = OKShell(scheme)
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                let on = selection == option
                Button {
                    withAnimation(reduceMotion ? nil : OKShell.easeOut(0.2)) { selection = option }
                } label: {
                    Text(label(option))
                        .font(.shellUI(12.5, .medium))
                        .foregroundStyle(on ? t.ink : t.muted)
                        .padding(.horizontal, 13)
                        .frame(height: 28)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(t.dark ? Color.white.opacity(0.1) : t.card)
                                    .shadow(color: .black.opacity(t.dark ? 0 : 0.08), radius: 2, y: 1)
                                    .matchedGeometryEffect(id: "seg", in: namespace)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(t.well))
    }
}

enum OnboardStep: Int, CaseIterable {
    case welcome, mode, access, workspace, brain, about, bring, tour, done
}

struct TourCanvas: View {
    @Binding var done: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var t: OKShell { OKShell(scheme) }
    @State private var points: [CGPoint] = []
    @State private var active: [CGPoint] = []

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width * 0.5, y: size.height * 0.5)
            let dot = CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10)
            context.fill(Path(ellipseIn: dot), with: .color(t.greenBright))
            let ring = CGRect(x: center.x - 26, y: center.y - 26, width: 52, height: 52)
            context.stroke(Path(ellipseIn: ring), with: .color(t.greenBright.opacity(0.35)),
                           style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            for stroke in [points, active] where !stroke.isEmpty {
                var path = Path()
                path.move(to: stroke[0])
                for point in stroke.dropFirst() { path.addLine(to: point) }
                context.stroke(path, with: .color(t.green),
                               style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
            }
        }
        .background(RoundedRectangle(cornerRadius: OKShell.radiusControl, style: .continuous).fill(t.soft))
        .overlay(RoundedRectangle(cornerRadius: OKShell.radiusControl, style: .continuous).strokeBorder(t.line))
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if let last = active.last {
                        if hypot(value.location.x - last.x, value.location.y - last.y) > 1.4 {
                            active.append(value.location)
                        }
                    } else {
                        active = [value.location]
                    }
                }
                .onEnded { _ in
                    let length = zip(active, active.dropFirst()).reduce(CGFloat(0)) { sum, pair in
                        sum + hypot(pair.1.x - pair.0.x, pair.1.y - pair.0.y)
                    }
                    if length > 60 {
                        points = active
                        withAnimation(reduceMotion ? nil : OKShell.easeOut(0.2)) { done = true }
                    }
                    active = []
                }
        )
    }
}
