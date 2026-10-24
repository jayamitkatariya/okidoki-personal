import Foundation

/// Something people ask to install, update or open by name: runtimes, coding agents, and the
/// tools in the catalog. Recipes chain through `needs`, so "install claude code" on a fresh Mac
/// becomes one reviewable plan that also sets up Homebrew.
public struct SetupRecipe: Identifiable, Sendable {
    public var id: String
    public var name: String
    public var aliases: [String]
    public var binary: String
    public var install: [String]
    public var needs: [String]
    public var update: [String]
    /// A command that needs a real terminal (a chat UI or a full-screen tool).
    public var launch: String?
    /// Whether the launch should start inside a project folder the person picks.
    public var launchInFolder: Bool
    public var blurb: String

    public init(id: String, name: String, aliases: [String], binary: String, install: [String],
                needs: [String] = [], update: [String] = [], launch: String? = nil,
                launchInFolder: Bool = false, blurb: String) {
        self.id = id; self.name = name; self.aliases = aliases; self.binary = binary
        self.install = install; self.needs = needs; self.update = update
        self.launch = launch; self.launchInFolder = launchInFolder; self.blurb = blurb
    }
}

public enum SetupRecipes {
    static let download = #"curl -fsSL --retry 3 %@ -o "${TMPDIR:-/tmp}/okidoki-%@.sh" && /bin/bash "${TMPDIR:-/tmp}/okidoki-%@.sh""#
    static func script(_ url: String, _ slug: String) -> String { String(format: download, url, slug, slug) }

    public static let all: [SetupRecipe] = [
        SetupRecipe(id: "homebrew", name: "Homebrew", aliases: ["homebrew", "brew"], binary: "brew",
                    install: [script("https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh", "homebrew"),
                              #"test -x /opt/homebrew/bin/brew && { grep -qs 'brew shellenv' "$HOME/.zprofile" || printf '\neval "$(/opt/homebrew/bin/brew shellenv)"\n' >> "$HOME/.zprofile"; }; true"#],
                    update: ["brew update", "brew upgrade"],
                    blurb: "The Mac package manager almost every free tool installs through."),
        SetupRecipe(id: "git", name: "Git", aliases: ["git"], binary: "git",
                    install: ["brew install git"], needs: ["homebrew"], update: ["brew upgrade git"],
                    blurb: "Version control, and what downloads most open-source projects."),
        SetupRecipe(id: "node", name: "Node.js", aliases: ["node", "nodejs", "node.js", "npm"], binary: "node",
                    install: ["brew install node"], needs: ["homebrew"], update: ["brew upgrade node"],
                    blurb: "The JavaScript runtime; many command-line tools are installed with npm."),
        SetupRecipe(id: "python", name: "Python", aliases: ["python", "python3", "pip", "pip3"], binary: "python3",
                    install: ["brew install python"], needs: ["homebrew"], update: ["brew upgrade python"],
                    blurb: "Python 3, with pip."),
        SetupRecipe(id: "uv", name: "uv", aliases: ["uv", "uvx"], binary: "uv",
                    install: ["brew install uv"], needs: ["homebrew"], update: ["brew upgrade uv"],
                    blurb: "Fast Python package and project manager."),
        SetupRecipe(id: "pipx", name: "pipx", aliases: ["pipx"], binary: "pipx",
                    install: ["brew install pipx", "pipx ensurepath"], needs: ["homebrew"], update: ["brew upgrade pipx"],
                    blurb: "Installs Python command-line apps in their own sandboxes."),
        SetupRecipe(id: "bun", name: "Bun", aliases: ["bun"], binary: "bun",
                    install: ["brew install oven-sh/bun/bun"], needs: ["homebrew"], update: ["brew upgrade oven-sh/bun/bun"],
                    blurb: "Fast JavaScript runtime and package manager."),
        SetupRecipe(id: "claude", name: "Claude Code", aliases: ["claude code", "claude-code", "claudecode"], binary: "claude",
                    install: [script("https://claude.ai/install.sh", "claude-code")],
                    update: ["claude update"], launch: "claude", launchInFolder: true,
                    blurb: "Anthropic's coding agent for the terminal."),
        SetupRecipe(id: "opencode", name: "OpenCode", aliases: ["opencode", "open code", "open-code"], binary: "opencode",
                    install: ["brew install opencode"], needs: ["homebrew"], update: ["brew upgrade opencode"],
                    launch: "opencode", launchInFolder: true,
                    blurb: "Open-source coding agent that works with any model provider."),
        SetupRecipe(id: "omp", name: "omp", aliases: ["omp"], binary: "omp",
                    install: [script("https://omp.sh/install", "omp")], launch: "omp", launchInFolder: true,
                    blurb: "Autonomous coding agent for long-running work."),
        SetupRecipe(id: "hermes", name: "Hermes Agent", aliases: ["hermes agent", "hermes-agent", "hermes"], binary: "hermes",
                    install: [script("https://hermes-agent.nousresearch.com/install.sh", "hermes")],
                    update: ["hermes update"], launch: "hermes", launchInFolder: false,
                    blurb: "Nous Research's self-improving agent with tools, memory and messaging."),
        SetupRecipe(id: "codex", name: "Codex", aliases: ["codex", "openai codex", "codex cli"], binary: "codex",
                    install: ["npm install -g @openai/codex"], needs: ["node"],
                    update: ["npm install -g @openai/codex@latest"], launch: "codex", launchInFolder: true,
                    blurb: "OpenAI's coding agent for the terminal."),
        SetupRecipe(id: "gemini", name: "Gemini CLI", aliases: ["gemini cli", "gemini-cli", "gemini"], binary: "gemini",
                    install: ["npm install -g @google/gemini-cli"], needs: ["node"],
                    update: ["npm install -g @google/gemini-cli@latest"], launch: "gemini", launchInFolder: true,
                    blurb: "Google's coding agent for the terminal."),
        SetupRecipe(id: "cursor-agent", name: "Cursor Agent", aliases: ["cursor agent", "cursor-agent", "cursor cli"], binary: "cursor-agent",
                    install: [script("https://cursor.com/install", "cursor-agent")],
                    launch: "cursor-agent", launchInFolder: true,
                    blurb: "Cursor's agent for the terminal."),
        SetupRecipe(id: "ollama", name: "Ollama", aliases: ["ollama"], binary: "ollama",
                    install: ["brew install --cask ollama"], needs: ["homebrew"], update: ["brew upgrade --cask ollama"],
                    blurb: "Runs open models locally on your Mac."),
        SetupRecipe(id: "mole", name: "Mole", aliases: ["mole", "mo"], binary: "mo",
                    install: ["brew install mole"], needs: ["homebrew"], update: ["brew upgrade mole"],
                    launch: "mo analyze",
                    blurb: "Deep-cleans caches, logs and leftovers. Visual disk explorer included."),
        SetupRecipe(id: "ffmpeg", name: "ffmpeg", aliases: ["ffmpeg"], binary: "ffmpeg",
                    install: ["brew install ffmpeg"], needs: ["homebrew"], update: ["brew upgrade ffmpeg"],
                    blurb: "Compress, trim, convert and stitch video."),
        SetupRecipe(id: "handbrake", name: "HandBrake", aliases: ["handbrake", "handbrakecli"], binary: "HandBrakeCLI",
                    install: ["brew install handbrake"], needs: ["homebrew"],
                    blurb: "Batch-friendly video transcoding."),
        SetupRecipe(id: "pandoc", name: "Pandoc", aliases: ["pandoc"], binary: "pandoc",
                    install: ["brew install pandoc"], needs: ["homebrew"], update: ["brew upgrade pandoc"],
                    blurb: "Converts between document formats."),
        SetupRecipe(id: "ocrmypdf", name: "OCRmyPDF", aliases: ["ocrmypdf", "ocr my pdf"], binary: "ocrmypdf",
                    install: ["brew install ocrmypdf"], needs: ["homebrew"], update: ["brew upgrade ocrmypdf"],
                    blurb: "Adds a searchable text layer to scanned PDFs."),
        SetupRecipe(id: "imagemagick", name: "ImageMagick", aliases: ["imagemagick", "image magick", "magick"], binary: "magick",
                    install: ["brew install imagemagick"], needs: ["homebrew"], update: ["brew upgrade imagemagick"],
                    blurb: "Resize, convert and crop whole folders of images."),
        SetupRecipe(id: "rclone", name: "rclone", aliases: ["rclone"], binary: "rclone",
                    install: ["brew install rclone"], needs: ["homebrew"], update: ["brew upgrade rclone"],
                    blurb: "Syncs almost any cloud drive from the terminal."),
        SetupRecipe(id: "yt-dlp", name: "yt-dlp", aliases: ["yt-dlp", "ytdlp", "youtube-dl", "youtube downloader"], binary: "yt-dlp",
                    install: ["brew install yt-dlp"], needs: ["homebrew"], update: ["brew upgrade yt-dlp"],
                    blurb: "Downloads video and audio from most websites."),
        SetupRecipe(id: "gh", name: "GitHub CLI", aliases: ["gh", "github cli"], binary: "gh",
                    install: ["brew install gh"], needs: ["homebrew"], update: ["brew upgrade gh"],
                    blurb: "GitHub from the terminal."),
        SetupRecipe(id: "docker", name: "Docker Desktop", aliases: ["docker"], binary: "docker",
                    install: ["brew install --cask docker"], needs: ["homebrew"],
                    blurb: "Runs apps in containers."),
        SetupRecipe(id: "gifski", name: "gifski", aliases: ["gifski"], binary: "gifski",
                    install: ["brew install gifski"], needs: ["homebrew"], update: ["brew upgrade gifski"],
                    blurb: "Turns video clips into crisp, small GIFs."),
        SetupRecipe(id: "sox", name: "SoX", aliases: ["sox"], binary: "sox",
                    install: ["brew install sox"], needs: ["homebrew"], update: ["brew upgrade sox"],
                    blurb: "Trims, converts, joins and evens out the volume of audio files."),
        SetupRecipe(id: "whisper", name: "whisper.cpp", aliases: ["whisper", "whisper.cpp", "whisper cpp", "whisper-cli"], binary: "whisper-cli",
                    install: ["brew install whisper.cpp"], needs: ["homebrew"], update: ["brew upgrade whisper.cpp"],
                    blurb: "Transcribes recordings on your Mac. Private, offline, no per-minute bill."),
        SetupRecipe(id: "pngquant", name: "pngquant", aliases: ["pngquant"], binary: "pngquant",
                    install: ["brew install pngquant"], needs: ["homebrew"], update: ["brew upgrade pngquant"],
                    blurb: "Shrinks PNGs by 60-80% with barely visible quality loss."),
        SetupRecipe(id: "oxipng", name: "oxipng", aliases: ["oxipng"], binary: "oxipng",
                    install: ["brew install oxipng"], needs: ["homebrew"], update: ["brew upgrade oxipng"],
                    blurb: "Shrinks PNGs without changing a single pixel."),
        SetupRecipe(id: "exiftool", name: "ExifTool", aliases: ["exiftool", "exif tool"], binary: "exiftool",
                    install: ["brew install exiftool"], needs: ["homebrew"], update: ["brew upgrade exiftool"],
                    blurb: "Shows and removes hidden photo data like location, camera and dates."),
        SetupRecipe(id: "webp", name: "WebP", aliases: ["webp", "cwebp"], binary: "cwebp",
                    install: ["brew install webp"], needs: ["homebrew"], update: ["brew upgrade webp"],
                    blurb: "Converts images to WebP, a fraction of the size for websites."),
        SetupRecipe(id: "qpdf", name: "qpdf", aliases: ["qpdf"], binary: "qpdf",
                    install: ["brew install qpdf"], needs: ["homebrew"], update: ["brew upgrade qpdf"],
                    blurb: "Merges, splits, rotates and unlocks PDFs without touching quality."),
        SetupRecipe(id: "ghostscript", name: "Ghostscript", aliases: ["ghostscript"], binary: "gs",
                    install: ["brew install ghostscript"], needs: ["homebrew"], update: ["brew upgrade ghostscript"],
                    blurb: "Shrinks heavy PDFs so they fit in an email."),
        SetupRecipe(id: "poppler", name: "Poppler", aliases: ["poppler", "pdftotext", "pdfimages"], binary: "pdftotext",
                    install: ["brew install poppler"], needs: ["homebrew"], update: ["brew upgrade poppler"],
                    blurb: "Pulls the text, images and details out of any PDF."),
        SetupRecipe(id: "typst", name: "Typst", aliases: ["typst"], binary: "typst",
                    install: ["brew install typst"], needs: ["homebrew"], update: ["brew upgrade typst"],
                    blurb: "Turns simple markup into polished PDFs. Also gives Pandoc a PDF engine."),
        SetupRecipe(id: "czkawka", name: "Czkawka", aliases: ["czkawka", "czkawka_cli", "duplicate finder"], binary: "czkawka_cli",
                    install: ["brew install czkawka"], needs: ["homebrew"], update: ["brew upgrade czkawka"],
                    blurb: "Finds duplicate files, similar photos and the biggest space hogs."),
        SetupRecipe(id: "sevenzip", name: "7-Zip", aliases: ["7-zip", "7zip", "7zz", "sevenzip"], binary: "7zz",
                    install: ["brew install sevenzip"], needs: ["homebrew"], update: ["brew upgrade sevenzip"],
                    blurb: "Makes and opens .7z and .zip archives with strong compression."),
        SetupRecipe(id: "unar", name: "unar", aliases: ["unar", "the unarchiver"], binary: "unar",
                    install: ["brew install unar"], needs: ["homebrew"], update: ["brew upgrade unar"],
                    blurb: "Opens RAR, 7z, ISO and old Mac archives with one command."),
        SetupRecipe(id: "duckdb", name: "DuckDB", aliases: ["duckdb", "duck db"], binary: "duckdb",
                    install: ["brew install duckdb"], needs: ["homebrew"], update: ["brew upgrade duckdb"],
                    blurb: "Answers questions about CSV, Excel and Parquet files with SQL, even huge ones."),
        SetupRecipe(id: "mas", name: "mas", aliases: ["mas", "app store cli"], binary: "mas",
                    install: ["brew install mas"], needs: ["homebrew"], update: ["brew upgrade mas"],
                    blurb: "Updates and installs Mac App Store apps from one command."),
        SetupRecipe(id: "restic", name: "restic", aliases: ["restic"], binary: "restic",
                    install: ["brew install restic"], needs: ["homebrew"], update: ["brew upgrade restic"],
                    blurb: "Encrypted, versioned backups to a drive or cloud storage."),
        SetupRecipe(id: "tesseract", name: "Tesseract", aliases: ["tesseract", "image ocr"], binary: "tesseract",
                    install: ["brew install tesseract"], needs: ["homebrew"], update: ["brew upgrade tesseract"],
                    blurb: "Copies the text out of screenshots, photos and scans."),
        SetupRecipe(id: "qrencode", name: "qrencode", aliases: ["qrencode", "qr code generator"], binary: "qrencode",
                    install: ["brew install qrencode"], needs: ["homebrew"], update: ["brew upgrade qrencode"],
                    blurb: "Makes QR codes for links, text and Wi-Fi as PNG or SVG."),
        SetupRecipe(id: "zbar", name: "zbar", aliases: ["zbar", "zbarimg", "qr code reader", "barcode reader"], binary: "zbarimg",
                    install: ["brew install zbar"], needs: ["homebrew"], update: ["brew upgrade zbar"],
                    blurb: "Reads QR codes and barcodes from images and screenshots."),
        SetupRecipe(id: "img2pdf", name: "img2pdf", aliases: ["img2pdf", "image to pdf"], binary: "img2pdf",
                    install: ["brew install img2pdf"], needs: ["homebrew"], update: ["brew upgrade img2pdf"],
                    blurb: "Turns photos and scans into one PDF without losing quality."),
        SetupRecipe(id: "jpegoptim", name: "jpegoptim", aliases: ["jpegoptim"], binary: "jpegoptim",
                    install: ["brew install jpegoptim"], needs: ["homebrew"], update: ["brew upgrade jpegoptim"],
                    blurb: "Makes photos smaller with little visible change."),
        SetupRecipe(id: "croc", name: "croc", aliases: ["croc"], binary: "croc",
                    install: ["brew install croc"], needs: ["homebrew"], update: ["brew upgrade croc"],
                    blurb: "Sends files to another computer, encrypted, with no size limit."),
        SetupRecipe(id: "age", name: "age", aliases: ["age", "age encryption"], binary: "age",
                    install: ["brew install age"], needs: ["homebrew"], update: ["brew upgrade age"],
                    blurb: "Locks files with a password or key, simply and securely."),
        SetupRecipe(id: "smartmontools", name: "smartmontools", aliases: ["smartmontools", "smartctl"], binary: "smartctl",
                    install: ["brew install smartmontools"], needs: ["homebrew"], update: ["brew upgrade smartmontools"],
                    blurb: "Checks the health of your Mac's drive and external disks."),
        SetupRecipe(id: "switchaudio", name: "SwitchAudio", aliases: ["switchaudio", "switchaudiosource", "switchaudio-osx"], binary: "SwitchAudioSource",
                    install: ["brew install switchaudio-osx"], needs: ["homebrew"], update: ["brew upgrade switchaudio-osx"],
                    blurb: "Switches your sound output or microphone from one command."),
        SetupRecipe(id: "topgrade", name: "topgrade", aliases: ["topgrade"], binary: "topgrade",
                    install: ["brew install topgrade"], needs: ["homebrew"], update: ["brew upgrade topgrade"],
                    blurb: "Updates Homebrew, App Store apps and your other tools in one go."),
    ]

    public static func recipe(id: String) -> SetupRecipe? { all.first { $0.id == id } }

    /// The recipe whose binary runs at a command position in the given command line.
    public static func recipe(forBinary binary: String) -> SetupRecipe? {
        all.first { $0.binary == binary } ?? (binary == "mole" ? recipe(id: "mole") : nil)
    }

    /// The recipe named in free text, preferring longer aliases ("claude code" over "claude").
    public static func match(in text: String) -> SetupRecipe? {
        let lower = text.lowercased()
        var best: (SetupRecipe, Int)?
        for recipe in all {
            for alias in recipe.aliases {
                let pattern = #"(?<![\w.-])"# + NSRegularExpression.escapedPattern(for: alias) + #"(?![\w-])"#
                if lower.range(of: pattern, options: .regularExpression) != nil, alias.count > (best?.1 ?? 0) {
                    best = (recipe, alias.count)
                }
            }
        }
        return best?.0
    }

    /// Install steps for a recipe and everything it needs that isn't on this Mac yet.
    public static func installPlan(for recipe: SetupRecipe, installed: (String) -> Bool) -> [(recipe: SetupRecipe, command: String)] {
        var seen: Set<String> = []
        var plan: [(SetupRecipe, String)] = []
        func visit(_ recipe: SetupRecipe) {
            guard !seen.contains(recipe.id), !installed(recipe.binary) else { return }
            seen.insert(recipe.id)
            for need in recipe.needs.compactMap(SetupRecipes.recipe(id:)) { visit(need) }
            for command in recipe.install { plan.append((recipe, command)) }
        }
        visit(recipe)
        return plan
    }
}

/// Small useful jobs remain available offline. Broader requests use the model planner.
public enum TerminalActions {
    public static let launchBuiltin = "terminal-app"

    public static func decide(_ text: String, installed: (String) -> Bool = { ShellRunner.which($0) != nil }) -> BrainDecision? {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = raw.lowercased()
        // Bringing memories over: "import my memory from claude code", "what does chatgpt know about me, pull it in".
        // Checked before installs, since the other assistant's name would otherwise read as a setup request,
        // and before the question guard below, since these are often phrased as questions.
        if let decision = MemoryImport.decide(t) { return decision }
        let listsTools = t.range(of: #"\b(what|which)('s| is| are)? (tools?|agents?) (do i have|are installed|is installed)\b"#, options: .regularExpression) != nil
            || t == "list my tools" || t == "list installed tools"
        if !listsTools, t.hasPrefix("teach") || t.hasPrefix("how ") || t.hasPrefix("what ") || t.hasPrefix("why ") || t.contains("?") { return nil }
        func plan(_ title: String, _ summary: String, _ commands: [String], pick: String? = nil,
                  steps: [String] = [], risk: RiskLevel = .low, builtin: String? = nil) -> BrainDecision {
            let labels = steps.isEmpty ? commands.map { command -> String in
                if command.hasPrefix("test ") { return "check that the output doesn't already exist" }
                if command.hasPrefix("mkdir ") { return "make a folder for the copies" }
                if command.hasPrefix("brew ") { return title }
                if command.hasPrefix("command -v ") { return "check the installation" }
                return title
            } : steps
            return BrainDecision(kind: .terminal, title: title, answer: summary + " I'll show the result here.",
                          risk: risk, previewSummary: summary, previewSteps: labels,
                          commands: commands, apps: [], pickFile: pick, builtin: builtin)
        }

        // Setting things up: "install claude code", "set up python", "get homebrew".
        if t.range(of: #"^(please |can you |could you )?(install|set ?up|setup|get|download) "#, options: .regularExpression) != nil,
           !t.contains("github.com"), let recipe = SetupRecipes.match(in: t) {
            let steps = SetupRecipes.installPlan(for: recipe, installed: installed)
            if steps.isEmpty {
                return BrainDecision(kind: .answer, title: "\(recipe.name) is ready",
                                     answer: "\(recipe.name) is already installed on this Mac." + (recipe.launch == nil ? "" : " Say “open \(recipe.name.lowercased())” and I'll start it for you."))
            }
            let labels = steps.map { step -> String in
                step.command.hasPrefix("test -x /opt/homebrew") ? "put Homebrew on your path"
                    : step.command.hasPrefix("pipx ensurepath") ? "put pipx apps on your path"
                    : "install \(step.recipe.name)" + (step.recipe.id == "homebrew" ? " (asks for your Mac password)" : "")
            }
            let names = Array(NSOrderedSet(array: steps.map(\.recipe.name))) as? [String] ?? [recipe.name]
            let summary = names.count > 1
                ? "Install \(recipe.name). It needs \(names.dropLast().joined(separator: " and ")) first, so I'll set those up too."
                : "Install \(recipe.name) and check it's ready."
            return plan("install \(recipe.name)", summary,
                        steps.map(\.command) + ["command -v \(shellQuote(recipe.binary))"],
                        steps: labels + ["check the installation"], risk: .medium)
        }

        // Opening interactive tools: "open claude code in my project", "start hermes", "run mole".
        if t.range(of: #"^(please )?(open|start|launch|run|use|chat with|talk to) "#, options: .regularExpression) != nil,
           let recipe = SetupRecipes.match(in: t), let launch = recipe.launch {
            let installs = SetupRecipes.installPlan(for: recipe, installed: installed)
            let pick = recipe.launchInFolder ? "folder" : nil
            let summary = (installs.isEmpty ? "" : "Install \(recipe.name) first, then ")
                + (installs.isEmpty ? "Open" : "open") + " \(recipe.name) in a Terminal window"
                + (recipe.launchInFolder ? " inside the project folder you choose." : ".")
            return plan("open \(recipe.name)", summary, installs.map(\.command) + [launch], pick: pick,
                        steps: installs.map { "install \($0.recipe.name)" } + ["open \(recipe.name) in Terminal"],
                        risk: installs.isEmpty ? .low : .medium, builtin: launchBuiltin)
        }

        // Keeping things current: "update everything", "upgrade ffmpeg".
        if t.range(of: #"^(please )?(update|upgrade) "#, options: .regularExpression) != nil {
            if t.range(of: #"\b(everything|all|my tools|homebrew|brew|my mac)\b"#, options: .regularExpression) != nil {
                return plan("update your tools", "Update Homebrew and every tool installed with it.",
                            ["brew update", "brew upgrade", "brew cleanup"],
                            steps: ["refresh the package list", "upgrade installed tools", "remove old versions"], risk: .medium)
            }
            if let recipe = SetupRecipes.match(in: t), !recipe.update.isEmpty {
                return plan("update \(recipe.name)", "Update \(recipe.name) to the latest version.", recipe.update,
                            steps: recipe.update.map { _ in "update \(recipe.name)" }, risk: .medium)
            }
        }

        if listsTools {
            let have = SetupRecipes.all.filter { installed($0.binary) }.map(\.name)
            let missing = SetupRecipes.all.filter { !installed($0.binary) }.map(\.name)
            return BrainDecision(kind: .answer, title: "your tools",
                                 answer: (have.isEmpty ? "Nothing from the toolbox is installed yet." : "Installed: " + have.joined(separator: ", ") + ".")
                                    + (missing.isEmpty ? "" : "\n\nNot yet: " + missing.joined(separator: ", ") + ". Say “install …” and I'll set it up."))
        }

        if (t.contains("compress") || t.contains("smaller")) && (t.contains("video") || t.contains("movie")) {
            return plan("make video smaller", "Choose a video. I'll save a smaller MP4 beside it and keep the original.",
                        ["test ! -e {{outputDir}}/{{basename}}-small.mp4", #"ffmpeg -nostdin -n -i {{file}} -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart {{outputDir}}/{{basename}}-small.mp4"#], pick: "video")
        }
        if t.range(of: #"\bocr\b"#, options: .regularExpression) != nil || t.contains("searchable") || t.contains("scanned pdf") {
            return plan("make PDF searchable", "Choose a PDF. I'll save a searchable copy beside the original.",
                        ["ocrmypdf --skip-text {{file}} {{outputDir}}/{{basename}}-searchable.pdf"], pick: "pdf")
        }
        if t.contains("convert") && t.contains("word") {
            return plan("convert to Word", "Choose a document. I'll make a Word copy beside it.",
                        ["test ! -e {{outputDir}}/{{basename}}.docx", "pandoc {{file}} -o {{outputDir}}/{{basename}}.docx"], pick: "document")
        }
        if t.contains("resize") && ["image", "photo", "picture"].contains(where: t.contains) {
            return plan("resize photos", "Choose a folder. I'll save copies at up to 1600 pixels in a new folder.",
                        ["test ! -e {{outputDir}}", "mkdir -p {{outputDir}}", "magick mogrify -resize '1600x1600>' -path {{outputDir}} {{dir}}/*.(jpg|jpeg|png|heic|JPG|JPEG|PNG|HEIC)(N)"], pick: "images")
        }
        if t.contains("zip") && !t.contains("unzip") && (t.contains("folder") || t.contains("compress")) {
            return plan("zip a folder", "Choose a folder. I'll make a ZIP beside it.",
                        ["test ! -e {{dir}}.zip", "ditto -c -k --sequesterRsrc --keepParent {{dir}} {{dir}}.zip"], pick: "folder")
        }
        if t.range(of: #"\b(disk|storage|space)\b"#, options: .regularExpression) != nil &&
            ["check", "show", "how much", "available", "left", "free space"].contains(where: t.contains) &&
            !["clean", "free up", "out of"].contains(where: t.contains) {
            return plan("check storage", "Check how much storage is available on your Mac.", ["df -h \"$HOME\""])
        }
        if t.range(of: #"\b(clean|clean up|free up|tidy)\b.*\b(mac|space|storage|disk|caches?)\b|\bout of (space|storage)\b"#, options: .regularExpression) != nil {
            let installs = SetupRecipes.installPlan(for: SetupRecipes.recipe(id: "mole")!, installed: installed)
            // Only the preview runs here. When it finishes, the real clean is offered as its own approval.
            return plan("free up space", "Preview what Mole can clean from caches, logs and trash. Nothing is removed yet; you approve the clean after you've seen it.",
                        installs.map(\.command) + ["mo clean --dry-run"],
                        steps: installs.map { "install \($0.recipe.name)" } + ["preview what would be removed"], risk: installs.isEmpty ? .low : .medium)
        }
        if t.contains("system info") || t.contains("mac version") {
            return plan("about this Mac", "Check your macOS version and processor.", ["sw_vers", "uname -m"])
        }
        if t.contains("git status") || t.contains("uncommitted") {
            return plan("check project changes", "Choose a project. I'll show its changed files.", ["git status --short --branch"], pick: "folder")
        }
        if let range = raw.range(of: #"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?"#, options: .regularExpression),
           ["clone", "download", "get this repo", "install"].contains(where: t.contains) {
            let url = String(raw[range]).trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return plan("download repository", "Choose where to save the project. I'll download it with Git.",
                        ["git clone -- \(shellQuote(url))"], pick: "folder", risk: .medium)
        }
        return nil
    }

    public struct PreparedPlan: Sendable {
        public var commands: [String]
        public var installs: [(label: String, command: String)]
        /// True when a step may ask for the Mac login password through the native dialog.
        public var asksForPassword: Bool
    }

    /// Add missing, known dependencies to the same reviewable plan, before approval.
    /// A Mac without Homebrew gets it installed as the first step instead of a dead end.
    public static func preparePlan(_ commands: [String], installed: (String) -> Bool = { ShellRunner.which($0) != nil }) throws -> PreparedPlan {
        guard !commands.isEmpty, commands.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw TerminalPlanError("I couldn't prepare any steps. Tell me what you'd like to do and I'll try again.")
        }
        if commands.contains(where: { $0.range(of: #"\{\{[^}]+\}\}"#, options: .regularExpression) != nil }) {
            throw TerminalPlanError("Choose the file or folder before running this job.")
        }
        var installs: [(String, String)] = []
        var added: Set<String> = []
        func add(_ recipe: SetupRecipe) {
            for step in SetupRecipes.installPlan(for: recipe, installed: installed) where !added.contains(step.command) && !commands.contains(step.command) {
                added.insert(step.command)
                installs.append(("install \(step.recipe.name)" + (step.recipe.id == "homebrew" ? " (asks for your Mac password)" : ""), step.command))
            }
        }
        for recipe in SetupRecipes.all where !installed(recipe.binary) {
            // Match executable positions, not filenames or words inside arguments.
            let pattern = #"(?:^|[;|&\n]\s*|\$\(\s*)\s*"# + NSRegularExpression.escapedPattern(for: recipe.binary) + #"(?:\s|$)"#
            if commands.contains(where: { $0.range(of: pattern, options: .regularExpression) != nil }) { add(recipe) }
        }
        let usesBrew = (commands + installs.map(\.1)).contains { $0.range(of: #"(?:^|[;&|\n]\s*)\s*brew\s"#, options: .regularExpression) != nil }
        if usesBrew, !installed("brew"), !added.contains(where: { $0.contains("Homebrew/install") }), let brew = SetupRecipes.recipe(id: "homebrew") {
            let steps = SetupRecipes.installPlan(for: brew, installed: installed)
            installs.insert(contentsOf: steps.map { ("install Homebrew (asks for your Mac password)", $0.command) }, at: 0)
        }
        let all = installs.map(\.1) + commands
        let password = all.contains { $0.range(of: #"(?:^|[;&|\n]\s*)\s*sudo\s"#, options: .regularExpression) != nil || $0.contains("Homebrew/install") }
        return PreparedPlan(commands: all, installs: installs.map { (label: $0.0, command: $0.1) }, asksForPassword: password)
    }

    public static func prepare(_ commands: [String], installed: (String) -> Bool = { ShellRunner.which($0) != nil }) throws -> [String] {
        try preparePlan(commands, installed: installed).commands
    }

    public static func script(_ commands: [String], progressMarker: String? = nil) -> String {
        (["set -o pipefail"] + commands.enumerated().flatMap { index, command -> [String] in
            var lines: [String] = []
            if let marker = progressMarker { lines.append("printf '\\036\(marker):start:\(index)\\037\\n'") }
            lines += ["printf '%s\\n' \(shellQuote("$ " + command))", "eval \(shellQuote(command))", "okidoki_step_code=$?"]
            if let marker = progressMarker { lines.append("printf '\\036\(marker):end:\(index):%s\\037\\n' \"$okidoki_step_code\"") }
            lines.append("if [ \"$okidoki_step_code\" -ne 0 ]; then exit \"$okidoki_step_code\"; fi")
            return lines
        }).joined(separator: "\n")
    }

    public struct Progress {
        public var output: String
        public var currentStep: Int
        public var completed: Set<Int>
        public var failed: Int?
    }

    /// Private frames distinguish progress from arbitrary command output, including lines starting with "$ ".
    public static func progress(in output: String, marker: String, commandCount: Int) -> Progress {
        let pattern = "\u{1e}" + NSRegularExpression.escapedPattern(for: marker) + #":(start|end):(\d+)(?::(\d+))?"# + "\u{1f}\n"
        let regex = try! NSRegularExpression(pattern: pattern)
        let range = NSRange(output.startIndex..., in: output)
        var progress = Progress(output: output, currentStep: 0, completed: [], failed: nil)
        for match in regex.matches(in: output, range: range) {
            guard let indexRange = Range(match.range(at: 2), in: output),
                  let index = Int(output[indexRange]), (0..<commandCount).contains(index) else { continue }
            progress.currentStep = index
            if let codeRange = Range(match.range(at: 3), in: output) {
                if output[codeRange] == "0" { progress.completed.insert(index) }
                else { progress.failed = index }
            }
        }
        progress.output = regex.stringByReplacingMatches(in: output, range: range, withTemplate: "")
        // A chunk may end inside a frame; don't expose that partial frame to the page.
        if let partial = progress.output.range(of: "\u{1e}" + marker, options: .backwards) {
            progress.output.removeSubrange(partial.lowerBound...)
        }
        progress.output = cleanOutput(progress.output)
        return progress
    }

    private static let ansiEscape = try! NSRegularExpression(pattern: "\u{1b}\\[[0-9;?]*[ -/]*[@-~]|\u{1b}\\][^\u{07}\u{1b}]*(?:\u{07}|\u{1b}\\\\)?|\u{1b}[@-Z\\\\-_]")

    /// Output as a person would see it in a terminal: colour codes gone, and progress bars that
    /// redraw a line with carriage returns reduced to the last thing drawn.
    public static func cleanOutput(_ output: String) -> String {
        guard output.contains("\u{1b}") || output.contains("\r") else { return output }
        var text = ansiEscape.stringByReplacingMatches(in: output, range: NSRange(output.startIndex..., in: output), withTemplate: "")
        guard text.contains("\r") else { return text }
        text = text.replacingOccurrences(of: "\r\n", with: "\n")
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
            guard let last = line.lastIndex(of: "\r") else { return line }
            return line[line.index(after: last)...]
        }.joined(separator: "\n")
    }

    // MARK: - Interactive tools

    private static let interactivePrograms: Set<String> = [
        "vim", "vi", "nvim", "nano", "emacs", "less", "more", "top", "htop", "btop", "man", "ssh", "tmux", "screen",
        "irb", "lua", "sqlite3", "psql", "mysql", "lazygit", "ranger", "nnn", "gdb", "lldb",
    ]

    /// True when a command is a chat UI, editor or full-screen tool that needs a real terminal window.
    public static func needsRealTerminal(_ command: String) -> Bool {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("|") else { return false }
        var words = trimmed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        while let first = words.first, first.contains("="), !first.hasPrefix("-") { words.removeFirst() }
        if words.first == "env" { words.removeFirst() }
        guard let program = words.first.map({ URL(fileURLWithPath: $0).lastPathComponent }) else { return false }
        let args = Array(words.dropFirst())
        if args.contains("--tui") { return true }
        if interactivePrograms.contains(program) { return true }
        switch program {
        case "claude": return !args.contains { ["-p", "--print", "-v", "--version", "-h", "--help", "update", "doctor", "install"].contains($0) }
        case "opencode": return args.isEmpty || !["run", "serve", "auth", "upgrade", "--version", "-v", "--help", "models", "export", "import", "web", "acp", "mcp", "agent", "session"].contains(args[0])
        case "omp": return !args.contains { ["-p", "--print", "--version", "-v", "-h", "--help", "update"].contains($0) }
        case "hermes":
            if args.isEmpty { return true }
            if args.contains(where: { ["-z", "--oneshot", "-q", "--query", "--version", "-V", "-h", "--help"].contains($0) }) { return false }
            return ["chat", "setup", "model", "tui", "login", "auth", "config", "gateway"].contains(args[0])
        case "duckdb": return !args.contains { ["-c", "-s", "-version", "--version", "-help", "--help"].contains($0) }
        case "gh": return args.prefix(2) == ["auth", "login"]
        // croc send waits for the other side and shows the code; age asks for a password; topgrade asks for the Mac password.
        case "croc": return args.contains("send")
        case "age": return args.contains { ["-p", "--passphrase"].contains($0) }
            || (args.contains { ["-d", "--decrypt"].contains($0) } && !args.contains { ["-i", "--identity"].contains($0) })
        case "topgrade": return !args.contains { ["--dry-run", "-n", "--help", "-h", "--version", "-V"].contains($0) }
        case "mo", "mole": return args.first.map { ["analyze", "status", "touchid", "uninstall", "optimize", "installer", "slim", "remove"].contains($0) && !args.contains("--dry-run") && !args.contains("-n") } ?? true
        case "ollama": return args.first == "run" && args.count == 2
        case "python", "python3", "node", "bun", "deno", "ruby":
            return args.isEmpty || args == ["repl"]
        default: return false
        }
    }

    /// A double-clickable script Terminal.app runs in its own window, so chat UIs and
    /// full-screen tools get a real terminal and the person sees everything.
    public static func launcherScript(title: String, commands: [String], workingDirectory: String) -> String {
        let body = commands.map { command in
            "printf '\\n%s\\n' \(shellQuote("$ " + command))\n\(command)\nokidoki_step_code=$?\nif [ \"$okidoki_step_code\" -ne 0 ]; then printf '\\nThat step stopped (exit %s). You can close this window.\\n' \"$okidoki_step_code\"; exit \"$okidoki_step_code\"; fi"
        }.joined(separator: "\n")
        return """
        #!/bin/zsh
        # okidoki · \(title)
        export PATH=\(shellQuote(ShellRunner.shared.pathEnvironment))":$PATH"
        export HOMEBREW_NO_AUTO_UPDATE=1
        export SUDO_ASKPASS=\(shellQuote(AskPass.path ?? ""))
        cd \(shellQuote(workingDirectory)) || exit 1
        clear
        printf 'okidoki · %s\\n' \(shellQuote(title))
        \(body)
        printf '\\nDone. You can close this window.\\n'
        """
    }

    // MARK: - Diagnosis

    public struct Diagnosis: Sendable, Equatable {
        /// Plain-language explanation, written for someone who has never used a terminal.
        public var message: String
        /// Commands that fix the cause, if the cause is known. Empty when the model (or the person) should decide.
        public var fixCommands: [String]
        public var fixLabels: [String]
        /// Whether the original steps should run again after the fix.
        public var retry: Bool
        public init(message: String, fixCommands: [String] = [], fixLabels: [String] = [], retry: Bool = false) {
            self.message = message; self.fixCommands = fixCommands; self.fixLabels = fixLabels; self.retry = retry
        }
    }

    /// Turn a failed step's output into something a person can act on without reading it.
    public static func diagnose(output: String, command: String, installed: (String) -> Bool = { ShellRunner.which($0) != nil }) -> Diagnosis {
        let lower = output.lowercased()
        let tail = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("$ ") }.suffix(3).joined(separator: "\n")
        if let name = firstCapture(in: output, patterns: [#"command not found: ([\w.+-]+)"#, #"(?:^|\s)([\w.+-]+): command not found"#, #"No such file or directory: '?([\w.+-]+)'?\s*$"#].prefix(2)) {
            if let recipe = SetupRecipes.recipe(forBinary: name) ?? SetupRecipes.match(in: name) {
                let steps = SetupRecipes.installPlan(for: recipe, installed: installed)
                return Diagnosis(message: "\(recipe.name) isn't installed yet, so that step couldn't run. I can install it and try again.",
                                 fixCommands: steps.map(\.command), fixLabels: steps.map { "install \($0.recipe.name)" }, retry: true)
            }
            return Diagnosis(message: "A tool called “\(name)” isn't installed, so that step couldn't run.")
        }
        if lower.contains("invalid active developer path") || lower.contains("xcode-select --install") || lower.contains("command line tools") && lower.contains("not installed") {
            return Diagnosis(message: "Apple's command line tools are missing. I'll open Apple's installer; click Install in the window that appears, wait for it to finish, then ask me again.",
                             fixCommands: ["xcode-select --install 2>&1 || true"], fixLabels: ["open Apple's installer"], retry: false)
        }
        if lower.contains("externally-managed-environment") {
            let rewritten = command.replacingOccurrences(of: #"\bpip3?\s+install\b"#, with: "pipx install", options: .regularExpression)
            let needs = SetupRecipes.installPlan(for: SetupRecipes.recipe(id: "pipx")!, installed: installed)
            return Diagnosis(message: "macOS protects its built-in Python, so pip refused. pipx installs Python apps safely; I'll use that instead.",
                             fixCommands: needs.map(\.command) + [rewritten], fixLabels: needs.map { "install \($0.recipe.name)" } + ["install with pipx"], retry: false)
        }
        if lower.contains("eacces") && lower.contains("npm") {
            return Diagnosis(message: "npm doesn't have permission to install there. Installing Node with Homebrew fixes that, so global installs go into a folder you own.",
                             fixCommands: ["brew install node"], fixLabels: ["install Node.js with Homebrew"], retry: true)
        }
        if lower.contains("no available formula") || lower.contains("no formulae or casks found") || lower.contains("no formulae found") {
            return Diagnosis(message: "Homebrew doesn't know a package by that name. The tool may be called something else; tell me what it does and I'll find it.")
        }
        if lower.contains("incorrect password attempts") || lower.contains("sudo: a password is required") || lower.contains("sudo: a terminal is required") || lower.contains("no askpass program") {
            return Diagnosis(message: "This step needs your Mac login password. Try again and type it in the dialog when it appears.", fixCommands: [], retry: true)
        }
        if lower.contains("could not resolve host") || lower.contains("network is unreachable") || lower.contains("failed to connect") || lower.contains("curl: (6)") || lower.contains("curl: (7)") || lower.contains("curl: (28)") || lower.contains("enotfound") || lower.contains("temporary failure in name resolution") {
            return Diagnosis(message: "This step needs the internet and couldn't reach it. Check your connection and try again.", retry: true)
        }
        if lower.contains("no space left on device") {
            return Diagnosis(message: "Your disk is full, so nothing more can be written. Ask me to free up space, then try again.")
        }
        if lower.contains("operation not permitted") {
            return Diagnosis(message: "macOS blocked access to a protected folder. Open System Settings → Privacy & Security → Full Disk Access and allow Okidoki, then try again.", retry: true)
        }
        if lower.contains("permission denied") {
            return Diagnosis(message: "A file or folder in this job isn't writable by you. Choose a folder inside your home folder (Desktop, Documents, Downloads) and try again.")
        }
        if lower.contains("no such file or directory") {
            return Diagnosis(message: "A file or folder this job expected doesn't exist. It may have moved; choose it again and I'll retry.")
        }
        if lower.contains("already exists") || lower.contains("file exists") {
            return Diagnosis(message: "The result already exists, so I didn't overwrite it. Move or rename the existing file if you want a fresh copy.")
        }
        if lower.contains("30 minute limit") {
            return Diagnosis(message: "This job ran for 30 minutes and was stopped. Try a smaller batch or ask me to run it in the background.")
        }
        return Diagnosis(message: tail.isEmpty ? "That step stopped without saying why." : "That step stopped. The last thing it said:\n\n\(tail)")
    }

    private static func firstCapture(in text: String, patterns: some Collection<String>) -> String? {
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: text) else { continue }
            return String(text[range])
        }
        return nil
    }
}

public struct TerminalPlanError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
