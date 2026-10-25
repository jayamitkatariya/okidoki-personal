import AppKit
import OkidokiCore

/// One action's outcome, as the model will read it.
struct ActionOutcome {
    var text: String
    var isError: Bool
    var change: ScreenChange?
    var performMs: Int
    var settleMs: Int
    /// A zoom crop, PNG.
    var image: Data?
}

/// Runs v2 actions on a target. After each one it waits for the screen to settle and checks that the
/// action did something, so a miss is reported as a miss instead of the model finding out a turn later.
@MainActor
final class DriveExecutor {
    private let target: ComputerTarget
    private(set) var shot: ComputerUseService.Screenshot?
    private(set) var context = ComputerContext()
    private var box = ScreenBox(x: 0, y: 0, width: 1, height: 1)
    private var imageWidth = 1.0
    private var imageHeight = 1.0
    /// The last action's screen settled before its time limit, so a following wait has nothing to wait for.
    private var lastStable = false

    init(target: ComputerTarget) { self.target = target }

    func observe(shot: ComputerUseService.Screenshot?, context: ComputerContext, fallback: ScreenBox) {
        lastStable = false
        self.shot = shot
        self.context = context
        box = shot?.box ?? fallback
        imageWidth = shot?.imageWidth ?? fallback.width
        imageHeight = shot?.imageHeight ?? fallback.height
    }

    // MARK: Coordinates

    func imagePoint(_ quartz: CGPoint) -> CGPoint {
        ComputerUseService.mapPoint(quartz, box: box, imageWidth: imageWidth, imageHeight: imageHeight)
    }

    func quartzPoint(x: Double?, y: Double?) -> CGPoint? {
        guard let x, let y else { return nil }
        return ComputerUseService.mapImage(x: x, y: y, box: box, imageWidth: imageWidth, imageHeight: imageHeight)
    }

    /// Where the HUD should show the aim, 0–1 in the screenshot.
    func aim(of act: ComputerAction) -> CGPoint? {
        if act.type == "click_element", let id = act.element, let entry = context.elements[id] {
            let p = imagePoint(CGPoint(x: entry.control.rect.midX, y: entry.control.rect.midY))
            return CGPoint(x: min(max(p.x / imageWidth, 0), 1), y: min(max(p.y / imageHeight, 0), 1))
        }
        return ComputerUseDriver.aim(of: act, imageWidth: imageWidth, imageHeight: imageHeight)
    }

    static let pixelClicks: Set<String> = ["click", "double_click", "triple_click", "right_click", "middle_click"]
    static let clickish: Set<String> = pixelClicks.union(["click_element"])

    /// Actions aimed at a pixel of the last screenshot, which a big screen change makes stale.
    static func aimsAtPixel(_ act: ComputerAction) -> Bool {
        switch act.type {
        case "click", "double_click", "triple_click", "right_click", "middle_click", "move":
            return act.x != nil && act.y != nil
        case "drag": return true
        case "scroll": return act.x != nil
        default: return false
        }
    }

    // MARK: Narration

    /// 2–6 words for the pill, made here instead of by the model.
    func narrate(_ act: ComputerAction) async -> String {
        func clip(_ text: String, _ limit: Int) -> String {
            let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
            return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
        }
        switch act.type {
        case "click_element":
            if let id = act.element, let label = context.elements[id]?.control.label, !label.isEmpty { return "clicking “\(clip(label, 28))”" }
            return "clicking"
        case "click", "double_click", "triple_click", "right_click", "middle_click":
            let verb = ["double_click": "double-clicking", "triple_click": "triple-clicking", "right_click": "right-clicking",
                        "middle_click": "middle-clicking"][act.type] ?? "clicking"
            if let point = quartzPoint(x: act.x, y: act.y),
               let hit = await Task.detached(priority: .userInitiated, operation: { AXSearch.describe(at: point) }).value,
               !hit.label.isEmpty {
                return "\(verb) “\(clip(hit.label, 28))”"
            }
            return verb
        case "type": return "typing “\(clip(act.text ?? "", 24))”"
        case "key": return "pressing \(ComputerUseDriver.prettyKey(act.key ?? ""))"
        case "scroll": return (act.dy ?? 0) < 0 ? "scrolling up" : (act.dx ?? 0) != 0 && (act.dy ?? 0) == 0 ? "scrolling sideways" : "scrolling down"
        case "open_app", "activate": return "opening \(act.app ?? act.text ?? "the app")"
        case "open_url": return "opening the link"
        case "script", "shell", "applescript", "jxa": return "running a script"
        case "zoom": return "looking closer"
        case "wait": return "waiting"
        case "drag": return "dragging"
        case "move": return "moving the pointer"
        case "mouse_down": return "pressing the mouse"
        case "mouse_up": return "letting go"
        case "hold_key": return "holding \(ComputerUseDriver.prettyKey(act.key ?? ""))"
        case "screenshot": return "looking"
        case "cursor_position": return "finding the pointer"
        default: return act.type
        }
    }

    // MARK: Running

    struct Profile {
        var minMs: Int
        var maxMs: Int
        var stable: Int
        var load: Bool
    }

    static func profile(for act: ComputerAction, browser: Bool) -> Profile? {
        switch act.type {
        case "click", "click_element", "right_click", "middle_click": return Profile(minMs: 80, maxMs: 900, stable: 1, load: false)
        case "double_click", "triple_click": return Profile(minMs: 120, maxMs: 900, stable: 1, load: false)
        case "type": return Profile(minMs: 40, maxMs: 800, stable: 1, load: false)
        case "key":
            let submit = ["return", "enter", "keypadenter"].contains((act.key ?? "").lowercased())
            return Profile(minMs: submit ? 120 : 60, maxMs: submit ? 4000 : 1200, stable: submit ? 2 : 1, load: submit && browser)
        case "scroll": return Profile(minMs: 120, maxMs: 1000, stable: 1, load: false)
        case "drag", "move", "mouse_down", "mouse_up", "hold_key": return Profile(minMs: 60, maxMs: 800, stable: 1, load: false)
        case "open_url": return Profile(minMs: 250, maxMs: 6000, stable: 2, load: true)
        case "open_app", "activate": return Profile(minMs: 150, maxMs: 2500, stable: 2, load: false)
        case "script", "shell", "applescript", "jxa": return Profile(minMs: 100, maxMs: 2000, stable: 1, load: false)
        default: return nil
        }
    }

    /// The fixed pause for targets that can't be sampled (the private Mac).
    static func fixedPause(_ act: ComputerAction) -> Double {
        switch act.type {
        case "open_app", "activate": return 1.1
        case "open_url": return 1.5
        case "script", "shell", "applescript", "jxa": return 0.7
        case "click", "click_element", "double_click", "triple_click", "right_click", "middle_click", "drag": return 0.45
        case "type": return 0.3
        case "key": return 0.35
        case "scroll": return 0.4
        default: return 0.2
        }
    }

    func run(_ original: ComputerAction) async -> ActionOutcome {
        let clock = Stopwatch()
        var act = original
        if target.isRemote {
            // These would act on this Mac's own pointer and keyboard, not the private Mac's.
            let local: Set<String> = ["mouse_down", "mouse_up", "hold_key", "cursor_position", "click_element"]
            if local.contains(act.type) || (Self.pixelClicks.contains(act.type) && (act.x == nil || act.y == nil)) {
                return ActionOutcome(text: "\(act.tool ?? act.type) isn't available on the private Mac — use clicks with coordinates, left_click_drag, type and key",
                                     isError: true, change: nil, performMs: 0, settleMs: 0)
            }
        }
        // A click with no coordinate lands where the pointer is.
        if Self.pixelClicks.contains(act.type), act.x == nil || act.y == nil, (act.target ?? "").isEmpty {
            let p = imagePoint(EventActuator.currentPoint())
            act.x = p.x
            act.y = p.y
        }
        switch act.type {
        case "screenshot":
            return ok("here is the screen now (attached below)", clock.ms)
        case "cursor_position":
            let p = imagePoint(EventActuator.currentPoint())
            return ok(String(format: "the pointer is at %.0f, %.0f", p.x, p.y), clock.ms)
        case "zoom":
            return await zoom(act, clock: clock)
        case "wait":
            let seconds = min(max(act.seconds ?? 1, 0.2), 10)
            if lastStable {
                lastStable = false
                return ok("the screen had already stopped changing, so no wait was needed", clock.ms)
            }
            if target.settles, let screen = target.screen() {
                // Waiting is for things to finish moving: stop as soon as the screen is still.
                let still = await ScreenSampler.settle(screen: screen, before: nil, minMs: 150, maxMs: Int(seconds * 1000), stableSamples: 2)
                return ok(String(format: "waited %.1fs until the screen was still", Double(still.elapsedMs) / 1000), clock.ms)
            }
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return ok(String(format: "waited %.1fs", seconds), clock.ms)
        case "unknown":
            return ActionOutcome(text: "okidoki can't do “\(act.tool ?? act.type)” — use another action", isError: true,
                                 change: nil, performMs: 0, settleMs: 0)
        default:
            break
        }

        lastStable = false
        let screen = target.screen()
        let checks = target.settles && screen != nil
        let before = checks ? await ScreenSampler.sample(screen: screen!) : nil
        var text: String
        var pressedEntry: AXSearch.Entry?
        var hit: (role: String, label: String)?
        do {
            switch act.type {
            case "click_element":
                (text, pressedEntry) = await clickElement(act)
            case "mouse_down":
                await EventActuator.mouseButton(down: true)
                text = "pressed the left button"
            case "mouse_up":
                await EventActuator.mouseButton(down: false)
                text = "released the left button"
            case "hold_key":
                let key = act.key ?? ""
                text = await EventActuator.holdKey(key, seconds: act.seconds ?? 1) ? "held \(key)" : "unknown key \(key)"
            default:
                if Self.pixelClicks.contains(act.type), let point = quartzPoint(x: act.x, y: act.y) {
                    hit = await Task.detached(priority: .userInitiated) { AXSearch.describe(at: point) }.value
                }
                text = try await target.perform(act, screen: box, imageWidth: imageWidth, imageHeight: imageHeight)
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return ActionOutcome(text: message, isError: true, change: nil, performMs: clock.ms, settleMs: 0)
        }
        let performMs = clock.ms
        if ComputerUseDriver.looksFailed(text) {
            return ActionOutcome(text: text, isError: true, change: nil, performMs: performMs, settleMs: 0)
        }
        guard checks, let screen else {
            let pause = Self.fixedPause(act)
            try? await Task.sleep(nanoseconds: UInt64(pause * 1_000_000_000))
            return ActionOutcome(text: text, isError: false, change: nil, performMs: performMs, settleMs: Int(pause * 1000))
        }
        let front = ComputerUseService.shared.frontmost()
        let browser = WebPage.isBrowser(bundleID: front?.bundleID ?? "")
        guard let profile = Self.profile(for: act, browser: browser) else {
            return ActionOutcome(text: text, isError: false, change: nil, performMs: performMs, settleMs: 0)
        }
        var area: AXUIElement?
        if profile.load, browser, let pid = front?.pid {
            area = await Task.detached(priority: .userInitiated) { WebPage.webArea(pid: pid).map(UncheckedElement.init) }.value?.element
        }
        var settle = await ScreenSampler.settle(screen: screen, before: before, minMs: profile.minMs, maxMs: profile.maxMs,
                                                stableSamples: profile.stable, webArea: area)
        var settleMs = settle.elapsedMs
        // A click that navigated a browser page: give the page time to load.
        if Self.clickish.contains(act.type), settle.large, browser, let pid = front?.pid {
            let page = await Task.detached(priority: .userInitiated) { WebPage.webArea(pid: pid).map(UncheckedElement.init) }.value?.element
            if page != nil {
                let more = await ScreenSampler.settle(screen: screen, before: before, minMs: 0, maxMs: 4000, stableSamples: 2, webArea: page)
                settleMs += more.elapsedMs
                if let change = more.change { settle.change = change }
            }
        }

        lastStable = settle.stable
        var isError = false
        switch act.type {
        case _ where Self.clickish.contains(act.type):
            if settle.changed { break }
            let pid = ComputerUseService.shared.frontmost()?.pid ?? 0
            let focused = await Task.detached(priority: .userInitiated) { AXSearch.focusedInput(pid: pid) }.value
            let targetRole = hit?.role ?? ""
            if AXSearch.textInputRoles.contains(focused?.role ?? ""),
               targetRole.isEmpty || AXSearch.textInputRoles.contains(targetRole) || pressedEntry?.control.role == "field" {
                text += " — the field has keyboard focus"
            } else if let entry = pressedEntry {
                // The accessibility press reported success but nothing happened (common in Electron apps): click for real.
                let center = CGPoint(x: entry.control.rect.midX, y: entry.control.rect.midY)
                let rect = await Task.detached(priority: .userInitiated) { AXSearch.currentFrame(of: entry.element) }.value
                let point = rect.map { CGPoint(x: $0.midX, y: $0.midY) } ?? center
                let again = await ScreenSampler.sample(screen: screen)
                await EventActuator.click(at: point)
                let retry = await ScreenSampler.settle(screen: screen, before: again ?? before, minMs: 80, maxMs: 1200)
                settleMs += retry.elapsedMs
                settle.change = retry.change ?? settle.change
                if retry.changed {
                    text = "clicked “\(entry.control.label)” (the accessibility press did nothing, a real click worked)"
                } else {
                    isError = true
                    text = "pressed “\(entry.control.label)” but nothing visibly changed — it may be disabled, already selected, or need another way in"
                }
            } else {
                isError = true
                let what = hit.map { $0.label.isEmpty ? " on a \($0.role.replacingOccurrences(of: "AX", with: "").lowercased())" : " on “\($0.label.prefix(40))”" } ?? ""
                text += "\(what) — but nothing visibly changed, so it probably missed: the target may be elsewhere, disabled or already selected"
            }
        case "type":
            let typed = act.text ?? ""
            let pid = ComputerUseService.shared.frontmost()?.pid ?? 0
            let focused = await Task.detached(priority: .userInitiated) { AXSearch.focusedInput(pid: pid) }.value
            if let focused, AXSearch.textInputRoles.contains(focused.role), let value = focused.value, !value.isEmpty {
                if Self.flat(value).contains(Self.flat(String(typed.suffix(40)))) {
                    text += "; the field now ends with “\(Self.flat(String(value.suffix(48))))”"
                } else {
                    isError = true
                    text = "typed \(typed.count) characters, but the focused field shows “\(Self.flat(String(value.suffix(60))))” — the text may have gone somewhere else"
                }
            } else if !settle.changed {
                isError = true
                text += " — but nothing changed on screen; is a text field focused? click it first"
            }
        case "key":
            if !settle.changed { text += " (no visible change)" }
        case "scroll":
            if !settle.changed { text += " — nothing moved (already at the end, or the pointer isn't over the part that scrolls)" }
        case "drag":
            if !settle.changed { text += " (no visible change)" }
        default:
            break
        }
        return ActionOutcome(text: text, isError: isError, change: settle.change, performMs: performMs, settleMs: settleMs)
    }

    private func ok(_ text: String, _ ms: Int) -> ActionOutcome {
        ActionOutcome(text: text, isError: false, change: nil, performMs: ms, settleMs: 0)
    }

    static func flat(_ text: String) -> String {
        text.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private func zoom(_ act: ComputerAction, clock: Stopwatch) async -> ActionOutcome {
        guard let shot, let x = act.x, let y = act.y else {
            return ActionOutcome(text: "zoom needs a region inside the screenshot", isError: true, change: nil, performMs: 0, settleMs: 0)
        }
        let width = act.width, height = act.height
        let crop = await Task.detached(priority: .userInitiated) {
            ComputerUseService.zoom(shot, x: x, y: y, width: width, height: height)
        }.value
        guard let crop else {
            return ActionOutcome(text: "couldn't zoom there", isError: true, change: nil, performMs: clock.ms, settleMs: 0)
        }
        let text = String(format: "zoomed into x %.0f–%.0f, y %.0f–%.0f of the screenshot (attached); keep answering in full-screenshot coordinates",
                          crop.rect.minX, crop.rect.maxX, crop.rect.minY, crop.rect.maxY)
        return ActionOutcome(text: text, isError: false, change: nil, performMs: clock.ms, settleMs: 0, image: crop.png)
    }

    /// Clicks a numbered control: an exact accessibility press when it is a plain click and the control
    /// takes one, else a real click at its current center. Returns the entry when it was pressed through
    /// accessibility, so a press that changed nothing can be retried as a real click.
    private func clickElement(_ act: ComputerAction) async -> (String, AXSearch.Entry?) {
        guard let id = act.element, let entry = context.elements[id] else {
            return ("couldn't click #\(act.element ?? 0): no control has that number in the latest list — use a number from the newest list, or left_click its pixel", nil)
        }
        let label = entry.control.label
        let element = UncheckedElement(element: entry.element)
        guard let rect = await Task.detached(priority: .userInitiated, operation: { AXSearch.currentFrame(of: element.element) }).value,
              rect.width > 0, rect.height > 0 else {
            return ("couldn't click “\(label)”: it isn't on screen anymore — look at the new screenshot", nil)
        }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let button = act.button ?? "left"
        let count = max(1, min(act.times ?? 1, 3))
        guard let held = EventActuator.modifierKeys(act.modifiers) else { return ("unknown modifiers \(act.modifiers ?? "")", nil) }
        if button == "left", count == 1, held.isEmpty {
            // Show the pointer going there while the press happens; the press doesn't wait for it.
            Task { await EventActuator.move(to: center) }
            if await Task.detached(priority: .userInitiated, operation: { AXSearch.perform(kAXPressAction, on: element.element) }).value {
                return ("pressed “\(label)”", entry)
            }
        }
        if button == "right", held.isEmpty,
           await Task.detached(priority: .userInitiated, operation: { AXSearch.perform(kAXShowMenuAction, on: element.element) }).value {
            return ("opened the menu of “\(label)”", nil)
        }
        let mouse: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
        await EventActuator.click(at: center, button: mouse, count: count, held: held)
        let verb = count == 2 ? "double-clicked" : count == 3 ? "triple-clicked" : button == "right" ? "right-clicked" : "clicked"
        return ("\(verb) “\(label)”", nil)
    }
}

/// Carries an accessibility element across a detached task. AX calls are thread-safe.
struct UncheckedElement: @unchecked Sendable {
    let element: AXUIElement
}
