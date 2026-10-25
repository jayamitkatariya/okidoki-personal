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

    // MARK: - Enterprise

    private let spaces = [ChatSpaceRef(id: "sp1", name: "sales", joined: true),
                          ChatSpaceRef(id: "sp2", name: "design review", joined: false),
                          ChatSpaceRef(id: "sp3", name: "general", joined: true)]
    private let shared = [ChatSharedSkillRef(id: "sh1", name: "expense report", publishedBy: "Priya"),
                          ChatSharedSkillRef(id: "sh2", name: "invoice flow", publishedBy: "Sam")]

    private func parseWork(_ text: String) -> ChatCommand? {
        ChatCommands.parse(text, context: ChatCommands.Context(skills: skills, spaces: spaces, sharedSkills: shared))
    }

    func testRequestsRouteToASpaceWhenOneIsNamed() {
        XCTAssertEqual(parseWork("ask #sales to compress the launch video"), .askSpace(spaceID: "sp1", text: "compress the launch video"))
        XCTAssertEqual(parseWork("#sales: compress the launch video"), .askSpace(spaceID: "sp1", text: "compress the launch video"))
        XCTAssertEqual(parseWork("#design review rename the frames"), .askSpace(spaceID: "sp2", text: "rename the frames"))
        XCTAssertEqual(parseWork("compress the launch video for #sales"), .askSpace(spaceID: "sp1", text: "compress the launch video"))
        XCTAssertEqual(parseWork("tell sales to export the deck"), .askSpace(spaceID: "sp1", text: "export the deck"))
        XCTAssertEqual(parseWork("ask #marketing to do it"), .unknownSpace(query: "marketing", text: "do it"))
    }

    func testEverydayRequestsDoNotBecomeSpaceMessages() {
        XCTAssertNil(parseWork("tell sam to buy milk"))
        XCTAssertNil(parseWork("in 5 minutes remind me to stretch"))
        XCTAssertNil(parseWork("ask me a question"))
        XCTAssertNil(parseWork("send the invoice to accounting"))
        // Without spaces the enterprise commands don't exist at all.
        XCTAssertNil(parse("ask #sales to compress the launch video"))
    }

    func testWaitingSpacesAndOpen() {
        XCTAssertEqual(parse("what's waiting on me?"), .whatsWaiting)
        XCTAssertEqual(parseWork("approvals"), .whatsWaiting)
        XCTAssertEqual(parseWork("my spaces"), .listSpaces)
        XCTAssertEqual(parseWork("open #sales"), .openSpace(spaceID: "sp1"))
        XCTAssertEqual(parseWork("show the design review chat"), .openSpace(spaceID: "sp2"))
        XCTAssertNil(parseWork("open finder"))
    }

    func testShareASkill() {
        XCTAssertEqual(parseWork("share invoice flow with my team"), .shareSkill(skillID: "s1", spaceID: nil))
        XCTAssertEqual(parseWork("share the figma export skill with #sales"), .shareSkill(skillID: "s2", spaceID: "sp1"))
        XCTAssertEqual(parseWork("publish figma frames to everyone"), .shareSkill(skillID: "s3", spaceID: nil))
        XCTAssertNil(parseWork("share my screen with him"))
    }

    func testAColleaguesSharedSkillReplaysByName() {
        XCTAssertEqual(parseWork("replay the expense report"), .replayShared(sharedID: "sh1", times: 1))
        XCTAssertEqual(parseWork("run expense report 3 times"), .replayShared(sharedID: "sh1", times: 3))
        XCTAssertEqual(parseWork("expense report"), .replayShared(sharedID: "sh1", times: 1))
        // My own recording wins over a colleague's copy of the same name.
        XCTAssertEqual(parseWork("replay invoice flow"), .replay(skillID: "s1", times: 1))
        XCTAssertNil(parseWork("do my expenses"))
    }
}
