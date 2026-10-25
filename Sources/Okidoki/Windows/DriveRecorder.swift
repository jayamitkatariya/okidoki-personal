import AppKit
import OkidokiCore

/// Milliseconds since a moment, for step timings.
struct Stopwatch {
    private let start = ContinuousClock.now
    var ms: Int {
        let elapsed = ContinuousClock.now - start
        return Int(elapsed.components.seconds * 1000) + Int(elapsed.components.attoseconds / 1_000_000_000_000_000)
    }
}

/// Collects a driving run's timings and writes them when the run ends (see `DriveTelemetry`).
@MainActor
final class DriveRecorder {
    private(set) var telemetry: DriveTelemetry
    private var saved = false

    init(runID: String, goal: String, protocolVersion: String, model: String) {
        telemetry = DriveTelemetry(runID: runID, goal: goal, protocolVersion: protocolVersion, model: model)
    }

    var callCount: Int { telemetry.calls.count }

    func setProtocol(_ version: String) { telemetry.protocolVersion = version }

    func record(_ call: DriveTelemetry.Call) { telemetry.calls.append(call) }

    func record(_ action: DriveTelemetry.Action) { telemetry.actions.append(action) }

    /// Writes the run once. With scripted testing on, also saves what the screen looks like afterwards
    /// so the harness can check the result independently of what the model claimed.
    func finish(outcome: String, summary: String, screen: NSScreen?) {
        guard !saved else { return }
        saved = true
        telemetry.endedAt = Date()
        telemetry.outcome = outcome
        telemetry.summary = summary
        DriveTelemetryStore.save(telemetry)
        guard ProcessInfo.processInfo.environment["OKIDOKI_DEV_HOOKS"] == "1", let screen else { return }
        let snapshot = telemetry
        Task { @MainActor in
            // Let the last action's effect and okidoki's own windows (excluded from capture) settle.
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let shot = await ComputerUseService.shared.capture(screen: screen) else { return }
            let data = await Task.detached(priority: .utility) {
                ComputerUseService.jpegData(shot.full, maxLongEdge: 1600, quality: 0.85)
            }.value
            guard let data else { return }
            var updated = snapshot
            updated.finalFrame = DriveTelemetryStore.saveFrame(data, runID: snapshot.runID, ext: "jpg")
            DriveTelemetryStore.save(updated)
        }
    }
}
