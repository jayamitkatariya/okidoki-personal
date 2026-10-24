import Foundation
import AppKit

public struct ShellResult: Sendable {
    public var code: Int32
    public var output: String
    public init(code: Int32, output: String) { self.code = code; self.output = output }
    public var ok: Bool { code == 0 }
}

public enum CommandRisk {
    public static func classify(_ command: String) -> RiskLevel {
        let c = command.lowercased()
        let veryDangerous = ["rm -rf /", "sudo rm", "mkfs", "dd if=", "diskutil erase", ":(){", "chmod -r 777 /", "> /dev/disk"]
        if veryDangerous.contains(where: { c.contains($0) }) { return .high }
        let high = ["rm -", "sudo ", "killall", "pkill", "mv ", "chmod ", "chown ", "launchctl", "defaults delete", "git reset --hard", "git clean -f", "brew uninstall", "osascript", "security "]
        if high.contains(where: { c.contains($0) }) { return .high }
        let medium = ["brew install", "brew upgrade", "curl ", "wget ", "pip install", "npm install -g", "ffmpeg", "pandoc", "ocrmypdf", "magick", "rclone", "ollama", "git clone", "npm run", "bun ", "yarn "]
        if medium.contains(where: { c.contains($0) }) { return .medium }
        return .low
    }

    public static func isBlocked(_ command: String) -> Bool {
        let c = command.lowercased()
        return c.contains("sudo rm -rf") || c.contains("rm -rf /") || c.contains("mkfs") || c.contains("diskutil erase")
    }
}

public final class ShellRunner: @unchecked Sendable {
    public static let shared = ShellRunner()
    private let lock = NSLock()
    private var processes: [String: Process] = [:]

    public var pathEnvironment: String {
        let home = NSHomeDirectory()
        return [
            "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.opencode/bin",
            "\(home)/.bun/bin", "\(home)/.cargo/bin", "\(home)/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"
        ].joined(separator: ":")
    }

    @discardableResult
    public func stream(id: String = UUID().uuidString, command: String, cwd: String? = nil,
                       onOutput: @escaping @Sendable (String) -> Void,
                       completion: @escaping @Sendable (Int32) -> Void) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = URL(fileURLWithPath: cwd ?? NSHomeDirectory())
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = pathEnvironment + ":" + (env["PATH"] ?? "")
        env["TERM"] = "dumb"
        env["NO_COLOR"] = "1"
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice

        lock.lock()
        processes[id] = process
        lock.unlock()

        let handle = pipe.fileHandleForReading
        handle.readabilityHandler = { file in
            let data = file.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            onOutput(text)
        }

        process.terminationHandler = { [weak self] proc in
            handle.readabilityHandler = nil
            let rest = handle.readDataToEndOfFile()
            if !rest.isEmpty, let text = String(data: rest, encoding: .utf8) { onOutput(text) }
            self?.lock.lock()
            self?.processes.removeValue(forKey: id)
            self?.lock.unlock()
            completion(proc.terminationStatus)
        }

        do {
            try process.run()
        } catch {
            onOutput("couldn't start: \(error.localizedDescription)\n")
            completion(127)
        }
        return id
    }

    public func run(command: String, cwd: String? = nil) async -> ShellResult {
        await withCheckedContinuation { continuation in
            let box = OutputBox()
            stream(command: command, cwd: cwd, onOutput: { text in box.append(text) }) { code in
                continuation.resume(returning: ShellResult(code: code, output: box.value))
            }
        }
    }

    public func cancel(id: String) {
        lock.lock()
        let process = processes[id]
        lock.unlock()
        process?.terminate()
    }

    public func pause(id: String) {
        lock.lock()
        let pid = processes[id]?.processIdentifier
        lock.unlock()
        if let pid { kill(pid, SIGSTOP) }
    }

    public func resume(id: String) {
        lock.lock()
        let pid = processes[id]?.processIdentifier
        lock.unlock()
        if let pid { kill(pid, SIGCONT) }
    }

    public func cancelAll() {
        lock.lock()
        let all = processes.values
        processes.removeAll()
        lock.unlock()
        all.forEach { $0.terminate() }
    }

    public static func which(_ binary: String) -> String? {
        let paths = [
            "/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.local/bin",
            "\(NSHomeDirectory())/.opencode/bin", "\(NSHomeDirectory())/.bun/bin",
            "\(NSHomeDirectory())/.cargo/bin", "\(NSHomeDirectory())/bin", "/usr/bin", "/bin"
        ]
        for dir in paths {
            let path = dir + "/" + binary
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    public static func toolInstalled(_ tool: ToolSpec) -> Bool {
        let candidates = tool.checkCommand.split(separator: "||").map { $0.trimmingCharacters(in: .whitespaces) }
        return candidates.contains { part in
            let pieces = part.split(separator: " ").map(String.init)
            if pieces.first == "command", pieces.count > 2, pieces[1] == "-v" {
                return which(pieces[2]) != nil
            }
            return which(tool.command) != nil
        }
    }
}

private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func append(_ value: String) { lock.lock(); text += value; lock.unlock() }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

public enum Bytes {
    public static func human(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowedUnits = [.useGB, .useMB, .useKB]
        formatter.includesUnit = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: bytes)
    }

    public static func human(_ bytes: Double) -> String { human(Int64(bytes)) }
}

public struct DiskSnapshot: Sendable {
    public var total: Int64
    public var free: Int64
    public var used: Int64
    public var usedFraction: Double
    public init(total: Int64, free: Int64) {
        self.total = total
        self.free = free
        self.used = max(0, total - free)
        self.usedFraction = total > 0 ? Double(total - free) / Double(total) : 0
    }
}

public enum DiskInspector {
    public static func snapshot() -> DiskSnapshot? {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        guard let values = try? url.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey]),
              let total = values.volumeTotalCapacity,
              let free = values.volumeAvailableCapacityForImportantUsage else { return nil }
        return DiskSnapshot(total: Int64(total), free: Int64(free))
    }

    public static func cacheBreakdown() async -> [(String, Int64)] {
        let home = NSHomeDirectory()
        let targets = ["Library/Caches", "Library/Logs", ".Trash", "Library/Developer/Xcode/DerivedData", "Library/Developer/CoreSimulator/Caches"]
        var output: [(String, Int64)] = []
        for target in targets {
            let path = home + "/" + target
            if !FileManager.default.fileExists(atPath: path) { continue }
            let result = await ShellRunner.shared.run(command: "du -sk \(shellQuote(path)) 2>/dev/null | awk '{print $1}'")
            if let kb = Int64(result.output.trimmingCharacters(in: .whitespacesAndNewlines)), kb > 0 {
                output.append((target, kb * 1024))
            }
        }
        return output.sorted { $0.1 > $1.1 }
    }
}

public func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
