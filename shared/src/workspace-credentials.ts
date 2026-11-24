import { z } from 'zod';
import { agentCredentialSnapshotSchema } from './analytics/types';
import { VALID_AGENT_PROVIDERS, type AgentProvider } from './agent';
import { agentCredentialMethods } from './credentials/agents';
import type { EngineClaudeRefreshResponse } from './routes/claude';
import type { EngineCodexRefreshResponse } from './routes/codex';

export const WORKSPACE_CREDENTIAL_PROVIDERS = ['claude', 'codex'] as const;
export const workspaceCredentialProviderSchema = z.enum(WORKSPACE_CREDENTIAL_PROVIDERS);
export type WorkspaceCredentialProvider = z.infer<typeof workspaceCredentialProviderSchema>;
export const workspaceCredentialSelectionSchema = agentCredentialSnapshotSchema.omit({ revision: true, account: true, credentialId: true });
export type WorkspaceCredentialSelection = z.infer<typeof workspaceCredentialSelectionSchema>;
export type WorkspaceCredentialSelections = Partial<Record<AgentProvider, WorkspaceCredentialSelection>>;

export const createWorkspaceCredentialSchema = workspaceCredentialSelectionSchema.extend({
  provider: z.enum(VALID_AGENT_PROVIDERS),
}).refine(({ provider, method }) => agentCredentialMethods(provider).includes(method), {
  message: 'This inference provider is not supported by this agent',
});
export type CreateWorkspaceCredentialRequest = z.infer<typeof createWorkspaceCredentialSchema>;

export const switchWorkspaceCredentialSchema = workspaceCredentialSelectionSchema.extend({
  provider: workspaceCredentialProviderSchema,
}).refine(({ provider, method }) => agentCredentialMethods(provider).includes(method), {
  message: 'This authentication method is not supported by this agent',
});
export type SwitchWorkspaceCredentialRequest = z.infer<typeof switchWorkspaceCredentialSchema>;

export type EngineSwitchCredentialRequest =
  | { provider: 'claude'; credential: EngineClaudeRefreshResponse }
  | { provider: 'codex'; credential: EngineCodexRefreshResponse };

export interface WorkspaceCredentialsResponse {
  credentials: WorkspaceCredentialSelection[];
  selected: WorkspaceCredentialSelection | null;
  personalCredentialOwner: 'you' | 'workspace_owner';
}
