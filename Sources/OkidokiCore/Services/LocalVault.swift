import CoreServices
import Foundation
import UniformTypeIdentifiers

/// A document in the vault folder. `id` is its path relative to the folder.
public struct VaultFile: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    /// The subfolder it's in, relative to the vault folder; empty for the top level.
    public var folder: String
    public var size: Int64
    public var modifiedAt: Date
    public var mime: String

    public init(id: String, name: String, folder: String, size: Int64, modifiedAt: Date, mime: String) {
        self.id = id; self.name = name; self.folder = folder; self.size = size; self.modifiedAt = modifiedAt; self.mime = mime
    }
}

/// A login kept in the vault. The password is sealed in the control panel with the vault
/// passphrase (PBKDF2 + AES-GCM) before it reaches the Mac; only the sealed box is stored.
public struct VaultLogin: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var site: String
    public var username: String
    public var ciphertext: String
    public var iv: String
    public var keyVersion: Int
    public var note: String
    public var createdAt: Date
    public var updatedAt: Date
    public var lastUsedAt: Date?

    public init(id: String = UUID().uuidString, site: String, username: String, ciphertext: String, iv: String,
                keyVersion: Int = 1, note: String = "", createdAt: Date = Date(), updatedAt: Date = Date(), lastUsedAt: Date? = nil) {
        self.id = id; self.site = site; self.username = username; self.ciphertext = ciphertext; self.iv = iv
        self.keyVersion = keyVersion; self.note = note; self.createdAt = createdAt; self.updatedAt = updatedAt; self.lastUsedAt = lastUsedAt
    }
}

/// The vault: a folder on this Mac (the Desktop's "Okidoki Vault" unless moved) plus sealed logins.
///
/// Files are whatever is in the folder — drop them in with Finder, the panel, or "add the W-9 to the
/// vault" — and the list follows the folder as it changes. Logins live in `vault.json` in the support
/// folder, next to a random salt that keys the passphrase to this vault.
@MainActor
public final class LocalVault: ObservableObject {
    public struct Failure: LocalizedError, Sendable {
        public var reason: String
        public var errorDescription: String? { reason }
        public init(_ reason: String) { self.reason = reason }
    }

    /// Where "remember on this Mac" keeps the passphrase: the private key file, never the state file.
    public static let passphraseKey = "vaultPassphrase"

    /// Enough for any sensible documents folder; a home folder picked by mistake stops here.
    public nonisolated static let maxFiles = 5_000
    public nonisolated static let maxDepth = 4
    public static let maxUpload = 200 * 1024 * 1024

    @Published public private(set) var files: [VaultFile] = []
    @Published public private(set) var folders: [String] = []
    @Published public private(set) var logins: [VaultLogin] = []
    /// Whether the folder exists and could be read.
    @Published public private(set) var available = false
    @Published public private(set) var truncated = false
    public private(set) var folderURL: URL
    public private(set) var salt: String

    private let storeURL: URL
    private var stream: FSEventStreamRef?
    private var rescanWork: DispatchWorkItem?
    private var scanGeneration = 0

    private struct Book: Codable {
        var salt: String
        var logins: [VaultLogin]
    }

    public init(folder: URL, storeURL: URL = AppPaths.support("vault.json")) {
        self.folderURL = folder.standardizedFileURL
        self.storeURL = storeURL
        let decoder = ISODates.decoder
        if let data = try? Data(contentsOf: storeURL), let book = try? decoder.decode(Book.self, from: data) {
            salt = book.salt
            logins = book.logins
        } else if FileManager.default.fileExists(atPath: storeURL.path) {
            // Unreadable, not missing: keep it aside instead of overwriting it with an empty vault on the
            // next save, so the sealed logins can still be recovered.
            let aside = storeURL.deletingPathExtension()
                .appendingPathExtension("unreadable-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: storeURL, to: aside)
            salt = UUID().uuidString
            logins = []
        } else {
            salt = UUID().uuidString
            logins = []
        }
    }

    deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    // MARK: Folder

    /// Creates the folder if it's missing, lists it and follows its changes.
    public func start() {
        ensureFolder()
        rescan()
        watch()
    }

    public func setFolder(_ url: URL) {
        let next = url.standardizedFileURL
        guard next != folderURL else { return }
        folderURL = next
        stopWatching()
        start()
    }

    private func ensureFolder() {
        try? FileManager.default.createDirectory(at: folderURL, withIntermediateDirectories: true)
    }

    /// Lists the folder off the main thread; the newest listing wins.
    public func rescan() {
        scanGeneration += 1
        let generation = scanGeneration
        let root = folderURL
        Task.detached(priority: .utility) {
            let listing = Self.list(root)
            await MainActor.run { [weak self] in
                guard let self, generation == self.scanGeneration, root == self.folderURL else { return }
                if self.files != listing.files { self.files = listing.files }
                if self.folders != listing.folders { self.folders = listing.folders }
                self.available = listing.available
                self.truncated = listing.truncated
            }
        }
    }

    nonisolated static func list(_ root: URL) -> (files: [VaultFile], folders: [String], available: Bool, truncated: Bool) {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return ([], [], false, false)
        }
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey, .contentTypeKey]
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
                                                          options: [.skipsHiddenFiles, .skipsPackageDescendants]) else {
            return ([], [], false, false)
        }
        let rootPath = root.standardizedFileURL.path
        var files: [VaultFile] = []
        var folders: [String] = []
        var truncated = false
        for case let url as URL in walker {
            let relative = String(url.standardizedFileURL.path.dropFirst(rootPath.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { continue }
            if values.isDirectory == true, values.isPackage != true {
                if walker.level >= maxDepth { walker.skipDescendants() }
                folders.append(relative)
                continue
            }
            if files.count >= maxFiles {
                truncated = true
                break
            }
            let folder = (relative as NSString).deletingLastPathComponent
            files.append(VaultFile(id: relative, name: url.lastPathComponent, folder: folder,
                                   size: Int64(values.fileSize ?? 0), modifiedAt: values.contentModificationDate ?? Date(),
                                   mime: values.contentType?.preferredMIMEType ?? "application/octet-stream"))
        }
        files.sort { $0.modifiedAt > $1.modifiedAt }
        folders.sort { $0.localizedStandardCompare($1) == .orderedAscending }
        return (files, folders, true, truncated)
    }

    private func watch() {
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let vault = Unmanaged<LocalVault>.fromOpaque(info).takeUnretainedValue()
            Task { @MainActor in vault.scheduleRescan() }
        }
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        guard let stream = FSEventStreamCreate(nil, callback, &context, [folderURL.path] as CFArray,
                                               FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.5,
                                               FSEventStreamCreateFlags(kFSEventStreamCreateFlagNoDefer)) else { return }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
        self.stream = stream
    }

    private func stopWatching() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    private func scheduleRescan() {
        rescanWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rescan() }
        rescanWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    // MARK: Files

    /// The file on disk for a listed id, only when it really is inside the vault folder.
    public func url(for id: String) -> URL? {
        let url = folderURL.appendingPathComponent(id).standardizedFileURL
        guard url.path.hasPrefix(folderURL.path + "/"), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// A subfolder by name, made if it's missing. Names that would leave the vault are refused.
    public func subfolder(_ name: String) throws -> URL {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !cleaned.isEmpty else { return folderURL }
        guard !cleaned.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { throw Failure("that folder name isn't allowed") }
        // A folder that's already there under another capitalization is the same folder.
        let match = folders.first { $0.caseInsensitiveCompare(cleaned) == .orderedSame } ?? cleaned
        let url = folderURL.appendingPathComponent(match, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Writes a file into the vault. A file of the same name in the same place is replaced:
    /// the newer copy of a document is the one to keep.
    @discardableResult
    public func add(data: Data, name: String, folder: String = "") throws -> (url: URL, replaced: Bool) {
        guard data.count <= Self.maxUpload else { throw Failure("files up to \(Self.maxUpload / 1024 / 1024) MB only") }
        ensureFolder()
        let directory = try subfolder(folder)
        let url = directory.appendingPathComponent(Self.safeName(name))
        let replaced = FileManager.default.fileExists(atPath: url.path)
        try data.write(to: url, options: .atomic)
        rescan()
        return (url, replaced)
    }

    /// Copies a file from elsewhere on the Mac into the vault.
    @discardableResult
    public func addCopy(of source: URL, folder: String = "") throws -> (url: URL, replaced: Bool) {
        ensureFolder()
        let directory = try subfolder(folder)
        let url = directory.appendingPathComponent(Self.safeName(source.lastPathComponent))
        let replaced = FileManager.default.fileExists(atPath: url.path)
        if replaced { try FileManager.default.removeItem(at: url) }
        try FileManager.default.copyItem(at: source, to: url)
        rescan()
        return (url, replaced)
    }

    /// Moves a file to the Trash, so a delete from the panel can be undone in Finder.
    public func delete(id: String) throws {
        guard let url = url(for: id) else { throw Failure("that file isn't in the vault any more") }
        try FileManager.default.trashItem(at: url, resultingItemURL: nil)
        rescan()
    }

    /// Files whose name or folder matches every word of the query, best first.
    public func search(_ query: String, limit: Int = 8) -> [VaultFile] {
        // Words as typed ("w-9", "1099-nec"), so short form names still match.
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
            .map { $0.trimmingCharacters(in: .punctuationCharacters) }.filter { !$0.isEmpty }
        guard !words.isEmpty else { return [] }
        let scored = files.compactMap { file -> (VaultFile, Int)? in
            let haystack = (file.folder + " " + file.name).lowercased()
            let hits = words.filter { haystack.contains($0) }.count
            return hits == 0 ? nil : (file, hits)
        }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.modifiedAt > $1.0.modifiedAt }.prefix(limit).map(\.0)
    }

    /// A name that's safe as a file name anywhere.
    public nonisolated static func safeFileName(_ name: String) -> String { safeName(name) }

    nonisolated static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "[/\\\\:*?\"<>|]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return cleaned.isEmpty ? "document" : String(cleaned.prefix(180))
    }

    /// True for bytes that start like a PDF: a "download" that's really an error page shouldn't be filed.
    public nonisolated static func looksLikePDF(_ data: Data) -> Bool {
        data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil
    }

    // MARK: Logins

    public func saveLogin(_ login: VaultLogin) {
        var next = login
        next.updatedAt = Date()
        if let index = logins.firstIndex(where: { $0.id == login.id }) {
            next.createdAt = logins[index].createdAt
            next.lastUsedAt = logins[index].lastUsedAt
            logins[index] = next
        } else {
            logins.insert(next, at: 0)
        }
        persist()
    }

    public func deleteLogin(id: String) {
        logins.removeAll { $0.id == id }
        persist()
    }

    public func touchLogin(id: String) {
        guard let index = logins.firstIndex(where: { $0.id == id }) else { return }
        logins[index].lastUsedAt = Date()
        persist()
    }

    /// Owner-only, written beside the other private files.
    private func persist() {
        let folder = storeURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let data = try? ISODates.encoder.encode(Book(salt: salt, logins: logins)) else { return }
        let temp = folder.appendingPathComponent(".vault-\(UUID().uuidString).json")
        guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        if rename(temp.path, storeURL.path) != 0 { try? FileManager.default.removeItem(at: temp) }
    }
}

extension VaultLogin {
    /// A login as the control panel sends it: the password already sealed, never in the clear.
    public init?(panel raw: [String: Any]) {
        guard let site = (raw["site"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !site.isEmpty,
              let ciphertext = raw["ciphertext"] as? String, !ciphertext.isEmpty,
              let iv = raw["iv"] as? String, !iv.isEmpty else { return nil }
        let id = (raw["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        self.init(id: id, site: site, username: raw["username"] as? String ?? "", ciphertext: ciphertext, iv: iv,
                  keyVersion: raw["keyVersion"] as? Int ?? 1, note: raw["note"] as? String ?? "")
    }
}
