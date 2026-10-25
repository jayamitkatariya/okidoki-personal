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
            Plan `mo clean --dry-run` on its own. When it finishes, okidoki offers the real clean as a second approval,
            so never put `mo clean` in the same plan as the dry run. Never pass --force without the person's explicit approval.
            Run `sudo -v` before the real `mo clean` so system caches are included; okidoki shows a native password dialog.
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
            installCommand: "brew install handbrake",
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
        ToolSpec(
            id: "yt-dlp",
            name: "yt-dlp",
            command: "yt-dlp",
            replaces: "paid video downloaders",
            blurb: "Saves video or audio from YouTube and thousands of other sites.",
            examples: [
                "download this youtube video",
                "save the audio from this link as an mp3",
                "download this video in 1080p"
            ],
            installCommand: "brew install yt-dlp",
            checkCommand: "command -v yt-dlp",
            docs: """
            yt-dlp downloads video or audio from a link:
              yt-dlp -P "$HOME/Downloads" -o "%(title)s.%(ext)s" URL
              yt-dlp -x --audio-format mp3 -P "$HOME/Downloads" -o "%(title)s.%(ext)s" URL
              yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" -P "$HOME/Downloads" URL
            Merging video and audio needs ffmpeg. Save to Downloads unless the person says otherwise.
            Only download what the person has the right to save.
            """,
            license: "Unlicense",
            popularity: 95,
            category: "video"
        ),
        ToolSpec(
            id: "gifski",
            name: "gifski",
            command: "gifski",
            replaces: "paid GIF makers",
            blurb: "Turns video clips into crisp, small GIFs.",
            examples: [
                "turn this video into a gif",
                "make a gif from this screen recording",
                "make this gif smaller"
            ],
            installCommand: "brew install gifski",
            checkCommand: "command -v gifski",
            docs: """
            gifski turns a video into a high-quality GIF:
              gifski --fps 12 --width 640 -o output.gif input.mp4
            Lower --fps, --width or --quality (1-100) to make the file smaller.
            Write the GIF next to the original; never overwrite it.
            """,
            license: "AGPL-3.0",
            popularity: 80,
            category: "video"
        ),
        ToolSpec(
            id: "sox",
            name: "SoX",
            command: "sox",
            replaces: "paid audio editors",
            blurb: "Trims, converts, joins and evens out the volume of audio files.",
            examples: [
                "convert this audio to mp3",
                "trim this recording to the first minute",
                "make these recordings the same volume"
            ],
            installCommand: "brew install sox",
            checkCommand: "command -v sox",
            docs: """
            SoX edits and converts audio:
              sox input.wav output.mp3
              sox input.mp3 first-minute.mp3 trim 0 60
              sox input.wav louder.wav norm -1
              sox first.wav second.wav joined.wav
            Always write a new file; never overwrite the input.
            """,
            license: "GPL / LGPL",
            popularity: 78,
            category: "audio"
        ),
        ToolSpec(
            id: "whisper",
            name: "whisper.cpp",
            command: "whisper-cli",
            replaces: "paid transcription services",
            blurb: "Transcribes recordings on your Mac. Private, offline, no per-minute bill.",
            examples: [
                "transcribe this recording",
                "turn this meeting audio into text",
                "make subtitles for this video"
            ],
            installCommand: "brew install whisper.cpp",
            checkCommand: "command -v whisper-cli",
            docs: """
            whisper.cpp transcribes speech on this Mac. The command is whisper-cli.
            It needs a model file once (about 150 MB); say so in the preview:
              mkdir -p "$HOME/.okidoki/models"
              curl -L --fail -o "$HOME/.okidoki/models/ggml-base.en.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
            Convert audio or video to 16 kHz WAV first, then transcribe:
              ffmpeg -nostdin -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le input-16k.wav
              whisper-cli -m "$HOME/.okidoki/models/ggml-base.en.bin" -f input-16k.wav -otxt -of transcript
            Use -osrt instead of -otxt for subtitles. For other languages, download ggml-base.bin (no .en) instead.
            """,
            license: "MIT",
            popularity: 90,
            category: "ai"
        ),
        ToolSpec(
            id: "pngquant",
            name: "pngquant",
            command: "pngquant",
            replaces: "image compressors like TinyPNG",
            blurb: "Shrinks PNGs by 60-80% with barely visible quality loss.",
            examples: [
                "make these pngs smaller",
                "compress this screenshot",
                "shrink images for my website"
            ],
            installCommand: "brew install pngquant",
            checkCommand: "command -v pngquant",
            docs: """
            pngquant shrinks PNGs with near-invisible quality loss:
              pngquant --quality=65-85 --skip-if-larger --ext -small.png image.png
              pngquant --quality=65-85 --skip-if-larger --ext -small.png *.png
            --ext writes copies next to the originals. Never use --force or --ext .png; they overwrite the originals.
            """,
            license: "GPL-3.0",
            popularity: 82,
            category: "images"
        ),
        ToolSpec(
            id: "oxipng",
            name: "oxipng",
            command: "oxipng",
            replaces: "lossless PNG optimizers",
            blurb: "Shrinks PNGs without changing a single pixel.",
            examples: [
                "optimize these pngs without losing quality",
                "losslessly compress this image"
            ],
            installCommand: "brew install oxipng",
            checkCommand: "command -v oxipng",
            docs: """
            oxipng shrinks PNGs losslessly:
              oxipng -o 4 --strip safe --out image-small.png image.png
              oxipng -o 4 --strip safe --dir small *.png
            Without --out or --dir it rewrites files in place, so always pass one.
            """,
            license: "MIT",
            popularity: 70,
            category: "images"
        ),
        ToolSpec(
            id: "exiftool",
            name: "ExifTool",
            command: "exiftool",
            replaces: "photo metadata editors",
            blurb: "Shows and removes hidden photo data like location, camera and dates.",
            examples: [
                "remove location from these photos",
                "which camera took this photo",
                "strip metadata before I share this"
            ],
            installCommand: "brew install exiftool",
            checkCommand: "command -v exiftool",
            docs: """
            ExifTool reads and removes photo and video metadata:
              exiftool -gps:all photo.jpg
              exiftool -gps:all= photo.jpg
              exiftool -all= -tagsfromfile @ -orientation photo.jpg
              exiftool -r -gps:all= folder
            Removing tags keeps a photo.jpg_original backup next to each file; that's the undo.
            Never pass -overwrite_original unless the person asks for it.
            """,
            license: "Artistic / GPL",
            popularity: 88,
            category: "images"
        ),
        ToolSpec(
            id: "webp",
            name: "WebP",
            command: "cwebp",
            replaces: "image format converters",
            blurb: "Converts images to WebP, a fraction of the size for websites.",
            examples: [
                "convert these images to webp",
                "turn this webp into a png"
            ],
            installCommand: "brew install webp",
            checkCommand: "command -v cwebp",
            docs: """
            cwebp converts images to WebP; dwebp converts back:
              cwebp -q 80 image.png -o image.webp
              dwebp image.webp -o image.png
            For a folder, loop over the files and write each copy next to its original.
            """,
            license: "BSD-3-Clause",
            popularity: 72,
            category: "images"
        ),
        ToolSpec(
            id: "qpdf",
            name: "qpdf",
            command: "qpdf",
            replaces: "Acrobat page tools",
            blurb: "Merges, splits, rotates and unlocks PDFs without touching quality.",
            examples: [
                "merge these pdfs",
                "split this pdf into pages",
                "rotate page 3 of this pdf"
            ],
            installCommand: "brew install qpdf",
            checkCommand: "command -v qpdf",
            docs: """
            qpdf merges, splits, rotates and unlocks PDFs without re-encoding them:
              qpdf --empty --pages a.pdf b.pdf -- merged.pdf
              qpdf input.pdf --pages . 1-3 -- first-three.pdf
              qpdf --split-pages input.pdf page-%d.pdf
              qpdf input.pdf --rotate=+90:3 rotated.pdf
              qpdf --decrypt locked.pdf unlocked.pdf
            Always write a new file. If a PDF needs a password to open, say so; never guess one.
            """,
            license: "Apache-2.0",
            popularity: 84,
            category: "documents"
        ),
        ToolSpec(
            id: "ghostscript",
            name: "Ghostscript",
            command: "gs",
            replaces: "PDF compressors",
            blurb: "Shrinks heavy PDFs so they fit in an email.",
            examples: [
                "compress this pdf",
                "make this pdf small enough to email"
            ],
            installCommand: "brew install ghostscript",
            checkCommand: "command -v gs",
            docs: """
            Ghostscript compresses PDFs. The command is gs:
              gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -dQUIET -sOutputFile=small.pdf input.pdf
            /screen is smallest, /ebook is a good default, /printer keeps more detail.
            Write a new file and report both sizes.
            """,
            license: "AGPL-3.0",
            popularity: 86,
            category: "documents"
        ),
        ToolSpec(
            id: "poppler",
            name: "Poppler",
            command: "pdftotext",
            replaces: "PDF text extractors",
            blurb: "Pulls the text, images and details out of any PDF.",
            examples: [
                "get the text out of this pdf",
                "save every image from this pdf"
            ],
            installCommand: "brew install poppler",
            checkCommand: "command -v pdftotext",
            docs: """
            Poppler reads what's inside a PDF:
              pdftotext -layout input.pdf output.txt
              mkdir -p images && pdfimages -all input.pdf images/img
              pdfinfo input.pdf
              pdfunite a.pdf b.pdf merged.pdf
            Never overwrite the input PDF.
            """,
            license: "GPL",
            popularity: 80,
            category: "documents"
        ),
        ToolSpec(
            id: "typst",
            name: "Typst",
            command: "typst",
            replaces: "paid typesetting apps",
            blurb: "Turns simple markup into polished PDFs. Also gives Pandoc a PDF engine.",
            examples: [
                "make a pdf from this outline",
                "turn my notes into a nicely formatted pdf"
            ],
            installCommand: "brew install typst",
            checkCommand: "command -v typst",
            docs: """
            Typst compiles a markup file to PDF:
              typst compile document.typ document.pdf
            It's also a PDF engine for Pandoc:
              pandoc input.md -o output.pdf --pdf-engine=typst
            Write the .typ file next to where the PDF should go.
            """,
            license: "Apache-2.0",
            popularity: 76,
            category: "documents"
        ),
        ToolSpec(
            id: "czkawka",
            name: "Czkawka",
            command: "czkawka_cli",
            replaces: "Gemini 2",
            blurb: "Finds duplicate files, similar photos and the biggest space hogs.",
            examples: [
                "find duplicate files",
                "find similar photos in my pictures",
                "what are my biggest files"
            ],
            installCommand: "brew install czkawka",
            checkCommand: "command -v czkawka_cli",
            docs: """
            Czkawka finds duplicates. The command is czkawka_cli:
              czkawka_cli dup --directories "$HOME/Pictures" --file-to-save "$HOME/Downloads/duplicates.txt"
              czkawka_cli image --directories "$HOME/Pictures" --file-to-save "$HOME/Downloads/similar-photos.txt"
              czkawka_cli big --directories "$HOME" --file-to-save "$HOME/Downloads/biggest-files.txt"
            List results first and summarise them. Never pass --delete-method in the same plan;
            deleting is a separate, high-risk plan the person approves after seeing the list.
            """,
            license: "MIT",
            popularity: 83,
            category: "files"
        ),
        ToolSpec(
            id: "sevenzip",
            name: "7-Zip",
            command: "7zz",
            replaces: "paid archive apps",
            blurb: "Makes and opens .7z and .zip archives with strong compression.",
            examples: [
                "make a 7z of this folder",
                "compress this folder as small as possible",
                "extract this 7z file"
            ],
            installCommand: "brew install sevenzip",
            checkCommand: "command -v 7zz",
            docs: """
            7-Zip makes and opens archives. The command is 7zz:
              7zz a archive.7z folder
              7zz a -tzip archive.zip folder
              7zz x archive.7z -ooutput
              7zz l archive.7z
            Extract into a new folder so nothing existing is overwritten.
            """,
            license: "LGPL-2.1",
            popularity: 85,
            category: "files"
        ),
        ToolSpec(
            id: "unar",
            name: "unar",
            command: "unar",
            replaces: "RAR extractors",
            blurb: "Opens RAR, 7z, ISO and old Mac archives with one command.",
            examples: [
                "open this rar file",
                "extract this archive"
            ],
            installCommand: "brew install unar",
            checkCommand: "command -v unar",
            docs: """
            unar extracts almost any archive; lsar lists one:
              unar -r -o output archive.rar
              lsar archive.rar
            -r renames instead of asking when a file exists. Never pass -f, which overwrites.
            """,
            license: "LGPL-2.1",
            popularity: 74,
            category: "files"
        ),
        ToolSpec(
            id: "duckdb",
            name: "DuckDB",
            command: "duckdb",
            replaces: "Excel for huge spreadsheets",
            blurb: "Answers questions about CSV, Excel and Parquet files with SQL, even huge ones.",
            examples: [
                "total this csv by region",
                "filter this giant csv to 2025 rows",
                "this spreadsheet is too big for excel"
            ],
            installCommand: "brew install duckdb",
            checkCommand: "command -v duckdb",
            docs: """
            DuckDB runs SQL directly on CSV, Parquet, JSON and Excel files:
              duckdb -c "SELECT * FROM 'sales.csv' LIMIT 10"
              duckdb -c "SELECT region, sum(total) FROM 'sales.csv' GROUP BY region ORDER BY 2 DESC"
              duckdb -c "COPY (SELECT * FROM 'big.csv' WHERE year = 2025) TO 'filtered.csv' (HEADER)"
            Excel files: duckdb -c "INSTALL excel; LOAD excel; SELECT * FROM read_xlsx('file.xlsx') LIMIT 10"
            Always pass -c with a query; plain duckdb opens an interactive shell in a Terminal window.
            """,
            license: "MIT",
            popularity: 81,
            category: "data"
        ),
        ToolSpec(
            id: "mas",
            name: "mas",
            command: "mas",
            replaces: "clicking through the App Store",
            blurb: "Updates and installs Mac App Store apps from one command.",
            examples: [
                "update all my app store apps",
                "which app store apps need updates"
            ],
            installCommand: "brew install mas",
            checkCommand: "command -v mas",
            docs: """
            mas manages Mac App Store apps. The person must be signed in to the App Store app:
              mas list
              mas outdated
              mas upgrade
              mas search "app name"
              mas install APP_ID
            Only install free apps or ones the person already owns. Never buy anything.
            """,
            license: "MIT",
            popularity: 77,
            category: "system"
        ),
        ToolSpec(
            id: "restic",
            name: "restic",
            command: "restic",
            replaces: "paid backup apps",
            blurb: "Encrypted, versioned backups to a drive or cloud storage.",
            examples: [
                "back up my documents to my external drive",
                "restore yesterday's version of this folder"
            ],
            installCommand: "brew install restic",
            checkCommand: "command -v restic",
            docs: """
            restic makes encrypted, versioned backups:
              restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" init
              restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" backup "$HOME/Documents"
              restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" snapshots
              restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" restore latest --target "$HOME/Restored"
            The person creates the password file themselves; never put a password in a command.
            Never run forget or prune without explicit approval; they delete old backups.
            """,
            license: "BSD-2-Clause",
            popularity: 79,
            category: "cloud"
        ),
        ToolSpec(
            id: "gh",
            name: "GitHub CLI",
            command: "gh",
            replaces: "paid Git clients",
            blurb: "Issues, pull requests and repos without opening the browser.",
            examples: [
                "list my open pull requests",
                "clone this github repo",
                "show the open issues on this repo"
            ],
            installCommand: "brew install gh",
            checkCommand: "command -v gh",
            docs: """
            GitHub CLI works with repositories, issues and pull requests:
              gh auth status
              gh repo clone owner/name
              gh issue list --repo owner/name
              gh pr list --repo owner/name
              gh pr view 123 --repo owner/name
            gh auth login is interactive and opens in a Terminal window.
            Never merge, close or delete anything without approval.
            """,
            license: "MIT",
            popularity: 89,
            category: "dev"
        ),
        ToolSpec(
            id: "tesseract",
            name: "Tesseract",
            command: "tesseract",
            replaces: "TextSniper",
            blurb: "Copies the text out of screenshots, photos and scans.",
            examples: [
                "copy the text out of this screenshot",
                "read the text in this photo",
                "turn this image into text"
            ],
            installCommand: "brew install tesseract",
            checkCommand: "command -v tesseract",
            docs: """
            Tesseract reads text in images:
              tesseract screenshot.png -
              tesseract photo.jpg photo-text
            The first prints the text; the second writes photo-text.txt next to the image.
            English is included. Other languages need "brew install tesseract-lang", then -l fra, -l deu or -l eng+spa.
            For PDFs use OCRmyPDF instead.
            """,
            license: "Apache-2.0",
            popularity: 88,
            category: "documents"
        ),
        ToolSpec(
            id: "qrencode",
            name: "qrencode",
            command: "qrencode",
            replaces: "paid QR code generators",
            blurb: "Makes QR codes for links, text and Wi-Fi as PNG or SVG.",
            examples: [
                "make a qr code for this link",
                "make a qr code for my wifi",
                "make a printable qr code"
            ],
            installCommand: "brew install qrencode",
            checkCommand: "command -v qrencode",
            docs: """
            qrencode makes QR codes:
              qrencode -o "$HOME/Downloads/qr.png" -s 10 -m 2 "https://example.com"
              qrencode -t SVG -o "$HOME/Downloads/qr.svg" "https://example.com"
              qrencode -o "$HOME/Downloads/wifi-qr.png" -s 10 "WIFI:T:WPA;S:NetworkName;P:password;;"
            -s sets the size of each dot. Use SVG for print. Don't overwrite an existing file.
            """,
            license: "LGPL-2.1",
            popularity: 78,
            category: "images"
        ),
        ToolSpec(
            id: "zbar",
            name: "zbar",
            command: "zbarimg",
            replaces: "QR code scanner apps",
            blurb: "Reads QR codes and barcodes from images and screenshots.",
            examples: [
                "what does this qr code say",
                "read the barcode in this photo"
            ],
            installCommand: "brew install zbar",
            checkCommand: "command -v zbarimg",
            docs: """
            zbarimg reads QR codes and barcodes in an image (the command is zbarimg):
              zbarimg -q --raw screenshot.png
            Read-only. If a QR code holds a link, show the link and don't open it unless the person asks.
            """,
            license: "LGPL-2.1",
            popularity: 70,
            category: "images"
        ),
        ToolSpec(
            id: "img2pdf",
            name: "img2pdf",
            command: "img2pdf",
            replaces: "paid JPG to PDF tools",
            blurb: "Turns photos and scans into one PDF without losing quality.",
            examples: [
                "turn these photos into one pdf",
                "make a pdf from these scans",
                "combine these images into a pdf"
            ],
            installCommand: "brew install img2pdf",
            checkCommand: "command -v img2pdf",
            docs: """
            img2pdf puts images into a PDF without re-encoding them:
              img2pdf page1.jpg page2.jpg -o scans.pdf
              img2pdf *.jpg --pagesize A4 -o photos.pdf
            HEIC isn't supported; make JPEG copies first with: sips -s format jpeg photo.heic --out photo.jpg
            PNGs with transparency fail; flatten them with ImageMagick first. Never overwrite an existing PDF.
            """,
            license: "LGPL-3.0",
            popularity: 75,
            category: "documents"
        ),
        ToolSpec(
            id: "jpegoptim",
            name: "jpegoptim",
            command: "jpegoptim",
            replaces: "JPEG compressors",
            blurb: "Makes photos smaller with little visible change.",
            examples: [
                "make these jpegs smaller",
                "compress these photos for email",
                "shrink photos for my website"
            ],
            installCommand: "brew install jpegoptim",
            checkCommand: "command -v jpegoptim",
            docs: """
            jpegoptim shrinks JPEGs. It edits files in place by default, so always write copies with --dest:
              mkdir -p smaller
              jpegoptim --max=85 --strip-all --dest=smaller *.jpg
            --max sets the quality (lower is smaller). --strip-all also removes metadata such as location.
            Never run it without --dest unless the person asks to change the originals.
            """,
            license: "GPL-3.0",
            popularity: 74,
            category: "images"
        ),
        ToolSpec(
            id: "croc",
            name: "croc",
            command: "croc",
            replaces: "WeTransfer Pro",
            blurb: "Sends files to another computer, encrypted, with no size limit.",
            examples: [
                "send this file to my other computer",
                "send this folder to a friend",
                "receive a file with a code"
            ],
            installCommand: "brew install croc",
            checkCommand: "command -v croc",
            docs: """
            croc sends files between computers with a one-time code:
              croc send "$HOME/Desktop/report.pdf"
            Sending prints a code phrase and waits for the other side, so it opens in a Terminal window.
            The other computer runs croc too, with the code (never put the code on the command line itself):
              CROC_SECRET="code-phrase" croc --yes --out "$HOME/Downloads"
            Only send what the person chose. Tell them the transfer is end-to-end encrypted.
            """,
            license: "MIT",
            popularity: 80,
            category: "files"
        ),
        ToolSpec(
            id: "age",
            name: "age",
            command: "age",
            replaces: "paid file encryption apps",
            blurb: "Locks files with a password or key, simply and securely.",
            examples: [
                "encrypt this file with a password",
                "decrypt this file",
                "lock this folder before I upload it"
            ],
            installCommand: "brew install age",
            checkCommand: "command -v age",
            docs: """
            age encrypts files. With a password it asks for it in a Terminal window:
              age -p -o report.pdf.age report.pdf
              age -d -o report.pdf report.pdf.age
            For a folder, make an archive first: tar -czf folder.tar.gz folder
            Never put a password in a command. Keep the original until the person confirms they can decrypt the copy.
            """,
            license: "BSD-3-Clause",
            popularity: 72,
            category: "security"
        ),
        ToolSpec(
            id: "smartmontools",
            name: "smartmontools",
            command: "smartctl",
            replaces: "DriveDx",
            blurb: "Checks the health of your Mac's drive and external disks.",
            examples: [
                "is my drive healthy",
                "check my ssd health",
                "how worn out is my disk"
            ],
            installCommand: "brew install smartmontools",
            checkCommand: "command -v smartctl",
            docs: """
            smartctl reads a drive's health report (the command is smartctl):
              diskutil list
              smartctl -H disk0
              smartctl -a disk0
            -H gives pass or fail. -a gives detail; explain "Percentage Used", "Available Spare" and "Media and Data Integrity Errors" in plain English.
            Read-only. Some external drives don't report health data; say so plainly.
            """,
            license: "GPL-2.0",
            popularity: 76,
            category: "system"
        ),
        ToolSpec(
            id: "switchaudio",
            name: "SwitchAudio",
            command: "SwitchAudioSource",
            replaces: "SoundSource",
            blurb: "Switches your sound output or microphone from one command.",
            examples: [
                "switch the sound to my airpods",
                "play sound through my speakers",
                "which audio output am i using"
            ],
            installCommand: "brew install switchaudio-osx",
            checkCommand: "command -v SwitchAudioSource",
            docs: """
            SwitchAudioSource changes the sound device:
              SwitchAudioSource -a -t output
              SwitchAudioSource -c
              SwitchAudioSource -t output -s "AirPods Pro"
              SwitchAudioSource -t input -s "MacBook Pro Microphone"
            List devices first and use the exact name. Say which device was active before, so it's easy to switch back.
            """,
            license: "MIT",
            popularity: 68,
            category: "system"
        ),
        ToolSpec(
            id: "topgrade",
            name: "topgrade",
            command: "topgrade",
            replaces: "MacUpdater",
            blurb: "Updates Homebrew, App Store apps and your other tools in one go.",
            examples: [
                "update everything on my mac",
                "update all my apps and tools"
            ],
            installCommand: "brew install topgrade",
            checkCommand: "command -v topgrade",
            docs: """
            topgrade updates everything it finds: Homebrew, App Store apps (with mas), npm, pip and more:
              topgrade --dry-run
              topgrade --yes
            Show the dry run first. The real update asks for the Mac password and runs for a while, so it opens in a Terminal window.
            It installs updates, so it always needs approval.
            """,
            license: "GPL-3.0",
            popularity: 73,
            category: "system"
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
        "yt-dlp": 45.0,
        "gifski": 15.0,
        "sox": 35.0,
        "whisper": 100.0,
        "pngquant": 39.0,
        "oxipng": 15.0,
        "exiftool": 20.0,
        "webp": 15.0,
        "qpdf": 80.0,
        "ghostscript": 6.0,
        "czkawka": 20.0,
        "sevenzip": 25.0,
        "duckdb": 100.0,
        "restic": 60.0,
        "gh": 69.0,
        "tesseract": 8.0,
        "qrencode": 30.0,
        "img2pdf": 10.0,
        "jpegoptim": 15.0,
        "croc": 120.0,
        "age": 20.0,
        "smartmontools": 20.0,
        "topgrade": 15.0,
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
        // On by default when the build ships an Apify key; otherwise it stays off until one is added in Settings › Keys.
        Connector(id: "apify", name: "Apify", kind: "cloud",
                  blurb: "Live web data: Google, LinkedIn, Instagram, TikTok, X, YouTube, Reddit, Amazon, Maps, Airbnb, Zillow and any site's text.",
                  enabled: !ServiceSecrets.apify.isEmpty, installed: !ServiceSecrets.apify.isEmpty,
                  installCommand: "",
                  docs: "Uses the Apify key the build ships (APIFY_API_KEY), or one added in Settings › Keys. Runs actors through the brain's connector kind; always preview first, since actors cost credits."),
        Connector(id: "mcp", name: "MCP servers", kind: "mcp",
                  blurb: "Bring your existing model-context tools into Okidoki runs.",
                  installCommand: "",
                  docs: "Add servers in Toolbox › MCP servers; their secrets stay on the Mac. Always show which server a tool belongs to."),
    ]
}
