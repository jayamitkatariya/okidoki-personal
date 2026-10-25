import Foundation

/// Settings an IT team pushes to a Mac so okidoki is in the organization before anyone types
/// anything. Read from the managed app configuration (an MDM profile for the app's bundle id
/// lands in `com.apple.configuration.managed`), or from the environment for testing:
///
///   OkidokiConvexSiteURL   / OKIDOKI_MANAGED_CONVEX_URL   — the deployment's HTTP site URL
///   OkidokiJoinCode        / OKIDOKI_MANAGED_JOIN_CODE    — a six-character organization join code
///   OkidokiOrgName         / OKIDOKI_MANAGED_ORG_NAME     — what to call it before the login exists
///   OkidokiWorkAccountName / OKIDOKI_MANAGED_ACCOUNT_NAME — the work account to create, if none
///
/// Nothing here can sign the person in: the join code waits in settings for the sync login,
/// and the Team page uses it the moment that exists.
public struct ManagedConfig: Equatable, Sendable {
    public var convexSiteURL: String
    public var joinCode: String
    public var orgName: String
    public var workAccountName: String

    public var isEmpty: Bool { convexSiteURL.isEmpty && joinCode.isEmpty }

    public init(convexSiteURL: String = "", joinCode: String = "", orgName: String = "", workAccountName: String = "") {
        self.convexSiteURL = convexSiteURL
        self.joinCode = joinCode
        self.orgName = orgName
        self.workAccountName = workAccountName
    }

    /// What's on this Mac right now.
    public static func current(defaults: UserDefaults = .standard, environment: [String: String] = ProcessInfo.processInfo.environment) -> ManagedConfig {
        let managed = defaults.dictionary(forKey: "com.apple.configuration.managed") ?? [:]
        func value(_ key: String, _ envKey: String) -> String {
            let fromProfile = (managed[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !fromProfile.isEmpty { return fromProfile }
            return environment[envKey]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        return ManagedConfig(convexSiteURL: value("OkidokiConvexSiteURL", "OKIDOKI_MANAGED_CONVEX_URL"),
                             joinCode: cleanCode(value("OkidokiJoinCode", "OKIDOKI_MANAGED_JOIN_CODE")),
                             orgName: value("OkidokiOrgName", "OKIDOKI_MANAGED_ORG_NAME"),
                             workAccountName: value("OkidokiWorkAccountName", "OKIDOKI_MANAGED_ACCOUNT_NAME"))
    }

    public static func cleanCode(_ code: String) -> String {
        let cleaned = code.uppercased().filter { $0.isLetter || $0.isNumber }
        return cleaned.count == 6 ? cleaned : ""
    }

    /// Puts the configuration into the store: the deployment URL (sync on), a work account when
    /// there isn't one, and the join code waiting for the login. Never overrides what the person
    /// already set, so a profile pushed later doesn't undo their choices. Returns what changed.
    @MainActor
    @discardableResult
    public func apply(to store: OkidokiStore) -> [String] {
        var changed: [String] = []
        if !convexSiteURL.isEmpty, store.settings.convexSiteURL.isEmpty {
            store.settings.convexSiteURL = convexSiteURL
            store.settings.syncEnabled = true
            changed.append("sync")
        }
        if !joinCode.isEmpty {
            if !store.accounts.contains(where: { $0.kind == .work }) {
                let name = workAccountName.isEmpty ? "\(store.activeAccount.firstName) at \(orgName.isEmpty ? "work" : orgName)" : workAccountName
                let current = store.currentAccountID
                store.createAccount(name: name, email: "", kind: .work)
                // The person keeps whatever account they were using; the work one is there when they switch.
                store.switchAccount(current)
                changed.append("account")
            }
            if store.settings.pendingJoinCode != joinCode {
                store.settings.pendingJoinCode = joinCode
                store.settings.pendingJoinOrgName = orgName
                changed.append("join")
            }
        }
        if !changed.isEmpty { store.saveNow() }
        return changed
    }
}
