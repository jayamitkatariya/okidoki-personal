import XCTest
@testable import OkidokiCore

/// The new shell's data: pins, seen marks and its settings, saved and loaded back.
final class ShellStoreTests: XCTestCase {
    private func withStore(_ body: @MainActor (OkidokiStore, URL) throws -> Void) async throws {
        try await MainActor.run {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let url = directory.appendingPathComponent("state.json")
            defer { try? FileManager.default.removeItem(at: directory) }
            try body(OkidokiStore(stateURL: url), url)
        }
    }

    func testSettingsDefaultsKeepTheShakeAndHotkey() throws {
        // Older saved settings carry "newShell"; it's ignored now that the shell is the only look.
        let decoded = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"newShell": false}"#.utf8))
        XCTAssertTrue(decoded.shakeToSummon)
        XCTAssertEqual(decoded.summonHotkey, "option+space")
    }

    func testReorderWithRepeatedIDsNeverDuplicatesPins() async throws {
        try await withStore { store, _ in
            store.seedPinsIfNeeded(loginSites: [])
            let ids = (store.pins ?? []).map(\.id)
            store.reorderPins([ids[1], ids[1], ids[0], ids[1]])
            let after = (store.pins ?? []).map(\.id)
            XCTAssertEqual(after.count, ids.count)
            XCTAssertEqual(Set(after), Set(ids))
            XCTAssertEqual(Array(after.prefix(2)), [ids[1], ids[0]])
        }
    }

    func testPinsSeedOnceDedupeByHostAndReorder() async throws {
        try await withStore { store, url in
            XCTAssertNil(store.pins)
            store.seedPinsIfNeeded(loginSites: ["github.com", "https://www.github.com/login", "chase.com"])
            let seeded = store.pins ?? []
            XCTAssertEqual(seeded.first?.host, "github.com")
            XCTAssertEqual(seeded.filter { $0.host == "github.com" }.count, 1)
            XCTAssertEqual(seeded.count, 6)
            // Seeding again never replaces what the person arranged.
            store.unpin(seeded[0].id)
            store.seedPinsIfNeeded(loginSites: ["github.com"])
            XCTAssertEqual(store.pins?.count, 5)

            XCTAssertTrue(store.pin(url: "https://www.figma.com/files", title: "Figma"))
            XCTAssertTrue(store.pin(url: "https://figma.com", title: "Figma again"))
            XCTAssertEqual(store.pins?.filter { $0.host == "figma.com" }.count, 1)

            let ids = (store.pins ?? []).map(\.id)
            store.reorderPins([ids.last!])
            XCTAssertEqual(store.pins?.first?.host, "figma.com")
            XCTAssertEqual(store.pins?.count, ids.count)

            store.saveNow()
            let loaded = OkidokiStore(stateURL: url)
            XCTAssertEqual(loaded.pins?.map(\.id), store.pins?.map(\.id))
        }
    }

    func testPinsStopAtTheLimit() async throws {
        try await withStore { store, _ in
            store.pins = []
            for n in 0..<OkidokiStore.maxPins { XCTAssertTrue(store.pin(url: "https://site\(n).com", title: "")) }
            XCTAssertFalse(store.pin(url: "https://one-too-many.com", title: ""))
        }
    }

    func testPinAtIndexAndBlankURLs() async throws {
        try await withStore { store, url in
            store.pins = []
            XCTAssertTrue(store.pin(url: "https://a.com", title: "A"))
            XCTAssertTrue(store.pin(url: "https://b.com", title: "B"))
            XCTAssertTrue(store.pin(url: "https://c.com", title: "C", at: 1))
            XCTAssertEqual(store.pins?.map(\.host), ["a.com", "c.com", "b.com"])
            XCTAssertTrue(store.pin(url: "https://d.com", title: "D", at: 99))
            XCTAssertEqual(store.pins?.last?.host, "d.com")
            XCTAssertFalse(store.pin(url: "", title: ""))
            XCTAssertEqual(store.pins?.count, 4)
            store.saveNow()
            XCTAssertEqual(OkidokiStore(stateURL: url).pins?.map(\.host), ["a.com", "c.com", "b.com", "d.com"])
        }
    }

    func testMarkSeenStampsThreadAndRun() async throws {
        try await withStore { store, _ in
            let thread = store.createThread(title: "t", app: "okidoki", topic: "")
            let run = store.createRun(kind: .answer, title: "r", prompt: "r", threadID: thread.id, status: .done)
            XCTAssertNil(store.thread(thread.id)?.seenAt)
            store.markSeen(threadID: thread.id, runID: run.id)
            XCTAssertNotNil(store.thread(thread.id)?.seenAt)
            XCTAssertNotNil(store.run(run.id)?.seenAt)
        }
    }
}
