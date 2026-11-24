import type { AccessScope } from '../access';
import type { CreditSummary } from './billing';
import type { PlanType } from '../pricing';
import type { WorkspaceSizeOption } from '../sandbox';
import type { EnvironmentRecord } from './environment';

export type OrganizationMemberRole = 'admin' | 'member';

export const INTERNAL_EMAIL_DOMAIN = '@okidoki.dev';

export function isInternalEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(INTERNAL_EMAIL_DOMAIN);
}

export function isOrganizationMemberRole(value: unknown): value is OrganizationMemberRole {
  return value === 'admin' || value === 'member';
}

export interface GetOrganizationSubscriptionResponse {
  plan: PlanType;
  subscriptionStatus: string | null;
  credit: CreditSummary | null;
  /** When a running YC deal ends. A subscribed org's deal adds its credit to each period until then. */
  ycDealEndsAt: string | null;
  subscribed: boolean;
}

export interface GetOrganizationMembershipResponse {
  role: string;
  userId: string;
  organizationId: string;
  /** Organization-wide scopes in effect for this member; admins hold every scope. */
  scopes: AccessScope[];
}

// Invite endpoints
export interface CreateInviteRequest {
  email: string;
  role?: OrganizationMemberRole;
}

export interface CreateInviteResponse {
  invite: {
    id: string;
    email: string;
    role: string;
    expires_at: string;
  };
  message: string;
}

export interface GetPendingInvitesResponse {
  invites: Array<{
    id: string;
    email: string;
    role: string;
    expires_at: string;
    created_at: string;
  }>;
}

export interface CancelInviteResponse {
  success: boolean;
}

export interface ResendInviteResponse {
  success: boolean;
}

// Public invite endpoints
export interface GetInviteDetailsResponse {
  invite: {
    organization_name: string;
    email: string;
    role: string;
    expires_at: string;
    invited_by_email: string;
  };
  isExpired: boolean;
  alreadyAccepted: boolean;
}

export interface AcceptInviteResponse {
  success: boolean;
  organizationId: string;
  organizationName: string;
}

// Member endpoints
export interface GetOrganizationMembersResponse {
  members: Array<{
    id: string;
    user_id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    role: string;
    role_ids: string[];
    created_at: string | null;
  }>;
}

export interface OrganizationRoleRecord {
  id: string;
  name: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface ListOrganizationRolesResponse {
  roles: OrganizationRoleRecord[];
}

export interface CreateOrganizationRoleRequest {
  name: string;
}

export interface CreateOrganizationRoleResponse {
  role: OrganizationRoleRecord;
}

export interface DeleteOrganizationRoleResponse {
  success: boolean;
}

export interface UpdateOrganizationMemberRolesRequest {
  role_ids: string[];
}

export interface UpdateOrganizationMemberRolesResponse {
  role_ids: string[];
}

export interface RemoveMemberResponse {
  success: boolean;
}

export interface UpdateMemberRoleRequest {
  role: OrganizationMemberRole;
}

export interface UpdateMemberRoleResponse {
  success: boolean;
  role: string;
}

// Organization settings endpoints
export interface GetOrganizationDetailsResponse {
  id: string;
  name: string;
  default_workspace_size: WorkspaceSizeOption;
}

export interface UpdateOrganizationNameRequest {
  name: string;
}

export interface UpdateOrganizationNameResponse {
  success: boolean;
  name: string;
}

export interface OrganizationStaticEgress {
  ipAddress: string;
  enabled: boolean;
  destinations: string[];
  /** Set up by Okidoki on request. Only a dedicated IP can route all traffic, which is billed per GB. */
  dedicated: boolean;
  routesAllTraffic: boolean;
}

export interface GetOrganizationStaticEgressResponse {
  available: boolean;
  staticEgress: OrganizationStaticEgress | null;
}

export interface UpdateOrganizationStaticEgressRequest {
  enabled: boolean;
}

export interface UpdateOrganizationStaticEgressDestinationsRequest {
  destinations: string[];
}

export interface UpdateOrganizationStaticEgressRoutingRequest {
  routesAllTraffic: boolean;
}

export interface UpdateOrganizationStaticEgressResponse {
  available: true;
  staticEgress: OrganizationStaticEgress | null;
}

// Onboarding endpoints
export interface OnboardingSteps {
  added_repository: boolean;
  set_up_environment: boolean;
  skipped_repository: boolean;
  connected_code_editor: boolean;
  created_workspace: boolean;
  connected_integration: boolean; // Linear OR Slack
  configured_github_triggers: boolean; // okidoki.json with organizationId configured
  invited_member: boolean;
  answered_source_question: boolean;
}

export interface OnboardingState {
  completed: boolean;
  steps: OnboardingSteps;
}

export interface GetOnboardingStatusResponse {
  onboarding: OnboardingState;
}

export interface OnboardingOrganizationMatch {
  memberCount: number;
  id: string;
  name: string;
  connectedAccount: boolean;
  isMember: boolean;
  canJoin: boolean;
}

export interface GetOnboardingOrganizationsResponse {
  organizations: OnboardingOrganizationMatch[];
  membershipVerificationError: string | null;
}

export interface JoinOnboardingOrganizationResponse {
  organization: OnboardingOrganizationMatch;
}

export interface SetupOnboardingEnvironmentRequest {
  repository_ids: string[];
}

export interface SetupOnboardingEnvironmentResponse {
  environment: EnvironmentRecord;
}

export interface CompleteOnboardingResponse {
  success: boolean;
}

export const PERSISTED_ONBOARDING_STEPS = ['configured_github_triggers'] as const;
export type PersistedOnboardingStep = typeof PERSISTED_ONBOARDING_STEPS[number];

export interface MarkOnboardingStepResponse {
  success: boolean;
}

export interface GitHubAutoRespondUser {
  login: string;
  enabled: boolean;
  created_at: string;
}

export interface GitHubAutoRespondSearchUser {
  login: string;
  type: 'Bot';
  avatar_url: string;
  html_url: string;
}

export interface GetGitHubAutoRespondSearchUsersResponse {
  items: GitHubAutoRespondSearchUser[];
}

export interface OrganizationSeat {
  id: string;
  organization_id: string;
  email: string;
  first_seen_at: string;
  last_workspace_created_at: string;
}

export interface WhoamiResponse {
  organization: { id: string; name: string };
  caller: 'user' | 'organization_api_key' | 'personal_api_key' | 'workspace';
  user: { id: string; email: string | null; display_name: string } | null;
  workspace_id: string | null;
  is_admin: boolean;
}
