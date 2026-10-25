import XCTest
@testable import OkidokiCore

final class SpaceWorkerTests: XCTestCase {
    /// A store of its own, so the real state on this Mac (or another test's) never leaks in.
    @MainActor
    private func freshStore() -> OkidokiStore {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-tests-\(UUID().uuidString)").appendingPathComponent("state.json")
        return OkidokiStore(seedDemo: false, stateURL: url)
    }

    private func run(status: RunStatus, title: String = "Compress video", summary: String = "", output: String = "") -> AgentRun {
        AgentRun(accountID: "acct", kind: .terminal, title: title, prompt: "compress it", status: status, output: output, summary: summary)
    }

    func testRunStatusesMapOntoTheJobsAChatUnderstands() {
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .previewing), "running")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .running), "running")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .paused), "running")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .waiting), "waiting")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .done), "done")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .failed), "failed")
        XCTAssertEqual(SpaceWorkerService.jobStatus(for: .cancelled), "cancelled")
    }

    func testClosingLinePrefersTheAnswerThenTheSummaryThenTheTitle() {
        XCTAssertEqual(SpaceWorkerService.closingLine(run: run(status: .done), answer: "It's 7.9 MB now."), "It's 7.9 MB now.")
        XCTAssertEqual(SpaceWorkerService.closingLine(run: run(status: .done, summary: "Saved launch.mp4"), answer: ""), "Done: Saved launch.mp4")
        XCTAssertEqual(SpaceWorkerService.closingLine(run: run(status: .done), answer: ""), "Done: Compress video")
    }

    func testFailuresQuoteTheLastOutputLineWhenThereIsNoSummary() {
        let failed = run(status: .failed, output: "ffmpeg: starting\nffmpeg: no such file launch.mov")
        XCTAssertEqual(SpaceWorkerService.closingLine(run: failed, answer: ""), "That didn't work: ffmpeg: no such file launch.mov")
        XCTAssertEqual(SpaceWorkerService.closingLine(run: run(status: .failed, summary: "No ffmpeg"), answer: ""), "That didn't work: No ffmpeg")
        XCTAssertEqual(SpaceWorkerService.closingLine(run: run(status: .cancelled), answer: ""), "Stopped.")
    }

    @MainActor
    func testImportingASharedSkillReplacesTheSameOneAndDropsScreenPictures() {
        let store = freshStore()
        let steps: [[String: Any]] = [
            ["id": "s1", "text": "Open Numbers", "app": "Numbers", "action": "click", "label": "Numbers", "frameX": 1, "frameY": 2, "frameW": 3, "frameH": 4],
            ["id": "s2", "text": "Save", "app": "Numbers", "action": "key", "input": "cmd+s"],
        ]
        let first = store.importSkill(sharedID: "shared-1", name: "Invoice flow", summary: "", stepsJSON: steps, version: 1)
        XCTAssertEqual(first?.source, "shared:shared-1")
        XCTAssertEqual(first?.summary, "shared by a colleague · v1")
        XCTAssertNil(first?.steps.first?.frameX)
        XCTAssertEqual(first?.steps.last?.input, "cmd+s")

        let second = store.importSkill(sharedID: "shared-1", name: "Invoice flow v2", summary: "Bills a client", stepsJSON: [steps[1]], version: 2)
        XCTAssertEqual(second?.id, first?.id)
        XCTAssertEqual(store.skills.filter { $0.source == "shared:shared-1" }.count, 1)
        XCTAssertEqual(second?.name, "Invoice flow v2")
        XCTAssertEqual(second?.steps.count, 1)

        XCTAssertNil(store.importSkill(sharedID: "shared-2", name: "Empty", summary: "", stepsJSON: [], version: 1))
        XCTAssertNil(store.importSkill(sharedID: "shared-3", name: "Broken", summary: "", stepsJSON: "not steps", version: 1))
    }

    @MainActor
    func testWorkerStaysOffWithoutSyncOrAWorkAccount() async {
        let store = freshStore()
        store.accounts = [Account(name: "Test", email: "", kind: .personal)]
        store.currentAccountID = store.accounts[0].id
        let worker = SpaceWorkerService()
        worker.runJob = { _, _ in }
        await worker.tick()
        XCTAssertEqual(worker.status, "off")
        store.settings.syncEnabled = true
        store.settings.convexSiteURL = "https://example.convex.site"
        store.settings.workerEnabled = true
        worker.start(store: store)
        worker.stop()
        await worker.tick()
        // a personal account never polls, however sync is set
        XCTAssertEqual(store.activeAccount.kind, .personal)
        XCTAssertEqual(worker.status, "off")
        XCTAssertNil(worker.lastPollAt)
    }
}
