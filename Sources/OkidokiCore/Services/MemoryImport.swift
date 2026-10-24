import Foundation

/// Another assistant whose memory can be brought into Okidoki. Local sources keep their notes in
/// files on this Mac, which the job reads with the terminal; hosted ones (ChatGPT, Gemini, claude.ai)
/// have no files here, so the person saves an export and picks it.
public struct MemorySource: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var aliases: [String]
    /// Memory files relative to the home folder. `*` matches one path segment.
    public var paths: [String]
    public var blurb: String

    public var isLocal: Bool { !paths.isEmpty }

    public init(id: String, name: String, aliases: [String], paths: [String] = [], blurb: String) {
        self.id = id; self.name = name; self.aliases = aliases; self.paths = paths; self.blurb = blurb
    }
}

public struct ImportedMemory: Equatable, Sendable {
    public var text: String
    public var section: MemorySection
    /// The file it was read from, when the job printed one; empty for a picked export.
    public var file: String
    public init(text: String, section: MemorySection, file: String = "") { self.text = text; self.section = section; self.file = file }
}

public enum MemoryImport {
    public static let builtin = "import-memory"

    public static let sources: [MemorySource] = [
        MemorySource(id: "claude-code", name: "Claude Code", aliases: ["claude code", "claude-code", "claudecode"],
                     paths: [".claude/CLAUDE.md", ".claude/projects/*/memory/*.md"],
                     blurb: "Its CLAUDE.md and the notes it keeps per project."),
        MemorySource(id: "hermes", name: "Hermes Agent", aliases: ["hermes agent", "hermes-agent", "hermes"],
                     paths: [".hermes/memories/MEMORY.md", ".hermes/memories/USER.md"],
                     blurb: "What Hermes has written down about you and your setup."),
        MemorySource(id: "codex", name: "Codex", aliases: ["codex", "openai codex"],
                     paths: [".codex/AGENTS.md", ".codex/memories/*.md"],
                     blurb: "The global AGENTS.md and saved memories."),
        MemorySource(id: "gemini-cli", name: "Gemini CLI", aliases: ["gemini cli", "gemini-cli"],
                     paths: [".gemini/GEMINI.md"],
                     blurb: "The notes Gemini CLI keeps in GEMINI.md."),
        MemorySource(id: "opencode", name: "OpenCode", aliases: ["opencode", "open code", "open-code"],
                     paths: [".config/opencode/AGENTS.md"],
                     blurb: "The global AGENTS.md."),
        MemorySource(id: "cursor", name: "Cursor", aliases: ["cursor"],
                     paths: [".cursor/rules/*.md", ".cursor/rules/*.mdc"],
                     blurb: "Your global Cursor rules."),
        MemorySource(id: "grok", name: "Grok", aliases: ["grok", "grok cli"],
                     paths: [".grok/memory-v2/global/MEMORY.md", ".grok/memory-v2/global/topics/*.md"],
                     blurb: "Grok's global memory and topics."),
        MemorySource(id: "minimax", name: "MiniMax", aliases: ["minimax", "mini max", "mavis"],
                     paths: [".minimax/memory/user.md"],
                     blurb: "Its notes about you."),
        // Its memory/ folder holds dated session logs, which are task history rather than facts about the person.
        MemorySource(id: "openclaw", name: "OpenClaw", aliases: ["openclaw", "open claw"],
                     paths: [".openclaw/workspace/MEMORY.md"],
                     blurb: "Its curated workspace memory."),
        MemorySource(id: "chatgpt", name: "ChatGPT", aliases: ["chatgpt", "chat gpt", "openai", "gpt"],
                     blurb: "Ask ChatGPT to export its saved memories, save the text, then pick the file."),
        MemorySource(id: "gemini", name: "Gemini", aliases: ["gemini", "google gemini", "bard"],
                     blurb: "Ask Gemini to export what it has saved about you, save the text, then pick the file."),
        MemorySource(id: "claude", name: "Claude", aliases: ["claude", "claude.ai", "claude app"],
                     blurb: "Ask Claude to export its memories, save the text, then pick the file."),
    ]

    public static func source(id: String) -> MemorySource? { sources.first { $0.id == id } }

    /// The source named in free text, preferring longer aliases ("claude code" over "claude").
    public static func source(in text: String) -> MemorySource? {
        let lower = text.lowercased()
        var best: (MemorySource, Int)?
        for source in sources {
            for alias in source.aliases {
                let pattern = #"(?<![\w.-])"# + NSRegularExpression.escapedPattern(for: alias) + #"(?![\w-])"#
                if lower.range(of: pattern, options: .regularExpression) != nil, alias.count > (best?.1 ?? 0) {
                    best = (source, alias.count)
                }
            }
        }
        return best?.0
    }

    /// "import my memory from claude code", "bring over what chatgpt knows about me", "pull memories from hermes".
    public static func asked(_ text: String) -> Bool {
        let t = text.lowercased()
        let verbs = #"\b(import|bring( over| in)?|pull( in)?|copy( over)?|move( over)?|migrate|transfer|load|grab|sync|get|fetch|read|retrieve|take( over)?)\b"#
        let memory = #"\bmemor(y|ies)\b|\b(what|notes?|context|facts|things|everything|stuff)\b[^.]{0,40}\babout me\b"#
        // "memory" the hardware, not the notes.
        let hardware = #"\b(ram|gb|gigabytes?|usage|pressure|leak|how much|free up|swap|more memory|memory (for|on|in) (my|this|the)|upgrade)\b"#
        return t.range(of: verbs, options: .regularExpression) != nil && t.range(of: memory, options: .regularExpression) != nil
            && t.range(of: hardware, options: .regularExpression) == nil
    }

    // MARK: - Files on this Mac

    /// Memory files a source keeps on this Mac, expanded from its patterns.
    public static func files(for source: MemorySource, home: String = NSHomeDirectory(),
                             fileManager: FileManager = .default) -> [String] {
        var found: [String] = []
        for pattern in source.paths {
            for path in expand(pattern.split(separator: "/").map(String.init), under: home, fileManager: fileManager) {
                var isDirectory: ObjCBool = false
                guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
                let size = (try? fileManager.attributesOfItem(atPath: path))?[.size] as? Int ?? 1
                if size > 0 { found.append(path) }
            }
        }
        return Array(NSOrderedSet(array: found)) as? [String] ?? found
    }

    private static func expand(_ segments: [String], under base: String, fileManager: FileManager) -> [String] {
        guard let segment = segments.first else { return [base] }
        let rest = Array(segments.dropFirst())
        guard segment.contains("*") else {
            return expand(rest, under: (base as NSString).appendingPathComponent(segment), fileManager: fileManager)
        }
        let pattern = "^" + NSRegularExpression.escapedPattern(for: segment).replacingOccurrences(of: "\\*", with: "[^/]*") + "$"
        let names = ((try? fileManager.contentsOfDirectory(atPath: base)) ?? [])
            .filter { $0.range(of: pattern, options: .regularExpression) != nil }
            .sorted()
        return names.flatMap { expand(rest, under: (base as NSString).appendingPathComponent($0), fileManager: fileManager) }
    }

    /// Sources that have at least one memory file on this Mac.
    public static func available(home: String = NSHomeDirectory(), fileManager: FileManager = .default) -> [(source: MemorySource, files: [String])] {
        sources.filter(\.isLocal).compactMap { source in
            let found = files(for: source, home: home, fileManager: fileManager)
            return found.isEmpty ? nil : (source, found)
        }
    }

    // MARK: - The job

    static let fileMarker = "@@okidoki-file "

    /// Prints each file behind a marker line, so the parser knows where one file ends and the next begins.
    public static func readCommand(files: [String]) -> String {
        files.map { "printf '\\n\(fileMarker)%s\\n' \(shellQuote($0)) && cat \(shellQuote($0))" }.joined(separator: " && ")
    }

    /// Reads a saved export in whatever format it was saved as. Markdown and text as they are;
    /// PDF through Poppler; Word, RTF and HTML through macOS's own converter.
    public static let exportCommand =
        "case {{file}} in *.pdf) pdftotext -layout {{file}} - ;; *.txt|*.md|*.markdown) cat {{file}} ;; *) textutil -convert txt -stdout {{file}} ;; esac"

    /// The whole plan for a request, or nil when it isn't about importing memory.
    public static func decide(_ text: String, home: String = NSHomeDirectory(), fileManager: FileManager = .default) -> BrainDecision? {
        guard asked(text) else { return nil }
        let named = source(in: text)
        let local: [(source: MemorySource, files: [String])]
        if let named {
            local = named.isLocal ? [(named, files(for: named, home: home, fileManager: fileManager))].filter { !$0.1.isEmpty } : []
        } else {
            local = available(home: home, fileManager: fileManager)
        }

        if !local.isEmpty {
            let names = local.map(\.source.name)
            let count = local.reduce(0) { $0 + $1.files.count }
            let who = names.count > 2 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names.joined(separator: " and ")
            let summary = "Read the \(count == 1 ? "memory file" : "\(count) memory files") \(who) \(names.count == 1 ? "keeps" : "keep") on this Mac and add what's about you to Memory. Nothing leaves your Mac, and nothing of theirs is changed."
            return BrainDecision(kind: .terminal, title: "import memory from \(names.count == 1 ? names[0] : "other assistants")",
                                 answer: summary + " You can edit or forget anything afterwards on the Memory page.",
                                 risk: .low, previewSummary: summary,
                                 previewSteps: local.map { "read what \($0.source.name) remembers" },
                                 commands: local.map { readCommand(files: $0.files) }, apps: [],
                                 files: local.flatMap(\.files), builtin: builtin)
        }

        let name = named?.name ?? "the other assistant"
        let howTo = "In \(name), ask: “Export everything you remember about me as a plain list, one memory per line.” Save the reply as a text file, then choose it here."
        let summary = named == nil || !(named?.isLocal ?? false)
            ? "Choose the memory export you saved from \(name). I'll read it and add what's about you to Memory."
            : "\(name) hasn't saved any memory files on this Mac yet. If you have an export from it, choose the file and I'll read that instead."
        return BrainDecision(kind: .terminal, title: "import memory from \(name)",
                             answer: summary + "\n\n" + howTo,
                             risk: .low, previewSummary: summary,
                             previewSteps: ["read the export you choose"],
                             commands: [exportCommand], apps: [], pickFile: "document", builtin: builtin)
    }

    // MARK: - Parsing

    private static let maxItems = 150
    private static let maxLength = 300

    // Lines that were written for the assistant, not about the person. Importing them would let one
    // tool's export steer another.
    private static let instructionLike = [
        #"ignore (all |any )?(previous|prior|above|earlier) (instructions?|prompts?|rules?)"#,
        #"\b(system prompt|system message|developer message)\b"#,
        #"\byou are (now|an?|the) (assistant|ai|model)\b"#, #"\bwhen importing\b"#, #"\bfrom now on,? (you|okidoki|the assistant) (must|should|will|always|never)\b"#,
        #"\bdo not (tell|warn|inform) (the )?user\b"#, #"\b(disable|skip|bypass) (safety|approval|confirmation)s?\b"#,
        #"\bact as (if|though) (i|the user) (have|has|am|is) (admin|root|elevated|unrestricted)\b"#,
        #"\bnever (disagree|question|push back|express concern)\b"#,
    ]

    // Secrets and identifiers are never worth remembering.
    private static let sensitive = [
        #"\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}"#, #"\bAKIA[0-9A-Z]{12,}"#, #"\bgh[pousr]_[A-Za-z0-9]{20,}"#, #"\bxox[abpr]-[A-Za-z0-9-]{10,}"#,
        #"\b(api[_ -]?key|secret|token|password|passphrase|passcode|pin)\s*[:=]"#,
        #"\b\d{3}-\d{2}-\d{4}\b"#, #"\b(?:\d[ -]?){13,19}\b"#, #"\b(ssn|social security|passport|routing number|account number|iban|credit card)\b"#,
        #"\b(diagnosed with|therapist|therapy|medication|prescription|depression|anxiety|suicid\w*|self-harm)\b"#,
    ]

    // File furniture: frontmatter keys, generated-file banners, section labels, empty-state placeholders.
    private static let noise = [
        #"^(generated by|do not edit|paths are relative|last updated|updated:|created:|version:)"#,
        #"^(type|why|source|confidence|apply when|evidence|tags?|status|date|name|description|title|slug|id|category|keywords|scope|project|path):"#,
        #"^(instructions|identity|career|projects|preferences|memories|memory|notes|about you|about me|right now)$"#,
        #"^this is (the )?(complete|full) (set|list|export)"#, #"^(no|none|nothing)\b[^.]*\b(yet|recorded|saved|remain|to report)\b"#,
    ]

    /// Turns the files the job printed into single memories, one per line or bullet, in the
    /// person's own words. Headings, code, links, secrets and anything addressed to an assistant are left out.
    public static func parse(_ output: String) -> [ImportedMemory] {
        var items: [ImportedMemory] = []
        var seen: Set<String> = []
        var inFence = false
        var section: MemorySection = .aboutYou
        var file = ""
        let withoutComments = output.replacingOccurrences(of: #"<!--[\s\S]*?-->"#, with: "\n", options: .regularExpression)
        let lines = withoutComments.components(separatedBy: "\n")
            .flatMap { $0.components(separatedBy: "§") }
        for raw in lines {
            if items.count >= maxItems { break }
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle(); continue }
            if trimmed.hasPrefix(fileMarker) {
                file = String(trimmed.dropFirst(fileMarker.count)).trimmingCharacters(in: .whitespaces)
                section = .aboutYou
                inFence = false
                continue
            }
            if inFence || trimmed.isEmpty || trimmed.hasPrefix("$ ") { continue }
            if trimmed.hasPrefix("#") || trimmed.hasPrefix("|") || trimmed.hasPrefix(">") {
                section = headingSection(trimmed) ?? section
                continue
            }
            if trimmed.range(of: #"^[-=*_]{3,}$"#, options: .regularExpression) != nil { continue }
            guard let text = clean(trimmed) else { continue }
            let key = text.lowercased()
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            items.append(ImportedMemory(text: text, section: key.hasPrefix("right now") ? .rightNow : section, file: file))
        }
        return items
    }

    /// The source a memory file belongs to, by the folder it lives in ("~/.hermes/…" → Hermes).
    public static func source(forFile path: String, home: String = NSHomeDirectory()) -> MemorySource? {
        guard path.hasPrefix(home + "/") else { return nil }
        let relative = String(path.dropFirst(home.count + 1))
        return sources.first { source in
            source.paths.contains { pattern in
                let folder = pattern.split(separator: "/").prefix { !$0.contains("*") }.dropLast().joined(separator: "/")
                return !folder.isEmpty && relative.hasPrefix(folder + "/")
            }
        }
    }

    private static func headingSection(_ heading: String) -> MemorySection? {
        let lower = heading.lowercased()
        if lower.contains("right now") || lower.contains("current") || lower.contains("this week") || lower.contains("in progress") { return .rightNow }
        if lower.hasPrefix("#") { return .aboutYou }
        return nil
    }

    /// One line → one memory, or nil when it's not something to remember.
    static func clean(_ line: String) -> String? {
        var text = line
        // Links keep their label; then bullets, numbering, checkboxes and dated export lines: "[2026-03-01] - …", "[unknown] - …".
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"^(?:[-*+•]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?(?:\[[^\]]{1,24}\]\s*[-–—:]?\s*)?"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"^(rule|preference|fact|note|memory|instruction|remember|learned):\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\*\*|__|(?<!\w)[*_](?=\w)|(?<=\w)[*_](?!\w)"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " .,;:-–—"))
        let lower = text.lowercased()
        guard text.count >= 12, text.split(separator: " ").count >= 3 else { return nil }
        guard lower.range(of: #"https?://|www\.|[\w.-]+@[\w-]+\.\w{2,}"#, options: .regularExpression) == nil else { return nil }
        guard !(noise + instructionLike + sensitive).contains(where: { lower.range(of: $0, options: .regularExpression) != nil }) else { return nil }
        if text.count > maxLength {
            // Keep the first sentence or two instead of cutting mid-word.
            let cut = text.prefix(maxLength)
            if let end = cut.lastIndex(where: { ".!?".contains($0) }), cut.distance(from: cut.startIndex, to: end) > 40 {
                text = String(cut[...end])
            } else if let space = cut.lastIndex(of: " ") {
                text = String(cut[..<space]) + "…"
            }
        }
        return text
    }
}
