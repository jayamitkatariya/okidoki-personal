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

final class NoteCommandTests: XCTestCase {
    private func parse(_ text: String) -> ChatCommand? { ChatCommands.parse(text, context: .init(skills: [])) }

    func testNotesAreTakenDownAsTyped() {
        XCTAssertEqual(parse("note: call the dentist about Thursday"), .addNote(text: "call the dentist about Thursday"))
        XCTAssertEqual(parse("Note to self - Wi-Fi is studio-5g"), .addNote(text: "Wi-Fi is studio-5g"))
        XCTAssertEqual(parse("jot down that the lease ends in May"), .addNote(text: "the lease ends in May"))
        XCTAssertNil(parse("notes are useful"))
        XCTAssertNil(parse("open notes"))
    }

    func testRepeatsAreReadFromTheRequest() {
        XCTAssertEqual(ReminderParsing.repeats(in: "remind me to stretch every weekday at 3"), .weekdays)
        XCTAssertEqual(ReminderParsing.repeats(in: "remind me to water plants every day"), .daily)
        XCTAssertEqual(ReminderParsing.repeats(in: "every friday at 4 file expenses"), .weekly)
        XCTAssertEqual(ReminderParsing.repeats(in: "pay rent monthly"), .monthly)
        XCTAssertEqual(ReminderParsing.repeats(in: "remind me to call mom at 6"), .never)
    }

    func testAWeekdayReminderSkipsTheWeekend() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let friday = calendar.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 9))!
        let next = ReminderRepeat.weekdays.next(after: friday, calendar: calendar)!
        XCTAssertEqual(calendar.component(.weekday, from: next), 2) // Monday
    }
}

final class DateParsingTests: XCTestCase {
    func testLocalTimesKeepTheirTime() {
        let calendar = Calendar.current
        for text in ["2026-11-02T09:30", "2026-11-02 09:30", "2026-11-02T09:30:00", "2026-11-02 09:30:00"] {
            let date = DateParsing.iso8601(text)
            XCTAssertNotNil(date, text)
            XCTAssertEqual(calendar.component(.hour, from: date!), 9, text)
            XCTAssertEqual(calendar.component(.minute, from: date!), 30, text)
        }
        XCTAssertEqual(calendar.component(.hour, from: DateParsing.iso8601("2026-11-02")!), 0)
        XCTAssertNotNil(DateParsing.iso8601("2026-11-02T13:30:00.000Z"))
        XCTAssertNil(DateParsing.iso8601("2026-11-02T9"))
    }
}
