import Foundation

/// Where okidoki keeps everything on this Mac. One folder, `~/Library/Application Support/Okidoki`,
/// so this build never reads or writes another okidoki's data. `OKIDOKI_SUPPORT_DIR` moves it (tests, a second profile).
public enum AppPaths {
    public static let folderName = "Okidoki"
    /// The folder 0.9.1 used, before okidoki dropped the "Personal" split. A first launch adopts its
    /// data once, by copy, so the older app keeps working until it's replaced.
    static let legacyFolderName = "Okidoki Personal"

    public static var support: URL {
        if let override = ProcessInfo.processInfo.environment["OKIDOKI_SUPPORT_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        }
        adoptLegacyDataIfNeeded
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent(folderName, isDirectory: true)
    }

    /// A file or folder inside the support folder.
    public static func support(_ path: String, isDirectory: Bool = false) -> URL {
        support.appendingPathComponent(path, isDirectory: isDirectory)
    }

    /// Once per run (static-initializer `let`): if the new folder doesn't exist yet and 0.9.1's does,
    /// copy it across — state, keys, skills, everything. Copy, never move, so the older app isn't
    /// broken mid-upgrade; and it only runs while the new folder has never appeared.
    static let adoptLegacyDataIfNeeded: Void = {
        let files = FileManager.default
        guard let base = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let folder = base.appendingPathComponent(folderName, isDirectory: true)
        let legacy = base.appendingPathComponent(legacyFolderName, isDirectory: true)
        guard !files.fileExists(atPath: folder.path),
              files.fileExists(atPath: legacy.path) else { return }
        try? files.copyItem(at: legacy, to: folder)
    }()
}
