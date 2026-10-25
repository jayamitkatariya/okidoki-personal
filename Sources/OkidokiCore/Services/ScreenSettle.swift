import AppKit
import ApplicationServices
import ScreenCaptureKit

// MARK: - Capture filter cache

/// ScreenCaptureKit's shareable-content query costs far more than the capture itself, so the
/// per-display filter (okidoki's own windows excluded) is kept and reused. It is dropped when
/// displays change, after a few seconds, or when a capture with it fails.
@MainActor
public final class DisplayFilterCache {
    public static let shared = DisplayFilterCache()

    private struct Entry {
        var display: SCDisplay
        var filter: SCContentFilter
        var at: Date
    }

    private var entries: [CGDirectDisplayID: Entry] = [:]
    private var observer: NSObjectProtocol?

    private init() {
        observer = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                          object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.invalidate() }
        }
    }

    public func invalidate() { entries.removeAll() }

    public static func displayID(of screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    }

    public func filter(for screen: NSScreen, maxAge: TimeInterval = 10) async -> (display: SCDisplay, filter: SCContentFilter)? {
        let id = Self.displayID(of: screen)
        if let entry = entries[id], Date().timeIntervalSince(entry.at) < maxAge { return (entry.display, entry.filter) }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
              let display = content.displays.first(where: { $0.displayID == id }) else { return nil }
        let ownBundle = Bundle.main.bundleIdentifier
        let own = content.applications.filter { $0.bundleIdentifier == ownBundle }
        let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
        entries[id] = Entry(display: display, filter: filter, at: Date())
        return (display, filter)
    }
}

// MARK: - Samples

/// A small grayscale picture of a display, for telling whether the screen changed.
public struct ScreenSample: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let pixels: [UInt8]

    public init(width: Int, height: Int, pixels: [UInt8]) {
        self.width = width; self.height = height; self.pixels = pixels
    }
}

/// How two samples differ, measured per 16×16 tile so a small local change (a checkbox, a
/// focus ring, a typed word) still counts while a blinking caret does not.
public struct ScreenChange: Sendable, Equatable {
    /// Largest mean difference of any tile, 0–255.
    public var peak: Double
    /// Share of tiles that changed.
    public var fraction: Double
    /// How many tiles changed.
    public var tiles: Int

    public init(peak: Double, fraction: Double, tiles: Int = 0) { self.peak = peak; self.fraction = fraction; self.tiles = tiles }

    public var changed: Bool { peak >= ScreenSampler.changedPeak }
    /// Still enough to stop waiting: a blinking caret or a tiny spinner touches a tile or two at most.
    public var settled: Bool { tiles <= 2 }
    /// Enough of the screen changed that earlier pixel targets can't be trusted (a new window, page, menu or dialog).
    public var large: Bool { fraction >= ScreenSampler.largeFraction }
}

public struct SettleResult: Sendable {
    /// Before versus after; nil when either sample was missing.
    public var change: ScreenChange?
    public var elapsedMs: Int
    /// The screen stopped changing before the time limit.
    public var stable: Bool
    public var changed: Bool { change?.changed ?? true }
    public var large: Bool { change?.large ?? false }
}

@MainActor
public enum ScreenSampler {
    /// Wide enough that two typed characters or a checkbox register, narrow enough that a blinking caret doesn't.
    public static let width = 640
    public nonisolated static let tile = 16
    public nonisolated static let changedPeak = 3.0
    public nonisolated static let largeFraction = 0.12

    public static func sample(screen: NSScreen) async -> ScreenSample? {
        guard CGPreflightScreenCaptureAccess(), let entry = await DisplayFilterCache.shared.filter(for: screen) else { return nil }
        let frame = entry.display.frame
        let config = SCStreamConfiguration()
        config.width = width
        config.height = max(1, Int((Double(width) * Double(frame.height) / Double(max(frame.width, 1))).rounded()))
        config.showsCursor = false
        config.captureResolution = .nominal
        do {
            let image = try await SCScreenshotManager.captureImage(contentFilter: entry.filter, configuration: config)
            return await Task.detached(priority: .userInitiated) { gray(image) }.value
        } catch {
            DisplayFilterCache.shared.invalidate()
            return nil
        }
    }

    public nonisolated static func gray(_ image: CGImage, width: Int? = nil) -> ScreenSample? {
        let w = width ?? image.width
        let h = max(1, Int((Double(w) * Double(image.height) / Double(max(image.width, 1))).rounded()))
        guard w > 0, let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                             space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = context.data else { return nil }
        let buffer = UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: w * h)
        return ScreenSample(width: w, height: h, pixels: Array(buffer))
    }

    public nonisolated static func compare(_ a: ScreenSample, _ b: ScreenSample) -> ScreenChange {
        guard a.width == b.width, a.height == b.height, a.width > 0, a.height > 0 else { return ScreenChange(peak: 255, fraction: 1, tiles: Int.max) }
        let columns = max(1, a.width / tile)
        let rows = max(1, a.height / tile)
        var peak = 0.0
        var changed = 0
        for row in 0..<rows {
            for column in 0..<columns {
                var sum = 0
                let x0 = column * tile, y0 = row * tile
                let x1 = min(a.width, x0 + tile), y1 = min(a.height, y0 + tile)
                for y in y0..<y1 {
                    let base = y * a.width
                    for x in x0..<x1 {
                        let d = Int(a.pixels[base + x]) - Int(b.pixels[base + x])
                        sum += d < 0 ? -d : d
                    }
                }
                let mean = Double(sum) / Double(max(1, (x1 - x0) * (y1 - y0)))
                if mean > peak { peak = mean }
                if mean >= changedPeak { changed += 1 }
            }
        }
        return ScreenChange(peak: peak, fraction: Double(changed) / Double(columns * rows), tiles: changed)
    }

    /// Waits for the screen to stop changing after an action: at least `minMs`, at most `maxMs`,
    /// and `stableSamples` unchanged samples in a row. With `webArea`, also until the page reports loaded.
    public static func settle(screen: NSScreen, before: ScreenSample?, minMs: Int, maxMs: Int,
                              stableSamples: Int = 1, webArea: AXUIElement? = nil) async -> SettleResult {
        let start = ContinuousClock.now
        func elapsed() -> Int {
            let d = ContinuousClock.now - start
            return Int(d.components.seconds * 1000) + Int(d.components.attoseconds / 1_000_000_000_000_000)
        }
        var last: ScreenSample?
        var still = 0
        var stable = false
        if minMs > 0 { try? await Task.sleep(nanoseconds: UInt64(minMs) * 1_000_000) }
        while elapsed() < maxMs {
            guard let current = await sample(screen: screen) else { break }
            if let last { still = compare(last, current).settled ? still + 1 : 0 }
            last = current
            let loaded = webArea.map { WebPage.isLoaded($0) } ?? true
            if still >= stableSamples, loaded { stable = true; break }
            try? await Task.sleep(nanoseconds: 60_000_000)
        }
        let change: ScreenChange? = {
            guard let before, let last else { return nil }
            return compare(before, last)
        }()
        return SettleResult(change: change, elapsedMs: elapsed(), stable: stable)
    }
}

// MARK: - Web pages

/// Whether the page in a browser has finished loading, read from its accessibility web area.
public enum WebPage {
    static let browsers: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
        "company.thebrowser.Browser", "company.thebrowser.dia", "com.microsoft.edgemac", "com.brave.Browser",
        "org.mozilla.firefox", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
    ]

    public static func isBrowser(bundleID: String) -> Bool { browsers.contains(bundleID) }

    /// The focused window's web area, found within a small budget.
    public nonisolated static func webArea(pid: pid_t) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        var queue: [AXUIElement] = [raw as! AXUIElement]
        var visited = 0
        let started = Date()
        while !queue.isEmpty, visited < 500, Date().timeIntervalSince(started) < 0.25 {
            let element = queue.removeFirst()
            visited += 1
            var role: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
               (role as? String) == "AXWebArea" {
                return element
            }
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
               let list = children as? [AXUIElement] {
                queue.append(contentsOf: list.prefix(40))
            }
        }
        return nil
    }

    /// True unless the web area says it is still loading. Unknown counts as loaded.
    public nonisolated static func isLoaded(_ area: AXUIElement) -> Bool {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(area, "AXElementBusy" as CFString, &value) == .success, let busy = value as? Bool, busy {
            return false
        }
        if AXUIElementCopyAttributeValue(area, "AXLoaded" as CFString, &value) == .success, let loaded = value as? Bool {
            return loaded
        }
        if AXUIElementCopyAttributeValue(area, "AXLoadingProgress" as CFString, &value) == .success, let progress = value as? Double {
            return progress >= 0.999
        }
        return true
    }
}
