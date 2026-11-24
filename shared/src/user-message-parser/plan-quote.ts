import type { PlanQuoteBlock, PlanQuoteParsed } from './types';

export type PendingPlanQuote = {
  id: string;
  planFilename: string;
  quotedText: string;
  replyText: string;
};

/**
 * Format used when serializing a plan quote into a chat message. The marker
 * line is itself a markdown blockquote so the message still renders nicely
 * if the structured parser misses it for any reason.
 *
 * Example:
 *
 *   > _Quoting from plan_ `implementation.md`
 *   >
 *   > The selected chunk of plan text
 *   > that spans multiple lines
 *
 *   My reply text here
 */
const MARKER_PREFIX = '> _Quoting from plan_';
const MARKER_LINE_REGEX = /^> _Quoting from plan_ `([^`\n]+)`\s*$/;

export function formatBlockquote(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Serialize a single plan-quote + reply block as chat-message text. The
 * reply text is appended below the blockquote separated by a blank line.
 */
export function formatPlanQuoteBlock(
  planFilename: string,
  quotedText: string,
  replyText: string = ''
): string {
  const header = `> _Quoting from plan_ \`${planFilename}\``;
  const body = `${header}\n>\n${formatBlockquote(quotedText)}`;

  const trimmedReply = replyText.trimEnd();
  return trimmedReply.length > 0 ? `${body}\n\n${trimmedReply}` : body;
}

/**
 * Check whether a message string contains a plan-quote marker. Cheap test
 * used to short-circuit the parser chain.
 */
export function hasPlanQuoteMarker(content: string): boolean {
  return content.includes(MARKER_PREFIX);
}

/**
 * Parse a message containing one or more plan-quote blocks.
 *
 * Returns `null` if no marker is found. Otherwise walks the message line by
 * line, grouping consecutive blockquote lines that follow a marker as the
 * quoted text, and treating following non-blockquote lines as that quote's
 * reply (until the next marker or end of message).
 */
export function parsePlanQuote(content: string): PlanQuoteParsed | null {
  if (!hasPlanQuoteMarker(content)) return null;

  const lines = content.split('\n');
  const blocks: PlanQuoteBlock[] = [];
  const leadingBuffer: string[] = [];

  let currentFilename: string | null = null;
  let quoteBuffer: string[] = [];
  let replyBuffer: string[] = [];
  let inQuoteBody = false;

  const flushCurrentBlock = () => {
    if (currentFilename !== null) {
      blocks.push({
        planFilename: currentFilename,
        quotedText: trimBlankEdges(quoteBuffer).join('\n'),
        replyText: trimBlankEdges(replyBuffer).join('\n'),
      });
    }
    currentFilename = null;
    quoteBuffer = [];
    replyBuffer = [];
    inQuoteBody = false;
  };

  for (const line of lines) {
    const markerMatch = line.match(MARKER_LINE_REGEX);
    if (markerMatch) {
      flushCurrentBlock();
      currentFilename = markerMatch[1].trim();
      inQuoteBody = true;
      continue;
    }

    if (currentFilename !== null) {
      if (inQuoteBody && isBlockquoteLine(line)) {
        quoteBuffer.push(stripBlockquotePrefix(line));
        continue;
      }
      // First non-blockquote line ends the quote body and starts the reply.
      inQuoteBody = false;
      replyBuffer.push(line);
      continue;
    }

    leadingBuffer.push(line);
  }

  flushCurrentBlock();

  if (blocks.length === 0) return null;

  return {
    source: 'plan_quote',
    blocks,
    leadingText: trimBlankEdges(leadingBuffer).join('\n'),
  };
}

function isBlockquoteLine(line: string): boolean {
  return line.startsWith('>');
}

function stripBlockquotePrefix(line: string): string {
  // Matches `> `, `>` (empty blockquote line), and any leading whitespace inside the quote.
  return line.replace(/^>\s?/, '');
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}
