import CryptoKit
import Foundation
import SQLite3

/// One cookie read from another browser. Its value lives only in memory, on its way into okidoki's
/// browser profile.
public struct ImportedCookie: Equatable, Sendable {
    public var domain: String
    public var name: String
    public var value: String
    public var path: String
    /// Nil for a session cookie.
    public var expires: Date?
    public var secure: Bool
    public var httpOnly: Bool
    /// "lax", "strict", or nil (none or unspecified).
    public var sameSite: String?

    public init(domain: String, name: String, value: String, path: String, expires: Date?, secure: Bool, httpOnly: Bool, sameSite: String?) {
        self.domain = domain; self.name = name; self.value = value; self.path = path
        self.expires = expires; self.secure = secure; self.httpOnly = httpOnly; self.sameSite = sameSite
    }

    /// As Foundation takes it, for WebKit's cookie store. Nil when it isn't a valid cookie.
    public func httpCookie() -> HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: domain, .name: name, .value: value, .path: path.isEmpty ? "/" : path,
        ]
        if let expires { properties[.expires] = expires } else { properties[.discard] = "TRUE" }
        if secure { properties[.secure] = "TRUE" }
        if httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        if let sameSite { properties[.sameSitePolicy] = sameSite }
        return HTTPCookie(properties: properties)
    }

    /// The site it belongs to, for counting ("google.com" for ".accounts.google.com").
    public var site: String {
        let host = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
        let parts = host.split(separator: ".")
        return parts.count > 2 ? parts.suffix(2).joined(separator: ".") : host
    }
}

/// Bringing sign-ins over from Chromium-family browsers: their cookies, opened with the same Safe
/// Storage key as their passwords, go into okidoki's own browser profile, so sites (and the agent)
/// are already signed in. Nothing is written anywhere else.
public enum BrowserCookieImport {
    /// A profile's cookie database: "Network/Cookies" in current Chromium, "Cookies" in older ones.
    public static func cookieFiles(of browser: ChromiumBrowser, support: URL = BrowserPasswordImport.applicationSupport,
                                   fileManager: FileManager = .default) throws -> [(profile: String, file: URL)] {
        let root = support.appendingPathComponent(browser.folder, isDirectory: true)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { return [] }
        let names: [String]
        do {
            names = try fileManager.contentsOfDirectory(atPath: root.path)
        } catch {
            if BrowserPasswordImport.isPermissionError(error) { throw BrowserPasswordImport.Failure(BrowserPasswordImport.blockedHint) }
            throw BrowserPasswordImport.Failure("couldn't read its folder: \(error.localizedDescription)")
        }
        let display = BrowserPasswordImport.profileNames(root.appendingPathComponent("Local State"))
        var folders = names.filter { $0 == "Default" || $0.hasPrefix("Profile ") }.sorted()
        // Opera keeps its one profile in the root.
        folders.insert("", at: 0)
        var found: [(String, URL)] = []
        for folder in folders {
            let base = folder.isEmpty ? root : root.appendingPathComponent(folder, isDirectory: true)
            for candidate in ["Network/Cookies", "Cookies"] {
                let file = base.appendingPathComponent(candidate)
                if fileManager.fileExists(atPath: file.path) {
                    found.append((folder.isEmpty ? "Default" : (display[folder] ?? folder), file))
                    break
                }
            }
        }
        return found
    }

    /// Every live cookie in every profile of `browser`. macOS asks the person before handing over the key.
    /// When a cookie is in several profiles, the first profile's copy wins.
    public static func read(_ browser: ChromiumBrowser, support: URL = BrowserPasswordImport.applicationSupport,
                            now: Date = Date()) throws -> (cookies: [ImportedCookie], skipped: Int, errors: [String]) {
        let files = try cookieFiles(of: browser, support: support)
        guard !files.isEmpty else { throw BrowserPasswordImport.Failure("\(browser.name) has no sign-ins on this Mac") }
        let password = try BrowserPasswordImport.safeStoragePassword(services: browser.keychainServices, browser: browser.name)
        guard let key = BrowserPasswordImport.chromiumKey(password: password) else {
            throw BrowserPasswordImport.Failure("couldn't derive \(browser.name)'s key")
        }
        var cookies: [ImportedCookie] = []
        var seen = Set<String>()
        var skipped = 0
        var errors: [String] = []
        for (profile, file) in files {
            do {
                let result = try BrowserPasswordImport.withCopy(of: file) { try readCookies(at: $0, key: key, now: now) }
                skipped += result.skipped
                for cookie in result.cookies where seen.insert("\(cookie.domain)|\(cookie.path)|\(cookie.name)").inserted {
                    cookies.append(cookie)
                }
            } catch {
                let reason = BrowserPasswordImport.isPermissionError(error) ? BrowserPasswordImport.blockedHint
                    : ((error as? BrowserPasswordImport.Failure)?.reason ?? error.localizedDescription)
                errors.append("\(browser.name) · \(profile): \(reason)")
            }
        }
        return (cookies, skipped, errors)
    }

    /// Reads a (copied) cookie database. Expired cookies, partitioned ones (they belong to one embedding
    /// site, which WebKit keeps differently) and values that won't open are skipped.
    public static func readCookies(at file: URL, key: Data, now: Date = Date()) throws -> (cookies: [ImportedCookie], skipped: Int) {
        var db: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db)
            throw BrowserPasswordImport.Failure("couldn't open the cookie database")
        }
        defer { sqlite3_close(db) }
        // From version 24 each decrypted value starts with the SHA-256 of its domain.
        let version = scalar(db, "SELECT value FROM meta WHERE key = 'version'").flatMap(Int.init) ?? 0
        let columns = Set(tableColumns(db, "cookies"))
        guard columns.contains("host_key"), columns.contains("encrypted_value") else {
            throw BrowserPasswordImport.Failure("not a browser cookie database")
        }
        let persistent = columns.contains("is_persistent") ? "is_persistent" : (columns.contains("has_expires") ? "has_expires" : "1")
        let sameSite = columns.contains("samesite") ? "samesite" : "-1"
        let partition = columns.contains("top_frame_site_key") ? "top_frame_site_key" : "''"
        let sql = """
            SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, \(persistent), \(sameSite), \(partition)
            FROM cookies
            """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw BrowserPasswordImport.Failure("not a browser cookie database")
        }
        defer { sqlite3_finalize(statement) }
        var cookies: [ImportedCookie] = []
        var skipped = 0
        while sqlite3_step(statement) == SQLITE_ROW {
            let domain = text(statement, 0)
            let name = text(statement, 1)
            let partitionKey = text(statement, 10)
            guard !domain.isEmpty, partitionKey.isEmpty else { skipped += 1; continue }
            let isPersistent = sqlite3_column_int(statement, 8) != 0
            let expires = isPersistent ? BrowserPasswordImport.chromiumDate(sqlite3_column_int64(statement, 5)) : nil
            if let expires, expires <= now { skipped += 1; continue }
            var value = text(statement, 2)
            if value.isEmpty {
                let length = Int(sqlite3_column_bytes(statement, 3))
                let blob = length > 0 ? sqlite3_column_blob(statement, 3).map { Data(bytes: $0, count: length) } ?? Data() : Data()
                guard let opened = decrypt(blob, key: key, domain: domain, version: version) else { skipped += 1; continue }
                value = opened
            }
            let policy: String? = switch sqlite3_column_int(statement, 9) {
            case 1: "lax"
            case 2: "strict"
            default: nil
            }
            cookies.append(ImportedCookie(domain: domain, name: name, value: value, path: text(statement, 4),
                                          expires: expires, secure: sqlite3_column_int(statement, 6) != 0,
                                          httpOnly: sqlite3_column_int(statement, 7) != 0, sameSite: policy))
        }
        return (cookies, skipped)
    }

    /// A "v10" cookie value. From database version 24 the first 32 bytes are SHA-256(domain): checked and dropped.
    public static func decrypt(_ blob: Data, key: Data, domain: String, version: Int) -> String? {
        guard let plain = BrowserPasswordImport.decryptChromiumData(blob, key: key) else { return nil }
        var bytes = plain
        if version >= 24 {
            guard bytes.count >= 32 else { return nil }
            let digest = Data(SHA256.hash(data: Data(domain.utf8)))
            guard bytes.prefix(32) == digest else { return nil }
            bytes = bytes.dropFirst(32)
        }
        return String(data: Data(bytes), encoding: .utf8)
    }

    /// The other direction, for tests that build a synthetic cookie database.
    public static func encrypt(_ value: String, key: Data, domain: String, version: Int) -> Data? {
        let prefix = version >= 24 ? Data(SHA256.hash(data: Data(domain.utf8))) : Data()
        return BrowserPasswordImport.encryptChromiumData(prefix + Data(value.utf8), key: key)
    }

    private static func text(_ statement: OpaquePointer?, _ column: Int32) -> String {
        sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
    }

    private static func scalar(_ db: OpaquePointer?, _ sql: String) -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return sqlite3_column_text(statement, 0).map { String(cString: $0) }
    }

    private static func tableColumns(_ db: OpaquePointer?, _ table: String) -> [String] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &statement, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(statement) }
        var names: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW { names.append(text(statement, 1)) }
        return names
    }
}
