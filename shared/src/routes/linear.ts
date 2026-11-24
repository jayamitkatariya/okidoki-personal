import { z } from 'zod';
import { isValidAgentProvider, type AgentProvider } from '../agent';
import type {
  ExternalAccountConnectionDeleteResponse,
  ExternalAccountConnectionStatusResponse,
} from './external-accounts';

export interface LinearStartOAuthResponse {
  authorizationUrl: string;
}

export interface LinearUserConnectionStatusResponse
  extends ExternalAccountConnectionStatusResponse {
  workspaceName?: string;
}

export type LinearUserStartOAuthResponse = LinearStartOAuthResponse;

export type LinearUserConnectionDeleteResponse = ExternalAccountConnectionDeleteResponse;

export interface LinearCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  workspaceName?: string;
  workspaceUrlKey?: string;
  lastFetchedAt?: string;
}

export interface LinearCredentialDeleteResponse {
  success: boolean;
}

export interface EngineLinearRefreshTokenResponse {
  token: string;
  expiresAt: string;
  workspace?: {
    id: string;
    name: string;
    urlKey: string;
  };
}

export interface EngineLinearGraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

export interface LinearSessionMetadata {
  /** Set when Scout started the session. `mothership` here is Scout's name from before it was renamed, not a Manager. */
  via_mothership?: boolean;
  /** Set when an existing workspace attached itself to the issue, so the issue does not own the workspace. */
  attached?: boolean;
  routing_chat_id?: string;
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  issue_description: string;
  issue_url: string;
  comment_id: string;
  comment_body: string;
  /** Linear user who triggered the agent session (the @mentioner or assigner). */
  triggered_by_id?: string;
  triggered_by_name?: string;
  triggered_by_email?: string;
  linear_workspace_id?: string;
  /** @deprecated Pre-rename name for triggered_by_*. Kept on the type so
   *  in-flight `linear_sessions` rows written before the rename still
   *  deserialize cleanly. New writes use `triggered_by_*`. */
  creator_id?: string;
  creator_name?: string;
  creator_email?: string;
  assignee_id?: string;
  assignee_name?: string;
  assignee_email?: string;
  issue_state?: string;
  parent_issue?: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
  };
  workspace?: {
    id: string;
    coding_agent: AgentProvider;
    task_description: string;
    created_at: string;
  };
}

export const linearSessionMetadataSchema: z.ZodType<LinearSessionMetadata> = z.object({
  via_mothership: z.boolean().optional(),
  attached: z.boolean().optional(),
  routing_chat_id: z.string().optional(),
  issue_id: z.string(),
  issue_identifier: z.string(),
  issue_title: z.string(),
  issue_description: z.string(),
  issue_url: z.string(),
  comment_id: z.string(),
  comment_body: z.string(),
  triggered_by_id: z.string().optional(),
  triggered_by_name: z.string().optional(),
  triggered_by_email: z.string().optional(),
  linear_workspace_id: z.string().optional(),
  creator_id: z.string().optional(),
  creator_name: z.string().optional(),
  creator_email: z.string().optional(),
  assignee_id: z.string().optional(),
  assignee_name: z.string().optional(),
  assignee_email: z.string().optional(),
  issue_state: z.string().optional(),
  parent_issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    description: z.string().nullable(),
  }).optional(),
  workspace: z.object({
    id: z.string(),
    coding_agent: z.custom<AgentProvider>((value) => typeof value === 'string' && isValidAgentProvider(value)),
    task_description: z.string(),
    created_at: z.string(),
  }).optional(),
});

export interface LinearSessionRecord {
  id: string;
  linear_session_id: string;
  organization_id: string;
  status: string;
  metadata: LinearSessionMetadata;
  soft_delete: boolean;
  created_at: string;
}

// Okidoki concepts that map to Linear workflow states per team. Kept in sync
// with the CHECK constraint on public.linear_team_state_overrides.state_kind.
export type LinearStateKind = 'in_progress' | 'in_review' | 'blocked';

export const LINEAR_STATE_KINDS: readonly LinearStateKind[] = [
  'in_progress',
  'in_review',
  'blocked',
] as const;

export const LINEAR_WORKFLOW_STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'] as const;
export type LinearWorkflowStateType = (typeof LINEAR_WORKFLOW_STATE_TYPES)[number];

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: LinearWorkflowStateType;
  /** Hex color string returned by Linear (e.g. "#4cb782"). */
  color: string;
  /**
   * Linear's per-team ordering value. Smaller = appears earlier in the
   * workflow. Used to sort states within a type group.
   */
  position: number;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearTeamWithMapping extends LinearTeam {
  states: LinearWorkflowState[];
  overrides: Partial<Record<LinearStateKind, string>>;
}

export interface GetLinearTeamsResponse {
  teams: LinearTeamWithMapping[];
}

export type PutLinearTeamStateMappingRequest = Partial<
  Record<LinearStateKind, string | null>
>;

export interface PutLinearTeamStateMappingResponse {
  success: boolean;
}
