import Foundation

/// The decisions a hybrid replay makes in code, shared by the browser and the Mac replayers: which
/// steps a pass runs (conditions and loops), whether the screen is where a step expects, where to
/// re-sync when it isn't, when to pause before something irreversible, and how values are typed,
/// checked and read back. No model here; the model is only asked when these say it's needed.
public enum HybridReplay {

    // MARK: - The pass plan

    /// One step as a pass will run it: the step, which recorded step it came from, the loop entry it
    /// belongs to, and the values it's filled with.
    public struct Planned: Equatable, Sendable {
        public var step: SkillStep
        /// Index in the skill's steps.
        public var source: Int
        /// Which loop entry (0-based), when the step is inside a `repeatOver`.
        public var iteration: Int?
        public var values: [String: String]
    }

    /// The pass's steps with conditions applied and loops unrolled. A loop over an empty list is skipped
    /// entirely (a person with no deductions never clicks "add row").
    public static func plan(_ steps: [SkillStep], values: [String: String]) -> [Planned] {
        var out: [Planned] = []
        var index = 0
        while index < steps.count {
            let step = steps[index]
            if let list = step.repeatOver, !list.isEmpty {
                let length = max(1, min(step.repeatLength ?? 1, steps.count - index))
                let body = Array(steps[index..<(index + length)])
                let entries = listValue(values[list] ?? values[ParameterFill.key(list)] ?? "")
                for (n, entry) in entries.enumerated() {
                    var scoped = values
                    for (field, value) in entry { scoped["item.\(field)"] = value }
                    scoped["item.index"] = String(n + 1)
                    for (offset, inner) in body.enumerated() where condition(inner.when, values: scoped) {
                        out.append(Planned(step: inner, source: index + offset, iteration: n, values: scoped))
                    }
                }
                index += length
                continue
            }
            if condition(step.when, values: values) {
                out.append(Planned(step: step, source: index, iteration: nil, values: values))
            }
            index += 1
        }
        return out
    }

    /// A list input's entries. Values travel as strings, so a list is JSON: `[{"section":"80C","amount":"150000"}]`,
    /// or a plain array of strings (each becomes `{{item.value}}`).
    public static func listValue(_ raw: String) -> [[String: String]] {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("["), let data = text.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
        return array.compactMap { element in
            if let object = element as? [String: Any] { return object.mapValues { stringify($0) } }
            if element is NSNull { return nil }
            return ["value": stringify(element)]
        }
    }

    public static func encodeList(_ entries: [[String: String]]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys]) else { return "[]" }
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    private static func stringify(_ value: Any) -> String {
        if let string = value as? String { return string }
        if let number = value as? NSNumber {
            // JSON numbers come back as doubles; 150000.0 should type as 150000.
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 1e15 { return String(Int64(double)) }
            return number.stringValue
        }
        if JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) {
            return String(data: data, encoding: .utf8) ?? ""
        }
        return "\(value)"
    }

    // MARK: - Conditions

    /// `{{x}}` is true when x has a value that isn't a "no" (empty, 0, false, no, none, n/a, nil).
    /// `{{x}} == old` / `!=` compare loosely (case and spaces ignored). `!` negates; `&&` binds tighter
    /// than `||`. A missing or empty condition is true. Anything unparseable is false, so a broken
    /// condition skips a step rather than doing it for everyone.
    public static func condition(_ expression: String?, values: [String: String]) -> Bool {
        guard let expression = expression?.trimmingCharacters(in: .whitespacesAndNewlines), !expression.isEmpty else { return true }
        return expression.components(separatedBy: "||").contains { clause in
            clause.components(separatedBy: "&&").allSatisfy { term(String($0), values: values) }
        }
    }

    private static func term(_ raw: String, values: [String: String]) -> Bool {
        var text = raw.trimmingCharacters(in: .whitespaces)
        var negate = false
        while text.hasPrefix("!") && !text.hasPrefix("!=") {
            negate.toggle()
            text = String(text.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        let result: Bool
        if let range = text.range(of: "!=") ?? text.range(of: "==") {
            let isEqual = text[range] == "=="
            let left = resolve(String(text[..<range.lowerBound]), values: values)
            let right = resolve(String(text[range.upperBound...]), values: values)
            guard let left, let right else { return false }
            result = (loose(left) == loose(right)) == isEqual
        } else {
            guard let value = resolve(text, values: values) else { return negate }
            result = truthy(value)
        }
        return negate ? !result : result
    }

    /// `{{name}}` → its value ("" when it has none); a bare word or quoted text → itself.
    private static func resolve(_ raw: String, values: [String: String]) -> String? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("{{"), text.hasSuffix("}}") {
            let name = String(text.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
            let lookup = Dictionary(values.map { (ParameterFill.key($0.key), $0.value) }, uniquingKeysWith: { _, last in last })
            return lookup[ParameterFill.key(name)] ?? ""
        }
        guard !text.isEmpty else { return nil }
        return text.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”"))
    }

    public static func truthy(_ value: String) -> Bool {
        let v = loose(value)
        if ["", "0", "false", "no", "none", "n/a", "na", "nil", "null", "[]", "{}"].contains(v) { return false }
        // A number that's zero ("0.00", "0,000") is no.
        let digits = v.filter(\.isNumber)
        if !digits.isEmpty, v.allSatisfy({ $0.isNumber || ",. ₹$€£".contains($0) }), digits.allSatisfy({ $0 == "0" }) { return false }
        return true
    }

    private static func loose(_ value: String) -> String {
        value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Where we are

    /// The screen as a replayer sees it.
    public struct Observation: Equatable, Sendable {
        public var url: String
        public var title: String
        /// Visible text, enough to find landmarks and expected text in.
        public var text: String
        public var app: String
        public var window: String
        public init(url: String = "", title: String = "", text: String = "", app: String = "", window: String = "") {
            self.url = url; self.title = title; self.text = text; self.app = app; self.window = window
        }
    }

    /// Whether the screen is where the anchor says. Nil and empty anchors match anything: a step
    /// learned without one is never second-guessed.
    public static func matches(_ anchor: StepAnchor?, _ seen: Observation) -> Bool {
        guard let anchor, !anchor.isEmpty else { return true }
        if let path = anchor.path, !path.isEmpty {
            let here = URLComponents(string: seen.url)?.path ?? seen.url
            if normalizedPath(here) != normalizedPath(path) { return false }
        }
        if let app = anchor.app, !app.isEmpty, !SkillReplayGeometry.sameApp(seen.app, app) { return false }
        if let window = anchor.window, !window.isEmpty, !contains(seen.window, window) { return false }
        if let title = anchor.title, !title.isEmpty, !contains(seen.title, title) { return false }
        if let landmark = anchor.landmark, !landmark.isEmpty, !contains(seen.text, landmark), !contains(seen.title, landmark) { return false }
        return true
    }

    private static func normalizedPath(_ path: String) -> String {
        let trimmed = path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return trimmed.isEmpty ? "/" : trimmed
    }

    private static func contains(_ haystack: String, _ needle: String) -> Bool {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ") }
        return fold(haystack).contains(fold(needle))
    }

    /// When the screen doesn't match the step due at `current`: the step that fits it instead. Forward
    /// first (the app is already past some steps: signed in, page filled), then back (a step didn't take).
    /// Only steps with a real anchor count, and only within `window` steps, so a generic page never sends
    /// the replay far off. Nil when nothing fits.
    public static func resync(_ plan: [Planned], current: Int, seen: Observation, window: Int = 8) -> Int? {
        guard plan.indices.contains(current) else { return nil }
        let forward = (current + 1)..<min(plan.count, current + 1 + window)
        for index in forward where hasAnchor(plan[index].step) && matches(plan[index].step.anchor, seen) {
            // Jumping ahead must never skip something irreversible.
            if plan[current..<index].contains(where: { $0.step.irreversible == true }) { return nil }
            return index
        }
        let backward = stride(from: current - 1, through: max(0, current - window * 2), by: -1)
        for index in backward where hasAnchor(plan[index].step) && matches(plan[index].step.anchor, seen) {
            // Back on an earlier page (signed out, sent back a step): it's a fresh copy of that page, so
            // start from its first step, not its last; the fields it had filled are empty again.
            var first = index
            while first > 0, first > current - window * 2, plan[first - 1].step.action != "navigate",
                  hasAnchor(plan[first - 1].step), matches(plan[first - 1].step.anchor, seen) {
                first -= 1
            }
            return first
        }
        return nil
    }

    private static func hasAnchor(_ step: SkillStep) -> Bool { !(step.anchor?.isEmpty ?? true) }

    /// Which expectation fields failed; empty when all hold. `present` answers a selector question
    /// (browser) or a label question (Mac) and is only asked for the fields that need it.
    public static func unmet(_ expect: StepExpectation?, _ seen: Observation, present: (String) -> Bool = { _ in true },
                             focusedRole: String? = nil, sheets: [String] = [], fileExists: (String) -> Bool = { _ in true }) -> [String] {
        guard let expect, !expect.isEmpty else { return [] }
        var failed: [String] = []
        if let want = expect.urlContains, !want.isEmpty, !seen.url.lowercased().contains(want.lowercased()) { failed.append("the page isn't \(want)") }
        if let want = expect.textContains, !want.isEmpty, !contains(seen.text, want), !contains(seen.title, want) { failed.append("“\(want)” isn't showing") }
        if let want = expect.windowTitleContains, !want.isEmpty, !contains(seen.window, want) { failed.append("the window isn't “\(want)”") }
        if let want = expect.elementPresent, !want.isEmpty, !present(want) { failed.append("\(want) isn't there") }
        if let want = expect.elementGone, !want.isEmpty, present(want) { failed.append("\(want) is still there") }
        if let want = expect.labelPresent, !want.isEmpty, !present(want), !contains(seen.text, want) { failed.append("“\(want)” isn't showing") }
        if let want = expect.focusedRole, !want.isEmpty, let role = focusedRole, role != want { failed.append("focus is on \(role), not \(want)") }
        if let want = expect.sheetGone, !want.isEmpty, sheets.contains(where: { contains($0, want) }) { failed.append("“\(want)” is still open") }
        if let want = expect.fileExists, !want.isEmpty, !fileExists(want) { failed.append("there's no file at \(want)") }
        return failed
    }

    // MARK: - Interrupts

    /// Interrupts every site and app has, cleared without the model.
    public static let builtinInterrupts: [InterruptHandler] = [
        InterruptHandler(id: "cookies-accept", whenText: "cookies", clickLabel: "Accept all", source: "builtin"),
        InterruptHandler(id: "cookies-accept-2", whenText: "cookies", clickLabel: "Accept", source: "builtin"),
        InterruptHandler(id: "cookies-agree", whenText: "cookies", clickLabel: "I agree", source: "builtin"),
        InterruptHandler(id: "survey-later", whenText: "survey", clickLabel: "Maybe later", source: "builtin"),
        InterruptHandler(id: "survey-no", whenText: "survey", clickLabel: "No thanks", source: "builtin"),
        InterruptHandler(id: "notifications", whenText: "notifications", clickLabel: "Not now", source: "builtin"),
        InterruptHandler(id: "save-password", whenText: "save password", clickLabel: "Not Now", source: "builtin"),
        InterruptHandler(id: "stay-signed-in", whenText: "stay signed in", clickLabel: "Stay signed in", source: "builtin"),
        InterruptHandler(id: "keep-signed-in", whenText: "keep me signed in", clickLabel: "Keep me signed in", source: "builtin"),
        InterruptHandler(id: "stay-logged-in", whenText: "stay logged in", clickLabel: "Stay logged in", source: "builtin"),
        InterruptHandler(id: "continue-session", whenText: "session", clickLabel: "Continue session", source: "builtin"),
        InterruptHandler(id: "newsletter", whenText: "newsletter", clickLabel: "No thanks", source: "builtin"),
    ]

    /// Buttons that close a popup without doing anything, safe to press in any dialog that's in the way.
    /// Never "OK", "Continue", "Yes" or "Confirm": in a dialog those can be the very thing not to do.
    public static let safeDismissals = ["stay signed in", "keep me signed in", "stay logged in", "continue session",
                                        "maybe later", "not now", "no thanks", "no, thanks", "remind me later", "later",
                                        "skip for now", "got it", "accept all", "accept all cookies"]
    /// Ones that close whatever dialog they're in, which might be one a step opened on purpose: only
    /// pressed once a step is already stuck behind it.
    public static let genericDismissals = ["dismiss", "close", "×", "✕", "x", "skip"]

    /// The button to press to get a dialog out of the way, from what it offers: the first safe one, in
    /// the order a person would pick (stay signed in before close). Nil when none is safe.
    public static func safeDismissal(in buttons: [String], generic: Bool = true) -> String? {
        let offered = buttons.map { ($0, $0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)) }
        for safe in safeDismissals + (generic ? genericDismissals : []) {
            if let hit = offered.first(where: { $0.1 == safe }) { return hit.0 }
        }
        return nil
    }

    /// Text a dialog can be known by again: its words without numbers ("time out in 2 minutes" changes),
    /// the first few that are long enough to mean something.
    public static func dialogKey(_ text: String) -> String? {
        let words = keyWords(text)
        guard words.count >= 2 else { return nil }
        return words.prefix(4).joined(separator: " ")
    }

    /// The words a dialog key is made of: three letters or more, no digits.
    static func keyWords(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 3 && !$0.contains(where: \.isNumber) }
    }

    /// Buttons that move past a page nobody recorded (a "verify your email" step) without doing anything.
    public static let pageSkips = ["skip for now", "not now", "maybe later", "remind me later", "no thanks", "skip this step",
                                   "continue without", "skip", "do this later", "i'll do it later"]

    /// What the page newly says after a final step that it refused: a line that wasn't there before and
    /// asks for something ("Please confirm the declaration"). Nil when nothing like that appeared.
    public static func refusal(before: String, after: String) -> String? {
        let old = Set(before.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) })
        let asks = ["please", "required", "must", "confirm", "tick", "agree", "accept the", "missing", "invalid", "enter a", "select a", "can't be empty", "cannot be empty"]
        return after.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { line in
            let l = line.lowercased()
            return !line.isEmpty && line.count <= 200 && !old.contains(line) && asks.contains { l.contains($0) } && transientError(in: line) == nil
        }
    }

    /// Whether the page says the last submit failed for a passing reason, so trying once more is what a
    /// person would do: "busy, try again", "temporarily unavailable". Not a validation error, and not a
    /// vague "something went wrong" (that one may have gone through).
    public static func transientError(in text: String) -> String? {
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let signs = ["try again", "busy", "temporarily unavailable", "please retry", "timed out", "too many requests", "service unavailable"]
        return lines.first { line in
            let l = line.lowercased()
            return line.count <= 200 && signs.contains { l.contains($0) }
        }
    }

    /// The handlers whose trigger is on screen now: the skill's own first, then the built-ins.
    /// A learned handler only fires on a dialog (`dialogText`), so its words showing elsewhere on a page
    /// never set it off.
    public static func interrupts(showing seen: Observation, skill: [InterruptHandler], present: (String) -> Bool = { _ in false },
                                  dialogText: String? = nil) -> [InterruptHandler] {
        (skill + builtinInterrupts).filter { handler in
            if let element = handler.whenElement, !element.isEmpty { return present(element) }
            if handler.source == "learned-page" { return false }
            if let text = handler.whenText, !text.isEmpty {
                // A learned key is the dialog's longer words ("what new acmedesk returns" for "What's new in
                // AcmeDesk 3. Returns…"), so it's found among the dialog's words as well as in its text.
                if handler.source == "learned" {
                    return dialogText.map { contains($0, text) || (" " + keyWords($0).joined(separator: " ") + " ").contains(" " + text + " ") } ?? false
                }
                return contains(seen.text, text) || contains(seen.window, text)
            }
            return false
        }
    }

    // MARK: - Values: render, validate, read back

    /// The value as the field should get it: money grouped or plain, a date in the field's format, text cased.
    public static func render(_ value: String, as input: SkillInput?) -> String {
        guard let input else { return value }
        let format = (input.format ?? "").lowercased()
        switch input.kind {
        case "money", "number":
            let digits = value.filter { $0.isNumber || $0 == "." || $0 == "-" }
            guard !digits.isEmpty else { return value }
            switch format {
            case "plain", "digits": return digits
            case "grouped", "western": return group(digits, indian: false)
            case "indian": return group(digits, indian: true)
            default: return value
            }
        case "date":
            guard !format.isEmpty, let date = parseDate(value) else { return value }
            let out = DateFormatter()
            out.locale = Locale(identifier: "en_US_POSIX")
            out.dateFormat = input.format
            return out.string(from: date)
        default:
            switch format {
            case "upper": return value.uppercased()
            case "lower": return value.lowercased()
            default: return value
            }
        }
    }

    private static func group(_ number: String, indian: Bool) -> String {
        let negative = number.hasPrefix("-")
        let parts = number.trimmingCharacters(in: CharacterSet(charactersIn: "-")).split(separator: ".", maxSplits: 1).map(String.init)
        var whole = parts.first ?? ""
        var grouped = ""
        if indian, whole.count > 3 {
            grouped = "," + String(whole.suffix(3))
            whole = String(whole.dropLast(3))
            while whole.count > 2 { grouped = "," + String(whole.suffix(2)) + grouped; whole = String(whole.dropLast(2)) }
            grouped = whole + grouped
        } else {
            while whole.count > 3 { grouped = "," + String(whole.suffix(3)) + grouped; whole = String(whole.dropLast(3)) }
            grouped = whole + grouped
        }
        return (negative ? "-" : "") + grouped + (parts.count > 1 ? "." + parts[1] : "")
    }

    private static func parseDate(_ text: String) -> Date? {
        for pattern in ["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "d MMM yyyy", "MMM d, yyyy", "dd-MM-yyyy", "yyyy/MM/dd"] {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = pattern
            f.isLenient = false
            if let date = f.date(from: text.trimmingCharacters(in: .whitespaces)) { return date }
        }
        return nil
    }

    /// Nil when the value fits the input; otherwise why not.
    public static func invalid(_ value: String, for input: SkillInput) -> String? {
        if value.isEmpty { return input.isRequired ? "no value" : nil }
        if let pattern = input.pattern, !pattern.isEmpty,
           let regex = try? NSRegularExpression(pattern: "^(?:\(pattern))$"),
           regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) == nil {
            return "“\(input.isSensitive ? "••••" : value)” doesn't look like a \(input.description.isEmpty ? input.name : input.description)"
        }
        if let choices = input.choices, !choices.isEmpty,
           !choices.contains(where: { loose($0) == loose(value) }) {
            return "“\(value)” isn't one of \(choices.joined(separator: ", "))"
        }
        if ["money", "number"].contains(input.kind), Double(value.filter { $0.isNumber || $0 == "." || $0 == "-" }) == nil {
            return "“\(value)” isn't a number"
        }
        return nil
    }

    /// Whether what the field holds now is what was typed. Masks reformat ("1250000" → "12,50,000"),
    /// so numbers compare by digits and text by letters and digits, ignoring case and spacing.
    public static func sameValue(typed: String, field: String) -> Bool {
        if typed == field { return true }
        let digitsTyped = typed.filter(\.isNumber), digitsField = field.filter(\.isNumber)
        let numeric = !digitsTyped.isEmpty && typed.allSatisfy { $0.isNumber || ",. ₹$€£-".contains($0) }
        if numeric { return digitsTyped == digitsField }
        let norm: (String) -> String = { $0.lowercased().filter { $0.isLetter || $0.isNumber } }
        return norm(typed) == norm(field)
    }

    // MARK: - Capture

    /// The first thing in `text` shaped like `example` ("REF-448990" → letters, a dash, six digits),
    /// or matching `pattern`. Nil when nothing fits.
    public static func capture(in text: String, example: String?, pattern: String? = nil) -> String? {
        let regex: String
        if let pattern, !pattern.isEmpty {
            regex = pattern
        } else if let example, !example.isEmpty {
            regex = shape(of: example)
        } else {
            return nil
        }
        guard let compiled = try? NSRegularExpression(pattern: regex) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = compiled.firstMatch(in: text, range: range), let r = Range(match.range, in: text) else { return nil }
        return String(text[r])
    }

    /// Whether a value read off the screen is an answer only reading can find ("658,236 for the city,
    /// 2025 estimate"), not a token with a fixed shape (a reference number). No pattern, and an example
    /// that's a phrase, long, or missing.
    public static func needsReading(_ input: SkillInput?) -> Bool {
        guard let input else { return true }
        if let pattern = input.pattern, !pattern.isEmpty { return false }
        guard let example = input.example?.trimmingCharacters(in: .whitespaces), !example.isEmpty else { return true }
        if example.contains(" ") || example.count > 24 { return true }
        // Only identifiers have a shape worth matching (REF-448990, ABCPR1234K, 112-3456789-1234567); a price,
        // a rating or a count ("$189.05", "8.8/10") looks like every other number on the page.
        let letters = example.contains(where: \.isLetter), digits = example.filter(\.isNumber).count
        let identifier = (letters && digits > 0) || (digits >= 8 && !example.contains(where: { "$€£₹.,/%".contains($0) }))
        return !identifier
    }

    /// A regex for strings shaped like `example`: runs of digits and letters keep their length (letters
    /// keep their case), other characters stay literal. Bounded by non-word characters.
    public static func shape(of example: String) -> String {
        var out = ""
        var run: (kind: Character, count: Int)?
        func flush() {
            guard let r = run else { return }
            switch r.kind {
            case "d": out += "\\d{\(r.count)}"
            case "U": out += "[A-Z]{\(r.count)}"
            case "l": out += "[a-z]{\(r.count)}"
            default: break
            }
            run = nil
        }
        for ch in example {
            let kind: Character? = ch.isNumber ? "d" : (ch.isUppercase ? "U" : (ch.isLowercase ? "l" : nil))
            if let kind {
                if run?.kind == kind { run!.count += 1 } else { flush(); run = (kind, 1) }
            } else {
                flush()
                out += NSRegularExpression.escapedPattern(for: String(ch))
            }
        }
        flush()
        return "(?<![A-Za-z0-9])" + out + "(?![A-Za-z0-9])"
    }

    // MARK: - The pause before something irreversible

    /// What happened on a pass so far that makes its values less certain.
    public struct PassDoubts: Equatable, Sendable {
        /// Input name → why it's doubtful (low confidence, failed its pattern, missing).
        public var values: [String: String] = [:]
        /// Steps that needed the model (a heal, a think step) on this pass.
        public var helped: [String] = []
        public init(values: [String: String] = [:], helped: [String] = []) { self.values = values; self.helped = helped }
        public var isEmpty: Bool { values.isEmpty && helped.isEmpty }
    }

    /// Why to stop before `step`, or nil to carry on. Only irreversible steps ever pause: when the
    /// skill always confirms (money), or when this pass has any doubt.
    public static func pauseReasons(before step: SkillStep, skill: Skill, doubts: PassDoubts) -> [String]? {
        guard step.irreversible == true else { return nil }
        if skill.alwaysConfirm == true { return ["this skill always checks with you before “\(step.text)”"] }
        guard !doubts.isEmpty else { return nil }
        var reasons = doubts.values.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }
        reasons += doubts.helped.map { "needed help with “\($0)”" }
        return reasons
    }

    /// Which of a pass's values the page shows (its text and its fields' contents): text loosely, numbers
    /// however they're grouped ("980000" shows as "9,80,000" or "980,000"). Short values, secrets and
    /// lists aren't counted: they'd match by chance or never show.
    public static func shownValues(_ values: [String: String], inputs: [SkillInput], on page: String) -> (checked: Int, shown: Int) {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        let haystack = fold(page)
        var checked = 0, shown = 0
        for input in inputs where input.kind != "list" && !input.isSensitive && input.source != "page" {
            guard let value = values[input.name]?.trimmingCharacters(in: .whitespaces), value.count >= 4 else { continue }
            checked += 1
            let digits = value.filter(\.isNumber)
            let numeric = !digits.isEmpty && value.allSatisfy { $0.isNumber || ",. ₹$€£-".contains($0) }
            let forms = numeric ? [digits, group(digits, indian: true), group(digits, indian: false)] : [fold(value)]
            if forms.contains(where: { haystack.contains($0) }) { shown += 1 }
        }
        return (checked, shown)
    }

    /// Whether an element's label carries every one of `values` ("Seville Andalusia, Spain" carries
    /// "Seville"; "Thursday, December 10, 2026" doesn't carry "Friday, December 18, 2026").
    public static func carries(_ label: String, all values: [String]) -> Bool {
        guard !values.isEmpty else { return false }
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ") }
        let words: (String) -> String = { fold($0).map { $0.isLetter || $0.isNumber ? String($0) : " " }.joined()
            .components(separatedBy: " ").filter { !$0.isEmpty }.joined(separator: " ") }
        let have = " " + words(label) + " "
        // Whole words only: "Female" doesn't carry "Male", "Category 12" doesn't carry "1".
        return values.allSatisfy { value in
            let want = words(value)
            return !want.isEmpty && have.contains(" " + want + " ")
        }
    }

    /// Below this, a value found in a document is doubtful.
    public static let confidenceFloor = 0.75

    // MARK: - Speed

    /// How long to wait at most before a step: the recorded gap, clamped. The replayer moves on as soon
    /// as the step's target is there, so this is a ceiling, not a pause.
    public static func waitCap(for step: SkillStep) -> Double {
        min(max(step.delay ?? 1, 0.4), 6)
    }
}
