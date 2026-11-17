import Foundation

/// What a plain (as-recorded) replay can do with the values it's given.
public enum ReplayValues {
    /// Keys that only say who a pass is for, or that every replay has; never a reason to refuse.
    static let bookkeeping: Set<String> = ["ref", "id", "today", "today_iso", "password"]

    /// The given keys a plain replay would silently ignore, when it would ignore every one of them: the
    /// skill types none of them, so replaying it "for Bharat" would file what was recorded (Asha's details)
    /// instead. Empty when the values fit (or there are none worth checking).
    public static func ignoredByRecording(_ steps: [SkillStep], passes: [[String: String]]) -> [String] {
        let used = Set(steps.flatMap { step in
            ParameterFill.names(in: (step.input ?? "") + " " + (step.url ?? "") + " " + step.text).map(ParameterFill.key)
        })
        var given: [String] = []
        for pass in passes {
            for (name, value) in pass where !value.trimmingCharacters(in: .whitespaces).isEmpty {
                let key = ParameterFill.key(name)
                if !bookkeeping.contains(key), !given.contains(key) { given.append(key) }
            }
        }
        guard !given.isEmpty, given.allSatisfy({ !used.contains($0) }) else { return [] }
        return given.sorted()
    }
}
