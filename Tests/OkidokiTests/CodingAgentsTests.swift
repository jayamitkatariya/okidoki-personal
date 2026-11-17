import XCTest
@testable import OkidokiCore

/// Coding agents: settings decode (old files, junk values), picking an agent, the working folder,
/// and finding CLIs on disk.
final class CodingAgentsTests: XCTestCase {
    func testOldSettingsDecodeWithoutCodingAgents() throws {
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data(#"{"claudeModel":"x"}"#.utf8))
        XCTAssertEqual(settings.codingAgents, CodingAgentSettings())
        XCTAssertTrue(settings.codingAgents.autoRoute)
        XCTAssertTrue(settings.codingAgents.enabled.isEmpty)
    }

    func testCodingAgentsRoundTripAndForgiveJunk() throws {
        let json = #"""
        {"summonMode":"agent","codingAgents":{"agents":[
          {"id":"claude","enabled":true,"access":"sideways"},
          {"id":"agent-1","name":"Aider","enabled":false,"command":"aider --message {prompt}","access":"full"}
        ],"defaultID":"claude","workingFolder":"~/Scratch"}}
        """#
        let settings = try JSONDecoder().decode(AppSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.summonMode, "agent")
        let agents = settings.codingAgents.agents
        XCTAssertEqual(agents.count, 2)
        XCTAssertEqual(agents[0].name, "Claude Code", "a preset with no name takes the preset's")
        XCTAssertEqual(agents[0].access, "workspace", "an unknown access level is the safe one")
        XCTAssertFalse(agents[0].isCustom)
        XCTAssertTrue(agents[1].isCustom)
        XCTAssertEqual(agents[1].access, "full")
        XCTAssertTrue(settings.codingAgents.autoRoute)

        let again = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(again.codingAgents, settings.codingAgents)
    }

    func testPickPrefersAskedThenDefaultThenFirstOn() {
        let settings = CodingAgentSettings(agents: [
            CodingAgentConfig(id: "claude", name: "Claude Code", enabled: true),
            CodingAgentConfig(id: "codex", name: "Codex", enabled: true),
            CodingAgentConfig(id: "pi", name: "Pi", enabled: false),
        ], defaultID: "codex")
        XCTAssertEqual(settings.pick("claude")?.id, "claude")
        XCTAssertEqual(settings.pick(nil)?.id, "codex")
        XCTAssertEqual(settings.pick("pi")?.id, "codex", "an agent that's off is never picked")
        var noDefault = settings
        noDefault.defaultID = "gone"
        XCTAssertEqual(noDefault.pick(nil)?.id, "claude")
        XCTAssertNil(CodingAgentSettings().pick(nil))
    }

    func testFolderFallsBackToVaultThenHome() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(CodingAgentSettings(workingFolder: dir.path).folder(vault: "/nope"), dir.path)
        XCTAssertEqual(CodingAgentSettings().folder(vault: dir.path), dir.path)
        XCTAssertEqual(CodingAgentSettings(workingFolder: "/does/not/exist").folder(vault: "/nope"), NSHomeDirectory())
    }

    func testDetectionFindsExecutablesInSearchPaths() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let codex = dir.appendingPathComponent("codex")
        try "#!/bin/sh\n".write(to: codex, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: codex.path)
        // Not executable: not an agent.
        try "x".write(to: dir.appendingPathComponent("amp"), atomically: true, encoding: .utf8)

        let found = CodingAgentCatalog.detect(paths: [dir.path])
        XCTAssertEqual(found.map(\.id), CodingAgentCatalog.presets.map(\.id))
        XCTAssertEqual(found.first { $0.id == "codex" }?.path, codex.path)
        XCTAssertNil(found.first { $0.id == "amp" }?.path)
        XCTAssertNil(found.first { $0.id == "claude" }?.path)
        XCTAssertTrue(found.first { $0.id == "pi" }!.unguarded)

        // A path set in Settings wins, wherever it is.
        let overridden = CodingAgentCatalog.detect(paths: [], overrides: ["claude": codex.path])
        XCTAssertEqual(overridden.first { $0.id == "claude" }?.path, codex.path)
    }

    func testSearchPathsCoverUsualInstallFolders() {
        let paths = CodingAgentCatalog.searchPaths(home: NSHomeDirectory())
        for folder in ["/opt/homebrew/bin", "\(NSHomeDirectory())/.local/bin", "\(NSHomeDirectory())/.bun/bin", "\(NSHomeDirectory())/.npm-global/bin"] {
            XCTAssertTrue(paths.contains(folder), folder)
        }
    }

    func testRunKindAndDecisionDecode() throws {
        XCTAssertEqual(try JSONDecoder().decode(RunKind.self, from: Data(#""coding_agent""#.utf8)), .codingAgent)
        let decision = try JSONDecoder().decode(BrainDecision.self, from: Data(#"{"kind":"coding_agent","title":"t","answer":"a","agentTask":"sort pdfs","agentId":"codex"}"#.utf8))
        XCTAssertEqual(decision.kind, .codingAgent)
        XCTAssertEqual(decision.agentTask, "sort pdfs")
        XCTAssertEqual(decision.agentID, "codex")
        let again = try JSONDecoder().decode(BrainDecision.self, from: JSONEncoder().encode(decision))
        XCTAssertEqual(again.agentID, "codex")
    }
}
