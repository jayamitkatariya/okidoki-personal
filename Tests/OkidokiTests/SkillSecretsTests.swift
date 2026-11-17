import XCTest
@testable import OkidokiCore

/// A password given in the request a skill was learned from is remembered for that skill, so replaying it
/// for someone else doesn't fail with "needs password".
final class SkillSecretsTests: XCTestCase {
    private func skill() -> Skill {
        var made = Skill(id: "secret-test-\(UUID().uuidString)", accountID: "a", name: "acme filing", summary: "")
        made.steps = [
            BrowserSteps.navigate("http://127.0.0.1:8777/login.html"),
            .browser("type", text: "type “eval” in “Username”", url: "http://127.0.0.1:8777/login.html", label: "Username", input: "eval"),
            .browser("type", text: "type “{{password}}” in “Password”", url: "http://127.0.0.1:8777/login.html", label: "Password", input: "{{password}}"),
            .browser("type", text: "type “{{name}}” in “Full name”", url: "http://127.0.0.1:8777/form.html", label: "Full name", input: "{{name}}"),
        ]
        return made
    }

    func testRememberedPasswordFillsEveryPassThatLacksOne() {
        let filled = SkillSecrets.fill([["name": "Bharat"], ["name": "Chandra", "Password": "given"]], skill: skill(), times: 1,
                                       lookup: { $0 == "password" ? "eval" : nil })
        XCTAssertEqual(filled[0], ["name": "Bharat", "password": "eval"])
        // One the request gives wins, whatever its case.
        XCTAssertEqual(filled[1], ["name": "Chandra", "Password": "given"])
        let classic = ParameterFill.fill("{{password}} {{name}}", values: filled[0])
        XCTAssertTrue(classic.missing.isEmpty)
    }

    func testNoValuesMakesOnePassPerTimeCarryingTheSecret() {
        let filled = SkillSecrets.fill([], skill: skill(), times: 3, lookup: { _ in "eval" })
        XCTAssertEqual(filled.count, 3)
        XCTAssertEqual(filled.first?["password"], "eval")
    }

    func testNothingRememberedLeavesPassesAlone() {
        XCTAssertEqual(SkillSecrets.fill([], skill: skill(), times: 2, lookup: { _ in nil }), [])
        XCTAssertEqual(SkillSecrets.fill([["name": "A"]], skill: skill(), times: 1, lookup: { _ in nil }), [["name": "A"]])
    }

    // MARK: - A plain recording given someone else's details

    func testARecordingWithNoPlaceForTheValuesSaysSo() {
        var recorded = skill()
        recorded.steps[3] = .browser("type", text: "type “Asha Rao” in “Full name”", url: "http://127.0.0.1:8777/form.html", label: "Full name", input: "Asha Rao")
        XCTAssertEqual(ReplayValues.ignoredByRecording(recorded.steps, passes: [["name": "Bharat Mehta", "pan": "BHMPM5678L"]]), ["name", "pan"])
        // Who it's for, a remembered password, and nothing at all are never reasons to refuse.
        XCTAssertEqual(ReplayValues.ignoredByRecording(recorded.steps, passes: [["ref": "Bharat", "password": "x"]]), [])
        XCTAssertEqual(ReplayValues.ignoredByRecording(recorded.steps, passes: []), [])
    }

    func testValuesTheSkillTypesAreFineEvenWithExtras() {
        // A record with more columns than the skill uses still fills the ones it does.
        XCTAssertEqual(ReplayValues.ignoredByRecording(skill().steps, passes: [["Name": "Bharat", "pan": "X", "city": "Pune"]]), [])
    }
}
