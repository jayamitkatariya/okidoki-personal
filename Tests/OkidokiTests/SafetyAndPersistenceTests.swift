import XCTest
@testable import OkidokiCore

final class SafetyAndPersistenceTests: XCTestCase {
    func testPendingConnectorRespectsLatestSwitchesAndKeys() {
        var connectors = Connectors.defaults
        var settings = AppSettings()
        let call = #"{"connector":"mcp","server":"fixture","tool":"echo"}"#
        let apify = #"{"connector":"apify","actor":"test/actor"}"#
        func reason(_ json: String, key: Bool = true) -> String? {
            SafetyPolicy.connectorUnavailable(callJSON: json, connectors: connectors, settings: settings, hasApifyKey: key)
        }
        XCTAssertNotNil(reason(call))
        connectors[connectors.firstIndex { $0.id == "mcp" }!].enabled = true
        settings.mcpServers = [MCPServer(id: "fixture", name: "Fixture", command: "test-server")]
        XCTAssertNil(reason(call))
        settings.mcpServers[0].enabled = false
        XCTAssertNotNil(reason(call))
        settings.mcpServers[0].enabled = true
        settings.blockedApps = ["test-server"]
        XCTAssertNotNil(reason(call))
        settings.blockedApps = []
        settings.mcpServers = []
        XCTAssertNotNil(reason(call))
        connectors[connectors.firstIndex { $0.id == "apify" }!].enabled = true
        XCTAssertNil(reason(apify))
        XCTAssertNotNil(reason(apify, key: false))
        connectors[connectors.firstIndex { $0.id == "apify" }!].enabled = false
        XCTAssertNotNil(reason(apify))
        XCTAssertNotNil(reason(#"{"connector":"unknown"}"#))
    }

    func testToolSwitchBlocksCommandsWithoutMatchingUnrelatedWords() {
        var settings = AppSettings()
        settings.blockedApps = ["mo", "ffmpeg"]
        XCTAssertNotNil(SafetyPolicy.blocked(commands: ["/opt/homebrew/bin/ffmpeg -version"], settings: settings))
        XCTAssertNotNil(SafetyPolicy.blocked(commands: ["mo clean"], settings: settings))
        XCTAssertNil(SafetyPolicy.blocked(commands: ["echo remove movie"], settings: settings))
    }
}

extension SafetyAndPersistenceTests {
    func testDuplicateNativeJobCannotReplaceTheRunningProcess() async throws {
        let id = UUID().uuidString
        let done = expectation(description: "original stopped")
        ShellRunner.shared.stream(id: id, command: "sleep 5", onOutput: { _ in }, completion: { _ in done.fulfill() })
        let duplicate = expectation(description: "duplicate rejected")
        ShellRunner.shared.stream(id: id, command: "echo duplicate", onOutput: { _ in }, completion: { code in
            XCTAssertNotEqual(code, 0)
            duplicate.fulfill()
        })
        XCTAssertTrue(ShellRunner.shared.isRunning(id: id))
        ShellRunner.shared.cancel(id: id)
        await fulfillment(of: [done, duplicate], timeout: 2)
        XCTAssertFalse(ShellRunner.shared.isRunning(id: id))
    }
}

extension SafetyAndPersistenceTests {
    func testRunPreservesExecutionMetadataThroughSavingAndLoading() throws {
        for builtin in ["computer-use", "browser", "skill"] {
            let run = AgentRun(accountID: "fixture", kind: .computerUse, title: "fixture", prompt: "fixture",
                               builtin: builtin, pickedPath: "/tmp/a folder")
            XCTAssertEqual(run.builtin, builtin)
            XCTAssertEqual(run.pickedPath, "/tmp/a folder")
            let loaded = try JSONDecoder().decode(AgentRun.self, from: JSONEncoder().encode(run))
            XCTAssertEqual(loaded.builtin, builtin)
            XCTAssertEqual(loaded.pickedPath, "/tmp/a folder")
        }
    }
}

extension SafetyAndPersistenceTests {
    func testDashboardSettingsAndQueuedPlansSurviveReloadWithoutRerunningWork() async throws {
        try await MainActor.run {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let url = directory.appendingPathComponent("state.json")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = OkidokiStore(stateURL: url)
            store.settings.blockedApps = ["ffmpeg"]
            store.settings.mcpServers = [MCPServer(id: "fixture", name: "Fixture", command: "test-server")]
            store.setConnector("mcp", enabled: true)
            let queued = store.createRun(kind: .borrow, title: "queued", prompt: "queued", status: .waiting,
                                         builtin: "skill", pickedPath: "skill-id")
            let running = store.createRun(kind: .computerUse, title: "old drive", prompt: "old drive", status: .running)
            let connector = store.createRun(kind: .connector, title: "expired call", prompt: "expired call", status: .waiting)
            store.saveNow()
            let loaded = OkidokiStore(stateURL: url)
            XCTAssertEqual(loaded.settings.blockedApps, ["ffmpeg"])
            XCTAssertEqual(loaded.settings.mcpServers[0].id, "fixture")
            XCTAssertTrue(loaded.connectors.first { $0.id == "mcp" }?.enabled == true)
            XCTAssertEqual(loaded.run(queued.id)?.status, .waiting)
            XCTAssertEqual(loaded.run(queued.id)?.builtin, "skill")
            XCTAssertEqual(loaded.run(queued.id)?.pickedPath, "skill-id")
            XCTAssertEqual(loaded.run(running.id)?.status, .failed)
            XCTAssertEqual(loaded.run(connector.id)?.status, .failed)
            loaded.saveNow()
        }
    }
}
