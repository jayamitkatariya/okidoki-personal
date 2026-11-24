import type { CredentialPoolAccount } from './credential-pool';

export interface User {
  id: string;
  email?: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  user: User;
}

export interface Organization {
  id: string;
  name: string;
  created_at: string;
  is_baa: boolean;
}

/** Bedrock keeps its own shape: its upload returns `awsRegion`, not account and plan. */
export interface CredentialUploadResponse {
  success: boolean;
  credentialId?: string;
  email?: string;
  planType?: string;
  sharedWithOrganization?: boolean;
  accountOrdinal?: number;
  accountCount?: number;
  error?: string;
}

export interface OAuthCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  email?: string;
  planType?: string;
  lastFetchedAt?: string;
  accounts?: CredentialPoolAccount[];
}

export interface OAuthCredentialDeleteResponse {
  success: boolean;
}

export interface OrganizationMembership {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
}

export interface OrganizationMemberWithEmail {
  id: string;
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}

export interface OrganizationInvite {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  token: string;
  invited_by: string;
  status: 'pending' | 'accepted' | 'expired' | 'cancelled';
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
}

export interface OrganizationInviteWithDetails extends OrganizationInvite {
  organization_name: string;
  invited_by_email: string;
}
export interface AuthenticatedContext {
  user: AuthenticatedUser;
}

export interface OrgAuthenticatedContext extends AuthenticatedContext {
  organizationId: string;
  userId: string;
  membership: OrganizationMembership;
}

// The engine's catch-all error for a send that failed for any reason other than invalid input.
export const ENGINE_SEND_MESSAGE_FAILED_ERROR = 'Failed to send message';

// A chat a delivery is still waiting to create on the workspace: it exists for its sender, but the engine does not know it yet.
export const CHAT_PENDING_CREATION_CODE = 'chat_pending_creation';

export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: string;
}

// The `code` of the 409 a send gets when its message was cancelled before it arrived: the message was not sent, and the user asked for that.
export const CHAT_MESSAGE_CANCELLED_CODE = 'message_cancelled';

// The `code` of the 409 a send gets when a Stop took its message before it ran: the message was not sent, whether or not the agent then stopped.
export const CHAT_MESSAGE_HANDED_BACK_CODE = 'message_handed_back';

// The `code` of the 409 a send gets when the server will not send this id again and cannot say whether its message ran: it was cancelled or stopped when it may already have reached the agent.
// A client stops retrying it, keeps the row with a warning, and sends it again only as a new message.
export const CHAT_MESSAGE_OUTCOME_UNKNOWN_CODE = 'message_outcome_unknown';

// Every `code` of a message that was taken back: its id is marked, and a send of it gets the same 409 for as long as the mark lives.
export const CHAT_MESSAGE_TAKEN_BACK_CODES = [CHAT_MESSAGE_CANCELLED_CODE, CHAT_MESSAGE_HANDED_BACK_CODE, CHAT_MESSAGE_OUTCOME_UNKNOWN_CODE] as const;
export type ChatMessageTakenBackCode = (typeof CHAT_MESSAGE_TAKEN_BACK_CODES)[number];

// The sentence of each: the 409's `details`, and the notice under the message's refused copy. A client may put its own "Not sent. " in front or nothing, so each reads both ways.
export const CHAT_MESSAGE_TAKEN_BACK_DETAILS: Record<ChatMessageTakenBackCode, string> = {
  [CHAT_MESSAGE_CANCELLED_CODE]: 'It was cancelled before it ran. Send it again as a new message.',
  [CHAT_MESSAGE_HANDED_BACK_CODE]: 'It was handed back when Stop was pressed. Send it again as a new message.',
  [CHAT_MESSAGE_OUTCOME_UNKNOWN_CODE]: 'It may still have reached the agent. Check the chat before sending it again.',
};

// The `code`s of a 409 that refused a send and marked nothing: the same id may be sent again. `error` is the readable sentence, shown as it is.
// Retry later: what stands in the way passes by itself (the workspace is still starting or waking), so a client may send the same id again without asking.
export const CHAT_MESSAGE_NOT_ACCEPTED_RETRY_LATER_CODE = 'message_not_accepted_retry_later';
// Needs action: it passes only when a person does what the sentence says (the workspace is in error or its sandbox is gone, the provider is not connected, the goal must be cleared first), so a client does not retry by itself.
export const CHAT_MESSAGE_NOT_ACCEPTED_NEEDS_ACTION_CODE = 'message_not_accepted_needs_action';
// May have run: a needs-action refusal of an id an earlier try may have delivered; a retry-later refusal of such an id stays retry later. `error` is the refusal's own sentence and `details` is the sentence below.
// A client does not retry by itself. The same id again is the way on once the cause has passed: an engine that ran it answers as it did then. A new message only after checking the chat.
export const CHAT_MESSAGE_NOT_ACCEPTED_MAY_HAVE_RUN_CODE = 'message_not_accepted_may_have_run';
export const CHAT_MESSAGE_MAY_HAVE_RUN_DETAILS = 'An earlier try may have reached the agent. Check the chat before trying again.';

// The `code`s of a message the server held, could not deliver and gave up on. Each is final for its id: the row keeps that id under this notice, and its text goes again only as a new message.
export const CHAT_MESSAGE_CHAT_NOT_FOUND_CODE = 'chat_not_found';
export const CHAT_MESSAGE_WORKSPACE_REFUSED_CODE = 'workspace_refused_message';
export const CHAT_MESSAGE_NOT_DELIVERED_CODE = 'message_not_delivered';
// The workspace's engine does not support what the message asks for, such as an edit or a switch of harness: the same text would be refused again, so a client offers no "Send again".
export const CHAT_MESSAGE_NOT_SUPPORTED_BY_WORKSPACE_CODE = 'not_supported_by_workspace';

// Every `code` the notice of a refused row can carry: a taken-back message's on its copy, and on a row that keeps its message's id may-have-run when an earlier try may have delivered it, or the code of a message the server gave up on.
export const CHAT_MESSAGE_REFUSED_ROW_CODES = [
  ...CHAT_MESSAGE_TAKEN_BACK_CODES,
  CHAT_MESSAGE_NOT_ACCEPTED_MAY_HAVE_RUN_CODE,
  CHAT_MESSAGE_CHAT_NOT_FOUND_CODE,
  CHAT_MESSAGE_WORKSPACE_REFUSED_CODE,
  CHAT_MESSAGE_NOT_DELIVERED_CODE,
  CHAT_MESSAGE_NOT_SUPPORTED_BY_WORKSPACE_CODE,
] as const;
export type ChatMessageRefusedRowCode = (typeof CHAT_MESSAGE_REFUSED_ROW_CODES)[number];

export interface PaginationParams {
  page?: number;
  limit?: number;
  defaultPage?: number;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface PaginationMetadata {
  page: number;
  total: number;
  limit: number;
  totalPages: number;
}

export interface ParsedPagination {
  page: number;
  limit: number;
  offset: number;
}

export function parsePaginationParams({
  page,
  limit,
  defaultPage = 1,
  defaultLimit = 10,
  maxLimit = 100,
}: PaginationParams): ParsedPagination {
  const parsedPage = typeof page === 'number' && Number.isInteger(page) && page > 0
    ? page
    : defaultPage;
  const parsedLimit = typeof limit === 'number' && Number.isInteger(limit) && limit > 0
    ? Math.min(limit, maxLimit)
    : defaultLimit;

  return {
    page: parsedPage,
    limit: parsedLimit,
    offset: (parsedPage - 1) * parsedLimit,
  };
}

export function getTotalPages(total: number, limit: number): number {
  return Math.ceil(total / limit);
}
