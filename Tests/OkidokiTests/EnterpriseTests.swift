import XCTest
@testable import OkidokiCore

final class EnterpriseTests: XCTestCase {
    @MainActor
    private func freshStore() -> OkidokiStore {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-tests-\(UUID().uuidString)").appendingPathComponent("state.json")
        return OkidokiStore(seedDemo: false, stateURL: url)
    }

    private let poll: [String: Any] = [
        "org": ["id": "org1", "name": "Acme", "role": "member", "welcome": "Try 'replay the expense report'.", "pendingJoins": 0, "memberCount": 4],
        "me": ["userId": "u1", "name": "sam"],
        "spaces": [
            ["id": "sp1", "name": "sales", "colorHex": "F2B84B", "workerPolicy": "thisMac", "joined": true, "unread": 3, "lastMessage": "jay: can someone…", "lastMessageAt": 1_761_300_000_000.0],
            ["id": "sp2", "name": "design", "colorHex": "8FB7FF", "workerPolicy": "privateMac", "joined": false, "unread": 0, "lastMessage": "", "lastMessageAt": 0.0],
        ],
        "approvals": [
            ["id": "job1", "spaceId": "sp1", "spaceName": "sales", "prompt": "clean the drive", "title": "Clean the shared drive", "requestedBy": "jay",
             "workerName": "pat", "workerIsYou": false, "createdAt": 1_761_300_000_000.0,
             "preview": ["summary": "Delete 14 stale folders", "risk": "high", "steps": ["list", "delete"], "commands": ["rm -rf …"], "apps": ["Finder"]]],
        ],
        "sharedSkills": [
            ["id": "sh1", "spaceId": NSNull(), "spaceName": "", "sourceSkillId": "skill-9", "name": "expense report", "summary": "monthly",
             "publishedBy": "priya", "isMine": false, "version": 2, "stepCount": 7, "requires": ["Numbers"], "runCount": 12],
        ],
    ]

    func testThePollSummaryParsesIntoTheMacsView() throws {
        let summary = try XCTUnwrap(EnterpriseSummary(json: poll))
        XCTAssertEqual(summary.org?.name, "Acme")
        XCTAssertEqual(summary.org?.isAdmin, false)
        XCTAssertEqual(summary.meName, "sam")
        XCTAssertEqual(summary.spaces.map(\.name), ["sales", "design"])
        XCTAssertEqual(summary.joinedSpaces.map(\.id), ["sp1"])
        XCTAssertEqual(summary.unreadCount, 3)
        XCTAssertEqual(summary.approvals.first?.risk, .high)
        XCTAssertEqual(summary.approvals.first?.commands, ["rm -rf …"])
        XCTAssertEqual(summary.approvals.first?.workerName, "pat")
        XCTAssertEqual(summary.sharedSkills.first?.requires, ["Numbers"])
        XCTAssertNil(summary.sharedSkills.first?.spaceId)
        XCTAssertNil(EnterpriseSummary(json: nil))
        XCTAssertNil(EnterpriseSummary(json: ["org": NSNull()]))
    }

    @MainActor
    func testAnswersAndReadsStayAheadOfTheDeployment() async {
        let store = freshStore()
        let service = EnterpriseService()
        service.start(store: store)
        service.apply(poll)
        XCTAssertTrue(service.linked)
        XCTAssertEqual(service.approvals.count, 1)
        XCTAssertEqual(service.unreadSpaces.map(\.name), ["sales"])
        XCTAssertEqual(service.pendingWelcome?.text, "Try 'replay the expense report'.")

        // Marked read here: the count is gone at once and stays gone when the next poll still says 3.
        await service.markRead(spaceID: "sp1")
        XCTAssertEqual(service.unreadCount, 0)
        service.apply(poll)
        XCTAssertEqual(service.unreadCount, 0)

        // The welcome shows once per organization.
        service.welcomeShown()
        XCTAssertNil(service.pendingWelcome)
        service.apply(poll)
        XCTAssertNil(service.pendingWelcome)
        XCTAssertEqual(store.settings.welcomedOrgIDs, ["org1"])

        // Unlinked: everything clears.
        service.apply(nil)
        XCTAssertFalse(service.linked)
        XCTAssertEqual(service.approvals, [])
    }

    @MainActor
    func testSpacesAreFoundByNameAndPulledSkillsStopBeingPullable() {
        let store = freshStore()
        let service = EnterpriseService()
        service.start(store: store)
        service.apply(poll)
        XCTAssertEqual(service.space(named: "#sales")?.id, "sp1")
        XCTAssertEqual(service.space(named: "the design space")?.id, "sp2")
        XCTAssertNil(service.space(named: "marketing"))
        XCTAssertEqual(service.pullableSkills.map(\.name), ["expense report"])
        store.importSkill(sharedID: "sh1", name: "expense report", summary: "", stepsJSON: [["id": "s1", "text": "Open Numbers", "app": "Numbers"]], version: 2)
        XCTAssertEqual(service.pullableSkills, [])
    }

    @MainActor
    func testManagedConfigurationSeedsSyncAndAJoinCodeWithoutOverridingChoices() {
        let store = freshStore()
        XCTAssertEqual(ManagedConfig.cleanCode("ab-c1 23"), "ABC123")
        XCTAssertEqual(ManagedConfig.cleanCode("abc"), "")
        let clean = ManagedConfig(convexSiteURL: "https://acme.convex.site", joinCode: "ABC123", orgName: "Acme")
        XCTAssertEqual(clean.apply(to: store), ["sync", "account", "join"])
        XCTAssertEqual(store.settings.convexSiteURL, "https://acme.convex.site")
        XCTAssertTrue(store.settings.syncEnabled)
        XCTAssertEqual(store.settings.pendingJoinCode, "ABC123")
        XCTAssertEqual(store.settings.pendingJoinOrgName, "Acme")
        let work = store.accounts.first { $0.kind == .work }
        XCTAssertNotNil(work)
        XCTAssertEqual(store.activeAccount.kind, .personal, "the person keeps the account they were on")

        // Applied again: nothing changes. A different URL later never overrides what's set.
        XCTAssertEqual(clean.apply(to: store), [])
        store.settings.convexSiteURL = "https://mine.convex.site"
        XCTAssertEqual(ManagedConfig(convexSiteURL: "https://other.convex.site").apply(to: store), [])
        XCTAssertEqual(store.settings.convexSiteURL, "https://mine.convex.site")

        XCTAssertEqual(ManagedConfig.current(defaults: UserDefaults(suiteName: "okidoki-tests-empty")!, environment: ["OKIDOKI_MANAGED_JOIN_CODE": "xyz789"]).joinCode, "XYZ789")
    }
}
