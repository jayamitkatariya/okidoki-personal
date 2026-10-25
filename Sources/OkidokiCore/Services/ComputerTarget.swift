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

    public init(appName: String = "", windowTitle: String = "", controls: [[String: Any]] = [], scripting: String = "") {
        self.appName = appName; self.windowTitle = windowTitle; self.controls = controls; self.scripting = scripting
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

    public func context(box: ScreenBox, imageWidth: Double, imageHeight: Double) async -> ComputerContext {
        let front = service.frontmost()
        async let title = service.frontWindowTitle()
        async let controls = service.visibleControls(box: box, imageWidth: imageWidth, imageHeight: imageHeight)
        async let scripting = service.scriptingHints()
        return ComputerContext(appName: front?.name ?? "", windowTitle: await title,
                               controls: await controls, scripting: await scripting)
    }

    public func perform(_ action: ComputerAction, screen box: ScreenBox, imageWidth: Double, imageHeight: Double) async throws -> String {
        try await service.perform(action, screen: box, imageWidth: imageWidth, imageHeight: imageHeight)
    }
}
