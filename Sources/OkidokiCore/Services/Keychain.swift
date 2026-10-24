import Foundation
import Security

public enum Keychain {
    private static let service = "com.jaykatariya.okidoki.keys"

    public static func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    public static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8) else { return nil }
        return string
    }

    public static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public static func has(_ key: String) -> Bool {
        (get(key)?.isEmpty == false)
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
                        blurb: "The brain. Reads your screen, writes answers, plans actions.",
                        placeholder: "sk-ant-…", url: "https://console.anthropic.com/settings/keys"),
        KeyProviderSpec(id: "cartesia", name: "Cartesia",
                        blurb: "Fast, warm voices for spoken answers.",
                        placeholder: "sk_car_…", url: "https://play.cartesia.ai/console"),
        KeyProviderSpec(id: "moss", name: "Moss",
                        blurb: "Semantic search across your threads and memory.",
                        placeholder: "moss_…", url: "https://moss.dev", optional: true),
        KeyProviderSpec(id: "apify", name: "Apify",
                        blurb: "Live web scraping and ready-made actors.",
                        placeholder: "apify_api_…", url: "https://console.apify.com/account/integrations", optional: true),
        KeyProviderSpec(id: "convex", name: "Convex sync",
                        blurb: "Private sync of threads, memory and runs across Macs.",
                        placeholder: "sync secret", url: "https://convex.dev", optional: true),
    ]

    public static func spec(_ id: String) -> KeyProviderSpec? { all.first { $0.id == id } }
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
        VoiceOption(id: "sarah", name: "sarah", blurb: "calm, clear, a little dry", cartesiaID: "694f9389-aac1-45b6-b726-9d9369183238"),
        VoiceOption(id: "brielle", name: "brielle", blurb: "warm and quick", cartesiaID: "79a125e8-cd45-4c13-8a67-188112f4dd22"),
        VoiceOption(id: "barney", name: "barney", blurb: "low, friendly, unhurried", cartesiaID: "a0e99841-438c-4a64-b679-ae501e7d6091"),
        VoiceOption(id: "system", name: "system voice", blurb: "uses your Mac's own voice", cartesiaID: ""),
    ]
    public static func voice(_ id: String) -> VoiceOption { all.first { $0.id == id } ?? all[0] }
}
