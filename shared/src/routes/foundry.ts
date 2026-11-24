import type { ApiKeyCredentialStatusResponse } from '../credentials/types';

export interface FoundryCredentialStatusResponse extends ApiKeyCredentialStatusResponse {
  resource?: string;
  baseUrl?: string;
  model?: string;
  sonnetModel?: string | null;
  haikuModel?: string | null;
  opusModel?: string | null;
}

export function maskFoundryApiKey(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}
