import Foundation

/// Picks which notes travel with a request. The prompt can only carry a few dozen, so with hundreds or
/// thousands of notes "the newest 24" would hide the one the request needs. Notes that share words with
/// the request come first (folded for case, accents and simple plurals, with a few everyday synonyms),
/// then the newest. This is also all the recall there is without a Moss key; with one, the brain adds
/// matches by meaning on top and skips lines the prompt already carries.
public enum MemoryRecall {
    /// Words too common to say anything about which note is meant.
    static let stopwords: Set<String> = [
        "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
        "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did", "have", "has", "had",
        "i", "me", "my", "mine", "you", "your", "yours", "we", "our", "us", "he", "she", "it", "its", "they", "them", "their",
        "this", "that", "these", "those", "what", "which", "who", "whom", "where", "when", "why", "how",
        "can", "could", "should", "would", "will", "shall", "may", "might", "must", "please", "just", "also",
        "so", "not", "no", "yes", "all", "any", "some", "about", "into", "out", "up", "down", "over", "than", "then",
        "there", "here", "get", "got", "make", "let", "lets", "want", "need", "like", "know", "tell", "find", "use",
        "okidoki", "remember", "note", "something", "thing", "things",
    ]

    /// Everyday words people use for the same thing; each group counts as one word.
    static let synonyms: [[String]] = [
        ["manager", "boss", "supervisor"],
        ["wife", "husband", "partner", "spouse"],
        ["flight", "flights", "fly", "airline", "plane", "airport"],
        ["seat", "seating"],
        ["phone", "mobile", "cell"],
        ["address", "home", "live", "lives"],
        ["birthday", "born", "bday"],
        ["kid", "child", "children", "son", "daughter"],
        ["email", "mail", "inbox"],
        ["doctor", "dentist", "gp", "physician"],
        ["food", "eat", "diet", "meal", "vegetarian", "vegan", "allergy", "allergic"],
        ["passport", "visa", "id"],
        ["shoe", "shoes", "sneaker", "size"],
        ["job", "work", "company", "employer", "office"],
    ]

    static let synonymRoot: [String: String] = {
        var map: [String: String] = [:]
        for group in synonyms { for word in group where map[word] == nil { map[word] = group[0] } }
        return map
    }()

    static func stem(_ word: String) -> String {
        guard word.count > 4 else { return word.hasSuffix("s") && word.count > 3 && !word.hasSuffix("ss") ? String(word.dropLast()) : word }
        for suffix in ["ies", "ing", "es", "ed", "s"] where word.hasSuffix(suffix) && !word.hasSuffix("ss") {
            let base = String(word.dropLast(suffix.count))
            return suffix == "ies" ? base + "y" : base
        }
        return word
    }

    /// The words of a text that can tell notes apart. Scripts written without spaces (Chinese, Japanese,
    /// Thai…) are compared by pairs of characters instead.
    public static func terms(_ text: String) -> Set<String> {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
        var out: Set<String> = []
        for raw in folded.split(whereSeparator: { !$0.isLetter && !$0.isNumber }) {
            let word = String(raw)
            if word.unicodeScalars.contains(where: isUnspaced) {
                let chars = Array(word)
                if chars.count == 1 { out.insert(word) }
                for i in 0..<max(chars.count - 1, 0) { out.insert(String(chars[i...i + 1])) }
                continue
            }
            guard word.count >= 2 || word.first?.isNumber == true, !stopwords.contains(word) else { continue }
            if let root = synonymRoot[word] { out.insert(root); continue }
            let stemmed = stem(word)
            out.insert(synonymRoot[stemmed] ?? stemmed)
        }
        return out
    }

    /// Notes rarely change and are ranked on every request, so their terms are kept between requests.
    nonisolated(unsafe) private static var termCache: [String: Set<String>] = [:]
    private static let termLock = NSLock()

    static func cachedTerms(_ text: String) -> Set<String> {
        termLock.lock()
        if let hit = termCache[text] { termLock.unlock(); return hit }
        termLock.unlock()
        let made = terms(text)
        termLock.lock()
        if termCache.count > 20_000 { termCache.removeAll(keepingCapacity: true) }
        termCache[text] = made
        termLock.unlock()
        return made
    }

    static func isUnspaced(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0x0E00...0x0E7F, 0xAC00...0xD7AF: return true
        default: return false
        }
    }

    /// How well a note matches the request's terms: shared terms, weighted toward rarer, longer words.
    public static func score(_ note: Set<String>, query: Set<String>) -> Double {
        var total = 0.0
        for term in query where note.contains(term) { total += term.count >= 5 ? 1.5 : 1 }
        return total
    }

    /// The notes for a request: pinned ones and current right-now notes always, then notes that match
    /// the request (best first), then the newest. At most `limit`, each once.
    public static func select(_ notes: [MemoryItem], query: String, limit: Int,
                              isCurrent: (MemoryItem) -> Bool) -> [MemoryItem] {
        guard limit > 0 else { return [] }
        let newest = notes.sorted { $0.updatedAt > $1.updatedAt }
        var picked: [MemoryItem] = []
        var taken = Set<String>()
        func take(_ item: MemoryItem) {
            guard picked.count < limit, taken.insert(item.id).inserted else { return }
            picked.append(item)
        }
        newest.filter { $0.pinned == true }.forEach(take)
        newest.filter { $0.section == .rightNow && isCurrent($0) }.forEach(take)
        let wanted = terms(query)
        if !wanted.isEmpty {
            let matches = newest.compactMap { item -> (MemoryItem, Double)? in
                guard item.section == .aboutYou || isCurrent(item), !taken.contains(item.id) else { return nil }
                let value = score(cachedTerms(item.text), query: wanted)
                return value > 0 ? (item, value) : nil
            }
            // Stable: equal scores keep newest first.
            matches.enumerated().sorted { a, b in a.element.1 != b.element.1 ? a.element.1 > b.element.1 : a.offset < b.offset }
                .forEach { take($0.element.0) }
        }
        newest.filter { $0.section == .aboutYou }.forEach(take)
        return picked
    }

    /// How a forgotten note is remembered as forgotten: its distinctive terms, sorted, so the same note
    /// written again with other casing or punctuation is one key.
    public static func forgetKey(_ text: String) -> String {
        terms(text).sorted().joined(separator: " ")
    }

    /// Whether a turn repeats a forgotten note: it carries (nearly) all of the note's distinctive words.
    /// Notes of one or two words are matched only when every word is there.
    public static func repeats(_ text: String, forgotten keys: [Set<String>]) -> Bool {
        guard !keys.isEmpty else { return false }
        let have = cachedTerms(text)
        return keys.contains { key in
            guard !key.isEmpty else { return false }
            let shared = key.intersection(have).count
            return key.count <= 2 ? shared == key.count : Double(shared) / Double(key.count) >= 0.75
        }
    }

    /// Notes whose words match a search, best first; for the Memory page when there's no index.
    public static func search(_ notes: [MemoryItem], query: String) -> [MemoryItem] {
        let needle = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespaces)
        let wanted = terms(query)
        return notes.compactMap { item -> (MemoryItem, Double)? in
            let hay = item.text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            let value = score(cachedTerms(item.text), query: wanted) + (!needle.isEmpty && hay.contains(needle) ? 3 : 0)
            return value > 0 ? (item, value) : nil
        }
        .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.updatedAt > $1.0.updatedAt }
        .map(\.0)
    }
}
