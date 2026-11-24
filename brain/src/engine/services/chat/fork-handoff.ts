import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import {
  CHAT_FORK_EXCERPT_OMITTED_NOTICE,
  canonicalizeChatTranscriptBlocks,
  lastUserBlockText,
  threadHandoffText,
  OKIDOKI_INSTRUCTIONS_TAG,
  wrapInTag,
  type EngineAgentProvider,
  type ChatMessageSender,
} from '@okidoki/shared';
import { FORKS_DIR, HISTORY_DIR_BY_PROVIDER } from './history-paths';
import { openWholeLog, type OpenedLog } from '../../managers/codex-asp/codex-history-file';

// The excerpt is what the new harness reads before its first tool call; older turns stay
// on disk where it can grep them, so the budget only needs to cover the recent context.
const EXCERPT_MAX_CHARS = 24_000;
const CONVERSATION_UPDATE_MAX_CHARS = 8_000;
const PULL_REQUEST_DECISIONS_MAX_CHARS = 4_000;
// Sanitizing is a synchronous whole-buffer pass on the engine's event loop (roughly 2s and
// 200MB per 32MB), so anything older than this stays in the raw log for the agent to grep.
const MAX_SANITIZED_SOURCE_BYTES = 32 * 1024 * 1024;

function unansweredRequest(blocks: readonly string[]): string | null {
  const lastUser = blocks.findLastIndex((block) => block.startsWith('## User'));
  if (lastUser === -1) return null;
  const answered = blocks.slice(lastUser + 1).some((block) => block.startsWith('## Agent'));
  return answered ? null : lastUserBlockText(blocks);
}

export async function readHistoryTail(path: string, maxBytes: number, openHistory = () => openWholeLog(path)): Promise<{ content: string; truncated: boolean }> {
  const opened = await openHistory();
  if (!opened) return { content: '', truncated: false };
  const { file: handle, size } = opened;
  try {
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(buffer, 0, buffer.length, size - buffer.length);
    if (size <= maxBytes) return { content: buffer.toString('utf-8'), truncated: false };
    // The window almost always opens mid-line; drop that fragment so every line parses.
    const firstNewline = buffer.indexOf(0x0a);
    return { content: buffer.subarray(firstNewline + 1).toString('utf-8'), truncated: true };
  } finally {
    await handle.close();
  }
}

function tailBlocks(blocks: readonly string[], maxChars: number): { excerpt: string; truncated: boolean } {
  let start = blocks.length;
  while (start > 0 && blocks.slice(start - 1).join('\n\n').length <= maxChars) start--;
  const excerpt = start < blocks.length ? blocks.slice(start).join('\n\n') : `…${blocks.at(-1)?.slice(-maxChars) ?? ''}`;
  return { excerpt, truncated: start > 0 };
}

export function hashTranscriptBlocks(blocks: readonly string[]): string[] {
  return blocks.map((block) => createHash('sha1').update(block).digest('base64'));
}

function unseenBlocks(seenHashes: readonly string[], blocks: readonly string[]): string[] {
  const hashes = hashTranscriptBlocks(blocks);
  let common = 0;
  while (common < seenHashes.length && common < blocks.length && seenHashes[common] === hashes[common]) common++;
  return blocks.slice(common);
}

function excerptOf(blocks: readonly string[], maxChars: number): string | null {
  if (blocks.length === 0) return null;
  const { excerpt, truncated } = tailBlocks(blocks, maxChars);
  return truncated ? `${CHAT_FORK_EXCERPT_OMITTED_NOTICE}\n\n${excerpt}` : excerpt;
}

export function unseenTurnsExcerpt(seenHashes: readonly string[], blocks: readonly string[]): string | null {
  return excerptOf(unseenBlocks(seenHashes, blocks), EXCERPT_MAX_CHARS);
}

export function unseenConversationExcerpt(seenHashes: readonly string[], blocks: readonly string[]): string | null {
  const conversation = unseenBlocks(seenHashes, blocks).filter((block) => block.startsWith('## User') || block.startsWith('## Agent\n'));
  return excerptOf(conversation, CONVERSATION_UPDATE_MAX_CHARS);
}

export interface ForkHandoffSegment {
  chatId: string;
  provider: EngineAgentProvider;
  senders: ChatMessageSender[];
  /** The chat's log, opened with its flushed end: bytes past it may belong to a record still being written. */
  openHistory?: () => Promise<OpenedLog | null>;
}

/** A continued chat's earlier handoffs read as the user's own messages, so the thread's transcript never nests. */
function unwrapHandoffBlock(block: string): string | null {
  const newline = block.indexOf('\n');
  const text = block.startsWith('## User') ? threadHandoffText(block.slice(newline + 1)) : null;
  if (text === null) return block;
  return text ? `${block.slice(0, newline)}\n${text}` : null;
}

/** `segments` is the source chat's thread, oldest first: every chat it continues, then the chat itself. */
export async function buildForkHandoff(input: {
  segments: ForkHandoffSegment[];
  targetChatId: string;
  turnLimit?: number;
  beforeMessageId?: string;
  transcriptName?: string;
}) {
  const sources = await Promise.all(input.segments.map(async (segment, index) => {
    const rawHistoryPath = join(HISTORY_DIR_BY_PROVIDER[segment.provider], `${segment.chatId}.jsonl`);
    const { content, truncated } = await readHistoryTail(rawHistoryPath, MAX_SANITIZED_SOURCE_BYTES, segment.openHistory);
    const last = index === input.segments.length - 1;
    const blocks = canonicalizeChatTranscriptBlocks(content, segment.provider, segment.senders, last ? input.beforeMessageId : undefined)
      .filter((block) => !block.startsWith('## Agent reasoning'));
    return { rawHistoryPath, truncated, blocks: index === 0 ? blocks : blocks.flatMap((block) => unwrapHandoffBlock(block) ?? []) };
  }));
  let blocks = sources.flatMap((source) => source.blocks);
  const sourceTruncated = sources.some((source) => source.truncated);
  // The raw log also holds what came after the cut, so a partial fork never points the agent at it.
  const fullHistory = input.turnLimit === undefined && input.beforeMessageId === undefined;
  if (input.turnLimit !== undefined) {
    let turns = 0;
    const start = blocks.findLastIndex((block) => block.startsWith('## User') && ++turns === input.turnLimit);
    blocks = blocks.slice(Math.max(0, start));
  }
  const forkDir = join(FORKS_DIR, input.targetChatId);
  await mkdir(forkDir, { recursive: true });
  const transcriptPath = join(forkDir, input.transcriptName ?? 'source-transcript.md');
  const rawHistoryPaths = sources.map((source) => source.rawHistoryPath);
  const header = sourceTruncated
    ? `_This file was generated from only the most recent ${MAX_SANITIZED_SOURCE_BYTES / 1024 / 1024} MB of ${sources.length > 1 ? 'each part of ' : ''}the source chat.${fullHistory ? ` The complete raw event ${sources.length > 1 ? `logs are, oldest first: ${rawHistoryPaths.join(', ')}` : `log is at ${rawHistoryPaths[0]}`}; grep ${sources.length > 1 ? 'them' : 'it'} for anything earlier.` : ''}_\n\n`
    : '';
  await writeFile(transcriptPath, `${header}${blocks.join('\n\n')}\n`, 'utf-8');
  const { excerpt, truncated } = tailBlocks(blocks, EXCERPT_MAX_CHARS);
  return {
    excerpt,
    excerptTruncated: truncated,
    sourceTruncated,
    blocks,
    resumeRequest: unansweredRequest(blocks),
    transcriptPath,
    rawHistoryPath: fullHistory ? rawHistoryPaths.at(-1) : undefined,
  };
}

export async function readPullRequestDecisions(notesPath: string): Promise<string | null> {
  const notes = await readFile(notesPath.replace(/^~(?=\/)/, homedir()), 'utf-8').catch(() => '');
  const decisions = /^## Decisions[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(notes)?.[1].trim();
  if (!decisions) return null;
  const body = decisions.length > PULL_REQUEST_DECISIONS_MAX_CHARS
    ? `${decisions.slice(0, PULL_REQUEST_DECISIONS_MAX_CHARS)}\n…(more in the file)`
    : decisions;
  return wrapInTag(`Decisions recorded for this PR in \`${notesPath}\`. Never undo these:\n${body}`, OKIDOKI_INSTRUCTIONS_TAG);
}
