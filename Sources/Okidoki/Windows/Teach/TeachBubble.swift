import SwiftUI
import OkidokiCore

// MARK: - Shared lesson model

enum TeachPhase: Equatable {
    /// Screenshot in flight, model deciding the next step.
    case looking
    /// A step is on screen; the learner does it and the lesson moves on by itself.
    case waiting
    /// A risky step wants a real yes before okidoki does it on their behalf.
    case confirm
    /// The lesson wrapped up; the card lingers for a beat.
    case done
}

enum TeachMode: String {
    /// okidoki points, the learner does it.
    case guide
    /// The same lesson again with hints held back.
    case practice
}

@MainActor
final class TeachModel: ObservableObject {
    @Published var topic = ""
    @Published var appName = ""
    @Published var isActive = false
    @Published var phase: TeachPhase = .looking
    @Published var mode: TeachMode = .guide
    @Published var say = ""
    @Published var why = ""
    @Published var hint = ""
    @Published var stepNumber = 0
    @Published var remaining: Int?
    @Published var milestones: [String] = []
    @Published var milestone = 0
    @Published var stuck = false
    @Published var provisional = false
    @Published var voice = true
    @Published var summary = ""
    @Published var offerPractice = false
    @Published var hasBubble = false
    var runID: String?
    var threadID: String?
}

// MARK: - Bubble

/// The instruction, sitting next to the control it talks about.
struct TeachBubbleView: View {
    @ObservedObject var model: TeachModel
    var accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(accent).frame(width: 6, height: 6)
                    .shadow(color: accent.opacity(0.4), radius: 1.5)
                Text(statusLine)
                    .font(.okMono(8.5))
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
                if model.provisional {
                    Text("· checking")
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.white.opacity(0.4))
                }
            }
            Text(model.say.isEmpty ? "looking at \(model.appName)…" : model.say)
                .font(.okBody(13.5, .medium))
                .foregroundStyle(Color.white.opacity(0.96))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !model.why.isEmpty, model.phase != .done {
                Text(model.why)
                    .font(.okBody(11.5))
                    .foregroundStyle(Color.white.opacity(0.62))
                    .lineSpacing(1.5)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 312, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .overlayGlass(cornerRadius: 16, veil: 0.62, tone: .dark)
        .animation(OKMotion.spring, value: model.say)
        .animation(OKMotion.spring, value: model.why)
    }

    private var statusLine: String {
        switch model.phase {
        case .looking: return model.hint.isEmpty ? "looking…" : model.hint
        case .waiting: return model.hint
        case .confirm: return "wants a yes"
        case .done: return "done"
        }
    }

    private var statusColor: Color {
        if model.hint == "nice" { return accent }
        if model.stuck || model.phase == .confirm { return Color.white.opacity(0.9) }
        return Color.white.opacity(0.5)
    }
}

// MARK: - Bar

/// The slim bar at the bottom: progress, the two things you can ask for (do it, next), voice and
/// stop. The lesson follows what the learner does on its own; the buttons are for when they'd
/// rather not wait, or want okidoki's hands. Confirm and done show their buttons only in those phases.
struct TeachBarView: View {
    @ObservedObject var model: TeachModel
    @Environment(\.colorScheme) private var scheme
    var accent: Color
    var onConfirm: () -> Void
    var onSkip: () -> Void
    var onNext: () -> Void
    var onDoIt: () -> Void
    var onVoice: () -> Void
    var onPractice: () -> Void
    var onStop: () -> Void
    @State private var blink = false

    private var theme: OKTheme { OKTheme(scheme) }

    var body: some View {
        HStack(spacing: 10) {
            progress
            if model.phase == .confirm || model.phase == .done {
                Rectangle().fill(theme.line).frame(width: 1, height: 18)
                controls
            }
            Spacer(minLength: 6)
            if model.phase == .looking || model.phase == .waiting {
                actions
                Rectangle().fill(theme.line).frame(width: 1, height: 18)
            }
            trailing
        }
        .padding(.horizontal, 14)
        .frame(width: TeachBarView.width, height: 56)
        .overlayGlass(cornerRadius: 28, veil: 0.46, tone: .dark)
        .animation(OKMotion.spring, value: model.phase)
        .animation(OKMotion.spring, value: model.stuck)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { blink = true }
        }
    }

    static let width: CGFloat = 520

    /// "do it" borrows okidoki's hands for this step; "next" moves on without it, even mid-look.
    private var actions: some View {
        HStack(spacing: 6) {
            Button("do it") { onDoIt() }
                .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                .disabled(model.phase != .waiting)
                .opacity(model.phase == .waiting ? 1 : 0.45)
                .help("okidoki does this step for you")
            Button {
                onNext()
            } label: {
                HStack(spacing: 5) {
                    Text("next")
                    Text("⇧⇧")
                        .font(.okMono(8.5))
                        .opacity(0.7)
                }
            }
            .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            .help("move on · or tap shift twice")
        }
    }

    @ViewBuilder private var progress: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.12), lineWidth: 2.5).frame(width: 26, height: 26)
                Circle()
                    .trim(from: 0, to: progressFraction)
                    .stroke(accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 26, height: 26)
                    .animation(.easeOut(duration: 0.5), value: progressFraction)
                if model.phase == .done {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(accent)
                } else if model.phase == .looking {
                    Circle().fill(accent).frame(width: 5, height: 5).opacity(blink ? 1 : 0.25)
                } else {
                    Text(model.stepNumber == 0 ? "·" : "\(model.stepNumber)")
                        .font(.okMono(10, .medium))
                        .foregroundStyle(Color.white.opacity(0.9))
                        .contentTransition(.numericText())
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(model.topic)
                    .font(.okMono(8.5, .medium))
                    .textCase(.uppercase)
                    .foregroundStyle(accent)
                    .lineLimit(1)
                    .frame(maxWidth: 170, alignment: .leading)
                if !model.milestones.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(Array(model.milestones.enumerated()), id: \.offset) { index, _ in
                            Capsule()
                                .fill(index < model.milestone ? accent : (index == model.milestone ? accent.opacity(0.9) : Color.white.opacity(0.18)))
                                .frame(width: index == model.milestone ? 16 : 8, height: 3)
                        }
                        Text(model.milestones.indices.contains(model.milestone) ? model.milestones[model.milestone] : "")
                            .font(.okMono(8))
                            .foregroundStyle(theme.tertiary)
                            .lineLimit(1)
                            .frame(maxWidth: 130, alignment: .leading)
                    }
                    .animation(OKMotion.spring, value: model.milestone)
                } else {
                    Text(model.appName)
                        .font(.okMono(8))
                        .foregroundStyle(theme.tertiary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var progressFraction: CGFloat {
        if model.phase == .done { return 1 }
        guard model.stepNumber > 0 else { return 0 }
        let total = CGFloat(model.stepNumber + (model.remaining ?? max(1, 6 - model.stepNumber)))
        return min(0.96, CGFloat(model.stepNumber) / max(1, total))
    }

    @ViewBuilder private var controls: some View {
        switch model.phase {
        case .confirm:
            HStack(spacing: 7) {
                Text("this one can't be undone")
                    .font(.okBody(11.5, .medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                Button("do it") { onConfirm() }
                    .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
                Button("skip") { onSkip() }
                    .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
            }
        case .done:
            HStack(spacing: 7) {
                if model.offerPractice {
                    Button("your turn?") { onPractice() }
                        .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                }
                Button("done") { onStop() }
                    .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var trailing: some View {
        HStack(spacing: 8) {
            Button {
                onVoice()
            } label: {
                Image(systemName: model.voice ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(model.voice ? Color.white.opacity(0.85) : theme.tertiary)
            }
            .buttonStyle(.plain)
            .help(model.voice ? "voice on" : "voice off")
            Text("esc")
                .font(.okMono(8))
                .foregroundStyle(theme.tertiary.opacity(0.7))
            Button {
                onStop()
            } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                    .foregroundStyle(theme.tertiary)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(Color.white.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .help("stop the lesson")
        }
    }
}

// MARK: - Recap

/// What they learned, shown on the answer card at the end.
enum TeachRecap {
    static func text(topic: String, app: String, steps: [TeachLogEntry], summary: String) -> String {
        var lines: [String] = []
        if !summary.isEmpty { lines.append(summary) }
        let shown = steps.filter { $0.action != "look" || !$0.say.isEmpty }
        if !shown.isEmpty {
            lines.append("")
            lines.append("**what you did**")
            for (index, step) in shown.prefix(12).enumerated() {
                lines.append("\(index + 1). \(step.say)")
            }
        }
        let keys = steps.compactMap { entry -> String? in
            guard entry.action == "key", let range = entry.say.range(of: #"(⌘|⌥|⌃|⇧|cmd|command|option|shift|ctrl|control)[^.,;]*"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
            return String(entry.say[range]).trimmingCharacters(in: .whitespaces)
        }
        if !keys.isEmpty {
            lines.append("")
            lines.append("**shortcuts**: " + Array(Set(keys)).prefix(6).joined(separator: " · "))
        }
        lines.append("")
        lines.append("_in \(app). say \"teach me \(topic)\" again any time._")
        return lines.joined(separator: "\n")
    }
}
