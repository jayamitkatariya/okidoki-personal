import SwiftUI
import OkidokiCore

enum HistoryTab: String, CaseIterable, Identifiable {
    case requests, threads
    var id: String { rawValue }
    var label: String { rawValue }
}

struct HistoryView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore
    @State private var tab: HistoryTab = .requests
    @State private var query = ""
    @State private var expandedRun: String?
    @State private var openThread: ChatThread?
    @State private var showArchived = false

    private var runs: [AgentRun] {
        store.recentRuns.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.prompt.localizedCaseInsensitiveContains(query) }
    }

    private var threads: [ChatThread] {
        store.activeThreads.filter { thread in
            (showArchived || !thread.archived) &&
            (query.isEmpty || thread.title.localizedCaseInsensitiveContains(query) || thread.messages.contains { $0.text.localizedCaseInsensitiveContains(query) })
        }
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "everything you've asked")
                        ScrambleText(text: "history", font: .okDisplay(50), color: Color.primary)
                        Text("threads continue where you left off. every past request keeps its plan and what actually happened.")
                            .font(.okMono(9.5))
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    OKSegmented(options: HistoryTab.allCases, label: { $0.label }, selection: $tab)
                }
                .reveal(0)

                HStack(spacing: 10) {
                    DashSearchField(placeholder: tab == .requests ? "search requests" : "search threads", text: $query)
                        .frame(maxWidth: 340)
                    if tab == .threads {
                        Button {
                            showArchived.toggle()
                        } label: {
                            HStack(spacing: 5) {
                                PixelGlyph(name: "folder", size: 8, color: showArchived ? Color(hex: 0x1FB57A) : Color.tertiary)
                                Text(showArchived ? "hiding archived" : "show archived")
                                    .font(.okMono(8.5))
                                    .foregroundStyle(showArchived ? Color.primary : Color.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                    Text(tab == .requests ? "\(runs.count) requests" : "\(threads.count) threads")
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.tertiary)
                }
                .reveal(0.04)

                if tab == .requests {
                    requestsList
                } else {
                    threadsList
                }
            }
            .padding(.horizontal, 34)
            .padding(.top, 25)
            .padding(.bottom, 40)
            .frame(maxWidth: 1180, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .sheet(item: $openThread) { thread in
            ThreadSheet(thread: thread, isPresented: Binding(get: { openThread != nil }, set: { if !$0 { openThread = nil } }))
                .environmentObject(env)
                .environmentObject(store)
                .okPreferredScheme(store.settings.appearance)
        }
    }

    // MARK: Requests

    private var requestsList: some View {
        VStack(spacing: 8) {
            if runs.isEmpty {
                EmptyState(glyph: "clock", title: "nothing here yet.",
                           message: "shake your mouse and ask for something. answers, quick actions and full agent runs all land here with their plan.",
                           actionTitle: nil, action: nil)
            } else {
                ForEach(runs) { run in
                    requestRow(run)
                }
            }
        }
        .reveal(0.08)
    }

    private func requestRow(_ run: AgentRun) -> some View {
        let expanded = expandedRun == run.id
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(OKMotion.spring) { expandedRun = expanded ? nil : run.id }
            } label: {
                HStack(spacing: 12) {
                    RunKindIcon(kind: run.kind)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(run.title)
                                .font(.okBody(13, .medium))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                            RunStatusBadge(status: run.status)
                        }
                        Text(run.summary.isEmpty ? run.prompt : run.summary)
                            .font(.okMono(8.5))
                            .foregroundStyle(Color.tertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(run.createdAt.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                        .font(.okMono(8.5))
                        .foregroundStyle(Color.tertiary)
                    PixelGlyph(name: expanded ? "minus" : "chevron", size: 9, color: Color.tertiary)
                        .rotationEffect(.degrees(expanded ? 0 : -90))
                }
                .padding(.horizontal, 14)
                .frame(height: 58)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 1).padding(.horizontal, 14)
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .top, spacing: 20) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("intended plan")
                                .font(.okMono(8))
                                .textCase(.uppercase)
                                .foregroundStyle(Color.tertiary)
                            if let steps = run.preview?.steps, !steps.isEmpty {
                                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                                    HStack(alignment: .top, spacing: 6) {
                                        Text("\(index + 1)").font(.okMono(7.5)).foregroundStyle(Color(hex: 0x1FB57A)).frame(width: 10)
                                        Text(step.text).font(.okBody(10.5)).foregroundStyle(Color.secondary)
                                    }
                                }
                            } else {
                                Text("a direct answer — no actions.").font(.okMono(9)).foregroundStyle(Color.tertiary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("what actually happened")
                                .font(.okMono(8))
                                .textCase(.uppercase)
                                .foregroundStyle(Color.tertiary)
                            if run.steps.isEmpty {
                                Text(run.summary.isEmpty ? run.status.label : run.summary)
                                    .font(.okBody(10.5))
                                    .foregroundStyle(Color.secondary)
                            } else {
                                ForEach(run.steps) { step in
                                    HStack(spacing: 5) {
                                        Circle()
                                            .fill(step.status == .done ? Color(hex: 0x3E8E5B) : (step.status == .failed ? Color(hex: 0xE33B2C) : Color.tertiary))
                                            .frame(width: 4, height: 4)
                                        Text(step.title).font(.okBody(10.5)).foregroundStyle(Color.secondary)
                                        Text(step.status.label).font(.okMono(7.5)).foregroundStyle(Color.tertiary)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: 8) {
                        Button("open run") { env.openDashboard(.runs, runID: run.id) }
                            .buttonStyle(OKButtonStyle(kind: .secondary, compact: true))
                        Button("run it again") { env.askFromDashboard(run.prompt) }
                            .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                        if let threadID = run.threadID, let thread = store.thread(threadID) {
                            Button("open thread") { openThread = thread }
                                .buttonStyle(OKButtonStyle(kind: .ghost, compact: true))
                        }
                        if let freed = run.freedBytes {
                            Text("freed \(Bytes.human(freed))")
                                .font(.okMono(8.5, .medium))
                                .foregroundStyle(Color(hex: 0x3E8E5B))
                        }
                        Spacer()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.primary.opacity(expanded ? 0.035 : 0.018))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 0.8)
        )
    }

    // MARK: Threads

    private var threadsList: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(threads) { thread in
                ThreadCard(thread: thread, onOpen: { openThread = thread })
            }
        }
        .reveal(0.08)
        .overlay {
            if threads.isEmpty {
                EmptyState(glyph: "memory", title: "no threads yet.",
                           message: "start a conversation and it becomes a thread. come back later and okidoki picks it up instead of starting over.",
                           actionTitle: nil, action: nil)
            }
        }
    }
}

struct ThreadCard: View {
    var thread: ChatThread
    var onOpen: () -> Void
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore
    @State private var hovering = false

    private var last: ChatMessage? { thread.messages.last }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                PixelGlyph(name: "memory", size: 11, color: Color(hex: 0x6C6CF8))
                Text(thread.app.isEmpty ? "mac" : thread.app)
                    .font(.okMono(8))
                    .textCase(.uppercase)
                    .foregroundStyle(Color.tertiary)
                Spacer()
                Text("\(thread.messages.count) messages")
                    .font(.okMono(7.5))
                    .foregroundStyle(Color.tertiary)
            }
            Text(thread.title)
                .font(.okDisplay(27))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
            Text(last?.text ?? "no messages yet")
                .font(.okBody(11))
                .foregroundStyle(Color.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Text(thread.updatedAt.formatted(.relative(presentation: .named)))
                    .font(.okMono(8))
                    .foregroundStyle(Color.tertiary)
                Spacer()
                Button("continue") { onOpen() }
                    .buttonStyle(.plain)
                    .font(.okMono(8.5, .medium))
                    .foregroundStyle(Color(hex: 0x1FB57A))
                Menu {
                    Button("archive") { store.archiveThread(thread.id) }
                    Button("delete", role: .destructive) { store.deleteThread(thread.id) }
                } label: {
                    PixelGlyph(name: "dots", size: 9, color: Color.tertiary)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 16)
            }
        }
        .padding(14)
        .frame(height: 140, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.primary.opacity(hovering ? 0.045 : 0.022))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(hovering ? 0.12 : 0.07), lineWidth: 0.8)
        )
        .offset(y: hovering ? -2 : 0)
        .onHover { hovering = $0 }
        .animation(OKMotion.spring, value: hovering)
        .opacity(thread.archived ? 0.5 : 1)
    }
}

struct ThreadSheet: View {
    var thread: ChatThread
    @Binding var isPresented: Bool
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var store: OkidokiStore
    @State private var text = ""
    @FocusState private var focused: Bool

    private var liveThread: ChatThread { store.thread(thread.id) ?? thread }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x6C6CF8).opacity(0.12)).frame(width: 32, height: 32)
                    PixelGlyph(name: "memory", size: 13, color: Color(hex: 0x6C6CF8))
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(liveThread.title)
                        .font(.okDisplay(26))
                        .foregroundStyle(Color.primary)
                    Text("\(liveThread.app) · \(liveThread.messages.count) messages · picks up where you left off")
                        .font(.okMono(8))
                        .foregroundStyle(Color.tertiary)
                }
                Spacer()
                Button("close") { isPresented = false }
                    .buttonStyle(.plain)
                    .font(.okMono(9))
                    .foregroundStyle(Color.tertiary)
            }
            .padding(18)
            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1)

            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(liveThread.messages) { message in
                            messageBubble(message)
                                .id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(20)
                }
                .onAppear { proxy.scrollTo("bottom") }
                .onChange(of: liveThread.messages.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }

            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1)
            HStack(spacing: 9) {
                PixelGlyph(name: "spark", size: 9, color: Color(hex: 0x1FB57A))
                TextField("continue this thread…", text: $text)
                    .textFieldStyle(.plain)
                    .font(.okBody(12.5))
                    .focused($focused)
                    .onSubmit(submit)
                Button {
                    submit()
                } label: {
                    PixelGlyph(name: "arrow", size: 9, color: Color(hex: 0xFFFBF4))
                        .frame(width: 25, height: 25)
                        .background(Circle().fill(Color(hex: 0x1FB57A)))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 13)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 11).fill(Color.primary.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.primary.opacity(0.08), lineWidth: 0.8))
            .padding(16)
        }
        .frame(width: 700, height: 620)
        .background(OKPaperBackground())
        .onAppear { focused = true }
    }

    private func messageBubble(_ message: ChatMessage) -> some View {
        HStack(alignment: .top, spacing: 9) {
            if message.role == .user { Spacer(minLength: 50) }
            if message.role != .user {
                OKLogo(size: 18)
            }
            VStack(alignment: .leading, spacing: 4) {
                if message.role == .assistant {
                    OKMarkdown(text: message.text, size: 12.5, color: Color.primary)
                } else {
                    Text(message.text)
                        .font(.okBody(12.5))
                        .foregroundStyle(Color.primary)
                        .lineSpacing(2)
                }
                Text(message.createdAt.formatted(.dateTime.hour().minute()))
                    .font(.okMono(7.5))
                    .foregroundStyle(Color.tertiary)
            }
            .padding(11)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(message.role == .user ? Color(hex: 0x1FB57A).opacity(0.07) : Color.primary.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(message.role == .user ? Color(hex: 0x1FB57A).opacity(0.12) : Color.primary.opacity(0.06), lineWidth: 0.7)
            )
            if message.role != .user { Spacer(minLength: 40) }
        }
    }

    private func submit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        text = ""
        isPresented = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            env.continueThread(thread.id, text: value)
        }
    }
}
