import AppKit
import CoreGraphics
import Foundation

// MARK: - Browser context

/// Title and URL of the front browser tab, read through AppleScript, so a lesson about "this video"
/// knows which video and a request made on Tinkercad is answered on Tinkercad.
public enum BrowserContext {
    public struct Page: Sendable, Equatable {
        public var title: String
        public var url: String
        public init(title: String, url: String) { self.title = title; self.url = url }
    }

    /// True for the browsers whose front tab can be read with AppleScript.
    public static func isBrowser(bundleID: String?) -> Bool {
        script(bundleID: bundleID, appName: nil) != nil
    }

    static func script(bundleID: String?, appName: String?) -> String? {
        guard let bundle = bundleID?.lowercased() else { return nil }
        if bundle.contains("safari") {
            return "tell application \"Safari\" to return (name of front document) & \"\\n\" & (URL of front document)"
        }
        if bundle.contains("chrome") || bundle.contains("chromium") || bundle.contains("brave") || bundle.contains("arc") || bundle.contains("edge") {
            let name = (appName ?? "Google Chrome").replacingOccurrences(of: "\"", with: "")
            return "tell application \"\(name)\" to return (title of active tab of front window) & \"\\n\" & (URL of active tab of front window)"
        }
        return nil
    }

    public static func current(app: NSRunningApplication?) async -> Page? {
        guard let script = script(bundleID: app?.bundleIdentifier, appName: app?.localizedName) else { return nil }
        return await Task.detached(priority: .utility) { () -> Page? in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", script]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            do {
                try process.run()
            } catch {
                return nil
            }
            // Read to EOF before waiting, so a chatty process can't fill the pipe and stall.
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let lines = output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard lines.count >= 2 else { return nil }
            let title = lines[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let url = lines[1].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty || !url.isEmpty else { return nil }
            return Page(title: title, url: url)
        }.value
    }
}

// MARK: - Screen context

/// Gathers what the brain needs to understand the screen before it routes a request: the front
/// window's title, the browser tab, and a small screenshot of the display the person is on.
/// Everything runs in parallel and nothing here prompts for permissions — a missing grant just
/// means that piece is left out.
@MainActor
public enum ScreenContextService {
    /// Long edge of the routing screenshot. Enough to read a page's headings and panels,
    /// well under what the tutor sends when it has to click precisely.
    public static let routingLongEdge = 1000

    public static func capture(app: NSRunningApplication?, screen: NSScreen, model: String,
                               includeScreenshot: Bool = true) async -> ScreenContext? {
        guard let app, app.bundleIdentifier != Bundle.main.bundleIdentifier else { return nil }
        let pid = app.processIdentifier
        let fit = ImageFit.tier(for: model)
        let longEdge = routingLongEdge

        // The tab and window title run as children while this task takes the screenshot, the slow part.
        async let page = BrowserContext.current(app: app)
        async let windowTitle = Task.detached(priority: .userInitiated) { () -> String in
            AXSearch.focusedWindowTitle(pid: pid)
        }.value

        var image: (png: Data, width: Double, height: Double)?
        if includeScreenshot, CGPreflightScreenCaptureAccess(), !Task.isCancelled,
           let captured = await ComputerUseService.shared.capture(screen: screen) {
            let full = captured.full
            image = await Task.detached(priority: .userInitiated) { () -> (png: Data, width: Double, height: Double)? in
                let size = fit.resized(width: full.width, height: full.height, longEdgeCap: longEdge)
                guard let scaled = TeachImage.scaled(full, to: size), let png = TeachImage.png(scaled) else { return nil }
                return (png, Double(size.width), Double(size.height))
            }.value
        }

        let pageInfo = await page
        let title = await windowTitle
        let context = ScreenContext(windowTitle: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                    pageTitle: pageInfo?.title ?? "",
                                    pageURL: pageInfo?.url ?? "",
                                    screenshotPNG: image?.png,
                                    imageWidth: image?.width ?? 0,
                                    imageHeight: image?.height ?? 0)
        return context.isEmpty ? nil : context
    }
}
