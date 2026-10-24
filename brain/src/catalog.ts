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
Always dry-run first. Never pass --force without approval. Summarise freed space in plain English.
Run "sudo -v" before "mo clean" so system caches are included; okidoki shows a native password dialog.
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
];

export function findTools(query: string): ToolSpec[] {
  const q = query.toLowerCase();
  return tools
    .map((tool) => {
      let score = 0;
      const haystack = `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")}`.toLowerCase();
      for (const token of q.split(/[^a-z0-9]+/).filter((t) => t.length > 2)) {
        if (haystack.includes(token)) score += 3;
      }
      if (haystack.includes(q)) score += 8;
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
