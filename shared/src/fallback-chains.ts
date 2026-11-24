import { z } from 'zod';
import {
  isValidAgentProvider,
  ENGINE_AGENT_PROVIDERS,
  VALID_THINKING_LEVELS,
  type AgentProvider,
} from './agent';
import { isAuthMethod } from './analytics/types';
import { agentCredentialMethods, CREDENTIAL_METHOD, rankAgentCredentialMethods, type AuthMethod, type CredentialPriority } from './credentials/agents';
import { CREDENTIAL_SCOPES, type CredentialScope } from './credentials/types';
import { isRecord } from './type-guards';

export type FallbackStep =
  | { kind: 'credential'; method: AuthMethod; scope?: CredentialScope; model?: string }
  | { kind: 'harness'; provider: AgentProvider; model?: string };

export type FallbackChains = Partial<Record<AgentProvider, FallbackStep[]>>;

/** Harnesses whose managers detect usage limits, so their harness steps can actually fire. */
export const QUOTA_REPORTING_AGENTS: readonly AgentProvider[] = ['claude', 'codex', 'gemini', 'muse', 'opencode', 'pi'];

export function defaultFallbackChain(agent: AgentProvider, orgCodexLogin = false): FallbackStep[] {
  const credentials: FallbackStep[] = agentCredentialMethods(agent).map((method) => ({ kind: 'credential', method }));
  return agent === 'claude' && orgCodexLogin ? [...credentials, { kind: 'harness', provider: 'codex' }] : credentials;
}

/**
 * Claude and Codex can switch a running chat onto Ollama or an OpenAI-compatible endpoint, which
 * serve their own models, so the chat's current model does not carry over to those steps.
 */
export function credentialStepTakesModel(agent: AgentProvider, method: AuthMethod): boolean {
  return (agent === 'claude' || agent === 'codex')
    && (method === CREDENTIAL_METHOD.OLLAMA || method === CREDENTIAL_METHOD.OPENAI_COMPATIBLE);
}

const stepModel = (entry: Record<string, unknown>) => (typeof entry.model === 'string' ? entry.model.trim() : '');

export function resolveFallbackChain(agent: AgentProvider, chains: FallbackChains | null | undefined, orgCodexLogin = false): FallbackStep[] {
  return chains?.[agent] ?? defaultFallbackChain(agent, orgCodexLogin);
}

export function fallbackChainAllowsScope(chain: readonly FallbackStep[], method: AuthMethod, scope: CredentialScope): boolean {
  const step = chain.find((entry) => entry.kind === 'credential' && entry.method === method);
  return step?.kind !== 'credential' || !step.scope || step.scope === scope;
}

export function fallbackStepId(step: FallbackStep): string {
  return step.kind === 'credential' ? `credential:${step.method}` : `harness:${step.provider}`;
}

/** A chat starts on the chain's first credential, so a fork step cannot come before it. */
export function withCredentialFirst(steps: FallbackStep[]): FallbackStep[] {
  const first = steps.findIndex((step) => step.kind === 'credential');
  return first <= 0 ? steps : [steps[first], ...steps.slice(0, first), ...steps.slice(first + 1)];
}

function sanitizeFallbackChain(agent: AgentProvider, raw: unknown[]): FallbackStep[] {
  const { ordered } = rankAgentCredentialMethods(
    agent,
    raw.flatMap((entry) => (isRecord(entry) && entry.kind === 'credential' ? [entry.method] : [])),
  );
  const accepted = new Set<AuthMethod>(ordered);
  const forks = new Set<AgentProvider>();
  const steps: FallbackStep[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (entry.kind === 'credential') {
      if (!isAuthMethod(entry.method) || !accepted.delete(entry.method)) continue;
      const model = credentialStepTakesModel(agent, entry.method) ? stepModel(entry) : '';
      const scope = CREDENTIAL_SCOPES.find((candidate) => candidate === entry.scope);
      steps.push({ kind: 'credential', method: entry.method, ...(scope ? { scope } : {}), ...(model ? { model } : {}) });
      continue;
    }
    const provider = entry.provider;
    if (entry.kind !== 'harness' || typeof provider !== 'string' || !isValidAgentProvider(provider)) continue;
    if (provider === agent || forks.has(provider)) continue;
    forks.add(provider);
    const model = stepModel(entry);
    steps.push({ kind: 'harness', provider, ...(model ? { model } : {}) });
  }
  // Credentials left out of the chain are never fallen back to, but a workspace still
  // has to start somewhere: a chain that names no credential gets the built-in order.
  return withCredentialFirst(accepted.size === ordered.length ? [...steps, ...defaultFallbackChain(agent)] : steps);
}

export function sanitizeFallbackChains(raw: unknown): FallbackChains | null {
  if (!isRecord(raw)) return null;
  const chains: FallbackChains = {};
  for (const [agent, steps] of Object.entries(raw)) {
    if (!isValidAgentProvider(agent) || !Array.isArray(steps) || steps.length === 0) continue;
    chains[agent] = sanitizeFallbackChain(agent, steps);
  }
  return Object.keys(chains).length > 0 ? chains : null;
}

export function credentialPriorityFromChains(chains: FallbackChains | null): CredentialPriority | null {
  if (!chains) return null;
  const priority: CredentialPriority = {};
  for (const [agent, steps] of Object.entries(chains)) {
    if (!isValidAgentProvider(agent)) continue;
    priority[agent] = steps.flatMap((step) => (step.kind === 'credential' ? [step.method] : []));
  }
  return priority;
}

/** A saved priority only ordered methods, never removed one, so the migrated chain keeps them all. */
export function fallbackChainsFromPriority(priority: CredentialPriority | null): FallbackChains | null {
  if (!priority) return null;
  const chains: FallbackChains = {};
  for (const [agent, methods] of Object.entries(priority)) {
    if (!isValidAgentProvider(agent)) continue;
    const { ordered, remaining } = rankAgentCredentialMethods(agent, methods);
    chains[agent] = [...ordered, ...remaining].map((method) => ({ kind: 'credential', method }));
  }
  return sanitizeFallbackChains(chains);
}

export const fallbackHarnessStepSchema = z.object({
  kind: z.literal('harness'),
  provider: z.enum(ENGINE_AGENT_PROVIDERS),
  model: z.string().min(1),
  thinkingLevel: z.enum(VALID_THINKING_LEVELS).optional().catch(undefined),
});

export type FallbackHarnessStep = z.infer<typeof fallbackHarnessStepSchema>;

export const fallbackPlanStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('credentials'),
    // An empty list would allow every method.
    methods: z.array(z.unknown()).transform((methods) => methods.filter(isAuthMethod)).refine((methods) => methods.length > 0),
    models: z.record(z.string(), z.string().min(1)).optional(),
  }),
  fallbackHarnessStepSchema,
]);

export type FallbackPlanStep = z.infer<typeof fallbackPlanStepSchema>;

// Skip steps a newer monolith sends that this engine can't read, rather than failing the whole plan.
export const fallbackPlanResponseSchema = z.object({
  steps: z.array(z.unknown()).transform((steps) => steps.flatMap((step) => fallbackPlanStepSchema.safeParse(step).data ?? [])),
});
export type FallbackPlanResponse = z.infer<typeof fallbackPlanResponseSchema>;
