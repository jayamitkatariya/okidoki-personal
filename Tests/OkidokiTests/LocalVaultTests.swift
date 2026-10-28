import XCTest
@testable import OkidokiCore

@MainActor
final class LocalVaultTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-vault-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    /// The listing is made off the main thread and lands on it; give it a few seconds.
    private func waitForListing(_ vault: LocalVault, count: Int) async {
        let deadline = Date().addingTimeInterval(5)
        while vault.files.count != count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
            await Task.yield()
        }
    }

    func testFilesLandInTheFolderAndAreListed() async throws {
        let vault = LocalVault(folder: root.appendingPathComponent("Vault"), storeURL: root.appendingPathComponent("vault.json"))
        vault.start()
        let first = try vault.add(data: Data("%PDF-1.7 hello".utf8), name: "W-9.pdf", folder: "taxes")
        XCTAssertFalse(first.replaced)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("Vault/taxes/W-9.pdf").path))
        await waitForListing(vault, count: 1)
        XCTAssertEqual(vault.files.map(\.id), ["taxes/W-9.pdf"])
        XCTAssertEqual(vault.files.first?.folder, "taxes")
        XCTAssertEqual(vault.files.first?.mime, "application/pdf")
        XCTAssertEqual(vault.search("w-9").map(\.id), ["taxes/W-9.pdf"])

        // The newer copy of the same document replaces the older one.
        let second = try vault.add(data: Data("%PDF-1.7 newer".utf8), name: "W-9.pdf", folder: "Taxes")
        XCTAssertTrue(second.replaced)
    }

    func testNamesCannotLeaveTheVault() throws {
        let vault = LocalVault(folder: root.appendingPathComponent("Vault"), storeURL: root.appendingPathComponent("vault.json"))
        vault.start()
        XCTAssertThrowsError(try vault.add(data: Data("x".utf8), name: "a.txt", folder: "../outside"))
        let saved = try vault.add(data: Data("x".utf8), name: "../../escape.txt")
        XCTAssertEqual(saved.url.deletingLastPathComponent().standardizedFileURL, root.appendingPathComponent("Vault").standardizedFileURL)
        XCTAssertNil(vault.url(for: "../vault.json"))
    }

    func testLoginsKeepOnlyTheSealedBoxAndSurviveARelaunch() throws {
        let store = root.appendingPathComponent("vault.json")
        let vault = LocalVault(folder: root.appendingPathComponent("Vault"), storeURL: store)
        let login = try XCTUnwrap(VaultLogin(panel: ["site": "stripe.com", "username": "me@x.com", "ciphertext": "c2VhbGVk", "iv": "aXY="]))
        vault.saveLogin(login)
        vault.touchLogin(id: login.id)

        let again = LocalVault(folder: root.appendingPathComponent("Vault"), storeURL: store)
        XCTAssertEqual(again.salt, vault.salt)
        XCTAssertEqual(again.logins.map(\.site), ["stripe.com"])
        XCTAssertNotNil(again.logins.first?.lastUsedAt)
        let attributes = try FileManager.default.attributesOfItem(atPath: store.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        again.deleteLogin(id: login.id)
        XCTAssertTrue(LocalVault(folder: root, storeURL: store).logins.isEmpty)
        XCTAssertNil(VaultLogin(panel: ["site": "no password"]))
    }
}
