import AppKit
import Foundation
import ScreenCaptureKit
import VideoToolbox

/// Pictures of what each recorded step looked like: a small crop of the screen around the
/// pointer, saved as PNG under `~/Library/Application Support/Okidoki/frames/<step id>.png`.
/// Replay uses them to find a control again by sight when accessibility can't, and shows them
/// to the brain when it has to step in. Needs Screen Recording; without it nothing is saved and
/// replay behaves as before.
public enum SkillFrames {
    /// Crop size in points. Wide enough to include a list row's text, short enough to stay
    /// specific to one control.
    public static let cropSize = CGSize(width: 220, height: 140)

    public static var directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Okidoki/frames", isDirectory: true)
    }()

    public static func url(for stepID: String) -> URL {
        directory.appendingPathComponent("\(stepID).png")
    }

    public static func has(_ stepID: String) -> Bool {
        FileManager.default.fileExists(atPath: url(for: stepID).path)
    }

    public static func load(_ stepID: String) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url(for: stepID) as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    public static func remove(_ stepIDs: [String]) {
        for id in stepIDs { try? FileManager.default.removeItem(at: url(for: id)) }
    }

    public static func remove(skill: Skill) {
        remove(skill.steps.map(\.id))
    }

    /// The crop rectangle (Quartz points) centred on a point, kept inside its display.
    public static func cropRect(around point: CGPoint, in display: CGRect) -> CGRect {
        var rect = CGRect(x: point.x - cropSize.width / 2, y: point.y - cropSize.height / 2,
                          width: cropSize.width, height: cropSize.height)
        rect.origin.x = min(max(rect.minX, display.minX), max(display.minX, display.maxX - rect.width))
        rect.origin.y = min(max(rect.minY, display.minY), max(display.minY, display.maxY - rect.height))
        return rect.intersection(display)
    }

    /// Shareable displays are looked up once per recording; the call is slow and the answer
    /// only changes when displays are plugged in.
    private static var cachedContent: SCShareableContent?
    private static var stream: FrameStream?
    /// The preparation under way, so two callers share one instead of starting two streams.
    private static var preparing: Task<Void, Never>?
    /// Bumped by `finish()`: a stream that finishes starting after that belongs to a recording
    /// that has already ended, and is stopped instead of kept.
    private static var generation = 0

    /// Gets ready to take pictures: looks the displays up and starts watching the display the
    /// pointer is on, so a click's picture can be cut from the frame just before the click.
    @MainActor
    public static func prepare() async {
        guard CGPreflightScreenCaptureAccess() else { return }
        if let preparing { await preparing.value; return }
        let wanted = generation
        let task = Task<Void, Never> { @MainActor in
            cachedContent = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let content = cachedContent, stream == nil, generation == wanted else { return }
            let pointer = CGEvent(source: nil)?.location ?? .zero
            guard let display = content.displays.first(where: { $0.frame.contains(pointer) }) ?? content.displays.first else { return }
            let candidate = FrameStream(display: display, content: content)
            guard await candidate.start() else { return }
            if generation == wanted, stream == nil { stream = candidate } else { candidate.stop() }
        }
        preparing = task
        await task.value
        if preparing == task { preparing = nil }
    }

    /// Stops watching the display. Nothing is kept.
    @MainActor
    public static func finish() {
        generation += 1
        preparing = nil
        stream?.stop()
        stream = nil
    }

    /// The pixel density of a display, 2 on Retina.
    static func scale(of display: SCDisplay) -> CGFloat {
        let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }
        return max(screen?.backingScaleFactor ?? 2, 1)
    }

    public struct Capture: @unchecked Sendable {
        /// Where the crop is on screen, Quartz points.
        public var rect: CGRect
        /// The crop at the display's pixel density.
        public var image: CGImage
        /// The pointer position it was taken around.
        public var point: CGPoint
        public var at: Date
    }

    /// A crop of the screen around `point` (Quartz), at its display's native scale: from the
    /// frame just before now when the display is being watched (so a click's picture shows the
    /// control before it was pressed), else a fresh capture. Nil when the screen can't be captured.
    @MainActor
    public static func capture(around point: CGPoint) async -> Capture? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        if cachedContent == nil {
            cachedContent = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        }
        guard let content = cachedContent else { return nil }
        let displays = content.displays
        guard let display = displays.first(where: { $0.frame.contains(point) }) ?? displays.first else { return nil }
        let rect = cropRect(around: point, in: display.frame)
        guard rect.width >= 16, rect.height >= 16 else { return nil }
        let scale = Self.scale(of: display)
        if let stream, stream.displayID == display.displayID, let frame = stream.frame(olderThan: 0.02) {
            let pixels = CGRect(x: (rect.minX - display.frame.minX) * scale, y: (rect.minY - display.frame.minY) * scale,
                                width: rect.width * scale, height: rect.height * scale).integral
            if let image = frame.cropping(to: pixels) {
                return Capture(rect: rect, image: image, point: point, at: Date())
            }
        }
        let ownBundle = Bundle.main.bundleIdentifier
        let own = content.applications.filter { $0.bundleIdentifier == ownBundle }
        let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.sourceRect = CGRect(x: rect.minX - display.frame.minX, y: rect.minY - display.frame.minY,
                                   width: rect.width, height: rect.height)
        config.width = Int((rect.width * scale).rounded())
        config.height = Int((rect.height * scale).rounded())
        config.showsCursor = false
        config.scalesToFit = false
        config.captureResolution = .best
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config),
              image.width > 0, image.height > 0 else { return nil }
        return Capture(rect: rect, image: image, point: point, at: Date())
    }

    /// Writes a capture to disk for a step.
    @discardableResult
    public static func save(_ capture: Capture, stepID: String) async -> Bool {
        let image = capture.image
        return await Task.detached(priority: .utility) { () -> Bool in
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            guard let destination = CGImageDestinationCreateWithURL(url(for: stepID) as CFURL, "public.png" as CFString, 1, nil) else { return false }
            CGImageDestinationAddImage(destination, image, nil)
            return CGImageDestinationFinalize(destination)
        }.value
    }

    /// The saved crop as PNG bytes, for showing to the brain.
    public static func png(_ stepID: String) -> Data? {
        try? Data(contentsOf: url(for: stepID))
    }

    /// Where the recorded control is on the live screen, by picture. `shot` is a full-resolution
    /// capture of one display with its box in Quartz points. The returned point is the step's
    /// click point carried along with the crop (Quartz), with how sure the match was.
    public static func locate(step: SkillStep, in shot: CGImage, box: ScreenBox, near: CGPoint?) -> (point: CGPoint, score: Double)? {
        guard let frame = step.frameRect, let x = step.x, let y = step.y, box.width > 0, box.height > 0,
              var template = load(step.id) else { return nil }
        let pixelsPerPoint = Double(shot.width) / box.width
        // The crop was saved at its display's scale; bring it to this display's.
        let recordedScale = Double(template.width) / frame.width
        if abs(recordedScale - pixelsPerPoint) > 0.05 {
            let size = (width: max(8, Int((frame.width * pixelsPerPoint).rounded())),
                        height: max(8, Int((frame.height * pixelsPerPoint).rounded())))
            guard let scaled = ComputerUseService.resized(template, to: size) else { return nil }
            template = scaled
        }
        let nearPixels = near.map { CGPoint(x: ($0.x - box.x) * pixelsPerPoint, y: ($0.y - box.y) * pixelsPerPoint) }
        // The click isn't always at the crop's centre (crops stay inside the display): look at
        // the part around the click, and read the answer as where the click is now.
        let anchor = CGPoint(x: (x - frame.minX) * pixelsPerPoint, y: (y - frame.minY) * pixelsPerPoint)
        guard let match = FrameMatcher.find(template: template, in: shot, near: nearPixels, anchor: anchor) else { return nil }
        return (CGPoint(x: box.x + match.center.x / pixelsPerPoint, y: box.y + match.center.y / pixelsPerPoint), match.edge)
    }
}

// MARK: - Live frames while recording

/// A low-rate stream of one display, keeping the last couple of frames so a click can be
/// pictured as the screen was just before it. Ten frames a second at most, and only when
/// something changed; one or two frames of memory.
final class FrameStream: NSObject, SCStreamOutput {
    let displayID: CGDirectDisplayID
    private let display: SCDisplay
    private let content: SCShareableContent
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "okidoki.skill-frames")
    private let lock = NSLock()
    private var frames: [(buffer: CVPixelBuffer, at: Date)] = []

    init(display: SCDisplay, content: SCShareableContent) {
        self.displayID = display.displayID
        self.display = display
        self.content = content
    }

    func start() async -> Bool {
        let ownBundle = Bundle.main.bundleIdentifier
        let own = content.applications.filter { $0.bundleIdentifier == ownBundle }
        let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
        let scale = SkillFrames.scale(of: display)
        let config = SCStreamConfiguration()
        config.width = Int((display.frame.width * scale).rounded())
        config.height = Int((display.frame.height * scale).rounded())
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.queueDepth = 6
        config.showsCursor = false
        config.scalesToFit = false
        config.captureResolution = .best
        config.pixelFormat = kCVPixelFormatType_32BGRA
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await stream.startCapture()
        } catch {
            return false
        }
        self.stream = stream
        return true
    }

    func stop() {
        let stream = self.stream
        self.stream = nil
        Task { try? await stream?.stopCapture() }
        lock.lock(); frames = []; lock.unlock()
    }

    /// The newest frame captured at least `age` seconds ago, so an event that has just happened
    /// can't be in it. Nil until the first frame has arrived.
    func frame(olderThan age: TimeInterval) -> CGImage? {
        lock.lock()
        let candidates = frames
        lock.unlock()
        let cutoff = Date().addingTimeInterval(-age)
        guard let pick = candidates.last(where: { $0.at <= cutoff }) ?? candidates.first else { return nil }
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pick.buffer, options: nil, imageOut: &image)
        return image
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let buffer = sampleBuffer.imageBuffer else { return }
        // Frames flagged as not "complete" carry no new picture.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let status = attachments.first?[.status] as? Int, status != SCFrameStatus.complete.rawValue {
            return
        }
        lock.lock()
        frames.append((buffer, Date()))
        if frames.count > 2 { frames.removeFirst(frames.count - 2) }
        lock.unlock()
    }
}
