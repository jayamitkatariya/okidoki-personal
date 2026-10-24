import AppKit
import Foundation

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

    func start() {
        stop()
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            let point = NSEvent.mouseLocation
            Task { @MainActor in self?.ingest(point) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            let point = NSEvent.mouseLocation
            Task { @MainActor in self?.ingest(point) }
            return event
        }
        lastPoint = NSEvent.mouseLocation
    }

    func stop() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        globalMonitor = nil
        localMonitor = nil
    }

    private func ingest(_ point: CGPoint) {
        guard isEnabled else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let dx = point.x - lastPoint.x
        let dy = point.y - lastPoint.y
        lastPoint = point
        guard abs(dx) > 0.8 || abs(dy) > 0.8 else { return }
        samples.append((now, dx, dy))
        samples.removeAll { now - $0.time > 0.9 }
        if samples.count > 40 { samples.removeFirst(samples.count - 40) }
        evaluate(now: now)
    }

    private func evaluate(now: TimeInterval) {
        guard Date().timeIntervalSince(lastFire) > 1.1 else { return }
        let recent = samples.filter { now - $0.time < 0.8 }
        guard recent.count >= 5 else { return }

        // Count horizontal direction reversals with real movement between them.
        var reversals = 0
        var lastSign: CGFloat = 0
        var accumulated: CGFloat = 0
        for sample in recent {
            accumulated += abs(sample.dx)
            guard abs(sample.dx) > 1.6 else { continue }
            let sign: CGFloat = sample.dx > 0 ? 1 : -1
            if lastSign != 0, sign != lastSign { reversals += 1 }
            lastSign = sign
        }
        let threshold = 125 - sensitivity * 70
        let needed = sensitivity > 0.8 ? 4 : 3
        if reversals >= needed && accumulated > threshold {
            lastFire = Date()
            samples.removeAll()
            onShake?()
        }
    }

    func reset() {
        samples.removeAll()
        lastPoint = NSEvent.mouseLocation
    }
}
