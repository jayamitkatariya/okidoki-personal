export const AGENT = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  CURSOR: 'cursor',
  GEMINI: 'gemini',
  MUSE: 'muse',
  OPENCODE: 'opencode',
  PI: 'pi',
  OKIDOKI: 'okidoki',
} as const;

export type AgentProvider = (typeof AGENT)[keyof typeof AGENT];
export type EngineAgentProvider = Exclude<AgentProvider, 'okidoki'>;

export const SUPPORTED_AGENT_PROVIDERS_HEADER = 'X-Okidoki-Agent-Providers';

export const VALID_AGENT_PROVIDERS: readonly AgentProvider[] = Object.values(AGENT);
export function isEngineAgentProvider(value: string): value is EngineAgentProvider {
  return value !== AGENT.OKIDOKI && isValidAgentProvider(value);
}
export const ENGINE_AGENT_PROVIDERS = VALID_AGENT_PROVIDERS.filter(isEngineAgentProvider);
export const SUBAGENT_MCP_HARNESSES: readonly AgentProvider[] = [AGENT.CLAUDE, AGENT.CODEX];

export function isValidAgentProvider(value: string): value is AgentProvider {
  return VALID_AGENT_PROVIDERS.some((p) => p === value);
}

export interface AgentProviderOption {
  value: AgentProvider;
  label: string;
  description: string;
}

export const AGENT_PROVIDER_OPTIONS: readonly AgentProviderOption[] = [
  {
    value: 'claude',
    label: 'Claude Code',
    description: 'Use Claude Code for tasks',
  },
  {
    value: 'codex',
    label: 'OpenAI Codex',
    description: 'Use OpenAI Codex for tasks',
  },
  {
    value: 'cursor',
    label: 'Cursor',
    description: 'Use Cursor for tasks',
  },
  {
    value: 'gemini',
    label: 'Gemini',
    description: 'Use Gemini through the Antigravity CLI for tasks',
  },
  {
    value: 'muse',
    label: 'Muse Code',
    description: 'Use Muse Code for tasks',
  },
  {
    value: 'opencode',
    label: 'Opencode',
    description: 'Use Opencode for tasks',
  },
  {
    value: 'pi',
    label: 'Pi',
    description: 'Use Pi for tasks',
  },
];

/**
 * Unified thinking/reasoning level across agent providers.
 *
 * Okidoki | Claude SDK (`effort`) | Codex SDK/ASP (`modelReasoningEffort`)
 * ---------|----------------------|-----------------------------------
 * low      | low                  | low
 * medium   | medium               | medium
 * high     | high                 | high
 * xhigh    | xhigh                | xhigh
 * max      | max                  | xhigh
 * ultra    | —                    | ultra
 * ultracode| xhigh + workflows   | —
 */
export const VALID_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'] as const;
export type ThinkingLevel = typeof VALID_THINKING_LEVELS[number];

export const STANDARD_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[];
const THINKING_LEVELS_BY_AGENT: Record<AgentProvider, readonly ThinkingLevel[]> = {
  claude: [...STANDARD_THINKING_LEVELS, 'ultracode'],
  codex: [...STANDARD_THINKING_LEVELS, 'ultra'],
  cursor: STANDARD_THINKING_LEVELS,
  gemini: STANDARD_THINKING_LEVELS,
  muse: VALID_THINKING_LEVELS.filter((level) => level !== 'max' && level !== 'ultracode'),
  opencode: STANDARD_THINKING_LEVELS,
  pi: STANDARD_THINKING_LEVELS,
  okidoki: STANDARD_THINKING_LEVELS,
};

export function getThinkingLevelOptions(provider?: AgentProvider | null): readonly ThinkingLevel[] {
  return provider ? THINKING_LEVELS_BY_AGENT[provider] : VALID_THINKING_LEVELS;
}

export const DEFAULT_THINKING_LEVEL_BY_AGENT: Record<AgentProvider, ThinkingLevel> = {
  claude: 'high',
  codex: 'medium',
  cursor: 'medium',
  gemini: 'high',
  muse: 'high',
  opencode: 'medium',
  pi: 'medium',
  okidoki: 'medium',
};

export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return VALID_THINKING_LEVELS.some((l) => l === value);
}

export function isProviderSpecificThinkingLevel(value: unknown): value is 'ultra' | 'ultracode' {
  return value === 'ultra' || value === 'ultracode';
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';

export const CODEX_REASONING_EFFORT_BY_THINKING_LEVEL: Record<ThinkingLevel, CodexReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'ultra',
  ultracode: 'xhigh',
};

export function codexReasoningEffortForThinkingLevel(
  thinkingLevel: ThinkingLevel | undefined,
): CodexReasoningEffort | undefined {
  return thinkingLevel ? CODEX_REASONING_EFFORT_BY_THINKING_LEVEL[thinkingLevel] : undefined;
}

export function getProviderDisplayName(provider: AgentProvider, variant: 'short' | 'long' = 'short'): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'gemini':
      return 'Gemini';
    case 'muse':
      return variant === 'long' ? 'Muse Code' : 'Muse';
    case 'opencode':
      return 'Opencode';
    case 'pi':
      return 'Pi';
    case 'okidoki':
      return 'Okidoki';
    case 'claude':
      return variant === 'long' ? 'Claude Code' : 'Claude';
  }
}

export function getCodingAgentDisplayNames(): string {
  return ENGINE_AGENT_PROVIDERS.map((provider) => getProviderDisplayName(provider)).join(', ');
}
