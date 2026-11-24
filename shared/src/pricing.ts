import { DEFAULT_WORKSPACE_SIZE, isWorkspaceSize, type WorkspaceSize } from './sandbox';

export const PLAN_TYPES = ['trial', 'developer', 'team', 'enterprise'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];
export type BillablePlanType = 'developer' | 'team';

export function isBillablePlan(plan: string | null | undefined): plan is BillablePlanType {
  return plan === 'developer' || plan === 'team';
}

/** Reason a billing block was raised; shared so backend errors and frontend prompts stay in sync. */
export const BILLING_BLOCK_CODES = ['INSUFFICIENT_MINUTES', 'PAYMENT_FAILED', 'USAGE_LIMIT_REACHED', 'SOURCE_LIMIT_REACHED', 'ORGANIZATION_BANNED'] as const;
export type BillingBlockCode = (typeof BILLING_BLOCK_CODES)[number];

export interface BillingBlock {
  code: BillingBlockCode;
  message: string;
}

export function isBillingBlockCode(value: unknown): value is BillingBlockCode {
  return typeof value === 'string' && BILLING_BLOCK_CODES.some((c) => c === value);
}

export const BILLING_BLOCK_TITLES: Record<BillingBlockCode, string> = {
  INSUFFICIENT_MINUTES: 'Out of usage',
  PAYMENT_FAILED: 'Payment failed',
  USAGE_LIMIT_REACHED: 'Usage limit reached',
  SOURCE_LIMIT_REACHED: 'Out of usage',
  ORGANIZATION_BANNED: 'Organization banned',
};

export const FOUNDERS_EMAIL = 'founders@okidoki.dev';
export const OUT_OF_USAGE_SUBSCRIBE_LINE = 'Subscribe to keep creating and waking workspaces, or email';

export const TRIAL_CREDIT_CENTS = 10_000;

/** `mothership` here is Scout's name from before it was renamed, not a Manager. It stays: engines already running in sandboxes validate message sources, and analytics store it. */
export const SCOUT_SOURCE = 'mothership';

export const WORKSPACE_SOURCES = ['api', 'dashboard', 'slack', 'linear', 'github', 'gitlab', 'automation', SCOUT_SOURCE] as const;
export type WorkspaceSource = (typeof WORKSPACE_SOURCES)[number];

export const CLIENT_MESSAGE_SOURCES = ['web', 'desktop', 'mobile', 'tui'] as const;
export const MESSAGE_SOURCES = [...CLIENT_MESSAGE_SOURCES, ...WORKSPACE_SOURCES] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

export function isClientMessageSource(value: unknown): value is (typeof CLIENT_MESSAGE_SOURCES)[number] {
  return typeof value === 'string' && CLIENT_MESSAGE_SOURCES.some((source) => source === value);
}

export function isMessageSource(value: unknown): value is MessageSource {
  return typeof value === 'string' && MESSAGE_SOURCES.some((source) => source === value);
}

/** Genuinely-paid Team/Enterprise, for entitlements a trial must not claim (e.g. a dedicated FDE). */
export function isPaidTeamPlan(plan: PlanType | null | undefined): boolean {
  return plan === 'team' || plan === 'enterprise';
}

export interface Plan {
  id: PlanType;
  name: string;
  monthlyPrice: number;
  features?: string[];
}

export const MANUAL_SOURCES: WorkspaceSource[] = ['dashboard', 'slack', 'linear', 'github', 'gitlab'];
export const INTEGRATION_SOURCES: readonly WorkspaceSource[] = ['slack', 'linear', 'github', 'gitlab'];
export const AUTOMATED_SOURCES: readonly WorkspaceSource[] = ['api', 'automation'];

/** Comma-separated quoted source literals for SQL `IN (...)` clauses. */
export const AUTOMATED_SOURCES_SQL = AUTOMATED_SOURCES.map((s) => `'${s}'`).join(', ');

function isManualSource(source: string): boolean {
  return MANUAL_SOURCES.some((s) => s === source);
}

export function isPlanType(value: unknown): value is PlanType {
  return typeof value === 'string' && PLAN_TYPES.some((p) => p === value);
}

/** `organizations.plan` is an unconstrained varchar, so DB reads must be normalized before use. */
export function toPlanType(value: unknown): PlanType {
  return isPlanType(value) ? value : 'trial';
}

export function isUserlessAutomatedWorkspace(
  source: WorkspaceSource | undefined,
  userId: string | null | undefined,
): boolean {
  if (userId) return false;
  return source !== undefined && !isManualSource(source);
}

export const WORKSPACE_SIZE_CREDIT_RATES: Record<WorkspaceSize, { included: number; overage: number }> = {
  small: { included: 4_000, overage: 6_000 },
  large: { included: 8_000, overage: 12_000 },
  ultra: { included: 16_000, overage: 24_000 },
};

export function formatCreditRate(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(3)}`;
}

export function resolveCreditWorkspaceSize(sandboxSize: string | null, size: string | null, orgDefault: string | null): WorkspaceSize {
  return [sandboxSize, size, orgDefault].find(isWorkspaceSize) ?? DEFAULT_WORKSPACE_SIZE;
}

export const MIN_OVERAGE_CHARGE_CENTS = 5_000;

/** Traffic through a dedicated static IP, billed as usage. AWS charges us about $0.09/GB to send it. */
export const EGRESS_MICRODOLLARS_PER_GB = 150_000;
export const EGRESS_RATE_LABEL = `$${(EGRESS_MICRODOLLARS_PER_GB / 1_000_000).toFixed(2)}/GB`;

export const CREDIT_PLAN_UNITS: Record<BillablePlanType, { unitCents: number; minQuantity: number; maxQuantity: number }> = {
  developer: { unitCents: 5_000, minQuantity: 1, maxQuantity: 1 },
  team: { unitCents: 10_000, minQuantity: 2, maxQuantity: 1_000 },
};

export function creditPlanQuantity(plan: BillablePlanType, amountCents: number): number | null {
  const { unitCents, minQuantity, maxQuantity } = CREDIT_PLAN_UNITS[plan];
  const quantity = amountCents / unitCents;
  return Number.isInteger(quantity) && quantity >= minQuantity && quantity <= maxQuantity ? quantity : null;
}

export function stepTeamPlanCents(cents: number, direction: 1 | -1, { stepCents = CREDIT_PLAN_UNITS.team.unitCents, aboveCents = cents } = {}): number {
  const { unitCents, minQuantity, maxQuantity } = CREDIT_PLAN_UNITS.team;
  const baseCents = Math.floor(cents / unitCents) * unitCents;
  const stepped = direction === 1 ? baseCents + stepCents * (Math.floor(Math.max(0, aboveCents - baseCents) / stepCents) + 1)
    : (Math.ceil(cents / unitCents) - 1) * unitCents;
  return Math.min(maxQuantity * unitCents, Math.max(minQuantity * unitCents, stepped));
}

export const PLANS: Record<PlanType, Plan> = {
  trial: {
    id: 'trial',
    name: 'Free Trial',
    monthlyPrice: 0,
    features: [
      `$${TRIAL_CREDIT_CENTS / 100} of free usage, no credit card required`,
      'Unlimited repositories and environments',
      'Unlimited automations',
      'Warm pools and warm hooks',
      'API access',
    ],
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    monthlyPrice: 50,
    features: [
      '$50 of included usage every month',
      'Usage beyond that billed at the overage rate',
      'Small, Large, and Ultra workspaces',
      'Unlimited repositories',
      'Unlimited environments',
      'Unlimited automations',
      'Warm pools and warm hooks',
      'API access',
      'Mobile app',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    monthlyPrice: 200,
    features: [
      '$200+ of included usage every month, in $100 steps',
      'Usage beyond that billed at the overage rate',
      'Everything in Developer',
      'Higher API rate limits',
      'Access to a static egress IP',
      'Shared Slack support channel',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: 0,
    features: [
      'Unlimited manual workspace minutes',
      'Unlimited automated workspace minutes',
      'Unlimited automations',
      'Custom warm hooks and pools',
      'Custom API rates',
      'Mobile app',
      'Custom rate limits',
      'Shared Slack support channel',
      'SOC 2',
      'Data Processing Agreement (DPA)',
      'HIPAA Business Associate Agreement (BAA)',
      'SCIM user provisioning',
      'Custom security and privacy settings',
    ],
  },
};

export const TEAM_PLAN = PLANS.team;
export const ENTERPRISE_PLAN = PLANS.enterprise;

export interface PlanLimits {
  repositoryLimit: number;
  environmentLimit: number;
}

export const PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  trial: {
    repositoryLimit: Infinity,
    environmentLimit: Infinity,
  },
  developer: {
    repositoryLimit: Infinity,
    environmentLimit: Infinity,
  },
  team: {
    repositoryLimit: Infinity,
    environmentLimit: Infinity,
  },
  enterprise: {
    repositoryLimit: Infinity,
    environmentLimit: Infinity,
  },
};

