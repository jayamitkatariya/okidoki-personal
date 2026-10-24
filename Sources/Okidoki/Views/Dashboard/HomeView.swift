import SwiftUI
import OkidokiCore

struct HomeView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12: return "morning"
        case 12..<17: return "afternoon"
        case 17..<22: return "evening"
        default: return "night"
        }
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 22) {
                header
                    .reveal(0)
                askBar
                    .reveal(0.04)
                mainRow
                quickToggles
                    .reveal(0.12)
                bottomRow
                    .reveal(0.16)
                footer
                    .padding(.top, 4)
            }
            .padding(.horizontal, 34)
            .padding(.top, 26)
            .padding(.bottom, 36)
            .frame(maxWidth: 1220, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .bottom, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: Date().formatted(.dateTime.weekday(.wide).month(.wide).day()))
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    ScrambleText(text: "good \(greeting),", font: .okDisplay(50), color: Color.primary)
                    Text(store.activeAccount.firstName)
                        .font(.okDisplay(50))
                        .foregroundStyle(Color(hex: 0x1FB57A))
                }
                Text("here's what's moving. \(store.waitingRuns.isEmpty ? "nothing needs you right now." : "\(store.waitingRuns.count) thing\(store.waitingRuns.count == 1 ? "" : "s") could use a yes.")")
                    .font(.okMono(10))
                    .foregroundStyle(Color.secondary)
                    .lineSpacing(2)
            }
            Spacer(minLength: 0)
            ZStack {
                OKOrb(size: 118, intensity: 0.8)
                OKLogo(size: 34, glow: true)
            }
            .frame(width: 130, height: 100)
            .offset(y: 4)
        }
    }

    private var askBar: some View {
        Button {
            env.requestAsk()
        } label: {
            HStack(spacing: 13) {
                ZStack {
                    Circle().fill(Color(hex: 0x1FB57A).opacity(0.1)).frame(width: 34, height: 34)
                    PixelGlyph(name: "search", size: 13, color: Color(hex: 0x1FB57A))
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("ask okidoki anything…")
                        .font(.okBody(14, .medium))
                        .foregroundStyle(Color.primary)
                    Text("answer, do, teach, or watch — you never pick a mode")
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.tertiary)
                }
                Spacer()
                HStack(spacing: 6) {
                    PixelGlyph(name: store.settings.defaultInput == .voice ? "mic" : "pencil", size: 9, color: Color.secondary)
                    Text(store.settings.defaultInput.label)
                        .font(.okMono(8.5))
                        .textCase(.lowercase)
                        .foregroundStyle(Color.secondary)
                }
                .padding(.horizontal, 8)
                .frame(height: 24)
                .background(Capsule().fill(Color.primary.opacity(0.045)))
                Text("⌘K")
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
                    .padding(.horizontal, 6)
                    .frame(height: 20)
                    .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(0.05)))
            }
            .padding(.horizontal, 14)
            .frame(height: 62)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(Color.primary.opacity(0.026))
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(LinearGradient(colors: [Color(hex: 0x1FB57A).opacity(0.05), .clear],
                                             startPoint: .leading, endPoint: .trailing))
                }
            )
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 0.8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Main

    private var mainRow: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 16) {
                needsYou
                    .reveal(0.07)
                liveWork
                    .reveal(0.1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 16) {
                glance
                    .reveal(0.06)
                memoryPreview
                    .reveal(0.09)
                toolboxPreview
                    .reveal(0.12)
            }
            .frame(width: 312)
        }
    }

    private var needsYou: some View {
        VStack(alignment: .leading, spacing: 10) {
            MiniHeading(title: "needs you", count: store.waitingRuns.count)
            if store.waitingRuns.isEmpty {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color(hex: 0x4CD97B).opacity(0.12)).frame(width: 42, height: 42)
                        PixelGlyph(name: "check", size: 17, color: Color(hex: 0x3E8E5B))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("nothing needs you.")
                            .font(.okDisplay(26))
                            .foregroundStyle(Color.primary)
                        Text("approvals and action previews land here before anything runs.")
                            .font(.okMono(9))
                            .foregroundStyle(Color.tertiary)
                    }
                    Spacer()
                }
                .padding(15)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.022))
                )
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.07), lineWidth: 0.8))
            } else {
                VStack(spacing: 0) {
                    ForEach(store.waitingRuns.prefix(4)) { run in
                        NeedsYouRow(run: run)
                        if run.id != store.waitingRuns.prefix(4).last?.id {
                            Rectangle().fill(Color.primary.opacity(0.055)).frame(height: 1).padding(.horizontal, 12)
                        }
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.022))
                )
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.075), lineWidth: 0.8))
            }
        }
    }

    private var liveWork: some View {
        VStack(alignment: .leading, spacing: 10) {
            MiniHeading(title: "live", count: store.liveRuns.count, action: { env.openDashboard(.runs) })
            if store.liveRuns.isEmpty {
                HStack(spacing: 12) {
                    PixelGlyph(name: "cursor", size: 16, color: Color.tertiary)
                    Text("no runs in the air. shake your mouse and give me something.")
                        .font(.okMono(9.5))
                        .foregroundStyle(Color.tertiary)
                    Spacer()
                    Button("open runs") { env.openDashboard(.runs) }
                        .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                }
                .padding(15)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.018)))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.065), lineWidth: 0.8))
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(store.liveRuns) { run in
                            LiveRunCard(run: run)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private var glance: some View {
        VStack(alignment: .leading, spacing: 14) {
            MiniHeading(title: "at a glance")
            HStack(alignment: .top, spacing: 18) {
                DashStat(value: "\(store.waitingRuns.count)", label: "waiting")
                DashStat(value: "\(store.liveRuns.filter { $0.status == .running }.count)", label: "running", accent: Color(hex: 0x3E8E5B))
                DashStat(value: "\(store.memories.count)", label: "memories", accent: Color(hex: 0x6C6CF8))
            }
            Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 1)
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("saved in subscriptions")
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.tertiary)
                    Text("$\(Int(store.savings))")
                        .font(.okDisplay(30))
                        .foregroundStyle(Color(hex: 0x3E8E5B))
                }
                Spacer()
                Text("\(store.installedToolCount) free tools")
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
            }
        }
        .okCard(hoverable: false, padding: 15)
    }

    private var memoryPreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            MiniHeading(title: "okidoki remembers", count: store.memories.count, action: { env.openDashboard(.memory) })
            if store.memories.isEmpty {
                Text("tell me about yourself once. “i'm a student, i use figma and vs code, keep it short.”")
                    .font(.okMono(9.5))
                    .foregroundStyle(Color.tertiary)
                    .lineSpacing(2)
                Button("teach it about me") { env.openOnboarding() }
                    .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(store.memories.prefix(3)) { memory in
                        HStack(alignment: .top, spacing: 7) {
                            Rectangle().fill(Color(hex: 0x6C6CF8).opacity(0.7)).frame(width: 3, height: 3).offset(y: 6)
                            Text(memory.text)
                                .font(.okBody(11))
                                .foregroundStyle(Color.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                Button("see all memory") { env.openDashboard(.memory) }
                    .buttonStyle(.plain)
                    .font(.okMono(8.5, .medium))
                    .foregroundStyle(Color(hex: 0x1FB57A))
            }
        }
        .okCard(hoverable: true, padding: 15)
    }

    private var toolboxPreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            MiniHeading(title: "toolbox", action: { env.openDashboard(.toolbox) })
            HStack(spacing: 8) {
                ForEach(ToolCatalog.tools.filter { store.toolInstalled[$0.id] == true }.prefix(5)) { tool in
                    HStack(spacing: 4) {
                        Rectangle().fill(Color(hex: 0xB8F26B)).frame(width: 4, height: 4)
                        Text(tool.name)
                            .font(.okMono(8))
                            .foregroundStyle(Color.secondary)
                    }
                    .padding(.horizontal, 6)
                    .frame(height: 20)
                    .background(Capsule().fill(Color.primary.opacity(0.045)))
                }
                if store.installedToolCount == 0 {
                    Text("no tools yet — mole, ffmpeg, pandoc and friends are one click away.")
                        .font(.okMono(9))
                        .foregroundStyle(Color.tertiary)
                }
            }
            Button("open toolbox") { env.openDashboard(.toolbox) }
                .buttonStyle(.plain)
                .font(.okMono(8.5, .medium))
                .foregroundStyle(Color(hex: 0x1FB57A))
        }
        .okCard(hoverable: true, padding: 15)
    }

    // MARK: Quick toggles

    private var quickToggles: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                MiniHeading(title: "quick toggles")
                Spacer()
                Text("settings are one click away")
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9)], spacing: 9) {
                QuickToggleTile(glyph: "spark", title: "okidoki", detail: store.settings.okidokiEnabled ? "shake to summon" : "paused", isOn: $store.settings.okidokiEnabled)
                QuickToggleTile(glyph: "runs", title: "background", detail: "quiet batch work", isOn: $store.settings.backgroundMode, accent: Color(hex: 0x3E8E5B))
                QuickToggleTile(glyph: "hand", title: "borrow screen", detail: "ghost cursor, with a yes", isOn: $store.settings.screenBorrowing, accent: Color(hex: 0x6C6CF8))
                QuickToggleTile(glyph: "mic", title: "voice", detail: store.settings.defaultInput == .voice ? "default input" : "spoken answers", isOn: $store.settings.voiceEnabled, accent: Color(hex: 0xC9A7FF))
                QuickToggleTile(glyph: "eye", title: "captions", detail: "when i speak", isOn: $store.settings.captions, accent: Color(hex: 0x8FB7FF))
                QuickToggleTile(glyph: "moon", title: "quiet mode", detail: "silent in calls", isOn: $store.settings.quietMode, accent: Color(hex: 0x8FB7FF))
            }
            .onChange(of: store.settings.okidokiEnabled) { _, _ in store.saveNow() }
            .onChange(of: store.settings.backgroundMode) { _, _ in store.saveNow() }
            .onChange(of: store.settings.screenBorrowing) { _, _ in store.saveNow() }
            .onChange(of: store.settings.voiceEnabled) { _, _ in store.saveNow() }
            .onChange(of: store.settings.captions) { _, _ in store.saveNow() }
            .onChange(of: store.settings.quietMode) { _, _ in store.saveNow() }
        }
    }

    // MARK: Bottom

    private var bottomRow: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 10) {
                MiniHeading(title: "routines", count: store.activeRoutines.count, action: { env.openDashboard(.skills) })
                if store.activeRoutines.isEmpty {
                    HStack(spacing: 9) {
                        PixelGlyph(name: "clock", size: 13, color: Color.tertiary)
                        Text("“every friday at 5, clean my downloads folder.”")
                            .font(.okMono(9.5))
                            .foregroundStyle(Color.tertiary)
                        Spacer()
                    }
                    .padding(13)
                } else {
                    VStack(spacing: 0) {
                        ForEach(store.activeRoutines.prefix(3)) { routine in
                            HStack(spacing: 10) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 7).fill(Color(hex: 0x1FB57A).opacity(0.09)).frame(width: 28, height: 28)
                                    PixelGlyph(name: "clock", size: 11, color: Color(hex: 0x1FB57A))
                                }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(routine.name)
                                        .font(.okBody(11.5, .medium))
                                        .foregroundStyle(Color.primary)
                                        .lineLimit(1)
                                    Text(routine.scheduleLabel + " · next " + (routine.nextRunAt.map { relative($0) } ?? "manual"))
                                        .font(.okMono(8))
                                        .foregroundStyle(Color.tertiary)
                                }
                                Spacer()
                                Button("run") { env.runRoutine(routine) }
                                    .buttonStyle(.plain)
                                    .font(.okMono(8.5, .medium))
                                    .foregroundStyle(Color(hex: 0x1FB57A))
                            }
                            .padding(.horizontal, 12)
                            .frame(height: 46)
                            if routine.id != store.activeRoutines.prefix(3).last?.id {
                                Rectangle().fill(Color.primary.opacity(0.05)).frame(height: 1).padding(.horizontal, 12)
                            }
                        }
                    }
                }
            }
            .okCard(hoverable: false, padding: 14)

            VStack(alignment: .leading, spacing: 10) {
                MiniHeading(title: "recently", action: { env.openDashboard(.history) })
                if store.recentRuns.isEmpty {
                    Text("nothing yet.")
                        .font(.okMono(9.5))
                        .foregroundStyle(Color.tertiary)
                } else {
                    VStack(spacing: 0) {
                        ForEach(store.recentRuns.prefix(3)) { run in
                            Button {
                                env.openDashboard(.runs, runID: run.id)
                            } label: {
                                HStack(spacing: 9) {
                                    RunKindGlyph(kind: run.kind, size: 12)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(run.title)
                                            .font(.okBody(11.5, .medium))
                                            .foregroundStyle(Color.primary)
                                            .lineLimit(1)
                                        Text(run.summary.isEmpty ? run.status.label : run.summary)
                                            .font(.okMono(8))
                                            .foregroundStyle(Color.tertiary)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    RunStatusBadge(status: run.status)
                                }
                                .padding(.horizontal, 12)
                                .frame(height: 46)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if run.id != store.recentRuns.prefix(3).last?.id {
                                Rectangle().fill(Color.primary.opacity(0.05)).frame(height: 1).padding(.horizontal, 12)
                            }
                        }
                    }
                }
            }
            .okCard(hoverable: false, padding: 14)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            PixelGlyph(name: "lock", size: 9, color: Color.tertiary)
            Text("open source · your keys live in the keychain · screenshots are never stored")
                .font(.okMono(8))
                .foregroundStyle(Color.tertiary)
            Spacer()
            Text("okidoki 0.9")
                .font(.okMono(8))
                .foregroundStyle(Color.tertiary.opacity(0.7))
        }
    }

    private func relative(_ date: Date) -> String {
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) { formatter.dateFormat = "h:mm a" }
        else { formatter.dateFormat = "EEE h:mm a" }
        return formatter.string(from: date)
    }
}
