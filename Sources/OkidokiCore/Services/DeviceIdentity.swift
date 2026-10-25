import CryptoKit
import Foundation
import IOKit

/// This Mac, as sync tells it apart from the account's other Macs. Derived from the hardware UUID,
/// so it survives reinstalling okidoki (a reinstalled Mac keeps running its own routines), and hashed,
/// so the hardware id itself never leaves the Mac.
public enum DeviceIdentity {
    public static let current: String = {
        if let hardware = platformUUID(), !hardware.isEmpty {
            let digest = SHA256.hash(data: Data("okidoki-device:\(hardware)".utf8))
            return "mac-" + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
        }
        return fallback()
    }()

    private static func platformUUID() -> String? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)
        return value?.takeRetainedValue() as? String
    }

    /// No hardware id (shouldn't happen on a Mac): a random one, remembered in the defaults.
    private static func fallback() -> String {
        let key = "okidoki.deviceID"
        if let saved = UserDefaults.standard.string(forKey: key), !saved.isEmpty { return saved }
        let made = "mac-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24)
        UserDefaults.standard.set(made, forKey: key)
        return made
    }
}
