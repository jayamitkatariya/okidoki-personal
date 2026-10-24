import Foundation
import XCTest
@testable import OkidokiCore

final class KeyStoreTests: XCTestCase {
    func testFreshInstallUsesOnlyThePrivateKeyFile() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let file = folder.appendingPathComponent("keys.json")
        let previous = ProcessInfo.processInfo.environment["OKIDOKI_KEYS_FILE"]
        setenv("OKIDOKI_KEYS_FILE", file.path, 1)
        defer {
            KeyStore.delete("test-provider")
            KeyStore.delete("test-connector")
            if let previous { setenv("OKIDOKI_KEYS_FILE", previous, 1) }
            else { unsetenv("OKIDOKI_KEYS_FILE") }
            try? FileManager.default.removeItem(at: folder)
        }

        XCTAssertFalse(KeyStore.has("test-provider"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "Reading a missing key file starts empty without migration")

        KeyStore.set("first-fixture", for: "test-provider")
        KeyStore.set("connector-fixture", for: "test-connector")
        KeyStore.set("updated-fixture", for: "test-provider")
        var saved = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
        XCTAssertEqual(saved["test-provider"], "updated-fixture")
        XCTAssertEqual(saved["test-connector"], "connector-fixture")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        KeyStore.delete("test-provider")
        XCTAssertFalse(KeyStore.has("test-provider"))
        saved = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
        XCTAssertNil(saved["test-provider"])
        XCTAssertEqual(saved["test-connector"], "connector-fixture")
    }
}
