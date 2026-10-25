import AppKit
import Foundation
import OkidokiCore

/// "add the CBP 3461 to the vault": find the document (a known form, a link, or the web), download
/// it, and file it in the organization's vault. Every step is a run step, so the Runs page and a
/// space that asked for it see the same progress.
extension AppEnvironment {
    private static let browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    func addToVault(query: String, url: String?, space: String, request: String, threadID: String, source: String) {
        summon.hideInput()
        func stop(_ title: String, _ body: String, _ actions: [CardAction] = []) {
            let run = store.createRun(kind: .answer, title: title, prompt: request, threadID: threadID, status: .done)
            store.appendMessage(threadID: threadID, role: .assistant, text: body, runID: run.id)
            present(AnswerCardModel(title: title, text: body, actions: actions, runID: run.id, threadID: threadID), source: source)
        }
        guard store.activeAccount.kind == .work else {
            return stop("that's a work thing", "the vault belongs to your organization. switch to your work account and ask again.")
        }
        let settings = store.settings
        guard settings.syncEnabled, !settings.convexSiteURL.isEmpty, let secret = KeyStore.get("convex"), !secret.isEmpty else {
            return stop("turn on sync", "the vault lives on your organization's deployment. turn on sync in Settings, then ask again.",
                        [CardAction(title: "open settings", kind: .primary, glyph: "gear") { [weak self] in self?.openDashboard(.settings) }])
        }

        let form = url == nil ? FormCatalog.match(query) : nil
        let label = form?.title ?? (url != nil ? "that link" : "“\(query)”")
        let place = space.isEmpty ? "the vault" : "#\(space) in the vault"
        let first = form.map { "\($0.title) · \($0.subtitle) on \($0.issuer)" } ?? (url != nil ? "the link" : "search the web for “\(query)”")
        let run = store.createRun(kind: .quickAction, title: "vault · \(form?.title ?? (url != nil ? "link" : query))", prompt: request,
                                  threadID: threadID,
                                  steps: [RunStep(title: first), RunStep(title: "download"), RunStep(title: "add to \(place)")],
                                  status: .running)
        store.startRun(run.id)
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: form != nil ? "getting \(form!.title) from \(form!.issuer)…" : url != nil ? "downloading that…" : "looking for \(label) on the web…",
                            runID: run.id)
        toast(title: form != nil ? "fetching \(form!.title)" : "on it", detail: form != nil ? "from \(form!.issuer), into \(place)" : "finding \(label), then into \(place)",
              kind: .info, undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: run.id)

        Task { [weak self] in
            guard let self else { return }
            do {
                let saved = try await self.fetchAndFile(run: run.id, form: form, query: query, link: url, space: space,
                                                        siteURL: settings.convexSiteURL, secret: secret)
                let where_ = saved.spaceName.isEmpty ? "the vault" : "#\(saved.spaceName) in the vault"
                let line = "\(saved.name) is in \(where_)\(saved.replaced ? " — it replaced the older copy" : "") · \(ByteCountFormatter.string(fromByteCount: Int64(saved.size), countStyle: .file))"
                self.store.finishRun(run.id, status: .done, summary: line)
                self.store.appendMessage(threadID: threadID, role: .assistant, text: line, runID: run.id)
                var actions = [CardAction(title: "open vault", kind: .primary, glyph: "lock") { [weak self] in
                    self?.answerController.close(restoreApp: false)
                    self?.openDashboard(.vault)
                }]
                if let link = saved.url {
                    actions.append(CardAction(title: "open it", kind: .secondary, glyph: "doc") { NSWorkspace.shared.open(link) })
                }
                self.present(AnswerCardModel(title: "in the vault", text: line, actions: actions, runID: run.id, threadID: threadID), source: source)
                self.speak("Added \(form?.title ?? "it") to the vault.")
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

    private func fetchAndFile(run: String, form: CatalogForm?, query: String, link: String?, space: String,
                              siteURL: String, secret: String) async throws -> VaultUpload.Saved {
        // 1. Where it is.
        vaultStep(run, 0, .running)
        var source: URL
        var name: String
        if let form {
            source = form.url
            name = form.fileName
        } else if let link, let url = URL(string: link) {
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

        // 2. The bytes. A known form falls back to the copy kept from last time if the agency's site is slow.
        vaultStep(run, 1, .running)
        let cache = form.map { Self.formCache.appendingPathComponent("\($0.id).pdf") }
        var data: Data
        var mime = "application/pdf"
        do {
            (data, mime) = try await download(source, timeout: form != nil ? 8 : 25)
            if let cache, VaultUpload.looksLikePDF(data) {
                try? FileManager.default.createDirectory(at: Self.formCache, withIntermediateDirectories: true)
                try? data.write(to: cache, options: .atomic)
            }
        } catch {
            guard let cache, let kept = try? Data(contentsOf: cache) else { throw error }
            data = kept
            vaultStep(run, 1, .running, detail: "\(source.host ?? "the site") was slow — used the copy from last time")
        }
        if link == nil || mime.contains("pdf") {
            guard VaultUpload.looksLikePDF(data) else { throw VaultUpload.Failure("\(source.host ?? "the site") sent back a web page instead of the PDF") }
            mime = "application/pdf"
        }
        vaultStep(run, 1, .done, detail: ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))

        // 3. Into the vault.
        vaultStep(run, 2, .running)
        let saved = try await VaultUpload.upload(data: data, name: name, mime: mime, space: space, accountID: store.activeAccount.id,
                                                 siteURL: siteURL, secret: secret)
        vaultStep(run, 2, .done, detail: saved.spaceName.isEmpty ? "organization" : "#\(saved.spaceName)")
        return saved
    }

    private static var formCache: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Okidoki/forms", isDirectory: true)
    }

    private func download(_ url: URL, timeout: TimeInterval) async throws -> (Data, String) {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue(Self.browserAgent, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        guard let status = http?.statusCode, (200..<300).contains(status) else {
            throw VaultUpload.Failure("\(url.host ?? "the site") answered HTTP \(http?.statusCode ?? 0)")
        }
        let mime = (http?.value(forHTTPHeaderField: "content-type") ?? "application/octet-stream").split(separator: ";").first.map(String.init) ?? "application/octet-stream"
        return (data, mime)
    }

    private struct FoundDocument: Decodable { var ok: Bool; var title: String?; var url: String?; var error: String? }

    private func findOnWeb(_ query: String) async throws -> (title: String, url: URL) {
        guard sidecar.status.isReady else { throw VaultUpload.Failure("the brain isn't running, so i can't search the web") }
        var request = URLRequest(url: BrainClient.shared.baseURL.appendingPathComponent("find/document"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty { request.setValue(key, forHTTPHeaderField: "x-anthropic-key") }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query])
        let (data, _) = try await URLSession.shared.data(for: request)
        let found = try JSONDecoder().decode(FoundDocument.self, from: data)
        guard found.ok, let raw = found.url, let url = URL(string: raw) else { throw VaultUpload.Failure(found.error ?? "couldn't find it on the web") }
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
