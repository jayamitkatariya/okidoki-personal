import Foundation
import PDFKit
import Vision

/// Binding: every pass's values settled before anything on screen is touched. Given values (the request,
/// a record, a spreadsheet row) are matched to the skill's inputs here, in code. Only what's still
/// missing goes to the model, once per item, with that item's documents. This file is the code side.
public enum SkillBinder {

    /// One pass's values, and what's uncertain about them.
    public struct Bound: Equatable, Sendable {
        /// Who or what the pass is for ("Bharat", "INV-4471").
        public var label: String
        public var values: [String: String]
        /// Input name → why it's in doubt (low confidence, fails its pattern). Feeds the pause gate.
        public var doubts: [String: String]
        /// Required inputs with no value: the pass can't start.
        public var missing: [String]
        /// Input name → where it came from ("Form16.pdf, Part B", "the request").
        public var sources: [String: String]
        public init(label: String, values: [String: String], doubts: [String: String] = [:], missing: [String] = [], sources: [String: String] = [:]) {
            self.label = label; self.values = values; self.doubts = doubts; self.missing = missing; self.sources = sources
        }
    }

    /// The inputs a pass has to be given: everything but what the replay reads off the page itself.
    public static func boundInputs(_ skill: Skill) -> [SkillInput] {
        (skill.inputs ?? []).filter { $0.source != "page" }
    }

    /// Given values matched to inputs by name: exact (loosely spelled), then one name containing the other
    /// when that's unambiguous ("name" → "full_name"). What matched nothing is handed back for the model.
    public static func match(_ given: [String: String], to inputs: [SkillInput]) -> (matched: [String: String], leftover: [String: String]) {
        var matched: [String: String] = [:]
        var leftover: [String: String] = [:]
        let keys = inputs.map { ParameterFill.key($0.name) }
        for (rawKey, value) in given {
            let key = ParameterFill.key(rawKey)
            if key == "ref" || key == "id" { continue }
            if let exact = inputs.first(where: { ParameterFill.key($0.name) == key }) {
                matched[exact.name] = value
                continue
            }
            let near = inputs.indices.filter { keys[$0].contains(key) || key.contains(keys[$0]) }
            if near.count == 1, matched[inputs[near[0]].name] == nil {
                matched[inputs[near[0]].name] = value
            } else {
                leftover[rawKey] = value
            }
        }
        return (matched, leftover)
    }

    /// The vault folder that is this item's: its last path component equals the item (or its first word,
    /// "Neha" for "Neha Shah"), ignoring case and accents. Nil when none or several fit.
    public static func folder(for item: String, in folders: [String]) -> String? {
        let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines) }
        let whole = fold(item)
        guard !whole.isEmpty else { return nil }
        let first = whole.split(separator: " ").first.map(String.init) ?? whole
        let last = { (path: String) in fold(path.split(separator: "/").last.map(String.init) ?? path) }
        let exact = folders.filter { last($0) == whole }
        if exact.count == 1 { return exact[0] }
        if exact.count > 1 { return exact.min { $0.count < $1.count } }
        let byFirst = folders.filter { last($0) == first }
        return byFirst.count == 1 ? byFirst[0] : nil
    }

    /// The pass's values made final: validated, lists checked, doubts and gaps listed.
    /// `confidence` and `sources` come from the model for values it found; given values are certain.
    public static func finish(label: String, values: [String: String], inputs: [SkillInput],
                              confidence: [String: Double] = [:], sources: [String: String] = [:],
                              optionalByUse: Set<String> = []) -> Bound {
        var doubts: [String: String] = [:]
        var missing: [String] = []
        for input in inputs {
            // Given as empty is an answer ("no capital gains"); only a value nobody gave is missing.
            guard let value = values[input.name] else {
                if input.isRequired { missing.append(input.name) }
                continue
            }
            if value.isEmpty || (input.kind == "list" && HybridReplay.listValue(value).isEmpty) {
                if input.isRequired, input.kind != "list", !optionalByUse.contains(input.name) { doubts[input.name] = "it's empty" }
                continue
            }
            if let problem = HybridReplay.invalid(value, for: input), input.kind != "list" {
                doubts[input.name] = problem
            }
            if let score = confidence[input.name], score < HybridReplay.confidenceFloor {
                doubts[input.name] = "only \(Int(score * 100))% sure" + (sources[input.name].map { " (from \($0))" } ?? "")
            }
        }
        return Bound(label: label, values: values, doubts: doubts, missing: missing, sources: sources)
    }

    /// A choice input's option for a value that names it loosely ("new" → "New regime"): exact first,
    /// then the one choice that contains it. The value unchanged when nothing (or several) fit.
    public static func choice(_ value: String, in choices: [String]?) -> String {
        guard let choices, !choices.isEmpty else { return value }
        let v = value.lowercased().trimmingCharacters(in: .whitespaces)
        if let exact = choices.first(where: { $0.lowercased() == v }) { return exact }
        let near = choices.filter { $0.lowercased().contains(v) || v.contains($0.lowercased()) }
        return near.count == 1 ? near[0] : value
    }

    // MARK: - Reading documents

    /// A document's text for binding: the text layer, or, for a scan or a photo, what Vision reads off it.
    public static func text(of url: URL, maxPages: Int = 12) -> String {
        let ext = url.pathExtension.lowercased()
        if ext == "pdf" {
            let layer = DocumentReader.read(url: url) ?? ""
            if layer.trimmingCharacters(in: .whitespacesAndNewlines).count > 40 { return layer }
            guard let document = PDFDocument(url: url) else { return layer }
            var out = ""
            for index in 0..<min(document.pageCount, maxPages) {
                guard let page = document.page(at: index) else { continue }
                let bounds = page.bounds(for: .mediaBox)
                let scale = 2000 / max(bounds.width, bounds.height, 1)
                let image = page.thumbnail(of: CGSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
                if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) { out += recognize(cg) + "\n" }
            }
            return out.isEmpty ? layer : out
        }
        if ["png", "jpg", "jpeg", "heic", "tiff", "gif", "webp"].contains(ext) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return "" }
            return recognize(cg)
        }
        if ["csv", "txt", "md", "json", "tsv"].contains(ext) {
            return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
        return DocumentReader.read(url: url) ?? ""
    }

    private static func recognize(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    // MARK: - Spreadsheets

    /// Rows of a CSV (first line is the header), each a dictionary by header. Quoted fields with commas
    /// and doubled quotes are handled; good enough for an export dropped in the vault.
    public static func csvRows(_ text: String) -> [[String: String]] {
        var rows: [[String]] = []
        var field = "", row: [String] = [], quoted = false
        var chars = Array(text.replacingOccurrences(of: "\r\n", with: "\n"))
        chars.append("\n")
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if quoted {
                if c == "\"" {
                    if i + 1 < chars.count, chars[i + 1] == "\"" { field.append("\""); i += 1 } else { quoted = false }
                } else { field.append(c) }
            } else if c == "\"" { quoted = true }
            else if c == "," { row.append(field); field = "" }
            else if c == "\n" {
                row.append(field); field = ""
                if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
                row = []
            } else { field.append(c) }
            i += 1
        }
        guard let header = rows.first?.map({ $0.trimmingCharacters(in: .whitespaces) }) else { return [] }
        return rows.dropFirst().map { cells in
            Dictionary(zip(header, cells.map { $0.trimmingCharacters(in: .whitespaces) }).map { ($0, $1) }, uniquingKeysWith: { first, _ in first })
        }
    }
}
