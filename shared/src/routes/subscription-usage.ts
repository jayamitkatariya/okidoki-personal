import type { CredentialPoolAccount } from '../credential-pool';
import type { AgentProvider } from '../agent';
import type { CredentialScope } from '../credentials/types';

export const SUBSCRIPTION_USAGE_PROVIDERS = ['claude', 'codex', 'gemini'] as const;
export type SubscriptionUsageProvider = (typeof SUBSCRIPTION_USAGE_PROVIDERS)[number];

export interface SubscriptionUsageWindow {
  kind: 'session' | 'weekly';
  /** Set when the limit only covers one model family, e.g. `Opus`. */
  model: string | null;
  usedPercent: number;
  resetsAt: string | null;
}

export interface SubscriptionUsageAccount extends CredentialPoolAccount {
  /** Null when the provider would not report usage for the account. */
  windows: SubscriptionUsageWindow[] | null;
  /** When the provider reported `windows`, which is earlier than the latest read when that read failed. */
  windowsFetchedAt: string | null;
}

export interface SubscriptionUsageResponse {
  accounts: SubscriptionUsageAccount[];
}

export interface AgentSubscriptionUsageAccount extends SubscriptionUsageAccount {
  provider: SubscriptionUsageProvider;
  scope: CredentialScope;
}

export interface AgentSubscriptionUsageResponse {
  accounts: AgentSubscriptionUsageAccount[];
}

export const getSubscriptionAuthCommand = (provider: AgentProvider, scope: CredentialScope) => `okidoki ${provider}-auth${scope === 'org' ? ' --org' : ''}`;

const DAY_MS = 86_400_000;

export const subscriptionUsageLevel = (percent: number): 'ok' | 'warning' | 'critical' => (percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'ok');

export const subscriptionWindowLabel = (window: SubscriptionUsageWindow) => [window.kind === 'session' ? '5-hour' : 'Weekly', window.model].filter(Boolean).join(' · ');

export const formatUsageTime = (iso: string, options: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', ...options });

export function formatUsageCountdown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const [days, hours, mins] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function subscriptionResetLabel(resetsAt: string | null, now: number): string {
  if (!resetsAt) return 'Not started';
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return 'Resetting now';
  return ms < DAY_MS ? `Resets in ${formatUsageCountdown(ms)}` : `Resets ${formatUsageTime(resetsAt, { weekday: 'short' })}`;
}
