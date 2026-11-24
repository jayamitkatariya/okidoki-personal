import { z } from 'zod';
import type { AgentCredentialSnapshot } from './analytics/types';
import type { AgentProvider } from './agent';
import { workspaceCredentialSelectionSchema, type WorkspaceCredentialSelection } from './workspace-credentials';
import { CREDENTIAL_SCOPE, type AgentCredentialMethod, type AuthMethod, type CredentialFailureKind, type CredentialScope, type OllamaCredentials, type SandboxAuth } from './credentials';

export interface EngineCredentialRefreshRequest<TMethod extends string> {
  failedMethod?: TMethod;
  failedCredential?: AgentCredentialSnapshot;
  failureReason?: string;
  failureKind?: CredentialFailureKind;
  resetsAt?: string;
  excludeCredentials?: AgentCredentialSnapshot[];
  /** The live credential on a routine refresh, kept over the rest of its account pool until it runs out. */
  currentCredential?: AgentCredentialSnapshot;
  /** Restricts resolution to one run of the fallback chain; omitted means any method. */
  allowedMethods?: AuthMethod[];
}

export const restingCredentialsSchema = z.object({
  count: z.number(),
  /** Set when every one of them is in this scope. */
  scope: z.enum(CREDENTIAL_SCOPE).optional(),
  resetsAt: z.string(),
});

/** Accounts a fallback skipped because they are still inside a usage limit, including the one that just ran out. */
export type RestingCredentials = z.infer<typeof restingCredentialsSchema>;

export interface EngineCredentialRefreshErrorResponse<TCode extends string> {
  error: string;
  code: TCode;
  /** The login that could not be refreshed, for an engine that started without any login to name. */
  credential?: WorkspaceCredentialSelection;
  resting?: RestingCredentials;
  /** The member has no working login of their own, so the engine withdraws any other it holds for this agent. */
  revoke?: AgentLoginWithdrawal;
}

const agentLoginWithdrawalSchema = z.object({
  envKeys: z.array(z.string()),
  files: z.array(z.string()),
});

/** Where an agent's login lives in the sandbox, so the engine can remove it without knowing the agent. */
export type AgentLoginWithdrawal = z.infer<typeof agentLoginWithdrawalSchema>;

export interface EngineWithdrawLoginsRequest {
  logins: Array<AgentLoginWithdrawal & { provider: AgentProvider }>;
}

export const engineCredentialRefreshFailureSchema = z.object({
  code: z.string(),
  credential: workspaceCredentialSelectionSchema.optional(),
  resting: restingCredentialsSchema.optional(),
  revoke: agentLoginWithdrawalSchema.optional(),
});

export interface EngineOllamaRefreshResponse extends OllamaCredentials {
  type: 'ollama';
  scope?: CredentialScope;
  fellBackFrom?: AuthMethod;
  fellBackReason?: string;
}

export type ApiKeyAgent = 'opencode' | 'pi';

export type EngineApiKeyRefreshRequest<TAgent extends ApiKeyAgent> = EngineCredentialRefreshRequest<AgentCredentialMethod<TAgent>>;

export interface EngineApiKeyRefreshResponse<TAgent extends ApiKeyAgent> extends Pick<AgentCredentialSnapshot, 'revision' | 'account' | 'credentialId'> {
  type: AgentCredentialMethod<TAgent>;
  scope: CredentialScope;
  auth: SandboxAuth;
}
