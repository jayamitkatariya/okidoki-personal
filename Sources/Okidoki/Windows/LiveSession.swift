import Foundation
import WebKit

// MARK: - Steps

/// One step of a driving run as the Live page shows it.
struct LiveStep: Codable, Equatable, Identifiable {
    var index: Int
    var say: String
    var kind: String
    var detail: String
    var result: String
    /// `okidoki-live://frame/<id>` for what the model saw before this step, if a screenshot existed.
    var frame: String?
    /// Where the model aimed, 0–1 in the frame, for pointer steps.
    var aimX: Double?
    var aimY: Double?
    /// The zoom crop this step produced, when it was a zoom.
    var zoomFrame: String?
    var script: String?
    var status: String
    var at: Date

    var id: Int { index }
}

/// What the dashboard gets about driving: the current (or last) run and its steps.
struct DashboardLivePayload: Encodable {
    var active: Bool
    var runID: String?
    var target: String
    var goal: String
    var stepIndex: Int
    var steps: [LiveStep]
}

// MARK: - Frames

/// Screenshots the Live page can load by URL. Kept in memory with a cap, newest kept.
@MainActor
final class LiveFrames {
    static let shared = LiveFrames()
    static let scheme = "okidoki-live"
    static let limit = 60

    private var frames: [String: Data] = [:]
    private var order: [String] = []

    func put(_ data: Data, id: String) -> String {
        if frames[id] == nil { order.append(id) }
        frames[id] = data
        while order.count > Self.limit, let oldest = order.first {
            order.removeFirst()
            frames[oldest] = nil
        }
        return "\(Self.scheme)://frame/\(id)"
    }

    func data(for id: String) -> Data? { frames[id] }

    func clear() {
        frames.removeAll()
        order.removeAll()
    }
}

/// Serves `okidoki-live://frame/<id>` to the dashboard web view.
final class LiveFrameSchemeHandler: NSObject, WKURLSchemeHandler {
    /// Tasks WebKit has stopped. Answering one of these raises an exception.
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url
        let id = url?.lastPathComponent ?? ""
        let key = ObjectIdentifier(task)
        Task { @MainActor in
            guard !self.stopped.contains(key) else { self.stopped.remove(key); return }
            guard let url, let data = LiveFrames.shared.data(for: id) else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            let jpeg = data.count > 2 && data[data.startIndex] == 0xFF && data[data.startIndex + 1] == 0xD8
            let response = URLResponse(url: url, mimeType: jpeg ? "image/jpeg" : "image/png", expectedContentLength: data.count, textEncodingName: nil)
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        if stopped.count > 200 { stopped.removeAll() }
        stopped.insert(ObjectIdentifier(task))
    }
}
