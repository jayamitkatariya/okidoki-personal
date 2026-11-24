import { z } from 'zod';
import { WORKSPACE_ATTENTION_REASONS } from '../workspace-attention';

export const registerPushDeviceRequestSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('ios'),
    token: z.string().regex(/^[0-9a-f]{64,200}$/i),
    appId: z.string().min(1).max(255),
    apnsEnvironment: z.enum(['sandbox', 'production']),
  }),
  z.object({
    platform: z.literal('android'),
    token: z.string().min(1).max(4096),
    appId: z.string().min(1).max(255),
  }),
]);
export type RegisterPushDeviceRequest = z.infer<typeof registerPushDeviceRequestSchema>;

export interface RegisterPushDeviceResponse {
  device: { id: string };
}

export const PUSH_HOLD_MINUTES = 5;

const chatRefSchema = z.object({ workspaceId: z.string().uuid(), chatId: z.string().min(1).max(100) });

export const recordPushActivityRequestSchema = z.object({
  organizationId: z.string().uuid(),
  /** Seconds since the last keyboard or mouse input on this computer. A phone leaves it out: it only reports what it has open. */
  idleSeconds: z.number().min(0).optional(),
  seenWorkspaceIds: z.array(z.string().uuid()).max(20),
  seenChats: z.array(chatRefSchema).max(20).optional(),
});
export type RecordPushActivityRequest = z.infer<typeof recordPushActivityRequestSchema>;

const PUSH_NOTIFICATION_KINDS = [...WORKSPACE_ATTENTION_REASONS, 'finished'] as const;
export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

export const PUSH_CATEGORIES = { reply: 'AGENT_REPLY', plan: 'AGENT_PLAN', open: 'AGENT_OPEN' } as const;

/** One single-select question with up to four short options, which the notification offers as buttons. The length caps keep the push under the APNs and FCM 4 KB payload limit; longer choices fall back to the regular push. */
export const PUSH_OPTION_LABEL_MAX = 60;
export const PUSH_OPTIONS_MAX = 4;
export const pushQuestionSchema = z.object({ id: z.string().max(64), allowCustom: z.boolean().optional(), options: z.array(z.object({ id: z.string().max(64), label: z.string().min(1).max(PUSH_OPTION_LABEL_MAX) })).min(1).max(PUSH_OPTIONS_MAX) });
export type PushQuestion = z.infer<typeof pushQuestionSchema>;

export const pushNotificationDataSchema = z.object({
  organizationId: z.string(),
  workspaceId: z.string(),
  chatId: z.string().nullable(),
  kind: z.enum(PUSH_NOTIFICATION_KINDS),
  completedAt: z.string(),
  toolRequestId: z.string().optional(),
  question: pushQuestionSchema.optional(),
});
export type PushNotificationData = z.infer<typeof pushNotificationDataSchema>;

export const workspaceSharedPushDataSchema = pushNotificationDataSchema.pick({ organizationId: true, workspaceId: true, chatId: true, completedAt: true }).extend({ kind: z.literal('shared') });
export type WorkspaceSharedPushData = z.infer<typeof workspaceSharedPushDataSchema>;

export interface AutomationPushData {
  organizationId: string;
  automationId: string;
  kind: 'automation_failed' | 'automation_paused';
}

export const registerLiveActivityRequestSchema = chatRefSchema.extend({
  deviceId: z.string().uuid(),
  /** The iOS activity's push token. Android leaves it out and gets FCM data messages on the device token. */
  pushToken: z.string().regex(/^[0-9a-f]{64,400}$/i).optional(),
  /** iOS only: when the card's turn started, in seconds. Cards keep their order by it. */
  startedAt: z.number().positive().optional(),
});
export type RegisterLiveActivityRequest = z.infer<typeof registerLiveActivityRequestSchema>;

export const syncLiveActivitiesRequestSchema = z.object({
  activities: z.array(chatRefSchema).max(100),
});
export type SyncLiveActivitiesRequest = z.infer<typeof syncLiveActivitiesRequestSchema>;

export const setLiveActivityStartTokenRequestSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64,400}$/i) });
export type SetLiveActivityStartTokenRequest = z.infer<typeof setLiveActivityStartTokenRequestSchema>;

export const LIVE_ACTIVITY_STATUSES = ['working', 'needs_input', 'blocked', 'done'] as const;
export type LiveActivityStatus = (typeof LIVE_ACTIVITY_STATUSES)[number];

const LIVE_ACTIVITY_RANK: Record<LiveActivityStatus, number> = { needs_input: 3, blocked: 2, working: 1, done: 0 };
/** iOS leads with the highest score; within a status the newer turn leads, so app and server updates keep the same order. */
export const liveActivityRelevance = (status: LiveActivityStatus, startedAt: number) => LIVE_ACTIVITY_RANK[status] + startedAt / 1e10;

export interface LiveActivityContentState {
  status: LiveActivityStatus;
  title: string;
  detail: string | null;
  toolRequestId: string | null;
  /** Seconds, not milliseconds: the app compares it with Swift's `timeIntervalSince1970`. */
  updatedAt: number;
}

export interface AndroidLiveUpdate {
  event: 'update' | 'end';
  organizationId: string;
  workspaceId: string;
  chatId: string;
  state: LiveActivityContentState;
}
