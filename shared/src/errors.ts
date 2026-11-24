export interface TransientErrorTextOptions {
  httpStatuses?: readonly number[];
  httpStatusClasses?: readonly number[];
  requireHttpContext?: boolean;
  includeRateLimit?: boolean;
  extraPatterns?: readonly RegExp[];
}

const TRANSIENT_NETWORK_ERROR_PATTERNS: readonly RegExp[] = [
  /socket connection was closed unexpectedly/,
  /fetch failed/,
  /network error/,
  /network request failed/,
  /econnreset/,
  /econnrefused/,
  /etimedout/,
  /enotfound/,
  /eai_again/,
  /und_err_socket/,
  /und_err_connect_timeout/,
  /headers timeout/,
  /body timeout/,
  /connection reset/,
  /connection closed/,
  /closed unexpectedly/,
];

const HTTP_CONTEXT_PATTERN = /(api error|request|response|status|http)/;
const HTTP_STATUS_PATTERN = /(^|[^0-9])([1-5][0-9]{2})(?=$|[^0-9])/g;

export function extractErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown): void => {
    if (value === null || value === undefined || seen.has(value)) return;
    seen.add(value);
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (value instanceof Error) {
      parts.push(value.name, value.message);
      collect(value.cause);
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['name', 'message', 'code', 'error', 'cause']) {
        collect(record[key]);
      }
      const errors = record.errors;
      if (Array.isArray(errors)) {
        for (const err of errors) collect(err);
      }
      return;
    }
    parts.push(String(value));
  };
  collect(error);
  return parts.filter(Boolean).join('\n');
}

export function isTransientErrorText(text: string, options: TransientErrorTextOptions = {}): boolean {
  const normalized = text.toLowerCase();
  if (!normalized) return false;
  if (TRANSIENT_NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (options.includeRateLimit && /rate limit/.test(normalized)) return true;
  if (options.extraPatterns?.some((pattern) => pattern.test(normalized))) return true;

  const httpStatuses = new Set(options.httpStatuses ?? []);
  const httpStatusClasses = new Set(options.httpStatusClasses ?? []);
  if (httpStatuses.size === 0 && httpStatusClasses.size === 0) return false;
  if (options.requireHttpContext !== false && !HTTP_CONTEXT_PATTERN.test(normalized)) return false;

  for (const match of normalized.matchAll(HTTP_STATUS_PATTERN)) {
    const status = Number(match[2]);
    if (httpStatuses.has(status) || httpStatusClasses.has(Math.floor(status / 100))) return true;
  }
  return false;
}
