import type { AgentCredentialSnapshot } from '../analytics/types';
import type { EngineAuthMethod, EngineCredentialAuthMethod } from '../engine/environment';
import type { CredentialScope } from '../credentials';
import type { EngineCredentialRefreshErrorResponse, EngineCredentialRefreshRequest, EngineOllamaRefreshResponse } from '../credential-refresh';
import type { OAuthCredentialDeleteResponse, OAuthCredentialStatusResponse } from '../types';

// Base credential types (shared between org and user scopes)
export type ClaudeCredentialStatusResponse = OAuthCredentialStatusResponse;
export type ClaudeCredentialDeleteResponse = OAuthCredentialDeleteResponse;

// Type aliases for user-scoped credentials (same structure as org)
export type ClaudeUserCredentialStatusResponse = ClaudeCredentialStatusResponse;
export type ClaudeUserCredentialDeleteResponse = ClaudeCredentialDeleteResponse;

export type EngineClaudeRefreshRequest = EngineCredentialRefreshRequest<
  Extract<EngineCredentialAuthMethod, 'ollama' | 'oauth' | 'api_key' | 'anthropic-compatible' | 'bedrock' | 'foundry'>
>;

export type EngineClaudeRefreshResponse =
  (EngineOllamaRefreshResponse
  | EngineClaudeRefreshOauthResponse
  | EngineClaudeRefreshApiKeyResponse
  | EngineClaudeRefreshAnthropicCompatibleResponse
  | EngineClaudeRefreshBedrockResponse
  | EngineClaudeRefreshFoundryResponse) & Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'>;


export interface EngineClaudeRefreshOauthResponse {
  type: 'oauth';
  scope?: CredentialScope;
  accessToken: string;
  /** Absent on one-year inference tokens, which Claude Code reads from `CLAUDE_CODE_OAUTH_TOKEN`. */
  refreshToken?: string;
  expiresAt: string;
  scopes: string[];
  subscriptionType: string;
  fellBackFrom?: EngineCredentialAuthMethod;
  fellBackReason?: string;
}

export interface EngineClaudeRefreshApiKeyResponse {
  type: 'api_key';
  scope?: CredentialScope;
  apiKey: string;
  fellBackFrom?: EngineCredentialAuthMethod;
  fellBackReason?: string;
}

interface EngineClaudeRefreshAnthropicCompatibleResponse {
  type: 'anthropic-compatible';
  scope?: CredentialScope;
  apiKey: string;
  baseUrl: string;
  fellBackFrom?: EngineCredentialAuthMethod;
  fellBackReason?: string;
}

export interface EngineClaudeRefreshBedrockResponse {
  type: 'bedrock';
  scope?: CredentialScope;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  smallFastModelRegion?: string | null;
  fellBackFrom?: EngineCredentialAuthMethod;
  fellBackReason?: string;
}

export interface EngineClaudeRefreshFoundryResponse {
  type: 'foundry';
  scope?: CredentialScope;
  apiKey: string;
  resource: string;
  sonnetModel?: string | null;
  haikuModel?: string | null;
  opusModel?: string | null;
  fellBackFrom?: EngineCredentialAuthMethod;
  fellBackReason?: string;
}

export type EngineClaudeRefreshErrorResponse = EngineCredentialRefreshErrorResponse<ClaudeAuthErrorCode>;

export type ClaudeAuthErrorCode =
  | 'no_credentials'
  | 'oauth_disconnected'
  | 'internal';

export const CLAUDE_AUTH_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'OKIDOKI_CLAUDE_AUTH_METHOD',
] as const;

export interface ClaudeAuthEnvShape {
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  CLAUDE_CODE_USE_BEDROCK?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION?: string;
  CLAUDE_CODE_USE_FOUNDRY?: string;
  ANTHROPIC_FOUNDRY_API_KEY?: string;
  ANTHROPIC_FOUNDRY_RESOURCE?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  OKIDOKI_CLAUDE_AUTH_METHOD?: EngineAuthMethod;
}

export function claudeAuthEnvFromResponse(
  response: EngineClaudeRefreshResponse,
): ClaudeAuthEnvShape {
  switch (response.type) {
    case 'ollama':
    case 'anthropic-compatible':
      return {
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: response.apiKey,
        ANTHROPIC_BASE_URL: response.baseUrl,
        OKIDOKI_CLAUDE_AUTH_METHOD: response.type,
      };
    case 'oauth':
      return response.refreshToken
        ? { OKIDOKI_CLAUDE_AUTH_METHOD: 'oauth' }
        : { CLAUDE_CODE_OAUTH_TOKEN: response.accessToken, OKIDOKI_CLAUDE_AUTH_METHOD: 'oauth' };
    case 'api_key':
      return { ANTHROPIC_API_KEY: response.apiKey, OKIDOKI_CLAUDE_AUTH_METHOD: 'api_key' };
    case 'bedrock':
      return {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_ACCESS_KEY_ID: response.awsAccessKeyId,
        AWS_SECRET_ACCESS_KEY: response.awsSecretAccessKey,
        AWS_REGION: response.awsRegion,
        ...(response.smallFastModelRegion
          ? { ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: response.smallFastModelRegion }
          : {}),
        OKIDOKI_CLAUDE_AUTH_METHOD: 'bedrock',
      };
    case 'foundry':
      return {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_API_KEY: response.apiKey,
        ANTHROPIC_FOUNDRY_RESOURCE: response.resource,
        ...(response.sonnetModel ? { ANTHROPIC_DEFAULT_SONNET_MODEL: response.sonnetModel } : {}),
        ...(response.haikuModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: response.haikuModel } : {}),
        ...(response.opusModel ? { ANTHROPIC_DEFAULT_OPUS_MODEL: response.opusModel } : {}),
        OKIDOKI_CLAUDE_AUTH_METHOD: 'foundry',
      };
  }
}

export const CLAUDE_AUTH_ENV_KEYS_BY_METHOD = {
  none: [],
  oauth: ['CLAUDE_CODE_OAUTH_TOKEN', 'OKIDOKI_CLAUDE_AUTH_METHOD'],
  api_key: ['ANTHROPIC_API_KEY', 'OKIDOKI_CLAUDE_AUTH_METHOD'],
  'openai-compatible': [],
  ollama: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OKIDOKI_CLAUDE_AUTH_METHOD'],
  'anthropic-compatible': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OKIDOKI_CLAUDE_AUTH_METHOD'],
  bedrock: [
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
    'OKIDOKI_CLAUDE_AUTH_METHOD',
  ],
  foundry: [
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'OKIDOKI_CLAUDE_AUTH_METHOD',
  ],
} satisfies Record<EngineAuthMethod, readonly (typeof CLAUDE_AUTH_ENV_KEYS)[number][]>;
