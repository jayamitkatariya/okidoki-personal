import CoreGraphics
import Foundation

// Finding a control in a Mac app again, and reading the screen it's on, from Accessibility.
// Everything here is pure: the app takes one snapshot of an app's accessibility tree (`MacTree`), and
// these decide which node is the step's control, what the screen says, which dialogs are up and
// whether the app is still busy. The browser's selectors, page observation and dialogs, for the Mac.

/// How to find one control again: in which app and window, what it is, and where it sat.
/// Several ways at once, tried from the most exact (its identifier) to the least (a point in the window).
public struct AXLocator: Codable, Equatable, Sendable {
    public var bundleID: String?
    public var app: String?
    /// The title of its window when it was recorded; matched loosely ("contains").
    public var window: String?
    /// It was inside a sheet or a dialog.
    public var inSheet: Bool?
    public var role: String
    public var subrole: String?
    /// `AXIdentifier`, when the app sets one. Stable in most apps; random in some.
    public var identifier: String?
    /// Its title, description or placeholder: what a person would call it.
    public var label: String?
    /// Its containers from the window down, each "Role[n]" (n counts siblings of that role from 1):
    /// `["AXWindow", "AXGroup[1]", "AXGroup[2]"]`. Loop rows are templated: `AXGroup[{{item.index}}]`.
    public var path: [String]?
    /// Which of its parent's children of the same role it was (from 1).
    public var index: Int?
    /// Its centre relative to the window's top-left corner, in points.
    public var relX: Double?
    public var relY: Double?

    public init(bundleID: String? = nil, app: String? = nil, window: String? = nil, inSheet: Bool? = nil, role: String,
                subrole: String? = nil, identifier: String? = nil, label: String? = nil, path: [String]? = nil,
                index: Int? = nil, relX: Double? = nil, relY: Double? = nil) {
        self.bundleID = bundleID; self.app = app; self.window = window; self.inSheet = inSheet; self.role = role
        self.subrole = subrole; self.identifier = identifier; self.label = label; self.path = path; self.index = index
        self.relX = relX; self.relY = relY
    }

    /// Placeholders filled with a pass's values: a loop row's `Amount {{item.index}}` → `Amount 2`.
    public func filled(_ values: [String: String]) -> AXLocator {
        var out = self
        let fill: (String?) -> String? = { $0.map { $0.contains("{{") ? ParameterFill.fill($0, values: values).text : $0 } }
        out.identifier = fill(identifier)
        out.label = fill(label)
        out.window = fill(window)
        out.path = path?.map { $0.contains("{{") ? ParameterFill.fill($0, values: values).text : $0 }
        return out
    }

    public var isTemplated: Bool {
        ([identifier, label, window].compactMap { $0 } + (path ?? [])).contains { $0.contains("{{") }
    }
}

/// One element of an app's accessibility tree, as a snapshot.
public struct MacNode: Equatable, Sendable {
    public var role: String
    public var subrole: String
    public var identifier: String
    /// Title, description or placeholder: what it's called.
    public var label: String
    /// Its value: a field's text, a static text's words, a checkbox's 0 or 1, a pop-up's choice.
    public var value: String
    public var frame: CGRect?
    public var enabled: Bool
    public var focused: Bool
    /// Index of its parent in the tree; nil for a window.
    public var parent: Int?
    /// Which of its parent's children of the same role it is (from 1).
    public var sibling: Int
    /// Which top-level window it belongs to (an index into the tree).
    public var window: Int

    public init(role: String, subrole: String = "", identifier: String = "", label: String = "", value: String = "",
                frame: CGRect? = nil, enabled: Bool = true, focused: Bool = false, parent: Int? = nil, sibling: Int = 1, window: Int = 0) {
        self.role = role; self.subrole = subrole; self.identifier = identifier; self.label = label; self.value = value
        self.frame = frame; self.enabled = enabled; self.focused = focused; self.parent = parent; self.sibling = sibling; self.window = window
    }

    public var isSecure: Bool { subrole == "AXSecureTextField" }
    public var isWindow: Bool { parent == nil }
    public var isSheet: Bool { role == "AXSheet" }
    public var isDialogWindow: Bool { isWindow && ["AXDialog", "AXSystemDialog", "AXSystemFloatingWindow"].contains(subrole) }
}

/// An app's windows and everything in them, flattened (parents before children).
public struct MacTree: Equatable, Sendable {
    public var app: String
    public var bundleID: String
    public var nodes: [MacNode]
    /// The window in front (focused, else main, else the first).
    public var front: Int?

    public init(app: String = "", bundleID: String = "", nodes: [MacNode] = [], front: Int? = nil) {
        self.app = app; self.bundleID = bundleID; self.nodes = nodes; self.front = front
    }

    public var windows: [Int] { nodes.indices.filter { nodes[$0].parent == nil } }

    public func children(of index: Int) -> [Int] { nodes.indices.filter { nodes[$0].parent == index } }

    /// From the window down to `index`, inclusive.
    public func chain(to index: Int) -> [Int] {
        var out = [index]
        var at = index
        while let up = nodes[at].parent { out.insert(up, at: 0); at = up }
        return out
    }

    /// Nodes under `index`, depth first, `index` included.
    public func subtree(_ index: Int) -> [Int] {
        // One pass for every node's children, then depth first: linear, it runs on every look.
        var kids = [[Int]](repeating: [], count: nodes.count)
        for (i, node) in nodes.enumerated() { if let p = node.parent, p < nodes.count { kids[p].append(i) } }
        var out: [Int] = []
        var stack = [index]
        while let next = stack.popLast() {
            out.append(next)
            stack.append(contentsOf: kids[next].reversed())
        }
        return out
    }

    /// The window's title (its label).
    public func title(of window: Int) -> String { nodes[window].label }

    /// Whether `index` sits inside a sheet or a dialog window.
    public func inDialog(_ index: Int) -> Bool {
        chain(to: index).contains { nodes[$0].isSheet || nodes[$0].isDialogWindow }
    }
}

public enum MacLocator {

    /// One way of looking for a control, in the order they're tried.
    public enum Try: Equatable, Sendable {
        case identifier(String)
        /// Same role and label in the same window (title contains this), or anywhere in the app.
        case roleLabel(role: String, label: String, sameWindow: Bool)
        /// The recorded spot in the window (only when nothing else knows it, or to break a tie).
        case point(x: Double, y: Double)
    }

    /// The order to look: identifier → role and label in its window → role and label anywhere in the app →
    /// the point in its window. A picture match (the recorded crop) comes after these and lives app-side.
    public static func candidates(_ locator: AXLocator) -> [Try] {
        var out: [Try] = []
        if let id = locator.identifier, !id.isEmpty { out.append(.identifier(id)) }
        if let label = locator.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty {
            if let window = locator.window, !window.isEmpty { out.append(.roleLabel(role: locator.role, label: label, sameWindow: true)) }
            out.append(.roleLabel(role: locator.role, label: label, sameWindow: false))
        }
        if let x = locator.relX, let y = locator.relY { out.append(.point(x: x, y: y)) }
        return out
    }

    public struct Hit: Equatable, Sendable {
        public var node: Int
        public var how: Try
        /// Another node fitted as well and this one won on rank.
        public var ambiguous: Bool
    }

    /// The node `locator` means in `tree`, or nil. A point alone never counts when the locator also knows
    /// a label or identifier (that control is gone, and clicking its old spot would hit something else).
    public static func find(_ locator: AXLocator, in tree: MacTree, allowPoint: Bool = false) -> Hit? {
        let knowsName = !(locator.identifier ?? "").isEmpty || !(locator.label ?? "").isEmpty
        for attempt in candidates(locator) {
            let fits: [Int]
            switch attempt {
            case .identifier(let id):
                fits = tree.nodes.indices.filter { tree.nodes[$0].identifier == id && sameRole(tree.nodes[$0], locator) }
            case .roleLabel(let role, let label, let sameWindow):
                fits = tree.nodes.indices.filter { index in
                    let node = tree.nodes[index]
                    guard sameRole(node, AXLocator(role: role, subrole: locator.subrole)), sameLabel(node.label, label) else { return false }
                    return !sameWindow || windowFits(tree, node, locator)
                }
            case .point(let x, let y):
                guard allowPoint || !knowsName else { continue }
                fits = nodeAt(x: x, y: y, role: locator.role, in: tree, locator: locator).map { [$0] } ?? []
            }
            guard !fits.isEmpty else { continue }
            let ranked = rank(fits, for: locator, in: tree)
            return Hit(node: ranked[0], how: attempt, ambiguous: ranked.count > 1)
        }
        return nil
    }

    /// Several fits, best first: in the recorded window, in a sheet when it was, the same containers,
    /// nearest the recorded spot, the same position among its siblings, and enabled.
    public static func rank(_ nodes: [Int], for locator: AXLocator, in tree: MacTree) -> [Int] {
        func score(_ index: Int) -> Double {
            let node = tree.nodes[index]
            var s = 0.0
            if windowFits(tree, node, locator) { s += 100 }
            if let window = tree.front, node.window == window { s += 20 }
            if let sheet = locator.inSheet, sheet == tree.inDialog(index) { s += 40 }
            if let path = locator.path { s += Double(pathAgreement(path, pathOf(index, in: tree))) * 10 }
            if let want = locator.index, want == node.sibling { s += 8 }
            if node.enabled { s += 5 }
            if let x = locator.relX, let y = locator.relY, let frame = node.frame, let origin = tree.nodes[node.window].frame?.origin {
                let dx = frame.midX - origin.x - x, dy = frame.midY - origin.y - y
                s -= min(60, (dx * dx + dy * dy).squareRoot() / 20)
            }
            return s
        }
        return nodes.map { ($0, score($0)) }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }.map(\.0)
    }

    static func sameRole(_ node: MacNode, _ locator: AXLocator) -> Bool {
        guard node.role == locator.role else { return false }
        // A secure field stays secure: a plain field with the same label is a different control.
        if let sub = locator.subrole, sub == "AXSecureTextField" || node.isSecure { return node.subrole == sub }
        return true
    }

    /// Labels compare loosely: case, accents, spacing and a trailing colon or ellipsis don't matter.
    public static func sameLabel(_ a: String, _ b: String) -> Bool {
        fold(a) == fold(b) && !fold(a).isEmpty
    }

    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: ": ").union(.whitespacesAndNewlines))
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }

    static func windowFits(_ tree: MacTree, _ node: MacNode, _ locator: AXLocator) -> Bool {
        guard let want = locator.window, !want.isEmpty else { return true }
        return fold(tree.title(of: node.window)).contains(fold(want))
    }

    /// "Role[n]" for each container from the window down to `index`'s parent; the window has no number.
    public static func pathOf(_ index: Int, in tree: MacTree) -> [String] {
        let chain = tree.chain(to: index).dropLast()
        return chain.map { i in
            let node = tree.nodes[i]
            return node.parent == nil ? node.role : "\(node.role)[\(node.sibling)]"
        }
    }

    /// How many segments agree, from the window down; stops at the first difference.
    static func pathAgreement(_ a: [String], _ b: [String]) -> Int {
        var n = 0
        for (x, y) in zip(a, b) { if x == y { n += 1 } else { break } }
        return n
    }

    /// The deepest node of `role` whose frame holds the window-relative point.
    static func nodeAt(x: Double, y: Double, role: String, in tree: MacTree, locator: AXLocator) -> Int? {
        let windows = tree.windows.filter { windowFits(tree, tree.nodes[$0], locator) }
        for window in windows.isEmpty ? tree.windows : windows {
            guard let origin = tree.nodes[window].frame?.origin else { continue }
            let point = CGPoint(x: origin.x + x, y: origin.y + y)
            let hits = tree.subtree(window).filter { tree.nodes[$0].role == role && (tree.nodes[$0].frame?.contains(point) ?? false) }
            if let deepest = hits.max(by: { tree.chain(to: $0).count < tree.chain(to: $1).count }) { return deepest }
        }
        return nil
    }

    /// A locator for `index`, made when a step is recorded (or acted on by the model).
    public static func make(_ index: Int, in tree: MacTree) -> AXLocator {
        let node = tree.nodes[index]
        let window = tree.nodes[node.window]
        var rel: CGPoint?
        if let frame = node.frame, let origin = window.frame?.origin { rel = CGPoint(x: frame.midX - origin.x, y: frame.midY - origin.y) }
        return AXLocator(bundleID: tree.bundleID.isEmpty ? nil : tree.bundleID, app: tree.app.isEmpty ? nil : tree.app,
                         window: window.label.isEmpty ? nil : window.label, inSheet: tree.inDialog(index) ? true : nil,
                         role: node.role, subrole: node.subrole.isEmpty ? nil : node.subrole,
                         identifier: node.identifier.isEmpty ? nil : node.identifier, label: node.label.isEmpty ? nil : node.label,
                         path: pathOf(index, in: tree), index: node.sibling,
                         relX: rel.map { Double($0.x.rounded()) }, relY: rel.map { Double($0.y.rounded()) })
    }

    /// The locator an older step implies: its label and role in its window. Nil when it knows neither.
    public static func implied(by step: SkillStep) -> AXLocator? {
        if let locator = step.axLocator { return locator }
        let label = (step.label ?? "").trimmingCharacters(in: .whitespaces)
        guard let role = step.role, !role.isEmpty, !label.isEmpty else { return nil }
        var rel: (Double, Double)?
        if let x = step.x, let y = step.y, let winX = step.winX, let winY = step.winY { rel = (x - winX, y - winY) }
        return AXLocator(app: step.app.isEmpty ? nil : step.app, window: step.winTitle, role: role, label: label,
                         relX: rel?.0, relY: rel?.1)
    }
}

// MARK: - The screen, as a replay reads it

/// A sheet or dialog in front of an app's window: what it says and which buttons it offers.
public struct MacDialog: Equatable, Sendable {
    public var node: Int
    public var title: String
    public var text: String
    public var buttons: [String]
    /// A sheet or a modal dialog blocks the window behind it.
    public var modal: Bool
    public init(node: Int, title: String, text: String, buttons: [String], modal: Bool) {
        self.node = node; self.title = title; self.text = text; self.buttons = buttons; self.modal = modal
    }
}

/// What a replay knows about an app's screen at one moment.
public struct MacObservation: Equatable, Sendable {
    public var app: String
    public var bundleID: String
    public var window: String
    /// Sheets and dialogs in front, by their title or first line.
    public var sheets: [String]
    /// The front window's static text and field values, a bounded amount.
    public var text: String
    public var focusedRole: String
    public var busy: Bool
    public var dialogs: [MacDialog]

    public init(app: String = "", bundleID: String = "", window: String = "", sheets: [String] = [], text: String = "",
                focusedRole: String = "", busy: Bool = false, dialogs: [MacDialog] = []) {
        self.app = app; self.bundleID = bundleID; self.window = window; self.sheets = sheets; self.text = text
        self.focusedRole = focusedRole; self.busy = busy; self.dialogs = dialogs
    }

    /// The shared shape `HybridReplay` checks anchors and expectations against. A sheet's first line
    /// counts as part of the window's title, so "the review sheet is up" can be an anchor.
    public var hybrid: HybridReplay.Observation {
        HybridReplay.Observation(url: "", title: ([window] + sheets).joined(separator: " · "), text: text, app: app, window: window)
    }
}

public enum MacScreen {
    /// How much of the window's text an observation keeps: enough for landmarks and checks.
    public static let textLimit = 2000

    /// One read of the app's front window.
    public static func observe(_ tree: MacTree) -> MacObservation {
        guard let front = tree.front ?? tree.windows.first else { return MacObservation(app: tree.app, bundleID: tree.bundleID) }
        let dialogs = self.dialogs(tree)
        return MacObservation(app: tree.app, bundleID: tree.bundleID, window: tree.title(of: front),
                              sheets: dialogs.map { $0.title.isEmpty ? String($0.text.prefix(80)) : $0.title },
                              text: String(windowText(tree, window: front).prefix(textLimit)),
                              focusedRole: tree.nodes.first(where: \.focused)?.role ?? "",
                              busy: isBusy(tree), dialogs: dialogs)
    }

    static let textRoles: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXHeading", "AXCell"]

    /// Everything the window says: static text, what fields hold (never a secure field), sheets included.
    public static func windowText(_ tree: MacTree, window: Int) -> String {
        tree.subtree(window).compactMap { index -> String? in
            let node = tree.nodes[index]
            guard textRoles.contains(node.role), !node.isSecure else { return nil }
            let text = node.value.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }.joined(separator: "\n")
    }

    /// What the fields hold, for the "does the review show their details" check.
    public static func fieldValues(_ tree: MacTree, window: Int) -> String {
        tree.subtree(window).compactMap { index -> String? in
            let node = tree.nodes[index]
            guard ["AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton"].contains(node.role), !node.isSecure, !node.value.isEmpty else { return nil }
            return node.value
        }.joined(separator: "\n")
    }

    /// Sheets on any window, and dialog windows: their title, words and buttons.
    public static func dialogs(_ tree: MacTree) -> [MacDialog] {
        tree.nodes.indices.filter { tree.nodes[$0].isSheet || tree.nodes[$0].isDialogWindow }.map { index in
            let inside = tree.subtree(index).dropFirst()
            let words = inside.compactMap { i -> String? in
                let node = tree.nodes[i]
                return node.role == "AXStaticText" && !node.value.isEmpty ? node.value : nil
            }
            let buttons = inside.compactMap { i -> String? in
                let node = tree.nodes[i]
                return node.role == "AXButton" && !node.label.isEmpty ? node.label : nil
            }
            let node = tree.nodes[index]
            let title = node.label.isEmpty ? (words.first ?? "") : node.label
            return MacDialog(node: index, title: title, text: words.joined(separator: "\n"), buttons: buttons, modal: node.isSheet || node.subrole != "AXFloatingWindow")
        }
    }

    /// A spinner or progress bar in the front window: the app is still working.
    public static func isBusy(_ tree: MacTree) -> Bool {
        guard let front = tree.front ?? tree.windows.first else { return false }
        return tree.subtree(front).contains { index in
            let node = tree.nodes[index]
            return node.role == "AXBusyIndicator" || (node.role == "AXProgressIndicator" && (node.frame.map { $0.width > 0 && $0.height > 0 } ?? false))
        }
    }

    /// Whether `label` shows anywhere in the front window: a control called that, or text that says it.
    public static func present(_ label: String, in tree: MacTree) -> Bool {
        guard let front = tree.front ?? tree.windows.first else { return false }
        let want = MacLocator.fold(label)
        guard !want.isEmpty else { return false }
        return tree.subtree(front).contains { index in
            let node = tree.nodes[index]
            return MacLocator.fold(node.label).contains(want) || (node.role == "AXStaticText" && MacLocator.fold(node.value).contains(want))
        }
    }

    /// The numbered controls the model is shown on a Mac step: things it can press or fill, with their
    /// label, role and value (secure fields without one), the way the browser lists a page's elements.
    public static func controls(_ tree: MacTree, limit: Int = 120) -> [(id: Int, node: Int, line: String)] {
        let actionable: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
                                       "AXComboBox", "AXMenuItem", "AXMenuButton", "AXLink", "AXCell", "AXRow", "AXSlider", "AXTab", "AXDisclosureTriangle"]
        var out: [(Int, Int, String)] = []
        let scope = tree.front.map { tree.subtree($0) } ?? Array(tree.nodes.indices)
        for index in scope where actionable.contains(tree.nodes[index].role) {
            let node = tree.nodes[index]
            var line = "\(node.role.replacingOccurrences(of: "AX", with: "")) “\(node.label.prefix(60))”"
            if !node.value.isEmpty, !node.isSecure, node.role != "AXButton" { line += " = “\(node.value.prefix(40))”" }
            if node.isSecure { line += " (password field)" }
            if tree.inDialog(index) { line += " (in a dialog)" }
            if !node.enabled { line += " (disabled)" }
            out.append((out.count + 1, index, line))
            if out.count >= limit { break }
        }
        return out
    }
}
