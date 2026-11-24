import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readOllamaAuthEnv, readOpenAICompatibleAuthEnv, OLLAMA_AGENTS, AGENT, detectEnvironmentAuthMethod, type AgentProvider, type EngineAuthMethod } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { GEMINI_AUTH_PATH, MUSE_AUTH_PATH, OPENCODE_AUTH_PATH, PI_AUTH_PATH } from './agent-auth-paths';
import { detectCodexAuthMethod } from './codex-auth';

const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

function detectClaudeAuthMethod(): EngineAuthMethod {
  if (ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD === 'ollama' || ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD === 'anthropic-compatible') {
    return ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD;
  }
  if (existsSync(CLAUDE_CREDENTIALS_PATH) || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'oauth';
  }
  if (ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD === 'foundry') {
    return 'foundry';
  }
  return detectEnvironmentAuthMethod(AGENT.CLAUDE, process.env) ?? 'none';
}

export function detectAgentAuthMethod(provider: AgentProvider): EngineAuthMethod {
  if (OLLAMA_AGENTS.some((agent) => agent === provider && readOllamaAuthEnv(agent, process.env))) return 'ollama';
  switch (provider) {
    case AGENT.CLAUDE:
      return detectClaudeAuthMethod();
    case AGENT.CODEX:
      return detectCodexAuthMethod();
    case AGENT.CURSOR:
      return ENGINE_ENV.CURSOR_API_KEY ? 'api_key' : 'none';
    case AGENT.GEMINI:
      return existsSync(GEMINI_AUTH_PATH) ? 'oauth' : 'none';
    case AGENT.MUSE:
      if (!existsSync(MUSE_AUTH_PATH)) return 'none';
      if (ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.muse?.method === 'api_key') return 'api_key';
      if (ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.muse?.method === 'muse-oauth') return 'oauth';
      return ENGINE_ENV.OKIDOKI_MUSE_AUTH_METHOD ?? 'oauth';
    case AGENT.OPENCODE:
    case AGENT.PI:
      if (readOpenAICompatibleAuthEnv(provider, process.env)) return 'openai-compatible';
      return existsSync(provider === AGENT.OPENCODE ? OPENCODE_AUTH_PATH : PI_AUTH_PATH) ? 'api_key' : 'none';
    case AGENT.OKIDOKI:
      return 'none';
  }
}

export function isAgentAvailable(provider: AgentProvider): boolean {
  return detectAgentAuthMethod(provider) !== 'none';
}
