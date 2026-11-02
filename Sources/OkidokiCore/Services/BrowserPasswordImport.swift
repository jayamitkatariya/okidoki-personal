import CommonCrypto
import CryptoKit
import Foundation
import Security
import SQLite3

/// A browser okidoki can bring saved passwords in from. Chromium-family browsers keep logins in a
/// "Login Data" SQLite file per profile, sealed with a key that sits in the login Keychain under
/// "<Name> Safe Storage".
public struct ChromiumBrowser: Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    /// The browser's data folder, relative to ~/Library/Application Support.
    public var folder: String
    /// Keychain services that may hold its Safe Storage key, tried in order.
    public var keychainServices: [String]

    public init(id: String, name: String, folder: String, keychainServices: [String]) {
        self.id = id; self.name = name; self.folder = folder; self.keychainServices = keychainServices
    }
}

/// One login read from a browser or a CSV export. The password lives only in memory, only until it's sealed.
public struct ImportedLogin: Equatable, Sendable {
    public var site: String
    public var username: String
    public var password: String
    public var lastUsedAt: Date?

    public init(site: String, username: String, password: String, lastUsedAt: Date? = nil) {
        self.site = site; self.username = username; self.password = password; self.lastUsedAt = lastUsedAt
    }
}

/// A browser found on this Mac, as the panel and onboarding list it. Never carries a secret.
public struct DetectedBrowser: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    /// Profile names, e.g. "Default", "Work".
    public var profiles: [String]
    /// Saved logins across its profiles, counted without opening any of them; nil when unknown.
    public var logins: Int?
    /// Why it can't be read right now (macOS blocked the folder, …).
    public var error: String?

    public init(id: String, name: String, profiles: [String], logins: Int?, error: String?) {
        self.id = id; self.name = name; self.profiles = profiles; self.logins = logins; self.error = error
    }
}

/// What an import did. Counts and reasons only.
public struct VaultImportReport: Codable, Equatable, Sendable {
    public var source: String
    public var imported: Int
    public var updated: Int
    public var skipped: Int
    public var errors: [String]
    public var finishedAt: Date

    public init(source: String, imported: Int = 0, updated: Int = 0, skipped: Int = 0, errors: [String] = [], finishedAt: Date = Date()) {
        self.source = source; self.imported = imported; self.updated = updated; self.skipped = skipped
        self.errors = errors; self.finishedAt = finishedAt
    }

    /// "12 added, 3 updated, 40 already in the vault".
    public var summary: String {
        var parts: [String] = []
        if imported > 0 { parts.append("\(imported) added") }
        if updated > 0 { parts.append("\(updated) updated") }
        if skipped > 0 { parts.append("\(skipped) skipped") }
        if parts.isEmpty { return errors.first ?? "nothing to import" }
        return parts.joined(separator: ", ")
    }
}

public enum BrowserPasswordImport {
    public struct Failure: LocalizedError, Sendable, Equatable {
        public var reason: String
        public var errorDescription: String? { reason }
        public init(_ reason: String) { self.reason = reason }
    }

    // MARK: - Browsers

    /// Chromium-family browsers on macOS. "Arc", "Dia", "Chrome" and "Comet" Safe Storage items were
    /// seen in a real Keychain; the rest follow each browser's published naming.
    public static let browsers: [ChromiumBrowser] = [
        ChromiumBrowser(id: "chrome", name: "Google Chrome", folder: "Google/Chrome", keychainServices: ["Chrome Safe Storage"]),
        ChromiumBrowser(id: "chrome-beta", name: "Chrome Beta", folder: "Google/Chrome Beta", keychainServices: ["Chrome Safe Storage"]),
        ChromiumBrowser(id: "chrome-canary", name: "Chrome Canary", folder: "Google/Chrome Canary", keychainServices: ["Chrome Safe Storage"]),
        ChromiumBrowser(id: "arc", name: "Arc", folder: "Arc/User Data", keychainServices: ["Arc Safe Storage"]),
        ChromiumBrowser(id: "dia", name: "Dia", folder: "Dia/User Data", keychainServices: ["Dia Safe Storage"]),
        ChromiumBrowser(id: "brave", name: "Brave", folder: "BraveSoftware/Brave-Browser", keychainServices: ["Brave Safe Storage", "Brave Browser Safe Storage"]),
        ChromiumBrowser(id: "edge", name: "Microsoft Edge", folder: "Microsoft Edge", keychainServices: ["Microsoft Edge Safe Storage"]),
        ChromiumBrowser(id: "chromium", name: "Chromium", folder: "Chromium", keychainServices: ["Chromium Safe Storage"]),
        ChromiumBrowser(id: "vivaldi", name: "Vivaldi", folder: "Vivaldi", keychainServices: ["Vivaldi Safe Storage"]),
        ChromiumBrowser(id: "opera", name: "Opera", folder: "com.operasoftware.Opera", keychainServices: ["Opera Safe Storage", "Opera Browser Safe Storage"]),
        ChromiumBrowser(id: "comet", name: "Comet", folder: "Comet", keychainServices: ["Comet Safe Storage"]),
        ChromiumBrowser(id: "helium", name: "Helium", folder: "net.imput.helium", keychainServices: ["Helium Storage Key", "Helium Safe Storage"]),
    ]

    public static func browser(id: String) -> ChromiumBrowser? { browsers.first { $0.id == id } }

    public static var applicationSupport: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
    }

    static let blockedHint = "macOS blocked okidoki from reading it. Allow okidoki under System Settings › Privacy & Security › Full Disk Access, or export a CSV from the browser and import that."

    /// A profile's "Login Data" file and the name the browser shows for it.
    public struct Profile: Equatable, Sendable {
        public var folder: String
        public var name: String
        public var loginData: URL
    }

    /// Profiles of a browser that have a "Login Data" file. Throws when the folder is there but macOS won't list it.
    public static func profiles(of browser: ChromiumBrowser, support: URL = applicationSupport,
                                fileManager: FileManager = .default) throws -> [Profile]? {
        let root = support.appendingPathComponent(browser.folder, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
        let names: [String]
        do {
            names = try fileManager.contentsOfDirectory(atPath: root.path)
        } catch {
            if isPermissionError(error) { throw Failure(blockedHint) }
            throw Failure("couldn't read its folder: \(error.localizedDescription)")
        }
        let displayNames = profileNames(root.appendingPathComponent("Local State"))
        var found: [Profile] = []
        // Opera keeps its one profile in the root.
        let rootLogin = root.appendingPathComponent("Login Data")
        if fileManager.fileExists(atPath: rootLogin.path) {
            found.append(Profile(folder: "", name: "Default", loginData: rootLogin))
        }
        let profileFolders = names.filter { $0 == "Default" || $0.hasPrefix("Profile ") }
        for folder in profileFolders.sorted(by: { profileOrder($0) < profileOrder($1) }) {
            let file = root.appendingPathComponent(folder).appendingPathComponent("Login Data")
            guard fileManager.fileExists(atPath: file.path) else { continue }
            found.append(Profile(folder: folder, name: displayNames[folder] ?? folder, loginData: file))
        }
        return found
    }

    private static func profileOrder(_ folder: String) -> String {
        folder == "Default" ? "" : folder.replacingOccurrences(of: #"\d+"#, with: "", options: .regularExpression) + String(format: "%06d", Int(folder.filter(\.isNumber)) ?? 0)
    }

    /// Profile folder → the name the person gave it, from the browser's "Local State".
    static func profileNames(_ localState: URL) -> [String: String] {
        guard let data = try? Data(contentsOf: localState),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let profile = json["profile"] as? [String: Any],
              let cache = profile["info_cache"] as? [String: Any] else { return [:] }
        var names: [String: String] = [:]
        for (folder, info) in cache {
            if let name = (info as? [String: Any])?["name"] as? String, !name.isEmpty { names[folder] = name }
        }
        return names
    }

    static func isPermissionError(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain, ns.code == NSFileReadNoPermissionError { return true }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain,
           underlying.code == Int(EPERM) || underlying.code == Int(EACCES) { return true }
        if ns.domain == NSPOSIXErrorDomain, ns.code == Int(EPERM) || ns.code == Int(EACCES) { return true }
        return false
    }

    /// Installed browsers with their profiles and how many logins each holds. Reads no secrets and asks
    /// the Keychain nothing.
    public static func detect(support: URL = applicationSupport, fileManager: FileManager = .default) -> [DetectedBrowser] {
        browsers.compactMap { browser in
            do {
                guard let profiles = try profiles(of: browser, support: support, fileManager: fileManager) else { return nil }
                guard !profiles.isEmpty else { return nil }
                var total = 0
                var known = true
                for profile in profiles {
                    if let count = try? withCopy(of: profile.loginData, { try countLogins(in: $0) }) { total += count } else { known = false }
                }
                return DetectedBrowser(id: browser.id, name: browser.name, profiles: profiles.map(\.name),
                                       logins: known ? total : (total > 0 ? total : nil), error: nil)
            } catch {
                return DetectedBrowser(id: browser.id, name: browser.name, profiles: [], logins: nil,
                                       error: (error as? Failure)?.reason ?? error.localizedDescription)
            }
        }
    }

    // MARK: - Reading a browser

    /// Every saved login in every profile of `browser`, opened with its Safe Storage key. macOS asks
    /// the person before handing over the key.
    public static func read(_ browser: ChromiumBrowser, support: URL = applicationSupport,
                            fileManager: FileManager = .default) throws -> (logins: [ImportedLogin], skipped: Int, errors: [String]) {
        guard let profiles = try profiles(of: browser, support: support, fileManager: fileManager), !profiles.isEmpty else {
            throw Failure("\(browser.name) has no saved passwords on this Mac")
        }
        let password = try safeStoragePassword(services: browser.keychainServices, browser: browser.name)
        guard let key = chromiumKey(password: password) else { throw Failure("couldn't derive \(browser.name)'s key") }
        var logins: [ImportedLogin] = []
        var skipped = 0
        var errors: [String] = []
        for profile in profiles {
            do {
                let result = try withCopy(of: profile.loginData) { try readLogins(at: $0, key: key) }
                logins += result.logins
                skipped += result.skipped
            } catch {
                let reason = isPermissionError(error) ? blockedHint : ((error as? Failure)?.reason ?? error.localizedDescription)
                errors.append("\(browser.name) · \(profile.name): \(reason)")
            }
        }
        return (logins, skipped, errors)
    }

    /// The browser's Safe Storage password from the login Keychain.
    static func safeStoragePassword(services: [String], browser: String) throws -> Data {
        var lastStatus: OSStatus = errSecItemNotFound
        for service in services {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecSuccess, let data = item as? Data, !data.isEmpty { return data }
            lastStatus = status
            if status != errSecItemNotFound { break }
        }
        switch lastStatus {
        case errSecItemNotFound:
            throw Failure("\(browser) hasn't stored its password key in the Keychain yet — open it once, or export a CSV")
        case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed:
            throw Failure("Keychain access to \(browser)'s key was declined")
        default:
            throw Failure("the Keychain wouldn't give \(browser)'s key (error \(lastStatus))")
        }
    }

    /// Chromium on macOS: PBKDF2-HMAC-SHA1 over the Safe Storage password, salt "saltysalt", 1003 rounds, 16 bytes.
    public static func chromiumKey(password: Data) -> Data? {
        let salt = Array("saltysalt".utf8)
        var derived = [UInt8](repeating: 0, count: kCCKeySizeAES128)
        let status = password.withUnsafeBytes { raw -> Int32 in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                 raw.bindMemory(to: Int8.self).baseAddress, raw.count,
                                 salt, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003,
                                 &derived, derived.count)
        }
        return status == kCCSuccess ? Data(derived) : nil
    }

    static let chromiumIV = Data(repeating: 0x20, count: kCCBlockSizeAES128)

    /// A "v10" value: AES-128-CBC, IV of 16 spaces, PKCS7. Nil for anything else or a wrong key.
    public static func decryptChromium(_ value: Data, key: Data) -> String? {
        guard value.count > 3, value.prefix(3) == Data("v10".utf8) else { return nil }
        guard let plain = aesCBC(CCOperation(kCCDecrypt), Data(value.dropFirst(3)), key: key) else { return nil }
        return String(data: plain, encoding: .utf8)
    }

    /// The other direction, for tests that build a synthetic "Login Data".
    public static func encryptChromium(_ secret: String, key: Data) -> Data? {
        aesCBC(CCOperation(kCCEncrypt), Data(secret.utf8), key: key).map { Data("v10".utf8) + $0 }
    }

    private static func aesCBC(_ operation: CCOperation, _ input: Data, key: Data) -> Data? {
        var output = Data(count: input.count + kCCBlockSizeAES128)
        let capacity = output.count
        var moved = 0
        let status = output.withUnsafeMutableBytes { out in
            input.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    chromiumIV.withUnsafeBytes { iv in
                        CCCrypt(operation, CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                                keyBytes.baseAddress, key.count, iv.baseAddress,
                                inBytes.baseAddress, input.count, out.baseAddress, capacity, &moved)
                    }
                }
            }
        }
        guard status == kCCSuccess else { return nil }
        return output.prefix(moved)
    }

    /// Runs `body` on a private copy of a SQLite file (and its -wal/-journal), so a browser that's open
    /// and holding a lock doesn't get in the way. The copy is removed afterwards.
    static func withCopy<T>(of file: URL, _ body: (URL) throws -> T) throws -> T {
        let fm = FileManager.default
        let folder = fm.temporaryDirectory.appendingPathComponent("okidoki-import-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: folder) }
        let copy = folder.appendingPathComponent("Login Data")
        try fm.copyItem(at: file, to: copy)
        for suffix in ["-wal", "-journal"] {
            let side = URL(fileURLWithPath: file.path + suffix)
            if fm.fileExists(atPath: side.path) { try? fm.copyItem(at: side, to: URL(fileURLWithPath: copy.path + suffix)) }
        }
        return try body(copy)
    }

    static func countLogins(in file: URL) throws -> Int {
        let db = try openDatabase(file)
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0", -1, &statement, nil) == SQLITE_OK else {
            throw Failure("not a browser login database")
        }
        defer { sqlite3_finalize(statement) }
        return sqlite3_step(statement) == SQLITE_ROW ? Int(sqlite3_column_int64(statement, 0)) : 0
    }

    private static func openDatabase(_ file: URL) throws -> OpaquePointer? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            sqlite3_close(db)
            throw Failure("couldn't open the login database")
        }
        return db
    }

    /// Microseconds since 1601-01-01, as Chromium stores time.
    static func chromiumDate(_ micros: Int64) -> Date? {
        guard micros > 0 else { return nil }
        return Date(timeIntervalSince1970: Double(micros) / 1_000_000 - 11_644_473_600)
    }

    /// Reads a (copied) "Login Data" file. Never-save entries, non-web origins and values that won't
    /// open are skipped.
    public static func readLogins(at file: URL, key: Data) throws -> (logins: [ImportedLogin], skipped: Int) {
        let db = try openDatabase(file)
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        var hasLastUsed = true
        if sqlite3_prepare_v2(db, "SELECT origin_url, username_value, password_value, blacklisted_by_user, date_last_used FROM logins", -1, &statement, nil) != SQLITE_OK {
            hasLastUsed = false
            guard sqlite3_prepare_v2(db, "SELECT origin_url, username_value, password_value, blacklisted_by_user FROM logins", -1, &statement, nil) == SQLITE_OK else {
                throw Failure("not a browser login database")
            }
        }
        defer { sqlite3_finalize(statement) }
        var logins: [ImportedLogin] = []
        var skipped = 0
        while sqlite3_step(statement) == SQLITE_ROW {
            let origin = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
            let username = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
            let length = Int(sqlite3_column_bytes(statement, 2))
            let blob = length > 0 ? sqlite3_column_blob(statement, 2).map { Data(bytes: $0, count: length) } ?? Data() : Data()
            if sqlite3_column_int(statement, 3) != 0 { continue }
            guard let site = siteName(origin), !blob.isEmpty, let password = decryptChromium(blob, key: key), !password.isEmpty else {
                skipped += 1
                continue
            }
            let lastUsed = hasLastUsed ? chromiumDate(sqlite3_column_int64(statement, 4)) : nil
            logins.append(ImportedLogin(site: site, username: username, password: password, lastUsedAt: lastUsed))
        }
        return (logins, skipped)
    }

    /// The bare host a login belongs to, or nil when it isn't a website (android://, chrome://, …).
    public static func siteName(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let range = trimmed.range(of: "://") {
            let scheme = trimmed[..<range.lowerBound].lowercased()
            guard scheme == "http" || scheme == "https" else { return nil }
        }
        let host = BrowserSteps.bareHost(trimmed)
        return host.isEmpty ? nil : host
    }

    // MARK: - CSV exports

    /// Splits CSV text into rows (RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes).
    public static func csvRows(_ text: String) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var quoted = false
        var chars = Array(text.unicodeScalars)
        if chars.first == "\u{FEFF}" { chars.removeFirst() }
        var index = 0
        func endRow() {
            row.append(field)
            field = ""
            if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
            row = []
        }
        while index < chars.count {
            let c = chars[index]
            if quoted {
                if c == "\"" {
                    if index + 1 < chars.count, chars[index + 1] == "\"" { field.unicodeScalars.append("\""); index += 1 } else { quoted = false }
                } else {
                    field.unicodeScalars.append(c)
                }
            } else {
                switch c {
                case "\"": quoted = true
                case ",": row.append(field); field = ""
                case "\r":
                    if index + 1 < chars.count, chars[index + 1] == "\n" { index += 1 }
                    endRow()
                case "\n": endRow()
                default: field.unicodeScalars.append(c)
                }
            }
            index += 1
        }
        if !field.isEmpty || !row.isEmpty { endRow() }
        return rows
    }

    /// Logins from a password export: Chrome/Edge/Brave/Arc (name,url,username,password,note), Safari and
    /// Passwords (Title,URL,Username,Password,Notes,OTPAuth), Firefox (url,username,password,…),
    /// Bitwarden (login_uri,login_username,login_password) and 1Password (Title,Url,Username,Password).
    /// Columns are found by their header, in any order and case. Notes and one-time-code seeds are left out.
    public static func parseCSV(_ text: String) throws -> (logins: [ImportedLogin], skipped: Int) {
        let rows = csvRows(text)
        guard let header = rows.first else { throw Failure("that file is empty") }
        let names = header.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        func column(_ candidates: [String]) -> Int? {
            for candidate in candidates { if let i = names.firstIndex(of: candidate) { return i } }
            return nil
        }
        guard let passwordColumn = column(["password", "login_password", "pass", "passwd"]) else {
            throw Failure("that doesn't look like a password export — no “password” column")
        }
        let urlColumn = column(["url", "login_uri", "website", "web site", "uri", "urls", "origin", "origin_url", "hostname", "login url", "site"])
        let nameColumn = column(["name", "title"])
        let userColumn = column(["username", "login_username", "user name", "user", "login", "email", "username/email", "login name"])
        let typeColumn = column(["type"])
        let lastUsedColumn = column(["timelastused"])
        guard urlColumn != nil || nameColumn != nil else { throw Failure("that export has no website column") }

        var logins: [ImportedLogin] = []
        var skipped = 0
        for row in rows.dropFirst() {
            func value(_ i: Int?) -> String {
                guard let i, i < row.count else { return "" }
                return row[i]
            }
            if let typeColumn, !value(typeColumn).isEmpty, value(typeColumn).lowercased() != "login" { continue }
            let password = value(passwordColumn)
            // 1Password and others put several URLs in one cell; the first is the login's.
            let urlText = value(urlColumn).split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " }).first.map(String.init) ?? ""
            let site = siteName(urlText) ?? (urlText.isEmpty ? siteName(value(nameColumn)).flatMap { $0.contains(".") ? $0 : nil } : nil)
            guard let site, !password.isEmpty else { skipped += 1; continue }
            let lastUsed = Double(value(lastUsedColumn)).flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
            logins.append(ImportedLogin(site: site, username: value(userColumn).trimmingCharacters(in: .whitespacesAndNewlines),
                                        password: password, lastUsedAt: lastUsed))
        }
        return (logins, skipped)
    }

    // MARK: - Into the vault

    /// True when `key` opens the logins already in the vault (or there are none), so imports aren't
    /// sealed with a different passphrase than the rest.
    public static func keyOpensVault(_ key: SymmetricKey, logins: [VaultLogin]) -> Bool {
        guard let first = logins.first else { return true }
        return VaultCrypto.open(ciphertext: first.ciphertext, iv: first.iv, key: key) != nil
    }

    /// What to save: new logins, existing ones whose password changed, and counts. Same site
    /// (`BrowserSteps.sameSite`) and same username (any case) is the same login. A vault login edited
    /// after the imported one was last used keeps its password.
    public static func merge(_ incoming: [ImportedLogin], into existing: [VaultLogin], key: SymmetricKey,
                             note: String = "") -> (save: [VaultLogin], imported: Int, updated: Int, skipped: Int) {
        // Several profiles or browsers often hold the same login; the most recently used wins.
        var unique: [ImportedLogin] = []
        var skipped = 0
        for login in incoming {
            let site = BrowserSteps.bareHost(login.site)
            guard !site.isEmpty else { skipped += 1; continue }
            var cleaned = login
            cleaned.site = site
            if let i = unique.firstIndex(where: { $0.site == site && $0.username.lowercased() == login.username.lowercased() }) {
                skipped += 1
                if (login.lastUsedAt ?? .distantPast) > (unique[i].lastUsedAt ?? .distantPast) { unique[i] = cleaned }
            } else {
                unique.append(cleaned)
            }
        }

        var current = existing
        var save: [VaultLogin] = []
        var imported = 0
        var updated = 0
        for login in unique {
            let match = current.firstIndex { BrowserSteps.sameSite($0.site, login.site) && $0.username.lowercased() == login.username.lowercased() }
            if let match {
                let old = current[match]
                if VaultCrypto.open(ciphertext: old.ciphertext, iv: old.iv, key: key) == login.password {
                    skipped += 1
                    continue
                }
                if let used = login.lastUsedAt, used < old.updatedAt { skipped += 1; continue }
                guard let sealed = VaultCrypto.seal(login.password, key: key) else { skipped += 1; continue }
                var next = old
                next.ciphertext = sealed.ciphertext
                next.iv = sealed.iv
                next.keyVersion = 1
                current[match] = next
                save.append(next)
                updated += 1
            } else {
                guard let sealed = VaultCrypto.seal(login.password, key: key) else { skipped += 1; continue }
                let new = VaultLogin(site: login.site, username: login.username, ciphertext: sealed.ciphertext, iv: sealed.iv,
                                     note: note, lastUsedAt: nil)
                current.append(new)
                save.append(new)
                imported += 1
            }
        }
        return (save, imported, updated, skipped)
    }
}
