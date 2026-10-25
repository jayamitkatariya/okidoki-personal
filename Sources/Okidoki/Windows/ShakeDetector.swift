import AppKit
import Foundation
import OkidokiCore

/// Watches the pointer and fires `onShake` on a real shake. The recognition itself lives in
/// `ShakeGesture`, where it can be tested with synthetic motion.
@MainActor
final class ShakeDetector {
    var onShake: (() -> Void)?
    var sensitivity: Double = 0.65 { didSet { gesture.sensitivity = sensitivity } }
    var isEnabled: Bool = true
    /// Ask for one more turn before firing. Set while a shake would open the mic, where a false
    /// one costs more than a missed one.
    var deliberate: Bool = false { didSet { gesture.deliberate = deliberate } }

    private var gesture = ShakeGesture()
    private var globalMonitor: Any?
    private var localMonitor: Any?

    func start() {
        stop()
        let mask: NSEvent.EventTypeMask = [.mouseMoved]
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            self?.take(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.take(event)
            return event
        }
        gesture.reset()
        _ = gesture.ingest(NSEvent.mouseLocation, at: ProcessInfo.processInfo.systemUptime)
    }

    /// The monitor runs on the main thread. Use the event's own time so a fast shake
    /// isn't thrown out just because the samples were handled in one burst.
    private nonisolated func take(_ event: NSEvent) {
        // Mouse moves posted by okidoki itself while it drives are not a shake.
        if EventActuator.isSynthetic(event) { return }
        let point = NSEvent.mouseLocation
        let time = event.timestamp
        if Thread.isMainThread {
            MainActor.assumeIsolated { self.ingest(point, at: time) }
        } else {
            Task { @MainActor in self.ingest(point, at: time) }
        }
    }

    func stop() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        globalMonitor = nil
        localMonitor = nil
    }

    private func ingest(_ point: CGPoint, at now: TimeInterval) {
        guard isEnabled else { return }
        if gesture.ingest(point, at: now) { onShake?() }
    }
}
