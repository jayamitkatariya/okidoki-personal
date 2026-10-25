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
        XCTAssertTrue(DrivePolicy.asksToContinue("Two matching contacts were found — which one did you mean?"))
        XCTAssertTrue(DrivePolicy.asksToContinue("Would you like me to keep going with the remaining rows"))
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
}
