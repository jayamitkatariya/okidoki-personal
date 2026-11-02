import AppKit
import Foundation
import OkidokiCore
import UniformTypeIdentifiers

/// Where "import passwords" stands, for the Vault page and onboarding. Counts and names only.
struct VaultImportStatus: Encodable, Equatable {
    /// Browsers found on this Mac, with their profiles and login counts.
    var sources: [DetectedBrowser] = []
    /// The browsers have been looked for at least once.
    var scanned = false
    var scanning = false
    /// The browser id being imported, or "csv"; nil when idle.
    var busy: String?
    var last: VaultImportReport?
    /// The name of a CSV that was imported and still sits on disk with passwords in the clear.
    var csvToTrash: String?
}

/// Bringing saved passwords into the vault from other browsers or a CSV export. Each password is
/// sealed with the vault passphrase the moment it's read; nothing in the clear is written or logged.
extension AppEnvironment {
    /// Looks for browsers again (off the main thread): their folders, profiles and how many logins each has.
    func refreshVaultImportSources() {
        guard !vaultImport.scanning else { return }
        vaultImport.scanning = true
        Task.detached(priority: .userInitiated) {
            let found = BrowserPasswordImport.detect()
            await MainActor.run { [weak self] in
                self?.vaultImport.sources = found
                self?.vaultImport.scanned = true
                self?.vaultImport.scanning = false
            }
        }
    }

    /// The passphrase to seal with: the one the person just typed, else the one remembered on this Mac.
    private func importPassphrase(_ typed: String?) -> String? {
        if let typed, !typed.isEmpty { return typed }
        if let remembered = KeyStore.get(LocalVault.passphraseKey), !remembered.isEmpty { return remembered }
        return nil
    }

    private func vaultImportFailed(_ source: String, _ reason: String) {
        vaultImport.busy = nil
        vaultImport.last = VaultImportReport(source: source, errors: [reason])
        toast(title: "couldn't import from \(source)", detail: reason, kind: .warning,
              undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
    }

    /// Reads every profile of a browser (macOS asks before handing over its Keychain key) and seals what it finds.
    func importBrowserPasswords(id: String, passphrase typed: String?) {
        guard vaultImport.busy == nil, let browser = BrowserPasswordImport.browser(id: id) else { return }
        guard let passphrase = importPassphrase(typed) else {
            vaultImportFailed(browser.name, "Unlock the vault first, so the passwords can be sealed with your passphrase.")
            return
        }
        vaultImport.busy = id
        let existing = vault.logins
        let salt = vault.salt
        Task.detached(priority: .userInitiated) {
            let outcome = Self.sealImport(source: browser.name, passphrase: passphrase, salt: salt, existing: existing) {
                let read = try BrowserPasswordImport.read(browser)
                return (read.logins, read.skipped, read.errors)
            }
            await MainActor.run { [weak self] in self?.finishVaultImport(outcome) }
        }
    }

    /// Asks for a CSV export and imports it. Afterwards the CSV can go to the Trash: it's plaintext.
    func importPasswordCSV(passphrase typed: String?) {
        guard vaultImport.busy == nil else { return }
        guard let passphrase = importPassphrase(typed) else {
            vaultImportFailed("a CSV file", "Unlock the vault first, so the passwords can be sealed with your passphrase.")
            return
        }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.allowsOtherFileTypes = true
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "Import"
        panel.message = "Pick the passwords CSV you exported from Safari, Passwords, Chrome, Firefox, 1Password or Bitwarden."
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        vaultImport.busy = "csv"
        let existing = vault.logins
        let salt = vault.salt
        Task.detached(priority: .userInitiated) {
            let outcome = Self.sealImport(source: url.lastPathComponent, passphrase: passphrase, salt: salt, existing: existing) {
                let data = try Data(contentsOf: url)
                guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else {
                    throw BrowserPasswordImport.Failure("couldn't read that file as text")
                }
                let parsed = try BrowserPasswordImport.parseCSV(text)
                return (parsed.logins, parsed.skipped, [])
            }
            await MainActor.run { [weak self] in
                guard let self else { return }
                if outcome.report.imported + outcome.report.updated + outcome.report.skipped > 0 {
                    self.vaultImportCSV = url
                    self.vaultImport.csvToTrash = url.lastPathComponent
                }
                self.finishVaultImport(outcome)
            }
        }
    }

    /// Moves the imported CSV to the Trash, or forgets about it.
    func finishVaultImportCSV(trash: Bool) {
        defer { vaultImportCSV = nil; vaultImport.csvToTrash = nil }
        guard trash, let url = vaultImportCSV else { return }
        do {
            try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            toast(title: "CSV in the Trash", detail: "Empty the Trash to get rid of it for good.", kind: .success,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
        } catch {
            toast(title: "couldn't move the CSV", detail: error.localizedDescription, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: "show", onEdit: { NSWorkspace.shared.activateFileViewerSelecting([url]) }, runID: nil)
        }
    }

    private struct ImportOutcome: Sendable {
        var report: VaultImportReport
        var save: [VaultLogin]
    }

    /// Reads, checks the passphrase against the vault, and seals. Runs off the main thread: the key takes
    /// a moment to derive and the Keychain may be waiting on the person.
    nonisolated private static func sealImport(source: String, passphrase: String, salt: String, existing: [VaultLogin],
                                               read: () throws -> ([ImportedLogin], Int, [String])) -> ImportOutcome {
        guard let key = VaultCrypto.key(passphrase: passphrase, vaultID: salt) else {
            return ImportOutcome(report: VaultImportReport(source: source, errors: ["couldn't derive the vault key"]), save: [])
        }
        guard BrowserPasswordImport.keyOpensVault(key, logins: existing) else {
            return ImportOutcome(report: VaultImportReport(source: source, errors: ["That isn't the passphrase your vault logins are sealed with."]), save: [])
        }
        do {
            let (logins, unreadable, errors) = try read()
            let merged = BrowserPasswordImport.merge(logins, into: existing, key: key)
            return ImportOutcome(report: VaultImportReport(source: source, imported: merged.imported, updated: merged.updated,
                                                           skipped: merged.skipped + unreadable, errors: errors),
                                 save: merged.save)
        } catch {
            let reason = (error as? BrowserPasswordImport.Failure)?.reason ?? error.localizedDescription
            return ImportOutcome(report: VaultImportReport(source: source, errors: [reason]), save: [])
        }
    }

    private func finishVaultImport(_ outcome: ImportOutcome) {
        vault.saveLogins(outcome.save)
        vaultImport.busy = nil
        vaultImport.last = outcome.report
        let report = outcome.report
        let changed = report.imported + report.updated
        if changed == 0, let error = report.errors.first {
            toast(title: "couldn't import from \(report.source)", detail: error, kind: .warning,
                  undoLabel: nil, onUndo: nil, editLabel: nil, onEdit: nil, runID: nil)
            return
        }
        let trashCSV = vaultImportCSV != nil
        toast(title: changed > 0 ? "\(changed) \(changed == 1 ? "login" : "logins") in the vault" : "nothing new",
              detail: "\(report.source): \(report.summary)" + (report.errors.isEmpty ? "" : " · \(report.errors.count) couldn't be read"),
              kind: changed > 0 ? .success : .info,
              undoLabel: trashCSV ? "trash the CSV" : nil,
              onUndo: trashCSV ? { [weak self] in self?.finishVaultImportCSV(trash: true) } : nil,
              editLabel: "vault", onEdit: { [weak self] in self?.openDashboard(.vault) }, runID: nil)
    }
}
