import Foundation

/// Turns a think step back into plain steps once the model has done it: what it clicked and typed,
/// with the typed values traced back to the pass's inputs. A list ("add each deduction") becomes a loop
/// over that list, with per-row selectors written as `{{item.index}}`. Only when every action maps
/// cleanly; otherwise the think step stays, and the next replay works it out again.
public enum SkillPromoter {

    /// One page action the model took during a think step.
    public struct Action: Equatable, Sendable {
        public var action: String
        public var selectors: [String]
        public var label: String?
        public var role: String?
        /// What was typed or chosen, or the key pressed.
        public var input: String?
        public var url: String?
        public init(action: String, selectors: [String], label: String? = nil, role: String? = nil, input: String? = nil, url: String? = nil) {
            self.action = action; self.selectors = selectors; self.label = label; self.role = role; self.input = input; self.url = url
        }
    }

    /// The plain steps that do what `think` did, or nil when it can't be expressed without the model.
    public static func promote(_ think: SkillStep, actions: [Action], values: [String: String], inputs: [SkillInput]) -> [SkillStep]? {
        let acted = actions.filter { $0.action != "scroll" && $0.action != "hover" }
        guard !acted.isEmpty, acted.allSatisfy({ !$0.selectors.isEmpty || $0.action == "press" }) else { return nil }
        // A click on something picked for this pass's data (the search result for "AirPods Pro 2") would
        // be that same thing on every pass: it stays a look.
        let picked = values.filter { key, value in !key.hasPrefix("today") && !key.hasPrefix("item.") && key != "ref" && value.count >= 3 }.map(\.value)
        if acted.contains(where: { action in
            action.action == "click" && picked.contains { value in (action.label ?? "").localizedCaseInsensitiveContains(value) }
                && (action.label ?? "").count > 40
        }) { return nil }
        let named = Set(ParameterFill.names(in: think.text + " " + (think.when ?? "")).map(ParameterFill.key))
        let lists = inputs.filter { $0.kind == "list" && named.contains(ParameterFill.key($0.name)) }
        if let list = lists.first {
            let entries = HybridReplay.listValue(values[list.name] ?? "")
            guard !entries.isEmpty else { return nil }
            return loop(think, acted, list: list, entries: entries)
        }
        // A one-off: every typed value has to be one of the pass's values.
        var out: [SkillStep] = []
        for action in acted {
            var input = action.input
            if let typed = action.input, ["type", "select"].contains(action.action) {
                guard let source = inputs.first(where: { input in
                    guard input.kind != "list", let value = values[input.name], !value.isEmpty else { return false }
                    return HybridReplay.sameValue(typed: value, field: typed)
                        || SkillBinder.choice(value, in: input.choices).lowercased() == typed.lowercased()
                }) else { return nil }
                input = "{{\(source.name)}}"
            }
            out.append(step(action, input: input, near: think))
        }
        // A condition covers the whole block: each step carries it.
        return out.map { var s = $0; s.when = think.when; return s }
    }

    private static func loop(_ think: SkillStep, _ acted: [Action], list: SkillInput, entries: [[String: String]]) -> [SkillStep]? {
        let n = entries.count
        guard acted.count % n == 0 else { return nil }
        let k = acted.count / n
        let blocks = (0..<n).map { Array(acted[($0 * k)..<($0 * k + k)]) }
        // Same actions in the same order in every row.
        let shape = blocks[0].map(\.action)
        guard blocks.allSatisfy({ $0.map(\.action) == shape }) else { return nil }
        var body: [SkillStep] = []
        for position in 0..<k {
            let column = blocks.map { $0[position] }
            var input = column[0].input
            if ["type", "select"].contains(shape[position]) {
                // The field of each row's entry that this action typed: the same field in every row.
                let fields = (entries.first ?? [:]).keys.sorted()
                guard let field = fields.first(where: { field in
                    zip(column, entries).allSatisfy { action, entry in
                        guard let typed = action.input, let want = entry[field] else { return false }
                        return HybridReplay.sameValue(typed: want, field: typed) || want.lowercased() == typed.lowercased()
                    }
                }) else { return nil }
                input = "{{item.\(field)}}"
            }
            guard let selectors = template(column.map(\.selectors)), !selectors.isEmpty || shape[position] == "press" else { return nil }
            var step = step(column[0], input: input, near: think)
            step.selectors = selectors
            if position == 0 { step.repeatOver = list.name; step.repeatLength = k }
            step.when = think.when
            body.append(step)
        }
        return body
    }

    /// Selectors that find the element in every row: ones that are the same in all rows, and ones where
    /// only the row number changes (`#amount-1`, `#amount-2` → `#amount-{{item.index}}`).
    static func template(_ rows: [[String]]) -> [String]? {
        guard let first = rows.first else { return nil }
        // When each row's element is a different one (#amount-1, #amount-2), a selector that's the same in
        // every row would only ever find the first row's: keep the per-row ones only.
        let perRow = rows.count > 1 && rows.contains { Set($0) != Set(first) }
        var out: [String] = []
        for selector in first {
            if rows.allSatisfy({ $0.contains(selector) }) { if !perRow { out.append(selector) }; continue }
            // Each run of digits that reads "1" in the first row, tried as the row number.
            let ns = selector as NSString
            let regex = try! NSRegularExpression(pattern: #"(?<![0-9])1(?![0-9])"#)
            for match in regex.matches(in: selector, range: NSRange(location: 0, length: ns.length)) {
                let candidate = ns.replacingCharacters(in: match.range, with: "{{item.index}}")
                let fits = rows.enumerated().allSatisfy { row, selectors in
                    selectors.contains(candidate.replacingOccurrences(of: "{{item.index}}", with: String(row + 1)))
                }
                if fits { out.append(candidate); break }
            }
        }
        // A selector that only works in some rows (a css path) isn't kept; one that works in all is enough.
        return out.isEmpty ? nil : out
    }

    private static func step(_ action: Action, input: String?, near: SkillStep) -> SkillStep {
        var step = SkillStep.browser(action.action, text: BrowserSteps.line(action.action, label: action.label, input: input),
                                     url: action.url ?? near.url ?? "", selectors: action.selectors, label: action.label,
                                     role: action.role, input: input, delay: 0.3)
        step.surface = near.surface ?? "browser"
        return step
    }

    /// The skill's steps with the think step at `index` replaced by `steps`.
    public static func replacing(_ skill: [SkillStep], at index: Int, with steps: [SkillStep]) -> [SkillStep] {
        guard skill.indices.contains(index), skill[index].mode == "think" else { return skill }
        var out = skill
        out.replaceSubrange(index...index, with: steps)
        return out
    }
}
