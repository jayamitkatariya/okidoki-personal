import Foundation

extension AgentRun {
    /// A new app process cannot resume an old shell, stream, or in-memory connector approval.
    public func recoveredAfterRestart(at date: Date = Date()) -> AgentRun {
        let lostConnector = kind == .connector && (status == .waiting || status == .previewing)
        guard status == .running || status == .paused || lostConnector else { return self }
        var run = self
        run.status = .failed
        run.endedAt = date
        run.summary = lostConnector
            ? "This connector plan expired when Okidoki restarted. Ask again to prepare a new one."
            : "Okidoki restarted before this job reported a result. Check what changed before retrying."
        for index in run.steps.indices where run.steps[index].status == .running || run.steps[index].status == .paused {
            run.steps[index].status = .failed
            run.steps[index].endedAt = date
        }
        return run
    }
}
