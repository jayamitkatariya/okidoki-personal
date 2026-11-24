import { z } from 'zod';
import { CHAT_ATTENTION_REASONS, INPUT_REQUEST_REASONS } from '../workspace-attention';
import { WORKSPACE_STATUSES, type WorkspaceRecord } from './workspaces';
import { presenceEntrySchema, type PresenceEntry } from './presence';

const workspaceTurnCompletionSchema = z.object({
  workspaceName: z.string(),
  completedAt: z.string(),
  processing: z.boolean().optional(),
  pullRequestFeedback: z.boolean().optional(),
  attention: z.object({ reason: z.enum(CHAT_ATTENTION_REASONS), userId: z.string() }).optional(),
});

export type WorkspaceTurnCompletion = z.infer<typeof workspaceTurnCompletionSchema>;

const inputRequestRaisedSchema = z.object({ reason: z.enum(INPUT_REQUEST_REASONS), userId: z.string(), chatId: z.string(), since: z.string() });

export type InputRequestRaised = z.infer<typeof inputRequestRaisedSchema>;

export type WorkspaceChangedEvent = {
  type: 'workspace.changed';
  workspaceId: string;
  accessChangedFor?: string;
  accessChangedForOrg?: true;
  workspace?: Pick<WorkspaceRecord, 'status' | 'last_activity_at'>;
  name?: string;
  completion?: WorkspaceTurnCompletion;
  ts: string;
} | {
  type: 'workspace.chat.changed';
  workspaceId: string;
  chatId: string;
  /** A message was rejected before reaching the engine, so only the chat history (not the workspace stream) shows why. */
  rejected?: boolean;
  ts: string;
} | {
  type: 'workspace.chat.advanced';
  workspaceId: string;
  chatId: string;
  /** The chat history's `afterCursor` once the turn landed; absent when the engine predates reporting it. */
  afterCursor?: string;
  processing: boolean;
  ts: string;
} | {
  type: 'presence.changed';
  userId: string;
  /** Null once they leave. */
  entry: PresenceEntry | null;
  ts: string;
} | {
  // Servers before presence events carried the change.
  type: 'presence.changed';
  ts: string;
} | {
  type: 'mobile-testing.changed';
  workspaceId: string;
  ts: string;
} | {
  type: 'variable-request.changed';
  workspaceId: string;
  ts: string;
} | {
  type: 'local-control-request.changed';
  workspaceId: string;
  ts: string;
} | {
  type: 'pull-request.changed';
  prUrl: string;
  ts: string;
} | {
  /** `mothership.*` are the names from before the Manager rename, still sent to app builds installed before it. */
  type: 'manager.subagent.changed' | 'mothership.subagent.changed';
  workspaceId: string;
  subagent: { id: string; name: string; prUrl: string | null };
  ts: string;
} | {
  type: 'issues.synced';
  syncId: number;
  ts: string;
} | {
  type: 'needs-you.changed';
  workspaceId: string | null;
  userId?: string;
  /** The question or plan an agent stopped on mid-turn. One that ends a turn arrives as its `completion`. */
  request?: InputRequestRaised;
  ts: string;
} | {
  type: 'workspace.shared';
  workspaceId: string;
  workspaceName: string;
  sharedWithUserId: string;
  sharedByName: string;
  ts: string;
} | {
  type: 'client-state.changed';
  userId: string;
  keys: string[];
  ts: string;
};

const workspaceEventSchemaByType = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace.changed'),
    workspaceId: z.string(),
    accessChangedFor: z.string().optional(),
    accessChangedForOrg: z.literal(true).optional(),
    workspace: z.object({ status: z.enum(WORKSPACE_STATUSES), last_activity_at: z.string().nullable() }).optional(),
    name: z.string().optional(),
    completion: workspaceTurnCompletionSchema.optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('workspace.chat.changed'),
    workspaceId: z.string(),
    chatId: z.string(),
    rejected: z.boolean().optional(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('workspace.chat.advanced'),
    workspaceId: z.string(),
    chatId: z.string(),
    afterCursor: z.string().optional(),
    processing: z.boolean(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('mobile-testing.changed'),
    workspaceId: z.string(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('variable-request.changed'),
    workspaceId: z.string(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('local-control-request.changed'),
    workspaceId: z.string(),
    ts: z.string(),
  }),
  z.object({
    type: z.literal('pull-request.changed'),
    prUrl: z.string(),
    ts: z.string(),
  }),
  z.object({
    type: z.enum(['manager.subagent.changed', 'mothership.subagent.changed']),
    workspaceId: z.string(),
    subagent: z.object({ id: z.string(), name: z.string(), prUrl: z.string().nullable() }),
    ts: z.string(),
  }),
  z.object({ type: z.literal('issues.synced'), syncId: z.number(), ts: z.string() }),
  z.object({ type: z.literal('needs-you.changed'), workspaceId: z.string().nullable(), userId: z.string().optional(), request: inputRequestRaisedSchema.optional(), ts: z.string() }),
  z.object({
    type: z.literal('workspace.shared'),
    workspaceId: z.string(),
    workspaceName: z.string(),
    sharedWithUserId: z.string(),
    sharedByName: z.string(),
    ts: z.string(),
  }),
  z.object({ type: z.literal('client-state.changed'), userId: z.string(), keys: z.array(z.string()), ts: z.string() }),
]);

// Presence has two shapes under one type, which a discriminated union can't tell apart.
export const workspaceChangedEventSchema = z.union([
  workspaceEventSchemaByType,
  z.object({ type: z.literal('presence.changed'), userId: z.string(), entry: presenceEntrySchema.nullable(), ts: z.string() }),
  z.object({ type: z.literal('presence.changed'), ts: z.string() }),
]) satisfies z.ZodType<WorkspaceChangedEvent>;
