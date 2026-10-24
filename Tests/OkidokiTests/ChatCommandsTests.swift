import XCTest
@testable import OkidokiCore

final class ChatCommandsTests: XCTestCase {
    private let invoice = Skill(id: "s1", accountID: "a", name: "invoice flow", summary: "4 clicks in Numbers")
    private let figma = Skill(id: "s2", accountID: "a", name: "figma export", summary: "3 clicks in Figma")
    private let figmaFrames = Skill(id: "s3", accountID: "a", name: "figma frames", summary: "2 clicks in Figma")
    private var skills: [Skill] { [invoice, figma, figmaFrames] }

    private func parse(_ text: String, recording: Bool = false, replaying: Bool = false, hasReplayed: Bool = false) -> ChatCommand? {
        ChatCommands.parse(text, context: ChatCommands.Context(skills: skills, recording: recording, replaying: replaying, hasReplayed: hasReplayed))
    }

    func testReplayByNameWithCounts() {
        XCTAssertEqual(parse("replay invoice flow"), .replay(skillID: "s1", times: 1))
        XCTAssertEqual(parse("Replay the invoice skill 3 times"), .replay(skillID: "s1", times: 3))
        XCTAssertEqual(parse("rerun invoice twice"), .replay(skillID: "s1", times: 2))
        XCTAssertEqual(parse("replay invoice x5"), .replay(skillID: "s1", times: 5))
        XCTAssertEqual(parse("run invoice flow"), .replay(skillID: "s1", times: 1))
        XCTAssertEqual(parse("invoice flow"), .replay(skillID: "s1", times: 1))
    }

    func testEverydayVerbsStayWithTheBrainUnlessASkillIsNamed() {
        XCTAssertNil(parse("do my taxes"))
        XCTAssertNil(parse("run brew update"))
        XCTAssertNil(parse("play some music"))
        XCTAssertNil(parse("invoice"))
        XCTAssertNil(parse("what's the weather"))
    }

    func testStrictVerbsAnswerEvenWhenNothingMatches() {
        XCTAssertEqual(parse("replay the payroll one"), .noSuchSkill(query: "payroll one"))
        XCTAssertEqual(parse("replay"), .replayLast(times: 1))
        XCTAssertEqual(parse("replay it 3 times"), .replayLast(times: 3))
    }

    func testAgainOnlyMeansReplayOnceSomethingWasReplayed() {
        XCTAssertNil(parse("again"))
        XCTAssertNil(parse("do it again"))
        XCTAssertNil(parse("one more time?"))
        XCTAssertEqual(parse("again", hasReplayed: true), .replayLast(times: 1))
        XCTAssertEqual(parse("do it again", hasReplayed: true), .replayLast(times: 1))
        XCTAssertEqual(parse("one more time", hasReplayed: true), .replayLast(times: 1))
        XCTAssertEqual(parse("again twice", hasReplayed: true), .replayLast(times: 2))
    }

    func testRestartWhileRecording() {
        XCTAssertEqual(parse("start over", recording: true), .restartRecording)
        XCTAssertEqual(parse("again", recording: true), .restartRecording)
        XCTAssertEqual(parse("redo", recording: true), .restartRecording)
        XCTAssertNil(parse("start over"))
    }

    func testCloseNamesAskWhichOne() {
        guard case .ambiguousSkill(_, let ids)? = parse("replay figma") else { return XCTFail("expected a choice") }
        XCTAssertEqual(Set(ids), ["s2", "s3"])
        XCTAssertEqual(parse("replay figma export"), .replay(skillID: "s2", times: 1))
    }

    func testRecordingControlsOnlyWhileRecording() {
        XCTAssertEqual(parse("stop", recording: true), .saveRecording(name: ""))
        XCTAssertEqual(parse("done", recording: true), .saveRecording(name: ""))
        XCTAssertEqual(parse("save as monthly report", recording: true), .saveRecording(name: "monthly report"))
        XCTAssertEqual(parse("discard", recording: true), .discardRecording)
        XCTAssertEqual(parse("never mind", recording: true), .discardRecording)
        XCTAssertNil(parse("stop"))
        XCTAssertNil(parse("done"))
    }

    func testStartRecordingAndReplayStop() {
        XCTAssertEqual(parse("watch me"), .startRecording(name: ""))
        XCTAssertEqual(parse("watch me do the expense report"), .startRecording(name: "the expense report"))
        XCTAssertEqual(parse("record a skill called weekly sync"), .startRecording(name: "weekly sync"))
        XCTAssertEqual(parse("stop", replaying: true), .stopReplay)
    }

    func testListRenameDelete() {
        XCTAssertEqual(parse("what skills do i have?"), .listSkills)
        XCTAssertEqual(parse("my skills"), .listSkills)
        XCTAssertEqual(parse("rename invoice flow to billing"), .renameSkill(skillID: "s1", name: "billing"))
        XCTAssertEqual(parse("delete the invoice flow skill"), .deleteSkill(skillID: "s1"))
        XCTAssertNil(parse("delete the old files"))
    }
}
