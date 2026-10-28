import Foundation

/// Keys you bring yourself, from outside the app's own key file.
///
/// Nothing is compiled in or bundled. Settings › Keys is the usual place for a key (it lands in
/// `keys.json`); this covers the other ways to hand one over: the launch environment, a file named by
/// `OKIDOKI_ENV_FILE`, or a `service.env` you put in the support folder yourself.
public enum ServiceSecrets {
    public static var anthropic: String { resolved("ANTHROPIC_API_KEY") }
    public static var cartesia: String { resolved("CARTESIA_API_KEY") }
    public static var mossProjectID: String { resolved("MOSS_PROJECT_ID") }
    public static var mossProjectKey: String { resolved("MOSS_PROJECT_KEY") }
    public static var apify: String { resolved("APIFY_API_KEY") }

    /// Key file ids, as found outside the key file. MCP secrets stay in the key file.
    public static func builtin(_ key: String) -> String? {
        switch key {
        case "anthropic": return anthropic
        case "cartesia": return cartesia
        case "moss": return mossProjectID.isEmpty || mossProjectKey.isEmpty ? nil : "\(mossProjectID):\(mossProjectKey)"
        case "apify": return apify
        default: return nil
        }
    }

    /// Variables to hand the brain sidecar. Empty values are left out by the caller.
    public static var brainEnvironment: [String: String] {
        [
            "ANTHROPIC_API_KEY": anthropic,
            "CARTESIA_API_KEY": cartesia,
            "MOSS_PROJECT_ID": mossProjectID,
            "MOSS_PROJECT_KEY": mossProjectKey,
            "APIFY_API_KEY": apify,
        ]
    }

    private static func resolved(_ name: String) -> String {
        if let env = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !env.isEmpty {
            return env
        }
        return fileValues[name] ?? ""
    }

    private static let fileValues: [String: String] = loadFiles()

    private static func loadFiles() -> [String: String] {
        var merged: [String: String] = [:]
        var urls: [URL] = []
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_ENV_FILE"], !override.isEmpty {
            urls.append(URL(fileURLWithPath: override))
        }
        urls.append(AppPaths.support("service.env"))
        for url in urls {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            // Earlier files win, so an explicit override beats the support folder's file.
            for (key, value) in parse(text) where merged[key] == nil {
                merged[key] = value
            }
        }
        return merged
    }

    static func parse(_ text: String) -> [String: String] {
        var values: [String: String] = [:]
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2, let first = value.first, (first == "\"" || first == "'"), value.last == first {
                value = String(value.dropFirst().dropLast())
            }
            if !key.isEmpty, !value.isEmpty { values[key] = value }
        }
        return values
    }
}
