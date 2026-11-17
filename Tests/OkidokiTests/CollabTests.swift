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

    // MARK: Take-the-wheel input

    private let w = 1440.0, h = 900.0

    func testInputCoordinatesAreNormalizedAndClamped() {
        let move = CollabInput.action(from: ["kind": "move", "x": 0.5, "y": 0.25], width: w, height: h)
        XCTAssertEqual(move?.type, "move")
        XCTAssertEqual(move?.x, 720)
        XCTAssertEqual(move?.y, 225)
        let outside = CollabInput.action(from: ["kind": "move", "x": 5.0, "y": -3.0], width: w, height: h)
        XCTAssertEqual(outside?.x, w)
        XCTAssertEqual(outside?.y, 0)
        XCTAssertNil(CollabInput.action(from: ["kind": "move", "x": "nope"], width: w, height: h))
        XCTAssertNil(CollabInput.action(from: ["kind": "move"], width: w, height: h))
    }

    func testInputClicksCarryButtonCountAndModifiers() {
        let plain = CollabInput.action(from: ["kind": "click", "x": 0.1, "y": 0.1], width: w, height: h)
        XCTAssertEqual(plain?.type, "click")
        let double = CollabInput.action(from: ["kind": "click", "x": 0.1, "y": 0.1, "count": 2], width: w, height: h)
        XCTAssertEqual(double?.type, "double_click")
        let right = CollabInput.action(from: ["kind": "click", "x": 0.1, "y": 0.1, "button": "right"], width: w, height: h)
        XCTAssertEqual(right?.type, "right_click")
        let held = CollabInput.action(from: ["kind": "click", "x": 0.1, "y": 0.1, "modifiers": "cmd+shift"], width: w, height: h)
        XCTAssertEqual(held?.modifiers, "cmd+shift")
    }

    func testInputDragScrollKeyAndType() {
        let drag = CollabInput.action(from: ["kind": "drag", "fromX": 0.0, "fromY": 0.0, "toX": 1.0, "toY": 1.0], width: w, height: h)
        XCTAssertEqual(drag?.type, "drag")
        XCTAssertEqual(drag?.fromX, 0)
        XCTAssertEqual(drag?.toX, w)
        XCTAssertEqual(drag?.toY, h)

        let scroll = CollabInput.action(from: ["kind": "scroll", "x": 0.5, "y": 0.5, "dy": 99999], width: w, height: h)
        XCTAssertEqual(scroll?.type, "scroll")
        XCTAssertEqual(scroll?.dy, CollabInput.maxScroll)
        XCTAssertNil(CollabInput.action(from: ["kind": "scroll", "dx": 0, "dy": 0], width: w, height: h))

        let key = CollabInput.action(from: ["kind": "key", "key": "cmd+l", "times": 500], width: w, height: h)
        XCTAssertEqual(key?.type, "key")
        XCTAssertEqual(key?.key, "cmd+l")
        XCTAssertEqual(key?.times, CollabInput.maxKeyTimes)
        XCTAssertNil(CollabInput.action(from: ["kind": "key", "key": String(repeating: "x", count: 80)], width: w, height: h))

        let type = CollabInput.action(from: ["kind": "type", "text": String(repeating: "a", count: 900)], width: w, height: h)
        XCTAssertEqual(type?.type, "type")
        XCTAssertEqual(type?.text?.count, CollabInput.maxTypeLength)
        XCTAssertNil(CollabInput.action(from: ["kind": "type", "text": ""], width: w, height: h))
        XCTAssertNil(CollabInput.action(from: ["kind": "shell"], width: w, height: h))
    }

    func testOnlyPointerKindsBroadcast() {
        XCTAssertTrue(CollabInput.movesPointer("move"))
        XCTAssertTrue(CollabInput.movesPointer("click"))
        XCTAssertTrue(CollabInput.movesPointer("drag"))
        XCTAssertFalse(CollabInput.movesPointer("key"))
        XCTAssertFalse(CollabInput.movesPointer("type"))
        XCTAssertFalse(CollabInput.movesPointer("scroll"))
    }
}
