import type { AgentCredentialSnapshot } from './analytics/types';
import type { EngineCredentialRefreshRequest } from './credential-refresh';
import type { AgentCredentialMethod, CredentialScope } from './credentials';

export const MUSE_AUTH_ENV_KEYS = ['OKIDOKI_MUSE_AUTH_METHOD'];

export function serializeMuseAuthFile(credentials: { accessToken: string }): string {
  return JSON.stringify({
    schema_version: 1,
    providers: {
      meta: {
        api_key: credentials.accessToken,
      },
    },
  }, null, 2);
}

export type EngineMuseRefreshRequest = EngineCredentialRefreshRequest<AgentCredentialMethod<'muse'>>;

export interface EngineMuseRefreshResponse extends Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'> {
  type: AgentCredentialMethod<'muse'>;
  scope?: CredentialScope;
  accessToken: string;
  fellBackFrom?: AgentCredentialMethod<'muse'>;
  fellBackReason?: string;
}
