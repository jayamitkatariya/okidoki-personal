import Foundation

/// Recognises a mouse shake from a stream of pointer positions. Pure arithmetic, no AppKit, so
/// it can be driven by recorded or synthetic motion in tests.
///
/// A shake is a few brisk sweeps back and forth that end up roughly where they started. Each
/// sweep has to cover real ground (its extent, not the length of a wobbly path), the turns have
/// to come one right after another, and the whole thing has to move at a shaking pace. Aiming
/// corrections, a tremor on the trackpad, and crossing the screen with a wobble all fail one of
/// those, which is what keeps the capsule (and the mic) from opening on their own.
public struct ShakeGesture {
    /// 0...1. Higher shortens how far and how fast you have to move.
    public var sensitivity: Double
    /// Ask for one more turn and longer sweeps. For when a false shake costs more than a missed one.
    public var deliberate: Bool

    private var lastPoint: CGPoint?
    private var samples: [(time: TimeInterval, dx: CGFloat, dy: CGFloat)] = []
    private var reversalTimes: [TimeInterval] = []
    /// The sweep under way: where it began, the farthest point reached, and how far that is.
    private var sweepStart: CGPoint?
    private var sweepFar: CGPoint = .zero
    private var sweepExtent: CGFloat = 0
    private var lastFire: TimeInterval = -.infinity

    public init(sensitivity: Double = 0.65, deliberate: Bool = false) {
        self.sensitivity = sensitivity
        self.deliberate = deliberate
    }

    /// Feeds one pointer position. Returns true when this sample completes a shake.
    public mutating func ingest(_ point: CGPoint, at now: TimeInterval) -> Bool {
        guard let previous = lastPoint else {
            lastPoint = point
            return false
        }
        let dx = point.x - previous.x
        let dy = point.y - previous.y
        lastPoint = point
        let travel = hypot(dx, dy)
        guard travel > 1.5 else { return false }

        samples.append((now, dx, dy))
        samples.removeAll { now - $0.time > Self.window }
        reversalTimes.removeAll { now - $0 > Self.window }

        guard let start = sweepStart else {
            sweepStart = previous
            sweepFar = point
            sweepExtent = travel
            return false
        }
        // How far along the sweep's own direction the pointer is now.
        let heading = CGPoint(x: sweepFar.x - start.x, y: sweepFar.y - start.y)
        let length = max(hypot(heading.x, heading.y), 0.001)
        let along = ((point.x - start.x) * heading.x + (point.y - start.y) * heading.y) / length
        if along >= sweepExtent {
            sweepFar = point
            sweepExtent = along
        } else if sweepExtent - along >= flipDeadzone {
            // Turned around. A sweep that covered enough ground counts as one pass of a shake;
            // the next sweep starts at the turning point.
            if sweepExtent >= minSweep { reversalTimes.append(now) }
            sweepStart = sweepFar
            sweepFar = point
            sweepExtent = hypot(point.x - sweepFar.x, point.y - sweepFar.y)
        }
        return evaluate(now: now)
    }

    public mutating func reset() {
        lastPoint = nil
        clearGesture()
    }

    private mutating func evaluate(now: TimeInterval) -> Bool {
        guard now - lastFire > 0.9 else { return false }
        // Three turnarounds: out, back, out again. That is a shake. (Four when it would open the mic.)
        let needed = deliberate ? 4 : 3
        guard reversalTimes.count >= needed, let first = reversalTimes.suffix(needed).first else { return false }
        // The turns come one right after another. Corrections while aiming at a button also
        // double back, but spread over most of a second; a shake is over in a few tenths.
        guard now - first <= burst(for: needed) else { return false }
        var path: CGFloat = 0
        var netX: CGFloat = 0
        var netY: CGFloat = 0
        for sample in samples where sample.time >= first {
            path += hypot(sample.dx, sample.dy)
            netX += sample.dx
            netY += sample.dy
        }
        guard path > minSweep * CGFloat(needed - 1) else { return false }
        // A shake stays put. A trip across the screen does not.
        guard path > 0, hypot(netX, netY) / path < 0.8 else { return false }
        // And it's brisk. Slow wandering that happens to double back is just pointing.
        guard path / CGFloat(max(now - first, 0.05)) >= minSpeed else { return false }

        lastFire = now
        clearGesture()
        return true
    }

    private var tuned: CGFloat { CGFloat(min(1, max(0, sensitivity))) }
    /// Each pass is a real sweep, not a twitch: 44pt at the default setting, more when deliberate.
    private var minSweep: CGFloat { (60 - tuned * 24) * (deliberate ? 1.2 : 1) }
    /// How far back the pointer has to come before the sweep counts as turned.
    private var flipDeadzone: CGFloat { 8 - tuned * 3 }
    /// Points per second across the turns.
    private var minSpeed: CGFloat { 240 - tuned * 80 }
    /// How long the needed turns may take, all together.
    private func burst(for turns: Int) -> TimeInterval { 0.2 * Double(turns) + 0.1 }
    private static let window: TimeInterval = 1.0

    private mutating func clearGesture() {
        samples.removeAll()
        reversalTimes.removeAll()
        sweepStart = nil
        sweepFar = .zero
        sweepExtent = 0
    }
}
