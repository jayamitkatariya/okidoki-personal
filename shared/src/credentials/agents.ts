import { AGENT, isValidAgentProvider, type AgentProvider } from '../agent';
import { isRecord } from '../type-guards';

export const CREDENTIAL_METHOD = {
  OAUTH: 'oauth',
  API_KEY: 'api_key',
  ANTHROPIC_COMPATIBLE: 'anthropic-compatible',
  OPENAI_COMPATIBLE: 'openai-compatible',
  OLLAMA: 'ollama',
  FOUNDRY: 'foundry',
  BEDROCK: 'bedrock',
  OPENCODE_GO: 'opencode-go',
  ASTER: 'aster',
  OPENROUTER: 'openrouter',
  MUSE_OAUTH: 'muse-oauth',
  GEMINI_OAUTH: 'gemini-oauth',
} as const;

/**
 * `public.credentials.type` values. Not derived from agent + method: live rows,
 * and one Aster/OpenRouter row serves both OpenCode and Pi.
 */
export const CREDENTIAL_TYPE = {
  CLAUDE_OAUTH: 'claude',
  ANTHROPIC_API_KEY: 'claude_anthropic_api_key',
  ANTHROPIC_COMPATIBLE: 'anthropic_compatible',
  CLAUDE_FOUNDRY: 'claude_foundry',
  CLAUDE_BEDROCK: 'claude_bedrock',
  CODEX_OAUTH: 'codex',
  OPENAI_API_KEY: 'openai_api_key',
  OPENAI_COMPATIBLE: 'openai_compatible',
  OLLAMA: 'ollama',
  CODEX_FOUNDRY: 'codex_foundry',
  CURSOR_API_KEY: 'cursor_api_key',
  OPENCODE_GO_API_KEY: 'opencode_go_api_key',
  ASTER_API_KEY: 'aster_api_key',
  OPENROUTER_API_KEY: 'openrouter_api_key',
  MUSE_OAUTH: 'muse_oauth',
  MUSE_API_KEY: 'muse_api_key',
  GEMINI_OAUTH: 'gemini_oauth',
} as const;

export type AuthMethod = (typeof CREDENTIAL_METHOD)[keyof typeof CREDENTIAL_METHOD];

export type EnvironmentAuthAgent = typeof AGENT.CLAUDE | typeof AGENT.CODEX;

export const ENVIRONMENT_AUTH_REQUIRED_KEYS: Record<EnvironmentAuthAgent, readonly [typeof CREDENTIAL_METHOD.BEDROCK | typeof CREDENTIAL_METHOD.API_KEY, readonly string[]][]> = {
  [AGENT.CLAUDE]: [
    [CREDENTIAL_METHOD.BEDROCK, ['CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']],
    [CREDENTIAL_METHOD.API_KEY, ['ANTHROPIC_API_KEY']],
  ],
  [AGENT.CODEX]: [[CREDENTIAL_METHOD.API_KEY, ['OPENAI_API_KEY']]],
};

export function isEnvironmentKeySet(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  return !!env[key]?.trim();
}

export function detectEnvironmentAuthMethod(agent: EnvironmentAuthAgent, env: Readonly<Record<string, string | undefined>>) {
  return ENVIRONMENT_AUTH_REQUIRED_KEYS[agent].find(([, keys]) => keys.every((key) => isEnvironmentKeySet(env, key)))?.[0];
}

export const INFERENCE_PROVIDER_LABELS: Record<string, string> = {
  [CREDENTIAL_METHOD.OLLAMA]: 'Ollama',
  [CREDENTIAL_METHOD.OPENCODE_GO]: 'OpenCode Go',
  [CREDENTIAL_METHOD.ASTER]: 'Aster',
  [CREDENTIAL_METHOD.OPENROUTER]: 'OpenRouter',
  [CREDENTIAL_METHOD.OPENAI_COMPATIBLE]: 'OpenAI-compatible endpoint',
  [CREDENTIAL_METHOD.ANTHROPIC_COMPATIBLE]: 'Anthropic-compatible endpoint',
};

export interface SandboxAuthFile {
  path: string;
  contents: string;
  mode?: string;
}

export interface SandboxAuth {
  env: Record<string, string>;
  files?: readonly SandboxAuthFile[];
}

export interface AgentCredentialMethodEntry<TMethod extends string = string> {
  /** Also the `fellBackFrom` value on the wire. */
  method: TMethod;
  credentialType: string;
}

export const AGENT_CREDENTIAL_METHODS_IN_ORDER = {
  [AGENT.CLAUDE]: [
    { method: CREDENTIAL_METHOD.OAUTH, credentialType: CREDENTIAL_TYPE.CLAUDE_OAUTH },
    { method: CREDENTIAL_METHOD.API_KEY, credentialType: CREDENTIAL_TYPE.ANTHROPIC_API_KEY },
    { method: CREDENTIAL_METHOD.ANTHROPIC_COMPATIBLE, credentialType: CREDENTIAL_TYPE.ANTHROPIC_COMPATIBLE },
    { method: CREDENTIAL_METHOD.FOUNDRY, credentialType: CREDENTIAL_TYPE.CLAUDE_FOUNDRY },
    { method: CREDENTIAL_METHOD.BEDROCK, credentialType: CREDENTIAL_TYPE.CLAUDE_BEDROCK },
    { method: CREDENTIAL_METHOD.OLLAMA, credentialType: CREDENTIAL_TYPE.OLLAMA },
  ],
  [AGENT.CODEX]: [
    { method: CREDENTIAL_METHOD.OAUTH, credentialType: CREDENTIAL_TYPE.CODEX_OAUTH },
    { method: CREDENTIAL_METHOD.API_KEY, credentialType: CREDENTIAL_TYPE.OPENAI_API_KEY },
    { method: CREDENTIAL_METHOD.OPENAI_COMPATIBLE, credentialType: CREDENTIAL_TYPE.OPENAI_COMPATIBLE },
    { method: CREDENTIAL_METHOD.FOUNDRY, credentialType: CREDENTIAL_TYPE.CODEX_FOUNDRY },
    { method: CREDENTIAL_METHOD.OLLAMA, credentialType: CREDENTIAL_TYPE.OLLAMA },
  ],
  [AGENT.CURSOR]: [
    { method: CREDENTIAL_METHOD.API_KEY, credentialType: CREDENTIAL_TYPE.CURSOR_API_KEY },
  ],
  [AGENT.GEMINI]: [
    { method: CREDENTIAL_METHOD.GEMINI_OAUTH, credentialType: CREDENTIAL_TYPE.GEMINI_OAUTH },
  ],
  [AGENT.MUSE]: [
    { method: CREDENTIAL_METHOD.MUSE_OAUTH, credentialType: CREDENTIAL_TYPE.MUSE_OAUTH },
    { method: CREDENTIAL_METHOD.API_KEY, credentialType: CREDENTIAL_TYPE.MUSE_API_KEY },
  ],
  [AGENT.OPENCODE]: [
    { method: CREDENTIAL_METHOD.OPENCODE_GO, credentialType: CREDENTIAL_TYPE.OPENCODE_GO_API_KEY },
    { method: CREDENTIAL_METHOD.ASTER, credentialType: CREDENTIAL_TYPE.ASTER_API_KEY },
    { method: CREDENTIAL_METHOD.OPENROUTER, credentialType: CREDENTIAL_TYPE.OPENROUTER_API_KEY },
    { method: CREDENTIAL_METHOD.OPENAI_COMPATIBLE, credentialType: CREDENTIAL_TYPE.OPENAI_COMPATIBLE },
    { method: CREDENTIAL_METHOD.OLLAMA, credentialType: CREDENTIAL_TYPE.OLLAMA },
  ],
  [AGENT.OKIDOKI]: [
    { method: CREDENTIAL_METHOD.OAUTH, credentialType: CREDENTIAL_TYPE.CODEX_OAUTH },
    { method: CREDENTIAL_METHOD.API_KEY, credentialType: CREDENTIAL_TYPE.OPENAI_API_KEY },
  ],
  [AGENT.PI]: [
    { method: CREDENTIAL_METHOD.OPENCODE_GO, credentialType: CREDENTIAL_TYPE.OPENCODE_GO_API_KEY },
    { method: CREDENTIAL_METHOD.ASTER, credentialType: CREDENTIAL_TYPE.ASTER_API_KEY },
    { method: CREDENTIAL_METHOD.OPENROUTER, credentialType: CREDENTIAL_TYPE.OPENROUTER_API_KEY },
    { method: CREDENTIAL_METHOD.OPENAI_COMPATIBLE, credentialType: CREDENTIAL_TYPE.OPENAI_COMPATIBLE },
    { method: CREDENTIAL_METHOD.OLLAMA, credentialType: CREDENTIAL_TYPE.OLLAMA },
  ],
} as const satisfies Record<AgentProvider, readonly AgentCredentialMethodEntry[]>;

export type AgentCredentialMethod<TAgent extends AgentProvider> =
  (typeof AGENT_CREDENTIAL_METHODS_IN_ORDER)[TAgent][number]['method'];

export type CredentialPriority = Partial<Record<AgentProvider, AuthMethod[]>>;

export function agentCredentialMethods(agent: AgentProvider): readonly AuthMethod[] {
  return AGENT_CREDENTIAL_METHODS_IN_ORDER[agent].map((entry) => entry.method);
}

export function rankAgentCredentialMethods(
  agent: AgentProvider,
  ranked: readonly unknown[],
): { ordered: AuthMethod[]; remaining: AuthMethod[] } {
  const known = agentCredentialMethods(agent);
  const ordered: AuthMethod[] = [];
  for (const candidate of ranked) {
    const method = known.find((entry) => entry === candidate);
    if (method && !ordered.includes(method)) ordered.push(method);
  }
  return { ordered, remaining: known.filter((method) => !ordered.includes(method)) };
}

export function resolveCredentialMethodOrder(
  agent: AgentProvider,
  priority?: CredentialPriority | null,
): readonly AgentCredentialMethodEntry<AuthMethod>[] {
  const entries: readonly AgentCredentialMethodEntry<AuthMethod>[] = AGENT_CREDENTIAL_METHODS_IN_ORDER[agent];
  const ranked = priority?.[agent];
  if (!ranked?.length) return entries;

  const { ordered, remaining } = rankAgentCredentialMethods(agent, ranked);
  return [...ordered, ...remaining].flatMap((method) => entries.filter((entry) => entry.method === method));
}

export function sanitizeCredentialPriority(raw: unknown): CredentialPriority | null {
  if (!isRecord(raw)) return null;

  const sanitized: CredentialPriority = {};
  for (const [agent, methods] of Object.entries(raw)) {
    if (!isValidAgentProvider(agent) || !Array.isArray(methods)) continue;
    const { ordered } = rankAgentCredentialMethods(agent, methods);
    if (ordered.length > 0) sanitized[agent] = ordered;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function getCredentialMethodLabel(agent: AgentProvider, method: AuthMethod): string {
  switch (method) {
    case CREDENTIAL_METHOD.OAUTH:
      if (agent === AGENT.CODEX || agent === AGENT.OKIDOKI) return 'ChatGPT account';
      return 'Claude account';
    case CREDENTIAL_METHOD.API_KEY:
      if (agent === AGENT.CODEX || agent === AGENT.OKIDOKI) return 'OpenAI API key';
      if (agent === AGENT.CURSOR) return 'Cursor API key';
      if (agent === AGENT.MUSE) return 'Muse API key';
      return 'Anthropic API key';
    case CREDENTIAL_METHOD.FOUNDRY:
      return 'Microsoft Foundry';
    case CREDENTIAL_METHOD.BEDROCK:
      return 'AWS Bedrock';
    case CREDENTIAL_METHOD.OLLAMA:
    case CREDENTIAL_METHOD.OPENCODE_GO:
    case CREDENTIAL_METHOD.ASTER:
    case CREDENTIAL_METHOD.OPENROUTER:
    case CREDENTIAL_METHOD.OPENAI_COMPATIBLE:
    case CREDENTIAL_METHOD.ANTHROPIC_COMPATIBLE:
      return INFERENCE_PROVIDER_LABELS[method];
    case CREDENTIAL_METHOD.MUSE_OAUTH:
      return 'Muse account';
    case CREDENTIAL_METHOD.GEMINI_OAUTH:
      return 'Google account';
  }
}

export function getAgentCredentialTypes(agent: AgentProvider): readonly string[] {
  return AGENT_CREDENTIAL_METHODS_IN_ORDER[agent].map((entry) => entry.credentialType);
}

export function getAgentCredentialType<TAgent extends AgentProvider>(
  agent: TAgent,
  method: AgentCredentialMethod<TAgent>,
): string {
  const entries: readonly AgentCredentialMethodEntry[] = AGENT_CREDENTIAL_METHODS_IN_ORDER[agent];
  const entry = entries.find((candidate) => candidate.method === method);
  if (!entry) throw new Error(`${agent} declares no ${method} credential method`);
  return entry.credentialType;
}
