import XCTest
import SQLite3
@testable import OkidokiCore

final class AgentDetectionTests: XCTestCase {
    private var home: String!

    override func setUpWithError() throws {
        home = NSTemporaryDirectory() + "okidoki-agents-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: home)
    }

    private func put(_ relative: String, _ text: String) throws {
        let path = (home as NSString).appendingPathComponent(relative)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try text.write(toFile: path, atomically: true, encoding: .utf8)
    }

    func testEmptyHomeIsSignedOutEverywhere() {
        for agent in CodingAgentID.allCases {
            XCTAssertEqual(AgentDetection.probe(agent, home: home), .none, agent.rawValue)
        }
        let status = AgentDetection.detect(home: home, installed: { _ in false })
        XCTAssertEqual(status.map(\.id), CodingAgentID.allCases.map(\.rawValue))
        XCTAssertFalse(status.contains(where: \.ready))
    }

    func testClaudeReadsTokenFileAndAccountEmail() throws {
        try put(".claude/.credentials.json", #"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r","expiresAt":1}}"#)
        try put(".claude.json", #"{"oauthAccount":{"emailAddress":"jay@example.com","organizationName":"Jay"}}"#)
        let probe = AgentDetection.probe(.claude, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.account, "jay@example.com")
        XCTAssertEqual(probe.providers, ["anthropic"])
        XCTAssertEqual(probe.source, "~/.claude/.credentials.json")
    }

    func testClaudeCountsAsSignedInWhenOnlyTheAccountIsOnDisk() throws {
        // Newer builds keep the token in the Keychain, which okidoki never opens; the email still lands in ~/.claude.json.
        try put(".claude.json", #"{"oauthAccount":{"emailAddress":"jay@example.com"}}"#)
        let probe = AgentDetection.probe(.claude, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.source, "~/.claude.json")
        try put(".claude.json", #"{"numStartups":3}"#)
        XCTAssertFalse(AgentDetection.probe(.claude, home: home).signedIn)
    }

    func testOpenCodeListsProvidersWithCredentials() throws {
        setenv("XDG_DATA_HOME", home + "/.local/share", 1)
        defer { unsetenv("XDG_DATA_HOME") }
        try put(".local/share/opencode/auth.json", #"{"anthropic":{"type":"oauth","refresh":"r","access":"a"},"openrouter":{"type":"api","key":"k"},"empty":{"type":"api","key":""}}"#)
        let probe = AgentDetection.probe(.opencode, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.providers, ["anthropic", "openrouter"])
    }

    func testOmpReadsProvidersFromItsVault() throws {
        try FileManager.default.createDirectory(atPath: home + "/.omp/agent", withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(home + "/.omp/agent/agent.db", &db), SQLITE_OK)
        let sql = """
        CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT);
        INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', '{}');
        INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', '{}');
        INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('openai', 'api', '{}', 'revoked');
        """
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)
        let probe = AgentDetection.probe(.omp, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.providers, ["anthropic"])
    }

    func testHermesPoolsProvidersAndEnvKeys() throws {
        try put(".hermes/auth.json", #"{"credential_pool":{"nous":[{"x":1}],"anthropic":[]},"active_provider":"nous"}"#)
        try put(".hermes/.env", "# keys\nOPENROUTER_API_KEY=\"sk-or-1\"\nexport GROQ_API_KEY=\nMODEL=foo\n")
        let probe = AgentDetection.probe(.hermes, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.providers, ["nous", "openrouter"])
    }

    func testCodexPullsEmailOutOfTheIDToken() throws {
        let payload = Data(#"{"https://api.openai.com/profile":{"email":"jay@example.com"},"sub":"u1"}"#.utf8)
            .base64EncodedString().replacingOccurrences(of: "=", with: "")
        try put(".codex/auth.json", #"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"h.\#(payload).s","access_token":"a","refresh_token":"r"}}"#)
        let probe = AgentDetection.probe(.codex, home: home)
        XCTAssertTrue(probe.signedIn)
        XCTAssertEqual(probe.account, "jay@example.com")
        XCTAssertEqual(probe.providers, ["openai"])
    }

    func testCodexApiKeyModeCountsToo() throws {
        try put(".codex/auth.json", #"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-1","tokens":null}"#)
        XCTAssertTrue(AgentDetection.probe(.codex, home: home).signedIn)
        try put(".codex/auth.json", #"{"auth_mode":"apikey","OPENAI_API_KEY":null,"tokens":null}"#)
        XCTAssertFalse(AgentDetection.probe(.codex, home: home).signedIn)
    }

    func testGeminiAndCursorReadTheirAccountFiles() throws {
        try put(".gemini/oauth_creds.json", #"{"access_token":"a","refresh_token":"r"}"#)
        try put(".gemini/google_accounts.json", #"{"active":"jay@gmail.com","old":[]}"#)
        let gemini = AgentDetection.probe(.gemini, home: home)
        XCTAssertTrue(gemini.signedIn)
        XCTAssertEqual(gemini.account, "jay@gmail.com")

        try put(".cursor/cli-config.json", #"{"version":1,"authInfo":{"email":"jay@example.com","displayName":"","userId":"user_1","authId":"x"}}"#)
        let cursor = AgentDetection.probe(.cursor, home: home)
        XCTAssertTrue(cursor.signedIn)
        XCTAssertEqual(cursor.account, "jay@example.com")

        try put(".cursor/cli-config.json", #"{"version":1,"authInfo":{"email":"","userId":""}}"#)
        XCTAssertFalse(AgentDetection.probe(.cursor, home: home).signedIn)
    }

    func testReadyNeedsBothInstalledAndSignedIn() throws {
        try put(".claude.json", #"{"oauthAccount":{"emailAddress":"jay@example.com"}}"#)
        let status = AgentDetection.detect(home: home, installed: { $0 == .opencode })
        XCTAssertFalse(status.first { $0.id == "claude" }!.ready)
        XCTAssertFalse(status.first { $0.id == "opencode" }!.ready)
        XCTAssertTrue(status.first { $0.id == "claude" }!.signedIn)
        XCTAssertTrue(status.first { $0.id == "opencode" }!.installed)
    }
}
