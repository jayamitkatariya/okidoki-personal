import type { AgentProvider } from '../agent';
import type { ImageContent } from '../engine/types';
import type {
  ExternalAccountConnectionDeleteResponse,
  ExternalAccountConnectionStatusResponse,
} from './external-accounts';

export interface SlackStartOAuthResponse {
  authorizationUrl: string;
}

export interface SlackUserConnectionStatusResponse
  extends ExternalAccountConnectionStatusResponse {
  teamName?: string;
}

export type SlackUserStartOAuthResponse = SlackStartOAuthResponse;

export type SlackUserConnectionDeleteResponse = ExternalAccountConnectionDeleteResponse;

export interface SlackCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  teamName?: string;
  teamId?: string;
  lastFetchedAt?: string;
  defaultChannelId?: string;
}

export interface SlackCredentialDeleteResponse {
  success: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  /** Slack Connect, including a pending invite. */
  is_ext_shared: boolean;
}

export interface SlackChannelListResponse {
  channels: SlackChannel[];
}

export interface SlackPublicChannel extends SlackChannel {
  is_member: boolean;
}

export interface SlackPublicChannelListResponse {
  channels: SlackPublicChannel[];
}

export const SLACK_JOIN_CHANNELS_MAX = 200;

export interface JoinSlackChannelsRequest {
  channel_ids: string[];
}

export interface JoinSlackChannelsResponse {
  joined: string[];
  failed: Array<{ channel_id: string; error: string }>;
}

export interface SlackThreadAttachRequest {
  channel_id: string;
  thread_ts: string;
  workspace_id?: string;
}

export interface SlackThreadAttachResponse {
  thread: SlackThreadRecord;
  workspace: {
    id: string;
    name: string;
  };
}

export interface SlackThreadMetadata {
  channel_id: string;
  channel_name?: string;
  thread_ts: string;
  message_ts?: string;
  routed_message_timestamps?: string[];
  original_message: string;
  user_id: string;
  user_name?: string;
  /** The Okidoki member whose message tied the thread to a Manager; ships started for it run as them. */
  requester_user_id?: string;
  images?: ImageContent[];
  workspace_target?: {
    label: string;
  };
  workspace?: {
    id: string;
    coding_agent?: AgentProvider;
    task_description: string;
    created_at: string;
  };
}

export interface SlackThreadRecord {
  id: string;
  organization_id: string;
  slack_team_id: string;
  channel_id: string;
  thread_ts: string;
  workspace_id: string | null;
  scout_user_id: string | null;
  owned_by_org_scout: boolean;
  status: string;
  metadata: SlackThreadMetadata;
  last_processed_message_ts: string | null;
  created_at: string;
  updated_at: string;
}
