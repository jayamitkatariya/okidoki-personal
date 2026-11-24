// Long selections can cross rendered chrome that isn't in the selected text, like a code block's header or a message's timestamp, so long quotes match on their ends, or else on all their lines in order, which chrome sits between.
const EDGE_LENGTH = 24;
export const stripWhitespace = (text: string) => text.replace(/\s+/g, '');

export function locateQuote(haystack: string, text: string, chrome?: ReadonlySet<string>, from = 0): [number, number] | null {
  const needle = stripWhitespace(text);
  if (!needle) return null;
  // Tightest, so parts repeated elsewhere in the text don't stretch the match to them.
  const inOrder = (parts: string[]): [number, number] | null => {
    const length = parts.join('').length;
    let best: [number, number] | null = null;
    for (let start = haystack.indexOf(parts[0], from); start !== -1; start = haystack.indexOf(parts[0], start + 1)) {
      let end = start;
      for (const part of parts) {
        const at = haystack.indexOf(part, end);
        if (at === -1) return best;
        end = at + part.length;
      }
      if (!best || end - start < best[1] - best[0]) best = [start, end];
      if (end - start === length) return best;
    }
    return best;
  };
  const whole = inOrder([needle]);
  if (whole || needle.length <= EDGE_LENGTH * 2) return whole;
  const lines = text.split('\n').map(stripWhitespace).filter((line) => line && !chrome?.has(line));
  return inOrder([needle.slice(0, EDGE_LENGTH), needle.slice(-EDGE_LENGTH)]) ?? (lines.length > 0 && lines.join('').length * 2 >= needle.length ? inOrder(lines) : null);
}

export function* quoteMatches(haystack: string, text: string, chrome?: ReadonlySet<string>) {
  for (let match = locateQuote(haystack, text, chrome); match; match = locateQuote(haystack, text, chrome, match[0] + 1)) yield match;
}

export function locateQuoteOccurrence(haystack: string, text: string, occurrence = 0, chrome?: ReadonlySet<string>): [number, number] | null {
  let index = 0;
  for (const match of quoteMatches(haystack, text, chrome)) if (index++ === occurrence) return match;
  return null;
}
