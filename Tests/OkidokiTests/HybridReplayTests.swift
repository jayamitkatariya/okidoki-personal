import XCTest
@testable import OkidokiCore

final class HybridReplayTests: XCTestCase {
    private func step(_ text: String, when: String? = nil, repeatOver: String? = nil, length: Int? = nil,
                      anchor: StepAnchor? = nil, irreversible: Bool? = nil) -> SkillStep {
        var s = SkillStep.browser("click", text: text, url: "http://x/")
        s.when = when; s.repeatOver = repeatOver; s.repeatLength = length; s.anchor = anchor; s.irreversible = irreversible
        return s
    }

    // MARK: plan

    func testConditionsSkipStepsThatDontApplyToThisPerson() {
        let steps = [step("name"), step("tick gains", when: "{{gains}}"), step("type gains", when: "{{gains}}"), step("continue")]
        XCTAssertEqual(HybridReplay.plan(steps, values: ["gains": "310000"]).map(\.step.text), ["name", "tick gains", "type gains", "continue"])
        XCTAssertEqual(HybridReplay.plan(steps, values: ["gains": ""]).map(\.step.text), ["name", "continue"])
        XCTAssertEqual(HybridReplay.plan(steps, values: [:]).map(\.step.text), ["name", "continue"])
    }

    func testLoopsUnrollOncePerEntryWithItemValues() {
        let steps = [step("open deductions"),
                     step("add row", repeatOver: "deductions", length: 3), step("{{item.section}}"), step("{{item.amount}}"),
                     step("continue")]
        let list = HybridReplay.encodeList([["section": "80C", "amount": "150000"], ["section": "80D", "amount": "25000"]])
        let planned = HybridReplay.plan(steps, values: ["deductions": list])
        XCTAssertEqual(planned.map(\.step.text), ["open deductions", "add row", "{{item.section}}", "{{item.amount}}",
                                                   "add row", "{{item.section}}", "{{item.amount}}", "continue"])
        XCTAssertEqual(planned.map(\.source), [0, 1, 2, 3, 1, 2, 3, 4])
        XCTAssertEqual(ParameterFill.fill("{{item.amount}} in {{item.section}}", values: planned[6].values).text, "25000 in 80D")
        XCTAssertEqual(planned[4].iteration, 1)
    }

    func testAnEmptyListSkipsTheWholeLoop() {
        let steps = [step("a"), step("add row", repeatOver: "deductions", length: 2), step("amount"), step("b")]
        XCTAssertEqual(HybridReplay.plan(steps, values: ["deductions": "[]"]).map(\.step.text), ["a", "b"])
        XCTAssertEqual(HybridReplay.plan(steps, values: [:]).map(\.step.text), ["a", "b"])
    }

    func testListValuesAcceptNumbersAndPlainArrays() {
        XCTAssertEqual(HybridReplay.listValue(#"[{"amount": 150000, "section": "80C"}]"#), [["amount": "150000", "section": "80C"]])
        XCTAssertEqual(HybridReplay.listValue(#"["a", "b"]"#), [["value": "a"], ["value": "b"]])
        XCTAssertEqual(HybridReplay.listValue("not a list"), [])
    }

    // MARK: conditions

    func testConditionLanguage() {
        let v = ["regime": "Old", "gains": "0", "name": "Asha", "kids": "2"]
        XCTAssertTrue(HybridReplay.condition("{{regime}} == old", values: v))
        XCTAssertFalse(HybridReplay.condition("{{regime}} != old", values: v))
        XCTAssertFalse(HybridReplay.condition("{{gains}}", values: v), "zero is no")
        XCTAssertTrue(HybridReplay.condition("!{{gains}}", values: v))
        XCTAssertTrue(HybridReplay.condition("{{gains}} || {{kids}}", values: v))
        XCTAssertFalse(HybridReplay.condition("{{name}} && {{gains}}", values: v))
        XCTAssertTrue(HybridReplay.condition(nil, values: v))
        XCTAssertTrue(HybridReplay.condition("  ", values: v))
        XCTAssertFalse(HybridReplay.condition("{{missing}}", values: v))
        XCTAssertTrue(HybridReplay.condition("{{Regime}} == \"old\"", values: v), "names and quotes are loose")
        XCTAssertFalse(HybridReplay.truthy("0.00"))
        XCTAssertFalse(HybridReplay.truthy("None"))
        XCTAssertTrue(HybridReplay.truthy("yes"))
    }

    // MARK: anchors and re-sync

    func testAnchorsMatchPathTitleAndLandmark() {
        let seen = HybridReplay.Observation(url: "http://127.0.0.1:8777/form.html?x=1", title: "Acme Filing · Your details",
                                            text: "Your details\nFull name PAN")
        XCTAssertTrue(HybridReplay.matches(StepAnchor(path: "/form.html"), seen))
        XCTAssertTrue(HybridReplay.matches(StepAnchor(path: "form.html", landmark: "your  DETAILS"), seen))
        XCTAssertFalse(HybridReplay.matches(StepAnchor(path: "/deductions.html"), seen))
        XCTAssertFalse(HybridReplay.matches(StepAnchor(landmark: "Deductions"), seen))
        XCTAssertTrue(HybridReplay.matches(nil, seen))
    }

    func testResyncJumpsForwardWhenAlreadyPastSteps() {
        let steps = [step("username", anchor: StepAnchor(path: "/login.html")), step("password"), step("sign in"),
                     step("full name", anchor: StepAnchor(path: "/form.html")), step("pan")]
        let plan = HybridReplay.plan(steps, values: [:])
        // Already signed in: the session survived from the last pass.
        let onForm = HybridReplay.Observation(url: "http://x/form.html")
        XCTAssertEqual(HybridReplay.resync(plan, current: 0, seen: onForm), 3)
        // Back on the login page when the form was due: a sign-in didn't take.
        let onLogin = HybridReplay.Observation(url: "http://x/login.html")
        XCTAssertEqual(HybridReplay.resync(plan, current: 4, seen: onLogin), 0)
        XCTAssertNil(HybridReplay.resync(plan, current: 0, seen: HybridReplay.Observation(url: "http://x/other.html")))
    }

    func testResyncNeverJumpsOverSomethingIrreversible() {
        let steps = [step("review", anchor: StepAnchor(path: "/review.html")), step("submit", irreversible: true),
                     step("done", anchor: StepAnchor(path: "/done.html"))]
        let plan = HybridReplay.plan(steps, values: [:])
        XCTAssertNil(HybridReplay.resync(plan, current: 1, seen: HybridReplay.Observation(url: "http://x/done.html")))
    }

    func testExpectations() {
        let seen = HybridReplay.Observation(url: "http://x/deductions.html", title: "Deductions", text: "Add one row for each deduction")
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(urlContains: "deductions"), seen), [])
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(urlContains: "review"), seen).count, 1)
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(textContains: "add ONE row"), seen), [])
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(elementGone: ".overlay"), seen, present: { _ in true }).count, 1)
        XCTAssertEqual(HybridReplay.unmet(nil, seen), [])
    }

    func testInterruptsAreFoundByTheirText() {
        let seen = HybridReplay.Observation(text: "We use cookies to keep you signed in. Accept all")
        let found = HybridReplay.interrupts(showing: seen, skill: [])
        XCTAssertEqual(found.first?.clickLabel, "Accept all")
        XCTAssertTrue(HybridReplay.interrupts(showing: HybridReplay.Observation(text: "Your details"), skill: []).isEmpty)
        let learned = InterruptHandler(id: "x", whenText: "rate us", clickLabel: "Close", source: "learned")
        // A learned rule only fires on a popup saying it, never on the same words in the page behind.
        XCTAssertEqual(HybridReplay.interrupts(showing: HybridReplay.Observation(text: "Please rate us"), skill: [learned],
                                               dialogText: "Please rate us!").first?.id, "x")
        XCTAssertNil(HybridReplay.interrupts(showing: HybridReplay.Observation(text: "Please rate us"), skill: [learned]).first { $0.id == "x" })
    }

    func testStaySignedInIsABuiltInRule() {
        let seen = HybridReplay.Observation(text: "Your session will time out in 2 minutes. Do you want to stay signed in?")
        XCTAssertEqual(HybridReplay.interrupts(showing: seen, skill: []).first?.clickLabel, "Stay signed in")
    }

    func testSafeDismissalsNeverPickWhatCouldDoSomething() {
        XCTAssertEqual(HybridReplay.safeDismissal(in: ["Sign out", "Stay signed in"]), "Stay signed in")
        XCTAssertEqual(HybridReplay.safeDismissal(in: ["Show me how", "Maybe later"]), "Maybe later")
        XCTAssertNil(HybridReplay.safeDismissal(in: ["OK", "Continue", "Confirm", "Yes"]))
        XCTAssertNil(HybridReplay.safeDismissal(in: ["Show me how", "Back to my return"]))
        // "Close" only once a step is already stuck behind the popup.
        XCTAssertNil(HybridReplay.safeDismissal(in: ["Close"], generic: false))
        XCTAssertEqual(HybridReplay.safeDismissal(in: ["Close"]), "Close")
    }

    func testDialogKeysIgnoreNumbersThatChange() {
        XCTAssertEqual(HybridReplay.dialogKey("New this year: e-verify in 1 tap"), HybridReplay.dialogKey("New this year: e-verify in 2 taps")?.replacingOccurrences(of: "taps", with: "tap"))
        XCTAssertEqual(HybridReplay.dialogKey("New this year You can now e-verify"), "new this year you")
        XCTAssertNil(HybridReplay.dialogKey("OK"))
    }

    func testTransientErrorsAreTheOnesWorthOneMoreTry() {
        XCTAssertNotNil(HybridReplay.transientError(in: "Review your return\nThe service is busy right now. Please try again."))
        XCTAssertNotNil(HybridReplay.transientError(in: "503 Service Unavailable"))
        XCTAssertNil(HybridReplay.transientError(in: "Review your return\nSomething went wrong"))
        XCTAssertNil(HybridReplay.transientError(in: "PAN should look like ABCDE1234F"))
    }

    func testShownValuesFindDetailsHoweverTheyreWritten() {
        let inputs = [SkillInput(name: "full_name"), SkillInput(name: "pan"), SkillInput(name: "income", kind: "money")]
        let values = ["full_name": "Zoë D'Souza", "pan": "ZDSPD1357N", "income": "1250000"]
        let review = "Review your return\nZOE D'SOUZA · ZDSPD1357N\nIncome ₹12,50,000 · old regime"
        XCTAssertEqual(HybridReplay.shownValues(values, inputs: inputs, on: review).shown, 3)
        let empty = "Review your return\n·\nIncome ₹0 · regime"
        XCTAssertEqual(HybridReplay.shownValues(values, inputs: inputs, on: empty).shown, 0)
        XCTAssertEqual(HybridReplay.shownValues(values, inputs: inputs, on: empty).checked, 3)
    }

    func testAKeptSelectorMustCarryThisPassesValue() {
        XCTAssertTrue(HybridReplay.carries("Seville Andalusia, Spain", all: ["Seville"]))
        XCTAssertFalse(HybridReplay.carries("Thursday, December 10, 2026", all: ["Friday, December 18, 2026"]))
        XCTAssertTrue(HybridReplay.carries("Friday, December 18, 2026", all: ["Friday, December 18, 2026"]))
        XCTAssertFalse(HybridReplay.carries("10", all: ["Friday, December 18, 2026"]))
        XCTAssertFalse(HybridReplay.carries("anything", all: []))
    }

    func testAnswersAreReadAndTokensAreMatched() {
        XCTAssertFalse(HybridReplay.needsReading(SkillInput(name: "ref", example: "REF-448990")))
        XCTAssertTrue(HybridReplay.needsReading(SkillInput(name: "fact_value", example: "658,236 for the city (2025 estimate)")))
        XCTAssertTrue(HybridReplay.needsReading(SkillInput(name: "answer")))
        XCTAssertFalse(HybridReplay.needsReading(SkillInput(name: "x", pattern: "[0-9]+")))
        XCTAssertTrue(HybridReplay.needsReading(SkillInput(name: "price", example: "$189.05")))
        XCTAssertTrue(HybridReplay.needsReading(SkillInput(name: "rating", example: "8.8/10")))
        XCTAssertFalse(HybridReplay.needsReading(SkillInput(name: "pan", example: "ABCPR1234K")))
        XCTAssertFalse(HybridReplay.needsReading(SkillInput(name: "order", example: "112-3456789-1234567")))
    }

    func testARefusalIsANewLineAskingForSomething() {
        let before = "Review your return\nAsha Rao · ABCPR1234K\nI declare that the information above is correct\nSubmit return"
        XCTAssertEqual(HybridReplay.refusal(before: before, after: before + "\nPlease confirm the declaration before filing."),
                       "Please confirm the declaration before filing.")
        // Text that was already there isn't the page's answer; a passing error is retried, not fixed.
        XCTAssertNil(HybridReplay.refusal(before: before, after: before))
        XCTAssertNil(HybridReplay.refusal(before: before, after: before + "\nThe service is busy right now. Please try again."))
    }

    func testResyncBackStartsAtTheFirstStepOfThatPage() {
        // Signed out mid-way: the login page is a fresh one, so the whole sign-in is done again.
        let login = StepAnchor(path: "/login.html")
        var nav = SkillStep.browser("navigate", text: "open", url: "http://x/login.html")
        nav.anchor = login
        let steps = [nav, step("username", anchor: login), step("password", anchor: login), step("sign in", anchor: login),
                     step("name", anchor: StepAnchor(path: "/form.html")), step("add row", anchor: StepAnchor(path: "/deductions.html"))]
        let plan = HybridReplay.plan(steps, values: [:])
        XCTAssertEqual(HybridReplay.resync(plan, current: 5, seen: HybridReplay.Observation(url: "http://x/login.html?expired=1")), 1)
    }

    // MARK: values

    func testRenderMoneyDatesAndCase() {
        XCTAssertEqual(HybridReplay.render("1250000", as: SkillInput(name: "income", kind: "money", format: "indian")), "12,50,000")
        XCTAssertEqual(HybridReplay.render("1250000", as: SkillInput(name: "income", kind: "money", format: "grouped")), "1,250,000")
        XCTAssertEqual(HybridReplay.render("₹12,50,000", as: SkillInput(name: "income", kind: "money", format: "plain")), "1250000")
        XCTAssertEqual(HybridReplay.render("2026-03-31", as: SkillInput(name: "d", kind: "date", format: "dd/MM/yyyy")), "31/03/2026")
        XCTAssertEqual(HybridReplay.render("abcpr1234k", as: SkillInput(name: "pan", format: "upper")), "ABCPR1234K")
        XCTAssertEqual(HybridReplay.render("x", as: nil), "x")
    }

    func testValidation() {
        let pan = SkillInput(name: "pan", description: "PAN", pattern: "[A-Z]{5}[0-9]{4}[A-Z]")
        XCTAssertNil(HybridReplay.invalid("ABCPR1234K", for: pan))
        XCTAssertNotNil(HybridReplay.invalid("ABCPR1234", for: pan))
        XCTAssertNotNil(HybridReplay.invalid("", for: pan))
        XCTAssertNil(HybridReplay.invalid("", for: SkillInput(name: "gains", required: false)))
        XCTAssertNotNil(HybridReplay.invalid("lots", for: SkillInput(name: "income", kind: "money")))
        XCTAssertNotNil(HybridReplay.invalid("maybe", for: SkillInput(name: "regime", choices: ["new", "old"])))
        XCTAssertNil(HybridReplay.invalid("Old", for: SkillInput(name: "regime", choices: ["new", "old"])))
    }

    func testReadBackSurvivesMasks() {
        XCTAssertTrue(HybridReplay.sameValue(typed: "1250000", field: "12,50,000"))
        XCTAssertFalse(HybridReplay.sameValue(typed: "1250000", field: "12,50,00"))
        XCTAssertTrue(HybridReplay.sameValue(typed: "Asha  Rao", field: "asha rao"))
        XCTAssertFalse(HybridReplay.sameValue(typed: "Asha Rao", field: "Asha"))
    }

    func testCaptureByExampleShape() {
        let page = "Return filed. Your reference number is REF-482913. Keep it for your records. Call 1800-123-456."
        XCTAssertEqual(HybridReplay.capture(in: page, example: "REF-448990"), "REF-482913")
        XCTAssertNil(HybridReplay.capture(in: "no reference yet", example: "REF-448990"))
        XCTAssertEqual(HybridReplay.capture(in: page, example: nil, pattern: "\\d{4}-\\d{3}-\\d{3}"), "1800-123-456")
        XCTAssertNil(HybridReplay.capture(in: "REF-1234567", example: "REF-448990"), "the length is part of the shape")
    }

    // MARK: gate

    func testPausesOnlyWhenUnsureBeforeIrreversibleSteps() {
        let skill = Skill(accountID: "a", name: "file", summary: "")
        var submit = step("Submit return"); submit.irreversible = true
        let calm = HybridReplay.PassDoubts()
        XCTAssertNil(HybridReplay.pauseReasons(before: submit, skill: skill, doubts: calm))
        XCTAssertNil(HybridReplay.pauseReasons(before: step("continue"), skill: skill,
                                               doubts: HybridReplay.PassDoubts(values: ["pan": "low confidence"])))
        let unsure = HybridReplay.PassDoubts(values: ["pan": "low confidence (0.4)"], helped: ["type income"])
        XCTAssertEqual(HybridReplay.pauseReasons(before: submit, skill: skill, doubts: unsure)?.count, 2)
        var money = skill; money.alwaysConfirm = true
        XCTAssertNotNil(HybridReplay.pauseReasons(before: submit, skill: money, doubts: calm))
    }

    // MARK: format

    func testV1SkillsStayV1AndV2RoundTrips() throws {
        let plain = Skill(accountID: "a", name: "weather", summary: "", steps: [SkillStep(text: "type", app: "Safari", action: "type", input: "x")])
        let v1 = SkillBundle.make(from: plain)
        XCTAssertEqual(v1.version, 1)
        XCTAssertNil(v1.skill)
        XCTAssertFalse(String(data: try v1.encoded(), encoding: .utf8)!.contains("\"skill\""))

        var rich = plain
        rich.inputs = [SkillInput(name: "pan", description: "PAN", pattern: "[A-Z]{5}[0-9]{4}[A-Z]", sensitive: true)]
        rich.intent = "file a return"
        rich.steps[0].when = "{{pan}}"
        rich.steps[0].expect = StepExpectation(urlContains: "review")
        let v2 = SkillBundle.make(from: rich)
        XCTAssertEqual(v2.version, 2)
        let decoded = try SkillBundle.decode(v2.encoded())
        XCTAssertEqual(decoded.skill?.inputs?.first?.name, "pan")
        XCTAssertEqual(decoded.steps.first?.when, "{{pan}}")
        XCTAssertEqual(decoded.steps.first?.expect?.urlContains, "review")
        var installed = Skill(accountID: "a", name: decoded.name, summary: "", steps: decoded.installableSteps())
        decoded.skill?.apply(to: &installed)
        XCTAssertEqual(installed.intent, "file a return")
    }

    func testOldStateDecodesWithoutV2Fields() throws {
        let json = #"{"id":"s","accountID":"a","name":"n","summary":"","steps":[{"id":"1","text":"t","app":"Safari"}],"createdAt":"2026-01-01T00:00:00Z","source":"watch me","runCount":0}"#
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let skill = try decoder.decode(Skill.self, from: Data(json.utf8))
        XCTAssertNil(skill.inputs)
        XCTAssertNil(skill.steps[0].when)
    }

    func testATemplateNeedsNoRecordedSteps() throws {
        var template = Skill(accountID: "a", name: "flights", summary: "")
        template.template = true
        template.outline = ["open google flights", "type {{from}}"]
        let decoded = try SkillBundle.decode(SkillBundle.make(from: template).encoded())
        XCTAssertEqual(decoded.skill?.outline?.count, 2)
    }

    func testGivenEmptyIsAnAnswerAndAbsentIsMissing() {
        let inputs = [SkillInput(name: "pan"), SkillInput(name: "gains", kind: "money"), SkillInput(name: "rows", kind: "list", required: false)]
        let given = SkillBinder.finish(label: "Asha", values: ["pan": "ABCPR1234K", "gains": "", "rows": "[]"], inputs: inputs, optionalByUse: ["gains"])
        XCTAssertEqual(given.missing, [])
        XCTAssertEqual(given.doubts, [:])
        let absent = SkillBinder.finish(label: "Asha", values: ["gains": ""], inputs: inputs)
        XCTAssertEqual(absent.missing, ["pan"])
        XCTAssertEqual(absent.doubts["gains"], "it's empty")
    }

    func testBinderMatchesGivenNamesLoosely() {
        let inputs = [SkillInput(name: "full_name"), SkillInput(name: "annual_income"), SkillInput(name: "tax_regime", kind: "choice", choices: ["New regime", "Old regime"])]
        let (matched, leftover) = SkillBinder.match(["name": "Asha Rao", "income": "1250000", "regime": "new", "ref": "Asha", "colour": "red"], to: inputs)
        XCTAssertEqual(matched, ["full_name": "Asha Rao", "annual_income": "1250000", "tax_regime": "new"])
        XCTAssertEqual(leftover, ["colour": "red"])
        XCTAssertEqual(SkillBinder.choice("new", in: inputs[2].choices), "New regime")
        XCTAssertEqual(SkillBinder.folder(for: "Neha", in: ["family/Neha", "family/Jay"]), "family/Neha")
        XCTAssertEqual(SkillBinder.folder(for: "Neha Shah", in: ["Neha"]), "Neha")
        XCTAssertNil(SkillBinder.folder(for: "Amit", in: ["Neha"]))
        XCTAssertEqual(SkillBinder.csvRows("name,amount\n\"Rao, Asha\",\"1,000\"\n").first, ["name": "Rao, Asha", "amount": "1,000"])
    }

    /// "file for Ezra … deductions 80C 150000 and 80D 50000": the router hands the list over in words. It must
    /// not bind as a list with no entries (that filed Ezra's return without deductions); it's left for the resolver.
    func testAListGivenInWordsIsLeftForTheResolverNotBoundAsEmpty() {
        let inputs = [SkillInput(name: "deductions", kind: "list", fields: ["section", "amount"], required: false), SkillInput(name: "pan")]
        let words = SkillBinder.match(["deductions": "80C 150000 and 80D 50000", "pan": "EZTPT2468M"], to: inputs)
        XCTAssertNil(words.matched["deductions"])
        XCTAssertEqual(words.leftover["deductions"], "80C 150000 and 80D 50000")
        XCTAssertEqual(words.matched["pan"], "EZTPT2468M")
        let json = SkillBinder.match(["deductions": #"[{"section":"80C","amount":"150000"}]"#], to: inputs)
        XCTAssertEqual(json.matched["deductions"], #"[{"section":"80C","amount":"150000"}]"#)
        XCTAssertEqual(SkillBinder.match(["deductions": "none"], to: inputs).matched["deductions"], "[]")
    }

    func testChoicesMatchValuesWrittenAnotherWay() {
        let sections = ["Choose…", "80C", "80D", "80G", "24B"]
        XCTAssertEqual(SkillBinder.choice("24(b)", in: sections), "24B")
        XCTAssertEqual(SkillBinder.choice("80 c", in: sections), "80C")
        XCTAssertEqual(SkillBinder.choice("Old", in: ["New regime", "Old regime"]), "Old regime")
        XCTAssertEqual(SkillBinder.choice("80", in: sections), "80", "ambiguous stays as given")
    }

    func testLoopSelectorsDropOnesThatOnlyFindTheFirstRow() {
        let rows = [["#amount-1", "text=input|Amount", "role=textbox|Amount 1"], ["#amount-2", "text=input|Amount", "role=textbox|Amount 2"]]
        XCTAssertEqual(SkillPromoter.template(rows), ["#amount-{{item.index}}", "role=textbox|Amount {{item.index}}"])
        XCTAssertEqual(SkillPromoter.template([["#add", "role=button|Add"], ["#add", "role=button|Add"]]), ["#add", "role=button|Add"])
    }
}
