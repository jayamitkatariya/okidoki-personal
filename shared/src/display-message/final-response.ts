import type { AgentProvider } from '../agent';
import type { ChatHistoryResponse } from '../engine/v1';
import { parseAgentEvents } from './parsers';

export function extractFinalResponse(
  history: ChatHistoryResponse,
  provider: AgentProvider,
): string | null {
  const message = parseAgentEvents(history.events ?? [], provider)
    .findLast((candidate) => candidate.type === 'agent');
  return message?.type === 'agent' && message.content ? message.content : null;
}
