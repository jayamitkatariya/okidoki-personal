import AppKit
import ApplicationServices
import Foundation

public struct AXSeenControl: Equatable, Sendable {
    public var label: String
    public var role: String
    /// Quartz global points, origin top-left of the main display.
    public var rect: CGRect
}

/// The labeled controls an app exposes through accessibility, so the tutor can name and
/// snap to real things instead of guessing from pixels.
public enum AXInventory {
    private static let roles: [String: String] = [
        "AXButton": "button", "AXMenuButton": "menu button", "AXPopUpButton": "popup", "AXMenuItem": "menu item",
        "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXTab": "tab", "AXTextField": "field",
        "AXTextArea": "text area", "AXSearchField": "search field", "AXComboBox": "combo box", "AXSlider": "slider",
        "AXLink": "link", "AXDisclosureTriangle": "disclosure", "AXToolbar": "toolbar", "AXSegmentedControl": "segmented",
        "AXColorWell": "color well", "AXIncrementor": "stepper", "AXImage": "image", "AXCell": "cell", "AXRow": "row",
    ]

    /// Controls inside `within` (Quartz global), nearest-first is not needed; reading order is fine.
    public static func controls(pid: pid_t, within bounds: CGRect, limit: Int = 90) -> [AXSeenControl] {
        guard AXIsProcessTrusted() else { return [] }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0) // a hung app must not stall the overlay for the 6 s default
        var queue: [AXUIElement] = []
        for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            var raw: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, attribute as CFString, &raw) == .success,
               let raw, let element = AXSearch.axElement(raw) {
                queue.append(element)
            }
        }
        if queue.isEmpty { queue = [app] }
        var found: [AXSeenControl] = []
        var seen = Set<String>()
        var visited = 0
        while !queue.isEmpty, visited < 2600, found.count < limit {
            let element = queue.removeFirst()
            visited += 1
            let role = AXSearch.stringAttribute(kAXRoleAttribute, of: element)
            if let plain = roles[role], let rect = AXSearch.frame(of: element), bounds.intersects(rect),
               rect.width < bounds.width * 0.8, rect.height < bounds.height * 0.8 {
                let title = AXSearch.stringAttribute(kAXTitleAttribute, of: element)
                let description = AXSearch.stringAttribute(kAXDescriptionAttribute, of: element)
                let help = AXSearch.stringAttribute(kAXHelpAttribute, of: element)
                let value = AXSearch.stringAttribute(kAXValueAttribute, of: element)
                let label = [title, description, help, value.count <= 40 ? value : ""]
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .first { !$0.isEmpty && $0.count <= 48 } ?? ""
                let skipRole = role == "AXImage" || role == "AXCell" || role == "AXRow"
                if !label.isEmpty, !(skipRole && label.count > 30) {
                    let key = "\(label)|\(Int(rect.midX / 4))|\(Int(rect.midY / 4))"
                    if !seen.contains(key) {
                        seen.insert(key)
                        found.append(AXSeenControl(label: label, role: plain, rect: rect))
                    }
                }
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(120))
            }
        }
        return found
    }

    /// The app's menu bar as the tutor should quote it: one line per menu, its items in order,
    /// submenus one level deep ("File: New, Open…, Export ▸ PNG · PDF"). Read once per lesson.
    public static func menus(pid: pid_t, limit: Int = 24) -> [String] {
        guard AXIsProcessTrusted() else { return [] }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        var barRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &barRef) == .success,
              let barRef, let bar = AXSearch.axElement(barRef) else { return [] }
        let started = Date()
        func title(_ element: AXUIElement) -> String {
            AXSearch.stringAttribute(kAXTitleAttribute, of: element).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        func items(of element: AXUIElement) -> [AXUIElement] {
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
                  let children = raw as? [AXUIElement] else { return [] }
            // A menu bar item or a menu item holds one AXMenu, which holds the items.
            if children.count == 1, AXSearch.stringAttribute(kAXRoleAttribute, of: children[0]) == "AXMenu" {
                return items(of: children[0])
            }
            return children
        }
        var lines: [String] = []
        for top in items(of: bar).dropFirst() where lines.count < limit && Date().timeIntervalSince(started) < 1.2 {
            let name = title(top)
            guard !name.isEmpty else { continue }
            var entries: [String] = []
            for item in items(of: top).prefix(40) {
                let label = title(item)
                // Hidden alternates (option-key variants) repeat a title; the Services menu is the system's, not the app's.
                guard !label.isEmpty, !entries.contains(where: { $0 == label || $0.hasPrefix("\(label) ▸") }) else { continue }
                let sub = label == "Services" ? [] : items(of: item).prefix(12).map(title).filter { !$0.isEmpty }
                entries.append(sub.isEmpty ? label : "\(label) ▸ \(sub.joined(separator: " · "))")
            }
            guard !entries.isEmpty else { continue }
            lines.append("\(name): \(entries.joined(separator: ", "))")
        }
        return lines
    }

    /// Press the control under a point through accessibility. Nothing moves on screen, so the
    /// learner keeps their pointer. False when the element has no press action.
    @discardableResult
    public static func press(at point: CGPoint) -> Bool {
        guard AXIsProcessTrusted() else { return false }
        let system = AXUIElementCreateSystemWide()
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &ref) == .success,
              var element = ref else { return false }
        for _ in 0..<4 {
            var namesRef: CFArray?
            if AXUIElementCopyActionNames(element, &namesRef) == .success,
               let names = namesRef as? [String], names.contains(kAXPressAction) {
                return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
            }
            var parentRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success,
                  let parentRef, let parent = AXSearch.axElement(parentRef) else { break }
            element = parent
        }
        return false
    }

    /// The element under a point, lifted to the control that owns it: an icon inside a button
    /// reports the button, a glyph inside a menu item reports the item.
    public static func control(at point: CGPoint) -> AXSeenControl? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &ref) == .success,
              var element = ref else { return nil }
        var best: AXSeenControl?
        for _ in 0..<4 {
            let role = AXSearch.stringAttribute(kAXRoleAttribute, of: element)
            if let rect = AXSearch.frame(of: element) {
                let title = AXSearch.stringAttribute(kAXTitleAttribute, of: element)
                let description = AXSearch.stringAttribute(kAXDescriptionAttribute, of: element)
                let value = AXSearch.stringAttribute(kAXValueAttribute, of: element)
                let label = [title, description, value].first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
                let control = AXSeenControl(label: String(label.prefix(80)), role: roles[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased(), rect: rect)
                if best == nil { best = control }
                let isControl = roles[role] != nil && role != "AXImage" && role != "AXCell" && role != "AXRow"
                if isControl, rect.width < 600, rect.height < 300 { return control }
            }
            var parentRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success,
                  let parentRef, let parent = AXSearch.axElement(parentRef) else { break }
            element = parent
        }
        return best
    }
}
