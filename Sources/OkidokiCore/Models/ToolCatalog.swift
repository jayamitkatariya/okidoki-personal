import Foundation

public enum ToolCatalog {
    public static let tools: [ToolSpec] = [
        ToolSpec(
            id: "mole",
            name: "Mole",
            command: "mo",
            replaces: "CleanMyMac",
            blurb: "Deep-cleans caches, logs, old installers and app leftovers. Visual disk explorer included.",
            examples: [
                "my mac is out of space",
                "clean my downloads folder",
                "what's taking up so much space?"
            ],
            installCommand: "brew install mole",
            checkCommand: "command -v mo || command -v mole",
            docs: """
            Mole is a CLI cleaner. Common commands:
              mo clean            deep clean caches, logs, trash
              mo clean --dry-run  preview what would be removed
              mo analyze          visual disk explorer
              mo status           live system health
              mo purge            remove project build artifacts
            Always run a dry run first. Never pass --force without the person's explicit approval.
            Run `sudo -v` before `mo clean` so system caches are included; okidoki shows a native password dialog.
            `mo analyze` and `mo status` are full-screen tools; they open in a Terminal window.
            Summarise the freed space in plain English; never dump raw terminal output into a card.
            """,
            license: "MIT",
            popularity: 96,
            category: "system"
        ),
        ToolSpec(
            id: "ffmpeg",
            name: "ffmpeg",
            command: "ffmpeg",
            replaces: "paid video converters",
            blurb: "Compress, trim, convert and stitch video. The quiet workhorse behind most editors.",
            examples: [
                "compress this video for discord",
                "turn this into a gif",
                "make a 1080p copy of this clip"
            ],
            installCommand: "brew install ffmpeg",
            checkCommand: "command -v ffmpeg",
            docs: """
            ffmpeg compresses video. Discord's free upload limit is 10 MB (25 MB for Nitro basic).
            A good Discord preset: scale to max 1280 wide, H.264, CRF 28, AAC 128k, +faststart:
              ffmpeg -i input.mp4 -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart output.mp4
            For a target size use two-pass or a bitrate cap. Always preserve the original file.
            """,
            license: "LGPL / GPL",
            popularity: 99,
            category: "video"
        ),
        ToolSpec(
            id: "handbrake",
            name: "HandBrake",
            command: "HandBrakeCLI",
            replaces: "paid video converters",
            blurb: "Batch-friendly video transcoding with presets that already know what they're doing.",
            examples: [
                "batch-convert these videos to 1080p",
                "make these videos smaller without losing quality"
            ],
            installCommand: "brew install --cask handbrake",
            checkCommand: "command -v HandBrakeCLI",
            docs: """
            HandBrakeCLI transcodes video:
              HandBrakeCLI -i input.mov -o output.mp4 --preset "Fast 1080p30"
            Use --preset-list to inspect presets. Batch in a loop, never delete originals.
            """,
            license: "GPL",
            popularity: 84,
            category: "video"
        ),
        ToolSpec(
            id: "pandoc",
            name: "Pandoc",
            command: "pandoc",
            replaces: "document converters",
            blurb: "Converts between Markdown, Word, PDF, slides, HTML and a hundred other formats.",
            examples: [
                "convert this to word",
                "turn this markdown into a pdf",
                "make slides from this outline"
            ],
            installCommand: "brew install pandoc",
            checkCommand: "command -v pandoc",
            docs: """
            Pandoc converts documents:
              pandoc input.md -o output.docx
              pandoc input.docx -o output.md
              pandoc input.md -o output.pdf --pdf-engine=typst
            PDF output needs a PDF engine (typst, wkhtmltopdf, LaTeX). If none is installed, produce .docx or .html.
            """,
            license: "GPL",
            popularity: 95,
            category: "documents"
        ),
        ToolSpec(
            id: "ocrmypdf",
            name: "OCRmyPDF",
            command: "ocrmypdf",
            replaces: "Acrobat text recognition",
            blurb: "Adds a searchable text layer to scans, straightening pages as it goes.",
            examples: [
                "make these scans searchable",
                "ocr this pdf",
                "can I search the text in this scan?"
            ],
            installCommand: "brew install ocrmypdf",
            checkCommand: "command -v ocrmypdf",
            docs: """
            OCRmyPDF adds a searchable layer:
              ocrmypdf --skip-text input.pdf output.pdf
            Use --skip-text so already-digital pages are left alone. It needs Tesseract; Homebrew installs it.
            Never overwrite the input file.
            """,
            license: "MPL-2.0",
            popularity: 88,
            category: "documents"
        ),
        ToolSpec(
            id: "imagemagick",
            name: "ImageMagick",
            command: "magick",
            replaces: "batch image editors",
            blurb: "Resize, convert, crop and annotate whole folders of images in one line.",
            examples: [
                "resize every image in this folder to 1600px",
                "convert these heic photos to jpg",
                "add a watermark to these images"
            ],
            installCommand: "brew install imagemagick",
            checkCommand: "command -v magick",
            docs: """
            ImageMagick 7 uses `magick`:
              magick mogrify -resize 1600x1600\\> -path out *.jpg
              magick mogrify -format jpg *.heic
            `mogrify` edits in place; use -path to write copies. Never modify originals without telling the person.
            """,
            license: "ImageMagick License",
            popularity: 90,
            category: "images"
        ),
        ToolSpec(
            id: "ollama",
            name: "Ollama",
            command: "ollama",
            replaces: "paid AI subscriptions",
            blurb: "Runs open models locally on your Mac. Private, offline, no per-token bill.",
            examples: [
                "run a model on my mac",
                "summarize this privately",
                "pull llama 3"
            ],
            installCommand: "brew install --cask ollama",
            checkCommand: "command -v ollama",
            docs: """
            Ollama runs local models:
              ollama pull llama3.2
              ollama run llama3.2 "summarise this"
            Keep models under ~8B on 16 GB machines. The daemon listens on 127.0.0.1:11434.
            """,
            license: "MIT",
            popularity: 92,
            category: "ai"
        ),
        ToolSpec(
            id: "rclone",
            name: "rclone",
            command: "rclone",
            replaces: "cloud sync apps",
            blurb: "Syncs almost any cloud drive from the terminal. One config for all of them.",
            examples: [
                "back up my desktop to google drive",
                "sync this folder to dropbox",
                "what's in my cloud drive?"
            ],
            installCommand: "brew install rclone",
            checkCommand: "command -v rclone",
            docs: """
            rclone syncs remotes:
              rclone copy ~/Desktop gdrive:Backups/Desktop --progress
              rclone listremotes
            Prefer `copy` over `sync` unless the person explicitly wants deletions mirrored.
            """,
            license: "MIT",
            popularity: 86,
            category: "cloud"
        ),
    ]

    public static func tool(id: String) -> ToolSpec? { tools.first { $0.id == id } }

    public static let paidAlternatives: [String: Double] = [
        "mole": 39.95,
        "ffmpeg": 79.0,
        "handbrake": 79.0,
        "pandoc": 49.0,
        "ocrmypdf": 239.88,
        "imagemagick": 69.0,
        "ollama": 240.0,
        "rclone": 59.0,
    ]

    public static let defaultConnectors: [Connector] = [
        Connector(id: "calendar", name: "Apple Calendar", kind: "apple",
                  blurb: "Read today's events and move things around without opening Calendar.",
                  installCommand: "osascript -l JavaScript -e 'Application(\"Calendar\").name()'",
                  docs: "Use Calendar.app via JXA. Never create an event without confirming date, time and title."),
        Connector(id: "reminders", name: "Apple Reminders", kind: "apple",
                  blurb: "Add reminders with a due date. Undo from the notch toast.",
                  installCommand: "osascript -l JavaScript -e 'Application(\"Reminders\").name()'",
                  docs: "Use Reminders.app via JXA. Return the reminder id so Okidoki can undo it."),
        Connector(id: "notes", name: "Apple Notes", kind: "apple",
                  blurb: "Drop a thought into Notes, with the source app attached.",
                  installCommand: "osascript -l JavaScript -e 'Application(\"Notes\").name()'",
                  docs: "Use Notes.app via JXA. Keep the note body plain text; include a small source line."),
        Connector(id: "apify", name: "Apify", kind: "cloud",
                  blurb: "Run ready-made scrapers and actors when a task needs live web data.",
                  installCommand: "",
                  docs: "Requires an Apify API key. Ask before starting any actor that costs credits."),
        Connector(id: "mcp", name: "MCP servers", kind: "mcp",
                  blurb: "Bring your existing model-context tools into Okidoki runs.",
                  installCommand: "",
                  docs: "MCP servers are configured in Settings → Keys and Toolbox. Always show which server a tool belongs to."),
    ]
}
