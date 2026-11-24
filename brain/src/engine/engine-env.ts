import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  agentCredentialSnapshotSchema,
  ENGINE_PORT,
  isValidAgentProvider,
  parsePosixEnv,
  provisionedDeviceSchema,
  readOkidokiRuntimeEnv,
  OKIDOKI_RUNTIME_ENV_ALIASES,
  serializePosixEnvFile,
  type AgentCredentialSnapshot,
  type AgentCredentialSnapshots,
  type AgentProvider,
  type AuthMethod,
  type CredentialScope,
  type EngineAuthMethod,
  type ProvisionedDevice,
} from '@okidoki/shared';
import { loadRuntimeEnvFile, type RuntimeEnvFile } from './runtime-env-loader';
import { isRecord } from './utils/type-guards';

const SANDBOX_IMAGE_VERSION_FILE = '/usr/local/lib/okidoki-sandbox-image-version';

export interface EngineEnv {
  // Defined: set at sandbox creation, persists across sleep/wake
  OKIDOKI_ENGINE_SECRET: string;
  OKIDOKI_ENGINE_PORT: number;
  OKIDOKI_MONOLITH_URL: string;
  HOME_DIR: string;
  WORKSPACE_ROOT: string;
  OKIDOKI_LOCAL: boolean;
  OKIDOKI_SANDBOX_IMAGE_VERSION: string;

  // Runtime: set via ~/.okidoki/runtime-env.sh at startup, not available during warming
  OKIDOKI_WORKSPACE_ID: string | undefined;
  OKIDOKI_LINEAR_SESSION_ID: string | undefined;
  OKIDOKI_LINEAR_ACCESS_TOKEN: string | undefined;
  OKIDOKI_SLACK_BOT_TOKEN: string | undefined;
  OKIDOKI_LINEAR_ACCESS_CONFIGURED: boolean;
  OKIDOKI_SLACK_ACCESS_CONFIGURED: boolean;
  OKIDOKI_SLACK_CHANNEL_ID: string | undefined;
  OKIDOKI_SLACK_THREAD_TS: string | undefined;
  ANTHROPIC_API_KEY: string | undefined;
  OPENAI_API_KEY: string | undefined;
  CODEX_OPENAI_BASE_URL: string | undefined;
  CODEX_OPENAI_MODELS_URL: string | undefined;
  CODEX_OPENAI_AUTHORIZATION_HEADER: string | undefined;
  CURSOR_API_KEY: string | undefined;
  CLAUDE_CODE_USE_BEDROCK: string | undefined;
  AWS_ACCESS_KEY_ID: string | undefined;
  AWS_SECRET_ACCESS_KEY: string | undefined;
  AWS_REGION: string | undefined;
  ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: string | undefined;

  /**
   * Resolved auth method per agent, set by the monolith when it provisions
   * the workspace. Lets the engine decide whether a workspace-level
   * ANTHROPIC_API_KEY / OPENAI_API_KEY env var should be honored or filtered
   * out so it does not silently override OAuth/Bedrock auth.
   */
  OKIDOKI_CLAUDE_AUTH_METHOD: EngineAuthMethod | undefined;
  OKIDOKI_CODEX_AUTH_METHOD: EngineAuthMethod | undefined;
  OKIDOKI_MUSE_AUTH_METHOD: EngineAuthMethod | undefined;
  OKIDOKI_AGENT_CREDENTIALS: AgentCredentialSnapshots;

  /**
   * Optional system prompt configured on the environment. Concatenated into
   * the agent's combined instructions when present.
   */
  OKIDOKI_ENV_SYSTEM_PROMPT: string | undefined;

  OKIDOKI_ENV_START_HOOK: string | undefined;
  OKIDOKI_REPOSITORY_HOOKS_DISABLED: boolean;
  OKIDOKI_ENV_DEVICES: ProvisionedDevice[];
  TS_AUTHKEY: string | undefined;
  OKIDOKI_DISABLE_AUTO_START_HOOKS: boolean;
  OKIDOKI_SCOUT: boolean;
  /** Overrides the live agent process cap, which otherwise follows sandbox memory. */
  OKIDOKI_MAX_LIVE_AGENT_PROCESSES: number | undefined;
}

/**
 * Reads and trims an optional environment variable.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readSandboxImageVersion(): string {
  const environmentVersion = readEnv('OKIDOKI_SANDBOX_IMAGE_VERSION');
  if (environmentVersion) return environmentVersion;
  try {
    return readFileSync(SANDBOX_IMAGE_VERSION_FILE, 'utf8').trim() || 'development';
  } catch {
    return 'development';
  }
}

/**
 * Parses the engine port from environment.
 */
function parsePort(value: string | undefined): number {
  if (!value) {
    return ENGINE_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid engine environment: OKIDOKI_ENGINE_PORT must be a positive integer');
  }

  return parsed;
}

/**
 * Ensures a required environment value is present.
 */
function requireDefined<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Invalid engine environment: ${name} is required`);
  }
  return value;
}

/**
 * Validates a required URL environment value.
 */
function requireValidURL(value: string, name: string): string {
  try {
    new URL(value);
    return value;
  } catch {
    throw new Error(`Invalid engine environment: ${name} must be a valid URL`);
  }
}

function parseClaudeAuthMethod(value: string | undefined): EngineAuthMethod | undefined {
  if (value === 'ollama' || value === 'oauth' || value === 'api_key' || value === 'anthropic-compatible' || value === 'bedrock' || value === 'foundry') {
    return value;
  }
  return undefined;
}

function parseCodexAuthMethod(value: string | undefined): EngineAuthMethod | undefined {
  if (value === 'ollama' || value === 'oauth' || value === 'api_key' || value === 'openai-compatible' || value === 'foundry') {
    return value;
  }
  return undefined;
}

function parseMuseAuthMethod(value: string | undefined): EngineAuthMethod | undefined {
  return value === 'oauth' || value === 'api_key' ? value : undefined;
}

function parseDevices(value: string | undefined): ProvisionedDevice[] {
  if (!value) return [];
  try {
    const parsed = provisionedDeviceSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseAgentCredentialSnapshots(value: string | undefined): AgentCredentialSnapshots {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    const snapshots: AgentCredentialSnapshots = {};
    for (const [provider, snapshot] of Object.entries(parsed)) {
      if (!isValidAgentProvider(provider)) continue;
      const parsedSnapshot = agentCredentialSnapshotSchema.safeParse(snapshot);
      if (parsedSnapshot.success) snapshots[provider] = parsedSnapshot.data;
    }
    return snapshots;
  } catch {
    return {};
  }
}

/**
 * Loads engine boot configuration from the process environment.
 *
 * Re-parses ~/.okidoki/runtime-env.sh in JS first so the engine reads the
 * same bytes the monolith wrote rather than trusting whatever shell sourced
 * the file at process spawn time.
 */
export function loadEngineEnv(runtimeEnvFile?: RuntimeEnvFile): EngineEnv {
  loadRuntimeEnvFile(runtimeEnvFile);
  const HOME_DIR = homedir();

  const env: EngineEnv = {
    // Defined: always available
    OKIDOKI_ENGINE_SECRET: requireDefined(readEnv('OKIDOKI_ENGINE_SECRET'), 'OKIDOKI_ENGINE_SECRET'),
    OKIDOKI_ENGINE_PORT: parsePort(readEnv('OKIDOKI_ENGINE_PORT')),
    OKIDOKI_MONOLITH_URL: readEnv('OKIDOKI_MONOLITH_URL') ?? 'http://127.0.0.1:9',
    HOME_DIR,
    WORKSPACE_ROOT: readEnv('OKIDOKI_WORKSPACE_ROOT') ?? join(HOME_DIR, 'workspaces'),
    OKIDOKI_LOCAL: readEnv('OKIDOKI_LOCAL') === '1',
    OKIDOKI_SANDBOX_IMAGE_VERSION: readSandboxImageVersion(),

    // Runtime: may not be set during warming
    OKIDOKI_WORKSPACE_ID: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.workspaceId),
    OKIDOKI_LINEAR_SESSION_ID: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.linearSessionId),
    OKIDOKI_LINEAR_ACCESS_TOKEN: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.linearAccessToken),
    OKIDOKI_SLACK_BOT_TOKEN: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.slackBotToken),
    OKIDOKI_LINEAR_ACCESS_CONFIGURED: readEnv('OKIDOKI_LINEAR_ACCESS_CONFIGURED') === 'true',
    OKIDOKI_SLACK_ACCESS_CONFIGURED: readEnv('OKIDOKI_SLACK_ACCESS_CONFIGURED') === 'true',
    OKIDOKI_SLACK_CHANNEL_ID: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.slackChannelId),
    OKIDOKI_SLACK_THREAD_TS: readOkidokiRuntimeEnv(readEnv, OKIDOKI_RUNTIME_ENV_ALIASES.slackThreadTs),
    ANTHROPIC_API_KEY: readEnv('ANTHROPIC_API_KEY'),
    OPENAI_API_KEY: readEnv('OPENAI_API_KEY'),
    CODEX_OPENAI_BASE_URL: readEnv('CODEX_OPENAI_BASE_URL'),
    CODEX_OPENAI_MODELS_URL: readEnv('CODEX_OPENAI_MODELS_URL'),
    CODEX_OPENAI_AUTHORIZATION_HEADER: readEnv('CODEX_OPENAI_AUTHORIZATION_HEADER'),
    CURSOR_API_KEY: readEnv('CURSOR_API_KEY'),
    CLAUDE_CODE_USE_BEDROCK: readEnv('CLAUDE_CODE_USE_BEDROCK'),
    AWS_ACCESS_KEY_ID: readEnv('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: readEnv('AWS_SECRET_ACCESS_KEY'),
    AWS_REGION: readEnv('AWS_REGION'),
    ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: readEnv('ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION'),
    OKIDOKI_CLAUDE_AUTH_METHOD: parseClaudeAuthMethod(readEnv('OKIDOKI_CLAUDE_AUTH_METHOD')),
    OKIDOKI_CODEX_AUTH_METHOD: parseCodexAuthMethod(readEnv('OKIDOKI_CODEX_AUTH_METHOD')),
    OKIDOKI_MUSE_AUTH_METHOD: parseMuseAuthMethod(readEnv('OKIDOKI_MUSE_AUTH_METHOD')),
    OKIDOKI_AGENT_CREDENTIALS: parseAgentCredentialSnapshots(readEnv('OKIDOKI_AGENT_CREDENTIALS')),
    OKIDOKI_ENV_SYSTEM_PROMPT: readEnv('OKIDOKI_ENV_SYSTEM_PROMPT'),
    OKIDOKI_ENV_START_HOOK: readEnv('OKIDOKI_ENV_START_HOOK'),
    OKIDOKI_REPOSITORY_HOOKS_DISABLED: readEnv('OKIDOKI_REPOSITORY_HOOKS_DISABLED') === '1',
    OKIDOKI_ENV_DEVICES: parseDevices(readEnv('OKIDOKI_ENV_DEVICES')),
    TS_AUTHKEY: readEnv('TS_AUTHKEY'),
    OKIDOKI_DISABLE_AUTO_START_HOOKS: readEnv('OKIDOKI_DISABLE_AUTO_START_HOOKS')?.toLowerCase() === 'true',
    OKIDOKI_SCOUT: readEnv('OKIDOKI_SCOUT') === 'true',
    OKIDOKI_MAX_LIVE_AGENT_PROCESSES: Number(readEnv('OKIDOKI_MAX_LIVE_AGENT_PROCESSES')) || undefined,
  };
  // Agents and terminals inherit this environment; they use the key files in ~/.ssh, and an `env` dump must not print the keys.
  delete process.env.OKIDOKI_ENV_DEVICES;

  return env;
}

export let ENGINE_ENV = loadEngineEnv();

export function reloadEngineEnv(runtimeEnvFile: RuntimeEnvFile): EngineEnv {
  ENGINE_ENV = loadEngineEnv(runtimeEnvFile);
  return ENGINE_ENV;
}

export function setLinearSessionId(linearSessionId: string): void {
  const path = join(homedir(), '.okidoki', 'runtime-env.sh');
  const persisted = parsePosixEnv(readFileSync(path, 'utf-8'));
  const key = OKIDOKI_RUNTIME_ENV_ALIASES.linearSessionId[0];
  // Persisted so the session survives an engine restart; the monolith keeps the file's other entries on wake.
  writeFileSync(path, serializePosixEnvFile(
    { ...persisted.values, [key]: linearSessionId },
    persisted.unsetKeys.filter((unset) => unset !== key),
  ));
  process.env[key] = linearSessionId;
  ENGINE_ENV.OKIDOKI_LINEAR_SESSION_ID = linearSessionId;
}

export function setAgentCredentialSnapshot(
  provider: AgentProvider,
  { type, scope, revision, account, credentialId }: { type: AuthMethod; scope?: CredentialScope }
    & Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'>,
): void {
  if (!scope) return;
  ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS = {
    ...ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS,
    [provider]: {
      method: type,
      scope,
      ...(revision ? { revision } : {}),
      ...(account ? { account } : {}),
      ...(credentialId ? { credentialId } : {}),
    },
  };
  process.env.OKIDOKI_AGENT_CREDENTIALS = JSON.stringify(ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS);
}
