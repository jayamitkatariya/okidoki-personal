import Foundation
import OkidokiCore

/// What came of one record of a replay, when the page that was filled reports back. The entry
/// workbench the brain serves at /ace does: each transmitted entry is kept with its reference.
struct PortalReceipt: Decodable {
    struct Totals: Decodable {
        var duty: Double
        var fees: Double
        var total: Double
    }
    var entryNumber: String
    var ref: String
    var status: String
    var importer: String?
    var totals: Totals
    var transmittedAt: Date

    var line: String {
        let money: (Double) -> String = { value in
            let formatter = NumberFormatter()
            formatter.numberStyle = .currency
            formatter.currencyCode = "USD"
            formatter.locale = Locale(identifier: "en_US")
            return formatter.string(from: NSNumber(value: value)) ?? String(format: "$%.2f", value)
        }
        return "entry \(entryNumber) \(status.lowercased()) · duty \(money(totals.duty)) · fees \(money(totals.fees))"
    }

    /// The latest entry transmitted for `ref` since `since`. Nil when nothing came back in time.
    static func latest(ref: String, since: Date, base: URL) async -> PortalReceipt? {
        guard var components = URLComponents(url: base.appendingPathComponent("ace/api/entries"), resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = [URLQueryItem(name: "ref", value: ref)]
        guard let url = components.url else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        // The page posts on Transmit; give it a moment to land.
        for attempt in 0..<6 {
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            if let (data, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200,
               let entries = try? decoder.decode([PortalReceipt].self, from: data),
               let hit = entries.first(where: { $0.transmittedAt >= since.addingTimeInterval(-2) }) {
                return hit
            }
            if attempt < 5 { try? await Task.sleep(nanoseconds: 250_000_000) }
        }
        return nil
    }
}

extension AppEnvironment {
    /// One record of a replay is through. Its receipt (or just "done") goes into the run's output and
    /// the chat, which is also what a space sees when the replay ran as one of its jobs. A skill that
    /// files into the workbench must get a receipt back: without one nothing was filed, whatever the
    /// clicks looked like, and the replay stops with that rather than calling it done.
    func replayPassFinished(runID: String, ref: String, pass: Int, of passes: Int, startedAt: Date, expectsReceipt: Bool) async -> String? {
        let receipt = await PortalReceipt.latest(ref: ref, since: startedAt, base: BrainClient.shared.baseURL)
        if receipt == nil, expectsReceipt {
            store.updateRun(runID) { run in run.output += (run.output.isEmpty ? "" : "\n") + "\(ref) → nothing reached the workbench" }
            return "the Entry Workbench never received \(ref) — something got in the way in Safari; run it again"
        }
        let line = receipt.map { "\(ref) → \($0.line)" } ?? "\(ref) done"
        store.updateRun(runID) { run in
            run.output += (run.output.isEmpty ? "" : "\n") + line
            run.summary = passes > 1 ? "\(pass) of \(passes) · \(line)" : line
        }
        if let threadID = store.run(runID)?.threadID {
            store.appendMessage(threadID: threadID, role: .assistant, text: line, runID: runID)
        }
        return nil
    }
}
