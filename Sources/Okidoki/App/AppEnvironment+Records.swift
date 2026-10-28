import Foundation
import OkidokiCore

extension AppEnvironment {
    /// One record of a replay is through: "done" goes into the run's output and the chat.
    func replayPassFinished(runID: String, ref: String, pass: Int, of passes: Int) {
        let line = "\(ref) done"
        store.updateRun(runID) { run in
            run.output += (run.output.isEmpty ? "" : "\n") + line
            run.summary = passes > 1 ? "\(pass) of \(passes) · \(line)" : line
        }
        if let threadID = store.run(runID)?.threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: line, runID: runID)
        }
    }
}
