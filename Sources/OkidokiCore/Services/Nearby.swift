import Foundation
import Network

/// Enterprise: colleagues on the same network join without typing anything.
///
/// An admin's Mac advertises a live join code over Bonjour (`_okidoki._tcp`, in the TXT record)
/// for as long as its "let nearby Macs join" switch is on. Every other okidoki on the network
/// browses for those records and shows "Join Acme · Jay's MacBook"; joining uses the ordinary
/// code, which expires and has a use limit, so the network is a convenience, not a permission.
/// No connection is ever made — the record is the whole exchange.
@MainActor
public final class NearbyService: ObservableObject {
    public struct Invite: Equatable, Sendable, Identifiable {
        public var id: String { "\(orgID)|\(code)|\(device)" }
        public var orgID: String
        public var orgName: String
        public var code: String
        public var device: String
    }

    public static let serviceType = "_okidoki._tcp"

    @Published public private(set) var invites: [Invite] = []
    @Published public private(set) var advertising: Invite?
    @Published public private(set) var browsing = false
    @Published public private(set) var error: String?

    private var listener: NWListener?
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "okidoki.nearby")

    public init() {}

    // MARK: - Browsing

    public func startBrowsing() {
        guard browser == nil else { return }
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: parameters)
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready: self.browsing = true
                case .failed(let failure):
                    self.browsing = false
                    self.error = "nearby: \(failure.localizedDescription)"
                case .cancelled: self.browsing = false
                default: break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap(Self.invite(from:))
            Task { @MainActor in
                guard let self else { return }
                // Our own record comes back too; it isn't an invitation.
                self.invites = found.filter { $0 != self.advertising }.sorted { $0.orgName < $1.orgName }
            }
        }
        browser.start(queue: queue)
        self.browser = browser
    }

    public func stopBrowsing() {
        browser?.cancel()
        browser = nil
        invites = []
        browsing = false
    }

    nonisolated static func invite(from result: NWBrowser.Result) -> Invite? {
        guard case .bonjour(let record) = result.metadata else { return nil }
        guard let org = record["org"], let code = record["code"], let name = record["name"] else { return nil }
        var device = ""
        if case .service(let serviceName, _, _, _) = result.endpoint { device = serviceName }
        return Self.parse(org: org, name: name, code: code, device: device)
    }

    /// Records are small, plain strings; anything that isn't shaped like ours is ignored.
    nonisolated public static func parse(org: String, name: String, code: String, device: String) -> Invite? {
        let cleanCode = code.trimmingCharacters(in: .whitespaces).uppercased()
        guard !org.isEmpty, org.count <= 64, !name.isEmpty, name.count <= 120,
              cleanCode.range(of: "^[A-Z0-9]{4,12}$", options: .regularExpression) != nil else { return nil }
        return Invite(orgID: org, orgName: name, code: cleanCode, device: device.isEmpty ? "a Mac" : String(device.prefix(60)))
    }

    // MARK: - Advertising

    public func advertise(orgID: String, orgName: String, code: String, device: String) {
        guard let invite = Self.parse(org: orgID, name: orgName, code: code, device: device) else { return }
        stopAdvertising()
        do {
            let parameters = NWParameters.tcp
            parameters.includePeerToPeer = true
            let listener = try NWListener(using: parameters)
            var txt = NWTXTRecord()
            txt["org"] = invite.orgID
            txt["name"] = invite.orgName
            txt["code"] = invite.code
            listener.service = NWListener.Service(name: invite.device, type: Self.serviceType, txtRecord: txt)
            // Nothing is served; a connection that shows up is simply dropped.
            listener.newConnectionHandler = { connection in connection.cancel() }
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    if case .failed(let failure) = state {
                        self.error = "nearby: \(failure.localizedDescription)"
                        self.advertising = nil
                    }
                }
            }
            listener.start(queue: queue)
            self.listener = listener
            advertising = invite
            error = nil
        } catch {
            self.error = "nearby: \(error.localizedDescription)"
        }
    }

    public func stopAdvertising() {
        listener?.cancel()
        listener = nil
        advertising = nil
    }
}
