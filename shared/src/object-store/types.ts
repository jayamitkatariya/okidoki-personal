import type { AgentProvider } from '../agent';
import { isValidAgentProvider } from '../agent';
import { coerceChatForkInfo, type ChatForkInfo } from '../chat-fork';
import { agentCredentialSnapshotSchema, type AgentCredentialSnapshot } from '../analytics/types';
import { CREDENTIAL_METHOD, type AuthMethod } from '../credentials/agents';
import type { CanvasItemKind } from '../engine/types';
import { isCanvasItemKind } from '../engine/types';
import { isChatMessageSender, type ChatMessageSender } from '../engine/v1';
import { isChatKind, type ChatKind } from '../chat-kind';
import { isRecord } from '../type-guards';
import type { VisualHeights } from '../visuals';
import {
  parseChatTranscriptHistoryIndex,
  type ChatTranscriptHistoryIndex,
} from '../chat-transcript-pages';

// Mirror enums and types in
// supabase/migrations/20260504120000_create_media.sql.
export const MEDIA_KIND = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  HTML: 'html',
} as const;
export const MEDIA_KINDS = [MEDIA_KIND.IMAGE, MEDIA_KIND.VIDEO, MEDIA_KIND.AUDIO, MEDIA_KIND.HTML] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const PUBLIC_MEDIA_KINDS = [MEDIA_KIND.IMAGE, MEDIA_KIND.VIDEO, MEDIA_KIND.AUDIO] as const;
export type PublicMediaKind = (typeof PUBLIC_MEDIA_KINDS)[number];

export function isPublicMediaKind(value: string): value is PublicMediaKind {
  return PUBLIC_MEDIA_KINDS.some((kind) => kind === value);
}

export type ObjectStoreProvider = 's3';
export type WorkspaceArtifactKind = 'chat_transcript' | 'canvas' | 'repo_state' | 'engine_log';
export const MAX_ENGINE_LOG_BYTES = 50 * 1024 * 1024;

export interface Media {
  id: string;
  organization_id: string;
  /** Null for a person's upload to an issue, which records `user_id` instead. */
  workspace_id: string | null;
  user_id: string | null;
  session_id: string | null;
  kind: MediaKind;
  provider: ObjectStoreProvider;
  bucket: string;
  key: string;
  size: number;
  display_name: string | null;
  visual_heights: VisualHeights | null;
  created_at: string;
}

export interface ListMediaResponse {
  media: Media[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface MediaResponse {
  media: Media;
}

export interface MediaPresignedUrlResponse {
  url: string;
  expires_in_seconds: number;
}

export interface MediaShareResponse {
  token: string;
}

export interface WorkspaceArtifact<TMetadata = Record<string, unknown>> {
  id: string;
  workspace_id: string;
  kind: WorkspaceArtifactKind;
  provider: ObjectStoreProvider;
  bucket: string;
  key: string;
  size: number;
  metadata: TMetadata;
  created_at: string;
}

export type ChatTranscriptArtifact = WorkspaceArtifact<ChatTranscriptMetadata> & {
  kind: 'chat_transcript';
};

export interface ChatTranscriptMetadata {
  historyVersion?: string;
  provider?: AgentProvider;
  credential?: AgentCredentialSnapshot;
  credentialSource?: 'stored' | 'environment';
  /** Set with `credentialSource: 'environment'`: the method the engine ran the agent on. Never the values. */
  environmentAuthMethod?: AuthMethod;
  model?: string;
  title?: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
  parentChatId?: string | null;
  deletedAt?: string | null;
  senders?: ChatMessageSender[];
  historyIndex?: ChatTranscriptHistoryIndex;
  captureId?: string;
  captureReason?: ChatTranscriptCaptureReason;
  sha256?: string;
  fork?: ChatForkInfo | null;
  kind?: ChatKind;
}

export type ChatTranscriptCaptureReason = 'workspace_sleep';

export interface EngineWorkspaceArtifactsFlushRequest {
  captureId: string;
  reason: ChatTranscriptCaptureReason;
}

function normalizeChatMessageSenders(value: unknown): ChatMessageSender[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const senders = value.flatMap((sender): ChatMessageSender[] => {
    if (!isChatMessageSender(sender)) return [];
    const { messageId, senderUserId, senderEmail, senderDisplayName, senderAvatarUrl, recordedAt } = sender;
    return [{
      ...(typeof messageId === 'string' ? { messageId } : {}),
      senderUserId,
      senderEmail,
      ...(typeof senderDisplayName === 'string' ? { senderDisplayName } : {}),
      ...(typeof senderAvatarUrl === 'string' ? { senderAvatarUrl } : {}),
      recordedAt,
    }];
  });
  return senders;
}

export interface EngineChatTranscriptUploadRequest {
  chatId: string;
  size: number;
  metadata: ChatTranscriptMetadata;
}

export interface EngineChatTranscriptFlushResult {
  flushed: number;
  failed: number;
  captureSupported?: true;
  revisions?: ChatTranscriptArtifact[];
}

export interface EngineWorkspaceArtifactsFlushResponse {
  chatTranscripts: EngineChatTranscriptFlushResult;
  canvas: { flushed: number; skipped: number; failed: number; deleted: number };
  repoState: { flushed: number; skipped: number; failed: number };
  engineLogs: { flushed: number; skipped: number; failed: number };
  turnActivity: { flushed: number; failed: number };
  skillActivity: { flushed: number; failed: number };
  mcpActivity: { flushed: number; failed: number };
}

export type EngineChatTranscriptUploadResponse =
  | { uploadUrl: string; expiresInSeconds: number; subagentIndexUploadUrl?: string }
  | { uploadUrl: null; skipped: 'persistence_disabled' };

export type EngineChatTranscriptFinalizeResponse =
  | { artifact: ChatTranscriptArtifact }
  | { artifact: null; skipped: 'persistence_disabled' };

export function normalizeChatTranscriptMetadata(value: unknown): ChatTranscriptMetadata {
  if (!isRecord(value)) return {};
  const metadata: ChatTranscriptMetadata = {};
  const {
    provider,
    credential,
    credentialSource,
    environmentAuthMethod,
    model,
    title,
    displayName,
    createdAt,
    updatedAt,
    historyVersion,
    parentChatId,
    deletedAt,
    senders,
    historyIndex,
    captureId,
    captureReason,
    sha256,
    fork,
    kind,
  } = value;

  if (typeof provider === 'string' && isValidAgentProvider(provider)) metadata.provider = provider;
  const parsedCredential = agentCredentialSnapshotSchema.safeParse(credential);
  if (parsedCredential.success) metadata.credential = parsedCredential.data;
  if (credentialSource === 'stored' || credentialSource === 'environment') metadata.credentialSource = credentialSource;
  const authMethod = Object.values(CREDENTIAL_METHOD).find((method) => method === environmentAuthMethod);
  if (authMethod) metadata.environmentAuthMethod = authMethod;
  if (typeof model === 'string') metadata.model = model;
  if (typeof title === 'string') metadata.title = title;
  if (typeof displayName === 'string') metadata.displayName = displayName;
  if (typeof createdAt === 'string') metadata.createdAt = createdAt;
  if (typeof updatedAt === 'string') metadata.updatedAt = updatedAt;
  if (typeof historyVersion === 'string') metadata.historyVersion = historyVersion;
  if (typeof parentChatId === 'string' || parentChatId === null) metadata.parentChatId = parentChatId;
  if (typeof deletedAt === 'string' || deletedAt === null) metadata.deletedAt = deletedAt;
  const normalizedSenders = normalizeChatMessageSenders(senders);
  if (normalizedSenders) metadata.senders = normalizedSenders;
  const parsedHistoryIndex = parseChatTranscriptHistoryIndex(historyIndex);
  if (parsedHistoryIndex) metadata.historyIndex = parsedHistoryIndex;
  if (typeof captureId === 'string') metadata.captureId = captureId;
  if (captureReason === 'workspace_sleep') metadata.captureReason = captureReason;
  if (typeof sha256 === 'string') metadata.sha256 = sha256;
  if (isChatKind(kind)) metadata.kind = kind;
  if (fork === null) metadata.fork = null;
  else if (fork !== undefined) {
    const parsedFork = coerceChatForkInfo(fork);
    if (parsedFork) metadata.fork = parsedFork;
  }

  return metadata;
}

export function parseChatTranscriptArtifact(value: unknown): ChatTranscriptArtifact | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.workspace_id !== 'string'
    || value.kind !== 'chat_transcript'
    || value.provider !== 's3'
    || typeof value.bucket !== 'string'
    || typeof value.key !== 'string'
    || typeof value.size !== 'number'
    || typeof value.created_at !== 'string') return null;

  return {
    id: value.id,
    workspace_id: value.workspace_id,
    kind: 'chat_transcript',
    provider: 's3',
    bucket: value.bucket,
    key: value.key,
    size: value.size,
    metadata: normalizeChatTranscriptMetadata(value.metadata),
    created_at: value.created_at,
  };
}

export type CanvasArtifact = WorkspaceArtifact<CanvasArtifactMetadata> & {
  kind: 'canvas';
};

export interface CanvasArtifactMetadata {
  filename?: string;
  kind?: CanvasItemKind;
  mimeType?: string;
  updatedAt?: string;
}

export function normalizeCanvasArtifactMetadata(value: unknown): CanvasArtifactMetadata {
  if (!isRecord(value)) return {};
  const metadata: CanvasArtifactMetadata = {};
  const { filename, kind, mimeType, updatedAt } = value;

  if (typeof filename === 'string') metadata.filename = filename;
  if (isCanvasItemKind(kind)) metadata.kind = kind;
  if (typeof mimeType === 'string') metadata.mimeType = mimeType;
  if (typeof updatedAt === 'string') metadata.updatedAt = updatedAt;

  return metadata;
}

export type EngineLogArtifact = WorkspaceArtifact<EngineLogArtifactMetadata> & {
  kind: 'engine_log';
};

export interface EngineLogArtifactMetadata {
  sessionId?: string;
  filename?: string;
  updatedAt?: string;
}

export function normalizeEngineLogArtifactMetadata(value: unknown): EngineLogArtifactMetadata {
  if (!isRecord(value)) return {};
  const metadata: EngineLogArtifactMetadata = {};
  const { sessionId, filename, updatedAt } = value;

  if (typeof sessionId === 'string') metadata.sessionId = sessionId;
  if (typeof filename === 'string') metadata.filename = filename;
  if (typeof updatedAt === 'string') metadata.updatedAt = updatedAt;

  return metadata;
}
