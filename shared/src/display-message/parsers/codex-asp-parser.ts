import { parseTimestampMs } from '../../agent-event-utils';
import type { AgentEvent } from '../../event';
import {
  codexItemFromEvent,
  codexTurnFromEvent,
  getCodexAspTurnResponse,
  normalizeCodexAspTranscriptStatus,
  type CodexAspTranscriptItem,
} from '../../engine/v1';
import { isRecord } from '../../type-guards';
import type { DisplayMessage, SkillMessage } from '../types';
import { skillNamesFromCommand } from '../format';
import { COMPACTION_CONTENT } from '../constants';
import { createCallDisplayMessage, markTurnEnd } from './utils';

interface CodexTurn {
  id: string;
  status: string;
  completedAt?: string;
  error?: string;
  items: CodexAspTranscriptItem[];
}

/**
 * Groups Codex item and turn events by turn, in order of first appearance. A later
 * record of an item replaces the earlier one, so a completed item supersedes its
 * live partial.
 */
export function collectCodexTurns(events: AgentEvent[]): Map<string, CodexTurn> {
  const turns = new Map<string, CodexTurn>();
  const turnFor = (id: string): CodexTurn => {
    const existing = turns.get(id);
    if (existing) return existing;
    const turn: CodexTurn = { id, status: 'inProgress', items: [] };
    turns.set(id, turn);
    return turn;
  };
  for (const event of events) {
    const item = codexItemFromEvent(event);
    if (item) {
      const turn = turnFor(item.turnId);
      const index = turn.items.findIndex((candidate) => candidate.id === item.item.id);
      if (index === -1) turn.items.push(item.item);
      else turn.items[index] = item.item;
      continue;
    }
    const turnEvent = codexTurnFromEvent(event);
    if (turnEvent) {
      const turn = turnFor(turnEvent.turnId);
      turn.status = turnEvent.status;
      turn.completedAt = event.timestamp;
      turn.error = turnEvent.error;
    }
  }
  return turns;
}

const turnMessages = new WeakMap<CodexAspTranscriptItem, { turn: CodexTurn; messages: DisplayMessage[] }>();

export function messagesForCodexTurn(turn: CodexTurn): DisplayMessage[] {
  const [first] = turn.items;
  const cached = first ? turnMessages.get(first) : undefined;
  if (
    cached
    && cached.turn.id === turn.id
    && cached.turn.status === turn.status
    && cached.turn.completedAt === turn.completedAt
    && cached.turn.error === turn.error
    && cached.turn.items.length === turn.items.length
    && cached.turn.items.every((item, index) => item === turn.items[index])
  ) {
    return cached.messages;
  }
  const messages = codexTurnMessages(turn);
  if (first) turnMessages.set(first, { turn, messages });
  return messages;
}

function codexTurnMessages(turn: CodexTurn): DisplayMessage[] {
  const items = turn.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => parseTimestampMs(a.item.timestamp) - parseTimestampMs(b.item.timestamp) || a.index - b.index)
    .map(({ item }) => item);
  const reasoning = items.filter(
    (item): item is Extract<CodexAspTranscriptItem, { type: 'reasoning' }> => item.type === 'reasoning' && item.text.trim().length > 0,
  );
  const firstReasoningIndex = items.findIndex((item) => item.type === 'reasoning');
  const coalesced = items.flatMap((item, index): CodexAspTranscriptItem[] => {
    if (item.type !== 'reasoning') return [item];
    if (index !== firstReasoningIndex || reasoning.length === 0) return [];
    return [{
      type: 'reasoning',
      id: turn.id,
      text: reasoning.map(({ text }) => text.trim()).join('\n\n'),
      timestamp: reasoning[0].timestamp,
      status: reasoning.at(-1)?.status ?? 'completed',
    }];
  });

  // Reasoning belongs above the answer it produced, even when its record landed after it.
  const response = getCodexAspTurnResponse({ status: turn.status, items: coalesced });
  const reasoningIndex = coalesced.findIndex((item) => item.type === 'reasoning');
  const responseIndex = response ? coalesced.indexOf(response) : -1;
  if (responseIndex !== -1 && reasoningIndex > responseIndex) {
    coalesced.splice(responseIndex, 0, ...coalesced.splice(reasoningIndex, 1));
  }

  const messages = coalesced.flatMap((item) => {
    const message = messageForItem(item);
    return [...(message ? [message] : []), ...skillMessagesForItem(item)];
  });
  if (normalizeCodexAspTranscriptStatus(turn.status) !== 'in_progress') markTurnEnd(messages, turn.completedAt);
  if (turn.error) {
    messages.push({
      id: `error-${turn.id}`,
      type: 'error',
      message: turn.error,
      timestamp: turn.completedAt ?? items.at(-1)?.timestamp ?? new Date(0).toISOString(),
    });
  }
  return messages;
}

function inputForDisplay(input: unknown): Record<string, unknown> | string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  if (isRecord(input)) return input;
  return String(input);
}

function isInternalUserMessage(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<goal_context>')
  );
}

function messageForItem(item: CodexAspTranscriptItem): DisplayMessage | null {
  if (item.type === 'userMessage') {
    if (isInternalUserMessage(item.content)) return null;
    return {
      id: `user-${item.id}`,
      type: 'user',
      content: item.content,
      images: item.images,
      timestamp: item.timestamp,
    };
  }

  if (item.type === 'agentMessage' || item.type === 'plan') {
    if (!item.text) return null;
    return {
      id: `agent-${item.id}`,
      type: 'agent',
      content: item.text,
      timestamp: item.timestamp,
      ...(item.type === 'plan' ? { isPlan: true } : {}),
    };
  }

  if (item.type === 'reasoning') {
    if (!item.text) return null;
    return {
      id: `reasoning-${item.id}`,
      type: 'reasoning',
      content: item.text,
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
      ...(item.sourceTimestamp ? { sourceTimestamp: item.sourceTimestamp } : {}),
    };
  }

  if (item.type === 'commandExecution') {
    const skillNames = skillNamesFromCommand(item.command);
    return {
      id: `command-${item.id}`,
      type: 'command',
      command: item.command,
      ...(skillNames.length > 0 ? { skillNames } : {}),
      output: item.output,
      ...(item.okidokiOmitted ? { outputOmitted: item.okidokiOmitted } : {}),
      exitCode: item.exitCode ?? undefined,
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
    };
  }

  if (item.type === 'fileChange') {
    return {
      id: `patch-${item.id}`,
      type: 'patch',
      operations: item.operations,
      output: item.output,
      exitCode: item.exitCode ?? undefined,
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
    };
  }

  if (item.type === 'toolCall') {
    return createCallDisplayMessage({
      id: `toolcall-${item.id}`,
      server: item.server,
      tool: item.tool,
      input: inputForDisplay(item.input),
      output: item.output,
      ...(item.okidokiOmitted ? { outputOmitted: item.okidokiOmitted } : {}),
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
    });
  }

  if (item.type === 'subagent') {
    return {
      id: `subagent-${item.id}`,
      type: 'subagent',
      toolUseId: item.id,
      description: item.description,
      prompt: item.prompt,
      subagentType: item.subagentType,
      ...(item.receiverThreadIds ? { receiverThreadIds: item.receiverThreadIds } : {}),
      ...(item.model ? { model: item.model } : {}),
      status: normalizeCodexAspTranscriptStatus(item.status),
      ...(item.output ? { output: item.output } : {}),
      ...(item.okidokiOmitted ? { outputOmitted: item.okidokiOmitted } : {}),
      nestedEvents: [],
      timestamp: item.timestamp,
    };
  }

  if (item.type === 'webSearch') {
    return {
      id: `web-search-${item.id}`,
      type: 'web_search',
      query: item.query,
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
    };
  }

  if (item.type === 'contextCompaction') {
    return {
      id: `reasoning-${item.id}`,
      type: 'reasoning',
      content: COMPACTION_CONTENT,
      status: normalizeCodexAspTranscriptStatus(item.status),
      timestamp: item.timestamp,
      completedAt: item.completedAt,
    };
  }

  return {
    id: `error-${item.id}`,
    type: 'error',
    message: item.message,
    timestamp: item.timestamp,
  };
}

function skillMessagesForItem(item: CodexAspTranscriptItem): SkillMessage[] {
  if (item.type !== 'userMessage' || !item.skillNames) return [];

  return item.skillNames
    .filter((skillName) => skillName.trim().length > 0)
    .map((skillName, index): SkillMessage => ({
      id: `skill-${item.id}-${index}`,
      type: 'skill',
      skillName,
      status: 'completed',
      timestamp: item.timestamp,
    }));
}
