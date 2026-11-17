import Foundation
import OkidokiCore

/// Memory creation: every path that keeps a fact about the person ends here.
///
///   explicit — "remember that …" in chat or summon, `okidoki remember`: saved now, confirmed in the chat.
///   learned  — after a turn, in the background: lasting facts the person stated in their own words.
///   agent    — facts a browser/computer run proposed with `remember`, kept only when the run finished
///              and the brain's verifier finds them grounded in the person's request (pages can lie).
///
/// The brain decides (gates + reconcile, one cheap model call at most); the Mac's `MemoryPolicy` gates
/// again and decides alone when the brain is down. Secrets are never saved, anywhere.
extension AppEnvironment {
    /// Saves facts the person asked to keep. Returns what each save did, in order.
    func rememberExplicit(_ facts: [String], words: String, source: String, threadID: String?,
                          messageID: String?, runID: String? = nil) async -> [OkidokiStore.MemorySave] {
        let facts = facts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !facts.isEmpty else { return [] }
        var results: [OkidokiStore.MemorySave] = []
        if sidecar.status.isReady,
           let out = await BrainClient.shared.extractMemories(text: words, mode: "explicit", facts: facts,
                                                              known: store.activeMemories, model: nil),
           out.ok != false {
            for op in out.ops ?? [] {
                results.append(store.saveMemory(op.text, section: op.section == "rightNow" ? .rightNow : .aboutYou,
                                                source: source, threadID: threadID, runID: runID, messageID: messageID,
                                                op: op.op, targetID: op.id))
            }
            // What the brain refused (secrets, instructions) is reported by the caller from the words themselves.
        } else {
            for fact in facts {
                results.append(store.saveMemory(fact, section: fact.lowercased().hasPrefix("right now") ? .rightNow : .aboutYou,
                                                source: source, threadID: threadID, runID: runID, messageID: messageID))
            }
        }
        if results.contains(where: { if case .refused = $0 { return false }; return true }) { store.saveNow() }
        return results
    }

    /// The chat line for what a save did, listing only what was actually kept.
    static func memoryConfirmation(_ results: [OkidokiStore.MemorySave], words: String) -> String {
        var lines: [String] = []
        for result in results {
            switch result {
            case .added(let item): lines.append("· \(item.text)")
            case .updated(let item): lines.append("· \(item.text) (was: \(item.previousText ?? "…"))")
            case .known(let item): lines.append("· \(item.text) (already knew this)")
            case .refused: break
            }
        }
        let secret = MemoryPolicy.secretKind(words)
        if lines.isEmpty {
            if let secret { return MemoryPolicy.vaultNote(secret) }
            return "I couldn't find a lasting fact to keep there. Try \"remember that …\" with the detail itself."
        }
        let changed = results.contains { if case .updated = $0 { return true }; return false }
        var text = (changed ? "Got it, updated my memory:\n" : "Noted. I'll remember:\n") + lines.joined(separator: "\n")
        if let secret { text += "\n\n" + MemoryPolicy.vaultNote(secret) }
        return text
    }

    /// After a turn, without holding up the reply: lasting facts the person stated in their own words.
    /// One extraction per message, ever; small talk never reaches the model (the brain prefilters).
    func learnFromTurn(words: String, reply: String, threadID: String, messageID: String?, source: String) {
        guard !Self.isUnattended(source) else { return }
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 8 else { return }
        let key = messageID ?? "\(threadID)|\(text)"
        guard !learnedTurns.contains(key) else { return }
        learnedTurns.insert(key)
        // A mention's attached context rides in brackets after the request; it's not their words.
        let ownWords = text.components(separatedBy: "\n\n(context: ").first ?? text
        Task { [weak self] in
            guard let self, self.sidecar.status.isReady else { return }
            guard let out = await BrainClient.shared.extractMemories(text: ownWords, reply: reply, mode: "chat",
                                                                     known: self.store.activeMemories,
                                                                     model: self.store.settings.claudeModel) else { return }
            var saved: [OkidokiStore.MemorySave] = []
            for op in out.ops ?? [] where op.op != "skip" {
                let result = self.store.saveMemory(op.text, section: op.section == "rightNow" ? .rightNow : .aboutYou,
                                                   source: "learned", learned: true, threadID: threadID,
                                                   messageID: messageID, op: op.op, targetID: op.id)
                if case .added = result { saved.append(result) }
                if case .updated = result { saved.append(result) }
            }
            guard !saved.isEmpty else { return }
            self.store.saveNow()
            self.announceLearned(saved)
        }
    }

    /// Facts a run's agent proposed with `remember`, once the run is over. Only a finished run counts as a
    /// confirmed outcome; the brain checks each fact against the person's own request before it's kept.
    func learnFromRun(_ runID: String) {
        guard let facts = pendingRunFacts.removeValue(forKey: runID), !facts.isEmpty,
              let run = store.runs.first(where: { $0.id == runID }), run.status == .done else { return }
        Task { [weak self] in
            guard let self, self.sidecar.status.isReady else { return }
            guard let out = await BrainClient.shared.extractMemories(text: "the run finished: \(run.summary.isEmpty ? run.title : run.summary)",
                                                                     mode: "agent", task: run.prompt, facts: facts,
                                                                     known: self.store.activeMemories,
                                                                     model: self.store.settings.claudeModel) else { return }
            var saved: [OkidokiStore.MemorySave] = []
            for op in out.ops ?? [] where op.op != "skip" {
                let result = self.store.saveMemory(op.text, section: op.section == "rightNow" ? .rightNow : .aboutYou,
                                                   source: "learned", learned: true, threadID: run.threadID, runID: runID,
                                                   op: op.op, targetID: op.id, untrusted: true)
                if case .added = result { saved.append(result) }
                if case .updated = result { saved.append(result) }
            }
            guard !saved.isEmpty else { return }
            self.store.saveNow()
            for result in saved { if let item = result.item { self.replayLog(runID, "→ remembered: \(item.text)") } }
            self.announceLearned(saved)
        }
    }

    /// A fact an agent asked to keep mid-run; held until the run ends (see `learnFromRun`).
    func proposeRunFact(_ fact: String, runID: String) {
        let fact = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !fact.isEmpty, MemoryPolicy.refusal(fact, untrusted: true) == nil else { return }
        var list = pendingRunFacts[runID] ?? []
        if !list.contains(fact), list.count < 12 { list.append(fact) }
        pendingRunFacts[runID] = list
    }

    /// The notch line for something learned without being asked, with Undo.
    func announceLearned(_ saved: [OkidokiStore.MemorySave], title: String = "learned") {
        let items = saved.compactMap { save -> MemoryItem? in
            switch save { case .added(let item), .updated(let item): return item; default: return nil }
        }
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        toast(title: items.count == 1 ? title : "\(title) · \(items.count)",
              detail: items.map(\.text).joined(separator: " · "), kind: .info,
              undoLabel: "undo", onUndo: { [weak self] in
                  for id in ids { self?.store.undoMemorySave(id) }
                  self?.store.saveNow()
              },
              editLabel: "memory", onEdit: { [weak self] in self?.openDashboard(.memory) }, runID: nil)
    }
}
