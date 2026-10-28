import Foundation

/// Where okidoki keeps everything on this Mac. One folder, `~/Library/Application Support/Okidoki Personal`,
/// so this build never reads or writes another okidoki's data. `OKIDOKI_SUPPORT_DIR` moves it (tests, a second profile).
public enum AppPaths {
    public static let folderName = "Okidoki Personal"

    public static var support: URL {
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_SUPPORT_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent(folderName, isDirectory: true)
    }

    /// A file or folder inside the support folder.
    public static func support(_ path: String, isDirectory: Bool = false) -> URL {
        support.appendingPathComponent(path, isDirectory: isDirectory)
    }
}
