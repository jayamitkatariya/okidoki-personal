import XCTest
@testable import OkidokiCore

/// The AcmeDesk skills scripts/cu-replay-eval.py replays (scripts/cu-fixture/make-skills.py) are real
/// skill files: they decode, keep their inputs, and plan the way the eval's people need.
final class MacFixtureSkillTests: XCTestCase {
    func bundle(_ name: String) throws -> SkillBundle {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try SkillBundle.decode(Data(contentsOf: root.appendingPathComponent("scripts/cu-fixture/\(name)")))
    }

    func testRecordedSkillIsAPlainRecordingWithLocators() throws {
        let recorded = try bundle("acmedesk.okiskill")
        XCTAssertEqual(recorded.name, "acmedesk filing")
        XCTAssertNil(recorded.skill)
        var skill = Skill(accountID: "a", name: recorded.name, summary: "", steps: recorded.steps)
        XCTAssertFalse(skill.usesSmartReplay, "classic replay keeps it")
        XCTAssertTrue(recorded.steps.filter { $0.action == "click" }.allSatisfy { $0.axLocator != nil || $0.role == "AXMenuItem" })
        skill.steps = []
    }

    func testSmartSkillPlansConditionsAndLoops() throws {
        let smart = try bundle("acmedesk-smart.okiskill")
        var skill = Skill(accountID: "a", name: smart.name, summary: "", steps: smart.steps)
        smart.skill?.apply(to: &skill)
        XCTAssertTrue(skill.usesSmartReplay)
        XCTAssertEqual(skill.inputs?.map(\.name), ["name", "pan", "income", "regime", "gains", "deductions", "reference"])
        let submit = try XCTUnwrap(skill.steps.first { $0.irreversible == true })
        XCTAssertEqual(submit.axLocator?.inSheet, true)
        XCTAssertEqual(submit.echoes, true)
        // Asha: no gains, no deductions.
        let asha = HybridReplay.plan(skill.steps, values: ["name": "Asha Rao", "gains": "", "deductions": "[]"])
        XCTAssertFalse(asha.contains { $0.step.text.contains("capital gains") })
        XCTAssertFalse(asha.contains { $0.step.repeatOver != nil })
        // Divya: three rows, each found by its own locator.
        let rows = #"[{"section":"80C","amount":"90000"},{"section":"80G","amount":"12000"},{"section":"24B","amount":"200000"}]"#
        let divya = HybridReplay.plan(skill.steps, values: ["name": "Divya Shah", "gains": "", "deductions": rows])
        let amounts = divya.filter { $0.step.axLocator?.label == "Amount {{item.index}}" }
        XCTAssertEqual(amounts.count, 3)
        XCTAssertEqual(amounts.map { $0.step.axLocator!.filled($0.values).identifier }, ["amount-1", "amount-2", "amount-3"])
        XCTAssertEqual(MacReplay.startSteps(divya), 1)
    }
}
