import XCTest
@testable import OkidokiCore

final class SkillCompilerTests: XCTestCase {
    private let base = "http://127.0.0.1:8777"

    /// The run the agent did for Asha: sign in, name, PAN, income, regime, continue, continue, submit.
    private func ashaRun() -> Skill {
        func b(_ action: String, _ label: String?, _ input: String?, _ page: String, after: String? = nil) -> SkillStep {
            var step = SkillStep.browser(action, text: BrowserSteps.line(action, label: label, input: input), url: "\(base)/\(page)",
                                         selectors: ["#x"], label: label, input: input)
            if let after { step.observedAfter = StepObservation(url: "\(base)/\(after)", landmarks: [after == "form.html" ? "Your details" : after]) }
            return step
        }
        let steps = [
            BrowserSteps.navigate("\(base)/login.html"),
            b("type", "Username", "eval", "login.html"),
            b("type", "Password", "{{vault:127.0.0.1.password}}", "login.html"),
            b("click", "Sign in", nil, "login.html", after: "form.html"),
            b("type", "Full name", "Asha Rao", "form.html"),
            b("type", "PAN", "ABCPR1234K", "form.html"),
            b("type", "Annual income (₹)", "1250000", "form.html"),
            b("select", "Tax regime", "New regime", "form.html"),
            b("click", "Continue", nil, "form.html", after: "deductions.html"),
            b("click", "Continue", nil, "deductions.html", after: "review.html"),
            b("click", "Submit return", nil, "review.html", after: "done.html"),
        ]
        return Skill(accountID: "a", name: "acme filing", summary: "", steps: steps)
    }

    private func compiled() -> CompiledSkill {
        CompiledSkill(
            intent: "file an income tax return for a person on Acme Filing", itemNoun: "person",
            inputs: [
                SkillInput(name: "name", description: "full name", example: "Asha Rao"),
                SkillInput(name: "pan", description: "PAN", pattern: "[A-Z]{5}[0-9]{4}[A-Z]", example: "ABCPR1234K"),
                SkillInput(name: "income", description: "annual income", kind: "money", format: "plain", example: "1250000"),
                SkillInput(name: "regime", description: "tax regime", kind: "choice", choices: ["New regime", "Old regime"]),
                SkillInput(name: "gains", description: "capital gains", kind: "money", required: false),
                SkillInput(name: "deductions", description: "deductions", kind: "list", fields: ["section", "amount"], required: false),
                SkillInput(name: "unused", description: "nothing types this"),
            ],
            substitutions: [.init(step: 4, input: "{{name}}"), .init(step: 7, input: "{{regime}}"), .init(step: 2, input: "{{oops}}")],
            thinkSteps: [.init(before: 8, goal: "Tick 'I sold shares' and type {{gains}} in Capital gains", when: "{{gains}}"),
                         .init(before: 9, goal: "For each entry in {{deductions}}, click 'Add deduction' and fill its section and amount", when: "{{deductions}}")],
            irreversible: [10],
            capture: .init(name: "reference", example: "REF-448990", description: "reference number"))
    }

    func testACaptureDescribedWithItsOwnArticleReadsOnce() throws {
        var answer = compiled()
        answer.capture = .init(name: "reference_number", example: "REF-1", description: "The reference number shown on the 'Return filed' page")
        let smart = try XCTUnwrap(SkillCompiler.apply(answer, to: ashaRun()))
        XCTAssertEqual(smart.steps.last?.text, "read the reference number shown on the 'Return filed' page")
    }

    func testARunBecomesASmartSkill() throws {
        let smart = try XCTUnwrap(SkillCompiler.apply(compiled(), to: ashaRun()))
        let inputs = smart.steps.map(\.input)
        XCTAssertEqual(inputs[4], "{{name}}")
        XCTAssertEqual(inputs[5], "{{pan}}", "the PAN example was left literal; it gets its placeholder anyway")
        XCTAssertEqual(inputs[6], "{{income}}")
        XCTAssertEqual(inputs[7], "{{regime}}")
        XCTAssertEqual(inputs[2], "{{vault:127.0.0.1.password}}", "a vault secret is never replaced")
        XCTAssertEqual(inputs[1], "eval", "the account's username stays")
        XCTAssertFalse(smart.steps.contains { ($0.input ?? "").contains("Asha") || ($0.input ?? "").contains("ABCPR") })
        XCTAssertEqual(smart.steps[4].text, "type “{{name}}” in “Full name”")

        let thinks = smart.steps.enumerated().filter { $0.element.mode == "think" }
        XCTAssertEqual(thinks.map(\.offset), [8, 10], "each goes right before the step that leaves its page")
        XCTAssertEqual(thinks.map(\.element.when), ["{{gains}}", "{{deductions}}"])
        XCTAssertEqual(smart.steps.last?.capture, "reference")
        XCTAssertEqual(smart.steps.last?.text, "read the reference number")
        XCTAssertEqual(smart.steps.first { $0.text.hasPrefix("click “Submit") }?.irreversible, true)

        XCTAssertEqual(Set(smart.inputs?.map(\.name) ?? []), ["name", "pan", "income", "regime", "gains", "deductions", "reference"])
        XCTAssertEqual(smart.intent, "file an income tax return for a person on Acme Filing")
    }

    func testAnchorsAndChecksComeFromTheRun() throws {
        let smart = try XCTUnwrap(SkillCompiler.apply(compiled(), to: ashaRun()))
        let name = try XCTUnwrap(smart.steps.first { $0.input == "{{name}}" })
        XCTAssertEqual(name.anchor?.path, "/form.html")
        let pan = try XCTUnwrap(smart.steps.first { $0.input == "{{pan}}" })
        XCTAssertNil(pan.anchor?.landmark, "only the first step on a page gets the landmark seen on arrival")
        let signIn = try XCTUnwrap(smart.steps.first { $0.label == "Sign in" })
        XCTAssertEqual(signIn.expect?.urlContains, "form.html")
        let firstOnForm = try XCTUnwrap(smart.steps.firstIndex { $0.input == "{{name}}" })
        XCTAssertEqual(smart.steps[firstOnForm].anchor?.landmark, "Your details")
        let submit = try XCTUnwrap(smart.steps.first { $0.irreversible == true })
        XCTAssertEqual(submit.expect?.urlContains, "done.html", "the read step after it sits on the page it led to")
    }

    func testPassesFollowEachPersonsData() throws {
        let smart = try XCTUnwrap(SkillCompiler.apply(compiled(), to: ashaRun()))
        let asha = HybridReplay.plan(smart.steps, values: ["gains": "", "deductions": "[]"])
        XCTAssertFalse(asha.contains { $0.step.mode == "think" }, "Asha needs no model at all")
        let bharat = HybridReplay.plan(smart.steps, values: ["gains": "", "deductions": #"[{"section":"80C","amount":"150000"}]"#])
        XCTAssertEqual(bharat.filter { $0.step.mode == "think" }.count, 1)
    }

    func testUnknownPlaceholdersAndBrokenLoopsKeepTheSkillAsRecorded() {
        var bad = compiled()
        bad.substitutions.append(.init(step: 5, input: "{{who_knows}}"))
        XCTAssertNil(SkillCompiler.apply(bad, to: ashaRun()))

        var loop = compiled()
        loop.loops = [.init(start: 4, length: 2, over: "name")]
        XCTAssertNil(SkillCompiler.apply(loop, to: ashaRun()), "loops must run over a list input")

        var overlap = compiled()
        overlap.loops = [.init(start: 4, length: 3, over: "deductions"), .init(start: 5, length: 2, over: "deductions")]
        XCTAssertNil(SkillCompiler.apply(overlap, to: ashaRun()))

        var past = compiled()
        past.conditions = [.init(step: 99, when: "{{gains}}")]
        XCTAssertNil(SkillCompiler.apply(past, to: ashaRun()))
    }

    func testLoopsMarkTheirBlock() throws {
        var withLoop = compiled()
        withLoop.loops = [.init(start: 5, length: 2, over: "deductions")]
        withLoop.substitutions = [.init(step: 5, input: "{{item.section}}"), .init(step: 6, input: "{{item.amount}}")]
        let smart = try XCTUnwrap(SkillCompiler.apply(withLoop, to: ashaRun()))
        let start = try XCTUnwrap(smart.steps.first { $0.repeatOver != nil })
        XCTAssertEqual(start.repeatOver, "deductions")
        XCTAssertEqual(start.repeatLength, 2)

        var outside = compiled()
        outside.substitutions = [.init(step: 9, input: "{{item.amount}}")]
        XCTAssertNil(SkillCompiler.apply(outside, to: ashaRun()), "item fields only exist inside a loop")
    }

    func testBareNamesAndYesConditionsMeanTheObvious() throws {
        var sloppy = compiled()
        sloppy.substitutions = [.init(step: 4, input: "name"), .init(step: 5, input: " pan ")]
        sloppy.conditions = [.init(step: 6, when: "{{gains}} == yes")]
        let smart = try XCTUnwrap(SkillCompiler.apply(sloppy, to: ashaRun()))
        XCTAssertEqual(smart.steps[4].input, "{{name}}")
        XCTAssertEqual(smart.steps[5].input, "{{pan}}")
        XCTAssertEqual(smart.steps[6].when, "{{gains}}")
        XCTAssertTrue(smart.inputs?.contains { $0.name == "name" } ?? false)
    }

    func testCompileNeverDropsTypingOrSigningIn() throws {
        var greedy = compiled()
        greedy.drop = [1, 2, 9]
        let smart = try XCTUnwrap(SkillCompiler.apply(greedy, to: ashaRun()))
        XCTAssertTrue(smart.steps.contains { $0.label == "Username" })
        XCTAssertTrue(smart.steps.contains { $0.label == "Password" })
        XCTAssertEqual(smart.steps.filter { $0.label == "Continue" }.count, 1, "a stray click may go")
    }

    func testAClickNamedAfterAValueFollowsTheValue() throws {
        var run = ashaRun()
        var suggestion = SkillStep.browser("click", text: "click “Asha Rao (you)”", url: "\(base)/form.html",
                                           selectors: ["role=option|Asha Rao (you)", "#opt-3"], label: "Asha Rao (you)")
        suggestion.role = "option"
        run.steps.insert(suggestion, at: 5)
        var answer = compiled()
        answer.substitutions = [.init(step: 4, input: "{{name}}")]
        let smart = try XCTUnwrap(SkillCompiler.apply(answer, to: run))
        let picked = try XCTUnwrap(smart.steps.first { $0.role == "option" })
        XCTAssertEqual(picked.label, "{{name}} (you)")
        XCTAssertEqual(picked.selectors, ["role=option|{{name}} (you)", "#opt-3"])
        XCTAssertEqual(ParameterFill.fill(picked.selectors![0], values: ["name": "Bharat Mehta"]).text, "role=option|Bharat Mehta (you)")
    }

    func testMacStepsReadWithTheirPlaceholders() throws {
        let steps = [SkillStep(text: "in Numbers, click “Name”", app: "Numbers", action: "click", label: "Name"),
                     SkillStep(text: "in Numbers, type “Asha Rao”", app: "Numbers", action: "type", input: "Asha Rao")]
        let skill = Skill(accountID: "a", name: "row", summary: "", steps: steps)
        let answer = CompiledSkill(intent: "add a row", inputs: [SkillInput(name: "name", description: "name", example: "Asha Rao")],
                                   substitutions: [.init(step: 1, input: "{{name}}")])
        let smart = try XCTUnwrap(SkillCompiler.apply(answer, to: skill))
        XCTAssertEqual(smart.steps[1].text, "in Numbers, type “{{name}}”")
        XCTAssertNil(smart.steps[1].anchor, "Mac steps keep finding controls the way they always have")
    }

    func testTheRequestNeverCarriesPasswords() {
        var steps = ashaRun().steps
        steps[2].role = "password"
        steps[2].input = "hunter2"
        let body = SkillCompiler.request(goal: "file", summary: "done", surface: "browser", steps: steps)
        let rows = body["steps"] as? [[String: Any]] ?? []
        XCTAssertNil(rows[2]["input"])
        XCTAssertEqual(rows[4]["input"] as? String, "Asha Rao")
    }

    func testDescribe() throws {
        let smart = try XCTUnwrap(SkillCompiler.apply(compiled(), to: ashaRun()))
        XCTAssertEqual(SkillCompiler.describe(smart), "6 values change per person · 2 steps only when needed · 2 parts it works out each time")
    }

    func testAReadingThinkStepAtTheEndBecomesACapture() {
        XCTAssertTrue(SkillCompiler.onlyReads("On the YouTube results page for {{query}}, read the top five organic results (skip ads) and report each one's title"))
        XCTAssertFalse(SkillCompiler.onlyReads("For each entry in {{deductions}}, click 'Add deduction' and type its amount"))
    }
}

final class SkillCompilerFinishingTests: XCTestCase {
    func testARequestForAnAnswerAlwaysEndsWithARead() {
        var skill = Skill(accountID: "a", name: "reveal", summary: "", steps: [
            BrowserSteps.navigate("https://the-internet.herokuapp.com/dynamic_loading/2"),
            SkillStep.browser("click", text: "click “Start”", url: "https://the-internet.herokuapp.com/dynamic_loading/2", selectors: ["#start button"]),
        ])
        skill.inputs = [SkillInput(name: "last_name", description: "", kind: "text", example: "Bach")]
        let made = SkillCompiler.finishing(skill, goal: "press Start and tell me the text for Bach")
        XCTAssertEqual(made.steps.last?.action, "read")
        XCTAssertEqual(made.steps.last?.capture, "answer")
        XCTAssertTrue(made.steps.last?.text.contains("{{last_name}}") == true, made.steps.last?.text ?? "")
        // Already reading: nothing added. Not a question: nothing added.
        XCTAssertEqual(SkillCompiler.finishing(made, goal: "tell me the text").steps.count, made.steps.count)
        XCTAssertEqual(SkillCompiler.finishing(skill, goal: "press Start").steps.count, 2)
    }

    func testAPasswordFromTheRequestIsASensitiveInput() {
        let skill = Skill(accountID: "a", name: "sign in", summary: "", steps: [
            SkillStep.browser("type", text: "type the password", url: "https://x.example/login", selectors: ["#password"], input: "{{password}}"),
        ])
        let made = SkillCompiler.finishing(skill, goal: "sign in with password hunter22")
        let input = made.inputs?.first { $0.name == "password" }
        XCTAssertEqual(input?.sensitive, true)
        XCTAssertNil(input?.example)
    }
}

final class SkillCompilerUndeclaredTests: XCTestCase {
    func testAPlaceholderAReadStepUsesGetsAnInput() {
        var read = SkillStep(text: "read the email of the row whose Last Name is {{last_name}}", app: "", action: "read")
        read.capture = "email"
        let skill = Skill(accountID: "a", name: "t", summary: "", steps: [BrowserSteps.navigate("https://x.example/tables"), read])
        let made = SkillCompiler.finishing(skill, goal: "what is the email of Bach?")
        XCTAssertTrue(made.inputs?.contains { $0.name == "last_name" } == true)
    }

    func testCarriesWholeWordsOnly() {
        XCTAssertFalse(HybridReplay.carries("Female", all: ["Male"]))
        XCTAssertTrue(HybridReplay.carries("Male", all: ["male"]))
        XCTAssertTrue(HybridReplay.carries("Lisbon, Portugal · 12–14 Dec", all: ["Lisbon"]))
        XCTAssertFalse(HybridReplay.carries("Category 12", all: ["1"]))
    }
}

/// The rule-based tidying of steps that can't work a second time — the ones that were spending a model
/// call per attempt on Google Flights, because their selectors named the value chosen the first time.
final class SkillCompilerPruneTests: XCTestCase {
    private func selectors() -> [String] {
        ["role=combobox|Round trip", "text=div|Round trip",
         "div:nth-of-type(1) > div:nth-of-type(1) > div > div > div > div:nth-of-type(1)"]
    }
    private func select(_ chosen: String) -> SkillStep {
        .browser("select", text: "choose “\(chosen)” in the field", url: "https://www.google.com/travel/flights",
                 selectors: selectors(), input: chosen)
    }
    private func type(_ placeholder: String) -> SkillStep {
        .browser("type", text: "type “{{\(placeholder)}}” in “Where from?”", url: "https://www.google.com/travel/flights",
                 selectors: ["input[aria-label=\"Where from?\"]"], label: "Where from?", input: "{{\(placeholder)}}")
    }

    func testAChoiceKeepsTheSelectorsThatIdentifyTheControlAndLosesTheOnesReadOffItsValue() {
        // "role=combobox|Round trip" can only match while the control still reads "Round trip".
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [select("One way"), type("origin")]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertEqual(pruned.steps.count, 2, "the choice itself is kept: it sets the trip type")
        let kept = pruned.steps[0].selectors ?? []
        XCTAssertFalse(kept.contains { $0.contains("Round trip") }, "value-read selectors go: \(kept)")
        XCTAssertTrue(kept.contains { $0.contains("nth-of-type") }, "the structural one stays: \(kept)")
    }

    func testTheSameControlChosenTwiceInARowIsOneChoice() {
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [select("One way"), select("One way"), type("origin")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 2)
    }

    func testMenuWalkKeysStraightAfterAChoiceAreDropped() {
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        let down = SkillStep.browser("press", text: "press ArrowDown", url: "https://www.google.com/travel/flights", input: "ArrowDown")
        let tab = SkillStep.browser("press", text: "press Tab", url: "https://www.google.com/travel/flights", input: "Tab")
        skill.steps = [select("One way"), down, tab, type("origin")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.map(\.action), ["select", "type"])
    }

    func testAKeyPressThatIsTheJobIsKept() {
        var skill = Skill(accountID: "a", name: "search", summary: "")
        skill.steps = [type("query"), .browser("press", text: "press return", url: "https://example.com", input: "return")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 2)
    }

    func testALearnedTripsBuiltUrlGoesWhenATemplatedOneCanFlyOtherRoutes() {
        let built = SkillStep.browser("navigate", text: "navigate", url: "https://www.google.com/travel/flights/search?tfs=CBwQARoj",
                                      input: "https://www.google.com/travel/flights/search?tfs=CBwQARoj")
        let templated = SkillStep.browser("navigate", text: "navigate",
                                          url: "https://www.google.com/travel/flights?q=from+{{origin}}+to+{{destination}}",
                                          input: "https://www.google.com/travel/flights?q=from+{{origin}}+to+{{destination}}")
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [built, templated]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertEqual(pruned.steps.count, 1)
        XCTAssertTrue((pruned.steps.first?.url ?? "").contains("{{origin}}"))
    }

    func testANavigateWithNoAddressIsDropped() {
        var skill = Skill(accountID: "a", name: "x", summary: "")
        skill.steps = [.browser("navigate", text: "navigate", url: ""), type("origin")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.map(\.action), ["type"])
    }

    func testTheTidyRunsOnEveryCompiledSkill() {
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [select("One way"), type("origin")]
        let finished = SkillCompiler.finishing(skill, goal: "search flights")
        XCTAssertFalse((finished.steps.first?.selectors ?? []).contains { $0.contains("Round trip") })
    }
}

extension SkillCompilerPruneTests {
    func testAWholeSearchInTheAddressReplacesTheTypingBeforeIt() {
        let learn = SkillStep.browser("navigate", text: "navigate", url: "https://www.google.com/travel/flights#flt=SFO.LIS.2026-12-18",
                                      input: "https://www.google.com/travel/flights#flt=SFO.LIS.2026-12-18")
        let choose = SkillStep.browser("select", text: "choose “One way”", url: "https://www.google.com/travel/flights",
                                       selectors: ["div:nth-of-type(1)"], input: "One way")
        let typed = SkillStep.browser("type", text: "type “San Francisco”", url: "https://www.google.com/travel/flights",
                                      selectors: ["#from"], input: "San Francisco")
        let templated = SkillStep.browser("navigate", text: "navigate",
                                          url: "https://www.google.com/travel/flights?q=flights+from+{{origin}}+to+{{destination}}+on+{{departure_date}}",
                                          input: "https://www.google.com/travel/flights?q=flights+from+{{origin}}+to+{{destination}}+on+{{departure_date}}")
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [learn, choose, typed, templated]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertEqual(pruned.steps.map(\.action), ["navigate"], "only the address that can fly other routes is left")
        XCTAssertTrue((pruned.steps.first?.url ?? "").contains("{{origin}}"))
    }

    func testALiteralValueTheSkillAlwaysUsesBecomesItsDefaultNotAQuestion() throws {
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [.browser("navigate", text: "navigate", url: "https://x.example?c={{cabin}}&n={{adults}}",
                                input: "https://x.example?c={{cabin}}&n={{adults}}")]
        // No source: the skill always flies economy for one adult. A value that comes from the request or a
        // document is never assumed (see testADocumentValueIsNeverDefaultedToTheRecordedPersons).
        skill.inputs = [SkillInput(name: "cabin", kind: "text", required: true, example: "economy"),
                        SkillInput(name: "adults", kind: "number", required: true, example: "1")]
        let finished = SkillCompiler.finishing(skill, goal: "book a flight")
        let cabin = try XCTUnwrap(finished.inputs?.first { $0.name == "cabin" })
        XCTAssertEqual(cabin.value, "economy")
        XCTAssertFalse(cabin.isRequired, "a value the recording decided is not a question")
        // A pass with only the route still binds: the defaults fill the rest.
        let bound = SkillBinder.finish(label: "trip", values: ["origin": "SFO", "destination": "LIS"], inputs: finished.inputs ?? [])
        XCTAssertEqual(bound.missing, [])
        XCTAssertEqual(bound.values["cabin"], "economy")
    }
}

extension SkillCompilerPruneTests {
    func testACalendarWalkBecomesOneStepThatSetsTheDate() {
        // Recorded: click Departure → Next → "12" → "Done. Search…". The second pass must not click the
        // same day again; it should set its own date.
        func click(_ label: String) -> SkillStep {
            .browser("click", text: "click “\(label)”", url: "https://www.google.com/travel/flights",
                     selectors: ["role=button|\(label)"], label: label)
        }
        var date = SkillStep.browser("type", text: "type “{{departure_date}}” in “Departure”",
                                     url: "https://www.google.com/travel/flights",
                                     selectors: ["input[placeholder=\"Departure\"]"], label: "Departure", input: "{{departure_date}}")
        date.action = "click"
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [date, click("Next"), click("12"),
                       click("Done. Search for one-way flights, departing on January 12, 2027"), click("Search")]
        let pruned = SkillCompiler.pruneStale(skill)
        let actions = pruned.steps.map(\.action)
        XCTAssertFalse(actions.contains("12"), "the day this run picked is gone: \(actions)")
        XCTAssertTrue(pruned.steps.contains { $0.mode == "think" && $0.text.contains("date picker") },
                      "the walk is replaced by one step that sets the date")
        XCTAssertTrue(actions.contains("click"), "Search is still there: \(actions)")
    }

    func testAClickOnANumberThatIsNotACalendarIsKept() {
        var skill = Skill(accountID: "a", name: "pick a quantity", summary: "")
        skill.steps = [.browser("click", text: "click “2”", url: "https://shop.example/cart",
                                selectors: ["#qty-2"], label: "2")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 1, "no date field anywhere: nothing to replace")
    }
}

/// Which think steps are really one button press — the model is paid per replay for these otherwise.
final class SkillCompilerSingleControlTests: XCTestCase {
    func testAClickOnOneNamedControlIsMechanical() {
        XCTAssertEqual(SkillCompiler.singleControl(in: "Click the 'Stops' filter button."), "Stops")
        XCTAssertEqual(SkillCompiler.singleControl(in: "Open the “Filters” panel."), "Filters")
    }

    func testAnythingNeedingJudgementStaysAThinkStep() {
        // A value to type or choose.
        XCTAssertNil(SkillCompiler.singleControl(in: "Click 'Where from?' and type {{origin}}."))
        XCTAssertNil(SkillCompiler.singleControl(in: "Choose 'Nonstop only' from the Stops menu."))
        // Two jobs in one step.
        XCTAssertNil(SkillCompiler.singleControl(in: "Click the 'Stops' filter button, then choose 'Nonstop only'."))
        // Two controls named.
        XCTAssertNil(SkillCompiler.singleControl(in: "Click 'Stops' then 'Nonstop only'."))
        // A list.
        XCTAssertNil(SkillCompiler.singleControl(in: "For each row, click 'Edit'."))
        // Nothing to press at all.
        XCTAssertNil(SkillCompiler.singleControl(in: "Work out the cheapest nonstop fare on this page."))
    }
}

extension SkillCompilerPruneTests {
    /// The exact shape a rescue promoted on Google Flights, which was written back and kept costing a
    /// model call on every replay after it.
    func testAPromotedDatePickerWalkIsPrunedOnWriteBack() {
        func click(_ label: String) -> SkillStep {
            var s = SkillStep.browser("click", text: "click “\(label)”", url: "https://www.google.com/travel/flights",
                                      selectors: ["role=button|\(label)"], label: label)
            return s
        }
        var thinking = SkillStep(text: "Set “Done. Search…December 18, 2026” to the date this run used with the page's date picker", app: "", action: "think")
        thinking.mode = "think"
        var departure = click("Departure")
        departure.action = "click"
        let steps = [click("Departure"), click("12"),
                     click("Done. Search for one-way flights, departing on December 18, 2026"),
                     click("Done. Search for one-way flights, departing on December 18, 2026")]
        let pruned = SkillCompiler.pruneStale(steps: steps)
        let labels = pruned.map { $0.label ?? $0.text }
        XCTAssertFalse(labels.contains("12"), "the day this run picked is gone: \(labels)")
        XCTAssertTrue(pruned.contains { $0.mode == "think" }, "replaced with one step that sets the date")
        // Running it twice is a no-op: a replay that heals and writes back must not grow the skill.
        XCTAssertEqual(SkillCompiler.pruneStale(steps: pruned).count, pruned.count)
    }
}

/// A typed literal that is really the learned trip's own value must become a placeholder, or every replay
/// travels to the city the recording used.
final class SkillCompilerLiteralInputTests: XCTestCase {
    private func typed(_ value: String, into label: String) -> SkillStep {
        .browser("type", text: "type “\(value)” in “\(label)”", url: "https://www.google.com/travel/flights",
                 selectors: ["input[aria-label=\"\(label)\"]"], label: label, input: value)
    }

    private func skill(_ steps: [SkillStep]) -> Skill {
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = steps
        s.inputs = [SkillInput(name: "origin", description: "departure city", kind: "text", source: "request", example: "SFO"),
                    SkillInput(name: "destination", description: "arrival city", kind: "text", source: "request", example: "LIS"),
                    SkillInput(name: "depart_date", description: "departure date", kind: "date", source: "request", example: "2026-12-18"),
                    SkillInput(name: "cheapest_nonstop_fare", description: "the cheapest nonstop fare", kind: "text",
                               source: "page", example: "$2,492 TAP")]
        return s
    }

    func testACityTypedAsItsFullNameBecomesItsPlaceholder() {
        // The compiled input's example is "SFO" but the step types "San Francisco": without this the
        // replay flew the recorded cities every time.
        let finished = SkillCompiler.finishing(skill([typed("San Francisco", into: "Where from?"),
                                                      typed("Lisbon", into: "Where to?")]),
                                               goal: "search flights")
        let inputs = finished.steps.map(\.input)
        XCTAssertTrue(inputs.contains("{{origin}}"), "\(inputs)")
        XCTAssertTrue(inputs.contains("{{destination}}"), "\(inputs)")
        XCTAssertFalse(inputs.contains("San Francisco"))
        XCTAssertFalse(inputs.contains("Lisbon"))
    }

    func testAValueThatIsNotOneOfTheInputsIsLeftAlone() {
        // "1" for the passenger count with no such input is a real literal, not a placeholder.
        let finished = SkillCompiler.finishing(skill([typed("1 adult", into: "Passengers")]), goal: "search flights")
        XCTAssertEqual(finished.steps.last?.input, "1 adult")
    }

    func testASecretStepIsNeverRewritten() {
        let secret = SkillStep.browser("type", text: "type the password", url: "https://x.example",
                                       selectors: ["#pw"], label: "Password", input: "{{vault:x.example.password}}")
        let finished = SkillCompiler.finishing(skill([secret]), goal: "sign in")
        // The skill also gains a leading navigate (a browser skill opens its own page), so look the step up.
        let passwordStep = finished.steps.first { $0.action == "type" }
        XCTAssertEqual(passwordStep?.input, "{{vault:x.example.password}}")
    }
}

extension SkillCompilerLiteralInputTests {
    func testAValueTheSkillTypesForThePassIsNotSeededWithTheLearnedExample() {
        // Origin and destination are typed for every pass: seeding them with the recorded trip made the
        // replay fly San Francisco→Lisbon no matter what it was asked for.
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = [typed("{{origin}}", into: "Where from?"), typed("{{destination}}", into: "Where to?")]
        s.inputs = [SkillInput(name: "origin", description: "departure city", kind: "text", source: "request", example: "San Francisco"),
                    SkillInput(name: "destination", description: "arrival city", kind: "text", source: "request", example: "Lisbon"),
                    // No source: the skill always flies economy. A request-sourced value is the pass's own.
                    SkillInput(name: "cabin", description: "cabin class", kind: "text", example: "economy")]
        let finished = SkillCompiler.finishing(s, goal: "search flights")
        let byName = Dictionary(uniqueKeysWithValues: (finished.inputs ?? []).map { ($0.name, $0) })
        XCTAssertNil(byName["origin"]?.value, "a typed-for-the-pass value keeps the pass's own value")
        XCTAssertNil(byName["destination"]?.value)
        XCTAssertEqual(byName["cabin"]?.value, "economy", "a value never typed is what the skill always does")
    }
}

extension SkillCompilerPruneTests {
    func testTwoNavigatesInARowLeaveOnlyTheOneThatCanFlyOtherRoutes() {
        // Recorded: open the search home, then the address the search produced. Replaying both reloads the
        // results page, and the read after it then reads a half-built page.
        let home = SkillStep.browser("navigate", text: "navigate", url: "https://www.google.com/travel/flights?hl=en",
                                     input: "https://www.google.com/travel/flights?hl=en")
        let search = SkillStep.browser("navigate", text: "navigate",
                                       url: "https://www.google.com/travel/flights?hl=en&q=from+{{origin}}+to+{{destination}}",
                                       input: "https://www.google.com/travel/flights?hl=en&q=from+{{origin}}+to+{{destination}}")
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = [home, search]
        let pruned = SkillCompiler.pruneStale(s)
        XCTAssertEqual(pruned.steps.count, 1, "\(pruned.steps.map { $0.url ?? "" })")
        XCTAssertTrue((pruned.steps.first?.url ?? "").contains("{{origin}}"))
    }
}

extension SkillCompilerPruneTests {
    func testTheOpeningPageNeverLeavesTwoNavigatesInARow() {
        // The skill's first step was already a navigate, so `finishing` doesn't add one — but when it does
        // (a skill that begins with a click), the pair must still collapse.
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = [.browser("click", text: "click “Search”", url: "https://www.google.com/travel/flights?hl=en",
                            selectors: ["role=button|Search"], label: "Search"),
                   .browser("navigate", text: "navigate", url: "https://www.google.com/travel/flights/search",
                            input: "https://www.google.com/travel/flights/search")]
        let finished = SkillCompiler.finishing(s, goal: "search flights")
        let navigates = finished.steps.indices.filter { finished.steps[$0].action == "navigate" }
        for (a, b) in zip(navigates, navigates.dropFirst()) {
            XCTAssertNotEqual(b, a + 1, "two navigates in a row: \(finished.steps.map { $0.action ?? "" })")
        }
    }
}

/// A value that comes from a document or the request is the whole point of a pass; assuming the recorded
/// person's value for it filed the wrong person's data and still reported success.
final class SkillCompilerDefaultSafetyTests: XCTestCase {
    func testADocumentValueIsNeverDefaultedToTheRecordedPersons() {
        var s = Skill(accountID: "a", name: "file a return", summary: "")
        s.steps = [.browser("type", text: "type “{{pan}}” in “PAN”", url: "https://tax.example/form",
                            selectors: ["#pan"], label: "PAN", input: "{{pan}}")]
        s.inputs = [SkillInput(name: "pan", description: "the person's PAN", kind: "text", source: "document",
                               required: true, example: "ABCPR1234K")]
        let finished = SkillCompiler.finishing(s, goal: "file a return")
        let pan = finished.inputs?.first { $0.name == "pan" }
        XCTAssertNil(pan?.value, "another person's PAN is never assumed")
        XCTAssertEqual(pan?.isRequired, true)
    }

    func testAPassValueIsNeverDefaulted() {
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = [.browser("type", text: "type “{{origin}}” in “From”", url: "https://x.example",
                            selectors: ["#from"], label: "From", input: "{{origin}}")]
        s.inputs = [SkillInput(name: "origin", description: "departure city", kind: "text", source: "request",
                               required: true, example: "San Francisco")]
        XCTAssertNil(SkillCompiler.finishing(s, goal: "fly").inputs?.first?.value)
    }

    func testAConstantWithNoSourceBecomesItsDefault() {
        var s = Skill(accountID: "a", name: "book a flight", summary: "")
        s.steps = [.browser("navigate", text: "navigate", url: "https://x.example?c={{cabin}}", input: "https://x.example?c={{cabin}}")]
        s.inputs = [SkillInput(name: "cabin", kind: "text", required: true, example: "economy")]
        let cabin = SkillCompiler.finishing(s, goal: "fly").inputs?.first
        XCTAssertEqual(cabin?.value, "economy")
        XCTAssertEqual(cabin?.isRequired, false)
    }
}

/// The value comparison a replay uses to decide a field took what was typed.
final class HybridReplaySameValueTests: XCTestCase {
    func testADateTheFieldReformattedIsTheSameDate() {
        // Typed 2026-12-18, shown 18/12/2026: comparing digits said "not the same", so every replay typed
        // the date twice and logged a doubt.
        XCTAssertTrue(HybridReplay.sameValue(typed: "2026-12-18", field: "18/12/2026"))
        XCTAssertTrue(HybridReplay.sameValue(typed: "2026-12-18", field: "Dec 18, 2026"))
        XCTAssertTrue(HybridReplay.sameValue(typed: "Dec 18, 2026", field: "2026-12-18"))
    }

    func testADifferentDateIsDifferent() {
        XCTAssertFalse(HybridReplay.sameValue(typed: "2026-12-18", field: "2026-12-19"))
    }

    func testLeadingZerosAreFormattingNotAValue() {
        XCTAssertTrue(HybridReplay.sameValue(typed: "78", field: "078"))
        XCTAssertTrue(HybridReplay.sameValue(typed: "1250000", field: "12,50,000"))
    }

    func testTextStillComparesLoosely() {
        XCTAssertTrue(HybridReplay.sameValue(typed: "Asha Rao", field: "ASHA RAO"))
        XCTAssertFalse(HybridReplay.sameValue(typed: "Asha Rao", field: "Bharat Mehta"))
    }
}

extension SkillCompilerPruneTests {
    func testAQueryWordAddressGoesWhenTheFormStepsAreStillThere() {
        // Google Flights answers `?q=flights from X to Y` with a form and a "best flights" strip that has
        // no route rows, so the read after it reports no results. The form steps do the job properly.
        let query = SkillStep.browser("navigate", text: "navigate",
                                      url: "https://www.google.com/travel/flights?hl=en&q=flights+from+{{origin}}+to+{{destination}}+on+{{departure_date}}",
                                      input: "https://www.google.com/travel/flights?hl=en&q=flights+from+{{origin}}+to+{{destination}}+on+{{departure_date}}")
        let origin = SkillStep.browser("type", text: "type “{{origin}}” in “Where from?”",
                                       url: "https://www.google.com/travel/flights",
                                       selectors: ["input[aria-label=\"Where from?\"]"], label: "Where from?", input: "{{origin}}")
        let destination = SkillStep.browser("type", text: "type “{{destination}}” in “Where to?”",
                                           url: "https://www.google.com/travel/flights",
                                           selectors: ["input[aria-label=\"Where to?\"]"], label: "Where to?", input: "{{destination}}")
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [query, origin, destination]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertFalse(pruned.steps.contains { ($0.action == "navigate") && ($0.url ?? "").contains("?q=") })
        XCTAssertEqual(pruned.steps.filter { $0.action == "type" }.count, 2, "the form steps stay")
    }

    func testAQueryWordAddressIsKeptWhenItIsTheOnlyWayIn() {
        let query = SkillStep.browser("navigate", text: "navigate",
                                      url: "https://example.com/search?q={{term}}", input: "https://example.com/search?q={{term}}")
        var skill = Skill(accountID: "a", name: "search", summary: "")
        skill.steps = [query, .browser("read", text: "read", url: "https://example.com/search?q=x")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 2)
    }
}

extension SkillCompilerPruneTests {
    func testABuiltAddressGoesWhenTheFormStepsFillTheTripThemselves() {
        // The skill types this pass's cities, then a recorded `#flt=` address sends it to the learned
        // trip anyway. The address wins over the fields, so the replay flew the wrong route and the read
        // honestly reported the mismatch.
        let home = SkillStep.browser("navigate", text: "navigate", url: "https://www.google.com/travel/flights?hl=en",
                                     input: "https://www.google.com/travel/flights?hl=en")
        func typed(_ placeholder: String, into label: String) -> SkillStep {
            .browser("type", text: "type “{{\(placeholder)}}” in “\(label)”",
                     url: "https://www.google.com/travel/flights?hl=en",
                     selectors: ["input[aria-label=\"\(label)\"]"], label: label, input: "{{\(placeholder)}}")
        }
        let built = SkillStep.browser("navigate", text: "navigate",
                                      url: "https://www.google.com/travel/flights#flt=SFO.LIS.2026-12-18;tt:o",
                                      input: "https://www.google.com/travel/flights#flt=SFO.LIS.2026-12-18;tt:o")
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [home, typed("origin", into: "Where from?"), typed("destination", into: "Where to?"), built]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertFalse(pruned.steps.contains { ($0.url ?? "").contains("#flt=") }, "\(pruned.steps.map { $0.url ?? "" })")
        XCTAssertTrue(pruned.steps.contains { $0.action == "navigate" }, "the opening page stays")
        XCTAssertEqual(pruned.steps.filter { $0.action == "type" }.count, 2)
    }

    func testABuiltAddressStaysWhenItIsTheOnlyWayIn() {
        let built = SkillStep.browser("navigate", text: "navigate",
                                      url: "https://www.google.com/travel/flights?tfs=CBwQARoo", input: "https://www.google.com/travel/flights?tfs=CBwQARoo")
        var skill = Skill(accountID: "a", name: "look up a fare", summary: "")
        skill.steps = [built, .browser("read", text: "read", url: "https://www.google.com/travel/flights?tfs=CBwQARoo")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 2)
    }
}

extension SkillCompilerPruneTests {
    func testALoopBodySurvivesTheDedupesThatWouldShortenIt() {
        // Three deduction rows are three of "choose Section" and three of "type Amount" by design. The
        // duplicate-pruning used to shorten the body to one select and one type while the loop head still
        // said "repeat 3", so the replay clicked Add deduction three times and filled nothing — which is
        // exactly how the filing skill lost every deduction.
        var head = SkillStep.browser("click", text: "click “Add deduction”", url: "https://tax.example/form",
                                     selectors: ["#add"], label: "Add deduction")
        head.repeatOver = "deductions"
        head.repeatLength = 2
        let section = SkillStep.browser("select", text: "choose “{{item.section}}” in “Section”",
                                        url: "https://tax.example/form", selectors: ["#section"], label: "Section", input: "{{item.section}}")
        let amount = SkillStep.browser("type", text: "type “{{item.amount}}” in “Amount”",
                                       url: "https://tax.example/form", selectors: ["#amount"], label: "Amount", input: "{{item.amount}}")
        // The recorded run repeated them once per row; pruning must keep the body intact.
        var skill = Skill(accountID: "a", name: "file a return", summary: "")
        skill.steps = [head, section, amount, section, amount, section, amount]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertTrue(pruned.steps.contains { $0.label == "Section" })
        XCTAssertTrue(pruned.steps.contains { $0.label == "Amount" })
        // The loop is still a loop of the same length, with its body present.
        let loopHead = pruned.steps.first { $0.repeatOver == "deductions" }
        XCTAssertEqual(loopHead?.repeatLength, 2)
        XCTAssertGreaterThanOrEqual(pruned.steps.count, 3, "the body wasn't emptied: \(pruned.steps.map { $0.label ?? $0.action ?? "" })")
    }

    func testTheSameSelectOutsideALoopIsStillDeduped() {
        func select(_ label: String, _ value: String) -> SkillStep {
            .browser("select", text: "choose “\(value)” in “\(label)”", url: "https://x.example",
                     selectors: ["#\(label)"], label: label, input: value)
        }
        var skill = Skill(accountID: "a", name: "x", summary: "")
        skill.steps = [select("regime", "New"), select("regime", "New")]
        XCTAssertEqual(SkillCompiler.pruneStale(skill).steps.count, 1)
    }
}

extension SkillCompilerPruneTests {
    func testAPromotedDateWalkKeepsItsInputBinding() {
        // A rescue learned "click Departure, click 18, click Done"; promotion made it plain steps; the
        // date-walk rewrite then turned it into a think step — but read the placeholder from the click's
        // `input`, which is always nil, so the goal said "the date this run used" and the binding was gone.
        func click(_ label: String, _ selectors: [String]) -> SkillStep {
            .browser("click", text: "click “\(label)”", url: "https://www.google.com/travel/flights",
                     selectors: selectors, label: label)
        }
        let departure = click("Departure", ["role=textbox|Departure"])
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        // A type step on the same control carries the binding.
        let bound = SkillStep.browser("type", text: "type “{{departure_date}}” in “Departure”",
                                      url: "https://www.google.com/travel/flights",
                                      selectors: ["role=textbox|Departure"], label: "Departure", input: "{{departure_date}}")
        skill.steps = [departure, bound, click("12", ["#d12"]),
                       click("Done. Search…", ["role=button|Done."])]
        skill.inputs = [SkillInput(name: "departure_date", kind: "date", source: "request", example: "Dec 18, 2026")]
        let pruned = SkillCompiler.pruneStale(skill)
        let think = pruned.steps.first { $0.mode == "think" }
        XCTAssertNotNil(think)
        XCTAssertTrue(think?.text.contains("{{departure_date}}") == true,
                      "the replacement names the input: \(think?.text ?? "")")
        XCTAssertFalse(think?.text.contains("this run used") == true, "not the learned date")
    }

    func testAPromotedWalkWithNoBindingStillGoesAndSaysWhatToDo() {
        func click(_ label: String) -> SkillStep {
            .browser("click", text: "click “\(label)”", url: "https://www.google.com/travel/flights",
                     selectors: ["#\(label)"], label: label)
        }
        var skill = Skill(accountID: "a", name: "book a flight", summary: "")
        skill.steps = [click("Departure"), click("12"), click("Done. Search…")]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertFalse(pruned.steps.contains { $0.label == "12" }, "the learned day is gone")
        let think = pruned.steps.first { $0.mode == "think" }
        XCTAssertTrue(think?.text.contains("read it from the request") == true, "\(think?.text ?? "")")
    }
}

extension SkillCompilerPruneTests {
    func testALoopRowsLabelIsTemplatedLikeItsSelectors() {
        // The recorded row is row one, so its label says "Section 1" while its selector carries
        // `{{item.index}}`. On row two the label looked for row one's control, missed, and paid for a model
        // rescue on every row of every replay.
        var head = SkillStep.browser("click", text: "click “Add row”", url: "https://x.example", selectors: ["#add"], label: "Add row")
        head.repeatOver = "rows"
        // The body is the two steps after the head: a repeatLength counts the head too.
        head.repeatLength = 3
        let section = SkillStep.browser("select", text: "choose section", url: "https://x.example",
                                        selectors: ["#section-{{item.index}}"], label: "Section 1", input: "{{item.section}}")
        let amount = SkillStep.browser("type", text: "type amount", url: "https://x.example",
                                       selectors: ["#amount-{{item.index}}"], label: "Amount 1 (₹)", input: "{{item.amount}}")
        var skill = Skill(accountID: "a", name: "file a return", summary: "")
        skill.steps = [head, section, amount]
        let pruned = SkillCompiler.pruneStale(skill)
        XCTAssertEqual(pruned.steps.first { $0.action == "select" }?.label, "Section {{item.index}}")
        XCTAssertEqual(pruned.steps.first { $0.action == "type" }?.label, "Amount {{item.index}} (₹)")
    }

    func testANameWithANumberIsNotATemplate() {
        // "80C" and "Form 16" are names, not rows: rewriting their digits would change what the control is.
        XCTAssertNil(SkillCompiler.trailingRowNumber(in: "80C"))
        XCTAssertNil(SkillCompiler.trailingRowNumber(in: "24B"))
        XCTAssertNil(SkillCompiler.trailingRowNumber(in: "Section 80C"))
        XCTAssertNil(SkillCompiler.trailingRowNumber(in: "Form 16"))
        XCTAssertNil(SkillCompiler.trailingRowNumber(in: "Select 2 of 3"))
        XCTAssertEqual(SkillCompiler.trailingRowNumber(in: "Section 1"), 1)
        XCTAssertEqual(SkillCompiler.trailingRowNumber(in: "Amount 2 (₹)"), 2)
    }
}
