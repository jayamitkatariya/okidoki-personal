import Foundation
import OkidokiCore

/// What the brain reports about a model request, for the run's telemetry.
struct BrainComputerMeta: Decodable {
    var model: String?
    var modelMs: Int?
    var firstActionMs: Int?
    var usage: DriveTelemetry.Usage?
    var stopReason: String?
}

extension BrainClient {
    struct BrainComputerEnvelope: Decodable {
        var action: ComputerAction?
        var usedModel: Bool?
        var error: String?
        var meta: BrainComputerMeta?
    }

    /// The single-action protocol (v1): one screenshot in, one action out.
    func computerTurn(goal: String, step: Int, appName: String, windowTitle: String = "",
                      screen box: OkidokiCore.ScreenBox,
                      imageWidth: Double, imageHeight: Double, history: [[String: Any]],
                      controls: [[String: Any]] = [],
                      scripting: String = "",
                      screenshotPNG: Data?, screenshotMediaType: String = "image/png",
                      previousPNG: Data? = nil, previousMediaType: String = "image/png",
                      referencePNG: Data? = nil,
                      zoom: ComputerUseService.Zoom? = nil,
                      canClick: Bool = true, canSee: Bool = true,
                      remote: Bool = false,
                      model: String) async -> (action: ComputerAction?, meta: BrainComputerMeta?, requestBytes: Int) {
        var body: [String: Any] = [
            "goal": goal,
            "step": step,
            "app": appName,
            "windowTitle": windowTitle,
            "screen": ["x": box.x, "y": box.y, "width": box.width, "height": box.height],
            "imageWidth": imageWidth,
            "imageHeight": imageHeight,
            "history": history,
            "controls": controls,
            "scripting": scripting,
            "canClick": canClick,
            "canSee": canSee,
            "remote": remote,
            "settings": ["claudeModel": model],
        ]
        if let screenshotPNG {
            body["screenshotBase64"] = screenshotPNG.base64EncodedString()
            body["screenshotMediaType"] = screenshotMediaType
        }
        if let previousPNG {
            body["previousScreenshotBase64"] = previousPNG.base64EncodedString()
            body["previousMediaType"] = previousMediaType
        }
        if let referencePNG {
            body["referenceBase64"] = referencePNG.base64EncodedString()
        }
        if let zoom {
            body["zoomBase64"] = zoom.png.base64EncodedString()
            body["zoom"] = ["x": zoom.rect.minX, "y": zoom.rect.minY, "width": zoom.rect.width, "height": zoom.rect.height,
                            "imageWidth": zoom.width, "imageHeight": zoom.height]
        }
        var request = drivingRequest(path: "computer", timeout: 75)
        do {
            let payload = try JSONSerialization.data(withJSONObject: body)
            request.httpBody = payload
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return (nil, nil, payload.count) }
            let envelope = try JSONDecoder().decode(BrainComputerEnvelope.self, from: data)
            return (envelope.action, envelope.meta, payload.count)
        } catch {
            return (nil, nil, 0)
        }
    }

    struct BrainDriveEnvelope: Decodable {
        var actions: [ComputerAction]?
        var meta: BrainComputerMeta?
        var error: String?
        /// "v1" when the chosen model can't use the computer use toolset.
        var fallback: String?
    }

    /// One turn of the v2 protocol: the last batch's results and the screen now in, the next batch out.
    func computerV2(_ body: [String: Any]) async -> (envelope: BrainDriveEnvelope?, requestBytes: Int) {
        var request = drivingRequest(path: "computer/v2", timeout: 70)
        do {
            let payload = try JSONSerialization.data(withJSONObject: body)
            request.httpBody = payload
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return (nil, payload.count) }
            return (try JSONDecoder().decode(BrainDriveEnvelope.self, from: data), payload.count)
        } catch {
            return (nil, 0)
        }
    }

    private struct StreamLine: Decodable {
        var type: String
        var action: ComputerAction?
        var actions: [ComputerAction]?
        var meta: BrainComputerMeta?
        var error: String?
        var fallback: String?
    }

    /// One v2 turn, streamed: `onAction` runs each action the moment it arrives (while the model is still
    /// writing the next) and returns false when the run is over, which stops listening. The end envelope
    /// carries the timings and any actions that weren't streamed (a failure, say).
    func computerV2Stream(_ body: [String: Any], onAction: (ComputerAction) async -> Bool)
        async -> (end: BrainDriveEnvelope?, received: Int, requestBytes: Int, stopped: Bool) {
        var request = drivingRequest(path: "computer/v2/stream", timeout: 70)
        var received = 0
        var size = 0
        do {
            let payload = try JSONSerialization.data(withJSONObject: body)
            size = payload.count
            request.httpBody = payload
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return (nil, 0, size, false) }
            for try await line in bytes.lines {
                guard let data = line.data(using: .utf8), let item = try? JSONDecoder().decode(StreamLine.self, from: data) else { continue }
                if item.type == "action", let action = item.action {
                    received += 1
                    if !(await onAction(action)) {
                        bytes.task.cancel()
                        return (nil, received, size, true)
                    }
                } else if item.type == "end" {
                    return (BrainDriveEnvelope(actions: item.actions, meta: item.meta, error: item.error, fallback: item.fallback), received, size, false)
                }
            }
        } catch {
            return (nil, received, size, false)
        }
        return (nil, received, size, false)
    }

    func drivingRequest(path: String, timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue("Bearer \(BrainConnection.token)", forHTTPHeaderField: "Authorization")
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let key = KeyStore.get("anthropic"), !key.isEmpty {
            request.setValue(key, forHTTPHeaderField: "x-anthropic-key")
        }
        return request
    }
}
