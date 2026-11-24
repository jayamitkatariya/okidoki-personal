import { z } from 'zod';
import { CREDIT_PLAN_UNITS, type BillablePlanType, type BillingBlock, type PlanType } from '../pricing';
import type { SlackChannel } from './slack';
import type { AnalyticsBucket } from '../analytics/types';

export interface CreateCheckoutSessionRequest {
  plan: BillablePlanType;
  /** Monthly amount for credit plans; defaults to the plan's minimum. */
  amountCents?: number;
  returnUrl: string;
  posthogSessionId?: string;
}

export interface CreateCheckoutSessionResponse {
  sessionUrl: string;
}

const TEAM_UNIT = CREDIT_PLAN_UNITS.team;
export const autoUpgradeAmountsSchema = z.object({
  maxCents: z.number().int().multipleOf(TEAM_UNIT.unitCents).min(TEAM_UNIT.unitCents * TEAM_UNIT.minQuantity).max(TEAM_UNIT.unitCents * TEAM_UNIT.maxQuantity),
  thresholdCents: z.number().int().multipleOf(100).min(0).max(TEAM_UNIT.unitCents * TEAM_UNIT.maxQuantity),
  stepCents: z.number().int().multipleOf(TEAM_UNIT.unitCents).min(TEAM_UNIT.unitCents).max(TEAM_UNIT.unitCents * TEAM_UNIT.maxQuantity),
});
export type AutoUpgradeAmounts = z.infer<typeof autoUpgradeAmountsSchema>;

export interface AutoUpgradeSettings {
  enabled: boolean;
  maxCents: number | null;
  thresholdCents: number;
  stepCents: number;
  failure: string | null;
}

export type UpdateAutoUpgradeRequest = { enabled: false } | ({ enabled: true } & AutoUpgradeAmounts);

export interface GetCheckoutSessionStatusResponse {
  status: 'pending' | 'activated' | 'rejected';
  plan: BillablePlanType | null;
  eventUuid: string | null;
}

export interface CreatePortalSessionRequest {
  returnUrl: string;
}

export interface CreatePortalSessionResponse {
  sessionUrl: string;
}

export interface ChangeSubscriptionRequest {
  plan: BillablePlanType;
  amountCents: number;
}

export interface ChangeSubscriptionResponse {
  /** Upgrades apply now and charge the difference; downgrades apply at renewal. */
  effective: 'now' | 'renewal';
  chargedCents: number;
}

export interface CreditSummary {
  periodStart: string;
  periodEnd: string;
  /** Everything usage can draw on this period: the plan's credit plus one-time grants. */
  creditCents: number;
  /** The subscription's monthly amount, or the trial's credit. */
  planCents: number;
  /** One-time credit granted for this period only. */
  grantCents: number;
  usedCents: number;
  overageCents: number;
  chargedCents: number;
  scheduled: { plan: BillablePlanType; amountCents: number } | null;
}

/** Snake case in every API version, so a 402's `balance` reads the same as `GET /v1/organization/billing/balance`. */
export interface BillingBalance {
  plan: PlanType;
  period_start: string;
  period_end: string;
  /** The billing page's Balance card. Null on plans without included credit. */
  credit: {
    total_cents: number;
    plan_cents: number;
    one_time_cents: number;
    used_cents: number;
    remaining_cents: number;
    overage_cents: number;
  } | null;
  /** Usage at which new workspaces get a 402: trial or YC deal credit, or an admin's usage limit. Null when nothing caps usage. */
  limit: { kind: 'credit' | 'usage_limit'; limit_cents: number; used_cents: number; remaining_cents: number } | null;
  blocked: BillingBlock | null;
}

export interface BillingPeriod {
  start: string;
  end: string;
}

export interface GetBillingPeriodsResponse {
  /** Periods with usage, newest first; the current period is always first. */
  periods: BillingPeriod[];
}

export interface UsageAmount {
  minutes: number;
  cents: number;
}

export interface BillingUsage {
  bucket: AnalyticsBucket;
  start: string;
  end: string;
  points: { bucket: string; cents: number; bySource: Record<string, number> }[];
  sources: (UsageAmount & { source: string })[];
  /** Keyed by seat email, falling back to the workspace creator's; null for charges with neither, like provider usage. */
  members: (UsageAmount & { email: string | null })[];
  /** A workspace size, or the charge's source when it has no size, like provider usage. */
  sizes: (UsageAmount & { size: string })[];
  /** One-time credit granted for this period. */
  grants: { amountCents: number; reason: string; grantedAt: string }[];
}

export const BILLING_ALERT_THRESHOLDS = [50, 80, 100, 150, 200] as const;

/** Usage sources billed at cost, which can be capped on their own. Values match `minute_ledger.source`. */
export const SOURCE_LIMIT_SOURCES = ['limrun', 'modal', 'revyl', 'inference'] as const;
export type SourceLimitSource = (typeof SOURCE_LIMIT_SOURCES)[number];
export const SOURCE_LIMIT_LABELS: Record<SourceLimitSource, string> = { limrun: 'Mobile simulators', modal: 'GPU sandboxes', revyl: 'macOS sandboxes', inference: 'Okidoki agent model calls' };
export const usageLimitCentsSchema = z.number().int().min(100).max(100_000_000);
export const sourceLimitsCentsSchema = z.partialRecord(z.enum(SOURCE_LIMIT_SOURCES), usageLimitCentsSchema);

export interface BillingAlertSettings {
  thresholdsPercent: number[];
  /** Fixed amounts of usage at included rates, the same measure as the billing page's usage total. */
  thresholdsCents: number[];
  emails: string[];
  slackChannel: Pick<SlackChannel, 'id' | 'name'> | null;
  /** Caps period usage, measured like `thresholdsCents`. Paid plans only. */
  usageLimitCents: number | null;
  sourceLimitsCents: Partial<Record<SourceLimitSource, number>>;
}
