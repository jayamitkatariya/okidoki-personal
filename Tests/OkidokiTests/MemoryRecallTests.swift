import XCTest
@testable import OkidokiCore

/// Which notes go with a request: the ones it needs, even among thousands and without a Moss key.
@MainActor
final class MemoryRecallTests: XCTestCase {
    private func freshStore() -> (OkidokiStore, URL) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("state.json")
        let store = OkidokiStore(stateURL: url)
        if store.accounts.isEmpty { store.createAccount(name: "test", email: "", kind: .personal) }
        return (store, url)
    }

    /// Notes added oldest first, so the filler is newer than the facts the requests need.
    private func storeWithFiller(_ facts: [String], filler: Int) -> OkidokiStore {
        let (store, _) = freshStore()
        let base = Date().addingTimeInterval(-86_400 * 30)
        for (n, fact) in facts.enumerated() {
            store.memories.append(MemoryItem(accountID: store.currentAccountID, section: .aboutYou, text: fact,
                                             createdAt: base.addingTimeInterval(Double(n)), updatedAt: base.addingTimeInterval(Double(n))))
        }
        for n in 0..<filler {
            let at = base.addingTimeInterval(1_000 + Double(n))
            store.memories.append(MemoryItem(accountID: store.currentAccountID, section: .aboutYou,
                                             text: "Filler preference number \(n) about weekend gardening and tea \(n)",
                                             createdAt: at, updatedAt: at))
        }
        return store
    }

    func testOldFactReachesThePromptPastNewerNotes() {
        let store = storeWithFiller(["My passport number is in the vault file passport.pdf",
                                     "I prefer aisle seats", "My manager is Priya"], filler: 60)
        XCTAssertTrue(store.memoryLines(query: "where is my passport?").contains { $0.contains("passport.pdf") })
        XCTAssertTrue(store.memoryLines(query: "book me a seat on the flight to Delhi").contains { $0.contains("aisle seats") },
                      "plural/singular fold: seat matches seats")
        XCTAssertTrue(store.memoryLines(query: "email my boss the report").contains { $0.contains("Priya") },
                      "boss and manager count as one word")
        // Without a query only the newest are sent, so the old facts aren't there.
        XCTAssertFalse(store.memoryLines().contains { $0.contains("passport.pdf") })
        XCTAssertEqual(store.memoryLines(query: "passport").count, 24, "the limit still holds; matches come first, newest fill the rest")
        XCTAssertTrue(store.memoryLines(query: "passport")[0].contains("passport.pdf"))
    }

    func testPinnedAndRightNowAlwaysGo() {
        let store = storeWithFiller(["Always reply in British English"], filler: 40)
        let pinned = store.memories.first { $0.text.hasPrefix("Always reply") }!
        XCTAssertFalse(store.memoryLines(query: "what's the weather").contains { $0.contains("British") })
        store.setMemoryPinned(pinned.id, true)
        XCTAssertTrue(store.memoryLines(query: "what's the weather")[0].contains("British"), "pinned notes lead every request")
        store.addMemory("Shipping the onboarding flow this week", section: .rightNow)
        XCTAssertTrue(store.memoryLines(query: "what's the weather").contains { $0 == "right now: Shipping the onboarding flow this week" })
        store.setMemoryPinned(pinned.id, false)
        XCTAssertNil(store.memories.first { $0.id == pinned.id }?.pinned)
    }

    func testEditAndDeleteShowUpInRecallAtOnce() {
        let (store, _) = freshStore()
        let item = store.addMemory("I prefer aisle seats")!
        XCTAssertTrue(store.memoryLines(query: "seat").contains("about you: I prefer aisle seats"))
        store.updateMemory(item.id, text: "  I prefer window seats  ")
        let lines = store.memoryLines(query: "seat")
        XCTAssertTrue(lines.contains("about you: I prefer window seats"), "the edit is trimmed and recalled")
        XCTAssertFalse(lines.contains { $0.contains("aisle") }, "the old text is gone")
        store.updateMemory(item.id, text: "   ")
        XCTAssertEqual(store.memories.first?.text, "I prefer window seats", "an empty edit doesn't blank a memory")
        store.deleteMemory(item.id)
        XCTAssertTrue(store.memoryLines(query: "seat").isEmpty)
        XCTAssertTrue(MemoryIndexPayload(store: store).memories.isEmpty, "a deleted note isn't sent to the index either")
    }

    func testOtherAccountsNotesStayOut() {
        let (store, _) = freshStore()
        store.addMemory("My manager is Priya")
        let first = store.currentAccountID
        store.createAccount(name: "work", email: "", kind: .work)
        store.addMemory("My manager is Sam")
        XCTAssertEqual(store.memoryLines(query: "manager"), ["about you: My manager is Sam"])
        store.switchAccount(first)
        XCTAssertEqual(store.memoryLines(query: "manager"), ["about you: My manager is Priya"])
    }

    func testUnicodeAndAccents() {
        let (store, _) = freshStore()
        store.addMemory("Mi café favorito es Café Tacuba en São Paulo")
        store.addMemory("我的护照在保险箱里")
        store.addMemory("Мой врач — доктор Иванов")
        store.addMemory("Filler note about something else entirely")
        XCTAssertEqual(store.memoryLines(limit: 1, query: "cafe sao paulo").first, "about you: Mi café favorito es Café Tacuba en São Paulo")
        XCTAssertEqual(store.memoryLines(limit: 1, query: "护照在哪里").first, "about you: 我的护照在保险箱里", "Chinese matches by character pairs")
        XCTAssertEqual(store.memoryLines(limit: 1, query: "кто мой врач").first, "about you: Мой врач — доктор Иванов")
    }

    func testThousandsOfNotesStayFast() {
        let store = storeWithFiller(["My passport number is in the vault file passport.pdf"], filler: 5_000)
        _ = store.memoryLines(query: "warm up")  // the first request after launch reads every note once
        let clock = Date()
        let lines = store.memoryLines(query: "where's my passport")
        let took = Date().timeIntervalSince(clock)
        XCTAssertLessThan(took, 0.25, "ranking 5000 notes has to stay quick: it runs on every request")
        XCTAssertTrue(lines[0].contains("passport.pdf"))
    }

    func testVeryLongNoteIsKeptWhole() {
        let (store, _) = freshStore()
        let long = "My allergies: " + String(repeating: "peanuts and shellfish, ", count: 400) + "and kiwi"
        store.addMemory(long)
        XCTAssertEqual(store.memoryLines(query: "kiwi allergy").first, "about you: \(long)")
    }

    func testPinnedSurvivesSaveAndOlderSavesDecode() throws {
        let (store, url) = freshStore()
        let item = store.addMemory("Always reply in British English")!
        store.setMemoryPinned(item.id, true)
        store.saveNow()
        let reloaded = OkidokiStore(stateURL: url)
        XCTAssertEqual(reloaded.memories.first { $0.id == item.id }?.pinned, true)
        let old = #"{"id":"a","section":"aboutYou","text":"old note","createdAt":0}"#
        let decoded = try JSONDecoder().decode(MemoryItem.self, from: Data(old.utf8))
        XCTAssertNil(decoded.pinned)
    }

    func testForgettingKeepsEarlierTurnsThatRepeatItOutOfTheIndex() {
        let (store, url) = freshStore()
        let item = store.addMemory("My manager is Priya")!
        let thread = store.createThread(title: "work", app: "mac", topic: "work")
        store.appendMessage(threadID: thread.id, role: .user, text: "who's my boss?")
        store.appendMessage(threadID: thread.id, role: .assistant, text: "Your manager is Priya.")
        store.appendMessage(threadID: thread.id, role: .assistant, text: "Priya sent the deck yesterday.")
        func indexed() -> [String] { MemoryIndexPayload(store: store).threads.flatMap(\.messages).map(\.text) }
        XCTAssertTrue(indexed().contains("Your manager is Priya."))

        store.deleteMemory(item.id)
        XCTAssertFalse(indexed().contains("Your manager is Priya."), "a turn repeating a forgotten note isn't recalled")
        XCTAssertTrue(indexed().contains("Priya sent the deck yesterday."), "other turns that mention the name stay")
        store.saveNow()
        XCTAssertFalse(MemoryIndexPayload(store: OkidokiStore(stateURL: url)).threads.flatMap(\.messages)
            .contains { $0.text == "Your manager is Priya." }, "still forgotten after a restart")

        store.addMemory("my manager is Priya")
        XCTAssertTrue(indexed().contains("Your manager is Priya."), "saved again, it's known again")
    }

    func testAnEditForgetsTheOldWording() {
        let (store, _) = freshStore()
        let item = store.addMemory("I prefer aisle seats")!
        let thread = store.createThread(title: "flights", app: "mac", topic: "flights")
        store.appendMessage(threadID: thread.id, role: .assistant, text: "You told me you prefer aisle seats, so I picked 14C.")
        store.updateMemory(item.id, text: "I prefer window seats")
        XCTAssertTrue(MemoryIndexPayload(store: store).threads.isEmpty, "the old preference isn't recalled next to the new one")
    }

    func testACorrectionIsRecalledAndUndoBringsTheOldNoteBack() {
        let (store, _) = freshStore()
        guard case .added(let item) = store.saveMemory("My manager is Priya", source: "you") else { return XCTFail("not saved") }
        let thread = store.createThread(title: "work", app: "mac", topic: "work")
        store.appendMessage(threadID: thread.id, role: .assistant, text: "Your manager is Priya.")
        store.saveMemory("My manager is Sam", source: "you", op: "update", targetID: item.id)
        XCTAssertEqual(store.memoryLines(query: "who is my boss"), ["about you: My manager is Sam"], "the correction replaced the note in place")
        XCTAssertTrue(MemoryIndexPayload(store: store).threads.isEmpty, "the old wording isn't recalled from the chat")
        XCTAssertEqual(MemoryIndexPayload(store: store).memories.map(\.text), ["My manager is Sam"])
        store.undoMemorySave(item.id)
        XCTAssertEqual(store.memoryLines(query: "who is my boss"), ["about you: My manager is Priya"])
        XCTAssertEqual(MemoryIndexPayload(store: store).threads.flatMap(\.messages).map(\.text), ["Your manager is Priya."],
                       "undone, the old note and the turns that said it are recalled again")
    }

    func testSearchFindsByWordsBestFirst() {
        let notes = [MemoryItem(section: .aboutYou, text: "I prefer aisle seats"),
                     MemoryItem(section: .aboutYou, text: "My manager is Priya"),
                     MemoryItem(section: .aboutYou, text: "Seat 12A was great")]
        XCTAssertEqual(MemoryRecall.search(notes, query: "aisle seat").map(\.text).first, "I prefer aisle seats")
        XCTAssertEqual(Set(MemoryRecall.search(notes, query: "seats").map(\.text)), ["I prefer aisle seats", "Seat 12A was great"])
        XCTAssertTrue(MemoryRecall.search(notes, query: "the").isEmpty, "stopwords alone match nothing")
    }
}
