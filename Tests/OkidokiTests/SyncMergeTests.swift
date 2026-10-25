import Foundation
import XCTest
@testable import OkidokiCore

final class SyncMergeTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ minutes: Double) -> Date { t0.addingTimeInterval(minutes * 60) }

    private func memory(_ id: String, _ text: String, edited minutes: Double, account: String = "a") -> MemoryItem {
        MemoryItem(id: id, accountID: account, section: .aboutYou, text: text, createdAt: t0, updatedAt: at(minutes))
    }

    private func merge(_ local: [MemoryItem], _ remote: [MemoryItem], deletions: [PulledChanges.Deletion] = [],
                       deletedHere: [String: Date] = [:]) -> ([MemoryItem], MergeSummary) {
        var summary = MergeSummary()
        let merged = SyncMerge.merge(local: local, remote: remote, deletions: deletions, deletedHere: deletedHere,
                                     editedAt: \.updatedAt, summary: &summary)
        return (merged, summary)
    }

    func testTheLaterEditWinsAndATieKeepsTheLocalCopy() {
        let (newer, newerSummary) = merge([memory("m", "old", edited: 1)], [memory("m", "new", edited: 2)])
        XCTAssertEqual(newer.map(\.text), ["new"])
        XCTAssertEqual(newerSummary, MergeSummary(updated: 1))

        let (older, olderSummary) = merge([memory("m", "mine", edited: 2)], [memory("m", "theirs", edited: 1)])
        XCTAssertEqual(older.map(\.text), ["mine"])
        XCTAssertEqual(olderSummary.changes, 0)

        let (tie, _) = merge([memory("m", "mine", edited: 2)], [memory("m", "theirs", edited: 2)])
        XCTAssertEqual(tie.map(\.text), ["mine"])
    }

    func testNewRemoteItemsAreAddedAndUntouchedLocalOnesStay() {
        let (merged, summary) = merge([memory("mine", "here", edited: 1)], [memory("theirs", "there", edited: 1)])
        XCTAssertEqual(merged.map(\.id), ["mine", "theirs"])
        XCTAssertEqual(summary, MergeSummary(added: 1))
    }

    func testADeleteFromAnotherMacRemovesTheItemUnlessItWasEditedHereAfterwards() {
        let delete = PulledChanges.Deletion(table: "memories", id: "m", deletedAt: at(5))
        let (gone, goneSummary) = merge([memory("m", "x", edited: 4)], [], deletions: [delete])
        XCTAssertTrue(gone.isEmpty)
        XCTAssertEqual(goneSummary, MergeSummary(removed: 1))

        let (kept, _) = merge([memory("m", "edited later", edited: 6)], [], deletions: [delete])
        XCTAssertEqual(kept.map(\.text), ["edited later"])
    }

    func testAnItemDeletedHereIsNotBroughtBackByAPullUnlessItWasEditedElsewhereSince() {
        let (stillGone, summary) = merge([], [memory("m", "x", edited: 3)], deletedHere: ["m": at(4)])
        XCTAssertTrue(stillGone.isEmpty)
        XCTAssertEqual(summary.changes, 0)

        let (back, _) = merge([], [memory("m", "edited on the other Mac", edited: 5)], deletedHere: ["m": at(4)])
        XCTAssertEqual(back.map(\.text), ["edited on the other Mac"])
    }

    func testAThreadEditedOnTwoMacsKeepsEveryMessageInOrder() {
        let base = ChatThread(id: "t", accountID: "a", title: "trip", createdAt: t0, updatedAt: at(1))
        var local = base
        local.messages = [ChatMessage(id: "1", role: .user, text: "plan chicago", createdAt: at(1)),
                          ChatMessage(id: "3", role: .user, text: "add a museum", createdAt: at(3))]
        local.updatedAt = at(3)
        var remote = base
        remote.title = "chicago trip"
        remote.messages = [ChatMessage(id: "1", role: .user, text: "plan chicago", createdAt: at(1)),
                           ChatMessage(id: "2", role: .assistant, text: "here's a plan", createdAt: at(2)),
                           ChatMessage(id: "4", role: .user, text: "book the train", createdAt: at(4))]
        remote.updatedAt = at(4)

        let merged = SyncMerge.combineThreads(local, remote)
        XCTAssertEqual(merged.messages.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(merged.title, "chicago trip")
        XCTAssertEqual(merged.updatedAt, at(4))
        XCTAssertEqual(SyncMerge.combineThreads(remote, local).messages.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(SyncMerge.combineThreads(local, local), local)
    }

    func testTheSameNoteSavedOnTwoMacsIsKeptOnce() {
        let local = [memory("mine", "Studies at Purdue", edited: 1)]
        let remote = [memory("theirs", "studies at purdue", edited: 2), memory("other-account", "studies at purdue", edited: 2, account: "b"),
                      memory("mine", "Studies at Purdue!", edited: 3)]
        XCTAssertEqual(SyncMerge.withoutDuplicateMemories(remote, local: local).map(\.id), ["other-account", "mine"])
    }

    func testSyncDatesKeepFractionsAndReadWholeSeconds() throws {
        let date = Date(timeIntervalSince1970: 1_800_000_000.25)
        let text = SyncDates.string(from: date)
        XCTAssertTrue(text.contains(".250"), text)
        XCTAssertEqual(try XCTUnwrap(SyncDates.date(from: text)).timeIntervalSince1970, 1_800_000_000.25, accuracy: 0.001)
        XCTAssertEqual(SyncDates.date(from: "2027-01-15T08:00:00Z")?.timeIntervalSince1970, 1_800_000_000)
    }
}
