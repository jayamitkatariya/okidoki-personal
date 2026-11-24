import { z } from 'zod';
import {
  ENGINE_AGENT_PROVIDERS,
  VALID_AGENT_PROVIDERS,
  VALID_THINKING_LEVELS,
  getProviderDisplayName,
  type AgentProvider,
  type ThinkingLevel,
} from './agent';
import { AGENT_FALLBACK_REASONS, type AgentFallbackReason } from './agent-quota';
import { fallbackHarnessStepSchema } from './fallback-chains';
import { DEFAULT_CHAT_TITLES, isDefaultChat } from './engine/types';
import type { ChatSummary } from './engine/v1';

const fallbackReasonSchema = z.enum(AGENT_FALLBACK_REASONS);

const chatForkInfoSchema = z.object({
  source: z.object({
    chatId: z.string().min(1),
    provider: z.enum(VALID_AGENT_PROVIDERS),
    title: z.string(),
  }),
  trigger: z.enum(['manual', 'auto', 'side', 'switch']),
  reason: fallbackReasonSchema.optional(),
  state: z.enum(['preparing', 'ready', 'failed']),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

export type ChatForkInfo = z.infer<typeof chatForkInfoSchema>;
export type ChatForkSource = ChatForkInfo['source'];
export type ChatForkTrigger = ChatForkInfo['trigger'];

export function coerceChatForkInfo(value: unknown): ChatForkInfo | null {
  const parsed = chatForkInfoSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const forkChatRequestSchema = z.object({
  provider: z.enum(ENGINE_AGENT_PROVIDERS),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional(),
  title: z.string().min(1).max(200).optional(),
  message: z.string().trim().optional(),
  id: z.string().uuid().optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
  enableInteractiveTools: z.boolean().optional(),
  // Server-injected by the monolith from the authenticated request; never trusted from clients.
  senderUserId: z.string().optional(),
  senderEmail: z.string().optional(),
  senderDisplayName: z.string().optional(),
  senderAvatarUrl: z.string().optional(),
});

export type ForkChatRequest = z.infer<typeof forkChatRequestSchema>;

export interface ForkChatResponse {
  chat: ChatSummary;
}

/** Served only to engines that predate fallback chains, which parse it themselves. */
export interface ChatForkFallbackResponse {
  provider: AgentProvider | null;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export function describeQuotaLimit(reason: AgentFallbackReason): string {
  if (reason === 'auth_failed') return 'could not authenticate';
  if (reason === 'credits_required') return 'needed usage credits for the selected model';
  if (reason === 'model_unavailable') return 'could not serve the selected model';
  return reason === 'out_of_credits' ? 'ran out of credits' : 'hit its usage limit';
}

export function describeChatForkReason(reason: AgentFallbackReason | undefined, provider: AgentProvider): string | null {
  return reason ? `${getProviderDisplayName(provider)} ${describeQuotaLimit(reason)}` : null;
}

/** Emitted only once credential fallback is exhausted, not on every quota error. */
export const AGENT_QUOTA_EXHAUSTED_EVENT_TYPE = 'agent-quota-exhausted';

export const agentQuotaExhaustedPayloadSchema = z.object({
  provider: z.enum(VALID_AGENT_PROVIDERS),
  reason: fallbackReasonSchema,
  detail: z.string().optional(),
  forkTo: fallbackHarnessStepSchema.optional(),
});

export type AgentQuotaExhaustedPayload = z.infer<typeof agentQuotaExhaustedPayloadSchema>;

export function defaultForkChatTitle(source: Pick<ChatSummary, 'provider' | 'title'>, provider: AgentProvider): string {
  return isDefaultChat(source) ? `Forked from ${source.title}` : `${source.title} (${getProviderDisplayName(provider)})`;
}

export function getContinuedChatName(chat: Pick<ChatSummary, 'provider' | 'title' | 'displayName'>, provider: AgentProvider): string {
  const name = chat.displayName ?? chat.title;
  return name === DEFAULT_CHAT_TITLES[chat.provider] ? DEFAULT_CHAT_TITLES[provider] : name;
}

/**
 * A harness fallback or switch carries its source's conversation on. A fallback whose source was used after the fork
 * (before messages followed forks) leaves two conversations; a switch stops its source first, so it never diverges.
 */
const continuesChat = (chat: ChatSummary, source: ChatSummary) => !chat.deletedAt && chat.fork?.source.chatId === source.id
  && (chat.fork.trigger === 'switch' || (chat.fork.trigger === 'auto' && source.updatedAt <= chat.fork.startedAt));

export function getChatContinuation(chats: readonly ChatSummary[], chatId: string | null): ChatSummary | undefined {
  const source = chatId ? chats.find((chat) => chat.id === chatId) : undefined;
  const next = source && chats.find((chat) => continuesChat(chat, source));
  return next && (getChatContinuation(chats, next.id) ?? next);
}

export function getContinuedChatIds(chats: readonly ChatSummary[]): Set<string> {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  return new Set(chats.flatMap((chat) => {
    const source = chat.fork && byId.get(chat.fork.source.chatId);
    return source && continuesChat(chat, source) ? [source.id] : [];
  }));
}

export function getCurrentChat(chats: readonly ChatSummary[], chatId: string | null): ChatSummary | undefined {
  return getChatContinuation(chats, chatId) ?? chats.find((chat) => chat.id === chatId);
}

/** Without a provider, a message's model was picked for the chat it was sent to, so a continuation on another harness keeps its own. */
export function requestForContinuation<T extends { provider?: AgentProvider; model?: string }>(
  request: T,
  addressed: AgentProvider | undefined,
  continuation: AgentProvider | undefined,
): T {
  return request.provider || addressed === continuation ? request : { ...request, model: undefined };
}

export function getChatThreadSources(chats: readonly ChatSummary[], chat: ChatSummary | null): ChatSummary[] {
  const sources: ChatSummary[] = [];
  for (let current = chat; current;) {
    const fork = current;
    const source = chats.find((candidate) => continuesChat(fork, candidate));
    if (!source) break;
    sources.unshift(source);
    current = source;
  }
  return sources;
}
