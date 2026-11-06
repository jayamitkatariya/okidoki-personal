import AppKit
import ApplicationServices
import XCTest
@testable import OkidokiCore

/// The real accessibility reader against the AcmeDesk fixture app (scripts/cu-fixture), launched in the
/// background with its window far off every display. Nothing moves the pointer or types: it reads the
/// tree, finds controls by locator and acts through Accessibility only.
///
/// Opt in: `scripts/cu-fixture/build.sh && OKIDOKI_FIXTURE_AX=1 swift test --filter MacFixtureAXTests`
final class MacFixtureAXTests: XCTestCase {
    var home: URL!
    var app: NSRunningApplication?

    override func setUp() async throws {
        guard ProcessInfo.processInfo.environment["OKIDOKI_FIXTURE_AX"] == "1" else { throw XCTSkip("set OKIDOKI_FIXTURE_AX=1 to run against the fixture app") }
        guard AXIsProcessTrusted() else { throw XCTSkip("needs Accessibility for the test runner") }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bundle = root.appendingPathComponent("build/cu-fixture/AcmeDesk.app")
        guard FileManager.default.fileExists(atPath: bundle.path) else { throw XCTSkip("build the fixture first: scripts/cu-fixture/build.sh") }
        home = FileManager.default.temporaryDirectory.appendingPathComponent("acmedesk-test-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data(#"{"offscreen": true}"#.utf8).write(to: home.appendingPathComponent("config.json"))
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.createsNewApplicationInstance = true
        configuration.environment = ["ACMEDESK_HOME": home.path]
        app = try await NSWorkspace.shared.openApplication(at: bundle, configuration: configuration)
        for _ in 0..<50 {
            if let pid = app?.processIdentifier, !MacAXReader.snapshot(pid: pid).tree.windows.isEmpty { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    override func tearDown() async throws {
        app?.terminate()
        if let home { try? FileManager.default.removeItem(at: home) }
    }

    func element(_ locator: AXLocator) throws -> (AXUIElement, MacNode) {
        let snapshot = MacAXReader.snapshot(pid: try XCTUnwrap(app).processIdentifier)
        let hit = try XCTUnwrap(MacLocator.find(locator, in: snapshot.tree), "nothing for \(locator)")
        return (snapshot.elements[hit.node], snapshot.tree.nodes[hit.node])
    }

    func testReadsFindsAndActsWithoutThePointer() async throws {
        let pid = try XCTUnwrap(app).processIdentifier
        var seen = MacScreen.observe(MacAXReader.snapshot(pid: pid).tree)
        XCTAssertEqual(seen.window, "AcmeDesk — Sign in")
        XCTAssertEqual(seen.bundleID, "dev.okidoki.acmedesk")
        // The window is off every display.
        let frame = try XCTUnwrap(MacAXReader.snapshot(pid: pid).tree.nodes.first?.frame)
        XCTAssertFalse(NSScreen.screens.contains { CGDisplayBounds(($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) ?? 0).intersects(frame) })

        let (user, _) = try element(AXLocator(window: "Sign in", role: "AXTextField", identifier: "username", label: "Username"))
        XCTAssertEqual(AXUIElementSetAttributeValue(user, kAXValueAttribute as CFString, "eval" as CFTypeRef), .success)
        // A random identifier: role and label still find the secure field.
        let (password, node) = try element(AXLocator(window: "Sign in", role: "AXTextField", subrole: "AXSecureTextField", identifier: "pw-x1", label: "Password"))
        XCTAssertEqual(node.value, "", "a secure field's value is never read")
        XCTAssertEqual(AXUIElementSetAttributeValue(password, kAXValueAttribute as CFString, "eval" as CFTypeRef), .success)
        let (signIn, _) = try element(AXLocator(window: "Sign in", role: "AXButton", label: "Sign in"))
        XCTAssertEqual(AXUIElementPerformAction(signIn, kAXPressAction as CFString), .success)
        try await Task.sleep(nanoseconds: 400_000_000)
        seen = MacScreen.observe(MacAXReader.snapshot(pid: pid).tree)
        XCTAssertEqual(seen.window, "AcmeDesk — Return details")

        // What recording keeps for a control, and that it finds that control again.
        let (income, _) = try element(AXLocator(window: "Return details", role: "AXTextField", label: "Income"))
        let recorded = try XCTUnwrap(MacAXReader.locator(for: income))
        XCTAssertEqual(recorded.identifier, "income")
        XCTAssertEqual(recorded.window, "AcmeDesk — Return details")
        XCTAssertEqual(recorded.path, ["AXWindow"])
        XCTAssertEqual(recorded.bundleID, "dev.okidoki.acmedesk")
        XCTAssertEqual(AXUIElementSetAttributeValue(income, kAXValueAttribute as CFString, "1250000" as CFTypeRef), .success)
        let (again, node2) = try element(recorded)
        XCTAssertTrue(CFEqual(again, income))
        // Read back through the app's own mask.
        XCTAssertTrue(HybridReplay.sameValue(typed: "1250000", field: node2.value))
        XCTAssertEqual(node2.value, "12,50,000")
    }
}
