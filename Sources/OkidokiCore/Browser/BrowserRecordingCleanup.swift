import Foundation

/// Recorded browser steps, tidied before they're kept as a skill.
///
/// An agent (or a person) often does the same thing twice: it types into the same field again, or
/// re-opens a dropdown it just chose from because the page hadn't caught up. A replay that repeats
/// those either reopens a menu it just closed or clicks a button that has already moved on, and every
/// step spent on a repeat is a step a deterministic replay pays for nothing.
public enum BrowserRecordingCleanup {
    public static func tidy(_ steps: [SkillStep]) -> [SkillStep] {
        var out: [SkillStep] = []
        for step in steps {
            // Typing the same field twice keeps the last: the final value is what the page ended with.
            if step.action == "type", let last = out.last, last.action == "type", last.selectors == step.selectors {
                out[out.count - 1] = step
                continue
            }
            // The same action on the same control twice in a row happened once.
            if let last = out.last, last.action == step.action, last.selectors == step.selectors,
               !["navigate", "press", "login", "dialog"].contains(step.action ?? "") {
                continue
            }
            out.append(step)
        }
        return out
    }
}
