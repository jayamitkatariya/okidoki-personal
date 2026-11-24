import type { InlineDiffCommentBlock, InlineDiffCommentsParsed } from './types';
import { parsePlanQuote } from './plan-quote';

const INLINE_DIFF_COMMENTS_HEADER = 'Inline diff comments for the current changes:';
const INLINE_DIFF_COMMENT_BLOCK_HEADER_REGEX = /^Inline diff comment \d+\s*$/;
const INLINE_DIFF_COMMENT_BLOCK_START_REGEX = /(?:^|\n\n)(Inline diff comment \d+\s*\n[\s\S]*?)(?=\n\nInline diff comment \d+\s*\n|$)/g;

export interface InlineDiffCommentForFormatting {
  path: string;
  startLineNumber?: number;
  lineNumber: number;
  side: string;
  lineText?: string;
  body: string;
}

export function formatInlineDiffCommentsBlock(comments: readonly InlineDiffCommentForFormatting[]): string {
  return [
    INLINE_DIFF_COMMENTS_HEADER,
    comments.map(formatInlineDiffCommentBlock).join('\n\n'),
  ].join('\n\n');
}

export function parseInlineDiffComments(content: string): InlineDiffCommentsParsed | null {
  const headerIndex = content.indexOf(INLINE_DIFF_COMMENTS_HEADER);
  if (headerIndex === -1) return null;

  const leadingText = content.slice(0, headerIndex).trim();
  const body = content.slice(headerIndex + INLINE_DIFF_COMMENTS_HEADER.length).trim();
  const comments: InlineDiffCommentBlock[] = [];

  for (const match of body.matchAll(INLINE_DIFF_COMMENT_BLOCK_START_REGEX)) {
    const comment = parseInlineDiffCommentBlock(match[1].trim());
    if (comment) comments.push(comment);
  }

  if (comments.length === 0) return null;

  return {
    source: 'inline_diff_comments',
    comments,
    leadingText,
    leadingPlanQuote: parsePlanQuote(leadingText) ?? undefined,
  };
}

function formatInlineDiffCommentBlock(comment: InlineDiffCommentForFormatting, index: number) {
  const location = comment.startLineNumber != null && comment.startLineNumber !== comment.lineNumber
    ? `${comment.path}:${comment.startLineNumber}-${comment.lineNumber}`
    : `${comment.path}:${comment.lineNumber}`;
  const side = comment.side === 'additions' ? 'new file' : comment.side === 'deletions' ? 'old file' : comment.side;
  const lines = [
    `Inline diff comment ${index + 1}`,
    `File: ${location}`,
    `Side: ${side}`,
  ];

  if (comment.lineText) {
    lines.push('', comment.startLineNumber != null ? 'Code in this range:' : 'Code on that line:', '```', comment.lineText, '```');
  }

  lines.push('', 'Comment:', comment.body);
  return lines.join('\n');
}

function parseInlineDiffCommentBlock(block: string): InlineDiffCommentBlock | null {
  const lines = block.split('\n');
  if (!INLINE_DIFF_COMMENT_BLOCK_HEADER_REGEX.test(lines[0] ?? '')) return null;

  const location = readInlineDiffCommentField(block, 'File');
  const side = readInlineDiffCommentField(block, 'Side');
  const commentMarker = '\nComment:\n';
  const commentIndex = block.indexOf(commentMarker);

  if (!location || !side || commentIndex === -1) return null;

  const parsedLocation = parseInlineDiffCommentLocation(location);
  const codeMatch = block.match(/\nCode (?:on that line|in this range):\n```(?:[^\n]*)?\n([\s\S]*?)\n```/);

  return {
    ...parsedLocation,
    location,
    side,
    lineText: codeMatch?.[1]?.trimEnd() ?? '',
    body: block.slice(commentIndex + commentMarker.length).trim(),
  };
}

function readInlineDiffCommentField(block: string, label: string): string {
  const match = block.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function parseInlineDiffCommentLocation(location: string): { path: string; startLineNumber?: number; lineNumber: number } {
  const match = location.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: location, lineNumber: 0 };

  if (match[3]) {
    return {
      path: match[1],
      startLineNumber: parseInt(match[2], 10),
      lineNumber: parseInt(match[3], 10),
    };
  }

  return {
    path: match[1],
    lineNumber: parseInt(match[2], 10),
  };
}
