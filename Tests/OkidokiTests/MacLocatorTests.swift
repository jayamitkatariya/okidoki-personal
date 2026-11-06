import CoreGraphics
import XCTest
@testable import OkidokiCore

/// Builds a `MacTree` the way the app's snapshot does: windows first, children after their parent,
/// sibling numbers counted per role.
final class TreeBuilder {
    var tree: MacTree
    init(app: String = "AcmeDesk", bundleID: String = "dev.okidoki.acmedesk") { tree = MacTree(app: app, bundleID: bundleID) }

    @discardableResult
    func window(_ title: String, frame: CGRect = CGRect(x: 100, y: 100, width: 500, height: 400), subrole: String = "AXStandardWindow", front: Bool = true) -> Int {
        let index = tree.nodes.count
        tree.nodes.append(MacNode(role: "AXWindow", subrole: subrole, label: title, frame: frame, parent: nil, sibling: 1, window: index))
        if front { tree.front = index }
        return index
    }

    @discardableResult
    func add(_ role: String, under parent: Int, label: String = "", id: String = "", value: String = "", subrole: String = "",
             frame: CGRect? = nil, enabled: Bool = true, focused: Bool = false) -> Int {
        let index = tree.nodes.count
        let sibling = tree.nodes.filter { $0.parent == parent && $0.role == role }.count + 1
        tree.nodes.append(MacNode(role: role, subrole: subrole, identifier: id, label: label, value: value, frame: frame,
                                  enabled: enabled, focused: focused, parent: parent, sibling: sibling, window: tree.nodes[parent].window))
        return index
    }
}

final class MacLocatorTests: XCTestCase {

    func detailsTree() -> (TreeBuilder, name: Int, next: Int) {
        let b = TreeBuilder()
        let w = b.window("AcmeDesk — Return details")
        b.add("AXStaticText", under: w, value: "Return details")
        let name = b.add("AXTextField", under: w, label: "Full name", id: "name", frame: CGRect(x: 250, y: 150, width: 280, height: 22))
        b.add("AXTextField", under: w, label: "PAN", id: "pan", frame: CGRect(x: 250, y: 180, width: 280, height: 22))
        let next = b.add("AXButton", under: w, label: "Next", id: "details-next", frame: CGRect(x: 130, y: 400, width: 80, height: 24))
        return (b, name, next)
    }

    func testTriesIdentifierThenLabelInWindowThenAppThenPoint() {
        let locator = AXLocator(window: "Return details", role: "AXButton", identifier: "next", label: "Next", relX: 70, relY: 312)
        XCTAssertEqual(MacLocator.candidates(locator), [
            .identifier("next"),
            .roleLabel(role: "AXButton", label: "Next", sameWindow: true),
            .roleLabel(role: "AXButton", label: "Next", sameWindow: false),
            .point(x: 70, y: 312),
        ])
        XCTAssertEqual(MacLocator.candidates(AXLocator(role: "AXButton")), [])
    }

    func testFindsByIdentifierFirst() {
        let (b, name, _) = detailsTree()
        let hit = MacLocator.find(AXLocator(window: "Return details", role: "AXTextField", identifier: "name", label: "Something else"), in: b.tree)
        XCTAssertEqual(hit?.node, name)
        XCTAssertEqual(hit?.how, .identifier("name"))
    }

    func testRandomIdentifierFallsBackToRoleAndLabel() {
        let (b, name, _) = detailsTree()
        let hit = MacLocator.find(AXLocator(window: "Return details", role: "AXTextField", identifier: "name-x7q2-311", label: "Full name"), in: b.tree)
        XCTAssertEqual(hit?.node, name)
        XCTAssertEqual(hit?.how, .roleLabel(role: "AXTextField", label: "Full name", sameWindow: true))
    }

    func testIdentifierOnAnotherRoleIsNotAMatch() {
        let (b, _, _) = detailsTree()
        XCTAssertNil(MacLocator.find(AXLocator(role: "AXButton", identifier: "name"), in: b.tree))
    }

    func testLabelsCompareLoosely() {
        XCTAssertTrue(MacLocator.sameLabel("Save…", "save"))
        XCTAssertTrue(MacLocator.sameLabel("  Full   name: ", "full name"))
        XCTAssertTrue(MacLocator.sameLabel("Zoë", "Zoe"))
        XCTAssertFalse(MacLocator.sameLabel("", ""))
        XCTAssertFalse(MacLocator.sameLabel("Next", "Next page"))
    }

    func testRenamedControlIsNotFoundAndItsOldSpotIsNotClicked() {
        // Drift: "Next" became "Continue". The point alone must not click whatever is there now.
        let (b, _, _) = detailsTree()
        let locator = AXLocator(window: "Return details", role: "AXButton", label: "Next", relX: 70, relY: 312)
        var drifted = b.tree
        drifted.nodes[4].label = "Continue"
        XCTAssertNil(MacLocator.find(locator, in: drifted))
        XCTAssertEqual(MacLocator.find(locator, in: drifted, allowPoint: true)?.node, 4)
    }

    func testPointOnlyLocatorUsesThePoint() {
        let (b, _, next) = detailsTree()
        // Window at (100,100): the button's centre (170,412) is (70,312) in the window.
        XCTAssertEqual(MacLocator.find(AXLocator(role: "AXButton", relX: 70, relY: 312), in: b.tree)?.node, next)
    }

    func testPrefersTheRecordedWindowWhenTwoWindowsHaveTheControl() {
        let b = TreeBuilder()
        let a = b.window("Invoices", front: false)
        let first = b.add("AXButton", under: a, label: "Save")
        let w = b.window("AcmeDesk — Return details")
        let second = b.add("AXButton", under: w, label: "Save")
        XCTAssertEqual(MacLocator.find(AXLocator(window: "Return details", role: "AXButton", label: "Save"), in: b.tree)?.node, second)
        XCTAssertEqual(MacLocator.find(AXLocator(window: "Invoices", role: "AXButton", label: "Save"), in: b.tree)?.node, first)
    }

    func testAmbiguousHitsRankByPathThenNearestPoint() {
        let b = TreeBuilder()
        let w = b.window("AcmeDesk — Deductions", frame: CGRect(x: 0, y: 0, width: 600, height: 500))
        let list = b.add("AXGroup", under: w, label: "Deduction rows")
        let row1 = b.add("AXGroup", under: list, label: "Deduction 1")
        let row2 = b.add("AXGroup", under: list, label: "Deduction 2")
        let a1 = b.add("AXTextField", under: row1, label: "Amount", frame: CGRect(x: 200, y: 100, width: 100, height: 20))
        let a2 = b.add("AXTextField", under: row2, label: "Amount", frame: CGRect(x: 200, y: 130, width: 100, height: 20))
        let byPath = AXLocator(window: "Deductions", role: "AXTextField", label: "Amount", path: ["AXWindow", "AXGroup[1]", "AXGroup[2]"])
        let hit = MacLocator.find(byPath, in: b.tree)
        XCTAssertEqual(hit?.node, a2)
        XCTAssertEqual(hit?.ambiguous, true)
        let byPoint = AXLocator(window: "Deductions", role: "AXTextField", label: "Amount", relX: 250, relY: 110)
        XCTAssertEqual(MacLocator.find(byPoint, in: b.tree)?.node, a1)
    }

    func testTemplatedLoopRowLocatorFindsEachRow() {
        let b = TreeBuilder()
        let w = b.window("AcmeDesk — Deductions")
        let list = b.add("AXGroup", under: w)
        var amounts: [Int] = []
        for n in 1...3 {
            let row = b.add("AXGroup", under: list, label: "Deduction \(n)")
            amounts.append(b.add("AXTextField", under: row, label: "Amount \(n)", id: "amount-\(n)"))
        }
        let template = AXLocator(window: "Deductions", role: "AXTextField", identifier: "amount-{{item.index}}", label: "Amount {{item.index}}",
                                 path: ["AXWindow", "AXGroup[1]", "AXGroup[{{item.index}}]"])
        XCTAssertTrue(template.isTemplated)
        for n in 1...3 {
            let filled = template.filled(["item.index": String(n)])
            XCTAssertFalse(filled.isTemplated)
            XCTAssertEqual(MacLocator.find(filled, in: b.tree)?.node, amounts[n - 1])
        }
        // Random identifiers: the label still finds the row's field.
        var random = b.tree
        for i in amounts { random.nodes[i].identifier = "x-\(i)" }
        XCTAssertEqual(MacLocator.find(template.filled(["item.index": "2"]), in: random)?.node, amounts[1])
    }

    func testSecureFieldOnlyMatchesSecure() {
        let b = TreeBuilder()
        let w = b.window("Sign in")
        let plain = b.add("AXTextField", under: w, label: "Password")
        let secure = b.add("AXTextField", under: w, label: "Password", subrole: "AXSecureTextField")
        XCTAssertEqual(MacLocator.find(AXLocator(role: "AXTextField", subrole: "AXSecureTextField", label: "Password"), in: b.tree)?.node, secure)
        XCTAssertNotEqual(MacLocator.find(AXLocator(role: "AXTextField", label: "Password"), in: b.tree)?.node, nil)
        _ = plain
    }

    func testMakeRecordsEverythingAndRoundTrips() throws {
        let b = TreeBuilder()
        let w = b.window("AcmeDesk — Deductions", frame: CGRect(x: 100, y: 50, width: 600, height: 500))
        let list = b.add("AXGroup", under: w)
        _ = b.add("AXGroup", under: list)
        let row = b.add("AXGroup", under: list)
        let field = b.add("AXTextField", under: row, label: "Amount 2", id: "amount-2", frame: CGRect(x: 300, y: 200, width: 100, height: 20))
        let made = MacLocator.make(field, in: b.tree)
        XCTAssertEqual(made.bundleID, "dev.okidoki.acmedesk")
        XCTAssertEqual(made.window, "AcmeDesk — Deductions")
        XCTAssertEqual(made.path, ["AXWindow", "AXGroup[1]", "AXGroup[2]"])
        XCTAssertEqual(made.index, 1)
        XCTAssertEqual(made.relX, 250)
        XCTAssertEqual(made.relY, 160)
        XCTAssertNil(made.inSheet)
        XCTAssertEqual(MacLocator.find(made, in: b.tree)?.node, field)
        let data = try JSONEncoder().encode(made)
        XCTAssertEqual(try JSONDecoder().decode(AXLocator.self, from: data), made)
    }

    func testOlderStepsImplyALocatorFromLabelAndRole() {
        var step = SkillStep(text: "click Next", app: "AcmeDesk", x: 270, y: 512, action: "click", label: "Next", role: "AXButton",
                             window: CGRect(x: 200, y: 200, width: 500, height: 400), windowTitle: "AcmeDesk — Return details")
        let implied = MacLocator.implied(by: step)
        XCTAssertEqual(implied?.label, "Next")
        XCTAssertEqual(implied?.relX, 70)
        XCTAssertEqual(implied?.relY, 312)
        step.label = nil
        XCTAssertNil(MacLocator.implied(by: step))
    }

    func testStepsWithoutALocatorDecodeAsBefore() throws {
        let json = #"{"id":"a","text":"click","app":"Numbers","action":"click","label":"Add"}"#
        let step = try JSONDecoder().decode(SkillStep.self, from: Data(json.utf8))
        XCTAssertNil(step.axLocator)
        var with = step
        with.axLocator = AXLocator(role: "AXButton", label: "Add")
        let back = try JSONDecoder().decode(SkillStep.self, from: JSONEncoder().encode(with))
        XCTAssertEqual(back.axLocator?.label, "Add")
    }

    // MARK: - The screen

    func reviewTree() -> TreeBuilder {
        let b = TreeBuilder()
        let w = b.window("AcmeDesk — Deductions")
        b.add("AXStaticText", under: w, value: "Deductions")
        b.add("AXTextField", under: w, label: "Amount 1", value: "1,50,000")
        b.add("AXTextField", under: w, label: "Password", value: "hunter2", subrole: "AXSecureTextField")
        let sheet = b.add("AXSheet", under: w)
        b.add("AXStaticText", under: sheet, value: "Review your return")
        b.add("AXStaticText", under: sheet, value: "Name: Bharat Mehta")
        b.add("AXButton", under: sheet, label: "Back")
        b.add("AXButton", under: sheet, label: "Submit", focused: true)
        return b
    }

    func testObservationReadsWindowSheetsAndText() {
        let seen = MacScreen.observe(reviewTree().tree)
        XCTAssertEqual(seen.window, "AcmeDesk — Deductions")
        XCTAssertEqual(seen.sheets, ["Review your return"])
        XCTAssertTrue(seen.text.contains("Name: Bharat Mehta"))
        XCTAssertTrue(seen.text.contains("1,50,000"))
        XCTAssertFalse(seen.text.contains("hunter2"), "a secure field's value is never read")
        XCTAssertEqual(seen.focusedRole, "AXButton")
        XCTAssertFalse(seen.busy)
        XCTAssertEqual(seen.dialogs.first?.buttons, ["Back", "Submit"])
        XCTAssertTrue(seen.dialogs.first?.modal ?? false)
        // Anchors and expectations see the sheet as part of the title.
        XCTAssertTrue(HybridReplay.matches(StepAnchor(landmark: "Review your return", app: "AcmeDesk", window: "Deductions"), seen.hybrid))
        XCTAssertFalse(HybridReplay.matches(StepAnchor(app: "AcmeDesk", window: "Sign in"), seen.hybrid))
    }

    func testTextIsBounded() {
        let b = TreeBuilder()
        let w = b.window("Big")
        for n in 0..<400 { b.add("AXStaticText", under: w, value: "line \(n) with some words in it") }
        XCTAssertLessThanOrEqual(MacScreen.observe(b.tree).text.count, MacScreen.textLimit)
    }

    func testBusyWhileASpinnerShows() {
        let b = TreeBuilder()
        let w = b.window("Deductions")
        XCTAssertFalse(MacScreen.isBusy(b.tree))
        b.add("AXProgressIndicator", under: w, frame: CGRect(x: 0, y: 0, width: 16, height: 16))
        XCTAssertTrue(MacScreen.isBusy(b.tree))
        var hidden = b.tree
        hidden.nodes[1].frame = .zero
        XCTAssertFalse(MacScreen.isBusy(hidden))
    }

    func testInDialogFollowsTheAncestorChain() {
        let b = reviewTree()
        XCTAssertTrue(b.tree.inDialog(8))
        XCTAssertFalse(b.tree.inDialog(2))
        let found = MacLocator.find(AXLocator(window: "Deductions", inSheet: true, role: "AXButton", label: "Submit"), in: b.tree)
        XCTAssertEqual(found?.node, 8)
    }

    func testPresentMeansAControlOrTextSaysIt() {
        let tree = reviewTree().tree
        XCTAssertTrue(MacScreen.present("Review your return", in: tree))
        XCTAssertTrue(MacScreen.present("submit", in: tree))
        XCTAssertFalse(MacScreen.present("Verify email", in: tree))
    }

    func testControlsListIsNumberedAndHidesSecrets() {
        let controls = MacScreen.controls(reviewTree().tree)
        XCTAssertEqual(controls.map(\.id), [1, 2, 3, 4])
        XCTAssertTrue(controls[0].line.contains("“Amount 1” = “1,50,000”"))
        XCTAssertTrue(controls[1].line.contains("(password field)"))
        XCTAssertFalse(controls[1].line.contains("hunter2"))
        XCTAssertTrue(controls[3].line.contains("(in a dialog)"))
    }

    func testMacExpectations() {
        let seen = MacScreen.observe(reviewTree().tree)
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(sheetGone: "Review"), seen.hybrid, sheets: seen.sheets), ["“Review” is still open"])
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(sheetGone: "Stay signed in"), seen.hybrid, sheets: seen.sheets), [])
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(fileExists: "~/x.pdf"), seen.hybrid, fileExists: { _ in false }), ["there's no file at ~/x.pdf"])
        XCTAssertEqual(HybridReplay.unmet(StepExpectation(windowTitleContains: "Deductions"), seen.hybrid), [])
        XCTAssertFalse(StepExpectation(sheetGone: "x").isEmpty)
    }
}
