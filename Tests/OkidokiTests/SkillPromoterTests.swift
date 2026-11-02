import XCTest
@testable import OkidokiCore

final class SkillPromoterTests: XCTestCase {
    private let inputs = [
        SkillInput(name: "deductions", kind: "list", fields: ["section", "amount"], required: false),
        SkillInput(name: "capital_gains", kind: "money", required: false),
    ]
    private func think(_ goal: String, when: String) -> SkillStep {
        var step = SkillStep(text: goal, action: "think"); step.mode = "think"; step.when = when; step.surface = "browser"
        step.url = "http://x/deductions.html"
        return step
    }
    private func row(_ n: Int, section: String, amount: String) -> [SkillPromoter.Action] {
        [SkillPromoter.Action(action: "click", selectors: ["#add-row", "role=button|Add deduction"], label: "Add deduction"),
         SkillPromoter.Action(action: "select", selectors: ["#section-\(n)", "role=combobox|Section \(n)", "tr:nth-of-type(\(n)) > td > select"], label: "Section \(n)", input: section),
         SkillPromoter.Action(action: "type", selectors: ["#amount-\(n)", "role=textbox|Amount \(n) (₹)"], label: "Amount \(n) (₹)", input: amount)]
    }

    func testRowsBecomeALoop() throws {
        let list = HybridReplay.encodeList([["section": "80C", "amount": "150000"], ["section": "80D", "amount": "25000"]])
        let steps = try XCTUnwrap(SkillPromoter.promote(think("For each entry in {{deductions}}, add a row", when: "{{deductions}}"),
                                                        actions: row(1, section: "80C", amount: "1,50,000") + row(2, section: "80D", amount: "25000"),
                                                        values: ["deductions": list], inputs: inputs))
        XCTAssertEqual(steps.count, 3)
        XCTAssertEqual(steps[0].repeatOver, "deductions")
        XCTAssertEqual(steps[0].repeatLength, 3)
        XCTAssertEqual(steps[0].selectors, ["#add-row", "role=button|Add deduction"])
        XCTAssertEqual(steps[1].input, "{{item.section}}")
        XCTAssertEqual(steps[2].input, "{{item.amount}}")
        XCTAssertEqual(steps[1].selectors, ["#section-{{item.index}}", "role=combobox|Section {{item.index}}", "tr:nth-of-type({{item.index}}) > td > select"])
        XCTAssertTrue(steps.allSatisfy { $0.when == "{{deductions}}" })

        // And it replays for someone with three rows, with no model.
        let three = HybridReplay.encodeList([["section": "80C", "amount": "1"], ["section": "80G", "amount": "2"], ["section": "24B", "amount": "3"]])
        let plan = HybridReplay.plan(steps, values: ["deductions": three])
        XCTAssertEqual(plan.count, 9)
        XCTAssertEqual(ParameterFill.fill(plan[7].step.selectors![0], values: plan[7].values).text, "#section-3")
        XCTAssertEqual(ParameterFill.fill(plan[8].step.input!, values: plan[8].values).text, "3")
    }

    func testAOneOffMapsTypedValuesToInputs() throws {
        let actions = [SkillPromoter.Action(action: "click", selectors: ["#has-gains"], label: "I sold shares or property this year"),
                       SkillPromoter.Action(action: "type", selectors: ["#gains"], label: "Capital gains (₹)", input: "3,10,000")]
        let steps = try XCTUnwrap(SkillPromoter.promote(think("Tick it and type {{capital_gains}}", when: "{{capital_gains}}"),
                                                        actions: actions, values: ["capital_gains": "310000"], inputs: inputs))
        XCTAssertEqual(steps.map(\.input), [nil, "{{capital_gains}}"])
        XCTAssertTrue(steps.allSatisfy { $0.when == "{{capital_gains}}" })
    }

    func testAnythingUnexplainedKeepsTheThinkStep() {
        let stray = [SkillPromoter.Action(action: "type", selectors: ["#note"], input: "something the model made up")]
        XCTAssertNil(SkillPromoter.promote(think("Tick it and type {{capital_gains}}", when: "{{capital_gains}}"),
                                           actions: stray, values: ["capital_gains": "310000"], inputs: inputs))
        let list = HybridReplay.encodeList([["section": "80C", "amount": "1"], ["section": "80D", "amount": "2"]])
        let uneven = row(1, section: "80C", amount: "1") + Array(row(2, section: "80D", amount: "2").prefix(2))
        XCTAssertNil(SkillPromoter.promote(think("each {{deductions}}", when: "{{deductions}}"), actions: uneven,
                                           values: ["deductions": list], inputs: inputs))
    }

    func testReplacingKeepsTheRest() {
        let a = SkillStep(text: "a"), b = think("t", when: "{{x}}"), c = SkillStep(text: "c")
        let out = SkillPromoter.replacing([a, b, c], at: 1, with: [SkillStep(text: "b1"), SkillStep(text: "b2")])
        XCTAssertEqual(out.map(\.text), ["a", "b1", "b2", "c"])
        XCTAssertEqual(SkillPromoter.replacing([a, c], at: 1, with: [SkillStep(text: "x")]).map(\.text), ["a", "c"])
    }
}
