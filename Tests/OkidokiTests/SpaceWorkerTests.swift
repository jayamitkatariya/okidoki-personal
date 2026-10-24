import XCTest
@testable import OkidokiCore

final class SpaceWorkerTests: XCTestCase {
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
    func testWorkerStaysOffWithoutSyncOrAWorkAccount() async {
        let store = OkidokiStore(seedDemo: false)
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
