import SwiftUI
import Combine
import OkidokiCore

struct OnboardingView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore

    @State private var step: OnboardStep = .welcome
    @State private var forward = true
    @State private var name = ""
    @State private var anthropicKey = ""
    @State private var keySaved = false
    @State private var inputMode: InputMode = .typing
    @State private var about = ""
    @State private var permissions: [PermissionKind: PermissionState] = [:]
    @State private var connecting: String?
    @State private var didShake = false
    @State private var didCircle = false

    var body: some View {
        ZStack {
            OnboardingCanvas()
            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 16)
                card
                Spacer(minLength: 24)
            }
            .padding(.horizontal, 32)
        }
        .frame(minWidth: 760, minHeight: 620)
        .preferredColorScheme(.light)
        .onAppear {
            name = store.activeAccount.name == "you" ? "" : store.activeAccount.name
            inputMode = store.settings.defaultInput
            keySaved = env.hasKey("anthropic")
            refreshPermissions()
        }
        .onDisappear { env.suspendSummonForTour = false }
        .onReceive(env.$shakePulse.dropFirst()) { _ in
            guard step == .tour else { return }
            withAnimation(OKMotion.spring) { didShake = true }
        }
        // Permissions are granted in System Settings; re-check whenever the user comes back.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            refreshPermissions()
        }
        .onChange(of: step) { _, newValue in
            env.suspendSummonForTour = newValue == .tour
            if newValue == .access { refreshPermissions() }
        }
    }

    // MARK: - Chrome

    private var topBar: some View {
        ZStack {
            HStack(spacing: 6) {
                ForEach(OnboardStep.allCases, id: \.self) { item in
                    Capsule()
                        .fill(item.rawValue <= step.rawValue ? OKBrand.greenInk : OKBrand.ink.opacity(0.1))
                        .frame(width: item == step ? 22 : 6, height: 6)
                }
            }
            .animation(OKMotion.spring, value: step)
            HStack {
                Spacer()
                if step != .done {
                    Button("Skip setup") { finish() }
                        .buttonStyle(.plain)
                        .font(.okBody(12.5, .medium))
                        .foregroundStyle(OKBrand.faint)
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
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(x: forward ? 24 : -24)),
                    removal: .opacity.combined(with: .offset(x: forward ? -24 : 24))
                ))
            footer.padding(.top, 28)
        }
        .padding(.horizontal, 36)
        .padding(.top, 34)
        .padding(.bottom, 26)
        .frame(width: 540)
        .background(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Color.white.opacity(0.78))
                .background(VisualEffectBlur(material: .popover, blending: .withinWindow).clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 1)
        )
        .shadow(color: Color(hex: 0x0E1512).opacity(0.06), radius: 2, y: 1)
        .shadow(color: Color(hex: 0x00372C).opacity(0.12), radius: 40, y: 24)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if step != .welcome && step != .done {
                Button("Back") { go(to: OnboardStep(rawValue: step.rawValue - 1) ?? .welcome) }
                    .buttonStyle(OKButtonStyle(kind: .ghost))
            }
            Spacer()
            Button(primaryTitle) { primaryAction() }
                .buttonStyle(OKButtonStyle(kind: .primary))
                .keyboardShortcut(.defaultAction)
                .disabled(step == .brain && !keyReady)
                .opacity(step == .brain && !keyReady ? 0.45 : 1)
        }
    }

    @ViewBuilder private var stepContent: some View {
        switch step {
        case .welcome: welcomeStep
        case .access: accessStep
        case .brain: brainStep
        case .about: aboutStep
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
                .font(.okBody(15))
                .padding(.horizontal, 14)
                .frame(height: 46)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.1)))
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
            .groupBox()
            .padding(.top, 22)

            fieldLabel("Apple apps").padding(.top, 20)
            VStack(spacing: 0) {
                appleRow("calendar", symbol: "calendar", title: "Calendar", connected: store.settings.appleCalendar)
                divider
                appleRow("reminders", symbol: "checklist", title: "Reminders", connected: store.settings.appleReminders)
                divider
                appleRow("notes", symbol: "note.text", title: "Notes", connected: store.settings.appleNotes)
            }
            .groupBox()
        }
    }

    private var brainStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Bring your own key")
            subtitle("An Anthropic key is required. Answers, lessons, and actions all go through it.")
            HStack(spacing: 8) {
                Image(systemName: keySaved ? "checkmark.seal.fill" : "key")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(keySaved ? OKBrand.greenInk : OKBrand.faint)
                    .frame(width: 20)
                SecureField(keySaved ? "Key saved in Keychain. Paste to replace." : "sk-ant-…", text: $anthropicKey)
                    .textFieldStyle(.plain)
                    .font(.okBody(14))
                    .onSubmit { saveKeyIfNeeded() }
            }
            .padding(.horizontal, 14)
            .frame(height: 46)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.1)))
            .padding(.top, 24)

            HStack {
                fieldLabel("How do you want to ask?")
                Spacer()
                OKSegmented(options: InputMode.allCases, label: { $0 == .voice ? "Voice" : "Typing" }, selection: $inputMode)
            }
            .padding(.top, 22)
        }
    }

    private var aboutStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Tell me about you")
            subtitle("Just once. It shapes every answer, and you can edit it in Memory.")
            ZStack(alignment: .topLeading) {
                if about.isEmpty {
                    Text("I'm a designer, I live in Figma, keep answers short…")
                        .font(.okBody(14))
                        .foregroundStyle(OKBrand.faint)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 13)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $about)
                    .font(.okBody(14))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            }
            .frame(height: 112)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.1)))
            .padding(.top, 24)
            HStack(spacing: 6) {
                ForEach(["I'm a student", "I use Figma", "Keep it short", "I'm building a startup"], id: \.self) { suggestion in
                    Button {
                        about = about.isEmpty ? suggestion : about + ", " + suggestion.lowercasedFirst
                    } label: {
                        Text(suggestion)
                            .font(.okBody(12, .medium))
                            .foregroundStyle(OKBrand.muted)
                            .padding(.horizontal, 10)
                            .frame(height: 28)
                            .background(Capsule().fill(OKBrand.ink.opacity(0.045)))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 12)
        }
    }

    private var tourStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Try it")
            subtitle("Two gestures are all you need.")
            VStack(spacing: 10) {
                tourCard(symbol: "cursorarrow.motionlines", title: "Shake your mouse",
                         detail: didShake ? "That's it. Shake again or press Esc to dismiss." : "Anywhere on screen, like scribbling out a mistake.",
                         done: didShake) { EmptyView() }
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
                Circle().fill(OKBrand.green.opacity(0.14)).frame(width: 64, height: 64)
                Image(systemName: "checkmark")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(OKBrand.greenInk)
            }
            .padding(.bottom, 22)
            title("You're all set\(name.isEmpty ? "" : ", \(firstName)").")
            subtitle("okidoki lives in your notch. It's there whenever you need it.")
            VStack(spacing: 0) {
                hintRow(keys: "Shake", detail: "Summon okidoki")
                divider
                hintRow(keys: "Esc", detail: "Dismiss")
                divider
                hintRow(keys: "⌘K", detail: "Ask from the dashboard")
            }
            .groupBox()
            .padding(.top, 24)
        }
    }

    // MARK: - Actions

    private var primaryTitle: String {
        switch step {
        case .welcome: return "Get started"
        case .brain: return "Continue"
        case .tour: return (didShake && didCircle) ? "Continue" : "Skip"
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
        case .brain:
            saveKeyIfNeeded()
            guard env.hasKey("anthropic") else { return }
            store.settings.defaultInput = inputMode
            store.saveNow()
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
        withAnimation(OKMotion.spring) { step = next }
    }

    private var keyReady: Bool {
        keySaved || !anthropicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func saveKeyIfNeeded() {
        let trimmed = anthropicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        env.saveKey(provider: "anthropic", value: trimmed)
        anthropicKey = ""
        withAnimation(OKMotion.snappy) { keySaved = env.hasKey("anthropic") }
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
            .font(.okBody(28, .semibold))
            .tracking(-0.6)
            .foregroundStyle(OKBrand.ink)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func subtitle(_ text: String) -> some View {
        Text(text)
            .font(.okBody(14.5))
            .foregroundStyle(OKBrand.muted)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.okBody(13, .medium))
            .foregroundStyle(OKBrand.ink.opacity(0.78))
            .padding(.bottom, 8)
    }

    private var divider: some View {
        Rectangle().fill(OKBrand.ink.opacity(0.06)).frame(height: 1).padding(.leading, 58)
    }

    private func iconTile(_ symbol: String, active: Bool) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(active ? OKBrand.greenInk : OKBrand.muted)
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(active ? OKBrand.green.opacity(0.13) : OKBrand.ink.opacity(0.045)))
    }

    private func statusPill(_ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
            Text(text).font(.okBody(12, .medium))
        }
        .foregroundStyle(OKBrand.greenInk)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Capsule().fill(OKBrand.green.opacity(0.12)))
    }

    private func accessRow(symbol: String, title: String, detail: String, granted: Bool, grant: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            iconTile(symbol, active: granted)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.okBody(13.5, .medium)).foregroundStyle(OKBrand.ink)
                Text(detail).font(.okBody(12)).foregroundStyle(OKBrand.faint)
            }
            Spacer(minLength: 8)
            if granted {
                statusPill("Allowed")
            } else {
                Button("Allow", action: grant).buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 58)
    }

    private func appleRow(_ id: String, symbol: String, title: String, connected: Bool) -> some View {
        HStack(spacing: 12) {
            iconTile(symbol, active: connected)
            Text(title).font(.okBody(13.5, .medium)).foregroundStyle(OKBrand.ink)
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
                .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
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
                    Text(title).font(.okBody(13.5, .medium)).foregroundStyle(OKBrand.ink)
                    Text(detail).font(.okBody(12)).foregroundStyle(done ? OKBrand.greenInk : OKBrand.faint)
                }
                Spacer()
            }
            content()
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(done ? 0.95 : 0.7)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(done ? OKBrand.green.opacity(0.35) : OKBrand.ink.opacity(0.07)))
        .animation(OKMotion.spring, value: done)
    }

    private func hintRow(keys: String, detail: String) -> some View {
        HStack(spacing: 12) {
            Text(keys)
                .font(.okBody(12, .semibold))
                .foregroundStyle(OKBrand.ink)
                .padding(.horizontal, 8)
                .frame(minWidth: 46)
                .frame(height: 26)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.1)))
            Text(detail).font(.okBody(13.5)).foregroundStyle(OKBrand.muted)
            Spacer()
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
    }
}

private extension View {
    func groupBox() -> some View {
        background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.7)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.07)))
    }
}

private extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

/// Soft green canvas with a faint grid, shared visual language with the dashboard.
private struct OnboardingCanvas: View {
    var body: some View {
        ZStack {
            Color(hex: 0xEEF2EF)
            RadialGradient(colors: [Color(hex: 0x3DDC97).opacity(0.24), .clear], center: .topLeading, startRadius: 0, endRadius: 620)
            RadialGradient(colors: [Color(hex: 0x00483C).opacity(0.12), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 560)
            Canvas { context, size in
                var path = Path()
                var x: CGFloat = 0
                while x < size.width { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)); x += 32 }
                var y: CGFloat = 0
                while y < size.height { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)); y += 32 }
                context.stroke(path, with: .color(.black.opacity(0.04)), lineWidth: 0.6)
            }
            .mask(RadialGradient(colors: [.black, .clear], center: .topLeading, startRadius: 40, endRadius: 640))
        }
        .ignoresSafeArea()
    }
}

enum OnboardStep: Int, CaseIterable {
    case welcome, access, brain, about, tour, done
}

struct TourCanvas: View {
    @Binding var done: Bool
    @State private var points: [CGPoint] = []
    @State private var active: [CGPoint] = []

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width * 0.5, y: size.height * 0.5)
            let dot = CGRect(x: center.x - 5, y: center.y - 5, width: 10, height: 10)
            context.fill(Path(ellipseIn: dot), with: .color(OKBrand.green))
            let ring = CGRect(x: center.x - 26, y: center.y - 26, width: 52, height: 52)
            context.stroke(Path(ellipseIn: ring), with: .color(OKBrand.green.opacity(0.22)),
                           style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            for stroke in [points, active] where !stroke.isEmpty {
                var path = Path()
                path.move(to: stroke[0])
                for point in stroke.dropFirst() { path.addLine(to: point) }
                context.stroke(path, with: .color(OKBrand.greenInk),
                               style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
            }
        }
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(OKBrand.ink.opacity(0.025)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(OKBrand.ink.opacity(0.06)))
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
                        withAnimation(OKMotion.spring) { done = true }
                    }
                    active = []
                }
        )
    }
}
