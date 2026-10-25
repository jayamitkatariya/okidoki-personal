import XCTest
@testable import OkidokiCore

/// Synthetic pointer motion, sampled at 120 Hz like a real mouse, through the shake recogniser.
final class ShakeGestureTests: XCTestCase {
    private let rate: TimeInterval = 1.0 / 120

    /// Runs a path (time → point) through a gesture and counts how many times it fires.
    private func fires(_ gesture: ShakeGesture, seconds: TimeInterval, _ path: (TimeInterval) -> CGPoint) -> Int {
        var gesture = gesture
        var count = 0
        var t: TimeInterval = 0
        _ = gesture.ingest(path(0), at: 0)
        while t < seconds {
            t += rate
            if gesture.ingest(path(t), at: t) { count += 1 }
        }
        return count
    }

    /// Side-to-side like a hand: `amplitude` points either way at `hz`.
    private func wave(amplitude: CGFloat, hz: Double) -> (TimeInterval) -> CGPoint {
        { t in CGPoint(x: 800 + amplitude * sin(2 * .pi * hz * t), y: 500) }
    }

    func testBriskShakeFires() {
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.7, wave(amplitude: 55, hz: 5)), 1)
    }

    func testLazyShakeStillFires() {
        XCTAssertEqual(fires(ShakeGesture(), seconds: 1.0, wave(amplitude: 40, hz: 3)), 1)
    }

    func testShakeToFindTheCursorFires() {
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.5, wave(amplitude: 80, hz: 6)), 1)
    }

    func testVerticalShakeFires() {
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.7) { t in CGPoint(x: 800, y: 500 + 50 * sin(2 * .pi * 5 * t)) }, 1)
    }

    func testSmallWiggleDoesNotFire() {
        // The slight wiggle that used to open the mic: 20pt either way.
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.9, wave(amplitude: 20, hz: 3)), 0)
    }

    func testTremorDoesNotFire() {
        // A hand resting on the trackpad: a few points of wobble on both axes.
        XCTAssertEqual(fires(ShakeGesture(), seconds: 1.0) { t in
            CGPoint(x: 800 + 6 * sin(2 * .pi * 8 * t), y: 500 + 3 * sin(2 * .pi * 7 * t))
        }, 0)
    }

    func testAimingCorrectionsDoNotFire() {
        // Homing in on a button: overshoot, come back, overshoot a little less.
        var gesture = ShakeGesture()
        var x: CGFloat = 800
        var t: TimeInterval = 0
        var count = 0
        _ = gesture.ingest(CGPoint(x: x, y: 500), at: t)
        for (dx, duration) in [(CGFloat(18), 0.15), (-9, 0.12), (12, 0.14), (-6, 0.1), (4, 0.1), (-3, 0.1)] {
            let steps = Int(duration / rate)
            for _ in 0..<steps {
                x += dx / CGFloat(steps)
                t += rate
                if gesture.ingest(CGPoint(x: x, y: 500), at: t) { count += 1 }
            }
        }
        XCTAssertEqual(count, 0)
    }

    func testSlowWanderDoesNotFire() {
        // Wide, but at a pointing pace, not a shaking one.
        XCTAssertEqual(fires(ShakeGesture(), seconds: 1.5, wave(amplitude: 60, hz: 1.2)), 0)
    }

    func testWobblyTripAcrossTheScreenDoesNotFire() {
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.8) { t in
            CGPoint(x: 300 + 600 * t + 25 * sin(2 * .pi * 5 * t), y: 500 + 10 * sin(2 * .pi * 3 * t))
        }, 0)
    }

    func testDeliberateNeedsMoreThanAModestShake() {
        // Three passes of 45pt is a shake when typing; with the mic on the line it is not quite.
        let modest = wave(amplitude: 24, hz: 4)
        XCTAssertEqual(fires(ShakeGesture(), seconds: 0.6, modest), 1)
        XCTAssertEqual(fires(ShakeGesture(deliberate: true), seconds: 0.6, modest), 0)
        XCTAssertEqual(fires(ShakeGesture(deliberate: true), seconds: 0.8, wave(amplitude: 55, hz: 5)), 1)
    }

    func testFiresOnceThenRestsBeforeFiringAgain() {
        // Two seconds of shaking is one summon, then another, not a shake every few samples.
        XCTAssertEqual(fires(ShakeGesture(), seconds: 2.0, wave(amplitude: 55, hz: 5)), 2)
    }

    func testLowerSensitivityNeedsABiggerShake() {
        let shake = wave(amplitude: 30, hz: 4)
        XCTAssertEqual(fires(ShakeGesture(sensitivity: 1.0), seconds: 0.7, shake), 1)
        XCTAssertEqual(fires(ShakeGesture(sensitivity: 0.0), seconds: 0.7, shake), 0)
    }
}
