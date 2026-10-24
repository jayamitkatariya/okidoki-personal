import XCTest
@testable import OkidokiCore

final class ToolboxTests: XCTestCase {
    func testEveryDashboardInstallIncludesDependenciesAndVerification() throws {
        for tool in ToolCatalog.tools {
            let plan = try TerminalActions.preparePlan([tool.installCommand, tool.checkCommand], installed: { _ in false })
            XCTAssertEqual(Array(plan.commands.suffix(2)), [tool.installCommand, tool.checkCommand], tool.name)
            XCTAssertEqual(plan.commands.count, plan.installs.count + 2, tool.name)
            if tool.installCommand.contains("brew ") {
                XCTAssertTrue(plan.commands.first?.contains("Homebrew/install") == true, tool.name)
                XCTAssertTrue(plan.asksForPassword, tool.name)
            }
        }
    }

    func testPendingConnectorRespectsLatestToolboxSwitchesAndKeys() {
        var connectors = ToolCatalog.defaultConnectors
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

extension ToolboxTests {
    func testNativeProgressIgnoresCommandLikeOutputAndRejectsEarlyExitSuccess() async {
        let marker = "fixture_marker"
        let commands = ["printf '$ fake step\\nhello'", "exit 0", "printf should-not-run"]
        let result = await ShellRunner.shared.run(command: TerminalActions.script(commands, progressMarker: marker))
        XCTAssertEqual(result.code, 0)
        let progress = TerminalActions.progress(in: result.output, marker: marker, commandCount: commands.count)
        XCTAssertEqual(progress.completed, [0])
        XCTAssertEqual(progress.currentStep, 1)
        XCTAssertTrue(progress.output.contains("$ fake step"))
        XCTAssertFalse(progress.output.contains(marker))
        XCTAssertFalse(progress.output.contains("should-not-run"))
    }

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

extension ToolboxTests {
    func testRunPreservesExecutionMetadataThroughSavingAndLoading() throws {
        for builtin in ["install", TerminalActions.launchBuiltin, "export-keynote", "skill"] {
            let run = AgentRun(accountID: "fixture", kind: .terminal, title: "fixture", prompt: "fixture",
                               builtin: builtin, pickedPath: "/tmp/a folder")
            XCTAssertEqual(run.builtin, builtin)
            XCTAssertEqual(run.pickedPath, "/tmp/a folder")
            let loaded = try JSONDecoder().decode(AgentRun.self, from: JSONEncoder().encode(run))
            XCTAssertEqual(loaded.builtin, builtin)
            XCTAssertEqual(loaded.pickedPath, "/tmp/a folder")
        }
    }
}

extension ToolboxTests {
    func testDashboardSettingsAndQueuedPlansSurviveReloadWithoutRerunningWork() async throws {
        try await MainActor.run {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let url = directory.appendingPathComponent("state.json")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = OkidokiStore(stateURL: url)
            store.settings.blockedApps = ["ffmpeg"]
            store.settings.selectedAgent = .hermes
            store.settings.mcpServers = [MCPServer(id: "fixture", name: "Fixture", command: "test-server")]
            store.setConnector("mcp", enabled: true)
            let queued = store.createRun(kind: .terminal, title: "queued", prompt: "queued", status: .waiting,
                                         builtin: "install", pickedPath: "ffmpeg")
            let running = store.createRun(kind: .terminal, title: "old process", prompt: "old process", status: .running)
            let connector = store.createRun(kind: .connector, title: "expired call", prompt: "expired call", status: .waiting)
            store.saveNow()
            let loaded = OkidokiStore(stateURL: url)
            XCTAssertEqual(loaded.settings.selectedAgent, .hermes)
            XCTAssertEqual(loaded.settings.blockedApps, ["ffmpeg"])
            XCTAssertEqual(loaded.settings.mcpServers[0].id, "fixture")
            XCTAssertTrue(loaded.connectors.first { $0.id == "mcp" }?.enabled == true)
            XCTAssertEqual(loaded.run(queued.id)?.status, .waiting)
            XCTAssertEqual(loaded.run(queued.id)?.builtin, "install")
            XCTAssertEqual(loaded.run(queued.id)?.pickedPath, "ffmpeg")
            XCTAssertEqual(loaded.run(running.id)?.status, .failed)
            XCTAssertEqual(loaded.run(connector.id)?.status, .failed)
            loaded.saveNow()
        }
    }
}

extension ToolboxTests {
    func testProgressSurvivesOutputTruncationAndFramesSplitAcrossReads() {
        let marker = "fixture"
        let buffer = TerminalOutputBuffer(marker: marker, commandCount: 2)
        buffer.append("\u{1e}fixture:start:0\u{1f}\n\u{1e}fixture:end:0:0\u{1f}\n\u{1e}fixture:sta")
        buffer.append("rt:1\u{1f}\n")
        buffer.append(String(repeating: "log line\n", count: 20_000))
        XCTAssertEqual(buffer.progress.currentStep, 1)
        XCTAssertEqual(buffer.progress.completed, [0])
        buffer.append("\u{1e}fixture:end:1:0\u{1f}\n")
        XCTAssertEqual(buffer.progress.completed, [0, 1])
        XCTAssertFalse(buffer.progress.output.contains(marker))
        XCTAssertLessThanOrEqual(buffer.progress.output.count, 80_000)
    }

    func testOutputReadsLikeATerminalWithoutColourCodesOrRedrawnProgressLines() {
        let buffer = TerminalOutputBuffer(marker: "fixture", commandCount: 1)
        buffer.append("\u{1e}fixture:start:0\u{1f}\n\u{1b}[1;32m==>\u{1b}[0m Downloading\n")
        buffer.append("  10%\r  55%\r 100%\r\n\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7}\n")
        buffer.append("step\u{1b}[")
        buffer.append("31m red\u{1b}[0m done\r\n\u{1e}fixture:end:0:0\u{1f}\n")
        let progress = buffer.progress
        XCTAssertEqual(progress.output, "==> Downloading\n 100%\nlink\nstep red done\n")
        XCTAssertEqual(progress.completed, [0])
        XCTAssertEqual(TerminalActions.cleanOutput("plain\n"), "plain\n")
    }

    func testBurstsOfOutputCoalesceIntoOneRefresh() {
        let buffer = TerminalOutputBuffer(marker: "fixture", commandCount: 1)
        buffer.append("a")
        XCTAssertTrue(buffer.needsRefresh())
        buffer.append("b")
        XCTAssertFalse(buffer.needsRefresh())
        XCTAssertEqual(buffer.progress.output, "ab")
        buffer.append("c")
        XCTAssertTrue(buffer.needsRefresh())
    }
}
