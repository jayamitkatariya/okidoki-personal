import type { Tool } from "./types";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function futureTime(value: string | null | undefined): string {
  if (!value) return "manual";
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (seconds < 0) return "due now";
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`;
  return `in ${Math.round(seconds / 86400)}d`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 MB";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_073_741_824).toFixed(1).replace(/\.0$/, "")} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function timeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

export function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function clockLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return "—";
  const finish = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.max(1, Math.round((finish - new Date(start).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Resolves false when the clipboard isn't available or the write is refused. */
export function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function scheduleLabel(routine: {
  cadence: string;
  weekday: number;
  hour: number;
  minute: number;
}): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hour = routine.hour % 12 === 0 ? 12 : routine.hour % 12;
  const suffix = routine.hour < 12 ? "AM" : "PM";
  const time = `${hour}:${String(routine.minute).padStart(2, "0")} ${suffix}`;
  switch (routine.cadence) {
    case "hourly":
      return `Every hour at :${String(routine.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `Every ${days[Math.max(0, Math.min(6, routine.weekday - 1))]} at ${time}`;
    default:
      return "When you ask";
  }
}

// Rough yearly price of the paid app each free tool stands in for. Mirrors ToolCatalog.paidAlternatives.
const TOOL_PRICES: Record<string, number> = { mole: 39.95, ffmpeg: 79, handbrake: 79, pandoc: 49, ocrmypdf: 239.88, imagemagick: 69, ollama: 240, rclone: 59, "yt-dlp": 45, gifski: 15, sox: 35, whisper: 100, pngquant: 39, oxipng: 15, exiftool: 20, webp: 15, qpdf: 80, ghostscript: 6, czkawka: 20, sevenzip: 25, duckdb: 100, restic: 60, gh: 69, tesseract: 8, qrencode: 30, img2pdf: 10, jpegoptim: 15, croc: 120, age: 20, smartmontools: 20, topgrade: 15 };

export function toolPrice(id: string): number {
  return TOOL_PRICES[id] ?? 0;
}

// Words that say nothing about the job, so "make this video smaller" doesn't match Pandoc's "convert this to word".
const FILLER = new Set([
  "the", "and", "for", "this", "that", "these", "those", "with", "from", "into", "onto", "your", "mine",
  "make", "want", "need", "can", "how", "what", "please", "help", "some", "all", "any", "out", "get", "just", "mac",
]);

// Whole words, with a trailing "s" dropped so "videos" matches "video" but "edit" doesn't match "editors".
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function jobWords(query: string): string[] {
  return words(query)
    .filter((word) => word.length > 2 && !FILLER.has(word))
    .map(singular);
}

// Letters and digits only, so "7zip", "7-zip" and "7 Zip" all read as one name.
function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The names a tool goes by: what's on its card, its id and the command it runs ("7-Zip", "sevenzip", "7zz").
function toolNames(tool: Tool): string[] {
  return [tool.name, tool.id, tool.command].map(compact).filter(Boolean);
}

// The catalog search box: plain text anywhere on the card, or any of the tool's names however it's spelled.
export function toolMatches(tool: Tool, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")} ${tool.command} ${tool.id}`.toLowerCase();
  const name = compact(q);
  return hay.includes(q) || (name.length > 1 && toolNames(tool).some((each) => each.includes(name)));
}

// The catalog search box: tools matching by name or card text first, then tools that fit the described job.
export function searchTools(tools: Tool[], query: string): Tool[] {
  if (!query.trim()) return tools;
  const direct = tools.filter((tool) => toolMatches(tool, query));
  const byJob = findTools(tools, query, tools.length).filter((tool) => !direct.includes(tool));
  return [...direct, ...byJob];
}

// Ranks the catalog for a job description: word hits first, popularity breaks ties.
// Tools matching less than half as many words as the best one are left out, so one shared word ("open") doesn't count.
export function findTools(tools: Tool[], query: string, limit = 3): Tool[] {
  const wanted = jobWords(query);
  if (!wanted.length) return [];
  const phrase = query.trim().toLowerCase();
  const ranked = tools.map((tool) => {
    const hay = `${tool.name} ${tool.replaces} ${tool.blurb} ${tool.examples.join(" ")} ${tool.category}`.toLowerCase();
    const vocab = new Set([...words(hay).map(singular), ...toolNames(tool)]);
    const hits = wanted.filter((word) => vocab.has(word)).length;
    const score = hits * 3 + (hay.includes(phrase) ? 8 : 0) + Math.floor((tool.popularity ?? 0) / 20);
    return { tool, hits, score };
  });
  const best = Math.max(0, ...ranked.map((entry) => entry.hits));
  return ranked
    .filter((entry) => entry.hits > 0 && entry.hits * 2 >= best)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.tool);
}

// A tool is off when its command is on the blocked list (Settings › Safety).
export function toolBlocked(tool: Tool, blocked: string[]): boolean {
  const command = tool.command.toLowerCase();
  return blocked.some((item) => item.trim().toLowerCase() === command);
}
