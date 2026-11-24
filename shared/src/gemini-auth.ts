import { z } from 'zod';
import type { AgentCredentialSnapshot } from './analytics/types';
import type { EngineCredentialRefreshRequest } from './credential-refresh';
import type { AgentCredentialMethod, CredentialScope, GeminiCredentials } from './credentials';

/** The Antigravity CLI's own Google sign-in (`agy acp --login`), whose callback page shows a code to paste back. */
export const GEMINI_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const GEMINI_OAUTH_REDIRECT_URI = 'https://antigravity.google/oauth-callback';

export function buildGeminiAuthorizationUrl(codeChallenge: string, state: string): string {
  return `https://accounts.google.com/o/oauth2/auth?${new URLSearchParams({
    access_type: 'offline',
    client_id: GEMINI_OAUTH_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
      'https://www.googleapis.com/auth/aicode',
      'openid',
    ].join(' '),
    state,
  })}`;
}

export function parseGeminiAuthorizationCode(input: string): string {
  const trimmed = input.trim();
  try {
    return new URL(trimmed).searchParams.get('code') ?? '';
  } catch {
    return trimmed;
  }
}

// An expired access token makes the CLI refresh it with the refresh token, which Google never rotates.
export function serializeGeminiAuthFile(credentials: Pick<GeminiCredentials, 'refreshToken' | 'user'>): string {
  return JSON.stringify({
    token: {
      access_token: '',
      token_type: 'Bearer',
      refresh_token: credentials.refreshToken,
      expiry: '1970-01-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: credentials.user.email,
  });
}

export type EngineGeminiRefreshRequest = EngineCredentialRefreshRequest<AgentCredentialMethod<'gemini'>>;

export interface EngineGeminiRefreshResponse extends Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'>, Pick<GeminiCredentials, 'refreshToken' | 'user'> {
  type: AgentCredentialMethod<'gemini'>;
  scope?: CredentialScope;
  fellBackFrom?: AgentCredentialMethod<'gemini'>;
  fellBackReason?: string;
}

export const geminiCredentialRequestSchema = z.object({ code: z.string(), code_verifier: z.string() });
export type GeminiCredentialRequest = z.infer<typeof geminiCredentialRequestSchema>;
