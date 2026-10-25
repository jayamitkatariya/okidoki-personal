import Foundation

/// Service credentials for the app itself.
///
/// Values come from the launch environment, then from a `service.env` file: the one the
/// build copies into the app bundle from the gitignored repo `.env`, or one in Application
/// Support. Nothing secret is compiled in; only the public Convex endpoints have defaults.
public enum ServiceSecrets {
    public static let convexCloudURLDefault = "https://wonderful-rook-611.convex.cloud"
    public static let convexSiteURLDefault = "https://wonderful-rook-611.convex.site"

    public static var anthropic: String { resolved("ANTHROPIC_API_KEY") }
    public static var cartesia: String { resolved("CARTESIA_API_KEY") }
    public static var mossProjectID: String { resolved("MOSS_PROJECT_ID") }
    public static var mossProjectKey: String { resolved("MOSS_PROJECT_KEY") }
    public static var apify: String { resolved("APIFY_API_KEY") }
    public static var convexCloudURL: String { resolved("CONVEX_URL", fallback: convexCloudURLDefault) }
    public static var convexSiteURL: String { resolved("CONVEX_SITE_URL", fallback: convexSiteURLDefault) }

    /// Key file ids the app used to ask for. MCP secrets stay user-supplied.
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
            "CONVEX_URL": convexCloudURL,
            "CONVEX_SITE_URL": convexSiteURL,
        ]
    }

    private static func resolved(_ name: String, fallback: String = "") -> String {
        if let env = ProcessInfo.processInfo.environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !env.isEmpty {
            return env
        }
        if let file = fileValues[name], !file.isEmpty { return file }
        return fallback
    }

    private static let fileValues: [String: String] = loadFiles()

    private static func loadFiles() -> [String: String] {
        var merged: [String: String] = [:]
        var urls: [URL] = []
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_ENV_FILE"], !override.isEmpty {
            urls.append(URL(fileURLWithPath: override))
        }
        if let bundled = Bundle.main.url(forResource: "service", withExtension: "env") {
            urls.append(bundled)
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Okidoki/service.env")
        if let support { urls.append(support) }
        #if DEBUG
        // Development only: a release build must not take credentials from a file any process can drop on the Desktop.
        let home = URL(fileURLWithPath: NSHomeDirectory())
        urls.append(home.appendingPathComponent("Desktop/okidoki/.env"))
        urls.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".env"))
        #endif
        for url in urls {
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            // Earlier files win, so an explicit override beats the repo file.
            let parsed = parse(text)
            for (key, value) in parsed where merged[key] == nil {
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
