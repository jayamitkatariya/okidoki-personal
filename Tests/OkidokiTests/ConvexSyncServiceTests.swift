import Foundation
import XCTest
@testable import OkidokiCore

/// The Convex sync routes in memory, with the same rules as backend/convex: a version per account,
/// pushes accepted only on top of the current version, pulls by version, tombstones for deletes,
/// floors for capped runs and threads. Lets two stores sync against one backend in a test.
final class FakeConvex {
    struct Row { var item: [String: Any]; var version: Int }
    var versions: [String: Int] = [:]
    var rows: [String: [String: Row]] = [:] // "account/table" → id → row
    var tombstones: [String: [(table: String, id: String, version: Int, at: Date)]] = [:]
    var log: [String] = []
    var syncBodies: [[String: Any]] = []
    /// Answer every route with this status (401: a wrong secret, 404 on /api/version: an older backend).
    var forcedStatus: [String: Int] = [:]
    /// Pushes to refuse as if another Mac had synced first.
    var refuseNextSyncs = 0

    static let tables = ["threads", "memories", "runs", "skills", "routines"]

    func handle(_ request: URLRequest, body: Data?) -> (Int, Data) {
        let url = request.url!
        let path = url.path
        log.append(path)
        if let forced = forcedStatus[path] { return (forced, Data("{}".utf8)) }
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch path {
        case "/api/version":
            let account = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "accountId" }?.value ?? ""
            return ok(["version": versions[account] ?? 0, "syncing": false])
        case "/api/pull":
            let account = json["accountId"] as! String
            let table = json["table"] as! String
            let since = json["since"] as? Int ?? 0
            let version = versions[account] ?? 0
            if table == "deletions" {
                let items = (tombstones[account] ?? []).filter { $0.version > since }.map {
                    ["table": $0.table, "id": $0.id, "deletedAt": SyncDates.string(from: $0.at)] as [String: Any]
                }
                return ok(["version": version, "items": items, "cursor": "", "isDone": true])
            }
            let items: [Any] = (rows["\(account)/\(table)"] ?? [:]).values.filter { since == 0 || $0.version > since }.map(\.item)
            return ok(["version": version, "items": items, "cursor": "", "isDone": true])
        case "/api/sync":
            syncBodies.append(json)
            let account = json["accountId"] as! String
            let current = versions[account] ?? 0
            if let base = json["baseVersion"] as? Int {
                if refuseNextSyncs > 0 {
                    refuseNextSyncs -= 1
                    versions[account] = current + 1 // the other Mac's sync
                    return (409, try! JSONSerialization.data(withJSONObject: ["error": "behind", "version": current + 1]))
                }
                if base != current { return (409, try! JSONSerialization.data(withJSONObject: ["error": "behind", "version": current])) }
            }
            let version = current + 1
            versions[account] = version
            let state = json["state"] as! [String: Any]
            let floors = json["floors"] as? [String: String] ?? [:]
            for table in Self.tables {
                guard let items = state[table] as? [[String: Any]] else { continue }
                let key = "\(account)/\(table)"
                var existing = rows[key] ?? [:]
                let keep = Set(items.compactMap { $0["id"] as? String })
                for item in items {
                    let id = item["id"] as! String
                    let changed = existing[id].map { !NSDictionary(dictionary: $0.item).isEqual(to: item) } ?? true
                    if changed {
                        existing[id] = Row(item: item, version: version)
                        tombstones[account]?.removeAll { $0.id == id }
                    }
                }
                for (id, row) in existing where !keep.contains(id) {
                    if let floor = floors[table] {
                        let key = table == "runs" ? row.item["createdAt"] as? String : row.item["updatedAt"] as? String
                        if (key ?? "") < floor { continue }
                    }
                    existing[id] = nil
                    tombstones[account, default: []].append((table, id, version, Date()))
                }
                rows[key] = existing
            }
            return ok(["ok": true, "version": version, "written": 0, "removed": 0])
        default:
            return (404, Data("{}".utf8))
        }
    }

    func ids(_ account: String, _ table: String) -> [String] {
        (rows["\(account)/\(table)"] ?? [:]).keys.sorted()
    }

    private func ok(_ json: [String: Any]) -> (Int, Data) {
        (200, try! JSONSerialization.data(withJSONObject: json))
    }
}

final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest, Data?) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        let (status, data) = Self.handler?(request, body) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class ConvexSyncServiceTests: XCTestCase {
    private var folder: URL!
    private var convex: FakeConvex!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        convex = FakeConvex()
        let fake = convex!
        StubURLProtocol.handler = { request, body in fake.handle(request, body: body) }
    }

    override func tearDown() async throws {
        StubURLProtocol.handler = nil
        try? FileManager.default.removeItem(at: folder)
    }

    private func mac(_ name: String) -> (OkidokiStore, ConvexSyncService) {
        let store = OkidokiStore(stateURL: folder.appendingPathComponent("\(name)/state.json"), deviceID: name)
        store.settings.syncEnabled = true
        store.settings.convexSiteURL = "https://fake.convex.site"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let service = ConvexSyncService(session: URLSession(configuration: configuration), secret: { "secret" }, device: name)
        return (store, service)
    }

    /// Mac B signed in to the same login: it has Mac A's account (same id) in front.
    private func sameAccount(_ b: OkidokiStore, as a: OkidokiStore) {
        b.adoptAccount(a.activeAccount)
        b.switchAccount(a.currentAccountID)
    }

    func testTheFirstSyncPushesOnTopOfVersionZeroAndAnUnchangedMacThenOnlyChecksTheVersion() async throws {
        let (store, service) = mac("mac-a")
        store.addMemory("studies at Purdue")
        await service.sync(store: store)
        XCTAssertEqual(service.status, "synced just now")
        let account = store.currentAccountID
        XCTAssertEqual(convex.syncBodies.first?["baseVersion"] as? Int, 0)
        XCTAssertEqual(convex.ids(account, "memories").count, 1)
        XCTAssertEqual(store.syncCursors[account], 1)
        XCTAssertNotNil(store.settings.lastSyncAt)

        convex.log.removeAll()
        await service.sync(store: store)
        XCTAssertEqual(convex.log, ["/api/version"])
        XCTAssertEqual(service.lastReport?.skipped, [account])
    }

    func testANoteAddedOnOneMacReachesTheOtherAndADeleteFollowsIt() async throws {
        let (a, syncA) = mac("mac-a")
        let (b, syncB) = mac("mac-b")
        sameAccount(b, as: a)
        let note = try XCTUnwrap(a.addMemory("studies at Purdue"))
        a.createRoutine(name: "brief", prompt: "brief me")
        await syncA.sync(store: a)

        await syncB.sync(store: b)
        XCTAssertEqual(b.activeMemories.map(\.text), ["studies at Purdue"])
        XCTAssertEqual(syncB.lastReport?.merged.added, 2)
        XCTAssertFalse(b.isFromThisMac(b.activeRoutines[0]), "Mac A's routine doesn't fire on Mac B")

        b.deleteMemory(note.id)
        await syncB.sync(store: b)
        XCTAssertTrue(convex.ids(a.currentAccountID, "memories").isEmpty)

        await syncA.sync(store: a)
        XCTAssertTrue(a.activeMemories.isEmpty)
        XCTAssertEqual(syncA.lastReport?.merged.removed, 1)
    }

    func testAMacThatIsBehindPullsAndMergesBeforeItsPushCanDeleteAnything() async throws {
        let (a, syncA) = mac("mac-a")
        let (b, syncB) = mac("mac-b")
        sameAccount(b, as: a)
        await syncA.sync(store: a)
        await syncB.sync(store: b)

        // Both edit while apart; A syncs first.
        a.addMemory("from the laptop")
        b.addMemory("from the desktop")
        await syncA.sync(store: a)
        await syncB.sync(store: b)

        let account = a.currentAccountID
        XCTAssertEqual(convex.ids(account, "memories").count, 2, "B's push didn't delete A's note")
        await syncA.sync(store: a)
        XCTAssertEqual(Set(a.activeMemories.map(\.text)), ["from the laptop", "from the desktop"])
        XCTAssertEqual(Set(b.activeMemories.map(\.text)), ["from the laptop", "from the desktop"])
    }

    func testARefusedPushIsRetriedAfterAFreshPull() async throws {
        let (store, service) = mac("mac-a")
        store.addMemory("note")
        convex.refuseNextSyncs = 1
        await service.sync(store: store)
        XCTAssertEqual(service.lastReport?.conflicts, 1)
        XCTAssertEqual(service.lastReport?.pushed, [store.currentAccountID])
        XCTAssertEqual(convex.syncBodies.map { $0["baseVersion"] as? Int }, [0, 1])
        XCTAssertEqual(store.syncCursors[store.currentAccountID], 2)
    }

    func testAMacThatKeepsLosingGivesUpForNowWithoutForcingItsPush() async throws {
        let (store, service) = mac("mac-a")
        store.addMemory("note")
        convex.refuseNextSyncs = 10
        await service.sync(store: store)
        XCTAssertEqual(service.status, "another Mac keeps syncing; will try again")
        XCTAssertTrue(convex.ids(store.currentAccountID, "memories").isEmpty)
    }

    func testEveryAccountSyncsEachWithItsOwnMemories() async throws {
        let (store, service) = mac("mac-a")
        let personal = store.currentAccountID
        store.addMemory("personal note")
        let work = store.createAccount(name: "work", email: "", kind: .work)
        store.addMemory("work note")
        await service.sync(store: store)
        XCTAssertEqual(convex.rows["\(personal)/memories"]?.values.map { $0.item["text"] as? String }, ["personal note"])
        XCTAssertEqual(convex.rows["\(work.id)/memories"]?.values.map { $0.item["text"] as? String }, ["work note"])
        XCTAssertEqual(Set(service.lastReport?.pushed ?? []), [personal, work.id])
    }

    func testOlderRunsBeyondThePushCapAreNotTakenForDeletes() async throws {
        let (store, service) = mac("mac-a")
        let start = Date().addingTimeInterval(-86_400)
        for index in 0..<(ConvexSyncService.maxRuns + 5) {
            store.runs.append(AgentRun(id: "run-\(index)", accountID: store.currentAccountID, kind: .terminal, title: "\(index)",
                                       prompt: "", status: .done, createdAt: start.addingTimeInterval(Double(index)), origin: "mac-a"))
        }
        await service.sync(store: store)
        let body = try XCTUnwrap(convex.syncBodies.last)
        XCTAssertEqual(((body["state"] as? [String: Any])?["runs"] as? [Any])?.count, ConvexSyncService.maxRuns)
        let floor = try XCTUnwrap((body["floors"] as? [String: String])?["runs"])
        XCTAssertEqual(SyncDates.date(from: floor)?.timeIntervalSince1970 ?? 0, start.addingTimeInterval(5).timeIntervalSince1970, accuracy: 0.01)
    }

    func testAWrongSecretAndAnOlderBackendAreReportedPlainly() async throws {
        let (store, service) = mac("mac-a")
        convex.forcedStatus["/api/version"] = 401
        await service.sync(store: store)
        XCTAssertEqual(service.status, "sync secret rejected")

        convex.forcedStatus["/api/version"] = 404
        await service.sync(store: store)
        XCTAssertEqual(service.lastReport?.legacy, true)
        XCTAssertNil(convex.syncBodies.last?["baseVersion"], "an older backend gets the push it understands")
        XCTAssertTrue(service.status.contains("one way"))
    }

    func testAnItemFromANewerBuildIsKeptAsItCameAndNeverDeletedByAnOlderMacsPush() async throws {
        let (a, syncA) = mac("mac-a")
        let (b, syncB) = mac("mac-b")
        sameAccount(b, as: a)
        a.addMemory("readable")
        await syncA.sync(store: a)
        let account = a.currentAccountID
        let future: [String: Any] = ["id": "future", "accountID": account, "kind": "teleport", "title": "from a newer build"]
        convex.rows["\(account)/runs", default: [:]]["future"] = FakeConvex.Row(item: future, version: convex.versions[account]!)

        await syncB.sync(store: b)
        XCTAssertEqual(b.activeMemories.map(\.text), ["readable"])
        XCTAssertEqual(syncB.lastReport?.unreadable, 1)
        XCTAssertEqual(b.unreadable.map(\.id), ["future"])

        // B changes something and pushes: the run it couldn't read goes back untouched.
        b.addMemory("from mac b")
        await syncB.sync(store: b)
        XCTAssertEqual(convex.ids(account, "runs"), ["future"])
        XCTAssertEqual(convex.rows["\(account)/runs"]?["future"]?.item["kind"] as? String, "teleport")
        XCTAssertTrue(convex.tombstones[account, default: []].isEmpty)

        // Once it's gone on Convex, B lets go of it too.
        convex.rows["\(account)/runs"] = [:]
        let version = convex.versions[account]! + 1
        convex.versions[account] = version
        convex.tombstones[account, default: []].append(("runs", "future", version, Date()))
        await syncB.sync(store: b)
        XCTAssertTrue(b.unreadable.isEmpty)
    }

    func testSyncIsOffWithoutTheSwitchAURLOrASecret() async throws {
        let (store, service) = mac("mac-a")
        store.settings.syncEnabled = false
        await service.sync(store: store)
        XCTAssertEqual(service.status, "local only")
        store.settings.syncEnabled = true
        let noSecret = ConvexSyncService(session: .shared, secret: { nil }, device: "x")
        await noSecret.sync(store: store)
        XCTAssertEqual(noSecret.status, "sync secret missing")
        XCTAssertTrue(convex.log.isEmpty)
    }
}
