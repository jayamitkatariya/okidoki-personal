import Foundation

/// Checks an Anthropic key with one free request (listing models), so a bad key shows up when it's
/// pasted rather than on the first real request.
public enum AnthropicKeyCheck {
    public struct Result: Sendable, Equatable {
        public var ok: Bool
        public var detail: String
    }

    public static func run(key: String, session: URLSession = .shared) async -> Result {
        guard let url = URL(string: "https://api.anthropic.com/v1/models?limit=1") else { return Result(ok: false, detail: "no address") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200..<300: return Result(ok: true, detail: "connected")
            case 401: return Result(ok: false, detail: "Anthropic doesn't recognize it")
            case 403: return Result(ok: false, detail: "it isn't allowed to use the API")
            case 429: return Result(ok: true, detail: "connected, but rate limited right now")
            default: return Result(ok: false, detail: "Anthropic answered HTTP \(status)")
            }
        } catch {
            return Result(ok: false, detail: "couldn't reach Anthropic (\(error.localizedDescription))")
        }
    }
}
