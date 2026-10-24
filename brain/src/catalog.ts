import type { ToolSpec } from "./types";

export const tools: ToolSpec[] = [
  {
    id: "mole",
    name: "Mole",
    command: "mo",
    replaces: "CleanMyMac",
    blurb: "Deep-cleans caches, logs, old installers and app leftovers. Visual disk explorer included.",
    examples: ["my mac is out of space", "clean my downloads folder", "what's taking up so much space?"],
    installCommand: "brew install mole",
    docs: `Mole is a CLI cleaner. Commands:
mo clean            deep clean caches, logs, trash
mo clean --dry-run  preview what would be removed
mo analyze          visual disk explorer
mo status           live system health
mo purge            remove project build artifacts
Plan "mo clean --dry-run" on its own. When it finishes, okidoki offers the real clean as a second approval, so never put "mo clean" in the same plan as the dry run.
Never pass --force without approval. Summarise freed space in plain English.
Run "sudo -v" before the real "mo clean" so system caches are included; okidoki shows a native password dialog.
"mo analyze" and "mo status" are full-screen tools; okidoki opens them in a Terminal window.`,
    license: "MIT",
    category: "system",
  },
  {
    id: "ffmpeg",
    name: "ffmpeg",
    command: "ffmpeg",
    replaces: "paid video converters",
    blurb: "Compress, trim, convert and stitch video.",
    examples: ["compress this video for discord", "turn this into a gif", "make a 1080p copy of this clip"],
    installCommand: "brew install ffmpeg",
    docs: `ffmpeg compresses video. Discord free upload is 10 MB (25 MB Nitro basic).
Good preset: scale max 1280 wide, H.264, CRF 28, AAC 128k, faststart:
ffmpeg -i input.mp4 -vf "scale='min(1280,iw)':-2" -c:v libx264 -crf 28 -preset medium -c:a aac -b:a 128k -movflags +faststart output.mp4
Always preserve the original.`,
    license: "LGPL / GPL",
    category: "video",
  },
  {
    id: "pandoc",
    name: "Pandoc",
    command: "pandoc",
    replaces: "document converters",
    blurb: "Converts between Markdown, Word, PDF, slides and HTML.",
    examples: ["convert this to word", "turn this markdown into a pdf", "make slides from this outline"],
    installCommand: "brew install pandoc",
    docs: `pandoc input.md -o output.docx
pandoc input.docx -o output.md
PDF output needs a PDF engine. If none is installed, produce .docx or .html.`,
    license: "GPL",
    category: "documents",
  },
  {
    id: "ocrmypdf",
    name: "OCRmyPDF",
    command: "ocrmypdf",
    replaces: "Acrobat text recognition",
    blurb: "Adds a searchable text layer to scans.",
    examples: ["make these scans searchable", "ocr this pdf", "can I search this scan?"],
    installCommand: "brew install ocrmypdf",
    docs: `ocrmypdf --skip-text input.pdf output.pdf
Use --skip-text so digital pages are left alone. Never overwrite the input.`,
    license: "MPL-2.0",
    category: "documents",
  },
  {
    id: "imagemagick",
    name: "ImageMagick",
    command: "magick",
    replaces: "batch image editors",
    blurb: "Resize, convert, crop and annotate folders of images.",
    examples: ["resize every image to 1600px", "convert these heic photos to jpg", "add a watermark"],
    installCommand: "brew install imagemagick",
    docs: `ImageMagick 7 uses magick:
magick mogrify -resize 1600x1600\\> -path out *.jpg
magick mogrify -format jpg *.heic
Use -path to write copies. Never modify originals without telling the person.`,
    license: "ImageMagick License",
    category: "images",
  },
  {
    id: "ollama",
    name: "Ollama",
    command: "ollama",
    replaces: "paid AI subscriptions",
    blurb: "Runs open models locally on your Mac.",
    examples: ["run a model on my mac", "summarize this privately", "pull llama 3"],
    installCommand: "brew install --cask ollama",
    docs: `ollama pull llama3.2
ollama run llama3.2 "summarise this"
Daemon listens on 127.0.0.1:11434. Keep models under ~8B on 16 GB machines.`,
    license: "MIT",
    category: "ai",
  },
  {
    id: "rclone",
    name: "rclone",
    command: "rclone",
    replaces: "cloud sync apps",
    blurb: "Syncs almost any cloud drive from the terminal.",
    examples: ["back up my desktop to google drive", "sync this folder to dropbox"],
    installCommand: "brew install rclone",
    docs: `rclone copy ~/Desktop gdrive:Backups/Desktop --progress
rclone listremotes
Prefer copy over sync unless deletions are explicitly wanted.`,
    license: "MIT",
    category: "cloud",
  },
  {
    id: "handbrake",
    name: "HandBrake",
    command: "HandBrakeCLI",
    replaces: "paid video converters",
    blurb: "Batch-friendly video transcoding with presets.",
    examples: ["batch convert these videos to 1080p", "make these videos smaller"],
    installCommand: "brew install --cask handbrake",
    docs: `HandBrakeCLI -i input.mov -o output.mp4 --preset "Fast 1080p30"
Never delete originals.`,
    license: "GPL",
    category: "video",
  },
  {
    id: "yt-dlp",
    name: "yt-dlp",
    command: "yt-dlp",
    replaces: "paid video downloaders",
    blurb: "Saves video or audio from YouTube and thousands of other sites.",
    examples: ["download this youtube video", "save the audio from this link as an mp3", "download this video in 1080p"],
    installCommand: "brew install yt-dlp",
    docs: `yt-dlp downloads video or audio from a link:
  yt-dlp -P "$HOME/Downloads" -o "%(title)s.%(ext)s" URL
  yt-dlp -x --audio-format mp3 -P "$HOME/Downloads" -o "%(title)s.%(ext)s" URL
  yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]" -P "$HOME/Downloads" URL
Merging video and audio needs ffmpeg. Save to Downloads unless the person says otherwise.
Only download what the person has the right to save.`,
    license: "Unlicense",
    category: "video",
  },
  {
    id: "gifski",
    name: "gifski",
    command: "gifski",
    replaces: "paid GIF makers",
    blurb: "Turns video clips into crisp, small GIFs.",
    examples: ["turn this video into a gif", "make a gif from this screen recording", "make this gif smaller"],
    installCommand: "brew install gifski",
    docs: `gifski turns a video into a high-quality GIF:
  gifski --fps 12 --width 640 -o output.gif input.mp4
Lower --fps, --width or --quality (1-100) to make the file smaller.
Write the GIF next to the original; never overwrite it.`,
    license: "AGPL-3.0",
    category: "video",
  },
  {
    id: "sox",
    name: "SoX",
    command: "sox",
    replaces: "paid audio editors",
    blurb: "Trims, converts, joins and evens out the volume of audio files.",
    examples: ["convert this audio to mp3", "trim this recording to the first minute", "make these recordings the same volume"],
    installCommand: "brew install sox",
    docs: `SoX edits and converts audio:
  sox input.wav output.mp3
  sox input.mp3 first-minute.mp3 trim 0 60
  sox input.wav louder.wav norm -1
  sox first.wav second.wav joined.wav
Always write a new file; never overwrite the input.`,
    license: "GPL / LGPL",
    category: "audio",
  },
  {
    id: "whisper",
    name: "whisper.cpp",
    command: "whisper-cli",
    replaces: "paid transcription services",
    blurb: "Transcribes recordings on your Mac. Private, offline, no per-minute bill.",
    examples: ["transcribe this recording", "turn this meeting audio into text", "make subtitles for this video"],
    installCommand: "brew install whisper.cpp",
    docs: `whisper.cpp transcribes speech on this Mac. The command is whisper-cli.
It needs a model file once (about 150 MB); say so in the preview:
  mkdir -p "$HOME/.okidoki/models"
  curl -L --fail -o "$HOME/.okidoki/models/ggml-base.en.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
Convert audio or video to 16 kHz WAV first, then transcribe:
  ffmpeg -nostdin -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le input-16k.wav
  whisper-cli -m "$HOME/.okidoki/models/ggml-base.en.bin" -f input-16k.wav -otxt -of transcript
Use -osrt instead of -otxt for subtitles. For other languages, download ggml-base.bin (no .en) instead.`,
    license: "MIT",
    category: "ai",
  },
  {
    id: "pngquant",
    name: "pngquant",
    command: "pngquant",
    replaces: "image compressors like TinyPNG",
    blurb: "Shrinks PNGs by 60-80% with barely visible quality loss.",
    examples: ["make these pngs smaller", "compress this screenshot", "shrink images for my website"],
    installCommand: "brew install pngquant",
    docs: `pngquant shrinks PNGs with near-invisible quality loss:
  pngquant --quality=65-85 --skip-if-larger --ext -small.png image.png
  pngquant --quality=65-85 --skip-if-larger --ext -small.png *.png
--ext writes copies next to the originals. Never use --force or --ext .png; they overwrite the originals.`,
    license: "GPL-3.0",
    category: "images",
  },
  {
    id: "oxipng",
    name: "oxipng",
    command: "oxipng",
    replaces: "lossless PNG optimizers",
    blurb: "Shrinks PNGs without changing a single pixel.",
    examples: ["optimize these pngs without losing quality", "losslessly compress this image"],
    installCommand: "brew install oxipng",
    docs: `oxipng shrinks PNGs losslessly:
  oxipng -o 4 --strip safe --out image-small.png image.png
  oxipng -o 4 --strip safe --dir small *.png
Without --out or --dir it rewrites files in place, so always pass one.`,
    license: "MIT",
    category: "images",
  },
  {
    id: "exiftool",
    name: "ExifTool",
    command: "exiftool",
    replaces: "photo metadata editors",
    blurb: "Shows and removes hidden photo data like location, camera and dates.",
    examples: ["remove location from these photos", "which camera took this photo", "strip metadata before I share this"],
    installCommand: "brew install exiftool",
    docs: `ExifTool reads and removes photo and video metadata:
  exiftool -gps:all photo.jpg
  exiftool -gps:all= photo.jpg
  exiftool -all= -tagsfromfile @ -orientation photo.jpg
  exiftool -r -gps:all= folder
Removing tags keeps a photo.jpg_original backup next to each file; that's the undo.
Never pass -overwrite_original unless the person asks for it.`,
    license: "Artistic / GPL",
    category: "images",
  },
  {
    id: "webp",
    name: "WebP",
    command: "cwebp",
    replaces: "image format converters",
    blurb: "Converts images to WebP, a fraction of the size for websites.",
    examples: ["convert these images to webp", "turn this webp into a png"],
    installCommand: "brew install webp",
    docs: `cwebp converts images to WebP; dwebp converts back:
  cwebp -q 80 image.png -o image.webp
  dwebp image.webp -o image.png
For a folder, loop over the files and write each copy next to its original.`,
    license: "BSD-3-Clause",
    category: "images",
  },
  {
    id: "qpdf",
    name: "qpdf",
    command: "qpdf",
    replaces: "Acrobat page tools",
    blurb: "Merges, splits, rotates and unlocks PDFs without touching quality.",
    examples: ["merge these pdfs", "split this pdf into pages", "rotate page 3 of this pdf"],
    installCommand: "brew install qpdf",
    docs: `qpdf merges, splits, rotates and unlocks PDFs without re-encoding them:
  qpdf --empty --pages a.pdf b.pdf -- merged.pdf
  qpdf input.pdf --pages . 1-3 -- first-three.pdf
  qpdf --split-pages input.pdf page-%d.pdf
  qpdf input.pdf --rotate=+90:3 rotated.pdf
  qpdf --decrypt locked.pdf unlocked.pdf
Always write a new file. If a PDF needs a password to open, say so; never guess one.`,
    license: "Apache-2.0",
    category: "documents",
  },
  {
    id: "ghostscript",
    name: "Ghostscript",
    command: "gs",
    replaces: "PDF compressors",
    blurb: "Shrinks heavy PDFs so they fit in an email.",
    examples: ["compress this pdf", "make this pdf small enough to email"],
    installCommand: "brew install ghostscript",
    docs: `Ghostscript compresses PDFs. The command is gs:
  gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -dQUIET -sOutputFile=small.pdf input.pdf
/screen is smallest, /ebook is a good default, /printer keeps more detail.
Write a new file and report both sizes.`,
    license: "AGPL-3.0",
    category: "documents",
  },
  {
    id: "poppler",
    name: "Poppler",
    command: "pdftotext",
    replaces: "PDF text extractors",
    blurb: "Pulls the text, images and details out of any PDF.",
    examples: ["get the text out of this pdf", "save every image from this pdf"],
    installCommand: "brew install poppler",
    docs: `Poppler reads what's inside a PDF:
  pdftotext -layout input.pdf output.txt
  mkdir -p images && pdfimages -all input.pdf images/img
  pdfinfo input.pdf
  pdfunite a.pdf b.pdf merged.pdf
Never overwrite the input PDF.`,
    license: "GPL",
    category: "documents",
  },
  {
    id: "typst",
    name: "Typst",
    command: "typst",
    replaces: "paid typesetting apps",
    blurb: "Turns simple markup into polished PDFs. Also gives Pandoc a PDF engine.",
    examples: ["make a pdf from this outline", "turn my notes into a nicely formatted pdf"],
    installCommand: "brew install typst",
    docs: `Typst compiles a markup file to PDF:
  typst compile document.typ document.pdf
It's also a PDF engine for Pandoc:
  pandoc input.md -o output.pdf --pdf-engine=typst
Write the .typ file next to where the PDF should go.`,
    license: "Apache-2.0",
    category: "documents",
  },
  {
    id: "czkawka",
    name: "Czkawka",
    command: "czkawka_cli",
    replaces: "Gemini 2",
    blurb: "Finds duplicate files, similar photos and the biggest space hogs.",
    examples: ["find duplicate files", "find similar photos in my pictures", "what are my biggest files"],
    installCommand: "brew install czkawka",
    docs: `Czkawka finds duplicates. The command is czkawka_cli:
  czkawka_cli dup --directories "$HOME/Pictures" --file-to-save "$HOME/Downloads/duplicates.txt"
  czkawka_cli image --directories "$HOME/Pictures" --file-to-save "$HOME/Downloads/similar-photos.txt"
  czkawka_cli big --directories "$HOME" --file-to-save "$HOME/Downloads/biggest-files.txt"
List results first and summarise them. Never pass --delete-method in the same plan;
deleting is a separate, high-risk plan the person approves after seeing the list.`,
    license: "MIT",
    category: "files",
  },
  {
    id: "sevenzip",
    name: "7-Zip",
    command: "7zz",
    replaces: "paid archive apps",
    blurb: "Makes and opens .7z and .zip archives with strong compression.",
    examples: ["make a 7z of this folder", "compress this folder as small as possible", "extract this 7z file"],
    installCommand: "brew install sevenzip",
    docs: `7-Zip makes and opens archives. The command is 7zz:
  7zz a archive.7z folder
  7zz a -tzip archive.zip folder
  7zz x archive.7z -ooutput
  7zz l archive.7z
Extract into a new folder so nothing existing is overwritten.`,
    license: "LGPL-2.1",
    category: "files",
  },
  {
    id: "unar",
    name: "unar",
    command: "unar",
    replaces: "RAR extractors",
    blurb: "Opens RAR, 7z, ISO and old Mac archives with one command.",
    examples: ["open this rar file", "extract this archive"],
    installCommand: "brew install unar",
    docs: `unar extracts almost any archive; lsar lists one:
  unar -r -o output archive.rar
  lsar archive.rar
-r renames instead of asking when a file exists. Never pass -f, which overwrites.`,
    license: "LGPL-2.1",
    category: "files",
  },
  {
    id: "duckdb",
    name: "DuckDB",
    command: "duckdb",
    replaces: "Excel for huge spreadsheets",
    blurb: "Answers questions about CSV, Excel and Parquet files with SQL, even huge ones.",
    examples: ["total this csv by region", "filter this giant csv to 2025 rows", "this spreadsheet is too big for excel"],
    installCommand: "brew install duckdb",
    docs: `DuckDB runs SQL directly on CSV, Parquet, JSON and Excel files:
  duckdb -c "SELECT * FROM 'sales.csv' LIMIT 10"
  duckdb -c "SELECT region, sum(total) FROM 'sales.csv' GROUP BY region ORDER BY 2 DESC"
  duckdb -c "COPY (SELECT * FROM 'big.csv' WHERE year = 2025) TO 'filtered.csv' (HEADER)"
Excel files: duckdb -c "INSTALL excel; LOAD excel; SELECT * FROM read_xlsx('file.xlsx') LIMIT 10"
Always pass -c with a query; plain duckdb opens an interactive shell in a Terminal window.`,
    license: "MIT",
    category: "data",
  },
  {
    id: "mas",
    name: "mas",
    command: "mas",
    replaces: "clicking through the App Store",
    blurb: "Updates and installs Mac App Store apps from one command.",
    examples: ["update all my app store apps", "which app store apps need updates"],
    installCommand: "brew install mas",
    docs: `mas manages Mac App Store apps. The person must be signed in to the App Store app:
  mas list
  mas outdated
  mas upgrade
  mas search "app name"
  mas install APP_ID
Only install free apps or ones the person already owns. Never buy anything.`,
    license: "MIT",
    category: "system",
  },
  {
    id: "restic",
    name: "restic",
    command: "restic",
    replaces: "paid backup apps",
    blurb: "Encrypted, versioned backups to a drive or cloud storage.",
    examples: ["back up my documents to my external drive", "restore yesterday's version of this folder"],
    installCommand: "brew install restic",
    docs: `restic makes encrypted, versioned backups:
  restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" init
  restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" backup "$HOME/Documents"
  restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" snapshots
  restic -r /Volumes/Backup/restic --password-file "$HOME/.config/restic/password" restore latest --target "$HOME/Restored"
The person creates the password file themselves; never put a password in a command.
Never run forget or prune without explicit approval; they delete old backups.`,
    license: "BSD-2-Clause",
    category: "cloud",
  },
  {
    id: "gh",
    name: "GitHub CLI",
    command: "gh",
    replaces: "paid Git clients",
    blurb: "Issues, pull requests and repos without opening the browser.",
    examples: ["list my open pull requests", "clone this github repo", "show the open issues on this repo"],
    installCommand: "brew install gh",
    docs: `GitHub CLI works with repositories, issues and pull requests:
  gh auth status
  gh repo clone owner/name
  gh issue list --repo owner/name
  gh pr list --repo owner/name
  gh pr view 123 --repo owner/name
gh auth login is interactive and opens in a Terminal window.
Never merge, close or delete anything without approval.`,
    license: "MIT",
    category: "dev",
  },
];

export function findTools(query: string): ToolSpec[] {
  const q = query.toLowerCase();
  // Letters and digits only, so "7zip" finds 7-Zip by its name, id (sevenzip) or command (7zz).
  const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const name = compact(q);
  return tools
    .map((tool) => {
      let score = 0;
      const haystack = `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")}`.toLowerCase();
      for (const token of q.split(/[^a-z0-9]+/).filter((t) => t.length > 2)) {
        if (haystack.includes(token)) score += 3;
      }
      if (haystack.includes(q)) score += 8;
      if (name.length > 1 && [tool.name, tool.id, tool.command].some((each) => compact(each).includes(name))) score += 10;
      return { tool, score };
    })
    .filter((entry) => entry.score > 0 || q.length === 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.tool);
}

export function toolDocs(installed: string[]): string {
  return tools
    .filter((tool) => installed.includes(tool.id))
    .map((tool) => `${tool.name}:\n${tool.docs}`)
    .join("\n\n");
}
