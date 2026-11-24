import { isRecord } from './type-guards';

export const SNAKE_CASE_API_VERSION = '2026-10-07';

/** Keys whose values are user or provider data (agent events, env vars, headers, saved config), so their keys are never renamed. */
const OPAQUE_KEYS = new Set(['payload', 'env', 'headers', 'config', 'input', 'arguments']);

const toSnake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const toCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

export function toSnakeCaseKeys(value: Record<string, unknown>): Record<string, unknown>;
export function toSnakeCaseKeys(value: unknown): unknown;
export function toSnakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCaseKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    toSnake(key),
    OPAQUE_KEYS.has(key) ? entry : toSnakeCaseKeys(entry),
  ]));
}

export function withCamelCaseKeys<T>(body: T): T {
  if (!isRecord(body)) return body;
  const aliases = Object.entries(body).filter(([key]) => key.includes('_') && !(toCamel(key) in body));
  return aliases.length ? { ...body, ...Object.fromEntries(aliases.map(([key, entry]) => [toCamel(key), entry])) } : body;
}
