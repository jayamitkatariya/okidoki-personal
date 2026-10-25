import Foundation

/// A row of data a skill can be replayed against: a shipment, an invoice, a customer. A skill's typed
/// text names fields as `{{importer}}`; each pass of a replay fills them from one record. Records live
/// in `records.json` next to the app's state, so an export from another system can be dropped in.
public struct SkillRecord: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// One line for cards and the run title: "Lakeshore Electronics · 240 notebook computers".
    public var title: String
    /// The skill to use when the request doesn't name one ("file the entry for MTS-4471").
    public var skill: String
    public var values: [String: String]

    public init(id: String, title: String = "", skill: String = "", values: [String: String] = [:]) {
        self.id = id; self.title = title; self.skill = skill; self.values = values
    }

    /// The record's values plus its own id as `{{ref}}` and `{{id}}`, unless it sets them itself.
    public var fillValues: [String: String] {
        var all = values
        if all["ref"] == nil { all["ref"] = id }
        if all["id"] == nil { all["id"] = id }
        return all
    }
}

public enum SkillRecords {
    private struct Book: Codable { var records: [SkillRecord] }

    public static var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Okidoki/records.json")
    }

    /// Accepts `{"records": [...]}` or a bare array. A missing or broken file is simply no records.
    public static func load(from url: URL = fileURL) -> [SkillRecord] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return decode(data)
    }

    public static func decode(_ data: Data) -> [SkillRecord] {
        let decoder = JSONDecoder()
        if let book = try? decoder.decode(Book.self, from: data) { return book.records }
        return (try? decoder.decode([SkillRecord].self, from: data)) ?? []
    }

    public static func save(_ records: [SkillRecord], to url: URL = fileURL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(Book(records: records)).write(to: url, options: .atomic)
    }
}

/// `{{name}}` placeholders in a skill's typed text, and filling them in.
public enum ParameterFill {
    /// `{{ importer name }}`, `{{hts}}`. Names are matched loosely: case, spaces, dashes and
    /// underscores don't matter, so `{{Importer Name}}` takes the value of `importer_name`.
    private static let pattern = try! NSRegularExpression(pattern: #"\{\{\s*([^{}]+?)\s*\}\}"#)

    public static func key(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    }

    /// Unique names in order of first appearance.
    public static func names(in text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        var seen = Set<String>()
        var out: [String] = []
        for match in pattern.matches(in: text, range: range) {
            guard let r = Range(match.range(at: 1), in: text) else { continue }
            let name = String(text[r])
            if seen.insert(key(name)).inserted { out.append(name) }
        }
        return out
    }

    public static func names(in steps: [SkillStep]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for step in steps where step.action == "type" {
            for name in names(in: step.input ?? "") where seen.insert(key(name)).inserted { out.append(name) }
        }
        return out
    }

    /// The text with every placeholder that has a value filled in, and the names that had none
    /// (those stay as written).
    public static func fill(_ text: String, values: [String: String]) -> (text: String, missing: [String]) {
        guard text.contains("{{") else { return (text, []) }
        let lookup = Dictionary(values.map { (key($0.key), $0.value) }, uniquingKeysWith: { _, last in last })
        let ns = text as NSString
        var result = ""
        var cursor = 0
        var missing: [String] = []
        for match in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let name = ns.substring(with: match.range(at: 1))
            if let value = lookup[key(name)] {
                result += value
            } else {
                result += ns.substring(with: match.range)
                if !missing.contains(name) { missing.append(name) }
            }
            cursor = match.range.location + match.range.length
        }
        result += ns.substring(from: cursor)
        return (result, missing)
    }

    /// Values the Mac knows without being told: today's date and where the brain serves pages.
    public static func builtins(portal: String, now: Date = Date()) -> [String: String] {
        let us = DateFormatter()
        us.locale = Locale(identifier: "en_US_POSIX")
        us.dateFormat = "MM/dd/yyyy"
        let iso = DateFormatter()
        iso.locale = Locale(identifier: "en_US_POSIX")
        iso.dateFormat = "yyyy-MM-dd"
        return ["portal": portal, "today": us.string(from: now), "today_iso": iso.string(from: now)]
    }

    /// `importer=Acme`, `value: 52000`, `hts="8471.30.0100"` from a request, after a "with" if there is one.
    public static func overrides(in raw: String) -> [String: String] {
        let regex = try! NSRegularExpression(pattern: #"([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|“([^”]*)”|([^\s,;]+))"#)
        let ns = raw as NSString
        var out: [String: String] = [:]
        for match in regex.matches(in: raw, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1))
            let value = [2, 3, 4].lazy.compactMap { i -> String? in
                let r = match.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }.first ?? ""
            out[key(name)] = value
        }
        return out
    }
}
