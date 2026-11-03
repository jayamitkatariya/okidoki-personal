import Foundation

/// Replay first, the agent when it must. For a request the brain wants to act on, the router says
/// whether a saved skill does exactly this job (and for whom); this decides, in code, whether to trust it.
public enum ReplayDispatcher {

    /// What the router answered (`/skill/route`).
    public struct Route: Equatable, Sendable {
        public var kind: String
        public var id: String?
        public var items: [String]
        public var overrides: [String: String]
        public var confidence: Double
        public init(kind: String, id: String? = nil, items: [String] = [], overrides: [String: String] = [:], confidence: Double = 0) {
            self.kind = kind; self.id = id; self.items = items; self.overrides = overrides; self.confidence = confidence
        }
    }

    public enum Decision: Equatable, Sendable {
        /// Replay this skill once per pass's values.
        case replay(skillID: String, passes: [[String: String]])
        /// Follow this template's outline with the agent, then keep what it did as the person's skill.
        case template(skillID: String, passes: [[String: String]])
        /// Do it with the agent, as before.
        case agent
    }

    public static let threshold = 0.8

    /// Words that ask for the agent, not a replay ("do it fresh", "use the agent").
    public static func wantsAgent(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["use the agent", "from scratch", "do it fresh", "without the skill", "without a skill", "don't replay", "dont replay", "no replay"]
            .contains { t.contains($0) }
    }

    /// The catalogue the router picks from: every skill's name, what it does, for what, and its inputs.
    public static func catalogue(_ skills: [Skill]) -> [[String: Any]] {
        skills.prefix(80).map { skill in
            var row: [String: Any] = ["id": skill.id, "name": skill.name, "intent": skill.intent ?? skill.summary,
                                      "surface": skill.runsInBrowser || skill.startURL != nil ? "browser" : "mac"]
            if let noun = skill.itemNoun { row["itemNoun"] = noun }
            let inputs = (skill.inputs ?? []).filter { $0.source != "page" }.map(\.name)
            if !inputs.isEmpty { row["inputs"] = inputs }
            if skill.template == true { row["template"] = true }
            return row
        }
    }

    /// The one other skill that does `skill`'s job with inputs: it starts on the same site, and its name
    /// is the same or contains it ("acme filing" → "acme filing smart"). Nil when none or several fit.
    static func smartSibling(of skill: Skill, in skills: [Skill]) -> Skill? {
        func host(_ s: Skill) -> String? {
            (s.startURL ?? s.steps.first { $0.url?.isEmpty == false }?.url).map { BrowserSteps.host(of: $0) }
        }
        let name = skill.name.lowercased()
        let fits = skills.filter { other in
            other.id != skill.id && other.template != true && !other.steps.isEmpty && !(other.inputs ?? []).isEmpty
                && host(other) != nil && host(other) == host(skill)
                && (other.name.lowercased().contains(name) || name.contains(other.name.lowercased()) || (other.intent != nil && other.intent == skill.intent))
        }
        return fits.count == 1 ? fits[0] : nil
    }

    public static func decide(_ route: Route, skills: [Skill]) -> Decision {
        guard route.confidence >= threshold, let id = route.id, let skill = skills.first(where: { $0.id == id }) else { return .agent }
        let names = route.items.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let passes: [[String: String]] = names.isEmpty
            ? [route.overrides]
            : names.map { route.overrides.merging(["ref": $0]) { _, ref in ref } }
        switch route.kind {
        case "skill" where skill.template != true && !skill.steps.isEmpty:
            // A plain recording with no inputs can't do it for someone else: only when it's one pass as
            // recorded. A smart version of the same job (same site, with inputs) can.
            if (skill.inputs ?? []).isEmpty, passes.count > 1 || !route.overrides.isEmpty {
                guard let smart = smartSibling(of: skill, in: skills) else { return .agent }
                return .replay(skillID: smart.id, passes: passes)
            }
            return .replay(skillID: id, passes: passes)
        case "template", "skill" where skill.template == true:
            return .template(skillID: id, passes: passes)
        default:
            return .agent
        }
    }
}
