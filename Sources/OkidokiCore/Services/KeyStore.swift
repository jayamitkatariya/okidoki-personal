import Foundation
import Security

/// API keys and MCP secrets, saved in a private file in okidoki's folder:
/// `~/Library/Application Support/Okidoki/keys.json`, readable only by you.
/// The file never leaves this Mac — it isn't part of the synced state.
public enum KeyStore {
    private static let lock = NSLock()
    private static var cache: [String: String]? // guarded by lock

    static var fileURL: URL {
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_KEYS_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Okidoki", isDirectory: true)
            .appendingPathComponent("keys.json")
    }

    public static func set(_ value: String, for key: String) {
        update { $0[key] = value }
    }

    public static func get(_ key: String) -> String? {
        if ProcessInfo.processInfo.environment["OKIDOKI_OVERLAY_PREVIEW"] == "1" { return nil }
        lock.lock()
        defer { lock.unlock() }
        return load()[key]
    }

    public static func delete(_ key: String) {
        update { $0[key] = nil }
    }

    public static func has(_ key: String) -> Bool {
        (get(key)?.isEmpty == false)
    }

    private static func update(_ change: (inout [String: String]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var keys = load()
        change(&keys)
        cache = keys
        save(keys)
    }

    /// Reads the file once and keeps it in memory. Callers hold the lock.
    private static func load() -> [String: String] {
        if let cache { return cache }
        var keys: [String: String] = [:]
        if let data = try? Data(contentsOf: fileURL) {
            keys = (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
        } else {
            // No file yet: bring over keys an earlier version kept in the Keychain, once.
            keys = LegacyKeychain.takeAll()
            if !keys.isEmpty { save(keys) }
        }
        cache = keys
        return keys
    }

    /// Writes owner-only (0600) to a temporary file, then swaps it in, so a crash never leaves half a file.
    private static func save(_ keys: [String: String]) {
        let url = fileURL
        let folder = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(keys) else { return }
        let temp = folder.appendingPathComponent(".keys-\(UUID().uuidString).json")
        guard FileManager.default.createFile(atPath: temp.path, contents: data,
                                             attributes: [.posixPermissions: 0o600]) else { return }
        if rename(temp.path, url.path) != 0 {
            try? FileManager.default.removeItem(at: temp)
        }
    }
}

/// The macOS Keychain items earlier versions saved keys in. Only read once, to move them to `KeyStore`.
enum LegacyKeychain {
    private static let service = "com.jaykatariya.okidoki.keys"

    /// Every saved key, removed from the Keychain as it's read.
    static func takeAll() -> [String: String] {
        let list: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var found: AnyObject?
        guard SecItemCopyMatching(list as CFDictionary, &found) == errSecSuccess,
              let items = found as? [[String: Any]] else { return [:] }
        var keys: [String: String] = [:]
        for account in items.compactMap({ $0[kSecAttrAccount as String] as? String }) {
            let item: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            var query = item
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: AnyObject?
            if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
               let data = result as? Data, let value = String(data: data, encoding: .utf8) {
                keys[account] = value
                SecItemDelete(item as CFDictionary)
            }
        }
        return keys
    }
}

public struct KeyProviderSpec: Identifiable, Sendable {
    public var id: String
    public var name: String
    public var blurb: String
    public var placeholder: String
    public var url: String
    public var optional: Bool

    public init(id: String, name: String, blurb: String, placeholder: String, url: String, optional: Bool = false) {
        self.id = id; self.name = name; self.blurb = blurb; self.placeholder = placeholder
        self.url = url; self.optional = optional
    }
}

public enum KeyProviders {
    public static let all: [KeyProviderSpec] = [
        KeyProviderSpec(id: "anthropic", name: "Anthropic",
                        blurb: "Required. Reads the screen, teaches, and plans every action.",
                        placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys"),
        KeyProviderSpec(id: "cartesia", name: "Cartesia",
                        blurb: "Fast, warm voices for spoken answers.",
                        placeholder: "sk_car_…", url: "https://play.cartesia.ai/console"),
        KeyProviderSpec(id: "moss", name: "Moss",
                        blurb: "Semantic search across your threads and memory.",
                        placeholder: "project-id:project-key", url: "https://moss.dev", optional: true),
        KeyProviderSpec(id: "apify", name: "Apify",
                        blurb: "Live web scraping and ready-made actors.",
                        placeholder: "apify_api_…", url: "https://console.apify.com/account/integrations", optional: true),
        KeyProviderSpec(id: "convex", name: "Convex sync",
                        blurb: "Private sync of threads, memory and runs across Macs.",
                        placeholder: "sync secret", url: "https://convex.dev", optional: true),
    ]
}

public struct VoiceOption: Identifiable, Sendable {
    public var id: String
    public var name: String
    public var blurb: String
    public var cartesiaID: String
    public init(id: String, name: String, blurb: String, cartesiaID: String) {
        self.id = id; self.name = name; self.blurb = blurb; self.cartesiaID = cartesiaID
    }
}

public enum Voices {
    public static let all: [VoiceOption] = [
        // Cartesia voices (sonic-3). An id no longer listed here (like the retired "brielle") falls back to sarah.
        VoiceOption(id: "sarah", name: "sarah", blurb: "soothing and calm · american", cartesiaID: "694f9389-aac1-45b6-b726-9d9369183238"),
        VoiceOption(id: "barney", name: "barney", blurb: "deep, steady, conversational · american", cartesiaID: "a0e99841-438c-4a64-b679-ae501e7d6091"),
        VoiceOption(id: "eden", name: "eden", blurb: "clear, gender-neutral · american", cartesiaID: "83ae58a1-7e97-4b94-b03f-e4cc0a10d8af"),
        VoiceOption(id: "archie", name: "archie", blurb: "warm and casual · british", cartesiaID: "ef191366-f52f-447a-a398-ed8c0f2943a1"),
        VoiceOption(id: "siobhan", name: "siobhan", blurb: "friendly and everyday · irish", cartesiaID: "d79d2b77-9192-4e10-9407-5d43ca034803"),
        VoiceOption(id: "devansh", name: "devansh", blurb: "warm and easygoing · indian english", cartesiaID: "1259b7e3-cb8a-43df-9446-30971a46b8b0"),
        VoiceOption(id: "ella", name: "ella", blurb: "bright and light · australian", cartesiaID: "2a12b36c-7f9b-4c3a-9f7a-72731b15323a"),
        VoiceOption(id: "brenda", name: "brenda", blurb: "cheerful and upbeat · african american", cartesiaID: "607167f6-9bf2-473c-accc-ac7b3b66b30b"),
        VoiceOption(id: "wyatt", name: "wyatt", blurb: "clear, with a gentle drawl · southern us", cartesiaID: "5fc5c797-12c5-4f2b-ac9b-d4e53c08098f"),
        VoiceOption(id: "system", name: "system voice", blurb: "uses your Mac's own voice", cartesiaID: ""),
    ]
    public static func voice(_ id: String) -> VoiceOption { all.first { $0.id == id } ?? all[0] }
}
