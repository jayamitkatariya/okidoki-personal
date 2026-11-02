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
            if (steps[sub.step].input ?? "").hasPrefix("{{vault:") { continue }
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
        for index in steps.indices where steps[index].isBrowser && steps[index].input != original[index].input {
            steps[index].text = BrowserSteps.line(steps[index].action ?? "click", label: steps[index].label, input: steps[index].input)
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
        let thinks = Dictionary(grouping: compiled.thinkSteps, by: \.before)
        for index in 0...steps.count {
            for think in thinks[index] ?? [] {
                guard ParameterFill.names(in: think.goal + " " + (think.when ?? "")).allSatisfy({ known($0, at: nil) }) else { return nil }
                let near = steps.indices.contains(index) ? steps[index] : steps.last
                out.append(thinkStep(goal: think.goal, when: think.when.map(plainTruth), near: near))
            }
            if index < steps.count, !dropped.contains(index) { out.append(steps[index]) }
        }

        var inputs = compiled.inputs
        if let capture = compiled.capture, !capture.name.isEmpty {
            let last = out.last
            var read = SkillStep(text: "read the \(capture.description ?? capture.name.replacingOccurrences(of: "_", with: " "))",
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
