import {
  ALPHANUMERIC,
  COMBINING_MARKS,
  MID_WORD,
  SYMBOL,
  WRAPPING_QUOTES,
  foldInPlace,
  foldSearchField,
  isWordStart,
  mergeRanges,
  type SearchRange,
} from './palette-search';

// Trigrams can't index shorter tokens, and a two-letter substring of a message is noise.
const MESSAGE_TOKEN_MIN_LENGTH = 3;
// A shorter token must start a word: "fts" is not in "drafts".
const WORD_START_LENGTH = 4;
const WORD_PREFIX = 0.8;
const PHRASE_BONUS = 0.25;
const NEAR_BONUS = 0.1;
const NEAR_SPAN = 60;
const NON_ASCII = /[\u0080-￿]/;
const CURLY_APOSTROPHES = /[‘’]/g;
// A word inside a commit SHA or UUID is a coincidence, not a match.
const HEX_ID = /^(?=[a-f]*\d)[0-9a-f]{7,}$/i;
// The chat shows a link as its text, so a match must not sit in the address.
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;
const SNIPPET_LENGTH = 240;
// Result rows show one line, so the match must sit near the start to be seen.
const SNIPPET_LEAD = 24;
const TABLE_DIVIDER = /^[\s|:]*-[\s|:-]*$/;

export function messageSearchTokens(query: string): { long: string[]; short: string[]; words: string[] } {
  const words = query.replace(WRAPPING_QUOTES, '').replace(CURLY_APOSTROPHES, "'").normalize('NFC').toLowerCase()
    .split(/\s+/).filter(Boolean);
  const long = words.filter((word) => Array.from(word).length >= MESSAGE_TOKEN_MIN_LENGTH);
  return { long, short: words.filter((word) => !long.includes(word)), words };
}

export function messagePhrase(words: string[]): RegExp | null {
  if (words.length < 2) return null;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

function startsWordAt(text: string, index: number): boolean {
  const character = text[index];
  if (!ALPHANUMERIC.test(character) && !SYMBOL.test(character)) return true;
  return isWordStart(text[index - 2] ?? '', text[index - 1] ?? '', character, text[index + 1] ?? '');
}

function endsWordAt(text: string, end: number): boolean {
  return end >= text.length || !ALPHANUMERIC.test(text[end]) || startsWordAt(text, end);
}

function findMessageToken(text: string, folded: string, token: string): { at: number[]; quality: number } | null {
  let quality = 0;
  let at: number[] = [];
  // Kept across hits in one run: rescanning it per hit is quadratic in a hex dump.
  let run = { start: 0, end: -1, hex: false };
  for (let index = folded.indexOf(token); index !== -1; index = folded.indexOf(token, index + 1)) {
    if (index + token.length > run.end) {
      let start = index;
      while (start > 0 && ALPHANUMERIC.test(text[start - 1])) start--;
      let end = index + token.length;
      while (end < text.length && ALPHANUMERIC.test(text[end])) end++;
      run = { start, end, hex: HEX_ID.test(text.slice(start, end)) };
    }
    if (run.hex && run.start < index) continue;
    const found = !startsWordAt(text, index) ? MID_WORD : endsWordAt(text, index + token.length) ? 1 : WORD_PREFIX;
    if (found > quality) {
      quality = found;
      at = [index];
    } else if (found === quality) {
      at.push(index);
    }
  }
  return at.length === 0 ? null : { at, quality };
}

function shortestSpan(places: number[][]): { start: number; length: number } {
  const hits = places.flatMap((at, word) => at.map((index) => ({ index, word }))).sort((left, right) => left.index - right.index);
  const counts = places.map(() => 0);
  let covered = 0;
  let best = { start: hits[0]?.index ?? 0, length: Infinity };
  let left = 0;
  for (const hit of hits) {
    if (++counts[hit.word] === 1) covered++;
    while (covered === places.length) {
      const first = hits[left++];
      if (hit.index - first.index < best.length) best = { start: first.index, length: hit.index - first.index };
      if (--counts[first.word] === 0) covered--;
    }
  }
  return best;
}

function buildSearchSnippet(text: string, matchStart: number): string {
  let start = Math.max(0, matchStart - SNIPPET_LEAD);
  const wordStart = text.slice(start, matchStart).search(/\s/);
  if (start > 0 && wordStart !== -1) start += wordStart + 1;
  if (/[\udc00-\udfff]/.test(text[start] ?? '')) start++;
  // Collapsing whitespace shortens the text, so read more of it.
  const rawEnd = Math.min(text.length, start + SNIPPET_LENGTH * 2);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  // The chat renders table rows as their cells, so drop the row borders and divider; pipes on other lines stay.
  const shown = text.slice(start, rawEnd).split('\n')
    .map((line, index) => !(index === 0 ? text.slice(lineStart, start) + line : line).trimStart().startsWith('|') ? line
      : TABLE_DIVIDER.test(line) ? '' : line.replaceAll('|', ' '))
    .join('\n').replace(/\*\*|`+/g, '').replace(/\s+/g, ' ').trim();
  let end = Math.min(shown.length, SNIPPET_LENGTH - 2);
  if (/[\udc00-\udfff]/.test(shown[end] ?? '')) end--;
  const cut = end < shown.length || rawEnd < text.length;
  return `${start > 0 ? '…' : ''}${shown.slice(0, end)}${cut ? '…' : ''}`;
}

interface MessageMatch {
  quality: number;
  snippet: () => string;
}

export function messageMatcher(query: string): (text: string) => MessageMatch | null {
  const { long, short, words } = messageSearchTokens(query);
  const tokens = [...long, ...short].map((token) => ({
    token,
    folded: foldInPlace(token).replace(COMBINING_MARKS, ''),
    nonAscii: NON_ASCII.test(token),
    mustStartWord: Array.from(token).length < WORD_START_LENGTH,
    // Grading by a word still being typed would reorder results on each keystroke.
    grades: long.includes(token),
  }));
  const phrase = messagePhrase(words);
  const foldedPhrase = messagePhrase(words.map((word) => foldInPlace(word).replace(COMBINING_MARKS, '')));
  const queryNonAscii = NON_ASCII.test(query);
  return (message) => {
    const text = message.replace(MARKDOWN_LINK, '$1');
    const lower = text.toLowerCase();
    // "İ" lowercases to two units, which would shift every offset after it.
    const plain = lower.length === text.length ? lower : foldInPlace(text);
    let folded: string | null = null;
    let quality = 1;
    const positions: number[][] = [];
    for (const { token, folded: foldedToken, nonAscii, mustStartWord, grades } of tokens) {
      let found = findMessageToken(text, plain, token);
      if (found?.quality !== 1 && foldedToken.length > 0 && (nonAscii || NON_ASCII.test(text))) {
        found = findMessageToken(text, (folded ??= foldInPlace(text)), foldedToken);
      }
      if (!found || (found.quality === MID_WORD && mustStartWord)) return null;
      if (grades) quality = Math.min(quality, found.quality);
      positions.push(found.at);
    }
    const straight = (value: string) => value.replace(CURLY_APOSTROPHES, "'");
    const together = phrase?.exec(straight(plain))
      ?? (queryNonAscii || NON_ASCII.test(text) ? foldedPhrase?.exec(straight((folded ??= foldInPlace(text)))) : null);
    if (together) return { quality: quality + PHRASE_BONUS, snippet: () => buildSearchSnippet(text, together.index) };
    const near = shortestSpan(positions);
    return {
      quality: long.length > 1 && near.length <= NEAR_SPAN ? quality + NEAR_BONUS : quality,
      snippet: () => buildSearchSnippet(text, near.start),
    };
  };
}

export function findSearchTokenRanges(text: string, query: string): SearchRange[] {
  const tokens = messageSearchTokens(query).long
    .map((token) => ({ token: foldInPlace(token).replace(COMBINING_MARKS, ''), needsWordStart: Array.from(token).length < WORD_START_LENGTH }))
    .filter(({ token }) => token.length > 0);
  if (tokens.length === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const { token, needsWordStart } of tokens) {
    const ownBoundary = !ALPHANUMERIC.test(token[0]) && !SYMBOL.test(token[0]);
    for (let index = field.text.indexOf(token); index !== -1; index = field.text.indexOf(token, index + 1)) {
      if (needsWordStart && !ownBoundary && !field.wordStarts[index]) continue;
      ranges.push({ start: index, end: index + token.length });
    }
  }
  return mergeRanges(ranges);
}

// A case-insensitive regex keeps offsets aligned with the original text; lowercasing can change string length.
export const chatFindPattern = (query: string): RegExp | null => {
  const normalized = query.trim();
  return normalized ? new RegExp(normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
};

interface ChatFindMatch {
  messageId: string;
  key: string;
  index: number;
  text: string;
}

export const findChatMatches = (messages: { id: string; text: string }[], pattern: RegExp): ChatFindMatch[] =>
  messages.flatMap(({ id, text }) => Array.from(text.matchAll(pattern), (match, occurrence) => ({ messageId: id, key: `${id}#${occurrence}`, index: match.index, text: match[0] })));
