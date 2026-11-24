import type { CredentialPoolAccount } from '../credential-pool';

export const CREDENTIAL_SCOPE = {
  USER: 'user',
  ORG: 'org',
} as const;

export type CredentialScope = (typeof CREDENTIAL_SCOPE)[keyof typeof CREDENTIAL_SCOPE];

export const CREDENTIAL_SCOPES: readonly CredentialScope[] = Object.values(CREDENTIAL_SCOPE);

export const buildScopedCredentialPath = (service: string, scope: CredentialScope) => `/v1/${service}${scope === 'user' ? '/user' : ''}/credentials`;

/** A member who connected their own account is telling us to bill them, not the org. */
export const CREDENTIAL_SCOPE_PRIORITY = [CREDENTIAL_SCOPE.USER, CREDENTIAL_SCOPE.ORG] as const;

/**
 * `rejected` means the provider refused the credential, so an OAuth credential
 * is force-rotated before being skipped. `exhausted` means it authenticated but
 * has no quota left — rotating would hand back the same empty account, so the
 * method is skipped outright.
 */
export type CredentialFailureKind = 'rejected' | 'exhausted';

export interface ClaudeProfile {
  email?: string;
  planType?: string;
}

export interface ClaudeCredentials {
  accessToken: string;
  /** Absent on one-year inference tokens, which cannot be refreshed. */
  refreshToken?: string;
  tokenType: string;
  scope?: string | null;
  expiresAt: string;
  refreshTokenExpiresAt?: string | null;
  fetchedAt?: string;
  user?: ClaudeProfile;
}

export interface CodexUserInfo {
  email: string;
  emailVerified: boolean;
  chatgptUserId: string;
  chatgptAccountId: string;
  planType: string;
  subscriptionActiveStart?: string | null;
  subscriptionActiveUntil?: string | null;
  organizations: Array<{
    id: string;
    title: string;
    role: string;
    isDefault: boolean;
  }>;
}

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  tokenType: string;
  scope: string | null;
  expiresAt: string;
  refreshTokenExpiresAt: string;
  fetchedAt: string;
  user?: CodexUserInfo;
}

export interface MuseCredentials {
  accessToken: string;
  fetchedAt: string;
}

export interface GeminiCredentials {
  refreshToken: string;
  user: { email: string };
  fetchedAt: string;
}

export interface CodexIdTokenClaims {
  email: string;
  email_verified: boolean;
  exp: number;
  'https://api.openai.com/auth': {
    chatgpt_user_id: string;
    chatgpt_account_id: string;
    chatgpt_plan_type: string;
    chatgpt_subscription_active_start?: string | null;
    chatgpt_subscription_active_until?: string | null;
    organizations: Array<{
      id: string;
      title: string;
      role: string;
      is_default: boolean;
    }>;
  };
}

export interface BedrockCredentials {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  smallFastModelRegion?: string | null;
  fetchedAt?: string;
}

export interface ApiKeyCredentials {
  apiKey: string;
  fetchedAt?: string;
}

export interface ClaudeFoundryCredentials extends ApiKeyCredentials {
  resource: string;
  sonnetModel?: string | null;
  haikuModel?: string | null;
  opusModel?: string | null;
}

export interface CodexFoundryCredentials extends ApiKeyCredentials {
  baseUrl: string;
  model: string;
}

export interface ApiKeyCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  apiKey?: string;
  lastFetchedAt?: string;
  accounts?: CredentialPoolAccount[];
}

export interface ApiKeyCredentialUploadResponse {
  success: boolean;
  credentialId?: string;
  error?: string;
}

export interface ApiKeyCredentialDeleteResponse {
  success: boolean;
}

export type AnthropicApiKeyCredentials = ApiKeyCredentials;
export interface AnthropicCompatibleCredentials extends ApiKeyCredentials {
  baseUrl: string;
}
export type OpenAIApiKeyCredentials = ApiKeyCredentials;
export interface OpenAICompatibleCredentials {
  apiKey?: string;
  baseUrl: string;
  modelsUrl?: string;
  authorizationHeader?: string;
  fetchedAt?: string;
}
export type OpenAICompatibleCredentialValues = Required<Pick<
  OpenAICompatibleCredentials,
  'apiKey' | 'baseUrl' | 'modelsUrl' | 'authorizationHeader'
>>;
export type CursorApiKeyCredentials = ApiKeyCredentials;
export type OpenRouterApiKeyCredentials = ApiKeyCredentials;
export type AsterApiKeyCredentials = ApiKeyCredentials;

export type OpenCodeGoCredentials = ApiKeyCredentials;
