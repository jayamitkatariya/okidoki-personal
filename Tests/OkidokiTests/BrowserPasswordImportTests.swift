import CryptoKit
import SQLite3
import XCTest
@testable import OkidokiCore

final class BrowserPasswordImportTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-pwimport-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    // MARK: CSV

    func testCSVRowsHandleQuotesCommasAndNewlines() {
        let text = "\u{FEFF}a,b,c\r\n\"x, y\",\"he said \"\"hi\"\"\",\"two\nlines\"\n\nlast,,\n"
        let rows = BrowserPasswordImport.csvRows(text)
        XCTAssertEqual(rows, [["a", "b", "c"], ["x, y", "he said \"hi\"", "two\nlines"], ["last", "", ""]])
    }

    func testChromeExport() throws {
        let csv = """
        name,url,username,password,note
        github.com,https://github.com/session,octo@example.com,"p,ass""word",
        app,android://hash@com.example.app/,me,secret,
        nopass.com,https://nopass.com/,me,,
        """
        let result = try BrowserPasswordImport.parseCSV(csv)
        XCTAssertEqual(result.logins, [ImportedLogin(site: "github.com", username: "octo@example.com", password: "p,ass\"word")])
        XCTAssertEqual(result.skipped, 2)
    }

    func testSafariPasswordsExportLeavesOutCodesAndNotes() throws {
        let csv = """
        Title,URL,Username,Password,Notes,OTPAuth
        Bank (me),https://www.bank.example/login,me@example.com,hunter2,"PIN is 1234",otpauth://totp/x?secret=ABC
        """
        let result = try BrowserPasswordImport.parseCSV(csv)
        XCTAssertEqual(result.logins.count, 1)
        XCTAssertEqual(result.logins[0].site, "bank.example")
        XCTAssertEqual(result.logins[0].password, "hunter2")
    }

    func testFirefoxExportKeepsLastUsed() throws {
        let csv = """
        "url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"
        "https://accounts.example.org","fox","pw1",,"https://accounts.example.org","{1}","1700000000000","1700000500000","1700000000000"
        "chrome://FirefoxAccounts","x","y",,,"{2}","1","1","1"
        """
        let result = try BrowserPasswordImport.parseCSV(csv)
        XCTAssertEqual(result.logins.count, 1)
        XCTAssertEqual(result.logins[0].site, "accounts.example.org")
        XCTAssertEqual(result.logins[0].lastUsedAt, Date(timeIntervalSince1970: 1_700_000_500))
        XCTAssertEqual(result.skipped, 1)
    }

    func testBitwardenExportSkipsNonLogins() throws {
        let csv = """
        folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
        ,,login,Shop,,,0,https://shop.example.com,buyer,pw,
        ,,note,Secret note,very secret,,0,,,,
        """
        let result = try BrowserPasswordImport.parseCSV(csv)
        XCTAssertEqual(result.logins, [ImportedLogin(site: "shop.example.com", username: "buyer", password: "pw")])
    }

    func testOnePasswordExportWithSeveralURLs() throws {
        let csv = "Title,Url,Username,Password\nMail,\"https://mail.example.com https://other.example.com\",me,pw\n"
        let result = try BrowserPasswordImport.parseCSV(csv)
        XCTAssertEqual(result.logins.first?.site, "mail.example.com")
    }

    func testCSVWithoutPasswordColumnIsRefused() {
        XCTAssertThrowsError(try BrowserPasswordImport.parseCSV("name,url\nx,https://x.com\n"))
    }

    // MARK: Chromium

    func testChromiumValueRoundTripAndWrongKey() throws {
        let key = try XCTUnwrap(BrowserPasswordImport.chromiumKey(password: Data("peanuts".utf8)))
        XCTAssertEqual(key.count, 16)
        let sealed = try XCTUnwrap(BrowserPasswordImport.encryptChromium("s3cret!", key: key))
        XCTAssertEqual(sealed.prefix(3), Data("v10".utf8))
        XCTAssertEqual(BrowserPasswordImport.decryptChromium(sealed, key: key), "s3cret!")
        let other = try XCTUnwrap(BrowserPasswordImport.chromiumKey(password: Data("other".utf8)))
        XCTAssertNotEqual(BrowserPasswordImport.decryptChromium(sealed, key: other), "s3cret!")
        XCTAssertNil(BrowserPasswordImport.decryptChromium(Data("plain".utf8), key: key))
    }

    /// Checked against Python's hashlib and OpenSSL: PBKDF2-SHA1("peanuts", "saltysalt", 1003, 16), then
    /// AES-128-CBC with an IV of 16 spaces.
    func testChromiumKeyAndCipherMatchReferenceImplementations() throws {
        let key = try XCTUnwrap(BrowserPasswordImport.chromiumKey(password: Data("peanuts".utf8)))
        XCTAssertEqual(key.map { String(format: "%02x", $0) }.joined(), "d9a09d499b4e1b7461f28e67972c6dbd")
        let value = Data("v10".utf8) + Data(base64Encoded: "46c0yTjqsaNE5d38nMYcxw==")!
        XCTAssertEqual(BrowserPasswordImport.decryptChromium(value, key: key), "hello world")
    }

    private func makeLoginData(at url: URL, key: Data, rows: [(origin: String, user: String, password: String?, never: Bool, lastUsed: Int64)]) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER, date_last_used INTEGER)", nil, nil, nil), SQLITE_OK)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for row in rows {
            var statement: OpaquePointer?
            XCTAssertEqual(sqlite3_prepare_v2(db, "INSERT INTO logins VALUES (?, ?, ?, ?, ?)", -1, &statement, nil), SQLITE_OK)
            sqlite3_bind_text(statement, 1, row.origin, -1, transient)
            sqlite3_bind_text(statement, 2, row.user, -1, transient)
            let blob = row.password.flatMap { BrowserPasswordImport.encryptChromium($0, key: key) } ?? Data()
            _ = blob.withUnsafeBytes { sqlite3_bind_blob(statement, 3, $0.baseAddress, Int32(blob.count), transient) }
            sqlite3_bind_int(statement, 4, row.never ? 1 : 0)
            sqlite3_bind_int64(statement, 5, row.lastUsed)
            XCTAssertEqual(sqlite3_step(statement), SQLITE_DONE)
            sqlite3_finalize(statement)
        }
    }

    func testSyntheticLoginDataIsReadThroughACopy() throws {
        let key = try XCTUnwrap(BrowserPasswordImport.chromiumKey(password: Data("keychain-secret".utf8)))
        // A browser folder the way Dia lays it out, with a named profile.
        let browser = try XCTUnwrap(BrowserPasswordImport.browser(id: "dia"))
        let userData = root.appendingPathComponent(browser.folder, isDirectory: true)
        try FileManager.default.createDirectory(at: userData.appendingPathComponent("Default"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: userData.appendingPathComponent("Profile 1"), withIntermediateDirectories: true)
        try Data(#"{"profile":{"info_cache":{"Profile 1":{"name":"Work"}}}}"#.utf8).write(to: userData.appendingPathComponent("Local State"))
        // 2026-01-01 in Chromium time.
        let micros: Int64 = (1_767_225_600 + 11_644_473_600) * 1_000_000
        try makeLoginData(at: userData.appendingPathComponent("Default/Login Data"), key: key, rows: [
            ("https://www.github.com/login", "octo", "pw-1", false, micros),
            ("https://never.example/", "x", "nope", true, 0),
            ("android://abc@com.app/", "y", "z", false, 0),
        ])
        try makeLoginData(at: userData.appendingPathComponent("Profile 1/Login Data"), key: key, rows: [
            ("https://work.example.com/", "me@work", "pw-2", false, 0),
        ])

        let profiles = try XCTUnwrap(try BrowserPasswordImport.profiles(of: browser, support: root))
        XCTAssertEqual(profiles.map(\.name), ["Default", "Work"])

        let detected = BrowserPasswordImport.detect(support: root)
        XCTAssertEqual(detected.map(\.id), ["dia"])
        XCTAssertEqual(detected.first?.logins, 3)

        let first = try BrowserPasswordImport.withCopy(of: profiles[0].loginData) { try BrowserPasswordImport.readLogins(at: $0, key: key) }
        XCTAssertEqual(first.logins, [ImportedLogin(site: "github.com", username: "octo", password: "pw-1",
                                                    lastUsedAt: Date(timeIntervalSince1970: 1_767_225_600))])
        XCTAssertEqual(first.skipped, 1)
        // Nothing is left behind in the temporary folder.
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)
            .filter { $0.hasPrefix("okidoki-import-") }
        XCTAssertTrue(leftovers.isEmpty)
    }

    func testMissingBrowserIsNotDetected() throws {
        XCTAssertNil(try BrowserPasswordImport.profiles(of: BrowserPasswordImport.browsers[0], support: root))
        XCTAssertTrue(BrowserPasswordImport.detect(support: root).isEmpty)
    }

    // MARK: Merge

    func testMergeAddsUpdatesAndSkips() throws {
        let key = try XCTUnwrap(VaultCrypto.key(passphrase: "vault pass", vaultID: "salt-1"))
        func login(_ site: String, _ user: String, _ password: String, updated: Date = Date(timeIntervalSince1970: 1_000)) throws -> VaultLogin {
            let sealed = try XCTUnwrap(VaultCrypto.seal(password, key: key))
            return VaultLogin(site: site, username: user, ciphertext: sealed.ciphertext, iv: sealed.iv, updatedAt: updated)
        }
        let existing = [
            try login("github.com", "octo", "same"),
            try login("bank.example", "me", "old"),
            try login("fresh.example", "me", "kept", updated: Date(timeIntervalSince1970: 2_000_000_000)),
        ]
        let incoming = [
            ImportedLogin(site: "https://github.com/login", username: "OCTO", password: "same"),
            ImportedLogin(site: "www.bank.example", username: "me", password: "new"),
            ImportedLogin(site: "fresh.example", username: "me", password: "stale", lastUsedAt: Date(timeIntervalSince1970: 1_000)),
            ImportedLogin(site: "shop.example", username: "a", password: "1", lastUsedAt: Date(timeIntervalSince1970: 10)),
            ImportedLogin(site: "shop.example", username: "a", password: "2", lastUsedAt: Date(timeIntervalSince1970: 20)),
        ]
        let result = BrowserPasswordImport.merge(incoming, into: existing, key: key)
        XCTAssertEqual(result.imported, 1)
        XCTAssertEqual(result.updated, 1)
        XCTAssertEqual(result.skipped, 3)
        XCTAssertEqual(result.save.count, 2)

        let bank = try XCTUnwrap(result.save.first { $0.site == "bank.example" })
        XCTAssertEqual(bank.id, existing[1].id)
        XCTAssertEqual(VaultCrypto.open(ciphertext: bank.ciphertext, iv: bank.iv, key: key), "new")
        let shop = try XCTUnwrap(result.save.first { $0.site == "shop.example" })
        XCTAssertEqual(VaultCrypto.open(ciphertext: shop.ciphertext, iv: shop.iv, key: key), "2")
    }

    func testWrongPassphraseIsCaughtBeforeImporting() throws {
        let key = try XCTUnwrap(VaultCrypto.key(passphrase: "right", vaultID: "s"))
        let sealed = try XCTUnwrap(VaultCrypto.seal("pw", key: key))
        let vault = [VaultLogin(site: "a.com", username: "", ciphertext: sealed.ciphertext, iv: sealed.iv)]
        XCTAssertTrue(BrowserPasswordImport.keyOpensVault(key, logins: vault))
        XCTAssertFalse(BrowserPasswordImport.keyOpensVault(try XCTUnwrap(VaultCrypto.key(passphrase: "wrong", vaultID: "s")), logins: vault))
        XCTAssertTrue(BrowserPasswordImport.keyOpensVault(key, logins: []))
    }
}
