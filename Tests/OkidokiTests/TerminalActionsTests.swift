import XCTest
@testable import OkidokiCore

final class TerminalActionsTests: XCTestCase {
    func testNaturalRequestsAndDependencies() throws {
        let onlyBrew: (String) -> Bool = { $0 == "brew" }
        for text in ["install ffmpeg", "compress this video for Discord", "make this PDF searchable", "resize my photos", "zip a folder", "check free disk space", "show git status", "clean up my mac", "update everything"] {
            let decision = try XCTUnwrap(TerminalActions.decide(text, installed: onlyBrew), text)
            XCTAssertEqual(decision.kind, .terminal)
            XCTAssertFalse(decision.commands.isEmpty)
            XCTAssertEqual(decision.previewSteps.count, decision.commands.count, text)
        }
        XCTAssertNil(TerminalActions.decide("teach me terminal"))
        XCTAssertNil(TerminalActions.decide("how do i install ffmpeg"))
        XCTAssertEqual(try TerminalActions.prepare(["ffmpeg -version"], installed: onlyBrew), ["brew install ffmpeg", "ffmpeg -version"])
        XCTAssertEqual(try TerminalActions.prepare(["brew install ffmpeg", "ffmpeg -version"], installed: onlyBrew), ["brew install ffmpeg", "ffmpeg -version"])
        XCTAssertThrowsError(try TerminalActions.prepare([]))
        XCTAssertThrowsError(try TerminalActions.prepare(["cat {{file}}"]))
    }

    func testMissingHomebrewBecomesTheFirstStepInsteadOfADeadEnd() throws {
        let plan = try TerminalActions.preparePlan(["ffmpeg -version"], installed: { _ in false })
        XCTAssertTrue(plan.commands[0].contains("Homebrew/install"), plan.commands[0])
        XCTAssertFalse(plan.commands[0].contains("| bash"), "installer scripts are downloaded to a file, never piped")
        XCTAssertEqual(plan.commands.suffix(2), ["brew install ffmpeg", "ffmpeg -version"])
        XCTAssertTrue(plan.asksForPassword)
        XCTAssertEqual(plan.installs.first?.label, "install Homebrew (asks for your Mac password)")
        // Already-installed tools are left alone, and brew isn't added when nothing needs it.
        let ready = try TerminalActions.preparePlan(["ffmpeg -version"], installed: { _ in true })
        XCTAssertEqual(ready.commands, ["ffmpeg -version"])
        XCTAssertFalse(ready.asksForPassword)
        XCTAssertEqual(try TerminalActions.prepare(["df -h"], installed: { _ in false }), ["df -h"])
    }

    func testCodingAgentsAndRuntimesAreKnownByName() throws {
        let nothing: (String) -> Bool = { _ in false }
        let claude = try XCTUnwrap(TerminalActions.decide("install claude code", installed: nothing))
        XCTAssertEqual(claude.title, "install Claude Code")
        XCTAssertTrue(claude.commands.contains { $0.contains("claude.ai/install.sh") })
        XCTAssertFalse(claude.commands.contains { $0.contains("Homebrew/install") }, "the native installer doesn't need Homebrew")
        XCTAssertEqual(claude.commands.last, "command -v 'claude'")

        let hermes = try XCTUnwrap(TerminalActions.decide("please set up hermes agent", installed: nothing))
        XCTAssertTrue(hermes.commands.contains { $0.contains("hermes-agent.nousresearch.com") })

        let opencode = try XCTUnwrap(TerminalActions.decide("get opencode", installed: nothing))
        XCTAssertTrue(opencode.commands[0].contains("Homebrew/install"), "brew formulae pull Homebrew in first")
        XCTAssertTrue(opencode.commands.contains("brew install opencode"))
        XCTAssertEqual(opencode.previewSteps.count, opencode.commands.count)

        let ready = try XCTUnwrap(TerminalActions.decide("install node", installed: { _ in true }))
        XCTAssertEqual(ready.kind, .answer)

        XCTAssertEqual(SetupRecipes.match(in: "install claude code in my project")?.id, "claude")
        XCTAssertEqual(SetupRecipes.match(in: "install python")?.id, "python")
        XCTAssertNil(SetupRecipes.match(in: "install something unknown"))
    }

    func testInteractiveToolsOpenInATerminalWindow() throws {
        for command in ["claude", "claude --continue", "opencode", "opencode .", "hermes", "hermes chat", "omp", "mo analyze", "mo", "ollama run llama3.2", "vim notes.txt", "python3", "hermes --tui"] {
            XCTAssertTrue(TerminalActions.needsRealTerminal(command), command)
        }
        for command in ["claude -p 'hello' --output-format text", "opencode run --auto 'fix it'", "hermes -z 'hello'", "mo clean --dry-run", "mo clean", "mo analyze --dry-run", "ollama run llama3.2 'summarise this'", "python3 script.py", "brew install mole", "ls | less"] {
            XCTAssertFalse(TerminalActions.needsRealTerminal(command), command)
        }
        let launch = try XCTUnwrap(TerminalActions.decide("open claude code in my project", installed: { _ in true }))
        XCTAssertEqual(launch.builtin, TerminalActions.launchBuiltin)
        XCTAssertEqual(launch.pickFile, "folder")
        XCTAssertEqual(launch.commands, ["claude"])
        let fresh = try XCTUnwrap(TerminalActions.decide("start hermes", installed: { _ in false }))
        XCTAssertEqual(fresh.builtin, TerminalActions.launchBuiltin)
        XCTAssertEqual(fresh.commands.last, "hermes")
        XCTAssertGreaterThan(fresh.commands.count, 1, "installs first, then opens it")

        let script = TerminalActions.launcherScript(title: "open Claude Code", commands: ["claude"], workingDirectory: "/tmp/my ' project")
        XCTAssertTrue(script.hasPrefix("#!/bin/zsh"))
        XCTAssertTrue(script.contains("cd '/tmp/my '\\'' project'"))
        XCTAssertTrue(script.contains("\nclaude\n"))
    }

    func testFailuresAreDiagnosedInPlainLanguage() {
        let nothing: (String) -> Bool = { _ in false }
        let missing = TerminalActions.diagnose(output: "$ ffmpeg -i in.mov out.mp4\nzsh:1: command not found: ffmpeg\n", command: "ffmpeg -i in.mov out.mp4", installed: nothing)
        XCTAssertTrue(missing.message.contains("ffmpeg isn't installed"), missing.message)
        XCTAssertTrue(missing.retry)
        XCTAssertEqual(missing.fixCommands.last, "brew install ffmpeg")
        XCTAssertTrue(missing.fixCommands.first?.contains("Homebrew/install") == true)

        let unknown = TerminalActions.diagnose(output: "bash: frobnicate: command not found", command: "frobnicate", installed: nothing)
        XCTAssertTrue(unknown.fixCommands.isEmpty)
        XCTAssertTrue(unknown.message.contains("frobnicate"))

        let pip = TerminalActions.diagnose(output: "error: externally-managed-environment", command: "pip3 install yt-dlp", installed: { $0 == "brew" })
        XCTAssertEqual(pip.fixCommands.last, "pipx install yt-dlp")
        XCTAssertEqual(pip.fixCommands.first, "brew install pipx")

        let password = TerminalActions.diagnose(output: "sudo: 3 incorrect password attempts", command: "sudo -v")
        XCTAssertTrue(password.retry)
        XCTAssertTrue(password.message.contains("password"))

        let offline = TerminalActions.diagnose(output: "curl: (6) Could not resolve host: github.com", command: "curl https://github.com")
        XCTAssertTrue(offline.retry)
        XCTAssertTrue(offline.message.contains("internet"))

        let plain = TerminalActions.diagnose(output: "$ thing\nsomething odd happened\n", command: "thing")
        XCTAssertTrue(plain.message.contains("something odd happened"))
    }

    func testRiskAndPasswordHelper() async throws {
        XCTAssertEqual(CommandRisk.classify("sudo -v"), .medium)
        XCTAssertEqual(CommandRisk.classify("sudo -v && mo clean"), .medium)
        XCTAssertEqual(CommandRisk.classify("sudo rm -rf ~/Library"), .high)
        XCTAssertEqual(CommandRisk.classify("sudo installer -pkg x.pkg -target /"), .high)
        let path = try XCTUnwrap(AskPass.path)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: path))
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), AskPass.script)
        let env = ShellRunner.shared.jobEnvironment()
        XCTAssertEqual(env["SUDO_ASKPASS"], path)
        XCTAssertNotNil(env["DISPLAY"])
        XCTAssertTrue(env["PATH"]?.hasPrefix("/opt/homebrew/bin:") == true)
        // The helper is well-formed AppleScript: compiling it must not fail.
        let check = await ShellRunner.shared.run(command: "osascript -e 'return \"ok\"'")
        XCTAssertEqual(check.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok")
    }

    func testPathsAreQuotedWithoutExecutingFilenameContents() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let name = "my ' movie $(touch PWNED)"
        let file = directory.appendingPathComponent(name + ".mov")
        let commands = PlaceholderFiller.fill(["printf '%s' {{outputDir}}/{{basename}}-small.mp4"], file: file, folder: nil)
        let result = await ShellRunner.shared.run(command: commands[0], cwd: directory.path)
        XCTAssertEqual(result.code, 0)
        XCTAssertEqual(result.output, directory.path + "/" + name + "-small.mp4")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("PWNED").path))
        let missing = PlaceholderFiller.fill(["cat {{file}}"], file: nil, folder: nil)
        XCTAssertThrowsError(try TerminalActions.prepare(missing))
    }

    func testLocalPlanPreservesStateAndStopsOnPipelineFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let result = await ShellRunner.shared.run(command: TerminalActions.script([
            "mkdir 'a folder'", "cd 'a folder'", "export OKIDOKI_TEST_VALUE='hello'",
            "printf '%s' \"$OKIDOKI_TEST_VALUE\" > result.txt", "false | cat", "touch later"
        ]), cwd: directory.path)
        XCTAssertNotEqual(result.code, 0)
        XCTAssertEqual(try String(contentsOf: directory.appendingPathComponent("a folder/result.txt"), encoding: .utf8), "hello")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("a folder/later").path))
    }
    func testSplitUnicodeOutputIsPreserved() async {
        let result = await ShellRunner.shared.run(command: "printf '\\342'; sleep 0.02; printf '\\202\\254'")
        XCTAssertEqual(result.code, 0)
        XCTAssertEqual(result.output, "€")
    }

    func testStopTerminatesLocalChildrenAndSkipsFollowingWork() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let done = expectation(description: "shell stopped")
        let id = UUID().uuidString
        let exitCode = LockedBox<Int32>(0)
        // The pipe only closes once `sleep` is gone too, so a prompt completion proves the
        // whole process group was stopped rather than just the shell.
        ShellRunner.shared.stream(id: id, command: "sleep 5; touch should-not-exist", cwd: directory.path,
                                  onOutput: { _ in }, completion: { code in exitCode.value = code; done.fulfill() })
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(ShellRunner.shared.isRunning(id: id))
        ShellRunner.shared.pause(id: id)
        ShellRunner.shared.cancel(id: id)
        let started = Date()
        await fulfillment(of: [done], timeout: 3)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5, "stop should reach the shell's children")
        XCTAssertNotEqual(exitCode.value, 0)
        XCTAssertFalse(ShellRunner.shared.isRunning(id: id))
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("should-not-exist").path))
    }

    func testVideoRequestProducesPlayableCopyAndPreservesOriginal() async throws {
        guard let ffmpeg = ShellRunner.which("ffmpeg"), let ffprobe = ShellRunner.which("ffprobe") else {
            throw XCTSkip("ffmpeg is not installed")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("my ' clip $(literal).mov")
        let generated = await ShellRunner.shared.run(command: "\(shellQuote(ffmpeg)) -nostdin -v error -f lavfi -i color=c=blue:s=320x240:d=0.5 -c:v libx264 -pix_fmt yuv420p \(shellQuote(source.path))")
        XCTAssertEqual(generated.code, 0, generated.output)
        let original = try Data(contentsOf: source)
        let decision = try XCTUnwrap(TerminalActions.decide("compress this video for Discord"))
        let commands = try TerminalActions.prepare(PlaceholderFiller.fill(decision.commands, file: source, folder: nil))
        let result = await ShellRunner.shared.run(command: TerminalActions.script(commands), cwd: directory.path)
        XCTAssertEqual(result.code, 0, result.output)
        let output = directory.appendingPathComponent("my ' clip $(literal)-small.mp4")
        let probe = await ShellRunner.shared.run(command: "\(shellQuote(ffprobe)) -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \(shellQuote(output.path))")
        XCTAssertEqual(probe.code, 0, probe.output)
        XCTAssertGreaterThan(Double(probe.output.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0, 0)
        XCTAssertEqual(try Data(contentsOf: source), original)
        // Running the same job again must refuse to overwrite its result.
        let repeated = await ShellRunner.shared.run(command: TerminalActions.script(commands), cwd: directory.path)
        XCTAssertNotEqual(repeated.code, 0)
    }

    func testZipRequestCreatesArchiveBesideChosenFolder() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let folder = directory.appendingPathComponent("folder with spaces")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try "hello".write(to: folder.appendingPathComponent("note.txt"), atomically: true, encoding: .utf8)
        let decision = try XCTUnwrap(TerminalActions.decide("zip a folder"))
        let commands = try TerminalActions.prepare(PlaceholderFiller.fill(decision.commands, file: nil, folder: folder))
        let result = await ShellRunner.shared.run(command: TerminalActions.script(commands), cwd: folder.path)
        XCTAssertEqual(result.code, 0, result.output)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path + ".zip"))
        let repeated = await ShellRunner.shared.run(command: TerminalActions.script(commands), cwd: folder.path)
        XCTAssertNotEqual(repeated.code, 0)
    }
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
