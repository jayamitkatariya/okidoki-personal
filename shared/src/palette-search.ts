export const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{N}/u;
const LETTER = /\p{L}/u;
export const SYMBOL = /\p{So}/u;
const APOSTROPHE = /['’]/;
export const COMBINING_MARKS = /\p{M}/gu;
export const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;

export interface SearchRange {
  start: number;
  end: number;
}

interface SearchField {
  text: string;
  wordStarts: Uint8Array;
}

// Folded per source unit so match offsets index the original text and highlights need no mapping.
export function foldInPlace(text: string): string {
  return text
    .replace(/[\u0080-￿]/g, (character) => {
      const folded = character.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/[‘’]/, "'");
      return folded.length === 1 ? folded : character;
    })
    .toLowerCase();
}

function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

export function isWordStart(beforePrevious: string, previous: string, character: string, next: string): boolean {
  const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
  return (ALPHANUMERIC.test(character) || SYMBOL.test(character))
    && !afterApostrophe
    && (previous === ''
      || !ALPHANUMERIC.test(previous)
      || (LOWERCASE.test(previous) && UPPERCASE.test(character))
      || (UPPERCASE.test(previous) && UPPERCASE.test(character) && LOWERCASE.test(next))
      || DIGIT.test(previous) !== DIGIT.test(character)
      || isCjk(character));
}

// Every keystroke rereads every name, so folding each name once keeps a keystroke to plain string scans.
const fieldCache = new Map<string, SearchField>();
const FIELD_CACHE_LIMIT = 50_000;

export function foldSearchField(source: string): SearchField {
  const wordStarts = new Uint8Array(source.length);
  const characters = Array.from(source);
  let index = 0;
  for (const [position, character] of characters.entries()) {
    if (isWordStart(characters[position - 2] ?? '', characters[position - 1] ?? '', character, characters[position + 1] ?? '')) {
      wordStarts[index] = 1;
    }
    index += character.length;
  }
  return { text: foldInPlace(source), wordStarts };
}

function prepareSearchField(source: string): SearchField {
  const cached = fieldCache.get(source);
  if (cached) return cached;
  const oldest = fieldCache.keys().next();
  if (fieldCache.size >= FIELD_CACHE_LIMIT && !oldest.done) fieldCache.delete(oldest.value);
  const field = foldSearchField(source);
  fieldCache.set(source, field);
  return field;
}

export function foldSearchQuery(query: string): string {
  return foldInPlace(query.replace(WRAPPING_QUOTES, '').normalize('NFC')).split(/\s+/).filter(Boolean).join(' ');
}

function wordEnd(field: SearchField, index: number): number {
  let end = index + 1;
  while (end < field.text.length && !field.wordStarts[end] && ALPHANUMERIC.test(field.text[end])) end++;
  return end;
}

function withinOneEdit(left: string, right: string, swapOnly: boolean): boolean {
  if (Math.abs(left.length - right.length) > (swapOnly ? 0 : 1)) return false;
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  const restLeft = left.slice(index);
  const restRight = right.slice(index);
  const swapped = restLeft.length > 1 && restLeft[0] === restRight[1] && restLeft[1] === restRight[0]
    && restLeft.slice(2) === restRight.slice(2);
  if (swapOnly) return swapped;
  return swapped || restLeft === restRight || restLeft.slice(1) === restRight.slice(1)
    || restLeft.slice(1) === restRight || restLeft === restRight.slice(1);
}

const WHOLE_WORD = 1;
const WHOLE_NAME = 1.5;
const WORD_START_MIN = 0.7;
const JOINED_WORDS = 0.6;
const TYPO = 0.45;
export const MID_WORD = 0.3;

interface TokenMatch extends SearchRange {
  score: number;
  letters?: SearchRange[];
}

// Only names allow a hit inside a word, and only from four letters: "del" must not find "model".
// A typo keeps the first letter (unless it swaps the first two) and never touches a number, so PR numbers stay distinct.
function matchToken(field: SearchField, token: string, typos: boolean, isPrimary: boolean, midWord: boolean): TokenMatch | null {
  let best: TokenMatch | null = null;
  const ownBoundary = !ALPHANUMERIC.test(token[0]) && !SYMBOL.test(token[0]);
  for (let index = field.text.indexOf(token); index !== -1; index = field.text.indexOf(token, index + 1)) {
    if (field.wordStarts[index] || ownBoundary) {
      const end = index + token.length;
      const whole = end >= field.text.length || field.wordStarts[end] === 1 || !ALPHANUMERIC.test(field.text[end]);
      let runEnd = end;
      while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd])) runEnd++;
      const score = whole ? WHOLE_WORD : WORD_START_MIN + (0.2 * token.length) / (runEnd - index);
      if (!best || score > best.score) best = { score, start: index, end };
      if (score === WHOLE_WORD) return best;
    } else if (midWord && token.length >= 4 && !best) {
      best = { score: MID_WORD, start: index, end: index + token.length };
    }
  }
  if ((!best || best.score <= MID_WORD) && isPrimary) {
    const joined = matchJoinedWords(field, token);
    if (joined) return joined;
  }
  if ((best && best.score > MID_WORD) || !typos || token.length < 3 || !LETTER.test(token)) return best;
  for (let index = 0; index < field.text.length; index++) {
    if (!field.wordStarts[index]) continue;
    const first = field.text[index];
    if (first !== token[0] && !(token.length > 3 && first === token[1] && field.text[index + 1] === token[0])) continue;
    let runEnd = index + 1;
    while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd])) runEnd++;
    const word = field.text.slice(index, runEnd);
    // Any edit of a three- or four-letter word matches too much ("cron" would find every "con…").
    const short = token.length <= 4;
    for (const length of short ? [token.length, token.length + 1] : [token.length, token.length - 1, token.length + 1]) {
      if (length > word.length) continue;
      if (withinOneEdit(token, word.slice(0, length), short && length === token.length)) {
        return { score: TYPO, start: index, end: index + length };
      }
    }
  }
  return best;
}

// Words typed together ("vscode" for "VS Code"). Short words before a short prefix are noise mid-name ("inth" in "in thread").
function matchJoinedWords(field: SearchField, token: string): TokenMatch | null {
  const firstWord = field.wordStarts.indexOf(1);
  for (let start = 0; start < field.text.length; start++) {
    if (!field.wordStarts[start] || field.text[start] !== token[0]) continue;
    const runs: SearchRange[] = [];
    let at = start;
    let rest = token;
    while (rest.length > 0 && at < field.text.length) {
      const end = wordEnd(field, at);
      if (rest.length <= end - at && field.text.startsWith(rest, at)) {
        runs.push({ start: at, end: at + rest.length });
        rest = '';
      } else if (rest.startsWith(field.text.slice(at, end))) {
        runs.push({ start: at, end });
        rest = rest.slice(end - at);
        at = end;
        while (at < field.text.length && !field.wordStarts[at]) at++;
      } else {
        break;
      }
    }
    const last = runs.at(-1);
    if (rest.length > 0 || !last || runs.length < 2) continue;
    if (last.end === wordEnd(field, last.start) || last.end - last.start >= 3 || start === firstWord
      || runs.slice(0, -1).every((run) => run.end - run.start >= 3)) {
      return { score: JOINED_WORDS, start, end: last.end, letters: runs };
    }
  }
  return null;
}

interface WeightedField {
  value: string;
  weight: number;
  wholeWords?: boolean;
  /** Only a word start counts, without typos: a loose hit on hidden text can't be explained to the user. */
  keyword?: boolean;
  /** Where the item lives (its repo): it supports a match but a word start there never makes the match strong. */
  context?: boolean;
  midWord?: boolean;
}

interface FieldsMatch {
  quality: number;
  strong: boolean;
  primaryRanges: SearchRange[];
}

const FILLER_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);

export function mergeRanges(ranges: SearchRange[]): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function matchFields(normalizedQuery: string, fields: WeightedField[], typos: boolean): FieldsMatch | null {
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  const prepared = fields.filter((field) => field.value.length > 0).map((field) => ({ ...field, field: prepareSearchField(field.value) }));
  const primary = fields[0]?.value ? prepared[0]?.field : undefined;
  const fillerOptional = tokens.some((token) => !FILLER_WORDS.has(token));
  const primaryRanges: SearchRange[] = [];
  let total = 0;
  let counted = 0;
  let strong = true;
  for (const token of tokens) {
    let best = 0;
    let bestPrimary: TokenMatch | null = null;
    let atWordStart = false;
    for (const { field, weight, wholeWords, keyword, context, midWord } of prepared) {
      if (best >= weight && field !== primary && atWordStart) continue;
      const match = matchToken(field, token, typos && !keyword, field === primary, midWord ?? false);
      if (!match || match.score < (wholeWords ? WHOLE_WORD : keyword ? WORD_START_MIN : 0)) continue;
      if (field === primary) bestPrimary = match;
      if (match.score >= WORD_START_MIN && !context) atWordStart = true;
      best = Math.max(best, match.score * weight);
    }
    if (best === 0) {
      if (fillerOptional && FILLER_WORDS.has(token)) continue;
      return null;
    }
    strong &&= atWordStart;
    if (bestPrimary) primaryRanges.push(...(bestPrimary.letters ?? [{ start: bestPrimary.start, end: bestPrimary.end }]));
    total += best;
    counted += 1;
  }
  let quality = total / counted;
  if (primary?.text === normalizedQuery) quality += WHOLE_NAME - WHOLE_WORD;
  else if (tokens.length > 1 && primary?.text.includes(normalizedQuery)) quality += 0.25;
  return { quality, strong, primaryRanges: mergeRanges(primaryRanges) };
}

interface SearchMatch {
  score: number;
  quality: number;
  groupQuality?: number;
  strong: boolean;
  ranges: SearchRange[];
  /** Why the item matched when its name shows no match; built only for rows shown. */
  explain?: () => SearchMatchHint | undefined;
  pickedAt?: number;
  pickedExactly?: boolean;
}

export interface SearchMatchHint {
  label: string;
  text: string;
  ranges: SearchRange[];
}

const KEYWORD_QUALITY = 0.65;
// Shorter queries would prefix-match most keywords ("co", "pro"), so they need whole keywords.
const KEYWORD_QUERY_MIN_LENGTH = 4;

export function scoreSearchTerms(normalizedQuery: string, terms: string[], { typos }: { typos: boolean }): SearchMatch | null {
  const meaningful = normalizedQuery.split(' ').filter((token) => !FILLER_WORDS.has(token)).join(' ');
  const short = (meaningful || normalizedQuery).length < KEYWORD_QUERY_MIN_LENGTH;
  const match = matchFields(
    normalizedQuery,
    terms.map((value, index) => index === 0
      ? { value, weight: 1 }
      : { value, weight: short ? 0.8 : 0.6, wholeWords: short, keyword: true }),
    typos,
  );
  if (!match) return null;
  return {
    score: match.quality,
    quality: match.quality,
    ...(match.primaryRanges.length > 0 ? {} : { groupQuality: Math.min(match.quality, KEYWORD_QUALITY) }),
    strong: match.strong,
    ranges: match.primaryRanges,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_MS = 14 * DAY_MS;
/** Opens closer together than this count once, so flipping between workspaces isn't frequency. */
export const SEARCH_OPEN_DEDUPE_MS = 10 * 60 * 1000;
const PICK_WINDOW_MS = 21 * DAY_MS;
const PICK_LIMIT = 3;
const PICK_MAX_LENGTH = 32;
const PICK_PREFIX_MIN_LENGTH = 3;

interface SearchPick {
  query: string;
  at: number;
}

export interface SearchOpens {
  openedAt: number;
  score: number;
  picks: SearchPick[];
}

function pickedQuery(query: string): string {
  const cut = foldSearchQuery(query).slice(0, PICK_MAX_LENGTH);
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

function decay(ageMs: number): number {
  return 2 ** (-Math.max(0, ageMs) / RECENCY_HALF_LIFE_MS);
}

export function recordSearchOpen(previous: SearchOpens | undefined, at: number, query?: string): SearchOpens {
  const pick = pickedQuery(query ?? '');
  const earlier = (previous?.picks ?? []).filter((entry) => at - entry.at <= PICK_WINDOW_MS);
  const picks = pick ? [{ query: pick, at }, ...earlier.filter((entry) => entry.query !== pick)].slice(0, PICK_LIMIT) : earlier;
  if (previous && at - previous.openedAt < SEARCH_OPEN_DEDUPE_MS) return { ...previous, picks };
  return { openedAt: at, score: previous ? previous.score * decay(at - previous.openedAt) + 1 : 1, picks };
}

export function searchOpensWeight(opens: SearchOpens, now: number): number {
  return opens.score * decay(now - opens.openedAt);
}

export interface SearchSubject {
  id: string;
  title: string;
  pullRequests: Array<{ number: number; branch: string | null; url: string | null }>;
  repositories: string[];
  activityAt: number | null;
  opens?: SearchOpens;
}

// Use reorders matches of about the same quality, but never lifts a hit inside a word over a whole word on a quiet item.
const USE_BOOST_LIMIT = 2.5;

function usageBoost(subject: SearchSubject, now: number): number {
  const recency = subject.activityAt === null ? 0 : decay(now - subject.activityAt);
  const opens = subject.opens ? searchOpensWeight(subject.opens, now) : 0;
  return Math.min(USE_BOOST_LIMIT, 1 + recency + 0.5 * Math.log2(1 + opens));
}

// IDs and links have many word starts, so a short query would hit everything: require a long pasted value.
const REFERENCE_MIN_LENGTH = 8;

function matchedReference(normalizedQuery: string, subject: SearchSubject): 'Link' | 'Branch' | undefined {
  if (normalizedQuery.length < REFERENCE_MIN_LENGTH || normalizedQuery.includes(' ')) return undefined;
  // A pasted link may go on past the reference (".../pull/22/files"), but a number is never cut short (".../pull/2" is not 22).
  const notCut = (text: string, end: number) => !DIGIT.test(text[end] ?? '');
  const matches = (reference: string) => {
    const folded = reference.toLowerCase();
    const at = folded.indexOf(normalizedQuery);
    return (at !== -1 && notCut(folded, at + normalizedQuery.length))
      || (normalizedQuery.startsWith(folded) && notCut(normalizedQuery, folded.length));
  };
  if ([subject.id, ...subject.pullRequests.flatMap((pullRequest) => pullRequest.url ? [pullRequest.url] : [])].some(matches)) return 'Link';
  return subject.pullRequests.some((pullRequest) => pullRequest.branch?.toLowerCase() === normalizedQuery) ? 'Branch' : undefined;
}

function activePick(subject: SearchSubject, normalizedQuery: string, now: number): SearchPick & { exact: boolean } | undefined {
  const query = pickedQuery(normalizedQuery);
  const prefix = query.length >= PICK_PREFIX_MIN_LENGTH;
  let exact: SearchPick | undefined;
  let latest: SearchPick | undefined;
  for (const pick of subject.opens?.picks ?? []) {
    if (now - pick.at > PICK_WINDOW_MS) continue;
    if (pick.query === query && (!exact || pick.at > exact.at)) exact = pick;
    if ((pick.query === query || (prefix && pick.query.startsWith(query))) && (!latest || pick.at > latest.at)) latest = pick;
  }
  const pick = exact ?? latest;
  return pick && { ...pick, exact: pick.query === query };
}

// Branches start with a type or author ("fix/", "saai/"), so "fix" would match nearly every workspace through them.
function searchableBranch(branch: string | null): string | null {
  return branch && branch.slice(branch.lastIndexOf('/') + 1);
}

function hintFields(subject: SearchSubject) {
  return [
    ...subject.pullRequests.map((pullRequest) => ({ label: 'PR', text: `#${pullRequest.number}` })),
    ...subject.pullRequests.map((pullRequest) => ({ label: 'Branch', text: pullRequest.branch ?? '' })),
    ...subject.repositories.map((repository) => ({ label: 'Repo', text: repository })),
  ].filter(({ text }) => text.length > 0);
}

function matchHint(normalizedQuery: string, subject: SearchSubject, typos: boolean): SearchMatchHint | undefined {
  const holds = (text: string, query: string) => matchFields(query, [{ value: text, weight: 1 }], typos)?.primaryRanges;
  const hintFor = (query: string) => {
    for (const { label, text } of hintFields(subject)) {
      const searched = label === 'Branch' ? text.slice(text.lastIndexOf('/') + 1) : text;
      const ranges = holds(searched, query);
      if (!ranges) continue;
      const offset = text.length - searched.length;
      return { label, text, ranges: ranges.map((range) => ({ start: range.start + offset, end: range.end + offset })) };
    }
    return undefined;
  };
  const whole = hintFor(normalizedQuery);
  if (whole) return whole;
  const rest = normalizedQuery.split(' ').filter((token) => !subject.repositories.some((repository) => holds(repository, token))).join(' ');
  return rest && rest !== normalizedQuery ? hintFor(rest) : undefined;
}

export function scoreSearchSubject(
  normalizedQuery: string,
  subject: SearchSubject,
  now: number,
  { typos }: { typos: boolean },
): SearchMatch | null {
  const fields: WeightedField[] = [{ value: subject.title, weight: 1, midWord: true }];
  for (const pullRequest of subject.pullRequests) {
    fields.push({ value: `#${pullRequest.number}`, weight: 1 });
    const branch = searchableBranch(pullRequest.branch);
    if (branch) fields.push({ value: branch, weight: 0.6 });
  }
  for (const repository of subject.repositories) fields.push({ value: repository, weight: 0.25, context: true });
  const fieldQuery = normalizedQuery.replace(/^(?:pr|pull request|pull)\s*(?=#?\d)/, '').replace(/^#\s*/, '');
  const fieldMatch = matchFields(fieldQuery, fields, typos);
  const reference = fieldMatch ? undefined : matchedReference(normalizedQuery, subject);
  const match = fieldMatch ?? (reference ? { quality: 0.6, strong: true, primaryRanges: [] } : null);
  if (!match) return null;
  // A row whose name shows no match must say why; a multi-word match spread over unrelated fields can't, so it's a coincidence.
  const nameShowsMatch = match.primaryRanges.length > 0;
  const checkHint = !nameShowsMatch && !reference && fieldQuery.includes(' ');
  const checkedHint = checkHint ? matchHint(fieldQuery, subject, typos) : undefined;
  if (checkHint && !checkedHint) return null;
  const pick = activePick(subject, normalizedQuery, now);
  return {
    score: match.quality * usageBoost(subject, now),
    quality: match.quality,
    // A workspace's exact name never lifts its group over a command or page of that name.
    groupQuality: Math.min(match.quality, WHOLE_NAME - 0.01),
    strong: match.strong,
    ranges: match.primaryRanges,
    ...(nameShowsMatch ? {} : {
      explain: () => reference ? { label: reference, text: normalizedQuery, ranges: [] } : checkedHint ?? matchHint(fieldQuery, subject, typos),
    }),
    ...(pick ? { pickedAt: pick.at, pickedExactly: pick.exact } : {}),
  };
}

export function searchSubjectRecentUse(subject: SearchSubject): number {
  return Math.max(subject.activityAt ?? 0, subject.opens?.openedAt ?? 0);
}

// Whole words and word starts share a class, so "Compact" doesn't lift a page over "Compaction".
function matchClass(quality: number): number {
  return quality >= WHOLE_NAME ? 3 : quality >= WORD_START_MIN ? 2 : quality >= 0.4 ? 1 : 0;
}

interface RankedSearchItem<T> {
  item: T;
  match: SearchMatch;
}

/**
 * Ranks groups by their best match class, so typing stays stable and use can't outweigh an equal command.
 * Typos only run when nothing matched cleanly at a word start: beside real matches they add noise and cost per key.
 */
export function rankSearchGroups<G, T>(
  groups: Array<{ group: G; items: T[] }>,
  score: (item: T, options: { typos: boolean }) => SearchMatch | null,
): Array<{ group: G; ranked: RankedSearchItem<T>[] }> {
  const rank = (typos: boolean) => groups.map(({ group, items }) => ({
    group,
    ranked: items.flatMap((item) => {
      const match = score(item, { typos });
      return match ? [{ item, match }] : [];
    }),
  }));
  let ranked = rank(false);
  if (!ranked.some((entry) => entry.ranked.some(({ match }) => match.strong))) ranked = rank(true);
  // Use can't lift a repo-only match over a name match; an exact pick leads word matches, but a pick for a longer query never passes a whole name.
  const wordMatch = (match: SearchMatch) => Math.min(matchClass(match.quality), 2);
  const exactPickAt = (match: SearchMatch) => match.pickedExactly ? match.pickedAt ?? 0 : 0;
  return ranked
    .flatMap(({ group, ranked: items }, order) => items.length === 0 ? [] : [{
      group,
      order,
      best: Math.max(...items.map(({ match }) => matchClass(match.groupQuality ?? match.quality))),
      ranked: items.sort((left, right) => wordMatch(right.match) - wordMatch(left.match)
        || exactPickAt(right.match) - exactPickAt(left.match)
        || matchClass(right.match.quality) - matchClass(left.match.quality)
        || (right.match.pickedAt ?? 0) - (left.match.pickedAt ?? 0)
        || right.match.score - left.match.score),
    }])
    .sort((left, right) => right.best - left.best || left.order - right.order)
    .map(({ group, ranked: items }) => ({ group, ranked: items }));
}

interface SearchTextPart {
  text: string;
  highlighted: boolean;
  start: number;
}

export function splitSearchText(text: string, ranges: SearchRange[]): SearchTextPart[] {
  const parts: SearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, start: range.start });
    cursor = range.end;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  return parts;
}
