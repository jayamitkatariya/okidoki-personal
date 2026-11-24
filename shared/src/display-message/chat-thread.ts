import { getProviderDisplayName, type AgentProvider } from '../agent';
import { describeAuthFallback, describeModelRefusalFallback } from '../auth-fallback';
import { describeChatForkReason, type ChatForkTrigger } from '../chat-fork';
import { parseChatForkHandoff, threadHandoffText } from '../user-message-parser/chat-fork';
import { parseTimestampMs } from '../user-message-matching';
import type { DisplayMessage, HarnessSwitchMessage, SwitchNoticeMessage } from './types';

function describeHarnessSwitch(message: HarnessSwitchMessage): string {
  if (message.trigger === 'switch') return `Switched from ${getProviderDisplayName(message.fromProvider, 'long')} to ${getProviderDisplayName(message.toProvider, 'long')}`;
  const reason = describeChatForkReason(message.reason, message.fromProvider) ?? `${getProviderDisplayName(message.fromProvider)} stopped`;
  return `${reason}, continuing in ${getProviderDisplayName(message.toProvider, 'long')}`;
}

export function describeSwitchNotice(message: SwitchNoticeMessage): string {
  if (message.type === 'harness_switch') return describeHarnessSwitch(message);
  const { headline, outcomeClause } = message.type === 'model_fallback' ? describeModelRefusalFallback(message) : describeAuthFallback(message);
  return `${headline} — ${outcomeClause}`;
}

export interface ChatThreadSegment {
  provider: AgentProvider;
  model?: string;
  /** How this segment's chat began, so a switch still reads as one before its handoff message loads. */
  trigger?: ChatForkTrigger;
  messages: DisplayMessage[];
}

export function mergeChatThread(segments: readonly ChatThreadSegment[]): DisplayMessage[] {
  const merged: DisplayMessage[] = [];
  segments.forEach(({ provider, model, trigger, messages }, index) => {
    if (index === 0) {
      merged.push(...messages);
      return;
    }
    const handoffIndex = messages.findIndex((message) => {
      const trigger = message.type === 'user' ? parseChatForkHandoff(message.content)?.trigger : undefined;
      return trigger === 'auto' || trigger === 'switch';
    });
    const handoff = messages[handoffIndex];
    const parsed = handoff?.type === 'user' ? parseChatForkHandoff(handoff.content) : null;
    const switched = (parsed?.trigger ?? trigger) === 'switch';
    const fromModel = parsed?.sourceModel ?? segments[index - 1].model;
    const toModel = parsed?.model ?? model;
    const anchor = handoff ?? messages[0];
    // A fallback's error and handoff are the old harness stopping; a switch's handoff is the user's message.
    // That error is the last row the old chat had when the handoff was written. A refused copy written before then stands after an error and keeps it,
    // as nothing on an error says it is the fallback's own; one written later is passed over. With no readable handoff time it is the last row, as before.
    const handoffMs = parseTimestampMs(anchor?.timestamp ?? '') || Infinity;
    const stopped = merged.findLastIndex((message) => parseTimestampMs(message.timestamp) <= handoffMs);
    if (!switched && merged[stopped]?.type === 'error' && !merged[stopped].id.startsWith('message-rejected-')) merged.splice(stopped, 1);
    merged.push({
      id: `harness-switch-${anchor?.id ?? index}`,
      type: 'harness_switch',
      trigger: switched ? 'switch' : 'auto',
      fromProvider: segments[index - 1].provider,
      toProvider: provider,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
      ...(parsed?.reason ? { reason: parsed.reason } : {}),
      timestamp: anchor?.timestamp ?? merged.at(-1)?.timestamp ?? new Date(0).toISOString(),
    });
    merged.push(...messages.flatMap((message, messageIndex) => {
      if (messageIndex !== handoffIndex || message.type !== 'user') return [message];
      const text = threadHandoffText(message.content);
      return text ? [{ ...message, content: text }] : [];
    }));
  });
  return merged;
}
