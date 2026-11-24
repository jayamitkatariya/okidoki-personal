import type { AgentCredentialSnapshot } from '../analytics/types';
import { ollamaAuthEnv } from '../credentials/ollama';
import type { EngineAuthMethod, EngineCredentialAuthMethod } from '../engine/environment';
import type { CredentialScope } from '../credentials';
import type { EngineCredentialRefreshErrorResponse, EngineCredentialRefreshRequest, EngineOllamaRefreshResponse } from '../credential-refresh';
import type { OAuthCredentialDeleteResponse, OAuthCredentialStatusResponse } from '../types';

// Base credential types (shared between org and user scopes)
export type CodexCredentialStatusResponse = OAuthCredentialStatusResponse;
export type CodexCredentialDeleteResponse = OAuthCredentialDeleteResponse;

// Type aliases for user-scoped credentials (same structure as org)
export type CodexUserCredentialStatusResponse = CodexCredentialStatusResponse;
export type CodexUserCredentialDeleteResponse = CodexCredentialDeleteResponse;

export interface EngineCodexRefreshRequest extends EngineCredentialRefreshRequest<
  Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'openai-compatible' | 'foundry'>
> {
  supportsOpenAICompatibleAuth?: boolean;
}

export type EngineCodexRefreshResponse =
  (EngineOllamaRefreshResponse
  | EngineCodexRefreshOauthResponse
  | EngineCodexRefreshApiKeyResponse
  | EngineCodexRefreshOpenAICompatibleResponse
  | EngineCodexRefreshFoundryResponse) & Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'>;


export interface EngineCodexRefreshOauthResponse {
  type: 'oauth';
  scope?: CredentialScope;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: string;
  fellBackFrom?: Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'openai-compatible' | 'foundry'>;
  fellBackReason?: string;
}

export interface EngineCodexRefreshApiKeyResponse {
  type: 'api_key';
  scope?: CredentialScope;
  apiKey?: string;
  baseUrl?: string;
  modelsUrl?: string;
  authorizationHeader?: string;
  fellBackFrom?: Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'openai-compatible' | 'foundry'>;
  fellBackReason?: string;
}

export interface EngineCodexRefreshOpenAICompatibleResponse {
  type: 'openai-compatible';
  scope?: CredentialScope;
  apiKey?: string;
  baseUrl: string;
  modelsUrl?: string;
  authorizationHeader?: string;
  fellBackFrom?: Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'openai-compatible' | 'foundry'>;
  fellBackReason?: string;
}

export interface EngineCodexRefreshFoundryResponse {
  type: 'foundry';
  scope?: CredentialScope;
  apiKey: string;
  baseUrl: string;
  model: string;
  fellBackFrom?: Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'openai-compatible' | 'foundry'>;
  fellBackReason?: string;
}

export type EngineCodexRefreshErrorResponse = EngineCredentialRefreshErrorResponse<CodexAuthErrorCode>;

export type CodexAuthErrorCode =
  | 'no_credentials'
  | 'oauth_disconnected'
  | 'internal';

export const CODEX_AUTH_ENV_KEYS = [
  'OKIDOKI_CODEX_OLLAMA_API_KEY',
  'OKIDOKI_CODEX_OLLAMA_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_OPENAI_BASE_URL',
  'CODEX_OPENAI_MODELS_URL',
  'CODEX_OPENAI_AUTHORIZATION_HEADER',
  'AZURE_OPENAI_API_KEY',
  'CODEX_FOUNDRY_BASE_URL',
  'CODEX_FOUNDRY_MODEL',
  'OKIDOKI_CODEX_AUTH_METHOD',
] as const;

export interface CodexAuthEnvShape {
  OKIDOKI_CODEX_OLLAMA_API_KEY?: string;
  OKIDOKI_CODEX_OLLAMA_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  CODEX_OPENAI_BASE_URL?: string;
  CODEX_OPENAI_MODELS_URL?: string;
  CODEX_OPENAI_AUTHORIZATION_HEADER?: string;
  AZURE_OPENAI_API_KEY?: string;
  CODEX_FOUNDRY_BASE_URL?: string;
  CODEX_FOUNDRY_MODEL?: string;
  OKIDOKI_CODEX_AUTH_METHOD?: EngineAuthMethod;
}

export function codexOpenAICompatibleAuthEnv(response: {
  apiKey?: string;
  baseUrl?: string;
  modelsUrl?: string;
  authorizationHeader?: string;
}): CodexAuthEnvShape & Record<string, string> {
  return {
    ...(response.apiKey && !response.authorizationHeader ? { OPENAI_API_KEY: response.apiKey } : {}),
    ...(response.baseUrl ? { CODEX_OPENAI_BASE_URL: response.baseUrl } : {}),
    ...(response.modelsUrl ? { CODEX_OPENAI_MODELS_URL: response.modelsUrl } : {}),
    ...(response.authorizationHeader
      ? { CODEX_OPENAI_AUTHORIZATION_HEADER: response.authorizationHeader }
      : {}),
    OKIDOKI_CODEX_AUTH_METHOD: 'openai-compatible',
  };
}

/**
 * `~/.codex/auth.json`, which signs the `codex` CLI in. A ChatGPT login is written in Codex's
 * externally managed mode with no refresh token, so the CLI never refreshes it: refresh tokens
 * rotate on use, and one on disk would log every other workspace on that account out.
 */
export function codexCliAuthFile(login: { accessToken: string; accountId: string } | { apiKey: string }): string {
  return JSON.stringify('apiKey' in login
    ? { auth_mode: 'apikey', OPENAI_API_KEY: login.apiKey }
    : {
      auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null,
      // Codex reads the account and plan from the access token in this mode.
      tokens: { id_token: login.accessToken, access_token: login.accessToken, refresh_token: '', account_id: login.accountId },
      last_refresh: new Date().toISOString(),
    }, null, 2);
}

export function codexAuthEnvFromResponse(
  response: EngineCodexRefreshResponse,
): CodexAuthEnvShape {
  switch (response.type) {
    case 'ollama':
      return {
        ...codexOpenAICompatibleAuthEnv({ apiKey: response.apiKey, baseUrl: `${response.baseUrl}/v1` }),
        ...ollamaAuthEnv('codex', response),
        OKIDOKI_CODEX_AUTH_METHOD: 'ollama',
      };
    case 'oauth':
      return { OKIDOKI_CODEX_AUTH_METHOD: 'oauth' };
    case 'api_key':
      if (response.baseUrl) {
        return codexOpenAICompatibleAuthEnv(response);
      }
      return {
        ...(response.apiKey ? { OPENAI_API_KEY: response.apiKey } : {}),
        OKIDOKI_CODEX_AUTH_METHOD: 'api_key',
      };
    case 'openai-compatible':
      return codexOpenAICompatibleAuthEnv(response);
    case 'foundry':
      return {
        AZURE_OPENAI_API_KEY: response.apiKey,
        CODEX_FOUNDRY_BASE_URL: response.baseUrl,
        CODEX_FOUNDRY_MODEL: response.model,
        OKIDOKI_CODEX_AUTH_METHOD: 'foundry',
      };
  }
}

export const CODEX_AUTH_ENV_KEYS_BY_METHOD = {
  none: [],
  oauth: ['OKIDOKI_CODEX_AUTH_METHOD'],
  api_key: [
    'OPENAI_API_KEY',
    'OKIDOKI_CODEX_AUTH_METHOD',
  ],
  'openai-compatible': [
    'OPENAI_API_KEY',
    'CODEX_OPENAI_BASE_URL',
    'CODEX_OPENAI_MODELS_URL',
    'CODEX_OPENAI_AUTHORIZATION_HEADER',
    'OKIDOKI_CODEX_AUTH_METHOD',
  ],
  ollama: ['OPENAI_API_KEY', 'CODEX_OPENAI_BASE_URL', 'OKIDOKI_CODEX_AUTH_METHOD', 'OKIDOKI_CODEX_OLLAMA_API_KEY', 'OKIDOKI_CODEX_OLLAMA_BASE_URL'],
  'anthropic-compatible': [],
  bedrock: [],
  foundry: ['AZURE_OPENAI_API_KEY', 'CODEX_FOUNDRY_BASE_URL', 'CODEX_FOUNDRY_MODEL', 'OKIDOKI_CODEX_AUTH_METHOD'],
} satisfies Record<EngineAuthMethod, readonly (typeof CODEX_AUTH_ENV_KEYS)[number][]>;
