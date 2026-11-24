import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import { VALID_THINKING_LEVELS } from '../agent';
import type { HarnessEvents, HarnessThreads } from '../database/schema';
import { integrationErrorNotificationTargetSchema, turnStoppedSchema } from '../engine/v1';

export const HARNESS_THREAD_STATUSES = ['idle', 'working', 'error'] as const;
export type HarnessThreadStatus = (typeof HARNESS_THREAD_STATUSES)[number];

/** Who the provider bills for a call: the customer's API key, the customer's subscription (a ChatGPT login, which costs them nothing per call), or our key. */
export const HARNESS_USAGE_PAYERS = ['okidoki', 'customer_key', 'customer_subscription'] as const;
export type HarnessUsagePayer = (typeof HARNESS_USAGE_PAYERS)[number];
export type HarnessUsageStatus = 'completed' | 'stopped' | 'failed';

export type HarnessThread = Omit<Selectable<HarnessThreads>, 'status' | 'created_at' | 'updated_at'> & {
  status: HarnessThreadStatus;
  created_at: string;
  updated_at: string;
  origin?: HarnessThreadOrigin;
  outcome?: HarnessAgentOutcome;
};

// Loose objects keep fields pi-ai or a newer writer added, such as the client's messageId.
const textSchema = z.looseObject({ type: z.literal('text'), text: z.string() });
const imageSchema = z.looseObject({ type: z.literal('image'), data: z.string(), mimeType: z.string() });
const userMessageSchema: z.ZodType<UserMessage> = z.looseObject({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(z.discriminatedUnion('type', [textSchema, imageSchema]))]),
  timestamp: z.number(),
});
const assistantMessageSchema: z.ZodType<AssistantMessage> = z.looseObject({
  role: z.literal('assistant'),
  content: z.array(z.discriminatedUnion('type', [
    textSchema,
    z.looseObject({ type: z.literal('thinking'), thinking: z.string() }),
    z.looseObject({ type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.json()) }),
  ])),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  usage: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    cost: z.looseObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }),
  }),
  stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']),
  timestamp: z.number(),
});
const toolResultMessageSchema: z.ZodType<ToolResultMessage> = z.looseObject({
  role: z.literal('toolResult'),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.discriminatedUnion('type', [textSchema, imageSchema])),
  isError: z.boolean(),
  timestamp: z.number(),
});

export const harnessAgentOutcomeSchema = z.object({
  agentId: z.string().uuid(),
  assignmentId: z.string(),
  status: z.enum(['completed', 'cancelled', 'error', 'help']),
  response: z.string(),
});
export type HarnessAgentOutcome = z.infer<typeof harnessAgentOutcomeSchema>;

export const HARNESS_AGENT_TYPES = ['general', 'explore', 'execute'] as const;
export type HarnessAgentType = (typeof HARNESS_AGENT_TYPES)[number];

export const harnessThreadOriginSchema = z.object({
  kind: z.enum(['side_chat', 'subagent']),
  agentType: z.enum(HARNESS_AGENT_TYPES).optional(),
  parentThreadId: z.string().uuid(),
  depth: z.number().int().nonnegative(),
  message: userMessageSchema,
});
type HarnessThreadOrigin = Omit<z.infer<typeof harnessThreadOriginSchema>, 'message'>;

export const harnessInboxPayloadSchemas = {
  message: z.looseObject({
    message: userMessageSchema,
    userId: z.string().nullable(),
    messageId: z.string().optional(),
    resendsMessageId: z.string().optional(),
    agentOutcome: harnessAgentOutcomeSchema.optional(),
    model: z.string().optional(),
    thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional(),
    instructionsHash: z.string().optional(),
    queued: z.boolean().optional(),
    /** Stored only on a message whose `instructionsHash` differs from the message before it; later ones find it by hash. */
    instructions: z.object({ environmentSystemPrompt: z.string().optional(), customInstructions: z.string().optional() }).optional(),
    errorNotificationTarget: integrationErrorNotificationTargetSchema.optional(),
  }),
  interrupt: z.looseObject({ userId: z.string().nullable(), messageId: z.string().optional(), cancelQueued: z.boolean().optional(), stopped: turnStoppedSchema.optional() }),
};
export type HarnessInboxPayloads = { [K in keyof typeof harnessInboxPayloadSchemas]: z.infer<(typeof harnessInboxPayloadSchemas)[K]> };
export type HarnessInboxKind = keyof HarnessInboxPayloads;

export const harnessEventBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread_origin'), payload: harnessThreadOriginSchema }),
  z.object({ type: z.literal('agent_outcome'), payload: harnessAgentOutcomeSchema }),
  z.object({ type: z.literal('user_message'), payload: harnessInboxPayloadSchemas.message }),
  z.object({ type: z.literal('cancelled_message'), payload: harnessInboxPayloadSchemas.message }),
  z.object({ type: z.literal('interrupt'), payload: harnessInboxPayloadSchemas.interrupt }),
  /** Saved before its tool calls run. */
  z.object({ type: z.literal('assistant_message'), payload: z.looseObject({ message: assistantMessageSchema }) }),
  z.object({ type: z.literal('tool_result'), payload: z.looseObject({ message: toolResultMessageSchema }) }),
  z.object({
    type: z.literal('status'),
    payload: z.looseObject({
      status: z.enum(HARNESS_THREAD_STATUSES),
      /** On the `working` status that starts a turn: the MCP servers' state the turn's request is sent with, saved so later calls repeat it byte for byte. */
      mcpStatus: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('error'), payload: z.looseObject({ message: z.string() }) }),
  /** The model's context is this summary followed by the events from `firstKeptSeq` on; nothing before it is deleted. */
  z.object({
    type: z.literal('compaction'),
    payload: z.looseObject({
      summary: z.string(),
      firstKeptSeq: z.number(),
      tokensBefore: z.number(),
      readFiles: z.array(z.string()),
      modifiedFiles: z.array(z.string()),
    }),
  }),
  /** A model call that saved no step of its own, such as a failed attempt or one cut off mid-stream; its `harness_usage` row says what it cost. */
  z.object({ type: z.literal('model_call'), payload: z.looseObject({}) }),
]);
type HarnessEventBody = z.infer<typeof harnessEventBodySchema>;
export type HarnessEventType = HarnessEventBody['type'];
export type HarnessEventPayloads = { [K in HarnessEventType]: Extract<HarnessEventBody, { type: K }>['payload'] };

export type HarnessEvent = {
  [K in HarnessEventType]: Omit<Selectable<HarnessEvents>, 'seq' | 'epoch' | 'type' | 'payload' | 'created_at'> & {
    seq: number;
    epoch: number;
    type: K;
    payload: HarnessEventPayloads[K];
    created_at: string;
  };
}[HarnessEventType];

export const HARNESS_DISPATCH_STREAM = 'harness:dispatch';
export const HARNESS_DISPATCH_GROUP = 'harness-workers';
/** Approximate cap on the stream; entries are hints, so trimming old ones loses nothing the sweep can't recover. */
export const HARNESS_DISPATCH_MAX_LEN = 10_000;

export function harnessSignalChannel(threadId: string): string {
  return `harness:thread:${threadId}:signal`;
}

export function harnessWorkspaceLiveChannel(workspaceId: string): string {
  return `harness:workspace:${workspaceId}:live`;
}

/** Deltas are never persisted; `step_saved` means the step is readable from the thread log. */
export const harnessLiveMessageSchema = z.union([
  z.object({ type: z.literal('delta'), streamId: z.string(), text: z.string() }),
  z.object({ type: z.literal('delta'), streamId: z.string(), thinking: z.string() }),
  z.object({ type: z.literal('delta'), streamId: z.string(), toolCall: z.object({ id: z.string(), name: z.string(), argumentsDelta: z.string() }) }),
  z.object({ type: z.literal('step_saved'), seq: z.number() }),
  z.object({ type: z.literal('status'), status: z.enum(HARNESS_THREAD_STATUSES) }),
  z.object({ type: z.literal('retry'), attempt: z.number(), maxAttempts: z.number(), reason: z.string() }),
]);
export type HarnessLiveMessage = z.infer<typeof harnessLiveMessageSchema>;

// Larger saved steps are read back from the thread log instead, keeping messages far below Valkey's pub/sub output buffer limits.
export const HARNESS_LIVE_MAX_BYTES = 64 * 1024;

export const harnessWorkspaceLiveMessageSchema = z.object({
  threadId: z.string(),
  message: harnessLiveMessageSchema,
  event: harnessEventBodySchema.and(z.object({ thread_id: z.string(), seq: z.number(), epoch: z.number(), blob_key: z.string().nullable(), created_at: z.string() })).optional(),
});
export type HarnessWorkspaceLiveMessage = z.infer<typeof harnessWorkspaceLiveMessageSchema>;
