import Foundation

/// Where okidoki keeps everything on this Mac. One folder, `~/Library/Application Support/Okidoki`,
/// so this build never reads or writes another okidoki's data. `OKIDOKI_SUPPORT_DIR` moves it (tests, a second profile).
public enum AppPaths {
    public static let folderName = "Okidoki"
    /// The folder 0.9.1 used, before okidoki dropped the "Personal" split. A first launch adopts its
    /// data once, so an upgrading Mac keeps its skills, memory and keys.
    static let legacyFolderName = "Okidoki Personal"
    /// Written after the one-time adoption, so it never runs again over the app's own data.
    static let adoptedMarker = "adopted-from-personal"

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

    /// Once per Mac (static-initializer `let` in the process, a marker file across launches): adopt a
    /// 0.9.1 "Okidoki Personal" installation. The Personal installation is this product's line, so on
    /// every name it has its file wins — which also covers a Mac where a pre-rename app left an older
    /// "Okidoki" folder: state and keys come from Personal, and anything only the older folder knew
    /// (its own caches, exports) simply stays. The state.json about to be replaced is kept beside,
    /// once, as state.pre-rename.json. Nothing is ever deleted from either side.
    static let adoptLegacyDataIfNeeded: Void = {
        let files = FileManager.default
        guard let base = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let folder = base.appendingPathComponent(folderName, isDirectory: true)
        let legacy = base.appendingPathComponent(legacyFolderName, isDirectory: true)
        let marker = folder.appendingPathComponent(adoptedMarker)
        guard files.fileExists(atPath: legacy.path),
              !files.fileExists(atPath: marker.path) else { return }

        if files.fileExists(atPath: folder.appendingPathComponent("state.json").path),
           !files.fileExists(atPath: folder.appendingPathComponent("state.pre-rename.json").path) {
            try? files.copyItem(at: folder.appendingPathComponent("state.json"),
                                to: folder.appendingPathComponent("state.pre-rename.json"))
        }
        if let names = try? files.contentsOfDirectory(atPath: legacy.path) {
            for name in names {
                copyItemOverwriting(from: legacy.appendingPathComponent(name), to: folder.appendingPathComponent(name))
            }
        }
        files.createFile(atPath: marker.path, contents: Data("0.9.2 adopted this from Okidoki Personal".utf8))
    }()

    /// Copies one item over its destination: files replace, folders merge item by item (source wins).
    private static func copyItemOverwriting(from: URL, to: URL) {
        let files = FileManager.default
        var isDirectory: ObjCBool = false
        guard files.fileExists(atPath: from.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue {
            try? files.createDirectory(at: to, withIntermediateDirectories: true)
            if let inner = try? files.contentsOfDirectory(atPath: from.path) {
                for item in inner {
                    copyItemOverwriting(from: from.appendingPathComponent(item), to: to.appendingPathComponent(item))
                }
            }
        } else {
            try? files.removeItem(at: to)
            try? files.copyItem(at: from, to: to)
        }
    }
}
