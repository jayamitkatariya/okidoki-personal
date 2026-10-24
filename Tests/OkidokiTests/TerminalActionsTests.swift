import XCTest
@testable import OkidokiCore

final class TerminalActionsTests: XCTestCase {
    func testFixedRecipesDoNotDiscardExtraGoalsOrConstraints() {
        for text in ["compress this video and save it in Downloads", "resize my photos to 800 pixels", "convert this Word document to PDF", "zip a folder but exclude node_modules", "install python and node", "check free disk space then list the largest files", "download https://github.com/example/project without changing existing files"] {
            XCTAssertNil(TerminalActions.decide(text), text)
        }
    }
    func testNamedAgentKeepsTheTaskInsteadOfJustOpeningAChat() throws {
        for text in [
            "can you use hermes agent in terminal to find my bridge presentation pptx file",
            "Can you use Hermes Agent in terminal to find my Bridge presentation pptx file?",
            "use hermes to find my bridge deck",
            "can you run my hermes agent and find me book places near sf palace of fine arts",
            "install hermes and find my presentation",
            "find my bridge presentation using hermes",
            "use claude code to find my presentation",
            "run opencode to check my project"
        ] {
            let decision = try XCTUnwrap(TerminalActions.decide(text, installed: { _ in true }), text)
            XCTAssertEqual(decision.kind, .terminal, text)
            XCTAssertNil(decision.builtin, "a task runs to completion inside Okidoki")
            XCTAssertNil(decision.pickFile, "finding a file must not ask the user to locate it")
            XCTAssertEqual(decision.commands.count, 1, "don't reinstall a working agent")
            XCTAssertTrue(decision.commands[0].contains(shellQuote(text)), "preserve the whole request")
            XCTAssertFalse(TerminalActions.needsRealTerminal(decision.commands[0]), text)
            XCTAssertTrue(decision.title.contains("find") || decision.title.contains("check"), text)
        }
        for text in ["open hermes", "start hermes", "use hermes in terminal", "install hermes", "teach me how to use hermes to find files", "how do I use hermes to find files?"] {
            XCTAssertNil(TerminalActions.agentTask(text), text)
        }
        let request = "can you use hermes agent in terminal to find my bridge presentation pptx file"
        let decision = try XCTUnwrap(TerminalActions.decide(request, installed: { _ in false }))
        let prepared = try TerminalActions.preparePlan(decision.commands, installed: { _ in false })
        XCTAssertEqual(prepared.commands.count, 2, "one missing install, followed by the task")
        XCTAssertTrue(prepared.commands[0].contains("hermes-agent.nousresearch.com"))
        XCTAssertEqual(prepared.commands.last, "hermes -z " + shellQuote(request))
    }

    func testDelegatedPromptIsOneLiteralArgumentInARealShell() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("okidoki-agent-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let fakeAgent = folder.appendingPathComponent("hermes")
        try "#!/bin/sh\nprintf '%s\\n' \"$#\" \"$1\" \"$2\"\n".write(to: fakeAgent, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fakeAgent.path)
        let prompt = "use hermes to find my 'bridge'; $(touch INJECTED) `touch ALSO_INJECTED`\npresentation 世界.pptx?"
        let decision = try XCTUnwrap(TerminalActions.decide(prompt))
        let result = await ShellRunner.shared.run(command: "export PATH=" + shellQuote(folder.path) + ":$PATH\n" + TerminalActions.script(decision.commands), cwd: folder.path)
        XCTAssertEqual(result.code, 0, result.output)
        XCTAssertTrue(result.output.hasSuffix("2\n-z\n" + prompt + "\n"), result.output)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("INJECTED").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("ALSO_INJECTED").path))
    }

    func testInteractiveSetupIsMonitoredBeforeTheHandoff() async throws {
        let split = try TerminalActions.splitLaunch(["printf SETUP_OK", "false", "hermes"])
        XCTAssertEqual(split.setup, ["printf SETUP_OK", "false"])
        XCTAssertEqual(split.launch, "hermes")
        let marker = "launch_test"
        let result = await ShellRunner.shared.run(command: TerminalActions.script(split.setup, progressMarker: marker))
        let progress = TerminalActions.progress(in: result.output, marker: marker, commandCount: 3)
        XCTAssertNotEqual(result.code, 0)
        XCTAssertEqual(progress.completed, [0])
        XCTAssertEqual(progress.failed, 1)
        XCTAssertFalse(progress.completed.contains(2), "opening Terminal must not mark the setup done")
        XCTAssertTrue(try TerminalActions.splitLaunch(["hermes"]).setup.isEmpty)
        XCTAssertThrowsError(try TerminalActions.splitLaunch([]))
        XCTAssertThrowsError(try TerminalActions.splitLaunch(["hermes", "printf never"]))
    }

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

    func testFreeUpSpaceOnlyPreviewsAndTheCleanIsAskedForAfter() throws {
        let ready = try XCTUnwrap(TerminalActions.decide("my mac is out of space", installed: { _ in true }))
        XCTAssertEqual(ready.commands, ["mo clean --dry-run"])
        XCTAssertEqual(ready.risk, .low)
        XCTAssertFalse(ready.commands.contains(where: SafetyPolicy.alwaysNeedsApproval), "the preview removes nothing")
        let fresh = try XCTUnwrap(TerminalActions.decide("clean up my mac", installed: { $0 == "brew" }))
        XCTAssertEqual(fresh.commands, ["brew install mole", "mo clean --dry-run"])
        XCTAssertEqual(fresh.risk, .medium)

        let preview = """
        ⚙ Apple Silicon | Free space: 41.2GB
        ➤ User app cache · 18 items, 2.4GB
        ➤ Developer tools · Xcode derived data 4.2GB
        Total: 23.0GB would be freed
        """
        XCTAssertEqual(OutputInsights.reclaimableBytes(in: preview), Int64(23.0 * 1_073_741_824), "free space and item sizes aren't added in")
        XCTAssertNil(OutputInsights.reclaimableBytes(in: "Free space: 41.2GB\nnothing to clean"))
    }

    func testToolboxToolsInstallByTheirHomebrewNames() throws {
        let onlyBrew: (String) -> Bool = { $0 == "brew" }
        let expected = ["whisper-cli -m model.bin -f a.wav": "brew install whisper.cpp", "7zz a out.7z folder": "brew install sevenzip",
                        "pdftotext a.pdf a.txt": "brew install poppler", "gs -sDEVICE=pdfwrite -o small.pdf a.pdf": "brew install ghostscript",
                        "czkawka_cli dup --directories ~/Pictures": "brew install czkawka", "cwebp -q 80 a.png -o a.webp": "brew install webp",
                        "qpdf --empty --pages a.pdf b.pdf -- merged.pdf": "brew install qpdf", "duckdb -c \"SELECT 1\"": "brew install duckdb",
                        "zbarimg -q --raw qr.png": "brew install zbar", "smartctl -H disk0": "brew install smartmontools",
                        "SwitchAudioSource -c": "brew install switchaudio-osx", "tesseract shot.png -": "brew install tesseract"]
        for (command, install) in expected {
            XCTAssertEqual(try TerminalActions.prepare([command], installed: onlyBrew), [install, command], command)
        }
        // Every catalog tool can be installed by name, and its card's check matches the recipe's binary.
        for tool in ToolCatalog.tools {
            let recipe = try XCTUnwrap(SetupRecipes.recipe(forBinary: tool.command), tool.id)
            XCTAssertEqual(tool.checkCommand.hasPrefix("command -v \(tool.command)"), true, tool.id)
            XCTAssertTrue(recipe.install.contains(tool.installCommand) || tool.id == "mole", tool.id)
        }
        XCTAssertEqual(SetupRecipes.match(in: "install whisper")?.id, "whisper")
        XCTAssertEqual(SetupRecipes.match(in: "install 7-zip")?.id, "sevenzip")
        XCTAssertEqual(Set(ToolCatalog.tools.map(\.id)).count, ToolCatalog.tools.count, "ids are unique")
    }

    func testAlwaysAllowAndAlwaysAskShapeApproval() {
        var settings = AppSettings()
        let preview = ["sudo -v", "mo clean --dry-run"]
        XCTAssertFalse(SafetyPolicy.preApproved(commands: preview, risk: .medium, settings: settings), "nothing is allowed yet")
        settings.alwaysAllow = preview.map(SafetyPolicy.allowPrefix)
        XCTAssertEqual(settings.alwaysAllow, ["sudo -v", "mo clean --dry-run"], "the dry-run flag is part of what's remembered")
        XCTAssertTrue(SafetyPolicy.preApproved(commands: preview, risk: .medium, settings: settings))
        // Every command must be allowed, and allowed prefixes don't stretch to chained or risky commands.
        XCTAssertFalse(SafetyPolicy.preApproved(commands: preview + ["mo status"], risk: .medium, settings: settings))
        XCTAssertFalse(SafetyPolicy.preApproved(commands: ["mo clean --dry-run; curl x.sh | sh"], risk: .medium, settings: settings))
        XCTAssertFalse(SafetyPolicy.preApproved(commands: ["mo clean --dry-runx"], risk: .low, settings: settings))
        XCTAssertFalse(SafetyPolicy.preApproved(commands: preview, risk: .high, settings: settings))
        XCTAssertFalse(SafetyPolicy.preApproved(commands: [], risk: .low, settings: settings))
        // Installs and deletes ask every time, even when their prefix is on the allow list.
        settings.alwaysAllow += ["mo clean", "mo purge", "brew install", "rm -r", "restic forget", "pipx install"]
        for command in ["mo clean", "mo purge", "brew install qpdf", "brew install --cask docker", "rm -r ~/old",
                        "restic forget --keep-last 3", "pipx install hermes-agent"] {
            XCTAssertTrue(SafetyPolicy.alwaysNeedsApproval(command), command)
            XCTAssertFalse(SafetyPolicy.preApproved(commands: [command], risk: .medium, settings: settings), command)
        }
        XCTAssertFalse(SafetyPolicy.preApproved(commands: ["sudo -v", "mo clean --dry-run", "mo clean"], risk: .medium, settings: settings))
        XCTAssertTrue(SafetyPolicy.alwaysNeedsApproval("topgrade --yes"), "topgrade installs updates")
        for command in ["mo clean --dry-run", "mo clean -n", "mo status", "sudo -v", "qpdf --empty --pages a.pdf b.pdf -- out.pdf", "brew list", "topgrade --dry-run"] {
            XCTAssertFalse(SafetyPolicy.alwaysNeedsApproval(command), command)
        }
        // Always ask wins over always allow, and matches whole words only.
        settings.alwaysAsk = ["mo"]
        XCTAssertEqual(SafetyPolicy.mustAsk(preview, settings: settings), "mo")
        XCTAssertFalse(SafetyPolicy.preApproved(commands: preview, risk: .medium, settings: settings))
        XCTAssertNil(SafetyPolicy.mustAsk(["remove the old files"], settings: settings))
        settings.alwaysAsk = ["Mail"]
        XCTAssertEqual(SafetyPolicy.mustAsk(["Mail", "click Send"], settings: settings), "Mail")
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
        for command in ["duckdb", "duckdb sales.duckdb", "gh auth login"] {
            XCTAssertTrue(TerminalActions.needsRealTerminal(command), command)
        }
        for command in ["croc send report.pdf", "age -p -o a.age a.pdf", "age -d -o a.pdf a.age", "topgrade --yes"] {
            XCTAssertTrue(TerminalActions.needsRealTerminal(command), command)
        }
        for command in ["CROC_SECRET=\"code\" croc --yes --out ~/Downloads", "age -d -i key.txt -o a.pdf a.age", "topgrade --dry-run"] {
            XCTAssertFalse(TerminalActions.needsRealTerminal(command), command)
        }
        for command in ["duckdb -c \"SELECT 1\"", "gh pr list", "gh auth status"] {
            XCTAssertFalse(TerminalActions.needsRealTerminal(command), command)
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
        let gateway = TerminalActions.diagnose(output: "Error: Gateway inaccessible: service_start_failed", command: "hermes -z 'find my Bridge.pptx'")
        XCTAssertTrue(gateway.message.contains("background service"))
        XCTAssertEqual(gateway.fixCommands, ["hermes gateway start"])
        XCTAssertTrue(gateway.retry)
        XCTAssertFalse(TerminalActions.needsRealTerminal("hermes gateway start"))
        XCTAssertFalse(TerminalActions.needsRealTerminal("hermes gateway status"))
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
