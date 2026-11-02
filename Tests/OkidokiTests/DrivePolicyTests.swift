import XCTest
@testable import OkidokiCore

@MainActor
final class DrivePolicyTests: XCTestCase {
    func testAskingToContinueIsNotAFailure() {
        // What the model said when it stopped half way through a Tinkercad circuit.
        XCTAssertTrue(DrivePolicy.asksToContinue("""
            I placed a 9V battery, a resistor, and a red LED on the Tinkercad workplane in "Circuit design Epic Juttuli," \
            but I haven't wired them together yet, so it isn't a working circuit. Should I continue by dragging wires \
            between the battery, resistor, and LED pins?
            """))
        XCTAssertTrue(DrivePolicy.asksToContinue("The slide is laid out. Do you want me to add the speaker notes too"))
        XCTAssertTrue(DrivePolicy.asksToContinue("Would you like me to keep going with the remaining rows"))
    }

    func testAQuestionOnlyTheUserCanAnswerPausesTheRun() {
        // What the model said when the only "Jay Katariya" chat in WhatsApp was the self-chat.
        XCTAssertTrue(DrivePolicy.asksForDetail("""
            I didn't send a new "hi". The only chat named Jay Katariya is the self-chat ("Jay Katariya (You)", Message yourself), \
            which already has a "hi" sent at 4:52 AM. If you meant a different contact, give me their name or number and I'll send it there.
            """))
        XCTAssertTrue(DrivePolicy.asksForDetail("Two matching contacts were found — which one did you mean?"))
        XCTAssertTrue(DrivePolicy.asksForDetail("There are several files called report.pdf; tell me which folder."))
        // Permission to go on is nudged, not paused on.
        XCTAssertFalse(DrivePolicy.asksForDetail("The slide is laid out. Do you want me to add the speaker notes too?"))
        XCTAssertFalse(DrivePolicy.asksForDetail("Should I continue by dragging wires between the pins?"))
        // Real blockers still end the run.
        XCTAssertFalse(DrivePolicy.asksForDetail("Two accounts match, but WhatsApp wants me to sign in first — which one did you mean?"))
        XCTAssertFalse(DrivePolicy.asksForDetail("I tried the menu, the shortcut and a script; the export button stays disabled."))
    }

    func testRealBlockersStillEndTheRun() {
        XCTAssertFalse(DrivePolicy.asksToContinue("Tinkercad wants me to sign in before I can save — should I wait for you?"))
        XCTAssertFalse(DrivePolicy.asksToContinue("A macOS permission prompt is open; please choose Allow or Don't Allow?"))
        XCTAssertFalse(DrivePolicy.asksToContinue("The checkout needs a credit card. Do you want to enter it?"))
        XCTAssertFalse(DrivePolicy.asksToContinue("Private Browsing is locked and asks for your password."))
        XCTAssertFalse(DrivePolicy.asksToContinue("I tried the menu, the shortcut and a script; the export button stays disabled."))
        XCTAssertTrue(DrivePolicy.isRealBlocker("Blender isn't installed on this Mac"))
    }

    private func freshStore() -> OkidokiStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("okidoki-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("state.json")
        let store = OkidokiStore(stateURL: url)
        if store.accounts.isEmpty { store.createAccount(name: "test", email: "", kind: .personal) }
        return store
    }

    func testAFailedRunKeepsTheStepsThatFinished() {
        let store = freshStore()
        let run = store.createRun(kind: .computerUse, title: "circuit", prompt: "make a basic circuit",
                                  steps: [RunStep(title: "Open Dia"), RunStep(title: "Do it"), RunStep(title: "Hand control back")],
                                  status: .running)
        store.updateRun(run.id) { run in
            run.steps[0].status = .done
            run.steps[1].status = .running
        }
        store.finishRun(run.id, status: .failed, summary: "couldn't wire it")
        let steps = store.run(run.id)?.steps.map(\.status)
        XCTAssertEqual(steps, [.done, .failed, .cancelled], "the card should read 1 of 3 done, not 0 of 3")

        let ok = store.createRun(kind: .computerUse, title: "notes", prompt: "make a note",
                                 steps: [RunStep(title: "a"), RunStep(title: "b")], status: .running)
        store.finishRun(ok.id, status: .done, summary: "done")
        XCTAssertEqual(store.run(ok.id)?.steps.map(\.status), [.done, .done])
    }

    func testAnAskedOrStoppedRunLeavesNoStepRunning() {
        let store = freshStore()
        let plan = { [RunStep(title: "search"), RunStep(title: "pick"), RunStep(title: "add to cart")] }
        let asked = store.createRun(kind: .browser, title: "cart", prompt: "add studs", steps: plan(), status: .running)
        store.updateRun(asked.id) { run in
            run.steps[0].status = .running
            run.steps[1].status = .previewing
            run.steps[2].status = .previewing
        }
        store.finishRun(asked.id, status: .asked, summary: "which size?")
        XCTAssertEqual(store.run(asked.id)?.steps.map(\.status), [.asked, .cancelled, .cancelled])

        let stopped = store.createRun(kind: .browser, title: "cart", prompt: "add studs", steps: plan(), status: .running)
        store.updateRun(stopped.id) { run in
            run.steps[0].status = .done
            run.steps[1].status = .running
        }
        store.finishRun(stopped.id, status: .cancelled, summary: "you stopped me")
        XCTAssertEqual(store.run(stopped.id)?.steps.map(\.status), [.done, .cancelled, .cancelled])
    }
}
