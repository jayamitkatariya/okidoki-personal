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
        XCTAssertEqual(BrowserSteps.addressURL("localhost:3000")?.absoluteString, "http://localhost:3000")
        XCTAssertEqual(BrowserSteps.addressURL("node.js")?.host, "node.js")
        // A sentence with a dot in it isn't an address.
        XCTAssertEqual(BrowserSteps.addressURL("what is 2.5 x 4")?.host, "www.google.com")
    }

    func testAddressBarTellsSitesSearchesAndTasksApart() {
        for address in ["github.com", "news.ycombinator.com/item?id=1", "https://a.b/c", "localhost:8080", "192.168.1.1", "amazon.co.uk"] {
            XCTAssertTrue(BrowserSteps.looksLikeAddress(address), address)
            XCTAssertFalse(BrowserSteps.looksLikeTask(address), address)
        }
        for search in ["weather lisbon", "how to tie a tie", "best pizza near me", "is it going to rain tomorrow", "openai", "puma boots", "2.5 kg in lbs"] {
            XCTAssertFalse(BrowserSteps.looksLikeAddress(search), search)
            XCTAssertFalse(BrowserSteps.looksLikeTask(search), search)
        }
        for task in ["book a table for two at 8 tonight", "find me cheap flights to goa next weekend", "add blue puma boots size 9 to my cart",
                     "please check my amazon orders", "compare prices of the iphone 17 on amazon and flipkart",
                     "Order a large margherita from dominos", "can you sign me up for the newsletter", "renew my library books for me"] {
            XCTAssertTrue(BrowserSteps.looksLikeTask(task), task)
        }
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
        XCTAssertTrue(elements.contains(#"options: "Standard", "Express""#), "a dropdown lists its options: \(elements)")
        XCTAssertFalse(elements.contains("null"), elements)
        // Smart replay reads a dropdown's options by its selectors.
        let options = try await call("return window.__okidoki.optionsOf(['select[name=ship]'])") as? [String]
        XCTAssertEqual(options, ["Standard", "Express"])
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

    /// A rich editor (a mail body, a comment box) holds its text in the element, not a value: replaying
    /// a recorded type into it has to replace what's there and announce the change, or the step silently
    /// does nothing and everything after it lands in the wrong place.
    func testTypingIntoARichEditorReplacesItsTextAndAnnouncesIt() async throws {
        try await load("""
        <html><body>
          <div id="body" contenteditable="true"><p>old draft</p></div>
        </body></html>
        """)
        // Count the input events the page hears, from the page's own world.
        _ = try await webView.callAsyncJavaScript(
            "window.seen = []; document.getElementById('body').addEventListener('input', e => window.seen.push(e.data))",
            arguments: [:], in: nil, contentWorld: .page)
        let typed = try await object("return window.__okidoki.act({selectors: ['#body'], action: 'type', text: 'hello from a replay'})")
        XCTAssertEqual(typed["ok"] as? Bool, true, "\(typed)")
        let text = try await call("return document.getElementById('body').innerText.trim()") as? String
        XCTAssertEqual(text, "hello from a replay")
        let announced = try await webView.callAsyncJavaScript("return window.seen", arguments: [:], in: nil, contentWorld: .page) as? [String]
        XCTAssertEqual(announced, ["hello from a replay"], "the page must hear about it like a person's typing")
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

    func testHoverShowsWhatOnlyAPointerWouldWithoutMovingIt() async throws {
        try await load("""
        <html><head><style>.cap { display: none } .figure:hover .cap { display: block }</style></head><body>
          <div class="figure"><img alt="User Avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="80"><div class="cap">name: user1</div></div>
          <div class="figure"><img alt="User Avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="80" height="80"><div class="cap">name: user2</div></div>
        </body></html>
        """)
        let snap = try await object("return window.__okidoki.snapshot()")
        let elements = snap["elements"] as? String ?? ""
        XCTAssertTrue(elements.contains(#"image "User Avatar" (hover)"#), elements)
        XCTAssertFalse((snap["text"] as? String ?? "").contains("user2"))
        let lines = elements.split(separator: "\n").filter { $0.contains("User Avatar") }
        let second = Int(lines[1].dropFirst().prefix { $0.isNumber }) ?? 0
        let hovered = try await object("return window.__okidoki.act(a)", ["a": ["action": "hover", "ref": second]])
        XCTAssertEqual(hovered["ok"] as? Bool, true)
        let after = try await object("return window.__okidoki.snapshot()")
        XCTAssertTrue((after["text"] as? String ?? "").contains("name: user2"), after["text"] as? String ?? "")
        XCTAssertFalse((after["text"] as? String ?? "").contains("name: user1"))
    }

    func testFieldsLabelledBesideThemGetTheirLabel() async throws {
        try await load("""
        <html><body><form>
          <div class="row"><div class="col"><label id="dob-label">Date of Birth</label></div><div class="col"><div><input id="dobInput" value="04 Nov 2026"></div></div></div>
          <div class="row"><div class="col"><label>Subjects</label></div><div class="col"><div class="select"><div><input role="combobox" aria-autocomplete="list"></div></div></div></div>
          <div class="row"><label><input type="radio" name="g"> Male</label></div>
        </form></body></html>
        """)
        let elements = try await object("return window.__okidoki.snapshot()")["elements"] as? String ?? ""
        XCTAssertTrue(elements.contains(#"textbox "Date of Birth""#), elements)
        XCTAssertTrue(elements.contains(#"combobox "Subjects""#), elements)
        XCTAssertTrue(elements.contains(#"radio "Male""#), elements)
    }

    // MARK: Hand-off: only a real check calls the person

    private func check(_ html: String) async throws -> String? {
        try await load(html)
        let value = try await call("return window.__okidoki.humanCheck()")
        return (value as? [String: Any])?["kind"] as? String
    }

    private let longPage = String(repeating: "<p>Your order history, invoices and saved addresses are below. Returns are free within 30 days.</p>", count: 30)

    func testARealChallengeIsACheck() async throws {
        let challenge = try await check("<html><head><title>Just a moment...</title></head><body><h1>Verify you are human</h1><p>Checking your browser.</p></body></html>")
        XCTAssertEqual(challenge, "captcha")
        let widget = try await check("<html><body>\(longPage)<div class='g-recaptcha'><iframe src='https://captcha.invalid/recaptcha/api2/anchor?k=x' width='304' height='78'></iframe></div><textarea name='g-recaptcha-response' style='display:none'></textarea></body></html>")
        XCTAssertEqual(widget, "captcha")
        let code = try await check("<html><body><h2>Enter the verification code</h2><input name='otp' inputmode='numeric' maxlength='6'></body></html>")
        XCTAssertEqual(code, "code")
    }

    func testDecoysAreNotChecks() async throws {
        // reCAPTCHA's invisible corner badge, on an ordinary long page.
        let badge = try await check("<html><body>\(longPage)<div class='grecaptcha-badge' style='position:fixed;right:0;bottom:0;width:256px;height:60px'><iframe src='https://captcha.invalid/recaptcha/api2/anchor?k=x&size=invisible' width='256' height='60'></iframe></div></body></html>")
        XCTAssertNil(badge)
        // A footer that talks about security checks and verification codes.
        let footer = try await check("<html><body><h1>Your orders</h1><input name='search'>\(longPage)<footer>We run a security check on every order and will never ask for a verification code by phone. Turn on two-factor sign-in.</footer></body></html>")
        XCTAssertNil(footer)
        // A tracking frame from a captcha vendor, too small to be in the way.
        let pixel = try await check("<html><body>\(longPage)<iframe src='https://captcha.invalid/hcaptcha/1/api.js' width='1' height='1'></iframe></body></html>")
        XCTAssertNil(pixel)
    }

    func testATickedWidgetIsNoLongerInTheWay() async throws {
        let solved = try await check("<html><body>\(longPage)<div class='g-recaptcha'><iframe src='https://captcha.invalid/recaptcha/api2/anchor?k=x' width='304' height='78'></iframe></div><textarea name='g-recaptcha-response' style='display:none'>03AFcWeA\(String(repeating: "x", count: 40))</textarea></body></html>")
        XCTAssertNil(solved)
    }
}

final class BrowserDialogStepTests: XCTestCase {
    func testDialogStepsSayHowTheNextPopUpIsAnswered() {
        let cancel = BrowserSteps.dialog(accept: false, text: nil)
        XCTAssertEqual(cancel.action, "dialog")
        XCTAssertEqual(BrowserSteps.dialogAnswer(cancel.input).accept, false)
        let typed = BrowserSteps.dialog(accept: true, text: "{{reason}}")
        XCTAssertEqual(typed.input, "accept:{{reason}}")
        let answer = BrowserSteps.dialogAnswer(ParameterFill.fill(typed.input ?? "", values: ["reason": "moved house"]).text)
        XCTAssertTrue(answer.accept)
        XCTAssertEqual(answer.text, "moved house")
        XCTAssertEqual(BrowserSteps.dialogAnswer(nil).accept, true)
        XCTAssertNil(BrowserSteps.dialogAnswer("accept").text)
    }
}

/// The tidy that a recording goes through before it's kept: repeats cost a deterministic replay time
/// and, worse, can undo what the step before achieved (a dropdown reopened after it was closed).
final class BrowserRecordingCleanupTests: XCTestCase {
    private func step(_ action: String, _ selectors: [String], input: String? = nil) -> SkillStep {
        .browser(action, text: action, url: "https://shop.example/cart", selectors: selectors, input: input)
    }

    func testTypingTheSameFieldTwiceKeepsTheLastValue() {
        let steps = [step("type", ["#email"], input: "ja"), step("type", ["#email"], input: "jay@okidoki.app")]
        let tidied = BrowserRecordingCleanup.tidy(steps)
        XCTAssertEqual(tidied.count, 1)
        XCTAssertEqual(tidied.first?.input, "jay@okidoki.app")
    }

    func testTheSameActionOnTheSameControlTwiceIsKeptOnce() {
        // An agent that re-opens the dropdown it just chose from: a replay would close what it opened.
        let steps = [step("select", ["role=combobox|Round trip"]), step("select", ["role=combobox|Round trip"]),
                     step("click", ["role=button|Search"])]
        let tidied = BrowserRecordingCleanup.tidy(steps)
        XCTAssertEqual(tidied.map(\.action), ["select", "click"])
    }

    func testDifferentControlsAndRepeatedKeysAreNotDropped() {
        let steps = [step("click", ["#a"]), step("click", ["#b"]),
                     step("press", ["#a"], input: "Enter"), step("press", ["#a"], input: "Enter")]
        XCTAssertEqual(BrowserRecordingCleanup.tidy(steps).count, 4, "a second key press is a person pressing again")
    }

    func testATypedFieldThenAClickElsewhereKeepsBoth() {
        let steps = [step("type", ["#search"], input: "shoes"), step("click", ["role=button|Go"])]
        XCTAssertEqual(BrowserRecordingCleanup.tidy(steps).count, 2)
    }
}

/// Reading what a control holds now, which is how a replay decides a step worked without asking the model.
extension BrowserPageScriptTests {
    func testACustomDropdownReportsItsChosenTextNotAnEmptyValue() async throws {
        try await load("""
        <html><body>
          <div id="trip" role="combobox" aria-label="Trip type" tabindex="0">Round trip</div>
          <ul role="listbox">
            <li role="option" onclick="document.getElementById('trip').textContent='One way'">One way</li>
            <li role="option">Round trip</li>
          </ul>
        </body></html>
        """)
        // A div has no `value`: before the fix this answered "" and every replayed choice looked failed.
        let beforeValue = try await call("return JSON.stringify(window.__okidoki.valueOf(['#trip']))") as? String
        XCTAssertEqual(beforeValue, #"{"value":"Round trip","text":"Round trip"}"#)
        let chose = try await object("return window.__okidoki.act({selectors: ['#trip'], action: 'select', value: 'One way'})")
        XCTAssertEqual(chose["ok"] as? Bool, true, "\(chose)")
        let after = try await call("return document.getElementById('trip').textContent") as? String
        XCTAssertEqual(after, "One way", "choosing in a custom dropdown picks the option in the same step")
        let readBack = try await call("return JSON.stringify(window.__okidoki.valueOf(['#trip']))") as? String
        XCTAssertEqual(readBack, #"{"value":"One way","text":"One way"}"#)
    }
}

/// Whether the page says it's still working — the signal a replay waits on before reading or clicking.
extension BrowserPageScriptTests {
    func testAResultsPageThatSaysItIsLoadingCountsAsBusy() async throws {
        try await load("<html><body><h1>Flight search</h1><p>Loading results</p></body></html>")
        let busy = try await call("return window.__okidoki.busy()") as? Bool
        XCTAssertEqual(busy, true, "before its list exists the page is still working")
    }

    func testAFinishedPageMentioningLoadingInItsTextIsNotBusy() async throws {
        // A settled results page can carry the word "loading" in a placeholder or a help line; only the
        // results-fetching phrases count, or every step would wait for nothing.
        try await load("""
        <html><body><h1>Flight search</h1>
          <p>Nonstop flights. Loading times are shown per airport.</p>
          <p>$185 Southwest, 6:05 AM – 12:10 PM</p>
        </body></html>
        """)
        let busy = try await call("return window.__okidoki.busy()") as? Bool
        XCTAssertEqual(busy, false)
    }
}

/// What a read is handed. A page whose first 12k characters are chrome used to hide its own results.
extension BrowserPageScriptTests {
    func testTheTextKeepsTheContentEvenWhenChromeComesFirst() async throws {
        let chrome = (1...400).map { "<a href='#'>nav item \($0)</a>" }.joined()
        try await load("""
        <html><body>
          <nav>\(chrome)</nav>
          <main>
            <div class="fare">$185</div>
            <div>Southwest · 6:05 AM – 12:10 PM · nonstop</div>
            <div>SJC to MDW</div>
          </main>
          <footer>\(chrome)</footer>
        </body></html>
        """)
        let text = try await call("return window.__okidoki.pageText()") as? String ?? ""
        XCTAssertTrue(text.contains("$185"), "the fare survives the chrome")
        XCTAssertTrue(text.contains("nonstop"), text)
        XCTAssertTrue(text.count <= 12_000)
    }
}

/// A custom dropdown opens on one turn and is picked from on the next. Reporting success on the turn that
/// only opened it made every replayed choice silently not happen.
extension BrowserPageScriptTests {
    func testACustomDropdownReportsNotYetOnTheTurnThatOpensItThenPicks() async throws {
        try await load("""
        <html><body>
          <div id="trip" tabindex="0" onclick="
            if (!this.querySelector('ul')) this.innerHTML = this.innerHTML +
              '<ul><li role=option>One way</li><li role=option>Round trip</li></ul>'
          ">Round trip</div>
        </body></html>
        """)
        let selectors = ["#trip"]
        // First turn: the menu isn't open, so the action opens it and must say "not yet", not "done".
        let first = try await object("return window.__okidoki.act({selectors: s, action: 'select', value: 'One way'})", ["s": selectors])
        XCTAssertEqual(first["ok"] as? Bool, false, "\(first)")
        XCTAssertEqual(first["detail"] as? String, "not on this page")
        // Nothing marked as chosen yet: the menu is open, but no option was picked.
        let chosenYet = try await call("return document.querySelectorAll('#trip [aria-selected=true]').length") as? Int
        XCTAssertEqual(chosenYet, 0)
        // Second turn: the list is there, so it picks.
        let second = try await object("return window.__okidoki.act({selectors: s, action: 'select', value: 'One way'})", ["s": selectors])
        XCTAssertEqual(second["ok"] as? Bool, true, "\(second)")
        let text = try await call("return document.getElementById('trip').textContent") as? String
        XCTAssertTrue(text?.contains("One way") == true, "\(text ?? "")")
    }
}

/// What a read is handed: a results list repeats the same price on every row.
extension BrowserPageScriptTests {
    func testRepeatedRowValuesSurviveSoEachRowKeepsItsPrice() async throws {
        try await load("""
        <html><body><h1>All flights</h1>
          <div>8:20 AM<br>2:27 PM<br>AlaskaAmerican<br>4 hr 7 min<br>SEA–AUS<br>Nonstop<br>$159</div>
          <div>9:15 AM<br>3:27 PM<br>Delta<br>4 hr 12 min<br>SEA–AUS<br>Nonstop<br>$159</div>
          <div>11:48 AM<br>6:01 PM<br>AlaskaAmerican<br>4 hr 13 min<br>SEA–AUS<br>Nonstop<br>$159</div>
        </body></html>
        """)
        let text = try await call("return window.__okidoki.readText()") as? String ?? ""
        // De-duplicating lines left one "$159" at the top and three rows with none, and the model then
        // correctly refused to tie a price to a row.
        let prices = text.components(separatedBy: "$159").count - 1
        XCTAssertEqual(prices, 3, "every row keeps its own price: \(text)")
        XCTAssertEqual(text.components(separatedBy: "Nonstop").count - 1, 3)
    }
}
