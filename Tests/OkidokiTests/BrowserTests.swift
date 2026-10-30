import WebKit
import XCTest
@testable import OkidokiCore

final class VaultCryptoTests: XCTestCase {
    func testOpensWhatThePanelSealed() throws {
        // Sealed by web/src/vaultCrypto.ts (WebCrypto) with this passphrase and vault id.
        let key = try XCTUnwrap(VaultCrypto.key(passphrase: "correct horse battery", vaultID: "B1A3F0C2-0000-4000-8000-000000000001"))
        XCTAssertEqual(VaultCrypto.open(ciphertext: "0QGvDL66qHJSOSimUnVwOW97bDA6va+f8sYX46LDA7KZV8gM", iv: "oBdeTGOpiPDaRHbs", key: key),
                       "hunter2 · ünïcode")
        let wrong = try XCTUnwrap(VaultCrypto.key(passphrase: "wrong", vaultID: "B1A3F0C2-0000-4000-8000-000000000001"))
        XCTAssertNil(VaultCrypto.open(ciphertext: "0QGvDL66qHJSOSimUnVwOW97bDA6va+f8sYX46LDA7KZV8gM", iv: "oBdeTGOpiPDaRHbs", key: wrong))
    }

    func testRoundTrip() throws {
        let key = try XCTUnwrap(VaultCrypto.key(passphrase: "p", vaultID: "v"))
        let sealed = try XCTUnwrap(VaultCrypto.seal("s3cret", key: key))
        XCTAssertEqual(VaultCrypto.open(ciphertext: sealed.ciphertext, iv: sealed.iv, key: key), "s3cret")
    }
}

final class BrowserStepsTests: XCTestCase {
    func testRecordedSecretsBecomeVaultPlaceholders() throws {
        let password = try XCTUnwrap(BrowserSteps.step(from: [
            "action": "type", "url": "https://www.github.com/login", "secret": true, "kind": "password",
            "label": "Password", "selectors": ["#password"],
        ]))
        XCTAssertEqual(password.input, "{{vault:github.com.password}}")
        XCTAssertEqual(password.text, "fill “Password” from your vault")
        XCTAssertTrue(password.isBrowser)
        XCTAssertEqual(password.selectors, ["#password"])
        XCTAssertEqual(BrowserSteps.vaultReference(in: password.input!)?.site, "github.com")
        XCTAssertEqual(BrowserSteps.vaultReference(in: password.input!)?.field, "password")

        let typed = try XCTUnwrap(BrowserSteps.step(from: ["action": "type", "url": "https://x.com", "text": "weather in {{city}}", "label": "Search"]))
        XCTAssertEqual(typed.input, "weather in {{city}}")
        XCTAssertNil(BrowserSteps.step(from: ["action": "hover"]))
    }

    func testVaultPlaceholdersAreNotParametersToAskFor() {
        let steps = [
            SkillStep.browser("type", text: "", url: "", input: "{{vault:github.com.password}}"),
            SkillStep.browser("type", text: "", url: "", input: "{{city}}"),
        ]
        XCTAssertEqual(ParameterFill.names(in: steps), ["city"])
    }

    func testLoginsOnlyMatchTheirOwnSite() {
        XCTAssertTrue(BrowserSteps.sameSite("github.com", "https://www.github.com/login"))
        XCTAssertTrue(BrowserSteps.sameSite("accounts.google.com", "google.com"))
        XCTAssertFalse(BrowserSteps.sameSite("box.com", "x.com"), "a suffix isn't a subdomain")
        XCTAssertFalse(BrowserSteps.sameSite("evil-bank.com", "bank.com"))
        XCTAssertFalse(BrowserSteps.sameSite("", "bank.com"))
    }

    func testRunsOfRemovedKindsStillLoad() throws {
        let old = #"{"id":"r","accountID":"a","kind":"teach","title":"t","prompt":"p","status":"done","steps":[],"output":"","summary":"","createdAt":0}"#
        let run = try JSONDecoder().decode(AgentRun.self, from: Data(old.utf8))
        XCTAssertEqual(run.kind, .answer)
    }

    func testAddressBar() {
        XCTAssertEqual(BrowserSteps.addressURL("github.com")?.absoluteString, "https://github.com")
        XCTAssertEqual(BrowserSteps.addressURL("https://a.b/c?d=1")?.absoluteString, "https://a.b/c?d=1")
        XCTAssertEqual(BrowserSteps.addressURL("weather lisbon")?.host, "www.google.com")
        XCTAssertEqual(BrowserSteps.displayURL("https://www.google.com/travel/flights?q=1"), "google.com/travel/flights")
    }

    func testBrowserOnlySkills() {
        let browser = Skill(accountID: "a", name: "n", summary: "", steps: [BrowserSteps.navigate("https://x.com")])
        XCTAssertTrue(browser.runsInBrowser)
        let mixed = Skill(accountID: "a", name: "n", summary: "", steps: [BrowserSteps.navigate("https://x.com"), SkillStep(text: "click", app: "Finder")])
        XCTAssertFalse(mixed.runsInBrowser)
    }
}

/// The page script against real pages in a real WKWebView: what the agent reads, how it acts, and
/// whether a recorded element is found again after the page changes around it.
@MainActor
final class BrowserPageScriptTests: XCTestCase {
    private var webView: WKWebView!
    private let world = WKContentWorld.world(name: BrowserPageScript.worldName)

    override func setUp() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(
            WKUserScript(source: BrowserPageScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1000, height: 800), configuration: configuration)
    }

    private func load(_ html: String) async throws {
        final class Waiter: NSObject, WKNavigationDelegate {
            var done: CheckedContinuation<Void, Never>?
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.resume(); done = nil }
        }
        let waiter = Waiter()
        webView.navigationDelegate = waiter
        await withCheckedContinuation { continuation in
            waiter.done = continuation
            webView.loadHTMLString(html, baseURL: URL(string: "https://shop.example/"))
        }
        webView.navigationDelegate = nil
    }

    private func call(_ body: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await webView.callAsyncJavaScript(body, arguments: arguments, in: nil, contentWorld: world)
    }

    private func object(_ body: String, _ arguments: [String: Any] = [:]) async throws -> [String: Any] {
        let value = try await call(body, arguments)
        return try XCTUnwrap(value as? [String: Any], "\(String(describing: value))")
    }

    private let form = """
    <html><body>
      <h1>Checkout</h1>
      <label for="email">Email</label><input id="email" name="email">
      <input type="password" name="pw" aria-label="Password">
      <select name="ship"><option>Standard</option><option>Express</option></select>
      <button data-testid="pay" onclick="document.getElementById('out').textContent = 'paid ' + document.getElementById('email').value">Pay now</button>
      <div id="out"></div>
      <div style="display:none"><button>Hidden</button></div>
    </body></html>
    """

    func testSnapshotListsWhatCanBeUsedAndHidesSecrets() async throws {
        try await load(form)
        let snap = try await object("return window.__okidoki.snapshot()")
        let elements = try XCTUnwrap(snap["elements"] as? String)
        XCTAssertTrue(elements.contains(#"textbox "Email""#), elements)
        XCTAssertTrue(elements.contains(#"password "Password" (password field)"#), elements)
        XCTAssertTrue(elements.contains(#"button "Pay now""#), elements)
        XCTAssertFalse(elements.contains("Hidden"), "invisible elements aren't offered")
        XCTAssertTrue((snap["text"] as? String ?? "").contains("Checkout"))
    }

    func testActsOnTheDomAndReturnsSelectors() async throws {
        try await load(form)
        _ = try await call("return window.__okidoki.snapshot()")
        let typed = try await object("return window.__okidoki.act({ref: 1, action: 'type', text: 'jay@okidoki.app'})")
        XCTAssertEqual(typed["ok"] as? Bool, true)
        XCTAssertEqual((typed["selectors"] as? [String])?.first, "#email")
        let chose = try await object("return window.__okidoki.act({ref: 3, action: 'select', value: 'express'})")
        XCTAssertEqual(chose["ok"] as? Bool, true)
        let paid = try await object("return window.__okidoki.act({ref: 4, action: 'click'})")
        XCTAssertEqual((paid["selectors"] as? [String])?.first, #"[data-testid="pay"]"#)
        let out = try await call("return document.getElementById('out').textContent") as? String
        XCTAssertEqual(out, "paid jay@okidoki.app")
        let ship = try await call("return document.querySelector('select').value") as? String
        XCTAssertEqual(ship, "Express")
    }

    func testRecordedElementIsFoundAgainAfterTheLayoutChanges() async throws {
        try await load(form)
        _ = try await call("return window.__okidoki.snapshot()")
        let located = try await object("return window.__okidoki.act({ref: 4, action: 'locate'})")
        let recorded = try XCTUnwrap(located["selectors"] as? [String])
        // A redesign: the test id is gone, the button moved into a new wrapper, the text stayed.
        try await load("""
        <html><body><nav><a href="#">Home</a></nav><main><section><div>
          <button class="btn-primary" onclick="this.textContent='clicked'">Pay now</button>
        </div></section></main></body></html>
        """)
        let replayed = try await object("return window.__okidoki.act({selectors: s, action: 'click'})", ["s": recorded])
        XCTAssertEqual(replayed["ok"] as? Bool, true, "\(replayed)")
        XCTAssertGreaterThan(replayed["matched"] as? Int ?? 0, 0, "the first selector no longer works, a later one does")
        let text = try await call("return document.querySelector('button').textContent") as? String
        XCTAssertEqual(text, "clicked")
    }

    func testLoginFillFindsTheFields() async throws {
        try await load(form)
        let result = try await object("return window.__okidoki.fillLogin('jay', 'pw1')")
        XCTAssertEqual(result["ok"] as? Bool, true)
        let values = try await call("return [document.getElementById('email').value, document.querySelector('[type=password]').value]") as? [String]
        XCTAssertEqual(values, ["jay", "pw1"])
    }

    /// The number the README quotes: one replayed step (find the element by its saved selectors, act on it).
    func testAReplayedStepTakesMillisecondsNotSeconds() async throws {
        let rows = (1...300).map { "<tr><td>row \($0)</td><td><button>Edit \($0)</button></td></tr>" }.joined()
        try await load("<html><body><table>\(rows)</table>" + form.dropFirst("<html><body>".count))
        let steps: [[String: Any]] = [
            ["action": "type", "selectors": ["#email"], "text": "jay@okidoki.app"],
            ["action": "select", "selectors": [#"select[name="ship"]"#], "value": "Express"],
            ["action": "click", "selectors": [#"[data-testid="gone"]"#, "role=button|Pay now"]],
        ]
        let rounds = 20
        let started = Date()
        for _ in 0..<rounds {
            for step in steps {
                let result = try await object("return window.__okidoki.act(a)", ["a": step])
                XCTAssertEqual(result["ok"] as? Bool, true)
            }
        }
        let perStep = Date().timeIntervalSince(started) / Double(rounds * steps.count) * 1000
        print("browser replay: \(String(format: "%.1f", perStep)) ms per step")
        XCTAssertLessThan(perStep, 50)
    }

    func testThePageCannotSeeTheScript() async throws {
        try await load(form)
        let fromPage = try await webView.callAsyncJavaScript("return typeof window.__okidoki", arguments: [:], in: nil, contentWorld: .page) as? String
        XCTAssertEqual(fromPage, "undefined")
    }
}
