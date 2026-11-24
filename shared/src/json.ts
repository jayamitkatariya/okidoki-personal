export function safeJsonParse<T = Record<string, unknown>>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// Some providers ignore structured-output settings and wrap JSON in markdown fences or prose.
export function extractJsonObject<T = unknown>(content: string): T | null {
  const direct = safeJsonParse<T | null>(content, null);
  if (direct !== null) return direct;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fromFence = fenced ? safeJsonParse<T | null>(fenced[1], null) : null;
  if (fromFence !== null) return fromFence;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return start !== -1 && end > start ? safeJsonParse<T | null>(content.slice(start, end + 1), null) : null;
}
