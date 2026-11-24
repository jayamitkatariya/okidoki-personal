import { withCamelCaseKeys } from '../api-casing';
import { IMAGE_MEDIA_TYPES, type ImageContent } from './types';
import { CHAT_KINDS, type ChatKind } from '../chat-kind';
import { AGENT, ENGINE_AGENT_PROVIDERS, VALID_THINKING_LEVELS, type AgentProvider, type EngineAgentProvider, type ThinkingLevel } from '../agent';
import type { CodeHostProvider } from '../code-host';
import type { ChatForkInfo } from '../chat-fork';
import {
  ACCEPTED_USER_MESSAGE_SOURCE,
  CODEX_ITEM_EVENT_TYPE,
  CODEX_ITEM_PARTIAL_EVENT_TYPE,
  CODEX_TURN_EVENT_TYPE,
  REPLACED_MESSAGE_ID_PAYLOAD_KEY,
  RESENT_MESSAGE_ID_PAYLOAD_KEY,
  USER_MESSAGE_ID_PAYLOAD_KEY,
  type AgentEvent,
  type ChatGoal,
  type ChatGoalStatus,
} from '../event';
import type { SlashCommand } from '../slash-commands';
import type { AgentCredentialSnapshot } from '../analytics/types';
import { CLIENT_MESSAGE_SOURCES, MESSAGE_SOURCES, type MessageSource } from '../pricing';
import { isRecord } from '../type-guards';
import { z } from 'zod';

export const MERGED_MESSAGE_SEPARATOR = '\n\n<!-- okidoki:merged -->\n\n';

export interface EngineEventEnvelope<TType extends string, TPayload> {
  id: string;
  ts: string;
  type: TType;
  payload: TPayload;
  /** Position in the engine's event stream for this boot; absent on engines without resumable streams. */
  seq?: number;
}

/** A stream resumes after `<epoch>:<seq>`; `resumed: false` means events may have been missed. */
interface EngineStreamOpenedPayload {
  epoch: string;
  seq: number;
  resumed: boolean;
}

export const ENGINE_STREAM_LAST_EVENT_ID_HEADER = 'Last-Event-ID';

export type EngineEvent =
  | EngineEventEnvelope<'engine.ready', { version: 'v1' }>
  | EngineEventEnvelope<'engine.stream.opened', EngineStreamOpenedPayload>
  | EngineEventEnvelope<'engine.status.changed', { status: EngineStatusSnapshot }>
  | EngineEventEnvelope<'repo.discovered', { repos: EngineRepoState[] }>
  | EngineEventEnvelope<'repo.status.changed', { repos: EngineRepoState[] }>
  | EngineEventEnvelope<'chat.created', { chat: ChatSummary; clientRequestId?: string }>
  | EngineEventEnvelope<'chat.updated', { chat: ChatSummary }>
  | EngineEventEnvelope<'chat.deleted', { chatId: string; chat?: ChatSummary }>
  | EngineEventEnvelope<'chat.turn.accepted', { chatId: string; messageId: string; queued: boolean; position: number; sender?: ChatMessageSender; event?: AgentEvent }>
  | EngineEventEnvelope<'chat.turn.started', { chatId: string; messageId: string; sender?: ChatMessageSender; event?: AgentEvent }>
  /** `historyEnd`: the chat's history file length when this was published; every event published later sits at or after it. */
  | EngineEventEnvelope<'chat.turn.delta', { chatId: string; messageId?: string; event: AgentEvent; historyEnd?: number }>
  | EngineEventEnvelope<'chat.turn.completed', { chatId: string; isComplete: boolean; processing?: boolean; completedAt?: string }>
  | EngineEventEnvelope<'chat.interrupted', { chatId: string; interrupted: boolean; queue: string[] }>
  | EngineEventEnvelope<'chat.queue.changed', ChatQueueResponse>
  | EngineEventEnvelope<'hooks.started', { running: boolean; completed: boolean }>
  | EngineEventEnvelope<'hooks.progress', { running: boolean; completed: boolean }>
  | EngineEventEnvelope<'hooks.completed', { running: boolean; completed: boolean }>
  | EngineEventEnvelope<'hooks.failed', { running: boolean; completed: boolean }>
  | EngineEventEnvelope<'hooks.status', { running: boolean; completed: boolean }>
  | EngineEventEnvelope<'preview.changed', { previews: PreviewPort[] }>
  | EngineEventEnvelope<'error', { code: string; message: string; details?: string }>;

export function getTerminalChatProcessing(
  event: Extract<EngineEvent, { type: 'chat.turn.completed' | 'chat.interrupted' }>,
): boolean {
  return event.type === 'chat.turn.completed' ? event.payload.processing ?? false : false;
}

// Deferred workspace naming
export interface SetWorkspaceNameRequest {
  name: string;
}

export interface SetWorkspaceNameResponse {
  success: boolean;
  repos: Array<{ name: string; branch: string; resumed: boolean }>;
}

export const engineStatusSnapshotSchema = z.object({
  uptimeSeconds: z.number(),
  hasActiveSSHSessions: z.boolean(),
  activeSseClients: z.number(),
  chatsTotal: z.number(),
  chatsProcessing: z.number(),
  chatsWithActiveTurn: z.number().optional(),
  reposTotal: z.number(),
  hooksRunning: z.boolean(),
  desktopReady: z.boolean().optional(),
});

export type EngineStatusSnapshot = z.infer<typeof engineStatusSnapshotSchema>;

export interface EngineStartupTiming {
  startedAtMs: number;
  durationMs: number;
}

export interface EngineStartupTimings {
  elapsedMs: number;
  steps: Record<string, EngineStartupTiming>;
}

export const ENGINE_HEALTH_WAIT_HEADER = 'X-Okidoki-Health-Wait';
export const ENGINE_HEALTH_WAIT_QUERY_PARAM = 'wait_ms';
export const ENGINE_HEALTH_MAX_WAIT_MS = 2000;

export const ENGINE_LIFECYCLE_STATES = ['parked', 'active', 'sleeping'] as const;
export type EngineLifecycleState = (typeof ENGINE_LIFECYCLE_STATES)[number];
export const ENGINE_ACTIVATE_PATH = '/lifecycle/activate';
export const ENGINE_SLEEP_PATH = '/lifecycle/sleep';

export interface EngineActivateRequest {
  workspaceId: string;
}

export interface EngineLifecycleResponse {
  state: EngineLifecycleState;
  workspaceId: string | null;
}

export interface EngineHealthResponse {
  status: 'initializing' | 'active';
  timestamp: string;
  startup?: EngineStartupTimings;
  /** Absent on engine builds that predate the lifecycle routes. */
  state?: EngineLifecycleState;
  /** The exec protocol the engine serves for the Okidoki harness; absent on engines without it. */
  execProtocol?: number;
}

export interface EngineRepoDiff {
  added: number;
  removed: number;
  fullDiff?: string;
}

export interface EngineRepoState {
  name: string;
  path: string;
  defaultBranch: string;
  currentBranch: string;
  /**
   * All pull request URLs the workspace has associated with this repository,
   * across every branch the engine has observed. A single workspace can open
   * multiple PRs in the same repository (e.g. by switching branches or by
   * opening follow-up PRs), so this is an array rather than a single value.
   */
  prUrls: string[];
  gitDiff: EngineRepoDiff | null;
  startHooksCompleted: boolean;
  provider?: CodeHostProvider;
  /** Canonical git origin URL computed by the engine from the repository on disk. */
  repositoryUrl?: string;
}

// Similar to PersistedChat in chat-service.ts?
// Can we unify?
export interface ChatSummary {
  id: string;
  provider: AgentProvider;
  model?: string;
  /** The latest turn's level; absent when it ran at the provider default, or on older engines. */
  thinkingLevel?: ThinkingLevel;
  title: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  /** Opaque revision of an idle chat's history; absent while changing or on older engines. */
  historyVersion?: string;
  /**
   * Present when `processing` authoritatively tracks the main agent turn.
   * Background tasks do not keep the turn active.
   */
  activityTrackingVersion?: 1;
  processing: boolean;
  parentChatId: string | null;
  /**
   * The agent has issued an interactive tool call (e.g. a question
   * for the user) and is paused until the user selects an option.
   * `processing` stays true while this is true — the turn hasn't ended —
   * but the agent isn't actually computing; it's blocked on the user.
   */
  awaitingInput?: boolean;
  isAuthRetrying?: boolean;
  mayBeReconnecting?: boolean;
  goal?: ChatGoal | null;
  lastMessageText?: string | null;
  deletedAt?: string | null;
  fork?: ChatForkInfo | null;
  kind?: ChatKind;
  /** The credential the chat's latest turn ran on, such as a member's Scout DM; 'workspace' when it used the workspace's, absent until a turn reports. */
  chatCredential?: AgentCredentialSnapshot | 'workspace';
  retryingMessageIds?: string[];
}

export const updateChatDisplayNameRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

export interface UpdateChatDisplayNameResponse {
  chat: ChatSummary;
}

export interface CreateChatRequest {
  id?: string;
  createdAt?: string;
  provider: AgentProvider;
  title?: string;
  parentChatId?: string;
  /** Inherit this chat's context with the first message, without starting a turn on creation. */
  forkSourceChatId?: string;
  pullRequestNotesPath?: string;
  kind?: ChatKind;
  sideChat?: boolean;
  clientRequestId?: string;
}

const createChatFields = z.object({
  id: z.string().uuid().optional(),
  createdAt: z.string().datetime().optional(),
  provider: z.enum(ENGINE_AGENT_PROVIDERS),
  title: z.string().min(1).optional(),
  parentChatId: z.string().uuid().optional(),
  forkSourceChatId: z.string().uuid().optional(),
  pullRequestNotesPath: z.string().min(1).optional(),
  kind: z.enum(CHAT_KINDS).optional(),
  sideChat: z.boolean().optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
});

export const createChatRequestSchema = createChatFields.refine((request) => !request.sideChat || (request.forkSourceChatId !== undefined && request.parentChatId === request.forkSourceChatId), {
  message: 'A side chat must fork its parent chat',
}) satisfies z.ZodType<CreateChatRequest>;

export const createHarnessChatRequestSchema = createChatFields.pick({ id: true, title: true, parentChatId: true, forkSourceChatId: true, sideChat: true }).extend({ provider: z.literal(AGENT.OKIDOKI) })
  .refine((request) => !request.parentChatId && !request.forkSourceChatId && !request.sideChat
    || request.sideChat === true && request.parentChatId !== undefined && request.forkSourceChatId === request.parentChatId,
  { message: 'A Okidoki side chat must fork its parent chat.' });

export interface CreateChatResponse {
  chat: ChatSummary;
}

export interface SpawnSubagentRequest {
  provider: EngineAgentProvider;
  prompt: string;
  forkTurns?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  ultrafastMode?: boolean;
  title?: string;
}

export interface MessageSubagentRequest {
  message: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  ultrafastMode?: boolean;
}

export const spawnSubagentRequestSchema = z.object({
  provider: z.enum(ENGINE_AGENT_PROVIDERS),
  prompt: z.string().min(1),
  forkTurns: z.string().regex(/^(all|none|[1-9]\d*)$/).refine(
    (value) => value === 'all' || value === 'none' || Number.isSafeInteger(Number(value)),
    'Expected all, none, or a positive safe integer string',
  ).default('all'),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional(),
  fastMode: z.boolean().optional(),
  ultrafastMode: z.boolean().optional(),
  title: z.string().min(1).optional(),
}) satisfies z.ZodType<SpawnSubagentRequest>;

export const messageSubagentRequestSchema = z.object({
  message: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional(),
  fastMode: z.boolean().optional(),
  ultrafastMode: z.boolean().optional(),
}) satisfies z.ZodType<MessageSubagentRequest>;

export const waitSubagentRequestSchema = z.object({
  timeoutMinutes: z.coerce.number().positive().max(1440).optional(),
});

export interface SubagentResponse {
  chatId: string;
  status: 'working' | 'completed';
  response?: string;
  timedOut?: true;
  interruptedByUserMessage?: true;
}

export const subagentResponseSchema = z.object({
  chatId: z.string().uuid(),
  status: z.enum(['working', 'completed']),
  response: z.string().optional(),
  timedOut: z.literal(true).optional(),
  interruptedByUserMessage: z.literal(true).optional(),
}) satisfies z.ZodType<SubagentResponse>;

export interface ListChatsResponse {
  chats: ChatSummary[];
  /** Soft-deleted chats, restorable from tab history. Absent on older engines. */
  deletedChats?: ChatSummary[];
}

export interface ListChatsWithOpeningHistoryResponse extends ListChatsResponse {
  opening?: { chatId: string; history: ChatHistoryResponse };
}

export interface GetChatResponse {
  chat: ChatSummary;
}

export interface ListSlashCommandsResponse {
  commands: SlashCommand[];
}

export interface DeleteChatResponse {
  success: boolean;
  chatId: string;
}

export interface RestoreChatResponse {
  chat: ChatSummary;
}

export type IntegrationErrorNotificationTarget =
  | { type: 'slack'; conversation?: { channelId: string; threadTs: string } }
  | { type: 'linear'; sessionId: string }
  | {
      type: 'code_host';
      provider: 'github' | 'gitlab';
      resource: 'issue' | 'pull_request';
      repositoryId: string;
      resourceNumber: number;
    }
  | { type: 'automation'; executionId: string };

export interface SendChatMessageRequest {
  messageId?: string;
  submittedAt?: string;
  message: string;
  /** Another harness than the chat's continues the chat on it, with the conversation handed over. */
  provider?: AgentProvider;
  model?: string;
  customInstructions?: string;
  images?: ImageContent[];
  canvasUploadIds?: string[];
  thinkingLevel?: ThinkingLevel;
  inheritThinkingLevel?: boolean;
  goalMode?: boolean;
  fastMode?: boolean;
  /** Codex's Ultrafast service tier. Sent alongside `fastMode: true` so engines without it fall back to Fast. */
  ultrafastMode?: boolean;
  source?: MessageSource;
  /**
   * Enables tools that interrupt the model to ask the user a question
   * (OpenCode's `question` tool). Only the dashboard
   * sets this — Slack/Linear/GitHub/automation flows leave it unset so
   * the agent can't block on a UI prompt the requester can't see.
   */
  enableInteractiveTools?: boolean;
  type?: string;
  merge?: boolean;
  /** Resending with the same key returns the original acceptance instead of re-enqueueing. Distinct from CreateChatRequest.clientRequestId, which is only a client-side correlation id. */
  idempotencyKey?: string;
  /** Server-injected by the monolith from the authenticated request; do not set from clients. */
  senderUserId?: string;
  /** Server-injected by the monolith for automation-triggered turns; do not set from clients. */
  automationId?: string;
  /** Server-injected by the monolith from the workspace; do not set from clients. */
  environmentId?: string;
  senderEmail?: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string;
  errorNotificationTarget?: IntegrationErrorNotificationTarget;
  errorNotificationTargets?: IntegrationErrorNotificationTarget[];
  /**
   * A sent message, by its transcript id, that this one edits: the agent continues from just before it, and it and everything after it are hidden.
   * Naming a refused copy edits nothing the agent saw: the message is sent as a new one, and the copy leaves the chat when it is accepted.
   */
  replacesMessageId?: string;
  /** A message a Stop cancelled, by its transcript id, that this one sends again: the cancelled one is hidden from the moment this one is sent. */
  resendsMessageId?: string;
  /** `'alone'` steers only this message, not the ones queued ahead of it. */
  steer?: boolean | 'alone';
}

export const integrationErrorNotificationTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('slack'),
    conversation: z.object({
      channelId: z.string().min(1),
      threadTs: z.string().min(1),
    }).optional(),
  }),
  z.object({ type: z.literal('linear'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('code_host'),
    provider: z.enum(['github', 'gitlab']),
    resource: z.enum(['issue', 'pull_request']),
    repositoryId: z.string().min(1),
    resourceNumber: z.number().int().positive(),
  }),
  z.object({ type: z.literal('automation'), executionId: z.string().min(1) }),
]);

export const sendChatMessageRequestSchema = z.object({
  messageId: z.string().min(1).optional(),
  submittedAt: z.string().datetime().optional(),
  message: z.string().min(1),
  provider: z.enum(ENGINE_AGENT_PROVIDERS).optional(),
  model: z.string().optional(),
  customInstructions: z.string().optional(),
  images: z.array(z.object({
    type: z.literal('image'),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('base64'), media_type: z.enum(IMAGE_MEDIA_TYPES), data: z.string().min(1) }),
      z.object({ type: z.literal('url'), url: z.string().url() }),
    ]),
  })).optional(),
  canvasUploadIds: z.array(z.string().min(1)).optional(),
  thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional(),
  inheritThinkingLevel: z.boolean().optional(),
  goalMode: z.boolean().optional(),
  fastMode: z.boolean().optional(),
  ultrafastMode: z.boolean().optional(),
  source: z.enum(MESSAGE_SOURCES).optional(),
  enableInteractiveTools: z.boolean().optional(),
  type: z.string().min(1).optional(),
  merge: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  // The workspace's stop count as this send read it when it arrived: set by the monolith alone. Lower than the number of the engine's last Stop of the chat, the send is older than that Stop.
  stopsSeen: z.number().int().nonnegative().optional(),
  automationId: z.string().optional(),
  environmentId: z.string().min(1).optional(),
  senderUserId: z.string().optional(),
  senderEmail: z.string().optional(),
  senderDisplayName: z.string().optional(),
  senderAvatarUrl: z.string().optional(),
  errorNotificationTarget: integrationErrorNotificationTargetSchema.optional(),
  errorNotificationTargets: z.array(integrationErrorNotificationTargetSchema).optional(),
  replacesMessageId: z.string().min(1).max(256).optional(),
  resendsMessageId: z.string().min(1).max(256).optional(),
  steer: z.union([z.boolean(), z.literal('alone')]).optional(),
}).passthrough() satisfies z.ZodType<SendChatMessageRequest>;

/** One record per user-authored message, in send order. */
export interface ChatMessageSender {
  messageId?: string;
  senderUserId: string;
  senderEmail: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string;
  recordedAt: string;
}

export function isChatMessageSender(value: unknown): value is ChatMessageSender {
  return (
    isRecord(value)
    && (value.messageId === undefined || typeof value.messageId === 'string')
    && typeof value.senderUserId === 'string'
    && typeof value.senderEmail === 'string'
    && typeof value.recordedAt === 'string'
  );
}

export type CodexAspTranscriptStatus = 'in_progress' | 'completed' | 'failed';

export function normalizeCodexAspTranscriptStatus(
  status: string | undefined,
  failed = false,
): CodexAspTranscriptStatus {
  if (failed || status === 'failed' || status === 'declined') return 'failed';
  if (status === 'completed') return 'completed';
  return 'in_progress';
}

export interface CodexAspTranscriptPatchOperation {
  action: 'add' | 'update' | 'delete';
  path: string;
  moveTo?: string;
  diff?: string;
}

export interface UserMessageImage {
  type: 'image';
  mediaType: string;
  data: string;
  dataHash?: string;
  okidokiOmitted?: ChatHistoryOmittedBody;
}

export function imageContentToUserMessageImages(images: ImageContent[] | undefined): UserMessageImage[] | undefined {
  const userImages: UserMessageImage[] = [];
  for (const image of images ?? []) {
    if (image.source.type !== 'base64' || image.source.data.length === 0) continue;
    userImages.push({
      type: 'image',
      mediaType: image.source.media_type,
      data: image.source.data,
    });
  }

  return userImages.length > 0 ? userImages : undefined;
}

export function createAcceptedUserMessageEvent(
  message: string,
  messageId: string,
  timestamp: string,
  images?: ImageContent[],
  replacesMessageId?: string,
  resendsMessageId?: string,
  senderUserId?: string,
): AgentEvent {
  const eventImages = imageContentToUserMessageImages(images);
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message,
      source: ACCEPTED_USER_MESSAGE_SOURCE,
      [USER_MESSAGE_ID_PAYLOAD_KEY]: messageId,
      ...(replacesMessageId ? { [REPLACED_MESSAGE_ID_PAYLOAD_KEY]: replacesMessageId } : {}),
      // The sender goes where the chat's own record of a message names it, and only on a resend: any other copy stays identical to the engine's record of it, which then keeps the copy the chat already holds.
      ...(resendsMessageId ? { [RESENT_MESSAGE_ID_PAYLOAD_KEY]: resendsMessageId, ...(senderUserId ? { userId: senderUserId } : {}) } : {}),
      ...(eventImages ? { images: eventImages } : {}),
    },
  };
}

export type CodexAspTranscriptItem = (
  | {
      type: 'userMessage';
      id: string;
      content: string;
      skillNames?: string[];
      images?: UserMessageImage[];
      timestamp: string;
    }
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase?: 'commentary' | 'final_answer' | null;
      timestamp: string;
    }
  | {
      type: 'reasoning';
      id: string;
      text: string;
      timestamp: string;
      sourceTimestamp?: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      output?: string;
      exitCode?: number | null;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'fileChange';
      id: string;
      operations: CodexAspTranscriptPatchOperation[];
      output?: string;
      exitCode?: number | null;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'toolCall';
      id: string;
      server: string;
      tool: string;
      input?: unknown;
      output?: string;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'subagent';
      id: string;
      description: string;
      prompt: string;
      subagentType: string;
      receiverThreadIds?: string[];
      model?: string;
      output?: string;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'webSearch';
      id: string;
      query: string;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'plan';
      id: string;
      text: string;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'contextCompaction';
      id: string;
      timestamp: string;
      status: CodexAspTranscriptStatus;
    }
  | {
      type: 'error';
      id: string;
      message: string;
      timestamp: string;
    }
) & {
  sequence?: number;
  completedAt?: string;
  okidokiOmitted?: ChatHistoryOmittedBody;
};

export interface CodexAspTranscriptTurn {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  items: CodexAspTranscriptItem[];
}

export function getCodexAspTurnResponse(
  turn: Pick<CodexAspTranscriptTurn, 'status' | 'items'>,
): Extract<CodexAspTranscriptItem, { type: 'agentMessage' }> | null {
  const finalAnswer = turn.items.find((item): item is Extract<CodexAspTranscriptItem, { type: 'agentMessage' }> => (
    item.type === 'agentMessage' && item.phase === 'final_answer'
  ));
  if (finalAnswer) return finalAnswer;
  if (normalizeCodexAspTranscriptStatus(turn.status) === 'in_progress') return null;
  return turn.items.findLast((item): item is Extract<CodexAspTranscriptItem, { type: 'agentMessage' }> => (
    item.type === 'agentMessage'
  )) ?? null;
}

export interface CodexAspTranscript {
  threadId: string;
  updatedAt: string;
  turns: CodexAspTranscriptTurn[];
}

interface CodexItemEventPayload extends Record<string, unknown> {
  turnId: string;
  item: CodexAspTranscriptItem;
}

interface CodexTurnEventPayload extends Record<string, unknown> {
  turnId: string;
  status: string;
  error?: string;
}

export function codexItemEvent(turnId: string, item: CodexAspTranscriptItem, partial = false): AgentEvent {
  const { sequence: _sequence, ...payloadItem } = item;
  return {
    timestamp: item.timestamp,
    type: partial ? CODEX_ITEM_PARTIAL_EVENT_TYPE : CODEX_ITEM_EVENT_TYPE,
    payload: { turnId, item: payloadItem } satisfies CodexItemEventPayload,
  };
}

export function codexTurnEvent(turnId: string, status: string, timestamp: string, error?: string): AgentEvent {
  return {
    timestamp,
    type: CODEX_TURN_EVENT_TYPE,
    payload: { turnId, status, ...(error ? { error } : {}) } satisfies CodexTurnEventPayload,
  };
}

function isTranscriptItemStatus(value: unknown): boolean {
  return value === 'in_progress' || value === 'completed' || value === 'failed';
}

const CODEX_ITEM_FIELD_CHECKS: Record<string, (item: Record<string, unknown>) => boolean> = {
  userMessage: (item) => typeof item.content === 'string',
  agentMessage: (item) => typeof item.text === 'string',
  reasoning: (item) => typeof item.text === 'string' && isTranscriptItemStatus(item.status),
  commandExecution: (item) => typeof item.command === 'string' && isTranscriptItemStatus(item.status),
  fileChange: (item) => Array.isArray(item.operations) && isTranscriptItemStatus(item.status),
  toolCall: (item) => typeof item.server === 'string'
    && typeof item.tool === 'string'
    && isTranscriptItemStatus(item.status),
  subagent: (item) => typeof item.description === 'string'
    && typeof item.prompt === 'string'
    && typeof item.subagentType === 'string'
    && isTranscriptItemStatus(item.status),
  webSearch: (item) => typeof item.query === 'string' && isTranscriptItemStatus(item.status),
  plan: (item) => typeof item.text === 'string' && isTranscriptItemStatus(item.status),
  contextCompaction: (item) => isTranscriptItemStatus(item.status),
  error: (item) => typeof item.message === 'string',
} satisfies Record<CodexAspTranscriptItem['type'], (item: Record<string, unknown>) => boolean>;

function isCodexAspTranscriptItem(value: unknown): value is CodexAspTranscriptItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.timestamp !== 'string') return false;
  if (value.sequence !== undefined && typeof value.sequence !== 'number') return false;
  if (value.completedAt !== undefined && typeof value.completedAt !== 'string') return false;
  if (typeof value.type !== 'string' || !Object.hasOwn(CODEX_ITEM_FIELD_CHECKS, value.type)) return false;
  return CODEX_ITEM_FIELD_CHECKS[value.type](value);
}

export function codexItemFromEvent(event: AgentEvent): CodexItemEventPayload | null {
  if (event.type !== CODEX_ITEM_EVENT_TYPE && event.type !== CODEX_ITEM_PARTIAL_EVENT_TYPE) return null;
  const { turnId, item } = event.payload;
  return typeof turnId === 'string' && isCodexAspTranscriptItem(item)
    ? { turnId, item }
    : null;
}

export function codexTurnFromEvent(event: AgentEvent): CodexTurnEventPayload | null {
  if (event.type !== CODEX_TURN_EVENT_TYPE) return null;
  const { turnId, status, error } = event.payload;
  return typeof turnId === 'string' && typeof status === 'string'
    ? { turnId, status, ...(typeof error === 'string' ? { error } : {}) }
    : null;
}

export function codexTranscriptToEvents(transcript: CodexAspTranscript): AgentEvent[] {
  return transcript.turns.flatMap((turn) => {
    const events = turn.items.map((item) => codexItemEvent(turn.id, item));
    if (normalizeCodexAspTranscriptStatus(turn.status) !== 'in_progress') {
      events.push(codexTurnEvent(
        turn.id,
        turn.status,
        turn.completedAt ?? turn.items.at(-1)?.timestamp ?? turn.startedAt,
      ));
    }
    return events;
  });
}

export interface CodexAspTranscriptItemDelta {
  id: string;
  item?: CodexAspTranscriptItem;
  appendText?: string;
  appendOutput?: string;
}

export interface CodexAspTranscriptTurnDelta {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  items: CodexAspTranscriptItemDelta[];
}

export interface CodexAspTranscriptDelta {
  threadId: string;
  updatedAt: string;
  reset?: CodexAspTranscript | null;
  turns: CodexAspTranscriptTurnDelta[];
}

export function isCodexAspTranscript(value: unknown): value is CodexAspTranscript {
  if (!isRecord(value)) return false;
  return (
    typeof value.threadId === 'string'
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.turns)
  );
}

export function isCodexAspTranscriptDelta(value: unknown): value is CodexAspTranscriptDelta {
  if (!isRecord(value)) return false;
  if (
    typeof value.threadId !== 'string'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.turns)
    || (
      value.reset !== undefined
      && value.reset !== null
      && !isCodexAspTranscript(value.reset)
    )
  ) {
    return false;
  }

  return value.turns.every((turn) => (
    isRecord(turn)
    && typeof turn.id === 'string'
    && typeof turn.status === 'string'
    && typeof turn.startedAt === 'string'
    && (turn.completedAt === null || typeof turn.completedAt === 'string')
    && Array.isArray(turn.items)
    && turn.items.every((item) => (
      isRecord(item)
      && typeof item.id === 'string'
      && (
        item.item === undefined
        || (
          isRecord(item.item)
          && typeof item.item.type === 'string'
          && typeof item.item.id === 'string'
          && typeof item.item.timestamp === 'string'
        )
      )
      && (item.appendText === undefined || typeof item.appendText === 'string')
      && (item.appendOutput === undefined || typeof item.appendOutput === 'string')
    ))
  ));
}

function appendCodexAspTranscriptField(
  current: string | undefined,
  append: string | undefined,
): string | undefined {
  return append === undefined ? current : `${current ?? ''}${append}`;
}

function patchCodexAspTranscriptItem(
  current: CodexAspTranscriptItem | undefined,
  delta: CodexAspTranscriptItemDelta,
): CodexAspTranscriptItem | null {
  const base = delta.item ?? current;
  if (!base) {
    return null;
  }

  if (base.type === 'agentMessage' && delta.appendText !== undefined) {
    return {
      ...base,
      text: appendCodexAspTranscriptField(base.text, delta.appendText) ?? '',
    };
  }
  if (
    (base.type === 'commandExecution' || base.type === 'fileChange')
    && delta.appendOutput !== undefined
  ) {
    return {
      ...base,
      output: appendCodexAspTranscriptField(base.output, delta.appendOutput),
    };
  }
  return base;
}

export function applyCodexAspTranscriptDelta(
  current: CodexAspTranscript | null | undefined,
  delta: CodexAspTranscriptDelta | null | undefined,
): CodexAspTranscript | null {
  if (!delta) return current ?? null;

  if (delta.reset === null) {
    return null;
  }

  const base = delta.reset ?? (
    current?.threadId === delta.threadId
      ? current
      : {
          threadId: delta.threadId,
          updatedAt: delta.updatedAt,
          turns: [],
        }
  );

  const turns = base.turns.map((turn) => delta.reset ? { ...turn, items: [...turn.items] } : turn);
  const changedTurns = new Set(delta.reset ? turns : []);
  const turnIndexes = new Map(turns.map((turn, index) => [turn.id, index]));
  for (const turnDelta of delta.turns) {
    const turnIndex = turnIndexes.get(turnDelta.id) ?? turns.length;
    const previousTurn = turns[turnIndex];
    const turn: CodexAspTranscriptTurn = {
      ...previousTurn,
      id: turnDelta.id,
      status: turnDelta.status,
      startedAt: turnDelta.startedAt,
      completedAt: turnDelta.completedAt,
      items: [...(previousTurn?.items ?? [])],
    };
    turnIndexes.set(turn.id, turnIndex);
    turns[turnIndex] = turn;

    const itemIndexes = new Map(turn.items.map((item, index) => [item.id, index]));
    for (const itemDelta of turnDelta.items) {
      const itemIndex = itemIndexes.get(itemDelta.id) ?? turn.items.length;
      const patched = patchCodexAspTranscriptItem(turn.items[itemIndex], itemDelta);
      if (!patched) continue;
      itemIndexes.set(itemDelta.id, itemIndex);
      turn.items[itemIndex] = patched;
    }
    changedTurns.add(turn);
  }
  for (const turn of changedTurns) {
    turn.items.sort((a, b) => (
      (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)
      || Date.parse(a.timestamp) - Date.parse(b.timestamp)
    ));
  }

  turns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return {
    threadId: delta.threadId,
    updatedAt: delta.updatedAt,
    turns,
  };
}

export interface SendChatMessageResponse {
  messageId: string;
  queued: boolean;
  position: number;
  /** Set when the message went to another chat continuing the addressed one: a harness fallback or switch. */
  chatId?: string;
  /** Whether a queued `steer` request reached the running turn; absent from engines that leave steering to the monolith. */
  steered?: boolean;
}

// Steers the messages queued ahead first, so the message never skips them, and stops at the first failure,
// since a provider that cannot steer restores the message to the queue front.
export async function steerQueuedInOrder(
  queue: Pick<QueuedMessageInfo, 'id' | 'steeredAt'>[],
  messageId: string,
  steer: (messageId: string) => Promise<boolean>,
): Promise<boolean> {
  const ids = queue.slice(0, queue.findIndex(({ id }) => id === messageId) + 1).filter(({ steeredAt }) => !steeredAt).map(({ id }) => id);
  if (ids.at(-1) !== messageId) return false;
  for (const id of ids) {
    if (!await steer(id)) return false;
  }
  return true;
}

export const sendChatMessageResponseSchema = z.object({
  messageId: z.string(),
  queued: z.boolean(),
  position: z.number(),
  chatId: z.string().optional(),
  steered: z.boolean().optional(),
}) satisfies z.ZodType<SendChatMessageResponse>;

// When the client pressed Stop, in the engine's time, so its "You stopped after" matches the engine's.
export const interruptChatRequestSchema = z.object({
  stoppedAt: z.string().datetime().optional(),
  // The workspace's stop count once this Stop was noted: set by the monolith alone. A send that saw a lower count is older than this Stop.
  stopNumber: z.number().int().positive().optional(),
});
export type InterruptChatRequest = z.infer<typeof interruptChatRequestSchema>;
// What the monolith sends the engine: the client's request plus who pressed Stop, which a client cannot set.
// `stopped` is set only for a Stop someone asked for, with the person when one pressed it. A turn cut so a message can start carries none.
export const turnStoppedSchema = z.object({ byUserId: z.string().optional() });
export type TurnStopped = z.infer<typeof turnStoppedSchema>;
export const engineInterruptChatRequestSchema = interruptChatRequestSchema.extend({ stopped: turnStoppedSchema.optional() });
export type EngineInterruptChatRequest = z.infer<typeof engineInterruptChatRequestSchema>;

/**
 * `queue` is the text of each message the Stop took out of the queue and hands to its caller, and `removedMessageIds` their ids.
 * The answer is not the only copy of a text the server took: the chat's history carries a refused copy of each, except of the caller's own
 * messages that were in the engine's queue, which are in this answer alone.
 */
export interface InterruptChatResponse {
  interrupted: boolean;
  queue: string[];
  /** Who sent each `queue` message, in the same order; null when no person did. */
  queueSenderUserIds?: (string | null)[];
  removedMessageIds?: string[];
}

export interface ClearChatGoalResponse {
  interrupted: boolean;
  queue: string[];
  queueSenderUserIds?: (string | null)[];
  goal: ChatGoal | null;
}

export interface UpdateChatGoalRequest {
  objective?: string;
  status?: Extract<ChatGoalStatus, 'active' | 'paused'>;
}

export interface UpdateChatGoalResponse {
  goal: ChatGoal | null;
}

export interface QueuedMessageInfo {
  id: string;
  message: string;
  queuedAt: string;
  senderUserId?: string;
  senderEmail?: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string;
  steeredAt?: string;
  resendsMessageId?: string;
}

export interface ChatQueueResponse {
  chatId: string;
  processing: boolean;
  queue: QueuedMessageInfo[];
}

export interface ReorderQueueRequest {
  messageId: string;
  position: number;
}

export interface UpdateQueuedMessageRequest {
  message: string;
}

export interface QueueMutationResponse {
  success: boolean;
  queue: QueuedMessageInfo[];
  removedMessageIds?: string[];
}

export const respondToolInputRequestSchema = z.object({
  requestId: z.string().min(1),
  selectionId: z.string().min(1),
  source: z.enum(CLIENT_MESSAGE_SOURCES).optional(),
});

export type RespondToolInputRequest = z.infer<typeof respondToolInputRequestSchema>;

export interface RespondToolInputResponse {
  resolved: boolean;
}

export interface ChatHistoryResponse {
  thread_id: string | null;
  events: AgentEvent[];
  /** Matches ChatSummary only when the latest snapshot was stable throughout its read. */
  historyVersion?: string;
  /** Ids no accepted message is shown under: those taken out of the queue, and with them the id of every taken-back message whose refused copy `events` carries. */
  removedMessageIds?: string[];
  /** Index of `events[0]` in the full history; > 0 means earlier events exist. Absent on legacy engines (full history). */
  eventsStartIndex?: number;
  /** Event count in the full history before pagination. Absent on legacy engines. */
  totalEvents?: number;
  /** Only sent by engines that predate Codex item events; the monolith converts it to events. */
  codexAspTranscript?: CodexAspTranscript | null;
  /** Same as `eventsStartIndex`, but for `codexAspTranscript.turns`; legacy engines only. */
  turnsStartIndex?: number;
  goal?: ChatGoal | null;
  senders?: ChatMessageSender[];
  beforeCursor?: string | null;
  /** End of the history file this response read up to; send it back as `afterCursor` to get only what was appended since. */
  afterCursor?: string;
  /** Set when `events` are only those appended after this cursor (the request's `afterCursor`), not a page. */
  appendsAfter?: string;
  /** The request's `userTurns`, echoed when the page was cut by user turns. Servers that predate turn pages page by `limit` and omit it. */
  userTurns?: number;
  /** Echoed when `events` are the first of the history, not the newest. */
  fromStart?: boolean;
}

// Kept off ChatHistoryResponse, whose shape every client's saved chat histories are keyed by.
export interface ChatSubagentHistoryResponse extends ChatHistoryResponse {
  subagentsCursor?: string;
  /** For a `subagentList` read, where to start each sub-agent's `subagentId` read, when the server can't look it up itself. */
  subagentCursors?: Record<string, string>;
}

export interface ChatHistoryPageParams {
  /** Max events (and codex transcript turns) to return, taken from the tail. */
  limit?: number;
  /** Exclusive upper bound: return events with index < beforeEvent. */
  beforeEvent?: number;
  /** Exclusive upper bound: return transcript turns with index < beforeTurn. */
  beforeTurn?: number;
  beforeCursor?: string;
  /** Return only the events appended after this cursor when the server can; otherwise the latest page of `limit`. */
  afterCursor?: string;
  /** Page whole user turns, this many, instead of `limit` events. Older engines and monoliths ignore it and page by `limit`. */
  userTurns?: number;
  /** Only send it to a monolith that answers with CHAT_HISTORY_COMPACT_HEADER. */
  compact?: boolean;
  /** Every event a chat's sub-agents are rebuilt from, across the whole history. Older engines ignore it and page as usual. */
  subagents?: boolean;
  /** Where a `subagents` read continues, from the previous response. Older engines return the whole read at once and never send one. */
  subagentsCursor?: string;
  /** With `subagents`, only the events sub-agents are listed from, without their own transcripts. Older servers ignore it and send those too. */
  subagentList?: boolean;
  /** With `subagents`, only this sub-agent's own transcript. Older servers ignore it and send every sub-agent's. */
  subagentId?: string;
  /** The first `limit` events instead of the newest. Older engines ignore it and return the newest page without echoing it. */
  fromStart?: boolean;
}

export const CHAT_HISTORY_COMPACT_HEADER = 'Okidoki-History-Compact';

export interface ChatHistoryRecordRange {
  offset: number;
  length: number;
}

export interface ChatHistoryOmittedBody {
  record: ChatHistoryRecordRange;
  bytes: number;
}

export interface ChatHistoryRecordResponse {
  event: AgentEvent;
}

export interface ChatHistoryCursor {
  mode: 'range' | 'legacy';
  events: string | null;
  turns: string | null;
}

export function isLatestChatHistoryPage(params: ChatHistoryPageParams): boolean {
  return params.beforeCursor === undefined
    && params.beforeEvent === undefined
    && params.beforeTurn === undefined
    && params.subagentsCursor === undefined
    && !params.fromStart;
}

export function getChatHistoryPageSenders(
  senders: ChatMessageSender[] | undefined,
  params: ChatHistoryPageParams,
): ChatMessageSender[] | undefined {
  return isLatestChatHistoryPage(params) ? senders : senders?.filter((sender) => sender.messageId);
}

export function parseChatHistoryCursor(value: string | undefined): ChatHistoryCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || (parsed.mode !== 'range' && parsed.mode !== 'legacy')) return undefined;
    const valid = (part: unknown) => part === null || typeof part === 'string';
    if (!valid(parsed.events) || !valid(parsed.turns)) return undefined;
    return { mode: parsed.mode, events: parsed.events, turns: parsed.turns };
  } catch {
    return undefined;
  }
}

export function createChatHistoryCursor(
  cursor: Omit<ChatHistoryCursor, 'mode'>,
  mode: ChatHistoryCursor['mode'] = 'range',
): string | null {
  return cursor.events === null && cursor.turns === null
    ? null
    : JSON.stringify({ mode, ...cursor });
}

export function chatHistoryPageParamsFromQuery(
  rawQuery: Record<string, string | undefined>,
): ChatHistoryPageParams {
  const query = withCamelCaseKeys(rawQuery);
  const parse = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return {
    limit: parse(query.limit),
    beforeEvent: parse(query.beforeEvent),
    beforeTurn: parse(query.beforeTurn),
    beforeCursor: query.beforeCursor || undefined,
    afterCursor: query.afterCursor || undefined,
    userTurns: parse(query.userTurns) || undefined,
    compact: query.compact === '1' || undefined,
    subagents: query.subagents === '1' || undefined,
    subagentsCursor: query.subagentsCursor || undefined,
    subagentList: query.subagentList === '1' || undefined,
    subagentId: query.subagentId || undefined,
    fromStart: query.fromStart === '1' || undefined,
  };
}

export function chatHistoryPageQueryString(params: ChatHistoryPageParams): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.beforeEvent !== undefined) search.set('beforeEvent', String(params.beforeEvent));
  if (params.beforeTurn !== undefined) search.set('beforeTurn', String(params.beforeTurn));
  if (params.beforeCursor !== undefined) search.set('beforeCursor', params.beforeCursor);
  if (params.afterCursor !== undefined) search.set('afterCursor', params.afterCursor);
  if (params.userTurns !== undefined) search.set('userTurns', String(params.userTurns));
  if (params.compact) search.set('compact', '1');
  if (params.subagents) search.set('subagents', '1');
  if (params.subagentsCursor !== undefined) search.set('subagentsCursor', params.subagentsCursor);
  if (params.subagentList) search.set('subagentList', '1');
  if (params.subagentId !== undefined) search.set('subagentId', params.subagentId);
  if (params.fromStart) search.set('fromStart', '1');
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function getChatHistoryPageWindow(
  totalItems: number,
  limit: number,
  before?: number,
): { startIndex: number; endIndex: number } {
  const endIndex = Math.min(before ?? totalItems, totalItems);
  return { startIndex: Math.max(0, endIndex - Math.max(1, limit)), endIndex };
}

export function paginateChatHistory(
  full: ChatHistoryResponse,
  params: ChatHistoryPageParams,
): ChatHistoryResponse {
  if (params.limit === undefined) return { ...full, totalEvents: full.events.length };

  const { startIndex: eventsStartIndex, endIndex: eventsEnd } = getChatHistoryPageWindow(
    full.events.length,
    params.limit,
    params.beforeEvent,
  );
  return {
    ...full,
    events: full.events.slice(eventsStartIndex, eventsEnd),
    eventsStartIndex,
    totalEvents: full.events.length,
  };
}

export interface ListReposResponse {
  repos: EngineRepoState[];
  workspaceRoot: string;
}

export interface HooksStatusResponse {
  running: boolean;
  completed: boolean;
}

// Preview Ports
export interface PreviewPort {
  port: number;
  publicUrl: string;
  createdAt: string;
  /** Set on previews Okidoki creates itself, like the live desktop stream. */
  system?: 'desktop';
}

export interface ListPreviewsResponse {
  previews: PreviewPort[];
}

export interface CreatePreviewRequest {
  port: number;
  publicUrl: string;
}

export interface CreatePreviewResponse {
  preview: PreviewPort;
}

export interface DeletePreviewResponse {
  success: boolean;
  port: number;
}
