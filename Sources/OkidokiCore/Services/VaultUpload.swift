import Foundation

/// Puts a file into the organization's vault from the Mac, over the deployment's sync secret: an
/// upload URL from Convex, the bytes straight to file storage, then the vault row.
public enum VaultUpload {
    public struct Saved: Sendable, Equatable {
        public var name: String
        /// Empty for the whole organization.
        public var spaceName: String
        public var replaced: Bool
        public var size: Int
        public var url: URL?
    }

    public struct Failure: LocalizedError, Sendable {
        public var reason: String
        public var errorDescription: String? { reason }
        public init(_ reason: String) { self.reason = reason }
    }

    public static func upload(data: Data, name: String, mime: String, space: String, accountID: String,
                              siteURL: String, secret: String, session: URLSession = .shared) async throws -> Saved {
        let base = siteURL.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !base.isEmpty, !secret.isEmpty else { throw Failure("turn on sync in Settings first") }
        guard data.count <= 50 * 1024 * 1024 else { throw Failure("files up to 50 MB only") }

        let ticket = try await post(base + "/api/vault/upload-url", ["accountId": accountID], secret: secret, session: session)
        guard ticket["ok"] as? Bool == true, let raw = ticket["url"] as? String, let uploadURL = URL(string: raw) else {
            throw Failure(ticket["reason"] as? String ?? "the vault didn't accept the upload")
        }
        var put = URLRequest(url: uploadURL)
        put.httpMethod = "POST"
        put.timeoutInterval = 60
        put.setValue(mime, forHTTPHeaderField: "content-type")
        let (stored, response) = try await session.upload(for: put, from: data)
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true,
              let body = try? JSONSerialization.jsonObject(with: stored) as? [String: Any],
              let storageID = body["storageId"] as? String else { throw Failure("the upload didn't go through") }

        let saved = try await post(base + "/api/vault/save",
                                   ["accountId": accountID, "storageId": storageID, "name": name, "mime": mime, "space": space],
                                   secret: secret, session: session)
        guard saved["ok"] as? Bool == true else { throw Failure(saved["reason"] as? String ?? saved["error"] as? String ?? "the vault didn't keep it") }
        return Saved(name: name, spaceName: saved["spaceName"] as? String ?? "", replaced: saved["replaced"] as? Bool ?? false,
                     size: saved["size"] as? Int ?? data.count, url: (saved["url"] as? String).flatMap(URL.init(string:)))
    }

    private static func post(_ url: String, _ body: [String: Any], secret: String, session: URLSession) async throws -> [String: Any] {
        guard let endpoint = URL(string: url) else { throw Failure("the sync address isn't valid") }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw Failure("the sync secret was rejected") }
        if status == 404 { throw Failure("this deployment can't take files from the Mac yet") }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure("the vault answered HTTP \(status)") }
        return json
    }

    /// True for bytes that start like a PDF: a "download" that's really an error page shouldn't be filed.
    public static func looksLikePDF(_ data: Data) -> Bool {
        data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil
    }
}
