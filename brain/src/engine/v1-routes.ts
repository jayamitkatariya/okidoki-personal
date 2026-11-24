import { Hono, type Context } from 'hono';
import { workspaceCredentialProviderSchema, type EngineSwitchCredentialRequest, type EngineWithdrawLoginsRequest } from '@okidoki/shared';
import { withdrawAgentLogin } from './services/agent-logins';
import { claudeTokenManager } from './managers/claude-token-manager';
import { clearCredentialFallbacks } from './services/credential-fallbacks';
import { z } from 'zod';
import { readdir, stat, readFile } from 'fs/promises';
import { openAsBlob } from 'fs';
import { join, resolve } from 'path';
import { ENGINE_FLUSH_CHAT_TRANSCRIPTS_PATH, ENGINE_FLUSH_WORKSPACE_ARTIFACTS_PATH, ENGINE_STREAM_LAST_EVENT_ID_HEADER, byteRangeResponse, MAX_CANVAS_PREVIEW_BYTES, MAX_CODEX_GOAL_OBJECTIVE_CHARS, MAX_REPO_FILE_CONTENT_BYTES, chatHistoryPageParamsFromQuery, createChatRequestSchema, engineInterruptChatRequestSchema, forkChatRequestSchema, getChatHistoryPageSenders, ENGINE_SEND_MESSAGE_FAILED_ERROR, getGoalCommandObjectiveValidationError, isValidEngineLogSessionId, messageSubagentRequestSchema, paginateChatHistory, paginateEngineLogContent, parseChatHistoryCursor, respondToolInputRequestSchema, sendChatMessageRequestSchema, spawnSubagentRequestSchema, updateChatDisplayNameRequestSchema, waitSubagentRequestSchema } from '@okidoki/shared';
import type {
  ApiErrorResponse,
  ChatQueueResponse,
  ChatHistoryPageParams,
  ChatHistoryRecordResponse,
  ClearChatGoalResponse,
  CreateChatResponse,
  ForkChatResponse,
  CreatePreviewRequest,
  CreatePreviewResponse,
  DeleteChatResponse,
  DeletePreviewResponse,
  EngineEnvironmentDetails,
  EngineEnvironmentTrackRequest,
  EngineVersionResponse,
  EngineWorkspaceArtifactsFlushResponse,
  EngineLogSessionInfo,
  EngineLogsListResponse,
  EngineLogReadResponse,
  EngineWorkspaceArtifactsFlushRequest,
  GetChatResponse,
  HooksStatusResponse,
  InterruptChatResponse,
  ListChatsResponse,
  ListPreviewsResponse,
  ListSlashCommandsResponse,
  CanvasContentResponse,
  CanvasListResponse,
  ListReposResponse,
  QueueMutationResponse,
  SubagentResponse,
  ReorderQueueRequest,
  RestoreChatResponse,
  SendChatMessageResponse,
  WarmHookFullLogResponse,
  WarmHookLogsResponse,
  StartHookFullLogResponse,
  StartHookLogsResponse,
  StartHookStreamEvent,
  UpdateChatGoalRequest,
  UpdateChatGoalResponse,
  UpdateChatDisplayNameResponse,
  UpdateQueuedMessageRequest,
  CreateTerminalSessionResponse,
  ListTerminalSessionsResponse,
  WriteTerminalSessionRequest,
  UpdateTextFileRequest,
  UpdateTextFileResponse,
} from '@okidoki/shared';
import { engineLogger, LOG_DIR } from './utils/logger';
import { environmentDetailsService } from './services/environment-details-service';
import { eventService } from './services/event-service';
import type { CanvasService } from './services/canvas-service';
import { previewService } from './services/preview-service';
import { gitService } from './git/service';
import { okidokiConfigService } from './services/okidoki-config-service';
import { codexTokenManager } from './managers/codex-token-manager';
import { readCodexAspThreadHistory } from './managers/codex-asp/codex-asp-manager';
import { runWarmHooks, runWarmHooksStreaming, type WarmHookStreamEvent } from './services/warm-hooks-service';
import { warmHookLogsService } from './services/warm-hook-logs-service';
import { startHookLogsService } from './services/start-hook-logs-service';
import { ChatBusyError, ChatMessagePersistenceError, ChatNotFoundError, ChatProviderUnavailableError, CodexThreadNotFoundError, DuplicateDefaultChatError } from './services/chat/errors';
import type { ChatService } from './services/chat/chat-service';
import type { RepoFileService } from './services/repo-file-service';
import { terminalService, terminalSizeSchema } from './services/terminal-service';
import { ENGINE_ENV, setLinearSessionId } from './engine-env';
import { pullRequestCheckService } from './services/pull-request-check-service';

const createPreviewSchema = z.object({
  port: z.number().int().min(1).max(65535),
  publicUrl: z.string().min(1),
}) satisfies z.ZodType<CreatePreviewRequest>;

const writeTerminalSessionSchema = z.object({
  data: z.string().max(64 * 1024),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
}) satisfies z.ZodType<WriteTerminalSessionRequest>;

const updateGoalSchema = z.object({
  objective: z.string().trim().min(1).max(MAX_CODEX_GOAL_OBJECTIVE_CHARS).optional(),
  status: z.enum(['active', 'paused']).optional(),
}).refine((body) => body.objective !== undefined || body.status !== undefined, {
  message: 'Goal objective or status required',
}) satisfies z.ZodType<UpdateChatGoalRequest>;

const updateTextFileSchema = (maxLength: number) => z.object({
  content: z.string().max(maxLength),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
}) satisfies z.ZodType<UpdateTextFileRequest>;

/**
 * Builds a standard API error payload.
 */
function jsonError(message: string, details?: string): ApiErrorResponse {
  return { error: message, details };
}

function createJsonEventStream(
  run: (send: (data: unknown, event?: string) => void) => Promise<unknown>,
  onError: (error: unknown) => { data: unknown; event?: string },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const send = (data: unknown, event?: string): void => {
        enqueue(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!enqueue(': ping\n\n')) clearInterval(heartbeat);
      }, 15_000);
      enqueue(': connected\n\n');
      run(send).catch((error) => {
        const failure = onError(error);
        send(failure.data, failure.event);
      }).finally(() => {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

/**
 * Creates the engine v1 API routes.
 */
export function createV1Routes(deps: {
  chatService: ChatService;
  repoFileService: RepoFileService;
  canvasService: Pick<CanvasService, 'listItems' | 'getItem' | 'updateItem' | 'locateItem'>;
}): Hono {
  const app = new Hono();

  app.post('/pull-requests/check', async (c) => {
    if (c.req.header('content-type')?.includes('application/json')) {
      const result = z.object({
        toolName: z.string(), toolInput: z.unknown(), output: z.unknown(), success: z.boolean(),
      }).safeParse(await c.req.json().catch(() => null));
      if (!result.success) return c.json({ error: 'Invalid PR tool result' }, 400);
      await pullRequestCheckService.onToolResult(result.data);
    } else {
      pullRequestCheckService.checkTurn().catch(() => {});
    }
    return c.json({ accepted: true }, 202);
  });
  const loadChatHistory = async (
    c: Context,
    chatId: string,
    page: ChatHistoryPageParams,
    failureMessage: string,
    unexpectedStatus: 404 | 500,
    legacy = false,
  ) => {
    try {
      const history = await deps.chatService.getChatHistory(chatId, legacy && page.limit !== undefined ? {} : page);
      if (!legacy) return c.json(history);
      return c.json(paginateChatHistory({
        ...history,
        senders: getChatHistoryPageSenders(history.senders, page),
      }, page));
    } catch (error) {
      const status = error instanceof ChatNotFoundError ? 404 : unexpectedStatus;
      return c.json<ApiErrorResponse>(jsonError(
        failureMessage,
        error instanceof Error ? error.message : 'Unknown error',
      ), status);
    }
  };

  app.get('/events', async (c) => {
    const encoder = new TextEncoder();
    const lastEventId = c.req.header(ENGINE_STREAM_LAST_EVENT_ID_HEADER);
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const cleanup = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const safeEnqueue = (chunk: string): boolean => {
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            cleanup();
            return false;
          }
        };

        unsubscribe = eventService.subscribe(safeEnqueue, lastEventId);

        heartbeat = setInterval(() => {
          safeEnqueue(': ping\n\n');
        }, 15000);
      },
      cancel: () => {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/chats', (c) => {
    const includeChildren = c.req.query('includeChildren') === 'true';
    const response: ListChatsResponse = {
      chats: deps.chatService.listChats(includeChildren),
      deletedChats: deps.chatService.listDeletedChats(includeChildren),
    };
    return c.json<ListChatsResponse>(response);
  });

  app.get('/chats/:chatId/children', (c) => {
    const chatId = c.req.param('chatId');
    const chat = deps.chatService.getChat(chatId);
    if (!chat) {
      return c.json<ApiErrorResponse>(jsonError('Chat not found'), 404);
    }
    const response: ListChatsResponse = {
      chats: deps.chatService.listChildChats(chatId),
    };
    return c.json<ListChatsResponse>(response);
  });

  app.get('/chats/:chatId/subagents', async (c) => {
    try {
      return c.json(
        await deps.chatService.getSubagentProviders(c.req.param('chatId')),
      );
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to load subagent providers',
        error instanceof Error ? error.message : 'Unknown error',
      ), 400);
    }
  });

  app.post('/chats/:chatId/subagents', async (c) => {
    try {
      const request = spawnSubagentRequestSchema.parse(await c.req.json());
      return c.json<SubagentResponse>(
        await deps.chatService.spawnSubagent(c.req.param('chatId'), request),
        201,
      );
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to spawn subagent',
        error instanceof Error ? error.message : 'Unknown error',
      ), 400);
    }
  });

  app.post('/chats/:chatId/subagents/:subagentId/messages', async (c) => {
    try {
      const request = messageSubagentRequestSchema.parse(await c.req.json());
      return c.json<SubagentResponse>(await deps.chatService.messageSubagent(
        c.req.param('chatId'),
        c.req.param('subagentId'),
        request,
      ));
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to message subagent',
        error instanceof Error ? error.message : 'Unknown error',
      ), 400);
    }
  });

  app.get('/chats/:chatId/subagents/:subagentId', async (c) => {
    try {
      return c.json<SubagentResponse>(await deps.chatService.getSubagent(
        c.req.param('chatId'),
        c.req.param('subagentId'),
      ));
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to load subagent',
        error instanceof Error ? error.message : 'Unknown error',
      ), 400);
    }
  });

  app.get('/chats/:chatId/subagents/:subagentId/wait', async (c) => {
    const parsed = waitSubagentRequestSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json<ApiErrorResponse>(jsonError('Failed to wait for subagent', parsed.error.message), 400);
    }
    return createJsonEventStream(
      async (send) => {
        send(await deps.chatService.waitForSubagent(
          c.req.param('chatId'),
          c.req.param('subagentId'),
          parsed.data.timeoutMinutes,
          c.req.raw.signal,
        ));
      },
      (error) => ({
        event: 'error',
        data: {
          error: 'Failed to wait for subagent',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
      }),
    );
  });

  app.delete('/chats/:chatId/subagents/:subagentId', async (c) => {
    try {
      await deps.chatService.deleteSubagent(c.req.param('chatId'), c.req.param('subagentId'));
      return c.json<DeleteChatResponse>({ success: true, chatId: c.req.param('subagentId') });
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to delete subagent',
        error instanceof Error ? error.message : 'Unknown error',
      ), 400);
    }
  });

  app.post('/chats', async (c) => {
    try {
      const body = createChatRequestSchema.parse(await c.req.json());
      const chat = await deps.chatService.createChat(body);
      const response: CreateChatResponse = { chat };
      return c.json<CreateChatResponse>(response, 201);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof DuplicateDefaultChatError) {
        return c.json<ApiErrorResponse>(jsonError('Invalid chat request', 'Default chat already exists for this provider'), 400);
      }
      return c.json<ApiErrorResponse>(jsonError('Invalid chat request', details), 400);
    }
  });

  app.post('/chats/:chatId/fork', async (c) => {
    try {
      const body = forkChatRequestSchema.strip().parse(await c.req.json());
      const chat = await deps.chatService.forkChat(c.req.param('chatId'), body);
      return c.json<ForkChatResponse>({ chat }, 201);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to fork chat', details), 404);
      }
      if (error instanceof ChatProviderUnavailableError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to fork chat', details), 409);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to fork chat', details), 400);
    }
  });

  app.get('/chats/:chatId', (c) => {
    const chat = deps.chatService.getChat(c.req.param('chatId'));
    if (!chat) {
      return c.json<ApiErrorResponse>(jsonError('Chat not found'), 404);
    }
    const response: GetChatResponse = { chat };
    return c.json<GetChatResponse>(response);
  });

  app.patch('/chats/:chatId', async (c) => {
    try {
      const body = updateChatDisplayNameRequestSchema.parse(await c.req.json());
      const chat = await deps.chatService.updateDisplayName(c.req.param('chatId'), body.displayName);
      return c.json<UpdateChatDisplayNameResponse>({ chat });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json<ApiErrorResponse>(jsonError(error.issues[0]?.message || 'Invalid tab name'), 400);
      }
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to rename tab', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to rename tab', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.delete('/chats/:chatId', async (c) => {
    const chatId = c.req.param('chatId');
    try {
      await deps.chatService.deleteChat(chatId);
      return c.json<DeleteChatResponse>({ success: true, chatId });
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof ChatNotFoundError || details.includes('Chat not found')) {
        return c.json<ApiErrorResponse>(jsonError('Failed to delete chat', details), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to delete chat', details), 500);
    }
  });

  app.post('/chats/:chatId/restore', async (c) => {
    const chatId = c.req.param('chatId');
    try {
      const chat = await deps.chatService.restoreChat(chatId);
      return c.json<RestoreChatResponse>({ chat });
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to restore chat', details), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to restore chat', details), 500);
    }
  });

  app.get('/chats/:chatId/history', (c) => loadChatHistory(
    c,
    c.req.param('chatId'),
    chatHistoryPageParamsFromQuery(c.req.query()),
    'Failed to load chat history',
    404,
    true,
  ));

  app.get('/chats/:chatId/history-page', async (c) => {
    const page = chatHistoryPageParamsFromQuery(c.req.query());
    if (page.limit === undefined) {
      return c.json<ApiErrorResponse>(jsonError('Failed to load chat history page', 'limit is required'), 400);
    }
    if (page.beforeCursor !== undefined && !parseChatHistoryCursor(page.beforeCursor)) {
      return c.json<ApiErrorResponse>(jsonError('Failed to load chat history page', 'invalid cursor'), 400);
    }
    return loadChatHistory(c, c.req.param('chatId'), page, 'Failed to load chat history page', 500);
  });

  app.get('/chats/:chatId/history/record', async (c) => {
    const record = { offset: Number(c.req.query('offset')), length: Number(c.req.query('length')) };
    try {
      const event = await deps.chatService.getChatHistoryRecord(c.req.param('chatId'), record);
      return event
        ? c.json<ChatHistoryRecordResponse>({ event })
        : c.json<ApiErrorResponse>(jsonError('Failed to load chat history record', 'not a record of this chat'), 404);
    } catch (error) {
      return c.json<ApiErrorResponse>(jsonError(
        'Failed to load chat history record',
        error instanceof Error ? error.message : 'Unknown error',
      ), error instanceof ChatNotFoundError ? 404 : 500);
    }
  });

  app.get('/chats/:chatId/slash-commands', async (c) => {
    try {
      const response = await deps.chatService.listSlashCommands(c.req.param('chatId'));
      return c.json<ListSlashCommandsResponse>(response);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to load slash commands', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to load slash commands', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.post('/chats/:chatId/messages', async (c) => {
    try {
      const body = sendChatMessageRequestSchema.strip().parse(await c.req.json());
      const goalValidationError = getGoalCommandObjectiveValidationError(body.message, body.goalMode);
      if (goalValidationError) {
        return c.json<ApiErrorResponse>(jsonError(goalValidationError), 400);
      }
      const result = await deps.chatService.sendMessage(c.req.param('chatId'), body);
      return c.json<SendChatMessageResponse>(result);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError(ENGINE_SEND_MESSAGE_FAILED_ERROR, details), 404);
      }
      if (details.includes('Chat not found')) {
        return c.json<ApiErrorResponse>(jsonError(ENGINE_SEND_MESSAGE_FAILED_ERROR, details), 404);
      }
      if (error instanceof ChatMessagePersistenceError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to save user message', details), 500);
      }
      if (error instanceof ChatBusyError || error instanceof ChatProviderUnavailableError) {
        return c.json<ApiErrorResponse>(jsonError(ENGINE_SEND_MESSAGE_FAILED_ERROR, details), 409);
      }
      return c.json<ApiErrorResponse>(jsonError(ENGINE_SEND_MESSAGE_FAILED_ERROR, details), 400);
    }
  });

  app.post('/chats/:chatId/interrupt', async (c) => {
    try {
      const { stoppedAt, stopped } = engineInterruptChatRequestSchema.catch({}).parse(await c.req.json().catch(() => ({})));
      const result = await deps.chatService.interrupt(c.req.param('chatId'), stoppedAt, stopped);
      const response: InterruptChatResponse = result;
      return c.json<InterruptChatResponse>(response);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to interrupt chat', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to interrupt chat', error instanceof Error ? error.message : 'Unknown error'), 404);
    }
  });

  app.patch('/chats/:chatId/goal', async (c) => {
    try {
      const body = updateGoalSchema.parse(await c.req.json());
      const result = await deps.chatService.updateGoal(c.req.param('chatId'), body);
      return c.json<UpdateChatGoalResponse>(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json<ApiErrorResponse>(jsonError(error.issues[0]?.message || 'Invalid goal update'), 400);
      }
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to update goal', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to update goal', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.post('/chats/:chatId/goal/clear', async (c) => {
    try {
      const result = await deps.chatService.clearGoal(c.req.param('chatId'));
      return c.json<ClearChatGoalResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to clear goal', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to clear goal', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.post(ENGINE_FLUSH_CHAT_TRANSCRIPTS_PATH, async (c) => {
    try {
      const result = await deps.chatService.flushAllChatTranscripts();
      return c.json(result);
    } catch (error) {
      return c.json(
        jsonError('Failed to flush transcripts', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post(ENGINE_FLUSH_WORKSPACE_ARTIFACTS_PATH, async (c) => {
    try {
      const body = await c.req.json<EngineWorkspaceArtifactsFlushRequest>().catch(() => undefined);
      const capture = body
        && typeof body.captureId === 'string'
        && body.reason === 'workspace_sleep'
        ? body
        : undefined;
      const result = await deps.chatService.flushAllWorkspaceArtifacts(capture);
      return c.json<EngineWorkspaceArtifactsFlushResponse>(result);
    } catch (error) {
      return c.json(
        jsonError('Failed to flush workspace artifacts', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/chats/:chatId/queue', (c) => {
    try {
      const result = deps.chatService.getChatQueue(c.req.param('chatId'));
      return c.json<ChatQueueResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to get queue', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.delete('/chats/:chatId/queue', async (c) => {
    try {
      const result = await deps.chatService.clearQueue(c.req.param('chatId'));
      return c.json<QueueMutationResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to clear queue', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.delete('/chats/:chatId/queue/:messageId', async (c) => {
    try {
      const result = await deps.chatService.removeFromQueue(c.req.param('chatId'), c.req.param('messageId'));
      return c.json<QueueMutationResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to remove from queue', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.patch('/chats/:chatId/queue/reorder', async (c) => {
    try {
      const body = await c.req.json<ReorderQueueRequest>();
      if (!body.messageId || typeof body.position !== 'number' || !Number.isFinite(body.position)) {
        return c.json<ApiErrorResponse>(jsonError('Invalid request', 'messageId and position are required'), 400);
      }
      const result = await deps.chatService.reorderQueue(c.req.param('chatId'), body.messageId, body.position);
      return c.json<QueueMutationResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to reorder queue', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  app.patch('/chats/:chatId/queue/:messageId', async (c) => {
    try {
      const body = await c.req.json<UpdateQueuedMessageRequest>();
      const message = body.message?.trim();
      if (!message) {
        return c.json<ApiErrorResponse>(jsonError('Invalid request', 'message is required'), 400);
      }
      const result = await deps.chatService.updateQueuedMessage(c.req.param('chatId'), c.req.param('messageId'), message);
      return c.json<QueueMutationResponse>(result);
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to update queued message', error instanceof Error ? error.message : 'Unknown error'), 500);
    }
  });

  for (const { action, failure, run } of [
    { action: 'steer', failure: 'Failed to steer queued message', run: (chatId: string, messageId: string) => deps.chatService.steerFromQueue(chatId, messageId) },
    { action: 'send-now', failure: 'Failed to send queued message now', run: (chatId: string, messageId: string) => deps.chatService.sendNow(chatId, messageId) },
  ]) {
    app.post(`/chats/:chatId/queue/:messageId/${action}`, async (c) => {
      try {
        return c.json<QueueMutationResponse>(await run(c.req.param('chatId'), c.req.param('messageId')));
      } catch (error) {
        if (error instanceof ChatNotFoundError) {
          return c.json<ApiErrorResponse>(jsonError('Chat not found', error.message), 404);
        }
        return c.json<ApiErrorResponse>(jsonError(failure, error instanceof Error ? error.message : 'Unknown error'), 500);
      }
    });
  }

  app.post('/chats/:chatId/tool-input', async (c) => {
    try {
      const body = respondToolInputRequestSchema.parse(await c.req.json());
      const resolved = await deps.chatService.respondToToolInput(
        c.req.param('chatId'),
        body.requestId,
        body.selectionId,
      );
      return c.json({ resolved });
    } catch (error) {
      if (error instanceof ChatNotFoundError) {
        return c.json<ApiErrorResponse>(jsonError('Failed to resolve tool input', error.message), 404);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to resolve tool input', error instanceof Error ? error.message : 'Unknown error'), 400);
    }
  });

  app.get('/repos', async (c) => {
    const includeDiffs = c.req.query('includeDiffs') === 'true';
    const repos = await gitService.listRepos({ includeDiffs });
    const response: ListReposResponse = {
      repos,
      workspaceRoot: gitService.getWorkspaceRoot(),
    };
    return c.json<ListReposResponse>(response);
  });

  app.get('/repo-files/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const prefix = c.req.query('prefix') ?? '';
    const rawLimit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    const limit = rawLimit !== undefined && !Number.isNaN(rawLimit) ? rawLimit : undefined;
    const cursor = c.req.query('cursor') ?? undefined;
    const refresh = c.req.query('refresh') === 'true';

    const result = await deps.repoFileService.search({ q, prefix, limit, cursor, refresh });
    return c.json(result);
  });

  app.get('/repo-files/content', async (c) => {
    const repoName = c.req.query('repoName');
    const path = c.req.query('path');

    if (!repoName || !path) {
      return c.json<ApiErrorResponse>(jsonError('repoName and path are required'), 400);
    }

    const result = await deps.repoFileService.readFile(repoName, path);
    if (!result) {
      return c.json<ApiErrorResponse>(jsonError('File not found'), 404);
    }

    return c.json(result);
  });

  app.get('/files/content', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.json<ApiErrorResponse>(jsonError('path is required'), 400);

    const result = await deps.repoFileService.readWorkspaceFile(path);
    if (!result) return c.json<ApiErrorResponse>(jsonError('File not found'), 404);
    return c.json(result);
  });

  app.put('/repo-files/content', async (c) => {
    const repoName = c.req.query('repoName');
    const path = c.req.query('path');
    if (!repoName || !path) {
      return c.json<ApiErrorResponse>(jsonError('repoName and path are required'), 400);
    }

    const body = updateTextFileSchema(MAX_REPO_FILE_CONTENT_BYTES).parse(await c.req.json());
    const result = await deps.repoFileService.updateFile(repoName, path, body.content, body.expectedRevision);
    if (!result) return c.json<ApiErrorResponse>(jsonError('File is not editable'), 400);
    return c.json<UpdateTextFileResponse>(result);
  });

  app.get('/repo-files/symbol', async (c) => {
    const repoName = c.req.query('repoName');
    const path = c.req.query('path');
    const action = c.req.query('action');
    const line = Number(c.req.query('line'));
    const character = Number(c.req.query('character'));
    if (!repoName || !path || (action !== 'hover' && action !== 'definition' && action !== 'references') || !Number.isInteger(line) || !Number.isInteger(character)) {
      return c.json<ApiErrorResponse>(jsonError('Invalid symbol request'), 400);
    }
    const result = await deps.repoFileService.inspectSymbol(repoName, path, line, character, action);
    if (!result) return c.json<ApiErrorResponse>(jsonError('Symbol not found'), 404);
    return c.json(result);
  });

  app.get('/terminal/sessions', (c) => {
    return c.json<ListTerminalSessionsResponse>({ sessions: terminalService.list() });
  });

  app.post('/terminal/sessions', async (c) => {
    const size = terminalSizeSchema.parse(await c.req.json());
    const result = terminalService.create(gitService.getWorkspaceRoot(), size.cols, size.rows);
    if (!result.ok) return c.json<ApiErrorResponse>(jsonError(result.error.message), 429);
    return c.json<CreateTerminalSessionResponse>({
      session: result.data,
    }, 201);
  });

  app.post('/terminal/sessions/:id/input', async (c) => {
    const body = writeTerminalSessionSchema.parse(await c.req.json());
    if (!terminalService.write(c.req.param('id'), body.data, body.generation, body.sequence)) {
      return c.json<ApiErrorResponse>(jsonError('Terminal session not found or exited'), 404);
    }
    return c.body(null, 204);
  });

  app.post('/terminal/sessions/:id/resize', async (c) => {
    const size = terminalSizeSchema.parse(await c.req.json());
    if (!terminalService.resize(c.req.param('id'), size.cols, size.rows)) {
      return c.json<ApiErrorResponse>(jsonError('Terminal session not found or exited'), 404);
    }
    return c.body(null, 204);
  });

  app.delete('/terminal/sessions/:id', (c) => {
    if (!terminalService.delete(c.req.param('id'))) {
      return c.json<ApiErrorResponse>(jsonError('Terminal session not found'), 404);
    }
    return c.body(null, 204);
  });

  app.get('/terminal/sessions/:id/stream', (c) => {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const subscription = terminalService.subscribe(c.req.param('id'), (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        });
        if (!subscription) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify('Terminal session not found')}\n\n`));
          controller.close();
          return;
        }
        if (subscription.replay) controller.enqueue(encoder.encode(`data: ${JSON.stringify(subscription.replay)}\n\n`));
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000);
        cleanup = () => {
          clearInterval(heartbeat);
          subscription.unsubscribe();
        };
      },
      cancel() {
        cleanup();
      },
    });
    c.req.raw.signal.addEventListener('abort', cleanup, { once: true });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/canvas', async (c) => {
    try {
      const items = await deps.canvasService.listItems();
      return c.json<CanvasListResponse>({ items });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to list canvas items', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/canvas/:filename{.+}', async (c) => {
    try {
      const filename = c.req.param('filename');
      if (!filename) {
        return c.json<ApiErrorResponse>(jsonError('Filename required'), 400);
      }

      const item = await deps.canvasService.getItem(filename);
      if (!item) {
        return c.json<ApiErrorResponse>(jsonError('Canvas item not found'), 404);
      }

      return c.json<CanvasContentResponse>(item);
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read canvas item', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/canvas-files/:filename{.+}', async (c) => {
    const item = await deps.canvasService.locateItem(c.req.param('filename'));
    const blob = item && await openAsBlob(item.path).catch(() => null);
    if (!item || !blob) return c.json<ApiErrorResponse>(jsonError('Canvas item not found'), 404);

    return byteRangeResponse({
      rangeHeader: c.req.header('range'),
      size: blob.size,
      contentType: item.mimeType,
      body: (start, end) => blob.slice(start, end),
    });
  });

  app.put('/canvas/:filename{.+}', async (c) => {
    const filename = c.req.param('filename');
    if (!filename) return c.json<ApiErrorResponse>(jsonError('Filename required'), 400);

    const body = updateTextFileSchema(MAX_CANVAS_PREVIEW_BYTES).parse(await c.req.json());
    const result = await deps.canvasService.updateItem(filename, body.content, body.expectedRevision);
    if (!result) return c.json<ApiErrorResponse>(jsonError('Canvas item is not editable'), 400);
    return c.json<UpdateTextFileResponse>(result);
  });

  app.get('/hooks/status', (c) => {
    const response: HooksStatusResponse = {
      running: okidokiConfigService.areHooksRunning(),
      completed: okidokiConfigService.areHooksCompleted(),
    };
    return c.json<HooksStatusResponse>(response);
  });

  app.get('/version', (c) => {
    const response: EngineVersionResponse = {
      version: ENGINE_ENV.OKIDOKI_SANDBOX_IMAGE_VERSION,
    };
    return c.json<EngineVersionResponse>(response);
  });

  app.get('/environment', async (c) => {
    try {
      const details = await environmentDetailsService.getDetails();
      return c.json<EngineEnvironmentDetails>(details);
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to load environment details', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/credentials/withdraw', async (c) => {
    const { logins } = await c.req.json<EngineWithdrawLoginsRequest>();
    for (const { provider, ...login } of logins) {
      if (await withdrawAgentLogin(provider, login)) await deps.chatService.releaseAgentSessions(provider);
      clearCredentialFallbacks(provider);
    }
    return c.json(await environmentDetailsService.getDetails());
  });

  app.post('/credentials/switch', async (c) => {
    const body = await c.req.json<EngineSwitchCredentialRequest>();
    const provider = workspaceCredentialProviderSchema.safeParse(body.provider);
    if (!provider.success) return c.json<ApiErrorResponse>(jsonError('Unsupported agent'), 400);
    if (deps.chatService.hasActiveAgentWork(provider.data)) {
      return c.json<ApiErrorResponse>(jsonError('Stop this agent’s running chats and clear their queues before switching credentials.'), 409);
    }
    if (body.provider === 'codex') await codexTokenManager.switchCredentials(body.credential);
    else await claudeTokenManager.switchCredentials(body.credential);
    clearCredentialFallbacks(provider.data);
    return c.json(await environmentDetailsService.getDetails());
  });

  app.post('/claude/refresh-now', async (c) => {
    // A reconnected login must not stay behind a fallback or a remembered failure from before it.
    const reconnected = c.req.query('reconnected') === '1';
    if (reconnected) clearCredentialFallbacks('claude');
    const result = await claudeTokenManager.refreshOnce(reconnected);
    if (!result.ok) {
      return c.json<ApiErrorResponse>(jsonError('Failed to refresh Claude credentials', result.error.message), 502);
    }
    return c.json({ success: true, lastSuccessAt: claudeTokenManager.getHealthStatus().lastSuccessAt });
  });

  app.post('/codex/refresh-now', async (c) => {
    try {
      const result = await codexTokenManager.refreshOnce(true);
      if (!result.ok) {
        return c.json<ApiErrorResponse>(
          jsonError('Failed to refresh Codex credentials', result.error.message),
          502,
        );
      }
      const status = codexTokenManager.getHealthStatus();
      return c.json({ success: true, lastSuccessAt: status.lastSuccessAt });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to refresh Codex credentials', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/codex/threads/:threadId/history', async (c) => {
    try {
      return c.json(await readCodexAspThreadHistory(c.req.param('threadId')));
    } catch (error) {
      if (error instanceof CodexThreadNotFoundError) {
        return c.json<ApiErrorResponse>(
          jsonError('Failed to load Codex thread history', error.message),
          404,
        );
      }
      return c.json<ApiErrorResponse>(
        jsonError('Failed to load Codex thread history', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/environment/track', async (c) => {
    try {
      const body = await c.req.json<EngineEnvironmentTrackRequest>();
      await environmentDetailsService.trackEnvironment(body);
      return c.json({ success: true });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to track environment', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/warm-hooks/run', async (c) => {
    try {
      const body = await c.req.json<{
        skills?: string[];
        environmentWarmHook?: string;
        timeoutMs?: number;
      }>();

      const result = await runWarmHooks({
        environmentWarmHook: body.environmentWarmHook,
        timeoutMs: body.timeoutMs,
      });

      return c.json({
        exit_code: result.exitCode,
        output: result.output,
        timed_out: result.timedOut,
      });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to run warm hooks', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/warm-hooks/run/stream', async (c) => {
    try {
      const body = await c.req.json<{
        environmentWarmHook?: string;
        timeoutMs?: number;
      }>();

      return createJsonEventStream(
        (send) => runWarmHooksStreaming({
          environmentWarmHook: body.environmentWarmHook,
          timeoutMs: body.timeoutMs,
          onEvent: (event: WarmHookStreamEvent) => {
            send(event);
          },
        }),
        (error) => ({ data: { type: 'error', data: error instanceof Error ? error.message : 'Unknown error' } }),
      );
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to run warm hooks', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/start-hooks/run/stream', async (c) => {
    try {
      const body = await c.req.json<{
        environmentStartHook?: string;
        timeoutMs?: number;
      }>();

      return createJsonEventStream(
        (send) => okidokiConfigService.runStartHooksStreaming({
          environmentStartHook: body.environmentStartHook,
          timeoutMs: body.timeoutMs,
          onEvent: (event: StartHookStreamEvent) => {
            send(event);
          },
        }),
        (error) => ({ data: { type: 'error', data: error instanceof Error ? error.message : 'Unknown error' } }),
      );
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to run start hooks', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/warm-hooks/logs', async (c) => {
    try {
      const logs = await warmHookLogsService.getAllLogs();
      return c.json<WarmHookLogsResponse>({ logs });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read warm hook logs', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/warm-hooks/current-run/log', async (c) => {
    try {
      const output = await warmHookLogsService.getCurrentRunLog();
      return c.json<WarmHookFullLogResponse>({ output: output ?? '' });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read current warm hook run log', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/warm-hooks/logs/:hookType/:hookName/full', async (c) => {
    try {
      const hookType = c.req.param('hookType');
      const hookName = c.req.param('hookName');
      if (hookType !== 'environment' && hookType !== 'repository') {
        return c.json<ApiErrorResponse>(jsonError('Invalid hookType', 'Must be "environment" or "repository"'), 400);
      }
      const output = await warmHookLogsService.getFullOutput(hookType, hookName);
      if (output === null) {
        return c.json<ApiErrorResponse>(jsonError('Warm hook log not found'), 404);
      }
      return c.json<WarmHookFullLogResponse>({ output });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read warm hook log', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/start-hooks/logs', async (c) => {
    try {
      const logs = await startHookLogsService.getAllLogs();
      return c.json<StartHookLogsResponse>({ logs });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read start hook logs', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/start-hooks/logs/:hookType/:hookName/full', async (c) => {
    try {
      const hookType = c.req.param('hookType');
      const hookName = c.req.param('hookName');
      if (hookType !== 'environment' && hookType !== 'repository') {
        return c.json<ApiErrorResponse>(jsonError('Invalid hookType', 'Must be "environment" or "repository"'), 400);
      }
      const output = await startHookLogsService.getFullOutput(hookType, hookName);
      if (output === null) {
        return c.json<ApiErrorResponse>(jsonError('Start hook log not found'), 404);
      }
      return c.json<StartHookFullLogResponse>({ output });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read start hook log', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  // Retained for older monoliths; workspace names no longer determine branches.
  app.post('/workspace-name', async (c) => {
    return c.json({ success: true, repos: [] });
  });

  app.put('/linear-session', async (c) => {
    const body = z.object({ linearSessionId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json<ApiErrorResponse>(jsonError('linearSessionId is required'), 400);
    setLinearSessionId(body.data.linearSessionId);
    return c.json({ success: true });
  });

  // Preview management
  app.get('/previews', async (c) => {
    try {
      const previews = await previewService.listPreviews();
      return c.json<ListPreviewsResponse>({ previews });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to list previews', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.post('/previews', async (c) => {
    try {
      const body = createPreviewSchema.parse(await c.req.json());
      const preview = await previewService.addPreview(body.port, body.publicUrl);
      return c.json<CreatePreviewResponse>({ preview }, 201);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Unknown error';
      if (details.includes('already exists')) {
        return c.json<ApiErrorResponse>(jsonError('Preview already exists', details), 409);
      }
      return c.json<ApiErrorResponse>(jsonError('Failed to create preview', details), 400);
    }
  });

  app.delete('/previews/:port', async (c) => {
    try {
      const portParam = c.req.param('port');
      const port = parseInt(portParam, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        return c.json<ApiErrorResponse>(jsonError('Invalid port number'), 400);
      }
      const removed = await previewService.removePreview(port);
      if (!removed) {
        return c.json<ApiErrorResponse>(jsonError('Preview not found'), 404);
      }
      return c.json<DeletePreviewResponse>({ success: true, port });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to delete preview', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  // Engine logs
  app.get('/logs', async (c) => {
    try {
      const files = await readdir(LOG_DIR).catch(() => [] as string[]);
      const logFiles = files.filter((f) => f.endsWith('.log'));

      const sessions: EngineLogSessionInfo[] = await Promise.all(
        logFiles.map(async (filename) => {
          const filePath = join(LOG_DIR, filename);
          const fileStat = await stat(filePath);
          const sessionId = filename.replace(/\.log$/, '');
          return {
            sessionId,
            filename,
            sizeBytes: fileStat.size,
            updatedAt: fileStat.mtime.toISOString(),
          };
        }),
      );

      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      return c.json<EngineLogsListResponse>({
        currentSessionId: engineLogger.sessionId,
        sessions,
      });
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to list logs', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  app.get('/logs/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId');
      if (!isValidEngineLogSessionId(sessionId)) {
        return c.json<ApiErrorResponse>(jsonError('Invalid session ID'), 400);
      }

      const filePath = resolve(LOG_DIR, `${sessionId}.log`);
      if (!filePath.startsWith(resolve(LOG_DIR))) {
        return c.json<ApiErrorResponse>(jsonError('Invalid session ID'), 400);
      }
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return c.json<ApiErrorResponse>(jsonError('Log session not found'), 404);
      }

      return c.json<EngineLogReadResponse>(paginateEngineLogContent({
        sessionId,
        content,
        offset: c.req.query('offset'),
        limit: c.req.query('limit'),
      }));
    } catch (error) {
      return c.json<ApiErrorResponse>(
        jsonError('Failed to read log', error instanceof Error ? error.message : 'Unknown error'),
        500,
      );
    }
  });

  return app;
}
