import CryptoKit
import Foundation
import SQLite3
import XCTest
@testable import OkidokiCore

final class BrowserCookieImportTests: XCTestCase {
    private let key = BrowserPasswordImport.chromiumKey(password: Data("peanuts".utf8))!

    private func micros(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 + 11_644_473_600) * 1_000_000) }

    /// A cookie database shaped like Chromium's (schema version `version`).
    private func makeCookies(version: Int, rows: [(host: String, name: String, value: String, plain: Bool, expires: Date?, partition: String, sameSite: Int32)]) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cookies-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("Cookies")
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        sqlite3_exec(db, "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '\(version)')", nil, nil, nil)
        XCTAssertEqual(sqlite3_exec(db, """
            CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
            expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, is_persistent INTEGER, samesite INTEGER)
            """, nil, nil, nil), SQLITE_OK)
        for row in rows {
            var statement: OpaquePointer?
            sqlite3_prepare_v2(db, "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, '/', ?, 1, 1, ?, ?, ?)", -1, &statement, nil)
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(statement, 1, row.host, -1, transient)
            sqlite3_bind_text(statement, 2, row.partition, -1, transient)
            sqlite3_bind_text(statement, 3, row.name, -1, transient)
            sqlite3_bind_text(statement, 4, row.plain ? row.value : "", -1, transient)
            let blob = row.plain ? Data() : BrowserCookieImport.encrypt(row.value, key: key, domain: row.host, version: version)!
            _ = blob.withUnsafeBytes { sqlite3_bind_blob(statement, 5, $0.baseAddress, Int32(blob.count), transient) }
            sqlite3_bind_int64(statement, 6, row.expires.map(micros) ?? 0)
            sqlite3_bind_int(statement, 7, row.expires == nil ? 0 : 1)
            sqlite3_bind_int(statement, 8, row.expires == nil ? 0 : 1)
            sqlite3_bind_int(statement, 9, row.sameSite)
            XCTAssertEqual(sqlite3_step(statement), SQLITE_DONE)
            sqlite3_finalize(statement)
        }
        return url
    }

    func testReadsLiveCookiesAndSkipsTheRest() throws {
        let later = Date().addingTimeInterval(86_400 * 30)
        let url = try makeCookies(version: 24, rows: [
            (".github.com", "user_session", "abc123", false, later, "", 1),
            ("mail.example.com", "sid", "s3ss10n", false, nil, "", 2),
            ("old.example.com", "gone", "x", false, Date().addingTimeInterval(-60), "", -1),
            (".embed.com", "chips", "x", false, later, "https://news.com", -1),
            ("plain.com", "pref", "dark", true, later, "", 0),
        ])
        let result = try BrowserCookieImport.readCookies(at: url, key: key)
        XCTAssertEqual(result.skipped, 2)
        XCTAssertEqual(result.cookies.map(\.name), ["user_session", "sid", "pref"])
        let github = result.cookies[0]
        XCTAssertEqual(github.value, "abc123")
        XCTAssertEqual(github.sameSite, "lax")
        XCTAssertEqual(github.site, "github.com")
        XCTAssertNotNil(github.expires)
        XCTAssertNil(result.cookies[1].expires, "a session cookie stays a session cookie")
        XCTAssertEqual(result.cookies[1].sameSite, "strict")

        let cookie = try XCTUnwrap(github.httpCookie())
        XCTAssertEqual(cookie.domain, ".github.com")
        XCTAssertTrue(cookie.isSecure)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertEqual(cookie.sameSitePolicy, .sameSiteLax)
        XCTAssertTrue(try XCTUnwrap(result.cookies[1].httpCookie()).isSessionOnly)
    }

    func testOlderDatabasesHaveNoDomainPrefix() throws {
        let url = try makeCookies(version: 20, rows: [("a.com", "n", "value-without-prefix", false, Date().addingTimeInterval(3600), "", -1)])
        XCTAssertEqual(try BrowserCookieImport.readCookies(at: url, key: key).cookies.first?.value, "value-without-prefix")
    }

    func testAWrongKeyOrForeignDomainOpensNothing() throws {
        let url = try makeCookies(version: 24, rows: [("a.com", "n", "v", false, Date().addingTimeInterval(3600), "", -1)])
        let wrong = BrowserPasswordImport.chromiumKey(password: Data("nope".utf8))!
        XCTAssertEqual(try BrowserCookieImport.readCookies(at: url, key: wrong).cookies.count, 0)
        let blob = BrowserCookieImport.encrypt("v", key: key, domain: "a.com", version: 24)!
        XCTAssertNil(BrowserCookieImport.decrypt(blob, key: key, domain: "b.com", version: 24), "the domain hash must match")
    }

    func testFindsCookieFilesInEachProfile() throws {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("support-\(UUID().uuidString)")
        let browser = ChromiumBrowser(id: "x", name: "X", folder: "X/User Data", keychainServices: [])
        for (profile, file) in [("Default", "Network/Cookies"), ("Profile 1", "Cookies")] {
            let path = support.appendingPathComponent("X/User Data/\(profile)/\(file)")
            try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: path.path, contents: Data())
        }
        let files = try BrowserCookieImport.cookieFiles(of: browser, support: support)
        XCTAssertEqual(files.map(\.file.lastPathComponent), ["Cookies", "Cookies"])
        XCTAssertEqual(files.count, 2)
    }
}
