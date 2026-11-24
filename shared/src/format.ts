interface FormatBytesOptions {
  baseUnit?: string;
  mbDigits?: number;
  gbDigits?: number;
}

export function formatBytes(n: number, opts: FormatBytesOptions = {}): string {
  const { baseUnit = 'B', mbDigits = 1, gbDigits } = opts;
  if (n < 1024) return `${n} ${baseUnit}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (gbDigits === undefined || n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(mbDigits)} MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(gbDigits)} GB`;
}

export function formatMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0';
  if (tokens >= 1_000_000) {
    const fractionDigits = tokens >= 10_000_000 ? 0 : 1;
    return `${(tokens / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}M`;
  }
  if (tokens >= 1_000) {
    const formatted = (tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1);
    return formatted === '1000' ? '1M' : `${formatted}k`;
  }
  return Math.round(tokens).toLocaleString();
}

export function formatRelativeFromNow(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

export function formatElapsedMs(ms: number): string {
  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toFixed(1)}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const remaining = totalSeconds % 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
}

export function formatApproxMinutes(seconds: number): string {
  return seconds < 90 ? 'about a minute' : `about ${Math.round(seconds / 60)} min`;
}

export function formatTurnElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function dayAndTime(timestamp: string, now: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return {
    days: Math.round((startOfDay(date) - startOfDay(today)) / 86_400_000),
    time: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    weekday: date.toLocaleDateString(undefined, { weekday: 'long' }),
    date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() && { year: 'numeric' }) }),
  };
}

export function formatMessageTime(timestamp: string): string {
  const parts = dayAndTime(timestamp, Date.now());
  if (!parts) return '';
  if (parts.days === 0) return parts.time;
  if (parts.days === -1) return `Yesterday at ${parts.time}`;
  return `${parts.days < -1 && parts.days > -7 ? parts.weekday : parts.date} at ${parts.time}`;
}

export function formatDayTime(timestamp: string, now = Date.now()): string {
  const parts = dayAndTime(timestamp, now);
  if (!parts) return '';
  const relative = ['yesterday', 'today', 'tomorrow'][parts.days + 1];
  return `${relative ?? (Math.abs(parts.days) < 7 ? parts.weekday : parts.date)} at ${parts.time}`;
}

export function formatMessageTimeFull(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function relativeParts(input: string | number | Date, now = Date.now()): { then: number; seconds: number; minutes: number; hours: number; days: number; months: number; years: number } | null {
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  return { then, seconds, minutes, hours, days, months, years: Math.floor(months / 12) };
}

// Pass `now` from a clock hook when rendering: a compiled component caches the label on its inputs.
export function compactTimeAgo(input: string | number | Date, options?: { seconds?: boolean; now?: number }): string {
  const p = relativeParts(input, options?.now);
  if (!p) return '';
  if (p.seconds < 60) return options?.seconds === false ? 'now' : `${p.seconds}s`;
  if (p.minutes < 60) return `${p.minutes}m`;
  if (p.hours < 24) return `${p.hours}h`;
  if (p.days < 30) return `${p.days}d`;
  if (p.months < 12) return `${p.months}mo`;
  return `${p.years}y`;
}

export function formatCompactRelativeTime(input: string | number | Date, now = Date.now()): string {
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return '';
  // Callers pass a minute clock, which can trail the newest timestamps by up to a minute.
  if (Math.abs(then - now) < 60_000) return 'just now';
  const future = then > now;
  const compact = compactTimeAgo(future ? now - (then - now) : then, { now });
  return future ? `in ${compact}` : `${compact} ago`;
}

export function formatTimeAgo(input: string | number | Date, now = Date.now()): string {
  const p = relativeParts(input, now);
  if (!p) return '';
  if (p.minutes < 1) return 'now';
  if (p.minutes < 60) return `${p.minutes} min ago`;
  if (p.hours < 24) return `${p.hours}h ago`;
  if (p.days < 7) return `${p.days}d ago`;
  return new Date(p.then).toLocaleDateString();
}

export function formatClockSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const formatList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatInferenceCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : USD.format(usd);
}
