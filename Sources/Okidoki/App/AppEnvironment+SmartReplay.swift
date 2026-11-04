import Foundation
import OkidokiCore

/// A finished browser run, as "save as skill" needs it: the steps plus what the compiler reads.
struct LearnedBrowserRun {
    var title: String
    var goal: String
    var summary: String
    var steps: [SkillStep]
    /// URL → some of the page's text.
    var pages: [String: String]
}

extension BrainClient {
    /// One of smart replay's up-front calls (`skill/compile`, `skill/resolve`, `skill/route`). Nil when
    /// the brain isn't there or didn't answer; callers then do what they did before smart replay.
    func smartReplay(_ path: String, body: [String: Any], timeout: TimeInterval = 90) async -> [String: Any]? {
        var request = drivingRequest(path: path, timeout: timeout)
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }
}

extension AppEnvironment {
    // MARK: - Compile: a saved run becomes a smart skill

    /// Asks the brain which of the run's values change per item, what's optional, and what to check,
    /// then rewrites the saved skill in place. On any failure the skill stays as recorded.
    func generalize(skillID: String, from run: LearnedBrowserRun) async {
        guard let skill = store.skill(skillID) else { return }
        let pages = run.steps.compactMap(\.observedAfter) + run.steps.compactMap { step in step.url.map { StepObservation(url: $0) } }
        let body = SkillCompiler.request(goal: run.goal, summary: run.summary, surface: skill.runsInBrowser ? "browser" : "mac",
                                         steps: skill.steps, pages: pages, pageTexts: run.pages)
        var smart: Skill?
        var compiled: CompiledSkill?
        if !hasKey("anthropic") {
            SmartReplayLog.write("compile \(skill.name): no Anthropic key")
        } else if let reply = await BrainClient.shared.smartReplay("skill/compile", body: body, timeout: 180) {
            if reply["ok"] as? Bool == true, let raw = reply["skill"], let data = try? JSONSerialization.data(withJSONObject: raw) {
                do { compiled = try JSONDecoder().decode(CompiledSkill.self, from: data) }
                catch { SmartReplayLog.write("compile \(skill.name): couldn't read the answer: \(error)\n\(String(data: data, encoding: .utf8) ?? "")") }
            } else {
                SmartReplayLog.write("compile \(skill.name): \(reply["error"] as? String ?? "no skill in the answer")")
            }
        } else {
            SmartReplayLog.write("compile \(skill.name): the brain didn't answer")
        }
        if let compiled, let current = store.skill(skillID) {
            smart = SkillCompiler.apply(compiled, to: current)
            if smart == nil, let data = try? JSONEncoder().encode(compiled) {
                SmartReplayLog.write("compile \(skill.name): the answer didn't hold together, kept as recorded\n\(String(data: data, encoding: .utf8) ?? "")")
            }
            if var made = smart, let name = compiled.name, !name.isEmpty, current.name == run.title {
                // The run's title is the request ("go to … and file for Asha"); the compiler's name fits every pass.
                made.name = name
                smart = made
            }
        }
        if var made = smart {
            // A final step on a page that showed what the run entered (a review page) is marked, so a later
            // pass whose details don't show there is paused instead of submitted, from the very first replay.
            let examples = Dictionary((made.inputs ?? []).compactMap { input in input.example.map { (input.name, $0) } },
                                      uniquingKeysWith: { first, _ in first })
            for index in made.steps.indices where made.steps[index].irreversible == true {
                guard let url = made.steps[index].url, let text = run.pages[url] else { continue }
                let seen = HybridReplay.shownValues(examples, inputs: made.inputs ?? [], on: text)
                if seen.checked > 0, seen.shown > 0 { made.steps[index].echoes = true }
            }
            smart = made
        }
        if let smart {
            store.replaceSkill(smart)
            store.saveNow()
            let detail = SkillCompiler.describe(smart)
            toast(title: "saved as a smart skill", detail: "\(smart.name) · \(detail.isEmpty ? "replays in seconds" : detail)", kind: .success,
                  undoLabel: "replay", onUndo: { [weak self] in self?.replaySkill(smart, times: 1) },
                  editLabel: "open", onEdit: { [weak self] in self?.openDashboard(.skills) }, runID: nil)
        } else {
            toast(title: "saved as a skill", detail: "\(skill.name) · replays exactly as recorded", kind: .success,
                  undoLabel: "replay", onUndo: { [weak self] in self?.replaySkill(skill, times: 1) },
                  editLabel: "open", onEdit: { [weak self] in self?.openDashboard(.skills) }, runID: nil)
        }
    }
}

extension AppEnvironment {
    // MARK: - Run log

    /// A line in the run's log. Receipts (one per finished item) carry no arrow, so `finishReplay` lists them.
    func replayLog(_ runID: String, _ line: String, receipt: Bool = false) {
        let text = receipt || line.hasPrefix("→") || line.hasPrefix("✗") ? line : "→ " + line
        store.updateRun(runID) { run in run.output += (run.output.isEmpty ? "" : "\n") + text }
    }

    // MARK: - The unsure gate

    /// The card before an irreversible step when a pass has a doubt: carry on · skip this one · stop.
    func presentReplayGate(runID: String, title: String, text: String, answer: @escaping (HybridBrowserReplayer.GateAnswer) -> Void) {
        var answered = false
        let once: (HybridBrowserReplayer.GateAnswer) -> Void = { [weak self] choice in
            guard !answered else { return }
            answered = true
            self?.answerController.close(restoreApp: false)
            answer(choice)
        }
        let card = AnswerCardModel(title: title, text: text, actions: [
            CardAction(title: "carry on", kind: .primary, glyph: "bolt") { once(.carryOn) },
            CardAction(title: "skip this one", kind: .secondary, glyph: "runs") { once(.skip) },
            CardAction(title: "stop", kind: .secondary, glyph: "runs") { once(.stop) },
        ], threadTitle: nil, runID: runID, threadID: store.run(runID)?.threadID)
        card.footnote = "smart replay · paused only because something above is uncertain"
        pendingGate = once
        present(card, source: "followup")
        speak("One check before I submit.")
    }

    /// "Your turn": the person does what only they can (a captcha, a code, anything while paused), then
    /// hands it back. The replay also takes it back by itself once the check is gone.
    ///
    /// The card never takes the keyboard: the person is about to type into the page (a one-time code),
    /// and a key card would catch it as a new request. Closing it isn't an answer; the run keeps waiting
    /// and still notices when the check is gone.
    func presentHandoff(runID: String, title: String, text: String, takeBack: @escaping () -> Void, stop: @escaping () -> Void) {
        var answered = false
        let once: (Bool) -> Void = { [weak self] back in
            guard !answered else { return }
            answered = true
            if self?.handoffRunID == runID {
                self?.pendingHandoff = nil
                self?.handoffRunID = nil
                self?.answerController.close(restoreApp: false)
            }
            back ? takeBack() : stop()
        }
        let card = AnswerCardModel(title: title, text: text, actions: [
            CardAction(title: "take back", kind: .primary, glyph: "bolt") { once(true) },
            CardAction(title: "stop", kind: .secondary, glyph: "runs") { once(false) },
        ], threadTitle: nil, runID: runID, threadID: store.run(runID)?.threadID)
        card.footnote = "waiting for you · okidoki carries on by itself once it's done"
        card.onClose = { [weak self] in
            guard let self, self.handoffRunID == runID else { return }
            self.answerController.close(restoreApp: false)
        }
        pendingHandoff = { once(true) }
        handoffRunID = runID
        present(card, source: "replay")
        // Said once, not every time a second check follows the first.
        if Date().timeIntervalSince(lastHandoffSpoken) > 45 {
            lastHandoffSpoken = Date()
            speak("Your turn. I need you for a moment.")
        }
    }

    /// The person stepped in on a paused replay and did something the skill doesn't: offer to add it, in
    /// their words, before the step they stepped in at. Nothing changes unless they say so.
    func offerPersonSteps(skillID: String, before index: Int, steps: [SkillStep], runID: String) {
        guard let skill = store.skill(skillID), skill.steps.indices.contains(index) else { return }
        let list = steps.map { "· \($0.text)" }.joined(separator: "\n")
        let card = AnswerCardModel(title: "learn what you did?", text: "While it was paused you did:\n\(list)\n\n"
                                   + "Add \(steps.count == 1 ? "it" : "these") to “\(skill.name)” before “\(skill.steps[index].text)”, so next time it does \(steps.count == 1 ? "it" : "them") itself?",
                                   actions: [], threadTitle: nil, runID: runID, threadID: store.run(runID)?.threadID)
        card.actions = [
            CardAction(title: "add to skill", kind: .primary, glyph: "wand") { [weak self] in
                guard let self, var current = self.store.skill(skillID), current.steps.indices.contains(index) else { return }
                current.steps.insert(contentsOf: steps, at: index)
                current.steps = SkillCompiler.deriveChecks(current.steps)
                self.store.replaceSkill(current)
                self.store.saveNow()
                self.replayLog(runID, "→ added \(steps.count) \(steps.count == 1 ? "step" : "steps") you did to “\(current.name)”")
                self.answerController.close(restoreApp: false)
                self.toast(title: "learned", detail: "“\(current.name)” now does that itself", kind: .success,
                           undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: runID)
            },
            CardAction(title: "not now", kind: .secondary, glyph: "runs") { [weak self] in self?.answerController.close(restoreApp: false) },
        ]
        card.footnote = "smart replay · learning from you"
        pendingTeach = { [weak card] in card?.actions.first?.handler() }
        present(card, source: "replay")
    }

    /// Closes the "your turn" card once the run has taken it back (or ended). Only that run's card:
    /// whatever else is showing now stays.
    func closeHandoffCard(runID: String) {
        guard pendingHandoff != nil, handoffRunID == runID else { return }
        pendingHandoff = nil
        handoffRunID = nil
        answerController.close(restoreApp: false)
    }

    // MARK: - Bind: every pass's values before anything is touched

    /// Each pass's values, final: given values matched to the skill's inputs in code, and whatever is
    /// still missing found in the item's documents by one model call per item, all items at once.
    /// Skills without inputs pass straight through, exactly as a classic replay would use them.
    func bindItems(_ skill: Skill, passes: [[String: String]], runID: String, request: String) async -> [SkillBinder.Bound] {
        let inputs = SkillBinder.boundInputs(skill)
        let labels = passes.enumerated().map { n, pass in
            pass["ref"] ?? pass["name"] ?? pass["id"] ?? (passes.count > 1 ? "pass \(n + 1)" : skill.name)
        }
        guard !inputs.isEmpty else {
            return passes.enumerated().map { SkillBinder.Bound(label: labels[$0.offset], values: $0.element) }
        }
        let folders = vault.folders
        let vaultRoot = vault.folderURL
        let canAsk = hasKey("anthropic")
        // Inputs steps are conditional on are optional, whatever the skill file says.
        let gating = Set(skill.steps.flatMap { ParameterFill.names(in: $0.when ?? "") + [$0.repeatOver].compactMap { $0 } }
            .compactMap { name in inputs.first { ParameterFill.key($0.name) == ParameterFill.key(name) }?.name })
        return await withTaskGroup(of: (Int, SkillBinder.Bound).self) { group in
            for (n, pass) in passes.enumerated() {
                let label = labels[n]
                // Documents: the item's own folder, else the vault's best matches for its name.
                let folder = SkillBinder.folder(for: label, in: folders)
                let files: [URL] = {
                    if let folder {
                        return vault.files.filter { $0.folder == folder || $0.folder.hasPrefix(folder + "/") }.prefix(10)
                            .map { vaultRoot.appendingPathComponent($0.id) }
                    }
                    return vault.search(label, limit: 5).map { vaultRoot.appendingPathComponent($0.id) }
                }()
                // What okidoki remembers: lines about this item, or, for a pass that's nobody else's, about you.
                let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
                let name = fold(label).split(separator: " ").first.map(String.init) ?? ""
                let remembered: [String] = pass["ref"] == nil && pass["name"] == nil
                    ? store.memoryLines(limit: 40)
                    : (name.count >= 3 ? store.memories.filter { fold($0.text).contains(name) }.prefix(20).map(\.text) : [])
                group.addTask { @MainActor in
                    var (values, leftover) = SkillBinder.match(pass, to: inputs)
                    for input in inputs where input.kind == "choice" {
                        if let value = values[input.name] { values[input.name] = SkillBinder.choice(value, in: input.choices) }
                    }
                    var confidence: [String: Double] = [:]
                    var sources: [String: String] = Dictionary(uniqueKeysWithValues: values.keys.map { ($0, "given") })
                    let still = inputs.filter { values[$0.name] == nil }
                    if !still.isEmpty, canAsk {
                        let found = await self.resolve(still, label: label, files: files, leftover: leftover, request: request,
                                                       memory: remembered, runID: runID)
                        for (name, hit) in found {
                            values[name] = hit.value
                            confidence[name] = hit.confidence
                            if let source = hit.source { sources[name] = source }
                        }
                    }
                    var all = ParameterFill.builtins()
                    for (key, value) in pass where key == "ref" || key == "id" { all[key] = value }
                    all.merge(values) { _, bound in bound }
                    return (n, SkillBinder.finish(label: label, values: all, inputs: inputs, confidence: confidence, sources: sources,
                                                  optionalByUse: gating))
                }
            }
            var out = [SkillBinder.Bound?](repeating: nil, count: passes.count)
            for await (n, bound) in group { out[n] = bound }
            return out.compactMap { $0 }
        }
    }

    /// One call: these inputs, for this item, from its documents (cached by the files' dates).
    private func resolve(_ inputs: [SkillInput], label: String, files: [URL], leftover: [String: String], request: String,
                         memory: [String] = [], runID: String) async -> [String: (value: String, confidence: Double, source: String?)] {
        let stamp = files.map { url -> String in
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            return "\(url.lastPathComponent)@\(Int(date))"
        }.sorted().joined(separator: "|")
        let cacheKey = [label.lowercased(), inputs.map(\.name).sorted().joined(separator: ","), stamp,
                        leftover.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&"), request,
                        memory.joined(separator: "|")].joined(separator: "#")
        if let hit = SmartReplayCache.shared.get(cacheKey) {
            replayLog(runID, "→ \(label): values from last time (documents unchanged)")
            return hit
        }
        var documents: [[String: String]] = await Task.detached(priority: .userInitiated) {
            files.map { ["name": $0.lastPathComponent, "text": SkillBinder.text(of: $0)] }.filter { !($0["text"] ?? "").isEmpty }
        }.value
        if !leftover.isEmpty {
            documents.append(["name": "values given with the request",
                              "text": leftover.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")])
        }
        if !memory.isEmpty {
            documents.append(["name": "what okidoki remembers", "text": memory.joined(separator: "\n")])
        }
        guard !documents.isEmpty || !request.isEmpty else { return [:] }
        let payload: [String: Any] = [
            "item": label,
            "inputs": inputs.map { input -> [String: Any] in
                var row: [String: Any] = ["name": input.name, "description": input.description, "kind": input.kind, "required": input.isRequired]
                if let fields = input.fields { row["fields"] = fields }
                if let choices = input.choices { row["choices"] = choices }
                if let hint = input.hint { row["hint"] = hint }
                return row
            },
            "documents": documents,
            "request": request,
        ]
        replayLog(runID, "→ \(label): reading \(documents.count) \(documents.count == 1 ? "document" : "documents")")
        store.countModelCall(runID)
        guard let reply = await BrainClient.shared.smartReplay("skill/resolve", body: payload),
              reply["ok"] as? Bool == true, let found = reply["values"] as? [String: [String: Any]] else {
            replayLog(runID, "✗ \(label): couldn't read the documents")
            return [:]
        }
        var out: [String: (value: String, confidence: Double, source: String?)] = [:]
        for input in inputs {
            guard let hit = found[input.name] else { continue }
            let confidence = (hit["confidence"] as? NSNumber)?.doubleValue ?? 0
            var value = ""
            if let list = hit["value"] as? [[String: Any]] {
                value = HybridReplay.encodeList(list.map { $0.mapValues { "\($0)" } })
            } else if let list = hit["value"] as? [Any] {
                value = HybridReplay.encodeList(list.map { ["value": "\($0)"] })
            } else if let text = hit["value"] as? String {
                value = text
            } else if let number = hit["value"] as? NSNumber {
                value = number.stringValue
            }
            if input.kind == "choice" { value = SkillBinder.choice(value, in: input.choices) }
            // Nothing found, and not required: an empty value is the answer (no capital gains, no deductions).
            if value.isEmpty, input.isRequired, confidence < 0.5 { continue }
            out[input.name] = (value, confidence, hit["source"] as? String)
        }
        SmartReplayCache.shared.set(cacheKey, out)
        return out
    }
}

/// Values found in documents, kept until the documents change, so a second replay for the same people
/// makes no model calls. In memory and in the support folder.
@MainActor
final class SmartReplayCache {
    static let shared = SmartReplayCache()
    private struct Entry: Codable { var value: String; var confidence: Double; var source: String? }
    private var entries: [String: [String: Entry]]
    private let url = AppPaths.support("smart-replay-cache.json")

    private init() {
        entries = (try? JSONDecoder().decode([String: [String: Entry]].self, from: Data(contentsOf: url))) ?? [:]
    }

    func get(_ key: String) -> [String: (value: String, confidence: Double, source: String?)]? {
        entries[key]?.mapValues { ($0.value, $0.confidence, $0.source) }
    }

    func set(_ key: String, _ values: [String: (value: String, confidence: Double, source: String?)]) {
        entries[key] = values.mapValues { Entry(value: $0.value, confidence: $0.confidence, source: $0.source) }
        if entries.count > 500 { entries = Dictionary(uniqueKeysWithValues: entries.suffix(400).map { ($0.key, $0.value) }) }
        try? JSONEncoder().encode(entries).write(to: url, options: .atomic)
    }
}

/// Why smart replay fell back to plain replay, for whoever is debugging it: `smart-replay.log` in the
/// support folder. Never values from documents or the vault.
enum SmartReplayLog {
    static func write(_ line: String) {
        let url = AppPaths.support("smart-replay.log")
        let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(stamped.utf8))
            try? handle.close()
        } else {
            try? Data(stamped.utf8).write(to: url)
        }
    }
}

extension AppEnvironment {
    // MARK: - Dispatch: replay first

    /// Asks the router whether a saved skill does this request's job, and starts it if so. False when the
    /// agent should do it (no fitting skill, not sure enough, or the router didn't answer).
    /// `echo`: the request isn't in the conversation yet (it came in as a chat command); add it first.
    func dispatchToSkill(_ text: String, threadID: String, source: String, echo: Bool = false) async -> Bool {
        // A template that's already been learned is offered as the learned skill only.
        let learnedFrom = Set(store.activeSkills.compactMap { $0.learned == true ? $0.templateID : nil })
        var skills = store.activeSkills.filter { (!$0.steps.isEmpty || $0.template == true) && !learnedFrom.contains($0.id) }
        // The whole library is on offer, not just what's been added: a template that fits is added the
        // first time a request needs it. One already added (or learned from) is offered as that.
        let installed = Set(store.activeSkills.compactMap { $0.source } + store.activeSkills.compactMap { $0.templateID })
            .union(store.activeSkills.filter { $0.template == true || $0.learned == true }.compactMap { $0.source })
        let available = library.filter { !installed.contains(SkillLibrary.source(for: $0.id)) }
        var offered: [String: SkillLibrary.Entry] = [:]
        for entry in available {
            var template = SkillLibrary.skill(from: entry, accountID: store.currentAccountID)
            template.id = SkillLibrary.source(for: entry.id)
            offered[template.id] = entry
            skills.append(template)
        }
        guard !skills.isEmpty else { return false }
        let body: [String: Any] = ["request": text, "skills": ReplayDispatcher.catalogue(skills)]
        guard let reply = await BrainClient.shared.smartReplay("skill/route", body: body, timeout: 25),
              reply["ok"] as? Bool == true, let raw = reply["route"] as? [String: Any] else {
            SmartReplayLog.write("route: no answer for a request of \(text.count) chars")
            return false
        }
        let route = ReplayDispatcher.Route(kind: raw["kind"] as? String ?? "agent", id: raw["id"] as? String,
                                           items: raw["items"] as? [String] ?? [],
                                           overrides: (raw["overrides"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String },
                                           confidence: (raw["confidence"] as? NSNumber)?.doubleValue ?? 0)
        let decision = ReplayDispatcher.decide(route, skills: skills)
        // Names and confidence only, never values.
        SmartReplayLog.write("route: \(route.kind) \(skills.first { $0.id == route.id }?.name ?? "-") at \(route.confidence), "
                             + "\(route.items.count) items → \(decision == .agent ? "agent" : "replay")")
        if decision != .agent, echo { store.appendMessage(threadID: threadID, role: .user, text: text) }
        switch decision {
        case .agent:
            return false
        case .replay(let id, let passes):
            guard let skill = store.skill(id) else { return false }
            let started = startReplayFromChat(skill, times: 1, threadID: threadID, source: source, values: passes, request: text)
            if started {
                store.appendMessage(threadID: threadID, role: .assistant,
                                    text: "this is what “\(skill.name)” does, so i'm replaying it instead of working it out again. say “use the agent” to do it from scratch.")
            }
            return started
        case .template(let id, let passes):
            let added = offered[id].map { store.installTemplate($0) }
            guard let template = added ?? store.skill(id) else { return false }
            return startTemplateRun(template, passes: passes, request: text, threadID: threadID, source: source)
        }
    }
}

extension AppEnvironment {
    // MARK: - Templates: the agent's first run follows the outline, then it's the person's skill

    /// Starts a library template: the agent does the first pass following the template's outline (so it
    /// plans less), and what it did becomes the person's own smart skill; the other passes replay it.
    func startTemplateRun(_ template: Skill, passes: [[String: String]], request: String, threadID: String, source: String) -> Bool {
        guard hasKey("anthropic"), let outline = template.outline, !outline.isEmpty else { return false }
        let first = passes.first ?? [:]
        let given = first.filter { $0.key != "ref" && $0.key != "id" && !$0.value.isEmpty }.sorted { $0.key < $1.key }
        var goal = request.trimmingCharacters(in: .whitespacesAndNewlines)
        if let who = first["ref"], passes.count > 1 { goal += "\n\nDo it for \(who) first; the others come after." }
        if !given.isEmpty { goal += "\n\nValues: " + given.map { "\($0.key) \($0.value)" }.joined(separator: "; ") + "." }
        if let start = template.startURL { goal += "\n\nStart at \(start)." } else if let app = template.startApp { goal += "\n\nUse \(app)." }
        goal += "\n\nA proven way to do it (adapt to what the screen shows; values in {{braces}} come from above or from the person):\n"
            + outline.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        let browser = template.startApp == nil
        let preview = ActionPreview(summary: "\(template.name) — following the library's outline", risk: template.alwaysConfirm == true ? .high : .medium,
                                    steps: outline.prefix(6).map { PreviewStep($0) }, commands: [],
                                    apps: [browser ? "okidoki browser" : (template.startApp ?? "your apps")], files: [])
        let run = store.createRun(kind: browser ? .browser : .computerUse, title: template.name, prompt: goal, threadID: threadID,
                                  preview: preview, steps: preview.steps.map { RunStep(title: $0.text) }, status: .waiting,
                                  builtin: browser ? "browser" : "computer-use")
        templateRuns[run.id] = (template.id, Array(passes.dropFirst()), request, threadID)
        store.appendMessage(threadID: threadID, role: .assistant,
                            text: "first time doing “\(template.name)”: i'll follow the library's outline, then keep it as your skill so next time it's instant.",
                            runID: run.id)
        let decision = BrainDecision(kind: browser ? .browser : .computerUse, title: template.name, answer: "",
                                     risk: template.alwaysConfirm == true ? .high : .medium)
        startOrAsk(run, decision: decision, threadID: threadID, source: source)
        return true
    }
}
