import type { AgentProvider } from './agent';
import type { OkidokiModelProvider } from './harness/models';

export interface AgentAvailability {
  available: boolean;
  connected_at?: string;
}

export interface OkidokiAgentAvailability extends AgentAvailability {
  modelProviders: OkidokiModelProvider[];
}

export type AgentAvailabilityMap = Partial<Record<AgentProvider, AgentAvailability | undefined>>;

/** Breaks ties between agents that became available together, e.g. through one shared Ollama credential. */
export const AGENT_FALLBACK_ORDER: readonly AgentProvider[] = ['claude', 'codex', 'gemini', 'muse', 'opencode', 'pi', 'cursor'];

/** Connected agents, earliest first: the first one connected is the default until someone picks another. */
export function getConnectedAgentProviders(availability: AgentAvailabilityMap | undefined): AgentProvider[] {
  return AGENT_FALLBACK_ORDER
    .filter((provider) => availability?.[provider]?.available)
    .sort((a, b) => (availability?.[a]?.connected_at ?? '').localeCompare(availability?.[b]?.connected_at ?? ''));
}

/**
 * A provider is only ever a default when its credentials are connected. Falls back to the
 * preferred provider when availability is unknown or nothing is connected, so callers still
 * render the "connect this agent" state instead of an arbitrary provider.
 */
export function resolveAvailableAgentProvider(
  preferred: AgentProvider,
  availability: AgentAvailabilityMap | undefined,
): AgentProvider {
  if (!availability || availability[preferred]?.available) return preferred;
  return getConnectedAgentProviders(availability)[0] ?? preferred;
}

export function pickConnectedAgentProvider(
  configured: readonly (AgentProvider | null | undefined)[],
  availability: AgentAvailabilityMap | undefined,
): AgentProvider | undefined {
  const candidates = configured.filter((provider): provider is AgentProvider => provider != null);
  if (!availability) return candidates[0];
  return candidates.find((provider) => availability[provider]?.available) ?? getConnectedAgentProviders(availability)[0];
}
