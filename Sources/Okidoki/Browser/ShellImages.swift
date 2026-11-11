import AppKit
import Foundation
import OkidokiCore
import WebKit

/// Pictures the new shell shows that aren't the page itself: a thumbnail per run for the Recent tasks
/// cards, a favicon per site for pins, bookmarks and tabs, and a still of the tab in front for when a
/// web overlay has to cover the native page. All are served to the dashboard as
/// `okidoki-live://thumb/<runID>`, `okidoki-live://favicon/<host>` and `okidoki-live://freeze/<n>`.
@MainActor
enum RunThumbs {
    static let keep = 60
    static let width: CGFloat = 640
    private static var lastAt: [String: Date] = [:]

    static var folder: URL {
        let url = AppPaths.support("thumbs", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func url(_ runID: String) -> URL {
        folder.appendingPathComponent(safe(runID) + ".jpg")
    }

    static func has(_ runID: String) -> Bool {
        FileManager.default.fileExists(atPath: url(runID).path)
    }

    static func data(_ runID: String) -> Data? { try? Data(contentsOf: url(runID)) }

    /// A still of the tab a run is working in. At most one every few seconds, unless it's the last one.
    static func capture(_ tab: BrowserTab, runID: String, final: Bool = false) {
        let now = Date()
        if !final, let last = lastAt[runID], now.timeIntervalSince(last) < 4 { return }
        // A finished run takes no more stills, so its entry goes rather than piling up for good.
        if final { lastAt[runID] = nil } else { lastAt[runID] = now }
        guard !tab.isBlank else { return }
        let config = WKSnapshotConfiguration()
        config.snapshotWidth = NSNumber(value: Double(width))
        tab.webView.takeSnapshot(with: config) { image, _ in
            guard let image else { return }
            Task { @MainActor in save(image: image, runID: runID) }
        }
    }

    /// The last screen a computer-use run saw.
    static func note(_ data: Data, runID: String) {
        let now = Date()
        if let last = lastAt[runID], now.timeIntervalSince(last) < 4 { return }
        lastAt[runID] = now
        // Decoding a full-screen PNG and scaling it down is real work; it happens off the main thread.
        let target = url(runID)
        Task.detached(priority: .utility) {
            guard let image = NSImage(data: data), let jpeg = image.okJPEG(maxWidth: width) else { return }
            try? jpeg.write(to: target, options: .atomic)
            await MainActor.run {
                trim()
                ShellImages.changed()
            }
        }
    }

    private static func save(image: NSImage, runID: String) {
        guard let jpeg = image.okJPEG(maxWidth: width) else { return }
        try? jpeg.write(to: url(runID), options: .atomic)
        trim()
        ShellImages.changed()
    }

    private static func trim() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]),
              files.count > keep else { return }
        let sorted = files.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a > b
        }
        for file in sorted.dropFirst(keep) { try? fm.removeItem(at: file) }
    }

    private static func safe(_ id: String) -> String {
        id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
}

/// Site icons, fetched from the site itself (never a third-party icon service) and kept as 64px PNGs.
@MainActor
enum FaviconCache {
    /// Hosts with no icon, and when that was found. Tried again after an hour; a network failure
    /// (offline, a timeout) isn't remembered at all.
    private static var missing: [String: Date] = [:]
    private static func isMissing(_ host: String) -> Bool {
        guard let at = missing[host] else { return false }
        return Date().timeIntervalSince(at) < 3600
    }
    private static var inFlight: [String: Task<Data?, Never>] = [:]
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 6
        config.httpCookieStorage = nil
        return URLSession(configuration: config)
    }()

    static var folder: URL {
        let url = AppPaths.support("favicons", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func key(_ host: String) -> String {
        let lower = host.lowercased()
        let bare = lower.hasPrefix("www.") ? String(lower.dropFirst(4)) : lower
        return bare.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
    }

    private static func file(_ host: String) -> URL { folder.appendingPathComponent(key(host) + ".png") }

    static func cached(_ host: String) -> Data? { try? Data(contentsOf: file(host)) }

    /// The icon for a host: from the cache, else the site's touch icon or favicon.ico.
    static func icon(_ host: String) async -> Data? {
        let host = key(host)
        guard !host.isEmpty else { return nil }
        if let data = cached(host) { return data }
        if isMissing(host) { return nil }
        if let running = inFlight[host] { return await running.value }
        var offline = false
        let task = Task<Data?, Never> {
            for path in ["/apple-touch-icon.png", "/favicon.ico"] {
                guard let url = URL(string: "https://\(host)\(path)") else { continue }
                switch await fetchResult(url) {
                case .icon(let png): return png
                case .unreachable: offline = true; return nil
                case .none: continue
                }
            }
            if host.split(separator: ".").count == 2, let url = URL(string: "https://www.\(host)/favicon.ico"),
               case .icon(let png) = await fetchResult(url) {
                return png
            }
            return nil
        }
        inFlight[host] = task
        let data = await task.value
        inFlight[host] = nil
        if let data { try? data.write(to: file(host), options: .atomic) } else if !offline { missing[host] = Date() }
        return data
    }

    /// The page told us its icon: read `<link rel=icon>` from a page that just finished loading.
    static func learn(from tab: BrowserTab) {
        guard let pageURL = tab.webView.url, let host = pageURL.host, cached(host) == nil, !isMissing(key(host)),
              inFlight[key(host)] == nil else { return }
        let script = """
        (() => {
          const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]')];
          const score = (l) => (l.rel.includes('apple') ? 300 : 0) + (parseInt((l.sizes && l.sizes.value || '').split('x')[0]) || 16);
          links.sort((a, b) => score(b) - score(a));
          return links.length ? links[0].href : null;
        })()
        """
        tab.webView.evaluateJavaScript(script) { result, _ in
            Task { @MainActor in
                // Only an icon on the web: a page must not point this at a file on the Mac.
                let href = (result as? String).flatMap(URL.init(string:)).flatMap { ["https", "http"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
                if let href, case .icon(let png) = await fetchResult(href) {
                    try? png.write(to: file(host), options: .atomic)
                    missing[key(host)] = nil
                    ShellImages.changed()
                } else {
                    _ = await icon(host)
                }
            }
        }
    }

    private enum Fetched { case icon(Data), none, unreachable }

    private static func fetchResult(_ url: URL) async -> Fetched {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return .none }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch let error as URLError where [.notConnectedToInternet, .timedOut, .networkConnectionLost,
                                             .cannotConnectToHost, .dnsLookupFailed].contains(error.code) {
            return .unreachable
        } catch {
            return .none
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count > 60, let image = NSImage(data: data), image.size.width >= 8,
              let png = image.okPNG(side: 64) else { return .none }
        return .icon(png)
    }
}

/// A still of the tab in front while a web overlay covers it, so the page doesn't blink out.
@MainActor
enum BrowserFreeze {
    private(set) static var image: Data?
    /// The overlay closed: the still isn't needed and it's a big picture to keep.
    static func release() { image = nil }
    private(set) static var serial = 0

    static func capture(_ tab: BrowserTab, done: @escaping (String?) -> Void) {
        guard !tab.isBlank else { done(nil); return }
        tab.webView.takeSnapshot(with: nil) { snapshot, _ in
            Task { @MainActor in
                guard let snapshot, let jpeg = snapshot.okJPEG(maxWidth: 2400, quality: 0.85) else { done(nil); return }
                image = jpeg
                serial += 1
                done("\(LiveFrames.scheme)://freeze/\(serial)")
            }
        }
    }
}

/// Lets the dashboard know a picture it shows changed, so it pushes fresh state.
@MainActor
enum ShellImages {
    static var onChange: (() -> Void)?
    static func changed() { onChange?() }

    /// Answers `okidoki-live://<kind>/<id>` for the kinds above. Nil means "not one of mine".
    static func serve(kind: String, id: String) async -> Data? {
        switch kind {
        case "thumb": return RunThumbs.data(id)
        case "favicon": return await FaviconCache.icon(id)
        case "freeze": return BrowserFreeze.image
        default: return nil
        }
    }
}

extension NSImage {
    func okJPEG(maxWidth: CGFloat, quality: Double = 0.72) -> Data? {
        guard let cg = cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let scale = min(1, maxWidth / CGFloat(cg.width))
        let w = max(1, Int(CGFloat(cg.width) * scale)), h = max(1, Int(CGFloat(cg.height) * scale))
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let scaled = context.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: scaled).representation(using: .jpeg, properties: [.compressionFactor: quality])
    }

    func okPNG(side: Int) -> Data? {
        // The biggest representation an .ico holds, drawn down to `side`.
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)
        guard let rep else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }
}
