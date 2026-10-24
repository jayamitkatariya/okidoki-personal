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
const TOOL_PRICES: Record<string, number> = { mole: 39.95, ffmpeg: 79, handbrake: 79, pandoc: 49, ocrmypdf: 239.88, imagemagick: 69, ollama: 240, rclone: 59 };

export function toolPrice(id: string): number {
  return TOOL_PRICES[id] ?? 0;
}
