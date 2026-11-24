import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { Readable } from 'stream';
import { basename, join } from 'path';
import {
  isRecord,
  normalizeChatTranscriptMetadata,
  type AgentProvider,
  type ChatSubagentIndex,
  parseChatTranscriptArtifact,
  type ChatSummary,
  type ChatTranscriptArtifact,
  type EngineWorkspaceArtifactsFlushRequest,
  type ChatTranscriptMetadata,
  type EngineChatTranscriptFlushResult,
  type EngineChatTranscriptUploadRequest,
} from '@okidoki/shared';
import { monolithRequest } from './monolith-service';
import { chatMessageSendersFilePath, parseChatMessageSendersJsonl } from './chat/chat-senders';
import { HISTORY_DIR_BY_PROVIDER } from './chat/history-paths';
import { ENGINE_ENV } from '../engine-env';
import { detectAgentAuthMethod } from '../managers/agent-auth-detection';
import { putPresignedFile } from '../utils/presigned-upload';
import { scrubSecrets, transcriptSecrets } from '../utils/transcript-secrets';
import { fileRangeReader, openWholeLog, type OpenedLog } from '../managers/codex-asp/codex-history-file';

const UPLOAD_CHUNK_BYTES = 1 << 18;
const HISTORY_DIRS = [...new Set(Object.values(HISTORY_DIR_BY_PROVIDER))];
const ALWAYS_UPLOAD_HISTORY_DIRS = new Set([
  HISTORY_DIR_BY_PROVIDER.claude,
  HISTORY_DIR_BY_PROVIDER.codex,
]);

export type TranscriptAuth = Pick<ChatTranscriptMetadata, 'credential' | 'credentialSource' | 'environmentAuthMethod'>;
export type ChatTranscriptSource = ChatSummary & {
  removedMessageIds?: string[];
  /** The chat's log, opened with its flushed end: the upload reads that file and stops there, short of a record still being written. */
  openHistory?: () => Promise<OpenedLog | null>;
  subagentIndex?: (opened: OpenedLog) => Promise<ChatSubagentIndex | null>;
  transcriptAuth?: TranscriptAuth;
  currentHistoryVersion?: () => string | undefined;
};

export function currentTranscriptAuth(provider: AgentProvider): TranscriptAuth {
  const credential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[provider];
  if (credential) return { credential, credentialSource: 'stored' };
  const method = detectAgentAuthMethod(provider);
  return method === 'none' ? {} : { credentialSource: 'environment', environmentAuthMethod: method };
}

export function normalizeTranscriptAuth(value: unknown): TranscriptAuth | undefined {
  if (!isRecord(value)) return undefined;
  const { credential, credentialSource, environmentAuthMethod } = normalizeChatTranscriptMetadata(value);
  return { credential, credentialSource, environmentAuthMethod };
}

export function shouldFlushChatTranscript(
  historyDir: string,
  chat: ChatSummary | undefined,
  chatsById: Map<string, ChatSummary>,
  sessionHistoryCapture = false,
): boolean {
  if (ALWAYS_UPLOAD_HISTORY_DIRS.has(historyDir)) return true;
  if (!chat) return false;
  // Session history condenses every provider's top-level chats, so a sleep capture includes them all.
  return chat.parentChatId ? chatsById.has(chat.parentChatId) : sessionHistoryCapture;
}

export async function flushAllChatTranscripts(
  chatsById: Map<string, ChatTranscriptSource> = new Map(),
  capture?: EngineWorkspaceArtifactsFlushRequest,
  onUploaded?: (chatId: string, artifact: ChatTranscriptArtifact | null) => Promise<void>,
): Promise<EngineChatTranscriptFlushResult> {
  let flushed = 0;
  let failed = 0;
  const revisions: ChatTranscriptArtifact[] = [];
  const tasks: Promise<void>[] = [];
  for (const dir of HISTORY_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const chatId = basename(entry, '.jsonl');
      const chat = chatsById.get(chatId);
      if (!shouldFlushChatTranscript(dir, chat, chatsById, Boolean(capture))) continue;
      tasks.push(
        uploadChatTranscript(chatId, join(dir, entry), chat, capture)
          .then(async (artifact) => {
            flushed++;
            if (artifact && capture) revisions.push(artifact);
            await onUploaded?.(chatId, artifact).catch((err: unknown) => {
              console.error('[ChatTranscriptUploader] recording the uploaded history version failed:', { chatId, err });
            });
          })
          .catch((err) => {
            failed++;
            console.error('[ChatTranscriptUploader] upload failed:', { chatId, err });
          }),
      );
    }
  }
  await Promise.all(tasks);
  return capture
    ? { flushed, failed, captureSupported: true, revisions }
    : { flushed, failed };
}

const uploadsByChatId = new Map<string, Promise<unknown>>();
const lastUploadByTarget = new Map<string, { fingerprint: string; artifact: ChatTranscriptArtifact }>();

// Uploads for a chat run in call order so an older in-flight upload cannot finalize over newer metadata.
export function uploadChatTranscript(
  chatId: string,
  filePath: string,
  chat?: ChatTranscriptSource,
  capture?: EngineWorkspaceArtifactsFlushRequest,
): Promise<ChatTranscriptArtifact | null> {
  const upload = (uploadsByChatId.get(chatId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => uploadChatTranscriptNow(chatId, filePath, chat, capture));
  uploadsByChatId.set(chatId, upload);
  void upload.catch(() => {}).finally(() => {
    if (uploadsByChatId.get(chatId) === upload) uploadsByChatId.delete(chatId);
  });
  return upload;
}

async function uploadChatTranscriptNow(
  chatId: string,
  filePath: string,
  chat?: ChatTranscriptSource,
  capture?: EngineWorkspaceArtifactsFlushRequest,
): Promise<ChatTranscriptArtifact | null> {
  const versionBeforeOpen = chat?.currentHistoryVersion?.();
  const opened = await (chat?.openHistory?.() ?? openWholeLog(filePath));
  if (!opened) return null;
  try {
    if (opened.size === 0) return null;
    const historyVersion = versionBeforeOpen === chat?.currentHistoryVersion?.() ? versionBeforeOpen : undefined;
    return await uploadOpenedTranscript(chatId, opened, historyVersion, chat, capture);
  } finally {
    await opened.file.close();
  }
}

async function* logBytes({ file, size }: OpenedLog): AsyncGenerator<Buffer> {
  for (let at = 0; at < size;) {
    const chunk = Buffer.allocUnsafe(Math.min(UPLOAD_CHUNK_BYTES, size - at));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, at);
    if (bytesRead === 0) return;
    at += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
}

// Every byte comes from the one open file, so a log swapped for its rewrite meanwhile cannot be cut at the other file's end.
async function uploadOpenedTranscript(
  chatId: string,
  opened: OpenedLog,
  historyVersion: string | undefined,
  chat?: ChatTranscriptSource,
  capture?: EngineWorkspaceArtifactsFlushRequest,
): Promise<ChatTranscriptArtifact | null> {
  const { size } = opened;
  const { mtimeMs } = await opened.file.stat();

  const metadata: ChatTranscriptMetadata = chat
      ? {
        provider: chat.provider,
        // Chats with no turn since this engine version fall back to the auth live at upload.
        ...(chat.transcriptAuth ?? currentTranscriptAuth(chat.provider)),
        model: chat.model,
        title: chat.title,
        displayName: chat.displayName,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        parentChatId: chat.parentChatId,
        deletedAt: chat.deletedAt ?? null,
        fork: chat.fork ?? null,
        kind: chat.kind,
        ...(historyVersion ? { historyVersion } : {}),
      }
    : {};
  try {
    metadata.senders = parseChatMessageSendersJsonl(
      await readFile(chatMessageSendersFilePath(chatId), 'utf-8'),
    );
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  metadata.historyIndex = {
    version: 2,
    sourceSize: size,
    ...(chat?.removedMessageIds?.length ? { removedMessageIds: chat.removedMessageIds } : {}),
  };

  // Size and mtime stand in for the bytes; file times tick coarsely, so only a settled file is trusted.
  const settled = Date.now() - mtimeMs > 1000;
  const target = `${chatId}:${capture ? 'capture' : 'canonical'}`;
  const { secrets, variablesVersion } = transcriptSecrets();
  const fingerprint = JSON.stringify({ size, mtimeMs, metadata, variablesVersion });
  const last = lastUploadByTarget.get(target);
  // Still report the stored revision, or a chat whose earlier flush never reached memory capture is never captured.
  if (last?.fingerprint === fingerprint) {
    return capture ? { ...last.artifact, metadata: { ...last.artifact.metadata, captureId: capture.captureId } } : null;
  }
  const scrubbedBytes = () => scrubSecrets(logBytes(opened), secrets);
  if (capture) {
    const hash = createHash('sha256');
    for await (const chunk of scrubbedBytes()) hash.update(chunk);
    metadata.captureId = capture.captureId;
    metadata.captureReason = capture.reason;
    metadata.sha256 = hash.digest('hex');
  }

  // Read through the same scrubber as the upload: masking keeps byte lengths, so the index's offsets still hold.
  const readLog = fileRangeReader(opened.file);
  const subagentIndexFile = await chat?.subagentIndex?.(opened)
    .then(async (index) => index && Buffer.from(await index.toFile(size, async (startByte, endByte) => {
      const chunks: Buffer[] = [];
      const bytes = Buffer.from(await readLog(startByte, endByte));
      for await (const chunk of scrubSecrets((async function* () { yield bytes; })(), secrets)) chunks.push(chunk);
      return Buffer.concat(chunks);
    })))
    .catch((error: unknown) => {
      console.error(`[ChatTranscripts] Could not index sub-agents of chat ${chatId}:`, error);
      return null;
    });
  if (subagentIndexFile) metadata.historyIndex.subagentIndexSize = subagentIndexFile.length;

  const uploadRequest: EngineChatTranscriptUploadRequest = { chatId, size, metadata };
  const prepareResponse = await monolithRequest('/v1/engine/chat-transcripts/upload-url', {
    body: uploadRequest,
  });
  if (!prepareResponse.ok) {
    throw new Error(`prepare failed: ${prepareResponse.status} ${await prepareResponse.text()}`);
  }
  const prepareBody: unknown = await prepareResponse.json();
  if (!isRecord(prepareBody) || (typeof prepareBody.uploadUrl !== 'string' && prepareBody.uploadUrl !== null)) {
    throw new Error('prepare failed: invalid response');
  }
  if (prepareBody.uploadUrl === null) return null;
  await putPresignedFile(prepareBody.uploadUrl, Readable.from(scrubbedBytes()), size, 'application/x-ndjson');
  // A monolith that predates sub-agent index files sends no URL, and drops their size from the metadata it saves.
  if (subagentIndexFile && typeof prepareBody.subagentIndexUploadUrl === 'string') {
    await putPresignedFile(prepareBody.subagentIndexUploadUrl, Readable.from([subagentIndexFile]), subagentIndexFile.length, 'application/x-ndjson');
  }

  const finalizeResponse = await monolithRequest('/v1/engine/chat-transcripts/finalize', {
    body: uploadRequest,
  });
  if (!finalizeResponse.ok) {
    throw new Error(`finalize failed: ${finalizeResponse.status} ${await finalizeResponse.text()}`);
  }
  const finalizeBody: unknown = await finalizeResponse.json();
  if (!isRecord(finalizeBody)) throw new Error('finalize failed: invalid response');
  if (finalizeBody.artifact === null) return null;
  const artifact = parseChatTranscriptArtifact(finalizeBody.artifact);
  if (!artifact) throw new Error('finalize failed: invalid artifact');
  if (settled) lastUploadByTarget.set(target, { fingerprint, artifact });
  return artifact;
}
