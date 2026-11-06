import AppKit
import Foundation
import OkidokiCore

/// "add the W-9 to the vault": find the document (a link, or the web), download it, and file it in
/// the vault folder. Every step is a run step, so the Runs page shows the same progress.
extension AppEnvironment {
    private static let browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    func addToVault(query: String, url: String?, folder: String, request: String, threadID: String, source: String) {
        summon.hideInput()
        func stop(_ title: String, _ body: String, _ actions: [CardAction] = []) {
            let run = store.createRun(kind: .answer, title: title, prompt: request, threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: body, runID: run.id)
            present(AnswerCardModel(title: title, text: body, actions: actions, runID: run.id, threadID: threadID), source: source)
        }
        let label = url != nil ? "that link" : "“\(query)”"
        let place = folder.isEmpty ? "the vault" : "\(folder) in the vault"
        let first = url != nil ? "the link" : "search the web for “\(query)”"
        let run = store.createRun(kind: .quickAction, title: "vault · \(url != nil ? "link" : query)", prompt: request,
                                  threadID: threadID,
                                  steps: [RunStep(title: first), RunStep(title: "download"), RunStep(title: "add to \(place)")],
                                  status: .running)
        store.startRun(run.id)
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: url != nil ? "downloading that…" : "looking for \(label) on the web…",
                            runID: run.id)
        toast(title: "on it", detail: "finding \(label), then into \(place)",
              kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: run.id)

        Task { [weak self] in
            guard let self else { return }
            do {
                let saved = try await self.fetchAndFile(run: run.id, query: query, link: url, folder: folder)
                let line = "\(saved.url.lastPathComponent) is in \(place)\(saved.replaced ? " — it replaced the older copy" : "") · \(ByteCountFormatter.string(fromByteCount: Int64(saved.size), countStyle: .file))"
                self.store.finishRun(run.id, status: .done, summary: line)
                self.store.appendMessage(threadID: threadID, role: .assistant, text: line, runID: run.id)
                var actions = [CardAction(title: "open vault", kind: .primary, glyph: "lock") { [weak self] in
                    self?.answerController.close(restoreApp: false)
                    self?.openDashboard(.vault)
                }]
                actions.append(CardAction(title: "open it", kind: .secondary, glyph: "doc") { NSWorkspace.shared.open(saved.url) })
                self.present(AnswerCardModel(title: "in the vault", text: line, actions: actions, runID: run.id, threadID: threadID), source: source)
                self.speak("Added it to the vault.")
            } catch {
                let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.store.updateRun(run.id) { run in
                    if let i = run.steps.firstIndex(where: { $0.status == .running }) { run.steps[i].status = .failed; run.steps[i].endedAt = Date() }
                }
                self.store.finishRun(run.id, status: .failed, summary: reason)
                self.store.appendMessage(threadID: threadID, role: .assistant, text: "couldn't add \(label): \(reason)", runID: run.id)
                self.present(AnswerCardModel(title: "couldn't add it", text: reason, runID: run.id, threadID: threadID), source: source)
            }
            self.store.saveNow()
        }
    }

    private func vaultStep(_ runID: String, _ index: Int, _ status: RunStatus, detail: String? = nil) {
        store.updateRun(runID) { run in
            guard run.steps.indices.contains(index) else { return }
            if status == .running { run.steps[index].startedAt = run.steps[index].startedAt ?? Date() } else { run.steps[index].endedAt = Date() }
            run.steps[index].status = status
            if let detail { run.steps[index].detail = detail }
        }
    }

    private func fetchAndFile(run: String, query: String, link: String?, folder: String) async throws -> (url: URL, replaced: Bool, size: Int) {
        // 1. Where it is.
        vaultStep(run, 0, .running)
        var source: URL
        var name: String
        if let link, let url = URL(string: link) {
            source = url
            name = Self.fileName(from: url, title: "")
        } else {
            let found = try await findOnWeb(query)
            source = found.url
            name = Self.fileName(from: found.url, title: found.title)
            vaultStep(run, 0, .running, detail: found.url.host ?? "")
            store.updateRun(run) { $0.steps[0].title = "found “\(found.title)” on \(found.url.host ?? "the web")" }
        }
        vaultStep(run, 0, .done, detail: source.absoluteString)

        // 2. The bytes.
        vaultStep(run, 1, .running)
        let (data, mime) = try await download(source, timeout: 25)
        if link == nil || mime.contains("pdf") {
            guard LocalVault.looksLikePDF(data) else { throw LocalVault.Failure("\(source.host ?? "the site") sent back a web page instead of the PDF") }
        }
        vaultStep(run, 1, .done, detail: ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))

        // 3. Into the vault folder.
        vaultStep(run, 2, .running)
        let saved = try vault.add(data: data, name: name, folder: folder)
        vaultStep(run, 2, .done, detail: folder.isEmpty ? "vault" : folder)
        return (saved.url, saved.replaced, data.count)
    }

    private func download(_ url: URL, timeout: TimeInterval) async throws -> (Data, String) {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(Self.browserAgent, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        guard let status = http?.statusCode, (200..<300).contains(status) else {
            throw LocalVault.Failure("\(url.host ?? "the site") answered HTTP \(http?.statusCode ?? 0)")
        }
        let mime = (http?.value(forHTTPHeaderField: "content-type") ?? "application/octet-stream").split(separator: ";").first.map(String.init) ?? "application/octet-stream"
        return (data, mime)
    }

    private struct FoundDocument: Decodable { var ok: Bool; var title: String?; var url: String?; var error: String? }

    private func findOnWeb(_ query: String) async throws -> (title: String, url: URL) {
        guard sidecar.status.isReady else { throw LocalVault.Failure("the brain isn't running, so i can't search the web") }
        var request = URLRequest(url: BrainClient.shared.baseURL.appendingPathComponent("find/document"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty { request.setValue(key, forHTTPHeaderField: "x-anthropic-key") }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query])
        let (data, _) = try await URLSession.shared.data(for: request)
        let found = try JSONDecoder().decode(FoundDocument.self, from: data)
        guard found.ok, let raw = found.url, let url = URL(string: raw) else { throw LocalVault.Failure(found.error ?? "couldn't find it on the web") }
        return (found.title ?? "", url)
    }

    static func fileName(from url: URL, title: String) -> String {
        let cleaned = title.replacingOccurrences(of: "[/\\\\:*?\"<>|]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty { return String(cleaned.prefix(150)) + (cleaned.lowercased().hasSuffix(".pdf") ? "" : ".pdf") }
        let last = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
        return last.isEmpty || last == "/" ? "document.pdf" : String(last.prefix(150))
    }
}

/// The panel's side of the vault: files dropped on the page, and moving the folder.
extension AppEnvironment {
    /// `files` are `{name, data}` with the bytes base64-encoded, as the panel reads them.
    func vaultAddFiles(_ files: [[String: Any]], folder: String) {
        var added: [String] = []
        var failed: [String] = []
        for file in files {
            guard let name = file["name"] as? String, let encoded = file["data"] as? String,
                  let data = Data(base64Encoded: encoded) else { continue }
            do {
                try vault.add(data: data, name: name, folder: folder)
                added.append(name)
            } catch {
                failed.append("\(name): \(error.localizedDescription)")
            }
        }
        if !added.isEmpty {
            toast(title: added.count == 1 ? "in the vault" : "\(added.count) files in the vault",
                  detail: added.count == 1 ? added[0] : added.prefix(3).joined(separator: ", "), kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
        if !failed.isEmpty {
            toast(title: "couldn't add \(failed.count == 1 ? "a file" : "\(failed.count) files")", detail: failed[0], kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }

    /// A folder picker; the vault follows whatever folder is picked, files and all.
    func chooseVaultFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use as vault"
        panel.message = "Pick the folder okidoki files documents into and searches."
        panel.directoryURL = vault.folderURL
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.settings.vaultFolder = url.path
        store.saveNow()
    }
}

/// Skills as files: export one to share or keep, import one someone sent you.
extension AppEnvironment {
    func exportSkill(_ id: String) {
        guard let skill = store.skill(id) else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = LocalVault.safeFileName(skill.name) + "." + SkillBundle.fileExtension
        panel.message = "Anyone with okidoki can import this file and replay the skill."
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try SkillBundle.make(from: skill).encoded().write(to: url, options: .atomic)
            toast(title: "skill saved", detail: url.lastPathComponent, kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: "show", onEdit: { NSWorkspace.shared.activateFileViewerSelecting([url]) }, runID: nil)
        } catch {
            toast(title: "couldn't save the skill", detail: error.localizedDescription, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }

    func importSkillFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = []
        panel.allowsOtherFileTypes = true
        panel.allowsMultipleSelection = true
        panel.message = "Pick .okiskill files to add to Replay."
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { importSkill(at: url) }
    }

    func importSkill(at url: URL) {
        do {
            let bundle = try SkillBundle.decode(try Data(contentsOf: url))
            var skill = store.createSkill(name: bundle.name, summary: bundle.summary, steps: bundle.installableSteps(), source: "file")
            // A v2 file's inputs, popup rules and the rest come along; without them its {{placeholders}} mean nothing.
            if let extras = bundle.skill, !extras.isEmpty {
                extras.apply(to: &skill)
                store.replaceSkill(skill)
            }
            store.saveNow()
            toast(title: "skill added", detail: "“\(skill.name)” · \(skill.steps.count) steps", kind: .success,
                  undoLabel: "replay", onUndo: { [weak self] in self?.replaySkill(skill) },
                  editLabel: "open", onEdit: { [weak self] in self?.openDashboard(.skills) }, runID: nil)
        } catch {
            toast(title: "couldn't import \(url.lastPathComponent)", detail: error.localizedDescription, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        }
    }
}
