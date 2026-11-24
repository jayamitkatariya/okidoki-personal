import { parseCodexHistoryEvents } from './codex-history';
import type { AgentProvider } from './agent';
import type { ChatMessageSender } from './engine/v1';
import { getDisplayMessageActivity } from './display-message/format';
import { attachSendersToMessages, parseDisplayMessages } from './display-message/parsers';
import type { DisplayMessage, UserMessage } from './display-message/types';
import { redactSecrets } from './memory-safety';

function parseChatTranscript(
  content: string,
  provider: AgentProvider,
  senders: ChatMessageSender[] | undefined,
): DisplayMessage[] {
  return attachSendersToMessages(parseDisplayMessages(parseCodexHistoryEvents(content), provider), senders);
}

/** Only messages a signed-in person sent; automations, subagent delegation, and system prompts carry no sender. */
export function humanChatTranscriptMessages(
  content: string,
  provider: AgentProvider,
  senders: ChatMessageSender[] | undefined,
): Array<UserMessage & { senderUserId: string }> {
  return parseChatTranscript(content, provider, senders)
    .filter((message): message is UserMessage & { senderUserId: string } => message.type === 'user' && !!message.senderUserId);
}

export function canonicalizeChatTranscriptBlocks(
  content: string,
  provider: AgentProvider,
  senders: ChatMessageSender[] | undefined,
  beforeMessageId?: string,
): string[] {
  const messages = parseChatTranscript(content, provider, senders);
  const end = beforeMessageId === undefined ? messages.length : messages.findIndex(({ id }) => id === beforeMessageId);
  if (end === -1) throw new Error('That message is no longer in the chat history');
  return messages.slice(0, end).flatMap((message): string[] => {
    let block: string | null = null;
    if (message.type === 'user') {
      block = `## User${message.senderEmail ? ` (${message.senderEmail})` : ''}\n${message.content}`;
    } else if (message.type === 'agent') {
      block = `## Agent\n${message.content}`;
    } else if (message.type === 'reasoning') {
      block = `## Agent reasoning (unverified)\nTimestamp: ${message.sourceTimestamp ?? message.timestamp}\n${message.content}`;
    } else {
      const activity = getDisplayMessageActivity(message);
      if (activity) {
        const details: string[] = [];
        if (activity.summary) details.push(`Summary: ${activity.summary}`);
        if (activity.items?.length) {
          details.push(`Items:\n${activity.items.map((item) => `- [${item.status}] ${item.text}`).join('\n')}`);
        }
        if (activity.content) details.push(`Details:\n${activity.content}`);
        if (message.type === 'command' && message.exitCode != null) details.push(`Exit: ${message.exitCode}`);
        block = `## Activity\n${activity.title}${details.length > 0 ? `\n${details.join('\n')}` : ''}`;
      }
    }
    if (!block) return [];
    return [redactSecrets(block)];
  });
}

export function lastUserBlockText(blocks: readonly string[]): string | null {
  const block = blocks.findLast((entry) => entry.startsWith('## User'));
  if (!block) return null;
  const body = block.slice(block.indexOf('\n') + 1).trim();
  return body || null;
}

export function packTranscriptBlocks(blocks: string[], maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('Transcript chunk size must be a positive safe integer');
  }
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    let remaining = block;
    while (remaining) {
      const separator = current ? '\n\n' : '';
      const available = maxChars - current.length - separator.length;
      if (available <= 0) {
        chunks.push(current);
        current = '';
        continue;
      }
      current += `${separator}${remaining.slice(0, available)}`;
      remaining = remaining.slice(available);
      if (current.length === maxChars) {
        chunks.push(current);
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
