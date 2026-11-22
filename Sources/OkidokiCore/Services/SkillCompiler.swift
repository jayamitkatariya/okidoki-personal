import Foundation

/// What the model said about a run (`/skill/compile`), as the Mac reads it.
public struct CompiledSkill: Codable, Equatable, Sendable {
    public struct Substitution: Codable, Equatable, Sendable { public var step: Int; public var input: String }
    public struct Condition: Codable, Equatable, Sendable { public var step: Int; public var when: String }
    public struct Loop: Codable, Equatable, Sendable { public var start: Int; public var length: Int; public var over: String }
    public struct Think: Codable, Equatable, Sendable { public var before: Int; public var goal: String; public var when: String? }
    public struct Capture: Codable, Equatable, Sendable { public var name: String; public var example: String; public var description: String? }

    public var name: String?
    public var intent: String
    public var itemNoun: String?
    public var inputs: [SkillInput]
    public var substitutions: [Substitution]
    public var conditions: [Condition]
    public var loops: [Loop]
    public var thinkSteps: [Think]
    public var irreversible: [Int]
    public var capture: Capture?
    public var drop: [Int]
    public var alwaysConfirm: Bool?

    public init(name: String? = nil, intent: String, itemNoun: String? = nil, inputs: [SkillInput] = [],
                substitutions: [Substitution] = [], conditions: [Condition] = [], loops: [Loop] = [],
                thinkSteps: [Think] = [], irreversible: [Int] = [], capture: Capture? = nil, drop: [Int] = [],
                alwaysConfirm: Bool? = nil) {
        self.name = name; self.intent = intent; self.itemNoun = itemNoun; self.inputs = inputs
        self.substitutions = substitutions; self.conditions = conditions; self.loops = loops
        self.thinkSteps = thinkSteps; self.irreversible = irreversible; self.capture = capture
        self.drop = drop; self.alwaysConfirm = alwaysConfirm
    }
}

/// Turns a recorded run into a smart skill: the model's reading of it (which values vary, what's
/// optional, what repeats) applied to the steps, checked, and given anchors and checks from what the
/// run saw. Pure: the Mac asks the brain, this decides what to keep. Anything that doesn't hold up
/// returns nil, and the skill stays exactly as recorded.
public enum SkillCompiler {

    // MARK: - The request

    /// What the brain needs to read the run: its steps (numbered), the pages it went through, and how it
    /// ended. Secrets are never sent: vault placeholders go as they are, and password fields carry no text.
    public static func request(goal: String, summary: String, surface: String, steps: [SkillStep],
                               pages: [StepObservation] = [], pageTexts: [String: String] = [:],
                               documents: [String] = []) -> [String: Any] {
        let numbered: [[String: Any]] = steps.enumerated().map { index, step in
            var row: [String: Any] = ["i": index, "action": step.action ?? "click", "text": step.text]
            if let label = step.label { row["label"] = label }
            if let role = step.role { row["role"] = role }
            if let input = step.input, step.role != "password" { row["input"] = input }
            if let url = step.url { row["url"] = url }
            if !step.app.isEmpty, !step.isBrowser { row["app"] = step.app }
            if let after = step.observedAfter?.landmarks, !after.isEmpty { row["after"] = Array(after.prefix(4)) }
            return row
        }
        var seen = Set<String>()
        var pageRows: [[String: Any]] = []
        for page in pages {
            let key = page.url ?? page.window ?? ""
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            var row: [String: Any] = [:]
            if let url = page.url { row["url"] = url }
            if let title = page.title { row["title"] = title }
            if let text = pageTexts[key] { row["text"] = String(text.prefix(1800)) }
            pageRows.append(row)
        }
        var body: [String: Any] = ["goal": goal, "summary": summary, "surface": surface, "steps": numbered]
        if !pageRows.isEmpty { body["pages"] = pageRows }
        if !documents.isEmpty { body["documents"] = documents }
        return body
    }

    // MARK: - Applying it

    /// The recorded skill made smart, or nil when the model's answer doesn't hold together.
    public static func apply(_ compiled: CompiledSkill, to skill: Skill) -> Skill? {
        let original = skill.steps
        guard !original.isEmpty else { return nil }
        var steps = original
        let declared = Dictionary(compiled.inputs.map { (ParameterFill.key($0.name), $0) }, uniquingKeysWith: { first, _ in first })

        // Placeholders: every name must be declared, an `item.` field inside a loop, a vault field, or a built-in.
        let loopRanges = compiled.loops.map { $0.start..<($0.start + max(1, $0.length)) }
        func known(_ name: String, at index: Int?) -> Bool {
            if name.hasPrefix("vault:") { return true }
            let key = ParameterFill.key(name)
            // A password from the request: its input is added, sensitive, by `finishing`.
            if key == "password" { return true }
            if key.hasPrefix("item_") { return index.map { i in loopRanges.contains { $0.contains(i) } } ?? true }
            return declared[key] != nil || ParameterFill.builtins()[key] != nil
        }

        // Models sometimes write the bare name ("pan") instead of "{{pan}}", or a condition as
        // "{{gains}} == yes" against an amount: both mean the obvious thing.
        func braced(_ text: String) -> String {
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            guard !trimmed.contains("{{") else { return text }
            if declared[ParameterFill.key(trimmed)] != nil || ParameterFill.key(trimmed).hasPrefix("item_") { return "{{\(trimmed)}}" }
            return text
        }
        func plainTruth(_ when: String) -> String {
            when.replacingOccurrences(of: #"(\{\{[^{}]+\}\})\s*==\s*["']?(yes|true|y)["']?"#, with: "$1",
                                      options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: #"(\{\{[^{}]+\}\})\s*==\s*["']?(no|false|n|none)["']?"#, with: "!$1",
                                      options: [.regularExpression, .caseInsensitive])
        }

        for raw in compiled.substitutions {
            let sub = CompiledSkill.Substitution(step: raw.step, input: braced(raw.input))
            guard steps.indices.contains(sub.step) else { return nil }
            // A secret is filled from the vault; nothing may replace that.
            if (steps[sub.step].input ?? "").hasPrefix("{{vault:") || steps[sub.step].input == "{{password}}" { continue }
            guard ParameterFill.names(in: sub.input).allSatisfy({ known($0, at: sub.step) }) else { return nil }
            if steps[sub.step].action == "navigate" { steps[sub.step].url = sub.input }
            steps[sub.step].input = sub.input
        }

        // No literal left behind: a declared input's example still typed somewhere as is gets its placeholder.
        for input in compiled.inputs where !input.isSensitive && input.kind != "list" {
            guard let example = input.example, example.count >= 3 else { continue }
            for index in steps.indices where steps[index].action == "type" || steps[index].action == "select" {
                if steps[index].input == example { steps[index].input = "{{\(input.name)}}" }
            }
        }

        // A click on something named after a value ("New York" in a list of suggestions) is about that
        // value: its label and selectors follow the pass's value, so another city finds its own suggestion.
        for input in compiled.inputs where !input.isSensitive && input.kind != "list" {
            guard let example = input.example, example.count >= 3 else { continue }
            for index in steps.indices where ["click", "hover"].contains(steps[index].action ?? "click") {
                guard let label = steps[index].label, label.localizedCaseInsensitiveContains(example) else { continue }
                // A search result named after the value plus details of that one product ("Apple AirPods Pro 2
                // Wireless Earbuds, Active Noise…"): another product's result shares none of those details. It's
                // "open the result that matches", which takes a look, not a fixed label.
                let rest = label.replacingOccurrences(of: example, with: "", options: .caseInsensitive).filter(\.isLetter)
                if rest.count > max(24, example.count * 2) {
                    var think = thinkStep(goal: "Open the result that best matches {{\(input.name)}} (skip sponsored results and ads). "
                                          + "When this was learned it was “\(label.prefix(80))”. Do only that.", when: steps[index].when, near: steps[index])
                    think.maxTurns = 3
                    think.url = steps[index].url
                    steps[index] = think
                    continue
                }
                steps[index].label = label.replacingOccurrences(of: example, with: "{{\(input.name)}}", options: .caseInsensitive)
                steps[index].selectors = steps[index].selectors?.map {
                    $0.replacingOccurrences(of: example, with: "{{\(input.name)}}", options: .caseInsensitive)
                }
                steps[index].text = "pick “{{\(input.name)}}”"
            }
        }

        for rawCondition in compiled.conditions {
            let condition = CompiledSkill.Condition(step: rawCondition.step, when: plainTruth(rawCondition.when))
            guard steps.indices.contains(condition.step) else { return nil }
            guard ParameterFill.names(in: condition.when).allSatisfy({ known($0, at: condition.step) }) else { return nil }
            steps[condition.step].when = condition.when
        }

        // Loops must not overlap and must run over a declared list.
        let sortedLoops = compiled.loops.sorted { $0.start < $1.start }
        for (n, loop) in sortedLoops.enumerated() {
            guard steps.indices.contains(loop.start), loop.length >= 1, loop.start + loop.length <= steps.count else { return nil }
            guard let list = declared[ParameterFill.key(loop.over)], list.kind == "list" else { return nil }
            if n > 0 { let prior = sortedLoops[n - 1]; guard prior.start + prior.length <= loop.start else { return nil } }
            steps[loop.start].repeatOver = list.name
            steps[loop.start].repeatLength = loop.length
        }

        for index in compiled.irreversible where steps.indices.contains(index) { steps[index].irreversible = true }

        // Lines read with placeholders, so the dashboard shows what's filled in.
        for index in steps.indices where steps[index].input != original[index].input {
            if steps[index].isBrowser {
                steps[index].text = BrowserSteps.line(steps[index].action ?? "click", label: steps[index].label, input: steps[index].input)
            } else if let was = original[index].input, !was.isEmpty, let now = steps[index].input {
                // "in Numbers, type “Asha Rao”" → "in Numbers, type “{{name}}”"
                steps[index].text = steps[index].text.replacingOccurrences(of: was, with: now)
            }
        }

        // Think steps go in before the step they name, so indices above still mean the recorded steps.
        // Dropped steps are removed last for the same reason.
        // Only true detours go: never typing, choosing, signing in or opening a page, which a replay
        // can't do without.
        let dropped = Set(compiled.drop.filter { index in
            steps.indices.contains(index) && !compiled.irreversible.contains(index)
                && !["type", "select", "login", "navigate"].contains(steps[index].action ?? "click")
                && !(steps[index].input ?? "").contains("{{vault:")
        })
        var out: [SkillStep] = []
        // A think step at the end that only reads ("read the top five results and report…") is a capture:
        // one look at the page, and a partial answer is still an answer.
        var capture = compiled.capture
        var thinkSteps = compiled.thinkSteps
        if let last = thinkSteps.last(where: { $0.before >= steps.count }), Self.onlyReads(last.goal), capture == nil || capture?.name.isEmpty == true {
            capture = CompiledSkill.Capture(name: "answer", example: "", description: last.goal)
            thinkSteps.removeAll { $0.before >= steps.count && Self.onlyReads($0.goal) }
        } else if capture != nil {
            thinkSteps.removeAll { $0.before >= steps.count && Self.onlyReads($0.goal) }
        }
        let thinks = Dictionary(grouping: thinkSteps, by: \.before)
        for index in 0...steps.count {
            for think in thinks[index] ?? [] {
                guard ParameterFill.names(in: think.goal + " " + (think.when ?? "")).allSatisfy({ known($0, at: nil) }) else { return nil }
                let near = steps.indices.contains(index) ? steps[index] : steps.last
                out.append(thinkStep(goal: think.goal, when: think.when.map(plainTruth), near: near))
            }
            if index < steps.count, !dropped.contains(index) { out.append(steps[index]) }
        }

        var inputs = compiled.inputs
        if let capture, !capture.name.isEmpty {
            let last = out.last
            // "read the reference number", never "read the The reference number shown…".
            let what = capture.description ?? capture.name.replacingOccurrences(of: "_", with: " ")
            let readText = what.lowercased().hasPrefix("the ") ? "read " + what.prefix(1).lowercased() + what.dropFirst() : "read the " + what
            var read = SkillStep(text: readText,
                                 app: last?.app ?? "", action: "read")
            read.surface = last?.surface
            read.url = last?.observedAfter?.url ?? last?.url
            read.capture = capture.name
            out.append(read)
            if declared[ParameterFill.key(capture.name)] == nil {
                inputs.append(SkillInput(name: capture.name, description: capture.description ?? capture.name, kind: "text",
                                         source: "page", required: false, example: capture.example))
            }
        }

        // Inputs nothing uses are dropped, so binding never asks for values no step types.
        let used = Set(out.flatMap { step -> [String] in
            ParameterFill.names(in: (step.input ?? "") + " " + (step.url ?? "") + " " + (step.when ?? "") + " "
                                + (step.mode == "think" ? step.text : "")).map(ParameterFill.key)
                + [step.repeatOver, step.capture].compactMap { $0 }.map(ParameterFill.key)
        })
        inputs = inputs.filter { used.contains(ParameterFill.key($0.name)) }
        // An input some steps are conditional on, or a loop runs over, is optional by design: empty
        // just means those steps don't happen.
        let gating = Set(out.flatMap { ParameterFill.names(in: $0.when ?? "").map(ParameterFill.key) + [$0.repeatOver].compactMap { $0 }.map(ParameterFill.key) })
        for index in inputs.indices where gating.contains(ParameterFill.key(inputs[index].name)) { inputs[index].required = false }

        var smart = skill
        smart.steps = deriveChecks(out)
        smart.inputs = inputs.isEmpty ? nil : inputs
        smart.intent = compiled.intent.isEmpty ? nil : compiled.intent
        smart.itemNoun = compiled.itemNoun
        smart.alwaysConfirm = compiled.alwaysConfirm == true ? true : nil
        return smart
    }

    /// The same pruning for a bare list of steps (a replay writing what it healed back into the skill).
    public static func pruneStale(steps: [SkillStep]) -> [SkillStep] {
        var carrier = Skill(accountID: "", name: "", summary: "")
        carrier.steps = steps
        return pruneStale(carrier).steps
    }

    /// Steps that can't work on a later replay, removed by rule rather than by asking the model:
    ///
    /// * A `select` whose selectors name the option it chose ("role=combobox|Round trip") only matches
    ///   while the control still reads that. The second time, it reads "One way" and the step can never
    ///   fire again — a replay would spend a model call per attempt on it. When a following step types
    ///   into the same control's field, the select was decoration; it goes.
    /// * Two `select`s on the same control in a row are one choice, made twice.
    /// * A `navigate` to a fully-built search URL from the learned trip (an opaque `?tfs=…` query) can
    ///   only ever repeat that trip. When a later navigate is templated ("{{origin}}…{{destination}}"),
    ///   it is the one that can fly other routes: the fixed one goes.
    public static func pruneStale(_ skill: Skill) -> Skill {
        var made = skill
        var steps = made.steps
        var drop = Set<Int>()
        /// Where a date picker's walk was replaced: (the walk's first index, the goal, the field).
        var dateReplacement: (at: Int, goal: String, near: SkillStep)?

        for index in steps.indices {
            let step = steps[index]
            guard step.action == "select" else { continue }
            // A recorded choice's selectors are built from what the control showed when it was recorded
            // ("role=combobox|Round trip"), while the step sets the option chosen ("One way"). Once the
            // control shows anything else, those selectors can never match again: the second replay
            // fails this step every time and, with a model available, asks it for help it doesn't need.
            // The structural selectors still identify the control, so keep them and drop the ones that
            // were read off the value.
            let chosen = (step.input ?? "").lowercased().trimmingCharacters(in: .whitespaces)
            if let selectors = step.selectors, !chosen.isEmpty {
                var kept: [String] = []
                for selector in selectors {
                    let s = selector.lowercased()
                    let namesAValue = s.contains("|") || s.hasPrefix("text=")
                    if !namesAValue { kept.append(selector); continue }
                    // Keep only a value-read selector that names the option this step actually sets.
                    if s.contains("|\(chosen)") || s.hasSuffix("|\(chosen)") { kept.append(selector) }
                }
                if kept.count != selectors.count {
                    // Nothing structural to fall back on: this step can't be found again at all.
                    if kept.isEmpty { drop.insert(index); continue }
                    steps[index].selectors = kept
                }
            }
            // The same control chosen the same way more than once: the first time already did it, and a
            // replay that does it again re-opens a menu it closed (the model then gets asked why).
            let earlier = steps[..<index].contains { other in
                other.action == "select" && (other.input ?? "").lowercased() == chosen && !chosen.isEmpty
            }
            if earlier { drop.insert(index) }
        }

        // Keys that only walked a menu: a run that opened a dropdown and pressed ArrowDown/ArrowUp/Tab
        // to reach an option. The select step now opens the menu and clicks the option itself, so on the
        // second replay these would press into whatever happens to be focused. Only a run of them
        // straight after a select goes; a key press anywhere else is the job.
        if let selectAt = steps.indices.last(where: { steps[$0].action == "select" }) {
            var index = selectAt + 1
            while index < steps.count, steps[index].action == "press",
                  ["arrowdown", "arrowup", "arrowleft", "arrowright", "tab"].contains((steps[index].input ?? "").lowercased()) {
                drop.insert(index)
                index += 1
            }
        }
        // A navigate with no address does nothing a replay can use.
        for index in steps.indices where steps[index].action == "navigate" && (steps[index].url ?? "").isEmpty && (steps[index].input ?? "").isEmpty {
            drop.insert(index)
        }

        // A calendar's own steps pick *this run's* day, and a month/Next/day/Done walk can't be replayed
        // for another date: the second pass would click the same day again. The prompt asks the model to
        // replace these with a think step, and it often doesn't. The pattern is mechanical, so enforce it:
        // a run of clicks that includes a month name or a bare day number, right after a date field, is a
        // date-picker walk. It goes, and a think step is put in its place that sets the field's value.
        let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
                      "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
                      "oct", "nov", "dec"]
        func isDateWalk(_ step: SkillStep) -> Bool {
            guard step.action == "click" else { return false }
            let text = (step.label ?? step.text).lowercased()
            if text.contains("done") && text.contains("departing") { return true }
            if months.contains(where: { text == $0 || text.hasPrefix($0 + " ") }) { return true }
            return Int(text.trimmingCharacters(in: .whitespaces)) != nil
        }
        var dateField: SkillStep?
        for index in steps.indices where steps[index].action == "click" {
            let text = (steps[index].label ?? steps[index].text).lowercased()
            if ["depart", "departure", "return", "date", "check-in", "check in", "check-out"].contains(where: { text.contains($0) }) {
                dateField = steps[index]
            }
        }
        if let dateField {
            // Replace the walk with one think step that sets the date by value, so the next pass enters
            // its own date instead of clicking this run's day again. The walk is dropped, and the think
            // step is placed where the walk began (recorded by its anchor, not its index, so the drops
            // don't shift it).
            let placeholder = ParameterFill.names(in: dateField.input ?? "").first
            let goal = "Set “\(dateField.label ?? "the date field")” to "
                + (placeholder.map { "{{\($0)}}" } ?? "the date this run used")
                + " with the page's date picker: open it, move to the right month and year, click the day, "
                + "then confirm. Check the field shows that date before carrying on."
            var index = 0
            while index < steps.count {
                guard isDateWalk(steps[index]) else { index += 1; continue }
                let start = index
                while index < steps.count, steps[index].action == "click", isDateWalk(steps[index]) { index += 1 }
                for walkIndex in start..<index { drop.insert(walkIndex) }
                let already = steps.contains { $0.mode == "think" && $0.text.lowercased().contains("date") }
                if !already { dateReplacement = (start, goal, dateField) }
                index += 1
            }
        }
        // A think step that names a control a kept step already handles ("open the Stops filter…") is the
        // model's guess at work a plain step can do; it costs a call per replay for nothing. A think step
        // with no kept step on the same page is left alone: it may be a real hand-off.
        let keptActions = steps.indices.filter { !drop.contains($0) }.map { steps[$0] }
        for index in steps.indices where steps[index].mode == "think" {
            let goal = steps[index].text.lowercased()
            let covered = keptActions.contains { other in
                guard other.action != "think", let label = other.label?.lowercased(), label.count >= 4 else { return false }
                return goal.contains(label)
            }
            if covered { drop.insert(index) }
        }

        // A think step that only presses one named control ("click the 'Stops' filter button, choose
        // 'Nonstop only', then close the panel") is work a plain click can do: the model is being paid
        // per replay for a button it can name. The talk is turned into steps that name the control, and
        // the replay's own retry finds it once the page is ready.
        for index in steps.indices where steps[index].mode == "think" {
            let goal = steps[index].text
            guard let control = Self.singleControl(in: goal) else { continue }
            var made = SkillStep.browser("click", text: "click “\(control)”", url: steps[index].url ?? "",
                                         selectors: ["role=button|\(control)", "text=button|\(control)"],
                                         label: control)
            made.delay = 0.6
            steps[index] = made
        }

        // The same click on the same control, on the same page, more than once: an agent often re-presses
        // a button whose first press was still landing. A replay that repeats it presses whatever has
        // moved into place (a date picker's Done closes it, and the second press hits something else).
        // The page is part of the key so "Next" on two different pages is kept.
        var seenClicks: Set<String> = []
        for index in steps.indices where steps[index].action == "click" {
            let page = URLComponents(string: steps[index].url ?? "")?.path ?? (steps[index].url ?? "")
            let key = page.lowercased() + "|" + (steps[index].label ?? steps[index].text).lowercased()
                + "|" + (steps[index].selectors ?? []).joined(separator: ",")
            if !seenClicks.insert(key).inserted { drop.insert(index) }
        }
        // The same field typed into more than once: a control the page renames as its suggestion box
        // opens ("Where from?" reads "Where else?" once it has focus). It is one field, only the last
        // value matters, and replaying both types it twice. Matched exactly on purpose: "Where from?" and
        // "Where to?" are two different airports and both must be typed.
        var typedField: [String: Int] = [:]
        for index in steps.indices where steps[index].action == "type" {
            let label = (steps[index].label ?? "").lowercased()
            guard !label.isEmpty else { continue }
            if let earlier = typedField[label] { drop.insert(earlier) }
            typedField[label] = index
        }
        // A click on the control the very next step then chooses from: the click only opened the menu
        // the select now opens for itself.
        for index in steps.indices where steps[index].action == "click" {
            guard index + 1 < steps.count, steps[index + 1].action == "select" else { continue }
            let clicked = (steps[index].label ?? steps[index].text).lowercased()
            let chosen = (steps[index + 1].input ?? "").lowercased()
            let selectors = (steps[index + 1].selectors ?? []).joined(separator: " ").lowercased()
            // The select's own selectors name the control as it read *before* the choice, which is what
            // the click named.
            if !clicked.isEmpty, selectors.contains("|\(clicked)") || clicked == chosen { drop.insert(index) }
        }

        let navigates = steps.indices.filter { steps[$0].action == "navigate" }
        // Two navigates with no step between them are one: the agent pressed Search and then also went to
        // the address it produced. Replaying both reloads the results page a second time, which starts the
        // list building again — and the read after it then reads a half-built page and answers nothing.
        for (first, second) in zip(navigates, navigates.dropFirst()) where second == first + 1 {
            let a = steps[first].url ?? steps[first].input ?? ""
            let b = steps[second].url ?? steps[second].input ?? ""
            // Keep the templated one if either is (it can fly other routes), else the later one (where the
            // run actually ended up).
            if a.contains("{{"), !b.contains("{{") { drop.insert(second) } else { drop.insert(first) }
            _ = (a, b)
        }
        // A click on the button whose job a `navigate` right after it already does ("click Search", then
        // "open …/search"). Google Flights' search is a single-page app: the click is what the agent did,
        // but the recorded address is what actually arrives at the results, and the button no longer
        // exists once the URL has moved on. The click can only ever miss.
        for index in steps.indices where steps[index].action == "click" {
            let next = steps.indices.first { $0 > index && steps[$0].action != "think" }
            guard let next, steps[next].action == "navigate" else { continue }
            let clicked = (steps[index].label ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            guard clicked.count >= 4 else { continue }
            let target = ((steps[next].url ?? "") + " " + (steps[next].input ?? "")).lowercased()
            // The button's whole label has to be where the address goes ("Search" → "…/search",
            // "Find flights" → "…/find-flights"): a "Continue" that happens to precede a navigate to an
            // unrelated page is real work and stays.
            let slug = clicked.replacingOccurrences(of: " ", with: "-")
            if target.contains(clicked) || target.contains(slug) { drop.insert(index) }
        }
        // A built search address from the run (?tfs=…, an encoded itinerary) carries the learned trip in
        // it. When a templated navigate exists it's the one that can fly other routes and the built one
        // goes (below). When it's the *only* navigate it is still the skill's starting page: dropping it
        // left the replay on whatever tab happened to be open, so the first click missed and the whole
        // run handed over to the agent.
        if navigates.count > 1,
           let templated = navigates.first(where: { (steps[$0].url ?? "").contains("{{") || (steps[$0].input ?? "").contains("{{") }) {
            for index in navigates where index != templated {
                let url = steps[index].url ?? ""
                // Only the learned trip's own built URL: an opaque query it could never reproduce.
                if !url.contains("{{") && (url.contains("?tfs=") || url.contains("#flt=")) { drop.insert(index) }
            }
            // A templated address that already carries the whole search ("…?q=one way flights from
            // {{origin}} to {{destination}} on {{date}} {{cabin}}") does the form's job by itself. The
            // typing and choosing before it only repeats the learned trip's details, and (having been
            // recorded on the first page) they can't be found again once the address bar has moved on.
            let fills = ["{{origin}}", "{{destination}}", "{{departure_date}}"].filter { (steps[templated].url ?? "").contains($0) }
            if fills.count >= 2 {
                for index in steps.indices where index < templated {
                    if ["type", "select", "press"].contains(steps[index].action ?? "") { drop.insert(index) }
                }
            }
        }

        if !drop.isEmpty || dateReplacement != nil {
            var out: [SkillStep] = []
            for (index, step) in steps.enumerated() {
                if let replacement = dateReplacement, replacement.at == index, drop.contains(index) {
                    out.append(Self.thinkStep(goal: replacement.goal, when: nil, near: replacement.near))
                }
                if !drop.contains(index) { out.append(step) }
            }
            steps = out
        }
        // Written back even when nothing was dropped: the selectors repaired above are part of the result.
        made.steps = steps
        return made
    }

    /// The one control a think step names, when pressing it is all the step asks for.
    ///
    /// "Click the 'Stops' filter button" → "Stops". Anything with a value to type, a choice to make
    /// from several options, a scroll, or more than one quoted control is real thinking and stays a
    /// think step: only the mechanical case is turned into a plain click.
    static func singleControl(in goal: String) -> String? {
        let lower = goal.lowercased()
        guard lower.contains("click") || lower.contains("press") || lower.contains("open") else { return nil }
        // A step that also types, chooses a value or walks a list needs judgment.
        let judgement = ["type ", "enter ", "fill", "choose", "select", "each ", "for each", "scroll", "drag",
                         "if ", "when ", "depending", "match", "find the", "work out", "confirm it",
                         // Two jobs in one step ("click X, then close Y") is a sequence, not one press.
                         " then ", " and then", "also "]
        guard !judgement.contains(where: { lower.contains($0) }) else { return nil }
        // A comma usually joins a second control ("click the filter button, choose nonstop").
        guard !goal.contains(",") else { return nil }
        // Every quoted piece: exactly one means one control. Two or more is a menu walk.
        var quoted: [String] = []
        for (open, close) in [("“", "”"), ("'", "'"), ("\"", "\"")] {
            var rest = Substring(goal)
            while let start = rest.firstIndex(of: Character(open)) {
                let after = rest.index(after: start)
                guard let end = rest[after...].firstIndex(of: Character(close)) else { break }
                quoted.append(String(rest[after..<end]))
                rest = rest[rest.index(after: end)...]
            }
        }
        guard quoted.count == 1, let name = quoted.first, !name.isEmpty, name.count <= 40 else { return nil }
        // A quoted value written in the goal is something to type, not a control to press.
        guard !name.contains("{{") else { return nil }
        return name
    }

    /// The step that opens the page a browser skill starts on. The same page a person was on when the
    /// run began, so the replay never depends on which tab happened to be in front.
    static func startStep(url: String, near: SkillStep?) -> SkillStep {
        var step = SkillStep.browser("navigate", text: "open \(BrowserSteps.displayURL(url))", url: url, input: url, delay: 0)
        step.surface = "browser"
        step.app = near?.app ?? "okidoki browser"
        step.observedAfter = near?.observedAfter
        return step
    }

    /// A request that wants something back ("…and tell me the message", "what is the email of…").
    public static func asksForAnswer(_ goal: String) -> Bool {
        let g = goal.lowercased()
        return g.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?")
            || ["tell me", "what is", "what's", "what are", "what was", "how many", "how much", "which ", "find out", "look up",
                "let me know", "report ", "read me", "give me"].contains { g.contains($0) }
    }

    /// Finishing touches on a compiled skill, whatever the compiler said:
    /// - a browser skill starts by opening its page, so a replay never begins on whatever tab happens
    ///   to be open (which is how a whole replay ended up handing over to the agent at step 1);
    /// - a request that wants an answer gets a final read step (the compiler sometimes leaves it out, and
    ///   then a replay does everything and says nothing);
    /// - a `{{password}}` step (a password the person gave in the request) has its input, sensitive.
    public static func finishing(_ skill: Skill, goal: String) -> Skill {
        var made = pruneStale(skill)
        if made.runsInBrowser, let first = made.steps.first, first.action != "navigate" {
            // The page the first step happens on. A recorded page can carry the learned trip in it; the
            // steps after it type this pass's own values, so the address is only the way in.
            if let url = first.url ?? first.observedAfter?.url, !url.isEmpty {
                made.steps.insert(Self.startStep(url: url, near: first), at: 0)
            }
        }
        // Pruned again: adding the opening page can leave two navigates in a row (the skill's own first
        // step was a navigate to another page), and that pair reloads the page the read depends on.
        made = pruneStale(made)
        var inputs = made.inputs ?? []
        let has = { (name: String) in inputs.contains { ParameterFill.key($0.name) == ParameterFill.key(name) } }
        // A value the recording never varied ("cabin: economy", "adults: 1") isn't something to ask for
        // every pass: it is what the skill does. Asking anyway made a replay refuse to start over a value
        // it already knew. Its example becomes its default, and it stops being required.
        //
        // A value the skill *types into a field for the pass* is different: origin, destination, a date.
        // Seeding those with the learned trip's example made every replay fly the recorded route — the
        // input was there, the binding filled it with the example, and the new values never arrived.
        let passDriven = Set(made.steps.compactMap { step -> String? in
            guard step.action == "type" || step.action == "select" else { return nil }
            return ParameterFill.names(in: step.input ?? "").first.map(ParameterFill.key)
        })
        for index in inputs.indices where inputs[index].source != "page" && inputs[index].source != "record" {
            guard let example = inputs[index].example, !example.isEmpty else { continue }
            inputs[index].required = false
            if inputs[index].value == nil, !passDriven.contains(ParameterFill.key(inputs[index].name)) {
                inputs[index].value = example
            }
        }
        // A step still typing the value the run was learned with, in a *different form* than the input's
        // example ("San Francisco" while the example is "SFO"), keeps the literal — and then every replay
        // types the learned trip's city again. Only a confident match rewrites: the field has to be named
        // for the input (its name, its description, or a well-known label for that input), so a passenger
        // count is never turned into a city.
        func matches(_ input: SkillInput, label: String, stepText: String) -> Bool {
            guard input.source != "page", input.sensitive != true else { return false }
            let name = input.name.lowercased()
            let key = ParameterFill.key(input.name).replacingOccurrences(of: "_", with: " ")
            // The input's own name as a word ("origin", "destination", "depart date").
            if key.count >= 4, label.contains(key) || stepText.contains("in “\(key)") { return true }
            // The label words the provider uses for this input ("Where from?" for an origin).
            let named = (input.description + " " + (input.hint ?? "")).lowercased()
            let pairs: [(field: String, input: [String])] = [
                ("where from", ["origin", "from", "departure city", "departure airport"]),
                ("where to", ["destination", "to city", "arrival city", "arrival airport"]),
                ("departure", ["depart date", "departure date", "date"]),
                ("return", ["return date", "return"]),
            ]
            for (field, words) in pairs where label.contains(field) {
                if words.contains(where: { name.contains($0) || named.contains($0) }) { return true }
            }
            return false
        }
        for index in made.steps.indices where made.steps[index].action == "type" {
            let typed = (made.steps[index].input ?? "")
            guard !typed.contains("{{"), !typed.isEmpty, !typed.hasPrefix("{{vault:") else { continue }
            let label = (made.steps[index].label ?? "").lowercased()
            let stepText = made.steps[index].text.lowercased()
            guard let match = inputs.first(where: { matches($0, label: label, stepText: stepText) }) else { continue }
            made.steps[index].input = "{{\(match.name)}}"
            made.steps[index].text = BrowserSteps.line("type", label: made.steps[index].label, input: "{{\(match.name)}}")
        }
        if made.steps.contains(where: { ($0.input ?? "").contains("{{password}}") }), !has("password") {
            inputs.append(SkillInput(name: "password", description: "the password to sign in with, as given in the request", kind: "text",
                                     sensitive: true, required: true))
        }
        // Every placeholder a step uses has an input (the compiler sometimes names one in a read or think
        // step without declaring it, and then the replay can't fill it).
        let builtins = ParameterFill.builtins()
        for step in made.steps {
            for name in ParameterFill.names(in: step.text + " " + (step.input ?? "") + " " + (step.when ?? "")) {
                let key = ParameterFill.key(name)
                guard !name.hasPrefix("vault:"), !key.hasPrefix("item_"), builtins[key] == nil, !has(name) else { continue }
                inputs.append(SkillInput(name: name, description: name.replacingOccurrences(of: "_", with: " "), kind: "text", required: true))
            }
        }
        if asksForAnswer(goal), !made.steps.contains(where: { $0.capture != nil }) {
            // What to read, in the request's words with this run's values swapped for their inputs.
            var what = goal
            for input in inputs where input.sensitive != true {
                if let example = input.example, example.count >= 2 { what = what.replacingOccurrences(of: example, with: "{{\(input.name)}}") }
            }
            let last = made.steps.last
            var read = SkillStep(text: "read the answer to: \(what)", app: last?.app ?? "", action: "read")
            read.surface = last?.surface
            read.url = last?.observedAfter?.url ?? last?.url
            read.capture = "answer"
            made.steps.append(read)
            if !has("answer") {
                inputs.append(SkillInput(name: "answer", description: "what the request asked for: \(what)", kind: "text", required: false))
            }
        }
        made.inputs = inputs.isEmpty ? made.inputs : inputs
        return made
    }

    /// A goal that only reads or reports what's on the page, with nothing to click, type or choose.
    static func onlyReads(_ goal: String) -> Bool {
        let g = goal.lowercased()
        let reads = ["read", "report", "list ", "note ", "find out", "look up", "tell me", "extract"].contains { g.contains($0) }
        let acts = ["click", "type ", "choose", "select", "enter ", "fill", "press", "tick", "add ", "submit", "open ", "scroll", "sort", "filter"]
            .contains { g.contains($0) }
        return reads && !acts
    }

    static func thinkStep(goal: String, when: String?, near: SkillStep?) -> SkillStep {
        var step = SkillStep(text: goal, app: near?.app ?? "", action: "think")
        step.mode = "think"
        step.when = when
        step.maxTurns = 14
        step.surface = near?.surface
        step.url = near?.url
        return step
    }

    // MARK: - Anchors and checks from what the run saw

    /// Each browser step gets the page it happens on as its anchor (path, and a heading seen there), and a
    /// step that led to another page expects that page. A step that already has one keeps it.
    public static func deriveChecks(_ steps: [SkillStep]) -> [SkillStep] {
        var out = steps
        for index in out.indices where out[index].isBrowser {
            let step = out[index]
            let action = step.action ?? "click"
            guard action != "navigate", action != "think", let url = step.url, let path = URLComponents(string: url)?.path,
                  !path.isEmpty else { continue }
            if out[index].anchor == nil {
                var anchor = StepAnchor(path: path)
                if index > 0, let seen = out[index - 1].observedAfter, samePath(seen.url, path) {
                    anchor.landmark = seen.landmarks?.first
                }
                out[index].anchor = anchor
            }
            // What came next happened on another page: this step took it there.
            if out[index].expect == nil, ["click", "press", "login"].contains(action),
               let nextURL = out[(index + 1)...].first(where: { $0.action != "think" })?.url,
               let nextPath = URLComponents(string: nextURL)?.path, !nextPath.isEmpty, !samePath(url, nextPath) {
                let last = nextPath.split(separator: "/").last.map(String.init) ?? nextPath
                out[index].expect = StepExpectation(urlContains: last)
            }
        }
        return out
    }

    private static func samePath(_ url: String?, _ path: String) -> Bool {
        guard let url else { return false }
        let a = (URLComponents(string: url)?.path ?? url).lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let b = path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return a == b
    }

    // MARK: - Summary

    /// "6 values change per person · 2 parts only when needed" for the save toast.
    public static func describe(_ skill: Skill) -> String {
        let inputs = (skill.inputs ?? []).filter { $0.source != "page" }
        var bits: [String] = []
        if !inputs.isEmpty {
            let fromDocs = inputs.filter { $0.source == "document" }.count
            bits.append("\(inputs.count) \(inputs.count == 1 ? "value changes" : "values change") per \(skill.itemNoun ?? "run")"
                        + (fromDocs > 0 ? ", \(fromDocs) from your documents" : ""))
        }
        let optional = skill.steps.filter { $0.when != nil }.count
        if optional > 0 { bits.append("\(optional) \(optional == 1 ? "step" : "steps") only when needed") }
        let thinks = skill.steps.filter { $0.mode == "think" }.count
        if thinks > 0 { bits.append("\(thinks) \(thinks == 1 ? "part" : "parts") it works out each time") }
        return bits.joined(separator: " · ")
    }
}
