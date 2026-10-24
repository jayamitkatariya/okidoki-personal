import Foundation
import AppKit

public struct ShellResult: Sendable {
    public var code: Int32
    public var output: String
    public init(code: Int32, output: String) { self.code = code; self.output = output }
}

public enum CommandRisk {
    public static func classify(_ command: String) -> RiskLevel {
        let c = command.lowercased()
        let veryDangerous = ["rm -rf /", "sudo rm", "mkfs", "dd if=", "diskutil erase", ":(){", "chmod -r 777 /", "> /dev/disk"]
        if veryDangerous.contains(where: { c.contains($0) }) { return .high }
        // `sudo -v` only caches the password for a tool that needs it (Mole's system caches).
        let withoutCredentialCheck = c.replacingOccurrences(of: #"(^|[;&|\n]\s*)sudo -v(\s|$)"#, with: "$1", options: .regularExpression)
        if withoutCredentialCheck != c { return classify(withoutCredentialCheck) == .high ? .high : .medium }
        let high = ["rm -", "sudo ", "killall", "pkill", "mv ", "chmod ", "chown ", "launchctl", "defaults delete", "git reset --hard", "git clean -f", "brew uninstall", "osascript", "security "]
        if high.contains(where: { c.contains($0) }) { return .high }
        let medium = ["npm install", "pip3 install", "uv ", "mkdir ", "touch ", "ditto ", "git ", "brew install", "brew upgrade", "curl ", "wget ", "pip install", "npm install -g", "ffmpeg", "pandoc", "ocrmypdf", "magick", "rclone", "ollama", "git clone", "npm run", "bun ", "yarn "]
        if medium.contains(where: { c.contains($0) }) { return .medium }
        return .low
    }

    public static func isBlocked(_ command: String) -> Bool {
        let patterns = [#"\brm\s+(?:-[\w]+\s+)*["']?/(?:["']?\s|$)"#,
                        #"\bsudo\s+rm\b"#, #"\bmkfs\b"#, #"\bdiskutil\s+erase"#,
                        #"\bdd\s+.*of=["']?/dev/"#, #">\s*["']?/dev/disk"#, #":\s*\(\s*\)\s*\{"#]
        return patterns.contains { command.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
    }
}

public final class ShellRunner: @unchecked Sendable {
    public static let shared = ShellRunner()
    private let lock = NSLock()
    /// Process ids of running jobs. Each job leads its own process group, so signals
    /// reach the shell and everything it started. An entry is removed once the job is reaped.
    private var jobs: [String: pid_t] = [:]

    public static let searchPaths: [String] = {
        let home = NSHomeDirectory()
        return [
            "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.opencode/bin",
            "\(home)/.hermes/bin", "\(home)/.bun/bin", "\(home)/.cargo/bin", "\(home)/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
    }()

    public var pathEnvironment: String { Self.searchPaths.joined(separator: ":") }

    /// Environment for every job: tools on the path, no interactive prompts, and a native
    /// password dialog for the few steps that need administrator access.
    public func jobEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = pathEnvironment + ":" + (env["PATH"] ?? "")
        env["TERM"] = "dumb"
        env["NO_COLOR"] = "1"
        env["NONINTERACTIVE"] = "1"
        env["CI"] = "1"
        env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
        env["HOMEBREW_NO_ENV_HINTS"] = "1"
        env["HOMEBREW_NO_INSTALL_CLEANUP"] = "1"
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
        if let askpass = AskPass.path {
            env["SUDO_ASKPASS"] = askpass
            // sudo only falls back to the helper when it believes a display exists.
            if env["DISPLAY"] == nil { env["DISPLAY"] = ":0" }
        }
        return env
    }

    @discardableResult
    public func stream(id: String = UUID().uuidString, command: String, cwd: String? = nil,
                       onOutput: @escaping @Sendable (String) -> Void,
                       completion: @escaping @Sendable (Int32) -> Void) -> String {
        let directory = cwd ?? NSHomeDirectory()
        let pid: pid_t
        let readEnd: Int32
        lock.lock()
        guard jobs[id] == nil else {
            lock.unlock()
            onOutput("this job is already running\n")
            completion(127)
            return id
        }
        do {
            (pid, readEnd) = try Self.spawn(arguments: ["/bin/zsh", "-c", command], directory: directory, environment: jobEnvironment())
        } catch {
            lock.unlock()
            onOutput("couldn't start: \(error.localizedDescription)\n")
            completion(127)
            return id
        }

        jobs[id] = pid
        lock.unlock()

        // Reading on one queue preserves output order and drains the pipe before completion.
        // The pipe only closes once the shell and everything it started have let go of it.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let handle = FileHandle(fileDescriptor: readEnd, closeOnDealloc: true)
            var pending = Data()
            while let chunk = try? handle.read(upToCount: 8192), !chunk.isEmpty {
                pending.append(chunk)
                var end = pending.count
                // Hold an incomplete trailing UTF-8 sequence for the next read.
                for count in 0...min(3, pending.count) {
                    let candidate = pending.prefix(pending.count - count)
                    if let text = String(data: candidate, encoding: .utf8) {
                        if !text.isEmpty { onOutput(text) }
                        end = count
                        break
                    }
                }
                if end == pending.count && pending.count > 3 {
                    onOutput(String(decoding: pending, as: UTF8.self))
                    pending.removeAll()
                } else if end == 0 { pending.removeAll() }
                else { pending = Data(pending.suffix(end)) }
            }
            if !pending.isEmpty { onOutput(String(decoding: pending, as: UTF8.self)) }
            try? handle.close()
            let code = Self.reap(pid)
            self?.lock.lock()
            self?.jobs.removeValue(forKey: id)
            self?.lock.unlock()
            completion(code)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30 * 60) { [weak self] in
            guard let self, self.isRunning(id: id) else { return }
            onOutput("\nThis job reached the 30 minute limit and was stopped.\n")
            self.cancel(id: id)
        }
        return id
    }

    public func isRunning(id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return jobs[id] != nil
    }

    /// Starts `arguments[0]` as the leader of a new process group with stdout and stderr
    /// joined into one pipe. Returns the child's pid and the read end of that pipe.
    private static func spawn(arguments: [String], directory: String, environment: [String: String]) throws -> (pid_t, Int32) {
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        let readEnd = fds[0], writeEnd = fds[1]

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, writeEnd, 1)
        posix_spawn_file_actions_adddup2(&actions, writeEnd, 2)
        posix_spawn_file_actions_addchdir_np(&actions, directory)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Own process group so Stop and pause reach the whole job; every other descriptor
        // stays closed in the child so one job can't hold another job's pipe open.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attributes, 0)

        let argv = arguments.map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let status = posix_spawn(&pid, arguments[0], &actions, &attributes, argv, envp)
        close(writeEnd)
        guard status == 0 else {
            close(readEnd)
            throw POSIXError(.init(rawValue: status) ?? .EIO)
        }
        return (pid, readEnd)
    }

    /// Waits for the child and converts its wait status to a shell-style exit code.
    private static func reap(_ pid: pid_t) -> Int32 {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 {
            if errno != EINTR { return 127 }
        }
        let low = status & 0x7f
        if low == 0 { return (status >> 8) & 0xff }
        return 128 + low
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
        guard let pid = leader(of: id) else { return }
        kill(-pid, SIGCONT)
        kill(-pid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.75) { [weak self] in
            // Until the job is reaped its leader pid can't be reused, so the group id is still ours.
            guard let self, self.leader(of: id) == pid else { return }
            kill(-pid, SIGKILL)
        }
    }

    public func pause(id: String) {
        if let pid = leader(of: id) { kill(-pid, SIGSTOP) }
    }

    public func resume(id: String) {
        if let pid = leader(of: id) { kill(-pid, SIGCONT) }
    }

    public func cancelAll() {
        lock.lock()
        let ids = Array(jobs.keys)
        lock.unlock()
        ids.forEach { cancel(id: $0) }
    }

    private func leader(of id: String) -> pid_t? {
        lock.lock(); defer { lock.unlock() }
        return jobs[id]
    }

    public static func which(_ binary: String) -> String? {
        guard !binary.isEmpty, !binary.contains("/") else { return nil }
        for dir in searchPaths {
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

/// A tiny helper `sudo` runs when a job needs the Mac login password. It shows a native
/// macOS dialog and hands the answer straight to sudo; nothing is stored or logged.
public enum AskPass {
    public static let script = """
    #!/bin/sh
    # okidoki: native password prompt for sudo. The answer goes straight to sudo.
    exec /usr/bin/osascript -e 'try' \\
      -e 'display dialog "Okidoki needs your Mac login password to finish this step.\\n\\nIt goes straight to macOS and is never stored." default answer "" with hidden answer with title "Okidoki" with icon caution buttons {"Cancel", "OK"} default button "OK"' \\
      -e 'return text returned of result' \\
      -e 'on error' \\
      -e 'error number -128' \\
      -e 'end try'
    """

    public static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Okidoki", isDirectory: true)
    }

    /// Path to the helper, written on first use. Nil only if the support folder can't be created.
    public static var path: String? {
        let url = directory.appendingPathComponent("askpass.sh")
        if let existing = try? String(contentsOf: url, encoding: .utf8), existing == script,
           FileManager.default.isExecutableFile(atPath: url.path) { return url.path }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            return url.path
        } catch {
            return nil
        }
    }
}

/// Opens a job in a real Terminal window for tools that need one (chat UIs, editors,
/// full-screen tools). Terminal runs `.command` files directly, so no automation permission is needed.
public enum TerminalLauncher {
    public static func open(title: String, commands: [String], workingDirectory: String) async throws -> URL {
        let folder = AskPass.directory.appendingPathComponent("launch", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let slug = title.lowercased().replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let url = folder.appendingPathComponent((slug.isEmpty ? "job" : slug) + ".command")
        try TerminalActions.launcherScript(title: title, commands: commands, workingDirectory: workingDirectory)
            .write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal")
            ?? URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try await NSWorkspace.shared.open([url], withApplicationAt: terminal, configuration: configuration)
        return url
    }
}

private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func append(_ value: String) { lock.lock(); text = String((text + value).suffix(80_000)); lock.unlock() }
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
}

public func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
