import AppKit
import Foundation
import OkidokiCore

@MainActor
final class ShakeDetector {
    var onShake: (() -> Void)?
    var sensitivity: Double = 0.65
    var isEnabled: Bool = true

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var lastPoint: CGPoint = .zero
    private var samples: [(time: TimeInterval, dx: CGFloat, dy: CGFloat)] = []
    private var lastFire = Date.distantPast
    /// Nonzero once a stroke has started. The actual direction lives in `heading`.
    private var direction: CGFloat = 0
    /// Where the current stroke is pointing.
    private var heading: CGPoint = .zero
    /// Distance traveled in `heading` since the last committed reversal.
    private var stroke: CGFloat = 0
    /// Opposite-direction distance that has not yet been large enough to count as a turn.
    private var pendingFlip: CGFloat = 0
    private var reversalTimes: [TimeInterval] = []

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
        lastPoint = NSEvent.mouseLocation
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
        let dx = point.x - lastPoint.x
        let dy = point.y - lastPoint.y
        lastPoint = point
        let travel = hypot(dx, dy)
        guard travel > 1.5 else { return }

        samples.append((now, dx, dy))
        samples.removeAll { now - $0.time > Self.window }
        reversalTimes.removeAll { now - $0 > Self.window }

        // Direction of the stroke so far. A shake is a turnaround, whichever way you do it.
        if direction == 0 && stroke == 0 {
            heading = CGPoint(x: dx, y: dy)
            stroke = travel
            direction = 1
            return
        }
        let along = dx * heading.x + dy * heading.y
        if along >= 0 {
            heading.x += dx
            heading.y += dy
            stroke += travel
            pendingFlip = 0
        } else {
            pendingFlip += travel
            guard pendingFlip >= flipDeadzone else { return }
            if stroke >= minStroke {
                reversalTimes.append(now)
            }
            heading = CGPoint(x: dx, y: dy)
            stroke = pendingFlip
            pendingFlip = 0
            direction = 1
        }
        evaluate(now: now)
    }

    private func evaluate(now: TimeInterval) {
        guard Date().timeIntervalSince(lastFire) > 0.9 else { return }
        // Three turnarounds: out, back, out again. That is a shake.
        guard reversalTimes.count >= 3 else { return }
        var path: CGFloat = 0
        var netX: CGFloat = 0
        var netY: CGFloat = 0
        for sample in samples where now - sample.time <= Self.window {
            path += hypot(sample.dx, sample.dy)
            netX += sample.dx
            netY += sample.dy
        }
        guard path > minStroke * 3 else { return }
        // A shake stays put. A trip across the screen does not.
        guard path > 0, hypot(netX, netY) / path < 0.8 else { return }

        lastFire = Date()
        clearGesture()
        onShake?()
    }

    /// Higher sensitivity shortens how far you have to travel before a turn counts.
    private var tuned: CGFloat { CGFloat(min(1, max(0, sensitivity))) }
    private var minStroke: CGFloat { 26 - tuned * 12 }
    private var flipDeadzone: CGFloat { 6 - tuned * 2 }
    private static let window: TimeInterval = 1.0

    private func clearGesture() {
        samples.removeAll()
        reversalTimes.removeAll()
        direction = 0
        heading = .zero
        stroke = 0
        pendingFlip = 0
    }

}
