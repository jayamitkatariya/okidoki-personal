import { getProviderDisplayName, isValidAgentProvider } from '../agent';
import { isAgentFallbackReason, type AgentFallbackReason } from '../agent-quota';
import { describeChatForkReason, type ChatForkSource, type ChatForkTrigger } from '../chat-fork';
import { isRecord } from '../type-guards';
import type { ChatForkParsed } from './types';

const OPEN_MARKER = '<!-- okidoki:chat-fork ';
const OPEN_MARKER_END = ' -->';
const CLOSE_MARKER = '<!-- /okidoki:chat-fork -->';

export interface ChatForkHandoff {
  source: ChatForkSource;
  trigger: ChatForkTrigger;
  reason?: AgentFallbackReason;
  sourceModel?: string;
  model?: string;
  /** Most recent sanitized turns, inlined so the first response needs no file reads. */
  excerpt: string;
  excerptTruncated: boolean;
  /** The sanitized file holds only the tail of a very large chat; the raw log has the rest. */
  sourceTruncated?: boolean;
  transcriptPath: string;
  rawHistoryPath?: string;
  subagent?: boolean;
  /** The source chat's last user request, resent when the fork interrupted it. */
  resumeRequest: string | null;
  message?: string;
}

export const CHAT_FORK_EXCERPT_OMITTED_NOTICE = '[earlier turns omitted; read the transcript file for them]';

/**
 * First user message of a forked chat. The HTML-comment envelope carries the
 * lineage for the dashboard; everything inside it is what the new agent reads.
 */
export function formatChatForkHandoffMessage(handoff: ChatForkHandoff): string {
  const meta = {
    sourceProvider: handoff.source.provider,
    sourceTitle: handoff.source.title,
    trigger: handoff.trigger,
    reason: handoff.reason,
    sourceModel: handoff.sourceModel,
    model: handoff.model,
  };
  const sourceName = getProviderDisplayName(handoff.source.provider, 'long');
  const reason = describeChatForkReason(handoff.reason, handoff.source.provider);
  const why = handoff.trigger === 'auto'
    ? `until ${reason ?? 'it stopped'}, so Okidoki moved the conversation to you automatically`
    : `until the user ${handoff.trigger === 'switch' ? 'switched' : 'forked'} it to you`;
  const side = handoff.trigger === 'side';
  const body = [
    side ? '# Side chat' : handoff.subagent ? '# Delegated task context' : `# Continuing a ${sourceName} chat`,
    '',
    side
      ? `You are a side chat the user opened next to the main chat "${handoff.source.title}" (${sourceName}) in this same workspace, to talk about it without interrupting it. The main chat may still be working, and nothing you say reaches it or its agent. Answer from its transcript and the workspace. The recent turns below are a snapshot from when you were opened and the main chat has likely moved on, so re-read the transcript file before answering anything about what it is doing or has done. Its agent works in the same files, so don't edit files, change git state, or start or stop processes unless the user explicitly asks you to.`
      : handoff.subagent
        ? `You are a subagent of the chat "${handoff.source.title}" in this same workspace. The inherited transcript is background for your assigned task below. Follow that task and report your result to the parent; do not take over the parent's entire request. Workspace files and git state are shared and authoritative.`
        : `You are picking up the chat "${handoff.source.title}" in this same workspace. It was running on ${sourceName} ${why}. Everything the previous agent changed is already on disk: the workspace files and git state are authoritative.`,
    '',
    '## Transcript',
    '',
    side
      ? `- Main chat transcript: \`${handoff.transcriptPath}\` (Okidoki refreshes it with the main chat's latest turns before each of your turns; re-read it whenever you need the main chat's current state)`
      : `- Sanitized transcript: \`${handoff.transcriptPath}\` (read or grep it for anything not in the excerpt below)`,
    ...(handoff.rawHistoryPath ? [`- Raw event log: \`${handoff.rawHistoryPath}\``] : []),
    ...(handoff.sourceTruncated ? [`- The chat was too large to sanitize in full; the sanitized file holds only its most recent part.${handoff.rawHistoryPath ? ' Grep the raw event log for anything older.' : ''}`] : []),
    '',
    '## Recent turns',
    '',
    ...(handoff.excerptTruncated ? [CHAT_FORK_EXCERPT_OMITTED_NOTICE, ''] : []),
    handoff.excerpt.trim() || '_The source chat had no messages yet._',
  ].join('\n');
  const instruction = handoff.message?.trim() || (side ? 'Say in one sentence that you are ready for questions about the main chat.' : handoff.resumeRequest
    ? `The previous agent was interrupted before it finished this request from the user. Continue it now:\n\n${handoff.resumeRequest.trim().replace(/^/gm, '> ')}`
    : 'Review the recent turns and the current workspace state, then continue where the previous agent left off. If nothing is pending, confirm in a sentence or two what you know and wait for the next request.');
  return `${OPEN_MARKER}${JSON.stringify(meta)}${OPEN_MARKER_END}\n${body}\n${CLOSE_MARKER}\n\n${instruction}`;
}

export function formatChatForkUpdateMessage(source: ChatForkSource, trigger: ChatForkTrigger, turns: string, message: string): string {
  const meta = { sourceProvider: source.provider, sourceTitle: source.title, trigger };
  return `${OPEN_MARKER}${JSON.stringify(meta)}${OPEN_MARKER_END}\n# Main chat update\n\nThe main chat "${source.title}" has new turns since your last reply:\n\n${turns}\n${CLOSE_MARKER}\n\n${message}`;
}

/**
 * The envelope of a chat-fork handoff without validating its lineage, so history can still read forks from
 * providers that no longer exist and envelopes cut off before their closing marker.
 */
export function readChatForkEnvelope(content: string): { meta: Record<string, unknown>; closed: boolean; inner: string; replyText: string } | null {
  if (!content.startsWith(OPEN_MARKER)) return null;
  const metaEnd = content.indexOf(OPEN_MARKER_END, OPEN_MARKER.length);
  if (metaEnd === -1) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(content.slice(OPEN_MARKER.length, metaEnd));
  } catch {
    return null;
  }
  if (!isRecord(meta)) return null;
  // A fork of a fork quotes the earlier handoff, envelope included, so only the last marker closes this one.
  const closeIndex = content.lastIndexOf(CLOSE_MARKER);
  const closed = closeIndex > metaEnd;
  return {
    meta,
    closed,
    inner: content.slice(metaEnd + OPEN_MARKER_END.length, closed ? closeIndex : undefined).trim(),
    replyText: closed ? content.slice(closeIndex + CLOSE_MARKER.length).trim() : '',
  };
}

export function threadHandoffText(content: string): string | null {
  const envelope = readChatForkEnvelope(content);
  if (!envelope?.closed) return null;
  return envelope.meta.trigger === 'auto' ? '' : envelope.replyText;
}

export function parseChatForkHandoff(content: string): ChatForkParsed | null {
  const envelope = readChatForkEnvelope(content);
  if (!envelope?.closed) return null;
  const { meta, inner, replyText } = envelope;
  if (
    typeof meta.sourceProvider !== 'string'
    || !isValidAgentProvider(meta.sourceProvider)
    || (meta.trigger !== 'manual' && meta.trigger !== 'auto' && meta.trigger !== 'side' && meta.trigger !== 'switch')
  ) {
    return null;
  }
  const excerptStart = inner.indexOf('## Recent turns');
  const excerpt = excerptStart !== -1 ? inner.slice(excerptStart + '## Recent turns'.length).trim() : inner;
  return {
    source: 'chat_fork',
    sourceProvider: meta.sourceProvider,
    sourceTitle: typeof meta.sourceTitle === 'string' ? meta.sourceTitle : '',
    trigger: meta.trigger,
    ...(isAgentFallbackReason(meta.reason) ? { reason: meta.reason } : {}),
    ...(typeof meta.sourceModel === 'string' ? { sourceModel: meta.sourceModel } : {}),
    ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
    excerpt,
    replyText,
  };
}
