import Foundation

/// Ready-made skills that ship with okidoki: templates the agent follows the first time (so it plans
/// less), after which they're the person's own smart skill. Plain `.okiskill` files with `template: true`.
public enum SkillLibrary {
    public struct Entry: Equatable, Sendable {
        /// The file's name without its extension ("flights-search").
        public var id: String
        public var bundle: SkillBundle
        public var surface: String { bundle.skill?.startApp == nil ? "browser" : "mac" }
    }

    /// Every template in `folder`, by name. Files that don't decode, or aren't templates, are skipped.
    public static func load(from folder: URL?) -> [Entry] {
        guard let folder, let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.filter { $0.hasSuffix("." + SkillBundle.fileExtension) }.sorted().compactMap { name in
            guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)),
                  let bundle = try? SkillBundle.decode(data), bundle.skill?.template == true else { return nil }
            return Entry(id: String(name.dropLast(SkillBundle.fileExtension.count + 1)), bundle: bundle)
        }
    }

    /// The source a template installed from the library carries, so the page knows it's there.
    public static func source(for id: String) -> String { "library:\(id)" }

    /// The template as a skill to add to the person's own: no steps yet, just what to follow.
    public static func skill(from entry: Entry, accountID: String, now: Date = Date()) -> Skill {
        var skill = Skill(accountID: accountID, name: entry.bundle.name, summary: entry.bundle.summary, steps: [],
                          createdAt: now, source: source(for: entry.id), updatedAt: now)
        entry.bundle.skill?.apply(to: &skill)
        skill.template = true
        return skill
    }
}
