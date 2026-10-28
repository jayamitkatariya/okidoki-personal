import Foundation

/// Sizing and layout for okidoki's private Mac: the macOS virtual machine computer-use runs
/// can drive instead of the user's own desktop. Pure numbers, so the app target can build the
/// Virtualization configuration from them and tests can pin them down.
public enum PrivateMacSpec {
    public static let folderName = "PrivateMac"

    /// A Retina display the model reads comfortably: 1440×900 points at 2×.
    public static let displayWidthPixels = 2880
    public static let displayHeightPixels = 1800
    public static let displayPixelsPerInch = 220

    public static var displayPointWidth: Double { Double(displayWidthPixels) / 2 }
    public static var displayPointHeight: Double { Double(displayHeightPixels) / 2 }

    /// Sparse: only what macOS and the user's apps actually write takes space.
    public static let diskBytes: UInt64 = 64 * 1024 * 1024 * 1024

    /// macOS restore images are around 15 GB; this is the warning shown before the download.
    public static let approximateDownloadBytes: UInt64 = 15 * 1000 * 1000 * 1000

    /// Leave the host at least two cores. Four is plenty for a desktop the model drives.
    public static func cpuCount(host: Int, minimum: Int, maximum: Int) -> Int {
        let wanted = min(4, max(host - 2, 1))
        return min(max(wanted, minimum), max(minimum, maximum))
    }

    /// Half the host's memory, between 4 and 8 GB, inside what the hypervisor allows.
    public static func memoryBytes(host: UInt64, minimum: UInt64, maximum: UInt64) -> UInt64 {
        let gib: UInt64 = 1024 * 1024 * 1024
        let half = host / 2
        let wanted = min(max(half, 4 * gib), 8 * gib)
        let clamped = min(max(wanted, minimum), max(minimum, maximum))
        // The hypervisor wants a multiple of 1 MiB.
        return clamped - clamped % (1024 * 1024)
    }

    /// The folder every VM file lives in: restore image, disk, auxiliary storage, identity.
    public static var directory: URL {
        AppPaths.support(folderName, isDirectory: true)
    }

    public static var restoreImageURL: URL { directory.appendingPathComponent("RestoreImage.ipsw") }
    public static var diskImageURL: URL { directory.appendingPathComponent("Disk.img") }
    public static var auxiliaryStorageURL: URL { directory.appendingPathComponent("AuxiliaryStorage") }
    public static var hardwareModelURL: URL { directory.appendingPathComponent("HardwareModel") }
    public static var machineIdentifierURL: URL { directory.appendingPathComponent("MachineIdentifier") }
    /// Written once macOS finished installing, so a half-done install is told apart from a usable VM.
    public static var installedMarkerURL: URL { directory.appendingPathComponent("installed") }

    /// Bytes actually used by the folder. Sparse files report their allocated size, not their nominal one.
    public static func bytesOnDisk() -> Int64 {
        guard let items = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.totalFileAllocatedSizeKey]) else { return 0 }
        return items.reduce(Int64(0)) { sum, url in
            let values = try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey])
            return sum + Int64(values?.totalFileAllocatedSize ?? 0)
        }
    }

    public static func format(bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
