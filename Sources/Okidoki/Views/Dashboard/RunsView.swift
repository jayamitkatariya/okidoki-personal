import SwiftUI
import AppKit
import OkidokiCore

enum RunFilter: String, CaseIterable, Identifiable {
    case all, waiting, running, done, failed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "all"
        case .waiting: return "waiting"
        case .running: return "running"
        case .done: return "done"
        case .failed: return "failed"
        }
    }
}

struct RunsView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore
    @State private var filter: RunFilter = .all
    @State private var query = ""
    @State private var selectedID: String?
    @State private var showRedirect = false
    @State private var redirectText = ""

    private var filtered: [AgentRun] {
        store.recentRuns.filter { run in
            let matchesFilter: Bool
            switch filter {
            case .all: matchesFilter = true
            case .waiting: matchesFilter = run.status == .waiting || run.status == .previewing
            case .running: matchesFilter = run.status == .running || run.status == .paused
            case .done: matchesFilter = run.status == .done
            case .failed: matchesFilter = run.status == .failed || run.status == .cancelled
            }
            let matchesQuery = query.isEmpty || run.title.localizedCaseInsensitiveContains(query) || run.prompt.localizedCaseInsensitiveContains(query)
            return matchesFilter && matchesQuery
        }
    }

    private var selected: AgentRun? {
        if let selectedID, let run = store.run(selectedID) { return run }
        return filtered.first
    }

    var body: some View {
        HStack(spacing: 0) {
            listPane
            Rectangle().fill(Color.primary.opacity(0.07)).frame(width: 1)
            detailPane
        }
        .onAppear {
            if let id = env.dashboardRunID, store.run(id) != nil {
                selectedID = id
            } else if selectedID == nil {
                selectedID = filtered.first?.id
            }
        }
        .onChange(of: env.dashboardRunID) { _, id in
            if let id, store.run(id) != nil { selectedID = id }
        }
        .onChange(of: filter) { _, _ in
            if let selected, !filtered.contains(where: { $0.id == selected.id }) {
                selectedID = filtered.first?.id
            }
        }
        .sheet(isPresented: $showRedirect) {
            redirectSheet
                .okPreferredScheme(store.settings.appearance)
        }
    }

    // MARK: List

    private var listPane: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text("runs")
                    .font(.okDisplay(38))
                    .foregroundStyle(Color.primary)
                Text("\(store.recentRuns.count)")
                    .font(.okMono(9))
                    .foregroundStyle(Color.tertiary)
                Spacer()
            }
            .padding(.top, 25)
            Text("action previews, live progress, plan vs actual")
                .font(.okMono(9))
                .foregroundStyle(Color.tertiary)
            DashSearchField(placeholder: "search runs", text: $query)
            HStack(spacing: 4) {
                ForEach(RunFilter.allCases) { item in
                    Button {
                        withAnimation(OKMotion.snappy) { filter = item }
                    } label: {
                        Text(item.label)
                            .font(.okMono(8.5, filter == item ? .medium : .regular))
                            .foregroundStyle(filter == item ? Color(hex: 0x171512) : Color.secondary)
                            .padding(.horizontal, 8)
                            .frame(height: 25)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(filter == item ? Color(hex: 0xFFFCF6) : .clear)
                                    .shadow(color: filter == item ? .black.opacity(0.08) : .clear, radius: 2, y: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(3)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.045)))

            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 4) {
                    ForEach(filtered) { run in
                        Button {
                            withAnimation(OKMotion.quick) { selectedID = run.id }
                        } label: {
                            RunListRow(run: run, selected: selected?.id == run.id)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 20)
            }
        }
        .padding(.horizontal, 20)
        .frame(width: 342)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: Detail

    @ViewBuilder private var detailPane: some View {
        if let run = selected {
            RunDetailView(run: run, showRedirect: $showRedirect, redirectText: $redirectText)
                .id(run.id)
                .transition(.opacity.combined(with: .offset(y: 4)))
        } else {
            VStack(spacing: 14) {
                PixelGlyph(name: "runs", size: 34, color: Color.tertiary)
                Text(filtered.isEmpty ? "no runs here." : "pick a run.")
                    .font(.okDisplay(34))
                    .foregroundStyle(Color.primary)
                Text(filtered.isEmpty ? "shake your mouse and ask for something. every run shows its plan first." : "the full action preview and plan-vs-actual live here.")
                    .font(.okMono(9.5))
                    .foregroundStyle(Color.tertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 330)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var redirectSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("redirect this run")
                .font(.okDisplay(32))
                .foregroundStyle(Color.primary)
            Text("i'll stop the current run and use your note as the next instruction. the thread stays together.")
                .font(.okMono(9))
                .foregroundStyle(Color.tertiary)
            TextField("actually, do it this way…", text: $redirectText)
                .textFieldStyle(.plain)
                .font(.okBody(13))
                .padding(.horizontal, 11)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.045)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.08)))
            HStack {
                Button("cancel") { showRedirect = false }
                    .buttonStyle(OKButtonStyle(kind: .ghost))
                Spacer()
                Button("redirect") {
                    if let run = selected {
                        env.redirectRun(run.id, instruction: redirectText)
                    }
                    redirectText = ""
                    showRedirect = false
                }
                .buttonStyle(OKButtonStyle(kind: .primary))
                .disabled(redirectText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 470)
        .background(OKPaperBackground())
    }
}

struct RunListRow: View {
    var run: AgentRun
    var selected: Bool
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(selected ? Color.white.opacity(0.45) : Color.primary.opacity(0.04))
                    .frame(width: 30, height: 30)
                RunKindGlyph(kind: run.kind, size: 12)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(run.title)
                    .font(.okBody(11.5, .medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(run.summary.isEmpty ? run.status.label : run.summary)
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Text(run.kind.label)
                        .font(.okMono(7.5))
                        .textCase(.uppercase)
                        .foregroundStyle(Color.tertiary)
                    Text("·")
                        .font(.okMono(7.5))
                        .foregroundStyle(Color.tertiary)
                    Text(relative(run.createdAt))
                        .font(.okMono(7.5))
                        .foregroundStyle(Color.tertiary)
                }
            }
            Spacer(minLength: 0)
            if run.status == .waiting {
                Circle().fill(Color(hex: 0x1FB57A)).frame(width: 5, height: 5).offset(y: 4)
            } else if run.status == .running {
                PixelSpinner(size: 9, color: Color(hex: 0x3E8E5B)).offset(y: 2)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(selected ? Color.white.opacity(0.7) : (hovering ? Color.primary.opacity(0.025) : .clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 9)
                .stroke(selected ? Color.black.opacity(0.08) : .clear, lineWidth: 0.8)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    private func relative(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86400)d ago"
    }
}

struct RunDetailView: View {
    var run: AgentRun
    @Binding var showRedirect: Bool
    @Binding var redirectText: String
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore
    @State private var showRawOutput = false
    @State private var showCommands = true

    private var live: Bool { run.status == .running || run.status == .waiting || run.status == .paused }
    private var displayOutput: String {
        if showRawOutput { return run.output }
        return String(run.output.suffix(12_000))
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 18) {
                header
                if run.status == .waiting { waitingBanner }
                if let preview = run.preview { previewCard(preview) }
                planCard
                if !run.output.isEmpty { outputCard }
                if run.status == .done || run.status == .failed || run.status == .cancelled { resultCard }
                footer
            }
            .padding(.horizontal, 30)
            .padding(.top, 25)
            .padding(.bottom, 36)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RunKindGlyph(kind: run.kind, size: 13)
                Text(run.kind.label)
                    .font(.okMono(9, .medium))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.secondary)
                if let risk = run.preview?.risk { RiskBadge(risk: risk) }
                Spacer()
                RunStatusBadge(status: run.status)
                if run.status == .running || run.status == .paused {
                    Button { env.pauseRun(run.id) } label: {
                        HStack(spacing: 5) {
                            PixelGlyph(name: run.status == .paused ? "play" : "pause", size: 8, color: Color.secondary)
                            Text(run.status == .paused ? "resume" : "pause").font(.okMono(8.5))
                        }
                    }
                    .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                }
                if live {
                    Button { env.stopRun(run.id) } label: {
                        Text("stop").font(.okMono(8.5, .medium))
                    }
                    .buttonStyle(OKButtonStyle(kind: .danger, compact: true))
                }
            }
            Text(run.title)
                .font(.okDisplay(46))
                .foregroundStyle(Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 7) {
                Text("“")
                    .font(.okSerif(18))
                    .foregroundStyle(Color(hex: 0x1FB57A).opacity(0.5))
                Text(run.prompt)
                    .font(.okMono(10))
                    .foregroundStyle(Color.secondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 2)
            HStack(spacing: 12) {
                meta("started", run.createdAt.formatted(.dateTime.hour().minute()))
                if let started = run.startedAt { meta("running", duration(from: started, to: run.endedAt ?? Date())) }
                if let threadID = run.threadID, let thread = store.thread(threadID) {
                    Button {
                        env.openDashboard(.history)
                    } label: {
                        HStack(spacing: 4) {
                            PixelGlyph(name: "link", size: 7, color: Color.tertiary)
                            Text(thread.title).font(.okMono(8)).foregroundStyle(Color.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if let agent = run.agent { meta("agent", agent.displayName) }
                Spacer()
                if live {
                    Button("redirect") { showRedirect = true }
                        .buttonStyle(.plain)
                        .font(.okMono(8.5))
                        .foregroundStyle(Color(hex: 0x1FB57A))
                }
            }
        }
    }

    private var waitingBanner: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Color(hex: 0x1FB57A).opacity(0.12)).frame(width: 34, height: 34)
                PixelGlyph(name: "hand", size: 14, color: Color(hex: 0x1FB57A))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("waiting for your okay")
                    .font(.okBody(12.5, .medium))
                    .foregroundStyle(Color.primary)
                Text("nothing runs until you say so. the exact commands are below.")
                    .font(.okMono(8.5))
                    .foregroundStyle(Color.tertiary)
            }
            Spacer()
            Button("not now") { env.denyRun(run.id) }
                .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
            Button("allow once") { env.approveRun(run.id) }
                .buttonStyle(OKButtonStyle(kind: .primary, compact: true))
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 13).fill(Color(hex: 0x1FB57A).opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(Color(hex: 0x1FB57A).opacity(0.18), lineWidth: 0.8))
    }

    private func previewCard(_ preview: ActionPreview) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                SectionLabel(text: "action preview")
                Spacer()
                RiskBadge(risk: preview.risk)
                Button {
                    showCommands.toggle()
                } label: {
                    Text(showCommands ? "hide commands" : "show commands")
                        .font(.okMono(8))
                        .foregroundStyle(Color.tertiary)
                }
                .buttonStyle(.plain)
            }
            Text(preview.summary)
                .font(.okBody(13))
                .foregroundStyle(Color.primary)
                .lineSpacing(2)
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("steps").font(.okMono(8)).textCase(.uppercase).foregroundStyle(Color.tertiary)
                    ForEach(Array(preview.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 7) {
                            Text("\(index + 1)")
                                .font(.okMono(7.5, .medium))
                                .foregroundStyle(Color(hex: 0x1FB57A))
                                .frame(width: 12)
                            Text(step.text)
                                .font(.okBody(11))
                                .foregroundStyle(Color.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !preview.apps.isEmpty || !preview.files.isEmpty {
                    VStack(alignment: .leading, spacing: 7) {
                        if !preview.apps.isEmpty {
                            Text("apps").font(.okMono(8)).textCase(.uppercase).foregroundStyle(Color.tertiary)
                            ForEach(preview.apps, id: \.self) { app in
                                Text(app).font(.okMono(9)).foregroundStyle(Color.secondary)
                            }
                        }
                        if !preview.files.isEmpty {
                            Text("files").font(.okMono(8)).textCase(.uppercase).foregroundStyle(Color.tertiary).padding(.top, 3)
                            ForEach(preview.files.prefix(3), id: \.self) { file in
                                Text(file.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                                    .font(.okMono(8.5))
                                    .foregroundStyle(Color.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    .frame(width: 190, alignment: .leading)
                }
            }
            if showCommands && !preview.commands.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("raw commands")
                            .font(.okMono(8))
                            .textCase(.uppercase)
                            .foregroundStyle(Color.white.opacity(0.35))
                        Spacer()
                        Button("copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(preview.commands.joined(separator: "\n"), forType: .string)
                        }
                        .buttonStyle(.plain)
                        .font(.okMono(8))
                        .foregroundStyle(Color.white.opacity(0.45))
                    }
                    ForEach(Array(preview.commands.enumerated()), id: \.offset) { _, command in
                        Text("$ " + command)
                            .font(.okMono(9))
                            .foregroundStyle(Color(hex: 0xE8E1D5))
                            .textSelection(.enabled)
                    }
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: 0x191816)))
            }
        }
        .okCard(hoverable: false, padding: 16)
    }

    private var planCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionLabel(text: "plan vs actual")
                Spacer()
                Text("\(run.steps.filter { $0.status == .done }.count)/\(max(1, run.steps.count)) steps")
                    .font(.okMono(8.5))
                    .foregroundStyle(Color.tertiary)
            }
            if run.steps.isEmpty {
                Text("this run has no steps — it's a single action.")
                    .font(.okMono(9))
                    .foregroundStyle(Color.tertiary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(run.steps.enumerated()), id: \.element.id) { index, step in
                        HStack(spacing: 10) {
                            ZStack {
                                Circle()
                                    .fill(step.status == .done ? Color(hex: 0x3E8E5B).opacity(0.12) : (step.status == .running ? Color(hex: 0x1FB57A).opacity(0.12) : Color.primary.opacity(0.05)))
                                    .frame(width: 23, height: 23)
                                if step.status == .done {
                                    PixelGlyph(name: "check", size: 8, color: Color(hex: 0x3E8E5B))
                                } else if step.status == .running {
                                    PixelSpinner(size: 8, color: Color(hex: 0x1FB57A))
                                } else if step.status == .failed {
                                    PixelGlyph(name: "x", size: 8, color: Color(hex: 0xE33B2C))
                                } else {
                                    Text("\(index + 1)").font(.okMono(7.5)).foregroundStyle(Color.tertiary)
                                }
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(step.title)
                                    .font(.okBody(11.5))
                                    .foregroundStyle(Color.primary)
                                if !step.detail.isEmpty {
                                    Text(step.detail).font(.okMono(8)).foregroundStyle(Color.tertiary)
                                }
                            }
                            Spacer()
                            Text(step.status.label)
                                .font(.okMono(8))
                                .foregroundStyle(Color.tertiary)
                        }
                        .padding(.vertical, 7)
                        if index != run.steps.count - 1 {
                            Rectangle().fill(Color.primary.opacity(0.05)).frame(height: 1).padding(.leading, 33)
                        }
                    }
                }
            }
        }
        .okCard(hoverable: false, padding: 16)
    }

    private var outputCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                SectionLabel(text: "output")
                if run.status == .running {
                    HStack(spacing: 4) {
                        StatusDot(color: Color(hex: 0x4CD97B), size: 4)
                        Text("live").font(.okMono(7.5)).foregroundStyle(Color(hex: 0x3E8E5B))
                    }
                }
                Spacer()
                Button(showRawOutput ? "tail" : "everything") { showRawOutput.toggle() }
                    .buttonStyle(.plain)
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
                Button("copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(run.output, forType: .string)
                }
                .buttonStyle(.plain)
                .font(.okMono(8))
                .foregroundStyle(Color.tertiary)
            }
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    Text(displayOutput.isEmpty ? "waiting for output…" : displayOutput)
                        .font(.okMono(9))
                        .foregroundStyle(Color(hex: 0xD8D2C7))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(11)
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxHeight: 280)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color(hex: 0x141311)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.08), lineWidth: 0.6))
                .onChange(of: run.output) { _, _ in
                    withAnimation(OKMotion.quick) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    private var resultCard: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill((run.status == .done ? Color(hex: 0x4CD97B) : Color(hex: 0xE33B2C)).opacity(0.12))
                    .frame(width: 42, height: 42)
                PixelGlyph(name: run.status == .done ? "check" : "x", size: 17,
                           color: run.status == .done ? Color(hex: 0x3E8E5B) : Color(hex: 0xE33B2C))
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(run.status == .done ? "done" : "didn't finish")
                    .font(.okDisplay(30))
                    .foregroundStyle(Color.primary)
                Text(run.summary.isEmpty ? run.status.label : run.summary)
                    .font(.okMono(9))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
            }
            Spacer()
            if let freed = run.freedBytes {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(Bytes.human(freed))
                        .font(.okDisplay(34))
                        .foregroundStyle(Color(hex: 0x3E8E5B))
                    Text("freed").font(.okMono(8)).textCase(.uppercase).foregroundStyle(Color.tertiary)
                }
            }
            if run.kind == .teach {
                Button("walkthrough again") { env.startTeach(topic: run.title, runID: nil, threadID: run.threadID) }
                    .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            } else {
                Button("run again") { env.askFromDashboard(run.prompt) }
                    .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
            }
        }
        .okCard(hoverable: false, padding: 15)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            PixelGlyph(name: "lock", size: 8, color: Color.tertiary)
            Text("every command ran on this mac. nothing was uploaded except what you approved.")
                .font(.okMono(8))
                .foregroundStyle(Color.tertiary)
            Spacer()
            Button("open data folder") {
                NSWorkspace.shared.open(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Okidoki"))
            }
            .buttonStyle(.plain)
            .font(.okMono(8))
            .foregroundStyle(Color.tertiary)
        }
    }

    private func meta(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.okMono(8)).textCase(.uppercase).foregroundStyle(Color.tertiary)
            Text(value).font(.okMono(8)).foregroundStyle(Color.secondary)
        }
    }

    private func duration(from start: Date, to end: Date) -> String {
        let seconds = max(1, Int(end.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }
}
