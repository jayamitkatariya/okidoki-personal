import XCTest
@testable import OkidokiCore

final class SkillBundleTests: XCTestCase {
    func testASkillFileRoundTripsWithFreshStepIDs() throws {
        let steps = [SkillStep(text: "in Safari, type “{{city}}”", app: "Safari", action: "type", input: "{{city}}"),
                     SkillStep(text: "in Safari, press ↩", app: "Safari", action: "key", input: "return")]
        let skill = Skill(accountID: "a", name: "weather", summary: "two steps", steps: steps)
        let bundle = SkillBundle.make(from: skill)
        let decoded = try SkillBundle.decode(bundle.encoded())
        XCTAssertEqual(decoded.name, "weather")
        XCTAssertEqual(decoded.steps.map(\.input), ["{{city}}", "return"])
        let installed = decoded.installableSteps()
        XCTAssertEqual(installed.map(\.text), steps.map(\.text))
        XCTAssertTrue(Set(installed.map(\.id)).isDisjoint(with: steps.map(\.id)))
    }

    func testOtherFilesAreRefused() {
        XCTAssertThrowsError(try SkillBundle.decode(Data(#"{"format":"something-else"}"#.utf8)))
        XCTAssertThrowsError(try SkillBundle.decode(Data("not json".utf8)))
    }
}
