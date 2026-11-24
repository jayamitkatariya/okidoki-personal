import { readRuntimeEnvFile } from '../runtime-env-loader';

const BACKSLASH = 0x5c;
const FILLER = 0x2a;
// AUTH is left out: it also names settings like auth methods.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSCODE|CREDENTIAL|PRIVATE|DSN|TOTP|COOKIE/i;
const PASSWORD_NAME = /SECRET|PASSWORD|PASSWD|PASSCODE/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A shorter value can be part of a longer word or id, so it is only masked where it stands alone.
const WHOLE_WORD_BELOW = 16;
// A replaced credential stays masked while it is among its source's last few, or for a day: a rarely replaced key may still be valid, and a fast-rotating token has expired.
const KEPT_REPLACEMENTS = 8;
const REPLACED_KEPT_MS = 24 * 60 * 60 * 1000;

const currentBySource = new Map<string, string[]>();
const replacedBySource = new Map<string, { values: string[]; at: number }[]>();
// A value once found in a log is never pruned, since every upload masks the whole log again and would show it.
const found = new Set<string>();
let variablesVersion = 0;

function remember(source: string, values: string[]): void {
  const previous = currentBySource.get(source) ?? [];
  if (previous.join('\n') === values.join('\n')) return;
  if (!source.startsWith('credential:')) variablesVersion++;
  currentBySource.set(source, values);
  if (previous.length > 0) replacedBySource.set(source, [{ values: previous, at: Date.now() }, ...(replacedBySource.get(source) ?? [])]);
}

// Words, paths, hosts, ids and commit hashes stay, since masking one would hide it across the whole history.
function looksLikeCredential(value: string): boolean {
  return value.length >= 16
    && /[A-Za-z]/.test(value)
    && /\d/.test(value)
    && (/[A-Z_]/.test(value) || value.length >= 32)
    && !value.startsWith('/')
    && !value.includes('://')
    && !UUID.test(value)
    && !/^[0-9a-f]{40}$/.test(value)
    && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value);
}

// A letters-only value under 12 characters is a word like `postgres` or `changeme` even under a password name.
function isNamedSecret(value: string, password = false): boolean {
  return value.length >= 8
    && !/^(true|false|yes|no|on|off|\d+)$/i.test(value)
    && !value.startsWith('/')
    && (/[^A-Za-z]/.test(value) || value.length >= (password ? 12 : 16));
}

function credentialTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9._~+/=-]+/).filter(looksLikeCredential);
}

function urlCredentials(value: string): string[] | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    const query = [...url.searchParams].flatMap(([name, part]) => SECRET_NAME.test(name) && isNamedSecret(part) ? [part, encodeURIComponent(part)] : []);
    if (url.password) return [...query, ...[url.password, decodeURIComponent(url.password)].filter((part) => isNamedSecret(part, true))];
    return [...query, ...[url.username, decodeURIComponent(url.username)].filter(looksLikeCredential)];
  } catch {
    return null;
  }
}

function variableSecrets(key: string, value: string | undefined): string[] {
  if (!value) return [];
  const fromUrl = urlCredentials(value);
  if (fromUrl) return fromUrl;
  if (SECRET_NAME.test(key)) return value.includes('\n') ? credentialTokens(value) : isNamedSecret(value, PASSWORD_NAME.test(key)) ? [value] : [];
  // Okidoki' own settings are ids, urls and prompts; its credentials all carry a secret name.
  return !key.startsWith('OKIDOKI_') && !/\s/.test(value) && looksLikeCredential(value) ? [value] : [];
}

export function rememberCredentials(source: string, text: string): void {
  remember(`credential:${source}`, credentialTokens(text));
}

export function rememberSecret(source: string, value: string): void {
  remember(`credential:${source}`, value.length >= 8 ? [value] : []);
}

// `variablesVersion` moves when a variable's value changes: unlike a credential the engine fetches, a person can set one to a value already printed in a chat.
export function transcriptSecrets(): { secrets: string[]; variablesVersion: number } {
  for (const [key, value] of Object.entries(process.env)) remember(`env:${key}`, variableSecrets(key, value));
  for (const [key, value] of Object.entries(readRuntimeEnvFile()?.values ?? {})) remember(`runtime:${key}`, variableSecrets(key, value));
  for (const [source, replaced] of replacedBySource) {
    replacedBySource.set(source, replaced.filter(({ at }, index) => index < KEPT_REPLACEMENTS || Date.now() - at <= REPLACED_KEPT_MS));
  }
  const replaced = [...replacedBySource.values()].flatMap((entries) => entries.flatMap(({ values }) => values));
  return { secrets: [...new Set([...[...currentBySource.values()].flat(), ...replaced, ...found])], variablesVersion };
}

// Only JSON-escaped forms, once and twice (tool output inside tool arguments), so a quote in a value can't swallow record syntax.
function needlesFor(secrets: readonly string[]): { needle: Buffer; secret: string }[] {
  const escape = (value: string) => JSON.stringify(value).slice(1, -1);
  const bySecretForm = new Map(secrets.flatMap((secret) => [[escape(secret), secret], [escape(escape(secret)), secret]]));
  return [...bySecretForm].map(([form, secret]) => ({ needle: Buffer.from(form), secret })).sort((a, b) => b.needle.length - a.needle.length);
}

function wordAt(buffer: Buffer, at: number): number {
  return buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16) | (buffer[at + 3] << 24);
}

function prefixSlot(prefix: number): number {
  return Math.imul(prefix, 0x9e3779b1) >>> 16;
}

function isWordByte(byte: number | undefined): boolean {
  return byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a));
}

// Each match becomes filler of the same byte length, so sizes and byte offsets into the log stay valid.
export async function* scrubSecrets(chunks: AsyncIterable<Buffer>, secrets: readonly string[]): AsyncGenerator<Buffer> {
  const needles = needlesFor(secrets);
  if (needles.length === 0) {
    yield* chunks;
    return;
  }
  // A match at the start of a buffer is judged by the bytes before it, which were emitted with the previous one.
  let tail = Buffer.alloc(0);
  let carriedBackslashes = 0;
  const byteAt = (buffer: Buffer, index: number) => index >= 0 ? buffer[index] : tail[tail.length + index];
  const backslashesBefore = (buffer: Buffer, position: number) => {
    let start = position;
    while (start > 0 && buffer[start - 1] === BACKSLASH) start--;
    return position - start + (start === 0 ? carriedBackslashes : 0);
  };
  const standsAlone = (buffer: Buffer, at: number, needle: Buffer) => {
    // An odd run of backslashes means the match starts inside an escape like `\n`.
    if (backslashesBefore(buffer, at) % 2 === 1) return false;
    if (needle.length >= WHOLE_WORD_BELOW) return true;
    // The letter of an escape like `\n` ends the word before it.
    const joinsWordBefore = isWordByte(byteAt(buffer, at - 1)) && byteAt(buffer, at - 2) !== BACKSLASH;
    return !joinsWordBefore && !isWordByte(buffer[at + needle.length]);
  };
  // Each value's first four bytes pick out the few positions worth comparing, so a pass costs the same however many values there are.
  const byPrefix = new Map<number, typeof needles>();
  const prefixes = new Uint8Array(1 << 16);
  for (const entry of needles) {
    const prefix = wordAt(entry.needle, 0);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), entry]);
    prefixes[prefixSlot(prefix)] = 1;
  }
  // A match is only taken once the byte after it has arrived, so one starting at or after `end` waits for the next chunk.
  const scrub = (buffer: Buffer, end: number) => {
    const parts: Buffer[] = [];
    let at = 0;
    for (let index = 0; index < end && index + 4 <= buffer.length; index++) {
      const prefix = wordAt(buffer, index);
      if (prefixes[prefixSlot(prefix)] === 0) continue;
      const match = byPrefix.get(prefix)
        ?.find(({ needle }) => index + needle.length <= buffer.length
          && buffer.compare(needle, 0, needle.length, index, index + needle.length) === 0
          && standsAlone(buffer, index, needle));
      if (!match) continue;
      found.add(match.secret);
      parts.push(buffer.subarray(at, index), Buffer.alloc(match.needle.length, FILLER));
      at = index + match.needle.length;
      index = at - 1;
    }
    const stop = Math.max(at, end);
    parts.push(buffer.subarray(at, stop));
    carriedBackslashes = backslashesBefore(buffer, stop);
    tail = stop >= 2 ? Buffer.from(buffer.subarray(stop - 2, stop)) : Buffer.concat([tail, buffer.subarray(0, stop)]).subarray(-2);
    return { scrubbed: Buffer.concat(parts), rest: buffer.subarray(stop) };
  };
  let rest: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const buffer = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
    const result = scrub(buffer, buffer.length - needles[0].needle.length);
    rest = result.rest;
    if (result.scrubbed.length > 0) yield result.scrubbed;
  }
  const last = scrub(rest, rest.length);
  if (last.scrubbed.length > 0) yield last.scrubbed;
}
