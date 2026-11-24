import { z } from 'zod';
import {
  CREDENTIAL_METHOD,
  CREDENTIAL_SCOPE,
  CREDENTIAL_SCOPES,
  type AuthMethod,
  type CredentialScope,
} from '../credentials';
import { isNonEmptyString, isRecord } from '../type-guards';
import { isValidAgentProvider, type AgentProvider } from '../agent';
import { isMessageSource, type MessageSource, type WorkspaceSource } from '../pricing';
import type { TimeGranularity } from '../routes/admin';

export type AnalyticsBucket = TimeGranularity;

export const ANALYTICS_BUCKETS: readonly AnalyticsBucket[] = ['day', 'week', 'month'];

export interface PullRequestActivityPoint {
  bucket: string;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
}

export interface AnalyticsTotals {
  workspacesCreated: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  computeMinutes: number;
}

export interface AnalyticsSourceCount {
  source: string;
  count: number;
}

export interface AnalyticsSourcePoint {
  bucket: string;
  bySource: Record<string, number>;
}

export interface AnalyticsUsagePoint extends AnalyticsSourcePoint {
  tokens: number;
}

export type AnalyticsTurnUsageMetric = 'tokens' | 'minutes' | 'workspaces' | 'turns';

export const ANALYTICS_TURN_USAGE_METRICS: readonly AnalyticsTurnUsageMetric[] = [
  'minutes',
  'tokens',
  'workspaces',
  'turns',
];

export interface AnalyticsTurnUsageMetrics {
  tokens: number;
  minutes: number;
  workspaces: number;
  turns: number;
}

export interface AnalyticsTurnUsageBreakdown extends AnalyticsTurnUsageMetrics {
  id: string;
  name: string;
}

export interface AnalyticsTurnUsage {
  automations: AnalyticsTurnUsageBreakdown[];
  environments: AnalyticsTurnUsageBreakdown[];
}

export interface AnalyticsSeatDay {
  bucket: string;
  minutes: number;
}

export interface AnalyticsSeatUsage {
  seatId: string;
  userId: string | null;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  computeMinutes: number;
  prsOpened: number;
  prsMerged: number;
  topSource: WorkspaceSource | null;
  workspacesCreated: number;
  sources: AnalyticsSourceCount[];
  activity: AnalyticsSeatDay[];
}

export interface AnalyticsOverview {
  bucket: AnalyticsBucket;
  start: string;
  end: string;
  points: PullRequestActivityPoint[];
  sources: AnalyticsSourceCount[];
  workspaceCreations: AnalyticsSourcePoint[];
  usage: AnalyticsUsagePoint[];
  seats: AnalyticsSeatUsage[];
  rangeTotals: AnalyticsTotals;
  allTimeTotals: AnalyticsTotals;
  chatTurns: Omit<AnalyticsChatTurns, 'bucket' | 'start' | 'end'>;
  turnUsage: AnalyticsTurnUsage;
  skillCalls: AnalyticsCallBreakdown[];
  mcpCalls: AnalyticsCallBreakdown[];
}

export type GetAnalyticsOverviewResponse = AnalyticsOverview;

export interface AnalyticsChatTurnBreakdown extends AnalyticsTurnUsageMetrics {
  key: string;
  label: string;
  seconds: number;
  credentialOwner?: string;
  credentialOwnerEmail?: string;
  credentialOwnerAvatarUrl?: string;
}

export interface AnalyticsCallBreakdown {
  name: string;
  calls: number;
}

export interface AnalyticsChatTurns {
  bucket: AnalyticsBucket;
  start: string;
  end: string;
  totalSeconds: number;
  agentProviders: AnalyticsChatTurnBreakdown[];
  models: AnalyticsChatTurnBreakdown[];
  credentials: AnalyticsChatTurnBreakdown[];
}

export interface AgentChatActivityRecord {
  chatId: string;
  provider: AgentProvider;
  model: string;
  credentialMethod?: AuthMethod;
  credentialScope?: CredentialScope;
  senderUserId?: string;
  source?: MessageSource;
  occurredAt: string;
}

function hasAgentChatActivityFields(
  value: unknown,
): value is Omit<AgentChatActivityRecord, 'provider'> & Record<string, unknown> {
  return isRecord(value)
    && typeof value.chatId === 'string'
    && typeof value.model === 'string'
    && (value.credentialMethod === undefined || isAuthMethod(value.credentialMethod))
    && (value.credentialScope === undefined || isCredentialScope(value.credentialScope))
    && (value.credentialMethod === undefined) === (value.credentialScope === undefined)
    && (value.senderUserId === undefined || typeof value.senderUserId === 'string')
    && (value.source === undefined || isMessageSource(value.source))
    && typeof value.occurredAt === 'string';
}

function isAgentChatActivityRecord(value: unknown): value is AgentChatActivityRecord & Record<string, unknown> {
  return hasAgentChatActivityFields(value)
    && typeof value.provider === 'string'
    && isValidAgentProvider(value.provider);
}

export interface AgentChatTurnActivityRecord extends AgentChatActivityRecord {
  turnId: string;
  seconds: number;
}

export interface UploadAgentChatTurnActivityRequest {
  turns: AgentChatTurnActivityRecord[];
}

/** Who a credential bills, so a quota error can name the account and not just its method. */
export const credentialAccountSchema = z.object({
  ownerName: z.string().optional(),
  email: z.string().optional(),
  /** 1-based place in the owner's account pool, set only when the pool holds several accounts. */
  ordinal: z.number().int().positive().optional(),
});
export type CredentialAccount = z.infer<typeof credentialAccountSchema>;

export const agentCredentialSnapshotSchema = z.object({
  method: z.enum(CREDENTIAL_METHOD),
  scope: z.enum(CREDENTIAL_SCOPE),
  revision: z.string().optional(),
  account: credentialAccountSchema.optional(),
  /** The `credentials` row, which tells apart accounts pooled under one method and scope. */
  credentialId: z.string().optional(),
});
export type AgentCredentialSnapshot = z.infer<typeof agentCredentialSnapshotSchema>;

export function isSameCredential(
  a: Pick<AgentCredentialSnapshot, 'method' | 'scope' | 'credentialId'>,
  b: Pick<AgentCredentialSnapshot, 'method' | 'scope' | 'credentialId'>,
): boolean {
  return a.method === b.method && a.scope === b.scope && a.credentialId === b.credentialId;
}

export type AgentCredentialSnapshots = Partial<Record<AgentProvider, AgentCredentialSnapshot>>;

export function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === 'string' && Object.values(CREDENTIAL_METHOD).some((method) => method === value);
}

export function isCredentialScope(value: unknown): value is CredentialScope {
  return typeof value === 'string' && CREDENTIAL_SCOPES.some((scope) => scope === value);
}

export function isAgentChatTurnActivityRecord(value: unknown): value is AgentChatTurnActivityRecord {
  return isAgentChatActivityRecord(value)
    && typeof value.turnId === 'string'
    && typeof value.seconds === 'number'
    && Number.isFinite(value.seconds)
    && value.seconds >= 0;
}

export function isUploadAgentChatTurnActivityRequest(value: unknown): value is UploadAgentChatTurnActivityRequest {
  return isRecord(value)
    && Array.isArray(value.turns)
    && value.turns.every(isAgentChatTurnActivityRecord);
}

interface AgentChatActivityCallRecord extends AgentChatActivityRecord {
  callId: string;
}

export const SKILL_USE_KINDS = ['invoke', 'read', 'shell'] as const;
export type SkillUseKind = typeof SKILL_USE_KINDS[number];

export interface AgentChatSkillActivityRecord extends AgentChatActivityCallRecord {
  skillName: string;
  /** Absent on records from engines that predate accurate skill-use detection. */
  useKind?: SkillUseKind;
}

export interface AgentChatMcpActivityRecord extends AgentChatActivityCallRecord {
  mcpName: string;
}

export interface UploadAgentChatSkillActivityRequest {
  skills: AgentChatSkillActivityRecord[];
}

export interface UploadAgentChatMcpActivityRequest {
  mcps: AgentChatMcpActivityRecord[];
}

function isAgentChatActivityCallRecord(value: unknown): value is AgentChatActivityCallRecord & Record<string, unknown> {
  return isAgentChatActivityRecord(value)
    && typeof value.callId === 'string'
    && value.callId.length > 0;
}

function isNamedAgentChatActivityRecord(value: unknown, field: 'skillName' | 'mcpName'): boolean {
  if (!isAgentChatActivityCallRecord(value)) return false;
  const name = value[field];
  return typeof name === 'string' && name.length > 0;
}

export function isAgentChatSkillActivityRecord(value: unknown): value is AgentChatSkillActivityRecord {
  return isNamedAgentChatActivityRecord(value, 'skillName')
    && isRecord(value)
    && (value.useKind === undefined || SKILL_USE_KINDS.some((kind) => kind === value.useKind));
}

export function isAgentChatMcpActivityRecord(value: unknown): value is AgentChatMcpActivityRecord {
  return isNamedAgentChatActivityRecord(value, 'mcpName');
}

function isAgentChatActivityRequest(
  value: unknown,
  field: 'skills' | 'mcps',
  validateRecord: (value: unknown) => boolean,
): boolean {
  return isRecord(value)
    && Array.isArray(value[field])
    && value[field].every(validateRecord);
}

export function isUploadAgentChatSkillActivityRequest(value: unknown): value is UploadAgentChatSkillActivityRequest {
  return isAgentChatActivityRequest(value, 'skills', isAgentChatSkillActivityRecord);
}

export function isUploadAgentChatMcpActivityRequest(value: unknown): value is UploadAgentChatMcpActivityRequest {
  return isAgentChatActivityRequest(value, 'mcps', isAgentChatMcpActivityRecord);
}

export const TOKEN_USAGE_PATH = '/v1/engine/token-usage';

export type TokenUsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
};

export type TokenUsageUploadRecord = Omit<AgentChatActivityRecord, 'provider'>
  & TokenUsageCounts
  & {
    harness: string;
    automationId?: string;
    environmentId: string;
    eventId?: string;
    pricingProvider?: string;
    reportedCostUsd?: number;
  };

export interface UploadTokenUsageRequest {
  records: TokenUsageUploadRecord[];
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTokenUsageCounts(value: unknown): value is TokenUsageCounts & Record<string, unknown> {
  return isRecord(value)
    && isTokenCount(value.inputTokens)
    && isTokenCount(value.outputTokens)
    && isTokenCount(value.cacheReadInputTokens)
    && isTokenCount(value.cacheWriteInputTokens);
}

export function isTokenUsageUploadRecord(value: unknown): value is TokenUsageUploadRecord {
  return hasAgentChatActivityFields(value)
    && isNonEmptyString(value.harness)
    && isNonEmptyString(value.chatId)
    && isNonEmptyString(value.model)
    && isNonEmptyString(value.occurredAt)
    && Number.isFinite(Date.parse(value.occurredAt))
    && (value.automationId === undefined || isNonEmptyString(value.automationId))
    && isNonEmptyString(value.environmentId)
    && (value.eventId === undefined || isNonEmptyString(value.eventId))
    && (value.pricingProvider === undefined || isNonEmptyString(value.pricingProvider))
    && (value.reportedCostUsd === undefined || (
      typeof value.reportedCostUsd === 'number'
      && Number.isFinite(value.reportedCostUsd)
      && value.reportedCostUsd >= 0
    ))
    && isTokenUsageCounts(value);
}

export function isUploadTokenUsageRequest(value: unknown): value is UploadTokenUsageRequest {
  return isRecord(value)
    && Array.isArray(value.records)
    && value.records.every(isTokenUsageUploadRecord);
}
