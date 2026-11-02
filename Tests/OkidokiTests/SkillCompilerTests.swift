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
}
