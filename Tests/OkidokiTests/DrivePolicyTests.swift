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

    func testAnsweringAQuestionTakesItOffNeedsYourAttention() {
        let store = freshStore()
        let thread = store.createThread(title: "cart", app: "okidoki browser", topic: "shopping")
        let asked = store.createRun(kind: .browser, title: "cart", prompt: "add studs", threadID: thread.id,
                                    steps: [RunStep(title: "search"), RunStep(title: "pick")], status: .running)
        store.finishRun(asked.id, status: .asked, summary: "which size?")
        XCTAssertEqual(store.run(asked.id)?.status, .asked)

        // The follow-up starts a new run in the same conversation: the question is answered.
        let next = store.createRun(kind: .browser, title: "cart", prompt: "size 10", threadID: thread.id, status: .waiting)
        let answered = store.run(asked.id)
        XCTAssertEqual(answered?.status, .done, "an answered question must not keep waiting on you")
        XCTAssertEqual(answered?.answer, "size 10")
        XCTAssertEqual(answered?.summary, "which size?", "the question stays readable in history")
        XCTAssertFalse(answered?.steps.contains { $0.status == .asked } ?? true)
        XCTAssertEqual(store.run(next.id)?.status, .waiting)

        // A question in another conversation is untouched.
        let other = store.createRun(kind: .computerUse, title: "x", prompt: "y", threadID: "elsewhere", status: .running)
        store.finishRun(other.id, status: .asked, summary: "which file?")
        _ = store.createRun(kind: .computerUse, title: "z", prompt: "w", threadID: thread.id, status: .waiting)
        XCTAssertEqual(store.run(other.id)?.status, .asked)
    }

    func testQuestionsAnsweredBeforeTheFixAreClearedOnLaunch() {
        let old = Date(timeIntervalSinceNow: -600)
        let asked = AgentRun(accountID: "a", kind: .browser, title: "t", prompt: "p", threadID: "th", status: .asked,
                             steps: [RunStep(title: "s", status: .asked)], summary: "which?", createdAt: old)
        let followUp = AgentRun(accountID: "a", kind: .browser, title: "t", prompt: "this one", threadID: "th", status: .done)
        let lonely = AgentRun(accountID: "a", kind: .computerUse, title: "t", prompt: "p", threadID: "other", status: .asked)
        let fixed = OkidokiStore.answeringSupersededQuestions([followUp, asked, lonely])
        XCTAssertEqual(fixed[1].status, .done)
        XCTAssertEqual(fixed[1].answer, "this one")
        XCTAssertEqual(fixed[1].steps.map(\.status), [.done])
        XCTAssertEqual(fixed[2].status, .asked, "an unanswered question still waits")

        // Given up on: the same task started over in a new conversation.
        let abandoned = AgentRun(accountID: "a", kind: .browser, title: "t", prompt: "Add blue Puma studs",
                                 threadID: "one", status: .asked, summary: "which size?", createdAt: old)
        let retry = AgentRun(accountID: "a", kind: .browser, title: "t", prompt: "add blue  puma studs", threadID: "two", status: .done)
        XCTAssertEqual(OkidokiStore.answeringSupersededQuestions([retry, abandoned])[1].status, .cancelled)
    }

    func testStartingTheSameTaskOverDropsItsOldQuestion() {
        let store = freshStore()
        let asked = store.createRun(kind: .browser, title: "studs", prompt: "add puma studs", threadID: "one", status: .running)
        store.finishRun(asked.id, status: .asked, summary: "which size?")
        _ = store.createRun(kind: .browser, title: "other", prompt: "something else", threadID: "two", status: .waiting)
        XCTAssertEqual(store.run(asked.id)?.status, .asked, "a different task leaves the question alone")
        _ = store.createRun(kind: .browser, title: "studs", prompt: "Add Puma studs", threadID: "three", status: .waiting)
        XCTAssertEqual(store.run(asked.id)?.status, .cancelled)
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
