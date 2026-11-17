import Foundation

/// What may become a memory, checked on the Mac for every save path (chat, the CLI, the Memory page,
/// an agent's `remember`), including when the brain is down. Mirrors brain/src/memorycapture.ts.
public enum MemoryPolicy {
    // MARK: - Secrets

    private static let secretWords = "\\b(pass(?:word|code|phrase)|pwd|pin(?:\\s*number)?(?!\\s*code)|otp|one[- ]time (?:code|password)|verification code|2fa code|security code|cvv|cvc|card number|credit card|debit card|api[- ]?key|secret key|access token|private key|seed phrase|recovery (?:phrase|code)|ssn|social security|passport (?:number|no)|aadhaar|pan (?:number|card)|driver'?s licen[cs]e (?:number|no)|bank account (?:number|no)|routing number|iban|tax id)\\b"
    private static let keyShapes = [
        "\\bsk-[A-Za-z0-9_-]{16,}", "\\bAKIA[0-9A-Z]{16}\\b", "\\bgh[pousr]_[A-Za-z0-9]{20,}",
        "\\bxox[abpr]-[A-Za-z0-9-]{10,}", "\\bAIza[0-9A-Za-z_-]{30,}", "-----BEGIN [A-Z ]*PRIVATE KEY-----",
        "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.",
    ]

    private static func matches(_ text: String, _ pattern: String, caseInsensitive: Bool = false) -> Range<String.Index>? {
        text.range(of: pattern, options: caseInsensitive ? [.regularExpression, .caseInsensitive] : [.regularExpression])
    }

    private static func luhn(_ digits: [Int]) -> Bool {
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            var v = d
            if i % 2 == 1 { v *= 2; if v > 9 { v -= 9 } }
            sum += v
        }
        return sum % 10 == 0
    }

    /// What kind of secret the text holds ("a password", "a card number", …), or nil. Naming a secret
    /// without its value ("I keep my passwords in 1Password") is not one.
    public static func secretKind(_ text: String) -> String? {
        for shape in keyShapes where matches(text, shape) != nil { return "an API key or token" }
        if let regex = try? NSRegularExpression(pattern: "\\b(?:\\d[ -]?){13,19}\\b") {
            let ns = text as NSString
            for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let digits = ns.substring(with: match.range).compactMap { $0.wholeNumberValue }
                if (13...19).contains(digits.count), luhn(digits) { return "a card number" }
            }
        }
        if matches(text, "\\b\\d{3}-\\d{2}-\\d{4}\\b") != nil || matches(text, "\\b\\d{4}\\s\\d{4}\\s\\d{4}\\b") != nil
            || matches(text, "\\b[A-Z]{5}\\d{4}[A-Z]\\b") != nil { return "an ID number" }
        if let word = matches(text, secretWords, caseInsensitive: true) {
            let name = text[word].lowercased()
            let after = String(text[word.upperBound...])
            let hasValue = matches(after, "^\\s*(?:is|was|=|:|of|to|will be|'s)?\\s*[\"'`]?[^\\s\"'`]{3,}", caseInsensitive: true) != nil
                && matches(String(after.prefix(60)), "[0-9]|[^\\x00-\\x7F]|[A-Za-z]\\S*[0-9!@#$%^&*]|^\\s*(?:is|=|:)\\s*[\"'`]?\\S{4,}", caseInsensitive: true) != nil
            if hasValue {
                if matches(name, "otp|one[- ]time|verification|2fa|security code") != nil { return "a one-time code" }
                if matches(name, "card|cvv|cvc") != nil { return "a card number" }
                if matches(name, "ssn|social|passport|aadhaar|pan |licen|tax id") != nil { return "an ID number" }
                if matches(name, "bank|routing|iban") != nil { return "a bank number" }
                if matches(name, "key|token|seed|recovery") != nil { return "an API key or token" }
                return "a password"
            }
        }
        return nil
    }

    /// The line okidoki says when it won't keep something.
    public static func vaultNote(_ kind: String) -> String {
        "That looks like \(kind), so I didn't save it to memory. Secrets belong in the Vault (Settings → Vault), where they stay encrypted."
    }

    // MARK: - Instructions

    private static let instruction = "\\b(ignore (?:all |any |the )?(?:previous|prior|above)|disregard|system prompt|you (?:must|should|are to|will)|always (?:send|forward|share|transfer|pay|click|visit|use this)|from now on|okidoki (?:must|should|will)|the assistant (?:must|should)|forward (?:all|every)|send (?:all|every|your)|wire|transfer (?:money|funds)|new instructions?|admin(?:istrator)? (?:says|mode))\\b"

    /// Reads like an instruction to the assistant rather than a fact about the person.
    public static func looksLikeInstruction(_ text: String) -> Bool {
        matches(text, instruction, caseInsensitive: true) != nil
    }

    /// Why a fact can't be saved, or nil when it can. `untrusted` is for facts an agent proposed.
    public static func refusal(_ fact: String, untrusted: Bool = false) -> String? {
        if let kind = secretKind(fact) { return "secret:\(kind)" }
        if looksLikeInstruction(fact) { return "instruction" }
        if untrusted, matches(fact, "https?://|www\\.[a-z]", caseInsensitive: true) != nil { return "instruction" }
        if untrusted, fact.count > 240 || matches(fact, "\\b(clipboard|screenshot|pasted|okidoki (can(?:not|'t)|must|should)|i (can(?:not|'t)|couldn't)|this request)\\b", caseInsensitive: true) != nil {
            return "not-a-fact"
        }
        return nil
    }

    // MARK: - Similarity + corrections

    private static let stop: Set<String> = Set("a an the is are was were am be been my i me i'm im their they them his her its of to in on at for and or with that this as by it user person person's user's okidoki".split(separator: " ").map(String.init))

    static func words(_ text: String) -> [String] {
        let lowered = text.lowercased().map { $0.isLetter || $0.isNumber || $0 == "'" || $0.isWhitespace ? $0 : " " }
        return String(lowered).split(whereSeparator: \.isWhitespace).map(String.init).filter { !stop.contains($0) }
    }

    public static func similarity(_ a: String, _ b: String) -> Double {
        let x = Set(words(a)), y = Set(words(b))
        guard !x.isEmpty, !y.isEmpty else { return 0 }
        let both = x.intersection(y).count
        return Double(both) / Double(x.count + y.count - both)
    }

    /// "My manager is Ravi" → "manager": what a fact is about when it reads "<subject> is <value>".
    public static func subject(_ fact: String) -> String {
        var text = fact.lowercased()
        text = text.replacingOccurrences(of: "^(actually|correction|update|now|fyi|note|remember)[,:]?\\s+(that\\s+)?", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "^(the (person|user)'?s?|their|my|our|i'm|i am)\\s+", with: "", options: .regularExpression)
        text = text.trimmingCharacters(in: .whitespaces)
        guard let regex = try? NSRegularExpression(pattern: "^([\\p{L}\\p{N}' -]{2,40}?)\\s+(?:is|are|was|=|:)\\s+(?:now\\s+|actually\\s+)?\\S"),
              let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else { return "" }
        let subject = (text as NSString).substring(with: match.range(at: 1))
            .replacingOccurrences(of: "^(the|a|an)\\s+", with: "", options: .regularExpression)
        return subject.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    public enum Match: Equatable {
        case new
        case duplicate(id: String)
        case correction(id: String)
    }

    /// Without the model: the same thing again is a duplicate; the same subject with a new value is a correction.
    public static func match(_ fact: String, in known: [MemoryItem]) -> Match {
        let norm = words(fact).joined(separator: " ")
        for item in known where words(item.text).joined(separator: " ") == norm || similarity(item.text, fact) >= 0.85 {
            return .duplicate(id: item.id)
        }
        let subject = subject(fact)
        if !subject.isEmpty, let same = known.first(where: { Self.subject($0.text) == subject }) {
            return .correction(id: same.id)
        }
        return .new
    }
}
