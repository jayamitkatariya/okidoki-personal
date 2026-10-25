import Foundation
import XCTest
@testable import OkidokiCore

@MainActor
final class OkidokiStoreSyncTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private var stateURL: URL { folder.appendingPathComponent("state.json") }

    private func store(device: String = "mac-a") -> OkidokiStore {
        OkidokiStore(stateURL: stateURL, deviceID: device)
    }

    func testASyncFinishingIsHousekeepingNotAChangeThatNeedsAnotherSync() {
        let store = store()
        var changes = 0
        var housekeeping = 0
        let sink = store.objectWillChange.sink { _ in
            if store.isHousekeeping { housekeeping += 1 } else { changes += 1 }
        }
        defer { sink.cancel() }
        store.addMemory("likes tea", section: .aboutYou, source: "said")
        XCTAssertEqual(changes, 1)
        // What a finished sync does: stamp the time and save. Neither may count as a change,
        // or every sync would schedule the next one forever.
        store.noteSynced()
        XCTAssertEqual(changes, 1)
        XCTAssertGreaterThan(housekeeping, 0)
        XCTAssertNotNil(store.settings.lastSyncAt)
    }

    /// A state.json the way builds before per-account memory wrote it.
    private func writeVersion1State(extraRun: String = "") throws {
        let json = """
        {
          "version": 1,
          "accounts": [
            {"id": "personal", "name": "Jay", "email": "", "kind": "personal", "colorHex": "1FB57A", "createdAt": "2026-10-01T00:00:00Z"},
            {"id": "work", "name": "Jay at work", "email": "", "kind": "work", "colorHex": "7A8CFF", "createdAt": "2026-10-02T00:00:00Z"}
          ],
          "currentAccountID": "work",
          "settings": {},
          "threads": [],
          "memories": [
            {"id": "m1", "section": "aboutYou", "text": "studies at Purdue", "source": "you", "createdAt": "2026-10-03T00:00:00Z", "updatedAt": "2026-10-03T00:00:00Z"},
            {"id": "m2", "section": "aboutYou", "text": "the clipboard has a link", "source": "said", "createdAt": "2026-10-03T00:00:00Z", "updatedAt": "2026-10-03T00:00:00Z"}
          ],
          "runs": [
            {"id": "r1", "accountID": "work", "kind": "terminal", "title": "compress", "prompt": "compress it", "status": "running",
             "steps": [], "output": "", "summary": "", "createdAt": "2026-10-04T00:00:00Z"}\(extraRun)
          ],
          "skills": [],
          "routines": [
            {"id": "ro1", "accountID": "work", "name": "brief", "prompt": "brief me", "cadence": "daily", "weekday": 2, "hour": 9,
             "minute": 0, "enabled": true, "createdAt": "2026-10-05T00:00:00Z"}
          ],
          "connectors": []
        }
        """
        try Data(json.utf8).write(to: stateURL)
    }

    func testAnOlderSaveGivesItsMemoriesToTheAccountInFrontAndClaimsItsRunsAndRoutinesForThisMac() throws {
        try writeVersion1State()
        let store = store()
        XCTAssertEqual(store.memories.map(\.id), ["m1"], "the model's old clipboard note is pruned, once")
        XCTAssertEqual(store.memories.first?.accountID, "work")
        XCTAssertEqual(store.runs.first?.origin, "mac-a")
        XCTAssertEqual(store.runs.first?.status, .failed, "this Mac's own interrupted run is recovered")
        XCTAssertNotNil(store.runs.first?.updatedAt, "and the recovery counts as an edit, so it syncs")
        XCTAssertEqual(store.routines.first?.origin, "mac-a")
        XCTAssertTrue(store.isFromThisMac(store.routines[0]))

        store.saveNow()
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: stateURL)) as? [String: Any]
        XCTAssertEqual(saved?["version"] as? Int, AppState.currentVersion)

        // Later launches don't prune again: a note that would fail today's check now stays.
        store.memories.append(MemoryItem(accountID: "work", section: .aboutYou, text: "the clipboard has a link", source: "said"))
        store.saveNow()
        XCTAssertEqual(self.store().memories.count, 2)
    }

    func testAnotherMacsRunningJobIsNotMarkedFailedWhenThisMacRestarts() throws {
        try writeVersion1State()
        let first = store()
        first.mergePulled(PulledChanges(runs: [AgentRun(id: "theirs", accountID: "work", kind: .terminal, title: "build", prompt: "build",
                                                        status: .running, updatedAt: Date(), origin: "mac-b")]))
        first.saveNow()
        let reopened = store()
        XCTAssertEqual(reopened.run("theirs")?.status, .running)
        XCTAssertFalse(reopened.isFromThisMac(reopened.run("theirs")!))
    }

    func testMemoryBelongsToTheAccountInFront() {
        let store = store()
        let personal = store.currentAccountID
        store.addMemory("studies at Purdue")
        let work = store.createAccount(name: "work", email: "", kind: .work)
        XCTAssertEqual(store.currentAccountID, work.id)
        XCTAssertTrue(store.activeMemories.isEmpty)
        XCTAssertNotNil(store.addMemory("studies at Purdue"), "the same note in another account is its own")
        XCTAssertNil(store.addMemory("Studies at Purdue."), "but not twice in one")
        store.addMemory("on call this week", section: .rightNow)

        XCTAssertEqual(store.stateForSync(accountID: personal).memories.map(\.text), ["studies at Purdue"])
        XCTAssertEqual(store.stateForSync().memories.count, 2)
        XCTAssertEqual(store.memoryLines(), ["right now: on call this week", "about you: studies at Purdue"])

        store.deleteAccount(work.id)
        XCTAssertEqual(store.memories.map(\.accountID), [personal])
        XCTAssertFalse(store.adoptAccount(work), "a deleted account isn't adopted straight back from the login")
    }

    func testStaleRightNowNotesStayVisibleButLeaveTheModelsList() {
        let store = store()
        store.addMemory("packing for chicago", section: .rightNow)
        store.memories[0].updatedAt = Date().addingTimeInterval(-15 * 86_400)
        store.addMemory("studying for the midterm", section: .rightNow)
        XCTAssertEqual(store.memories(.rightNow).count, 2)
        XCTAssertEqual(store.memoryLines(), ["right now: studying for the midterm"])
        XCTAssertFalse(store.memoryContext.contains("chicago"))
    }

    func testEveryChangeStampsTheItemSoSyncKeepsTheNewestCopy() throws {
        let store = store()
        let run = store.createRun(kind: .terminal, title: "t", prompt: "p")
        XCTAssertEqual(run.origin, "mac-a")
        let created = try XCTUnwrap(run.updatedAt)
        Thread.sleep(forTimeInterval: 0.01)
        store.updateRun(run.id) { $0.output += "line\n" }
        XCTAssertGreaterThan(try XCTUnwrap(store.run(run.id)?.updatedAt), created)

        let skill = store.createSkill(name: "export", summary: "", steps: [])
        Thread.sleep(forTimeInterval: 0.01)
        store.incrementSkillRun(skill.id)
        XCTAssertGreaterThan(try XCTUnwrap(store.skill(skill.id)?.updatedAt), try XCTUnwrap(skill.updatedAt))

        let routine = store.createRoutine(name: "brief", prompt: "brief me")
        XCTAssertEqual(routine.origin, "mac-a")
        Thread.sleep(forTimeInterval: 0.01)
        store.toggleRoutine(routine.id)
        XCTAssertGreaterThan(try XCTUnwrap(store.routine(routine.id)?.updatedAt), try XCTUnwrap(routine.updatedAt))

        let thread = store.createThread(title: "x")
        Thread.sleep(forTimeInterval: 0.01)
        store.archiveThread(thread.id)
        XCTAssertGreaterThan(try XCTUnwrap(store.thread(thread.id)?.updatedAt), thread.updatedAt)
    }

    func testDeletesAreRememberedAcrossARelaunchAndKeepAPullFromBringingTheItemBack() throws {
        let store = store()
        let note = try XCTUnwrap(store.addMemory("an old note"))
        store.deleteMemory(note.id)
        store.saveNow()

        let reopened = self.store()
        XCTAssertNotNil(reopened.deletions[note.id])
        // The note as Convex hands it back: through the wire format, like every pulled item.
        let pulled = try SyncDates.decoder.decode(MemoryItem.self, from: SyncDates.encoder.encode(note))
        let summary = reopened.mergePulled(PulledChanges(memories: [pulled]))
        XCTAssertEqual(summary.changes, 0)
        XCTAssertTrue(reopened.memories.isEmpty)
    }

    func testAPullMergesIntoTheStoreAndLeavesUnchangedCollectionsAlone() throws {
        let store = store()
        let account = store.currentAccountID
        let mine = try XCTUnwrap(store.addMemory("mine"))
        let skill = store.createSkill(name: "keep", summary: "", steps: [])
        let skillsBefore = store.skills

        let theirs = MemoryItem(id: "theirs", accountID: account, section: .aboutYou, text: "from my laptop",
                                createdAt: Date().addingTimeInterval(60), updatedAt: Date().addingTimeInterval(60))
        let summary = store.mergePulled(PulledChanges(
            memories: [theirs],
            deletions: [PulledChanges.Deletion(table: "memories", id: mine.id, deletedAt: Date().addingTimeInterval(1))]))
        XCTAssertEqual(summary, MergeSummary(added: 1, removed: 1))
        XCTAssertEqual(store.memories.map(\.id), ["theirs"])
        XCTAssertEqual(store.skills, skillsBefore)
        XCTAssertEqual(store.skill(skill.id)?.name, "keep")
    }

    func testItemsThisBuildCantReadAreKeptInACopyInsteadOfBeingLostOnTheNextSave() throws {
        try writeVersion1State(extraRun: """
        ,
            {"id": "future", "accountID": "work", "kind": "teleport", "title": "from a newer build", "prompt": "", "status": "done",
             "steps": [], "output": "", "summary": "", "createdAt": "2026-10-04T00:00:00Z"}
        """)
        let store = store()
        XCTAssertEqual(store.runs.map(\.id), ["r1"])
        XCTAssertNotNil(store.loadWarning)
        let copies = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasPrefix("state.partial-") }
        XCTAssertEqual(copies.count, 1)
        let kept = try String(contentsOf: folder.appendingPathComponent(copies[0]), encoding: .utf8)
        XCTAssertTrue(kept.contains("teleport"))
        // And it stays with the state, so the next push sends it back instead of deleting it on Convex.
        XCTAssertEqual(store.unreadable.map(\.id), ["future"])
        XCTAssertEqual(store.unreadable.first?.accountID, "work")
        store.saveNow()
        XCTAssertEqual(self.store().unreadable.map(\.id), ["future"])
    }

    func testTheIndexGetsOnlyWhatItEmbeds() {
        let now = Date()
        let thread = ChatThread(accountID: "a", title: "today", messages: [
            ChatMessage(role: .user, text: "recent", createdAt: now.addingTimeInterval(-3600)),
            ChatMessage(role: .system, text: "system line", createdAt: now),
            ChatMessage(role: .user, text: "old", createdAt: now.addingTimeInterval(-20 * 86_400)),
        ], updatedAt: now)
        let oldThread = ChatThread(accountID: "a", title: "last month", messages: [ChatMessage(role: .user, text: "x", createdAt: now.addingTimeInterval(-30 * 86_400))],
                                   updatedAt: now.addingTimeInterval(-30 * 86_400))
        let runs = [
            AgentRun(id: "done", accountID: "a", kind: .terminal, title: "compress", prompt: "compress it", status: .done,
                     output: String(repeating: "log ", count: 10_000), summary: "24 MB", createdAt: now),
            AgentRun(id: "answer", accountID: "a", kind: .answer, title: "q", prompt: "q", status: .done, createdAt: now),
            AgentRun(id: "plan", accountID: "a", kind: .terminal, title: "p", prompt: "p", status: .previewing, createdAt: now),
            AgentRun(id: "old", accountID: "a", kind: .terminal, title: "o", prompt: "o", status: .done, createdAt: now.addingTimeInterval(-90 * 86_400)),
        ]
        let skill = Skill(accountID: "a", name: "export", summary: "pdf", steps: (0..<20).map { SkillStep(text: "step \($0)", x: 1, y: 2) })
        let payload = MemoryIndexPayload(memories: [MemoryItem(accountID: "a", section: .rightNow, text: "busy")],
                                         threads: [thread, oldThread], runs: runs, skills: [skill], now: now)
        XCTAssertEqual(payload.memories.map(\.accountID), ["a"])
        XCTAssertEqual(payload.threads.map(\.title), ["today"])
        XCTAssertEqual(payload.threads[0].messages.map(\.text), ["recent"])
        XCTAssertEqual(payload.runs.map(\.id), ["done"])
        XCTAssertEqual(payload.runs[0].summary, "24 MB")
        XCTAssertEqual(payload.skills[0].steps.count, 12)

        let encoded = String(data: try! JSONEncoder().encode(payload.runs), encoding: .utf8)!
        XCTAssertFalse(encoded.contains("log log"), "run output never goes to the index")
    }
}
