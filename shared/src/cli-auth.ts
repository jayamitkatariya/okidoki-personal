import type { CredentialScope } from './credentials/types';

export interface CliAuthResult {
  provider: 'claude' | 'codex' | 'gemini' | 'muse' | null;
  email: string;
  scope: CredentialScope;
  organizationId: string | null;
}
