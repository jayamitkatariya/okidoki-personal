import XCTest
@testable import OkidokiCore

final class CollabTests: XCTestCase {
    // MARK: Rules

    func testCodeIsSixUnambiguousCharacters() {
        for _ in 0..<50 {
            let code = CollabRules.makeCode()
            XCTAssertEqual(code.count, 6)
            XCTAssertTrue(code.allSatisfy { CollabRules.codeAlphabet.contains($0) })
            XCTAssertFalse(code.contains("I"))
            XCTAssertFalse(code.contains("O"))
            XCTAssertFalse(code.contains("0"))
            XCTAssertFalse(code.contains("1"))
        }
    }

    func testNormalizeCodeTrimsAndUppercases() {
        XCTAssertEqual(CollabRules.normalizeCode("  ab12cd \n"), "AB12CD")
    }

    func testDisplayNameFallsBackAndTruncates() {
        XCTAssertEqual(CollabRules.displayName("   "), "Guest")
        XCTAssertEqual(CollabRules.displayName(" Asha "), "Asha")
        XCTAssertEqual(CollabRules.displayName(String(repeating: "x", count: 80)).count, CollabRules.nameMax)
    }

    func testAskPrefixDetectionAndStripping() {
        XCTAssertTrue(CollabRules.asksOkidoki("okidoki, check the weather"))
        XCTAssertTrue(CollabRules.asksOkidoki("  Okidoki do it"))
        XCTAssertFalse(CollabRules.asksOkidoki("hey everyone"))
        XCTAssertFalse(CollabRules.asksOkidoki("okidokiish"))
        XCTAssertEqual(CollabRules.stripAskPrefix("okidoki, check the weather"), "check the weather")
        XCTAssertEqual(CollabRules.stripAskPrefix("Okidoki: do it"), "do it")
    }

    func testClampMessageTrimsAndCaps() {
        XCTAssertEqual(CollabRules.clampMessage("  hi  "), "hi")
        XCTAssertEqual(CollabRules.clampMessage(String(repeating: "a", count: 5000)).count, CollabRules.messageMax)
    }

    func testColorWrapsThePalette() {
        XCTAssertEqual(CollabRules.color(forIndex: 0), CollabRules.palette[0])
        XCTAssertEqual(CollabRules.color(forIndex: CollabRules.palette.count), CollabRules.palette[0])
        XCTAssertEqual(CollabRules.color(forIndex: -1), CollabRules.palette.last)
    }

    // MARK: Joining

    func testJoinNeedsTheCodeAndReturnsAToken() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        XCTAssertThrowsError(try session.join(name: "Asha", code: "WRONG")) { error in
            XCTAssertEqual(error as? CollabJoinError, .badCode)
        }
        let joined = try session.join(name: "Asha", code: "abc234")
        XCTAssertEqual(joined.participant.name, "Asha")
        XCTAssertEqual(session.participantCount, 1)
        XCTAssertEqual(session.participant(forToken: joined.token)?.id, joined.participant.id)
        XCTAssertNil(session.participant(forToken: "nope"))
    }

    func testSessionFillsUp() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        for i in 0..<CollabRules.maxParticipants {
            _ = try session.join(name: "p\(i)", code: "ABC234")
        }
        XCTAssertThrowsError(try session.join(name: "overflow", code: "ABC234")) { error in
            XCTAssertEqual(error as? CollabJoinError, .full)
        }
    }

    func testKickRemovesTheParticipantAndTheirToken() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        let joined = try session.join(name: "Asha", code: "ABC234")
        session.requestWheel(joined.participant.id)
        session.kick(joined.participant.id)
        XCTAssertEqual(session.participantCount, 0)
        XCTAssertNil(session.participant(forToken: joined.token))
        XCTAssertNil(session.wheelHolder)
    }

    // MARK: Chat

    func testChatIsCapped() {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        for i in 0..<(CollabRules.chatCap + 50) {
            session.say(authorID: "a", authorName: "A", colorHex: "44E45E", text: "m\(i)", kind: .chat)
        }
        XCTAssertEqual(session.messages.count, CollabRules.chatCap)
        XCTAssertEqual(session.messages.first?.text, "m50")
    }

    // MARK: Wheel

    func testWheelIsHeldByOneAndReclaimedByTheHost() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        let a = try session.join(name: "Asha", code: "ABC234")
        let b = try session.join(name: "Ravi", code: "ABC234")
        XCTAssertTrue(session.requestWheel(a.participant.id))
        XCTAssertFalse(session.requestWheel(b.participant.id))
        XCTAssertEqual(session.wheelHolder, a.participant.id)
        session.releaseWheel(b.participant.id) // not theirs: nothing happens
        XCTAssertEqual(session.wheelHolder, a.participant.id)
        session.reclaimWheel()
        XCTAssertNil(session.wheelHolder)
        XCTAssertTrue(session.requestWheel(b.participant.id))
    }

    func testOnlyTheRequesterStopsTheirRun() {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        XCTAssertTrue(session.canStop(requestedBy: "a", participantID: "a"))
        XCTAssertFalse(session.canStop(requestedBy: "a", participantID: "b"))
        XCTAssertFalse(session.canStop(requestedBy: nil, participantID: "a"))
    }

    // MARK: Snapshot

    func testSnapshotCarriesTheSessionState() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        let joined = try session.join(name: "Asha", code: "ABC234")
        session.say(authorID: joined.participant.id, authorName: "Asha", colorHex: joined.participant.colorHex, text: "hi", kind: .chat)
        let snap = session.snapshot(vm: CollabVM(phase: "running", running: true), run: nil, skills: [])
        XCTAssertEqual(snap.hostName, "Host")
        XCTAssertEqual(snap.participants.count, 1)
        XCTAssertEqual(snap.chat.count, 1)
        XCTAssertTrue(snap.vm.running)
        XCTAssertNil(snap.run)
    }

    func testSnapshotEncodesToTheWireContract() throws {
        let session = CollabSession(hostName: "Host", code: "ABC234")
        _ = try session.join(name: "Asha", code: "ABC234")
        let snap = session.snapshot(vm: CollabVM(phase: "running", running: true), run: nil,
                                    skills: [CollabSkillCard(id: "s", name: "weather", summary: "check it", inputs: [CollabSkillInput(name: "city", description: "where")])])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snap)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["hostName"] as? String, "Host")
        XCTAssertNotNil(object["participants"])
        XCTAssertNotNil(object["skills"])
        XCTAssertNotNil(object["vm"])
        XCTAssertNotNil(object["chat"])
    }
}
