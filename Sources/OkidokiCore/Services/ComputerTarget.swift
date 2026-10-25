import AppKit
import Foundation

/// What the model gets to know about the screen it is driving, beyond the screenshot.
public struct ComputerContext {
    public var appName: String
    public var windowTitle: String
    /// Clickable controls as the brain expects them: role, label, center in screenshot pixels.
    public var controls: [[String: Any]]
    /// Abridged AppleScript dictionary of the frontmost app, or empty.
    public var scripting: String
    /// The elements behind the numbered controls, for `click_element`.
    public var elements: [Int: AXSearch.Entry]
    public var bundleID: String
    public var pid: pid_t

    public init(appName: String = "", windowTitle: String = "", controls: [[String: Any]] = [], scripting: String = "",
                elements: [Int: AXSearch.Entry] = [:], bundleID: String = "", pid: pid_t = 0) {
        self.appName = appName; self.windowTitle = windowTitle; self.controls = controls; self.scripting = scripting
        self.elements = elements; self.bundleID = bundleID; self.pid = pid
    }
}

/// A computer the driving loop can look at and act on: this Mac, or okidoki's private Mac (a VM).
@MainActor
public protocol ComputerTarget: AnyObject {
    /// Shown to the user, e.g. "this Mac".
    var displayName: String { get }
    /// True when this isn't the Mac okidoki runs on: no scripts, no accessibility, only the picture.
    var isRemote: Bool { get }
    /// Whether the user's own Escape key should stop a run. False when the user keeps
    /// using their Mac while the run happens somewhere else.
    var stopsOnUserEscape: Bool { get }
    /// Whether the labelled pointer overlay should follow the real cursor.
    var showsPointerOverlay: Bool { get }
    /// Whether clicks and keys can be delivered at all.
    var canAct: Bool { get }
    /// The screen to capture and act on. Nil when nothing sensible exists.
    func screen() -> NSScreen?
    func capture() async -> ComputerUseService.Screenshot?
    func context(box: ScreenBox, imageWidth: Double, imageHeight: Double) async -> ComputerContext
    func perform(_ action: ComputerAction, screen box: ScreenBox, imageWidth: Double, imageHeight: Double) async throws -> String
    /// The capture the driving loop sends to the model, sized for it.
    func captureForDriving(limits: ComputerUseService.ImageLimits, jpeg: Bool) async -> ComputerUseService.Screenshot?
    /// Whether the screen can be sampled cheaply to wait for it to settle and to check actions.
    var settles: Bool { get }
}

public extension ComputerTarget {
    func captureForDriving(limits: ComputerUseService.ImageLimits, jpeg: Bool) async -> ComputerUseService.Screenshot? {
        await capture()
    }

    var settles: Bool { false }
}

/// The Mac okidoki is running on.
@MainActor
public final class LocalComputer: ComputerTarget {
    private let service = ComputerUseService.shared

    public init() {}

    public var displayName: String { "this Mac" }
    public var isRemote: Bool { false }
    public var stopsOnUserEscape: Bool { true }
    public var showsPointerOverlay: Bool { true }
    public var canAct: Bool { EventActuator.canPost }

    public func screen() -> NSScreen? { service.screenForAction() }

    public func capture() async -> ComputerUseService.Screenshot? {
        await service.capture(screen: service.screenForAction())
    }

    public func captureForDriving(limits: ComputerUseService.ImageLimits, jpeg: Bool) async -> ComputerUseService.Screenshot? {
        await service.captureForDriving(screen: service.screenForAction(), limits: limits, jpeg: jpeg)
    }

    public var settles: Bool { true }

    public func context(box: ScreenBox, imageWidth: Double, imageHeight: Double) async -> ComputerContext {
        let front = service.frontmost()
        async let title = service.frontWindowTitle()
        async let snapshot = service.visibleSnapshot(box: box, imageWidth: imageWidth, imageHeight: imageHeight)
        async let scripting = service.scriptingHints()
        let found = await snapshot
        return ComputerContext(appName: front?.name ?? "", windowTitle: await title,
                               controls: found.controls, scripting: await scripting, elements: found.elements,
                               bundleID: front?.bundleID ?? "", pid: front?.pid ?? 0)
    }

    public func perform(_ action: ComputerAction, screen box: ScreenBox, imageWidth: Double, imageHeight: Double) async throws -> String {
        try await service.perform(action, screen: box, imageWidth: imageWidth, imageHeight: imageHeight)
    }
}
