import XCTest
@testable import OkidokiCore

final class MacReplayTests: XCTestCase {

    func testOnlyThePersonAnswersPasswordsPermissionsKeychainAndCodes() {
        XCTAssertEqual(MacReplay.personOnly(text: "“AcmeDesk” would like to access your contacts.", buttons: ["Don't Allow", "Allow"]), "a permission prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "Something", buttons: ["Allow", "Don’t Allow"]), "a permission prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "AcmeDesk wants to use your confidential information stored in “x” in your keychain.", buttons: ["Deny", "Allow"]), "a keychain prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "AcmeDesk wants to use your confidential information stored in “x” in your keychain.", buttons: ["Deny", "Always Allow"]), "a keychain prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "Enter your password to allow this.", buttons: ["Cancel", "OK"], owner: "com.apple.SecurityAgent"), "a macOS password prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "Anything", buttons: [], owner: "com.apple.UserNotificationCenter"), "a macOS prompt")
        XCTAssertEqual(MacReplay.personOnly(text: "Enter the code we sent to your phone", buttons: ["Verify"]), "a one-time code")
        XCTAssertNil(MacReplay.personOnly(text: "Stay signed in?", buttons: ["Sign out", "Stay signed in"]))
        XCTAssertNil(MacReplay.personOnly(text: "What's new in AcmeDesk 3", buttons: ["Take the tour", "Start filing"]))
    }

    func testWorkIsNeverThrownAwayByAPopupRule() {
        XCTAssertTrue(MacReplay.neverDismiss(text: "Do you want to save the changes made to the document “Budget”?", buttons: ["Don't Save", "Cancel", "Save"]))
        XCTAssertTrue(MacReplay.neverDismiss(text: "Are you sure you want to delete this row? This can't be undone.", buttons: ["Cancel", "OK"]))
        XCTAssertTrue(MacReplay.neverDismiss(text: "Move items", buttons: ["Cancel", "Move to Trash"]))
        XCTAssertFalse(MacReplay.neverDismiss(text: "Stay signed in?", buttons: ["Sign out", "Stay signed in"]))
    }

    func testStartStepsAreTheLeadingSwitches() {
        let steps = [SkillStep(text: "open AcmeDesk", app: "AcmeDesk", action: "switch"),
                     SkillStep(text: "click Username", app: "AcmeDesk", action: "click"),
                     SkillStep(text: "open again", app: "AcmeDesk", action: "switch")]
        XCTAssertEqual(MacReplay.startSteps(HybridReplay.plan(steps, values: [:])), 1)
        XCTAssertEqual(MacReplay.startSteps([]), 0)
    }

    func anchored(_ window: String, landmark: String? = nil) -> SkillStep {
        var step = SkillStep(text: "x", app: "AcmeDesk", action: "click")
        step.anchor = StepAnchor(landmark: landmark, app: "AcmeDesk", window: window)
        return step
    }

    func testUnknownScreensAreOnesNoStepIsOn() {
        let plan = HybridReplay.plan([anchored("Sign in"), anchored("Return details"), anchored("Deductions")], values: [:])
        let verify = HybridReplay.Observation(title: "AcmeDesk — Verify email", text: "Verify your email", app: "AcmeDesk", window: "AcmeDesk — Verify email")
        let details = HybridReplay.Observation(title: "AcmeDesk — Return details", text: "", app: "AcmeDesk", window: "AcmeDesk — Return details")
        XCTAssertTrue(MacReplay.unknownScreen(plan, seen: verify))
        XCTAssertFalse(MacReplay.unknownScreen(plan, seen: details))
        // A plan without window anchors can't tell, so nothing is pressed on a guess.
        XCTAssertFalse(MacReplay.unknownScreen(HybridReplay.plan([SkillStep(text: "x", app: "A")], values: [:]), seen: verify))
        XCTAssertEqual(MacReplay.screenKey(window: "AcmeDesk — Verify email"), "window:acmedesk verify email")
        XCTAssertEqual(MacReplay.screenKey(window: "AcmeDesk — Verify email", sheets: ["Code sent"]), "window:acmedesk verify email code")
    }

    func testKeysThroughAccessibility() {
        XCTAssertEqual(MacReplay.meaning(ofKey: "return"), .defaultButton)
        XCTAssertEqual(MacReplay.meaning(ofKey: "Enter"), .defaultButton)
        XCTAssertEqual(MacReplay.meaning(ofKey: "esc"), .cancelButton)
        XCTAssertEqual(MacReplay.meaning(ofKey: "tab"), .nextField)
        XCTAssertEqual(MacReplay.meaning(ofKey: "cmd+s"), .unsupported)
    }

    func testTypingAWholeValueReplacesSoASecondPassNeverDoublesIt() {
        XCTAssertTrue(MacReplay.isWholeValue("{{name}}"))
        XCTAssertTrue(MacReplay.isWholeValue(" {{item.amount}} "))
        XCTAssertFalse(MacReplay.isWholeValue("Dear {{name}},"))
        XCTAssertFalse(MacReplay.isWholeValue("eval"))
        XCTAssertEqual(MacReplay.typedValue(current: "Asha Rao", typed: "Bharat Mehta", wholeValue: true), "Bharat Mehta")
        XCTAssertEqual(MacReplay.typedValue(current: "", typed: "eval", wholeValue: false), "eval")
        XCTAssertEqual(MacReplay.typedValue(current: "Dear ", typed: "Asha", wholeValue: false), "Dear Asha")
    }

    func testThePersonsTurnEndsOnlyWhenClearAndQuiet() {
        var clock = MacReplay.QuietClock()
        let t0 = Date()
        XCTAssertFalse(clock.note(clear: false, signature: "a", now: t0))
        XCTAssertFalse(clock.note(clear: true, signature: "a", now: t0))
        XCTAssertFalse(clock.note(clear: true, signature: "a", now: t0.addingTimeInterval(1.0)))
        // The screen changed: the quiet starts again.
        XCTAssertFalse(clock.note(clear: true, signature: "b", now: t0.addingTimeInterval(1.6)))
        XCTAssertFalse(clock.note(clear: true, signature: "b", now: t0.addingTimeInterval(2.9)))
        XCTAssertTrue(clock.note(clear: true, signature: "b", now: t0.addingTimeInterval(3.2)))
        // A second check right after the first: not done.
        var again = MacReplay.QuietClock()
        XCTAssertFalse(again.note(clear: true, signature: "x", now: t0))
        XCTAssertFalse(again.note(clear: false, signature: "x", now: t0.addingTimeInterval(1.6)))
        XCTAssertFalse(again.note(clear: true, signature: "x", now: t0.addingTimeInterval(2.0)))
        // An unreadable screen never counts.
        var blank = MacReplay.QuietClock()
        XCTAssertFalse(blank.note(clear: true, signature: "", now: t0))
        XCTAssertFalse(blank.note(clear: true, signature: "", now: t0.addingTimeInterval(5)))
    }

    func testRiskyLabelsAreNeverLearned() {
        for label in ["Sign Out", "Delete Row", "Submit", "File return", "Send", "Don't Save", "Move to Trash"] { XCTAssertTrue(MacReplay.isRisky(label), label) }
        for label in ["Start filing", "Stay signed in", "Not Now", "Skip for now"] { XCTAssertFalse(MacReplay.isRisky(label), label) }
    }

    func testBuiltinsCloseStaySignedInInsideTheSheetOnly() {
        let seen = HybridReplay.Observation(title: "AcmeDesk — Return details", text: "Stay signed in?", app: "AcmeDesk", window: "AcmeDesk — Return details")
        let hits = HybridReplay.interrupts(showing: seen, skill: [], dialogText: "Stay signed in?\nYou've been idle")
        XCTAssertEqual(hits.first?.clickLabel, "Stay signed in")
        XCTAssertEqual(HybridReplay.safeDismissal(in: ["Sign out", "Stay signed in"]), "Stay signed in")
        XCTAssertNil(HybridReplay.safeDismissal(in: ["Take the tour", "Start filing"]))
        // A learned rule only fires on a dialog's words, never on the window's.
        let learned = InterruptHandler(whenText: "what new acmedesk returns", clickLabel: "Start filing", source: "learned")
        XCTAssertTrue(HybridReplay.interrupts(showing: seen, skill: [learned], dialogText: nil).filter { $0.source == "learned" }.isEmpty)
        XCTAssertEqual(HybridReplay.interrupts(showing: seen, skill: [learned], dialogText: "What's new in AcmeDesk 3 Returns now save").first?.clickLabel, "Start filing")
    }
}

final class LearnedPopupKeyTests: XCTestCase {
    /// A learned key is made of the dialog's longer words; it must find the same dialog again even with
    /// short words, digits and punctuation in between (it used to be matched as plain text only).
    func testALearnedKeyFindsItsDialogAgain() {
        for text in ["What's new in AcmeDesk 3\nReturns now save as you type.", "We value your feedback! Take our 2-minute survey",
                     "Your session will time out in 2 minutes. Continue?"] {
            let key = HybridReplay.dialogKey(text)!
            let rule = InterruptHandler(whenText: key, clickLabel: "x", source: "learned")
            XCTAssertEqual(HybridReplay.interrupts(showing: HybridReplay.Observation(), skill: [rule], dialogText: text).first?.whenText, key, text)
        }
        // Not a different dialog that shares a word.
        let rule = InterruptHandler(whenText: HybridReplay.dialogKey("We value your feedback! Take our survey")!, clickLabel: "x", source: "learned")
        XCTAssertTrue(HybridReplay.interrupts(showing: HybridReplay.Observation(), skill: [rule], dialogText: "Your feedback was sent").filter { $0.source == "learned" }.isEmpty)
    }
}
