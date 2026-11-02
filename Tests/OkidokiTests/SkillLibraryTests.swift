import XCTest
@testable import OkidokiCore

final class SkillLibraryTests: XCTestCase {
    private var folder: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Resources/skills")
    }

    func testEveryShippedTemplateLoads() throws {
        let entries = SkillLibrary.load(from: folder)
        XCTAssertGreaterThanOrEqual(entries.count, 12)
        for entry in entries {
            let extras = try XCTUnwrap(entry.bundle.skill, entry.id)
            XCTAssertEqual(extras.template, true, entry.id)
            XCTAssertFalse(extras.outline?.isEmpty ?? true, entry.id)
            XCTAssertFalse(extras.intent?.isEmpty ?? true, entry.id)
            // Where it starts: a site, an app, or an address the person gives (their school's portal).
            XCTAssertTrue(extras.startURL != nil || extras.startApp != nil || (extras.inputs ?? []).contains { $0.name.hasSuffix("url") }, entry.id)
            // Every {{placeholder}} the outline uses is one of its inputs.
            let inputs = Set((extras.inputs ?? []).map { ParameterFill.key($0.name) })
            for line in extras.outline ?? [] {
                for name in ParameterFill.names(in: line) { XCTAssertTrue(inputs.contains(ParameterFill.key(name)), "\(entry.id): \(name)") }
            }
        }
        XCTAssertTrue(entries.contains { $0.surface == "mac" })
        XCTAssertTrue(entries.contains { $0.surface == "browser" })
    }

    func testATemplateBecomesAnEmptySkillWithItsOutline() throws {
        let entry = try XCTUnwrap(SkillLibrary.load(from: folder).first { $0.id == "amazon-order" })
        let skill = SkillLibrary.skill(from: entry, accountID: "a")
        XCTAssertEqual(skill.template, true)
        XCTAssertEqual(skill.alwaysConfirm, true)
        XCTAssertTrue(skill.steps.isEmpty)
        XCTAssertEqual(skill.source, "library:amazon-order")
        XCTAssertEqual(skill.startURL, "https://www.amazon.com")
    }
}
