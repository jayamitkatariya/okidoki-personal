import { z } from 'zod';

export const MAX_CREDENTIAL_POOL_ACCOUNTS = 10;

export interface CredentialPoolAccount {
  credentialId: string;
  email?: string;
  planType?: string;
  /** Pools of API keys have no login to show, so each key is told apart by its last characters. */
  maskedApiKey?: string;
  /** Set for logins that cannot be refreshed: the user has to sign in again before then. */
  expiresAt?: string;
  /** Okidoki skips the account until then because it last hit a usage limit. */
  exhaustedUntil: string | null;
  /** The provider rejected the saved login, so workspaces cannot use the account until it is reconnected. */
  reconnectRequired: boolean;
}

export const reorderCredentialPoolSchema = z.object({
  credential_ids: z.array(z.string().uuid()).min(1).max(MAX_CREDENTIAL_POOL_ACCOUNTS),
});
