import SwiftUI
import OkidokiCore

// MARK: - Shared

struct DashHeader: View {
    var title: String
    var subtitle: String
    var icon: String = "spark"
    var trailing: AnyView? = nil

    var body: some View {
        PageTitle(title: title, subtitle: subtitle, icon: icon, trailing: trailing)
    }
}

struct MiniHeading: View {
    var title: String
    var count: Int? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            SectionLabel(text: title)
            if let count {
                Text("\(count)")
                    .font(.okMono(8.5, .medium))
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, 5)
                    .frame(height: 16)
                    .background(Capsule().fill(Color.primary.opacity(0.06)))
            }
            Spacer()
            if let action {
                Button { action() } label: {
                    HStack(spacing: 3) {
                        Text("see all").font(.okMono(9))
                        PixelGlyph(name: "arrow", size: 7, color: Color.secondary)
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.secondary)
            }
        }
    }
}

struct NeedsYouRow: View {
    var run: AgentRun
    @EnvironmentObject private var env: AppEnvironment
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(hex: 0x1FB57A).opacity(0.12))
                    .frame(width: 34, height: 34)
                RunKindGlyph(kind: run.kind, size: 14)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(run.title)
                        .font(.okBody(14, .medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    RiskBadge(risk: run.preview?.risk ?? .low)
                }
                Text(run.preview?.summary ?? run.prompt)
                    .font(.okMono(9.5))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            HStack(spacing: 7) {
                Button("review") { env.openDashboard(.runs, runID: run.id) }
                    .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                Button(run.kind == .borrow ? "allow once" : "do it") { env.approveRun(run.id) }
                    .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
            }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(hovering ? Color(hex: 0x1FB57A).opacity(0.05) : Color.clear)
        )
        .onHover { hovering = $0 }
        .animation(OKMotion.quick, value: hovering)
    }
}

struct LiveRunCard: View {
    var run: AgentRun
    @EnvironmentObject private var env: AppEnvironment
    @State private var hovering = false

    private var step: String {
        run.steps.first(where: { $0.status == .running })?.title
            ?? run.steps.first(where: { $0.status == .previewing })?.title
            ?? run.summary
    }

    private var doneFraction: Double {
        guard !run.steps.isEmpty else { return run.status == .done ? 1 : 0.35 }
        return Double(run.steps.filter { $0.status == .done }.count) / Double(run.steps.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                RunKindGlyph(kind: run.kind, size: 12)
                Text(run.kind.label)
                    .font(.okMono(8.5, .medium))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.secondary)
                Spacer()
                RunStatusBadge(status: run.status)
            }
            Text(run.title)
                .font(.okBody(14, .semibold))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
            Text(step.isEmpty ? "working…" : step)
                .font(.okMono(9))
                .foregroundStyle(Color.tertiary)
                .lineLimit(1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.07))
                    Capsule()
                        .fill(LinearGradient(colors: [Color(hex: 0x1FB57A), Color(hex: 0x7BE3B5)],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, geo.size.width * doneFraction))
                }
            }
            .frame(height: 3)
            HStack(spacing: 8) {
                Text(run.startedAt.map { relative($0) } ?? "queued")
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
                Spacer()
                if hovering {
                    Button { env.pauseRun(run.id) } label: {
                        PixelGlyph(name: run.status == .paused ? "play" : "pause", size: 8, color: Color.secondary)
                    }
                    .buttonStyle(.plain)
                    Button { env.stopRun(run.id) } label: {
                        PixelGlyph(name: "stop", size: 8, color: Color(hex: 0xE33B2C))
                    }
                    .buttonStyle(.plain)
                }
                Button("open") { env.openDashboard(.runs, runID: run.id) }
                    .buttonStyle(.plain)
                    .font(.okMono(9, .medium))
                    .foregroundStyle(Color.primary)
            }
        }
        .padding(14)
        .frame(width: 292, height: 148, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.001))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(LinearGradient(colors: [Color(hex: 0x1FB57A).opacity(hovering ? 0.075 : 0.04), .clear],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                )
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(hovering ? 0.14 : 0.08), lineWidth: 1))
        )
        .offset(y: hovering ? -2 : 0)
        .onHover { hovering = $0 }
        .animation(OKMotion.spring, value: hovering)
    }

    private func relative(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "\(max(1, seconds))s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h"
    }
}

struct QuickToggleTile: View {
    var glyph: String
    var title: String
    var detail: String
    @Binding var isOn: Bool
    var accent: Color = Color(hex: 0x1FB57A)

    var body: some View {
        Button {
            withAnimation(OKMotion.snappy) { isOn.toggle() }
        } label: {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(isOn ? accent.opacity(0.15) : Color.primary.opacity(0.05))
                        .frame(width: 35, height: 35)
                    PixelGlyph(name: glyph, size: 14, color: isOn ? accent : Color.secondary)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.okBody(12.5, .medium))
                        .foregroundStyle(Color.primary)
                    Text(detail)
                        .font(.okMono(8))
                        .foregroundStyle(Color.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                OKSwitch(isOn: $isOn, tint: accent, size: 0.82)
            }
            .padding(.horizontal, 12)
            .frame(height: 60)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.primary.opacity(isOn ? 0.018 : 0.008))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.primary.opacity(isOn ? 0.1 : 0.06), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }
}

struct DashStat: View {
    var value: String
    var label: String
    var accent: Color = Color(hex: 0x1FB57A)
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.okDisplay(34))
                .foregroundStyle(accent)
                .contentTransition(.numericText())
            Text(label)
                .font(.okMono(8.5))
                .textCase(.uppercase)
                .foregroundStyle(Color.tertiary)
        }
    }
}

struct SettingsCard<Content: View>: View {
    var title: String?
    var description: String?
    @ViewBuilder var content: Content

    init(title: String? = nil, description: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.description = description
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title)
                    .font(.okBody(13, .semibold))
                    .foregroundStyle(Color.primary)
            }
            if let description {
                Text(description)
                    .font(.okMono(9))
                    .foregroundStyle(Color.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(2)
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.001))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.022))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(0.075), lineWidth: 0.8)
        )
    }
}

struct SettingRow<Trailing: View>: View {
    var title: String
    var detail: String?
    @ViewBuilder var trailing: Trailing

    init(_ title: String, detail: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.detail = detail
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.okBody(12.5, .medium))
                    .foregroundStyle(Color.primary)
                if let detail {
                    Text(detail)
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 8)
    }
}

struct DashSearchField: View {
    var placeholder: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            PixelGlyph(name: "search", size: 11, color: Color.tertiary)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.okBody(12))
            if !text.isEmpty {
                Button { text = "" } label: {
                    PixelGlyph(name: "x", size: 8, color: Color.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.08), lineWidth: 0.7))
    }
}

struct TimePill: View {
    var body: some View {
        TimelineView(.everyMinute) { timeline in
            Text(timeline.date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                .font(.okMono(9))
                .textCase(.lowercase)
                .foregroundStyle(Color.secondary)
        }
    }
}

struct RunKindIcon: View {
    var kind: RunKind
    var color: Color = Color(hex: 0x1FB57A)
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(color.opacity(0.1))
                .frame(width: 34, height: 34)
            RunKindGlyph(kind: kind, size: 15)
        }
    }
}
