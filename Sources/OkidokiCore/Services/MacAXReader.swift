import AppKit
import ApplicationServices
import Foundation

/// Reads an app's accessibility tree into a `MacTree` (with the live elements beside it), and the
/// chain above one element into an `AXLocator`. Blocking I/O: callers run it off the main thread.
/// Every element gets a short messaging timeout, so an app that hangs can't freeze okidoki.
public enum MacAXReader {
    /// Seconds an app gets to answer one accessibility question.
    public static let timeout: Float = 0.5

    /// A tree and the elements behind its nodes, in the same order.
    public struct Snapshot: @unchecked Sendable {
        public var tree: MacTree
        public var elements: [AXUIElement]
        public var pid: pid_t
    }

    /// The app's windows and what's in them, depth first. Bounded by depth, count and time: a huge
    /// window (a spreadsheet's cells) stops growing the tree rather than stalling the replay.
    public static func snapshot(pid: pid_t, maxDepth: Int = 14, maxNodes: Int = 900, budget: TimeInterval = 1.5) -> Snapshot {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, timeout)
        let running = NSRunningApplication(processIdentifier: pid)
        var tree = MacTree(app: SkillReplayGeometry.cleanAppName(running?.localizedName ?? ""), bundleID: running?.bundleIdentifier ?? "")
        var elements: [AXUIElement] = []
        let deadline = Date().addingTimeInterval(budget)
        let windows = elementList(kAXWindowsAttribute, of: app)
        let focused = element(kAXFocusedWindowAttribute, of: app) ?? element(kAXMainWindowAttribute, of: app)

        func visit(_ element: AXUIElement, parent: Int?, sibling: Int, window: Int?, depth: Int) {
            guard tree.nodes.count < maxNodes, Date() < deadline else { return }
            AXUIElementSetMessagingTimeout(element, timeout)
            let index = tree.nodes.count
            var node = read(element)
            node.parent = parent
            node.sibling = sibling
            node.window = window ?? index
            tree.nodes.append(node)
            elements.append(element)
            guard depth < maxDepth else { return }
            var counts: [String: Int] = [:]
            for child in elementList(kAXChildrenAttribute, of: element) {
                let role = AXSearch.stringAttribute(kAXRoleAttribute, of: child)
                counts[role, default: 0] += 1
                visit(child, parent: index, sibling: counts[role]!, window: window ?? index, depth: depth + 1)
            }
        }
        for window in windows {
            let at = tree.nodes.count
            visit(window, parent: nil, sibling: 1, window: nil, depth: 0)
            if let focused, CFEqual(focused, window) { tree.front = at }
        }
        if tree.front == nil { tree.front = tree.windows.first }
        return Snapshot(tree: tree, elements: elements, pid: pid)
    }

    /// One element as a node (no parent yet). A secure field's value is never read.
    public static func read(_ element: AXUIElement) -> MacNode {
        let keys = [kAXRoleAttribute, kAXSubroleAttribute, "AXIdentifier", kAXTitleAttribute, kAXDescriptionAttribute,
                    kAXPlaceholderValueAttribute]
        let s = AXSearch.strings(keys, of: element)
        let role = s[0], subrole = s[1]
        var label = [s[3], s[4], s[5]].first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
        if label.isEmpty, role != "AXStaticText", let titled = self.element(kAXTitleUIElementAttribute, of: element) {
            label = AXSearch.stringAttribute(kAXValueAttribute, of: titled)
        }
        let secure = subrole == "AXSecureTextField"
        let value = secure ? "" : String(AXSearch.stringAttribute(kAXValueAttribute, of: element).prefix(400))
        var enabled = true
        var focused = false
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &raw) == .success, let flag = raw as? Bool { enabled = flag }
        if AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &raw) == .success, let flag = raw as? Bool { focused = flag }
        return MacNode(role: role, subrole: subrole, identifier: s[2], label: String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)),
                       value: value, frame: AXSearch.frame(of: element), enabled: enabled, focused: focused)
    }

    /// A locator for `element`, from its own attributes and the chain of containers above it up to its
    /// window: what recording keeps for each step, and what a model's click is promoted to.
    public static func locator(for element: AXUIElement) -> AXLocator? {
        var chain: [AXUIElement] = [element]
        var at = element
        while chain.count < 20, let up = self.element(kAXParentAttribute, of: at) {
            let role = AXSearch.stringAttribute(kAXRoleAttribute, of: up)
            if role == "AXApplication" { break }
            chain.insert(up, at: 0)
            at = up
        }
        guard let top = chain.first, AXSearch.stringAttribute(kAXRoleAttribute, of: top) == "AXWindow" else { return nil }
        var tree = MacTree()
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        let running = pid > 0 ? NSRunningApplication(processIdentifier: pid) : nil
        tree.app = SkillReplayGeometry.cleanAppName(running?.localizedName ?? "")
        tree.bundleID = running?.bundleIdentifier ?? ""
        for (n, item) in chain.enumerated() {
            AXUIElementSetMessagingTimeout(item, timeout)
            var node = read(item)
            node.parent = n == 0 ? nil : n - 1
            node.window = 0
            if n > 0 {
                // Which of its parent's children of this role it is.
                let role = node.role
                let siblings = elementList(kAXChildrenAttribute, of: chain[n - 1]).filter { AXSearch.stringAttribute(kAXRoleAttribute, of: $0) == role }
                node.sibling = (siblings.firstIndex { CFEqual($0, item) } ?? 0) + 1
            }
            tree.nodes.append(node)
        }
        tree.front = 0
        return MacLocator.make(chain.count - 1, in: tree)
    }

    /// Elements of `role` under `element` (a menu's items once it's open), a few levels down.
    public static func snapshotChildren(of element: AXUIElement, role: String, depth: Int = 3) -> [AXUIElement] {
        var out: [AXUIElement] = []
        func walk(_ e: AXUIElement, _ d: Int) {
            for child in elementList(kAXChildrenAttribute, of: e) {
                AXUIElementSetMessagingTimeout(child, timeout)
                if AXSearch.stringAttribute(kAXRoleAttribute, of: child) == role { out.append(child) }
                if d < depth { walk(child, d + 1) }
            }
        }
        walk(element, 1)
        return out
    }

    /// An attribute that holds another element (a window's default button).
    public static func attributeElement(_ key: String, of element: AXUIElement) -> AXUIElement? {
        self.element(key, of: element)
    }

    static func element(_ key: String, of element: AXUIElement) -> AXUIElement? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &raw) == .success, let raw else { return nil }
        return AXSearch.axElement(raw)
    }

    static func elementList(_ key: String, of element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &raw) == .success, let list = raw as? [AnyObject] else { return [] }
        return list.compactMap { AXSearch.axElement($0) }
    }
}
