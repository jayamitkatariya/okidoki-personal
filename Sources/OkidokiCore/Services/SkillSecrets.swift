import Foundation

/// Secrets a skill needs that the person gave once, in the request it was learned from ("sign in with
/// password hunter2"). The skill file only says `{{password}}`; the value lives in keys.json (private to
/// this Mac, never exported with the skill), and a replay that isn't given one uses it.
public enum SkillSecrets {
    static func key(_ skillID: String, _ name: String) -> String { "skill-secret.\(skillID).\(ParameterFill.key(name))" }

    public static func remember(_ value: String, name: String, skillID: String) {
        guard !value.isEmpty else { return }
        KeyStore.set(value, for: key(skillID, name))
    }

    public static func value(_ name: String, skillID: String) -> String? { KeyStore.get(key(skillID, name)) }

    public static func forget(skillID: String, names: [String]) {
        // Only touches keys.json when there's something to remove.
        for name in names where KeyStore.has(key(skillID, name)) { KeyStore.delete(key(skillID, name)) }
    }

    /// The names this skill keeps a secret for: placeholders a step types that are passwords (the only
    /// kind a run remembers).
    static func names(in skill: Skill) -> [String] {
        ParameterFill.names(in: skill.steps).filter { ParameterFill.key($0) == "password" }
    }

    /// Each pass's values, with any remembered secret it wasn't given filled in. With no passes at all, a
    /// remembered secret makes `times` passes that carry just it (what a replay with no values does anyway).
    public static func fill(_ passes: [[String: String]], skill: Skill, times: Int,
                            lookup: (String) -> String? = { _ in nil }) -> [[String: String]] {
        var known: [String: String] = [:]
        for name in names(in: skill) {
            if let value = lookup(name) ?? value(name, skillID: skill.id), !value.isEmpty { known[name] = value }
        }
        guard !known.isEmpty else { return passes }
        if passes.isEmpty { return Array(repeating: known, count: max(1, min(times, 10_000))) }
        return passes.map { pass in
            var out = pass
            for (name, value) in known where !pass.keys.contains(where: { ParameterFill.key($0) == ParameterFill.key(name) }) {
                out[name] = value
            }
            return out
        }
    }
}
