import type { EngineCredentialAuthMethod } from '@okidoki/shared';
import { ENGINE_ENV, type EngineEnv } from '../engine-env';

type ClaudeAuthEnv = Pick<
  EngineEnv,
  'OKIDOKI_CLAUDE_AUTH_METHOD' | 'CLAUDE_CODE_USE_BEDROCK' | 'ANTHROPIC_API_KEY'
>;

export function resolveClaudeAuthMethodForMessage(
  env: ClaudeAuthEnv = ENGINE_ENV,
): EngineCredentialAuthMethod | 'unknown' {
  const method = env.OKIDOKI_CLAUDE_AUTH_METHOD;
  if (method && method !== 'none') {
    return method;
  }
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') return 'bedrock';
  if (env.ANTHROPIC_API_KEY) return 'api_key';
  return 'unknown';
}

/**
 * Builds the env passed to the Claude Agent SDK for a query.
 *
 * Workspaces can configure plain env vars (via the Okidoki Environments UI,
 * Infisical, etc.) which are baked into the sandbox. When a user happens to
 * configure ANTHROPIC_API_KEY there but the workspace is actually authenticated
 * via OAuth or Bedrock, the env var would silently override the configured
 * auth and fail in surprising ways. We strip it in that case so the auth the
 * user actually picked is honored.
 */
export function buildClaudeAgentEnv(overrides?: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (overrides) {
    Object.assign(env, overrides);
  }
  const method = ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD;
  const isBedrock = method === 'bedrock'
    || env.OKIDOKI_CLAUDE_AUTH_METHOD === 'bedrock'
    || env.CLAUDE_CODE_USE_BEDROCK === '1';
  if (method === 'oauth' || method === 'bedrock' || method === 'foundry' || isBedrock) {
    env.ANTHROPIC_API_KEY = undefined;
  }
  if (method && method !== 'none' && method !== 'oauth') env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
  if (method === 'ollama' || method === 'anthropic-compatible') env.ANTHROPIC_API_KEY = '';
  if (isBedrock) {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
  }
  // Claude Code prefers this token over a connected credential's access keys, and an environment can carry its app's own.
  if (method === 'bedrock' || env.OKIDOKI_CLAUDE_AUTH_METHOD === 'bedrock') env.AWS_BEARER_TOKEN_BEDROCK = undefined;
  env.GH_TOKEN = undefined;
  env.GITHUB_TOKEN = undefined;
  env.GH_CONFIG_DIR = undefined;
  // Tells the SDK to also load CLAUDE.md from each `additionalDirectories` entry.
  env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // Opt into authoritative session_state_changed events (opt-in since SDK
  // 0.2.83). These describe the foreground turn; background task rosters
  // independently track work that outlives it.
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  return env;
}
