import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { DESKTOP_STREAM_PORT, DEVICE_HOST_KEYS_HEADER, ENGINE_ACTIVATE_PATH, ENGINE_FLUSH_CHAT_TRANSCRIPTS_PATH, ENGINE_FLUSH_WORKSPACE_ARTIFACTS_PATH, ENGINE_HEALTH_MAX_WAIT_MS, ENGINE_HEALTH_WAIT_HEADER, ENGINE_HEALTH_WAIT_QUERY_PARAM, ENGINE_SLEEP_PATH, GITHUB_CREDENTIAL_REFRESH_PATH, EXEC_PROTOCOL_VERSION, EXEC_SOCKET_PATH, GITLAB_CREDENTIAL_REFRESH_PATH, IDENTITY_PROXY_PORT, OKIDOKI_RUNTIME_ENV_ALIASES, createErrorResult, createSuccessResult, isRecord, readOkidokiRuntimeEnv, type ApiErrorResponse, type EngineActivateRequest, type EngineHealthResponse, type EngineLifecycleResponse, type EngineStartupTimings, type EngineStatusSnapshot, type Result } from '@okidoki/shared';
import { randomUUID } from 'crypto';
import { connect } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { WebSocketServer } from 'ws';
import { execAsync } from './utils/exec';
import { githubTokenManager } from './managers/github-token-manager';
import { gitlabTokenManager } from './managers/gitlab-token-manager';
import { claudeTokenManager } from './managers/claude-token-manager';
import { codexTokenManager } from './managers/codex-token-manager';
import { infisicalTokenManager } from './managers/infisical-token-manager';
import { workspaceIdentityTokens } from './workspace-identity-tokens';
import { createIdentityProxy } from './identity-proxy';
import { mcpOAuthTokens } from './mcp-oauth-tokens';
import { ENGINE_ENV, reloadEngineEnv } from './engine-env';
import { readRuntimeEnvFile } from './runtime-env-loader';
import { lifecycle } from './lifecycle';
import { gitService } from './git/service';
import { engineLogger } from './utils/logger';
import { okidokiConfigService } from './services/okidoki-config-service';
import { recordProxyConnection } from './services/network-check';
import { eventService } from './services/event-service';
import { previewService } from './services/preview-service';
import { registerDesktopPreview } from './services/desktop-preview-service';
import { acceptDeviceConnection } from './services/device-relay';
import { connectDevices } from './services/device-service';
import { ChatService } from './services/chat/chat-service';
import { AgentChatActivityTrackerService } from './analytics/agent/activity/agent-chat-activity-tracker-service';
import { uploadAnalytics } from './analytics/analytics-upload';
import { AgentTokenUsageTracker } from './analytics/token-usage/agent-token-usage-tracker';
import { RepoFileService } from './services/repo-file-service';
import { canvasService } from './services/canvas-service';
import { createV1Routes } from './v1-routes';
import { attachExecSocket } from './services/exec/exec-socket';
import { attachTerminalSocket } from './services/terminal-socket';
import { heartbeatService } from './services/heartbeat-service';
import { keepAliveService } from './services/keep-alive-service';
import { configureManagedGitCredentialHelper } from './utils/file';
import { installWorkspaceSdk } from './services/workspace-sdk-service';
import { startGitPushTracker } from './services/git-push-tracker';

// Reset at every activation so /health reports the latest activation's steps.
let startupStartedAt = performance.now();
const startupTimings: EngineStartupTimings['steps'] = {};
// TRANSITION: the monolith passes `--warming` while engines without lifecycle routes remain in
// templates, since that is the only flag those engines park on. Drop the alias once they are gone.
const START_PARKED = process.argv.includes('--parked') || process.argv.includes('--warming');
// Okidoki Personal runs the engine beside the app on this Mac, with no control plane.
const LOCAL = ENGINE_ENV.OKIDOKI_LOCAL;
const PARKED_PATH_PREFIXES = ['/warm-hooks/', '/start-hooks/', '/environment/track'];
// A deleted workspace's sandbox is resumed only to get its chats out, and activating would run start hooks and queued chats.
const SLEEPING_PATHS: string[] = [ENGINE_FLUSH_WORKSPACE_ARTIFACTS_PATH, ENGINE_FLUSH_CHAT_TRANSCRIPTS_PATH];

async function timeStartupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    startupTimings[name] = {
      startedAtMs: startedAt - startupStartedAt,
      durationMs: performance.now() - startedAt,
    };
  }
}

await timeStartupStep('engine_logger_initialize', () => engineLogger.initialize());

// Catch-all handlers so the engine never dies silently.
// Log the error, flush the log, then exit with a non-zero code so the
// orchestrator can detect the failure and restart the process.
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  engineLogger.flush().finally(() => process.exit(1));
});

// Cursor's SDK runs in-process; swallow its background-task rejections instead of crashing the engine mid-turn.
function isCursorSdkRejection(reason: unknown): boolean {
  const text = reason instanceof Error ? `${reason.stack ?? ''}\n${reason.message}` : String(reason);
  return text.includes('@cursor/sdk');
}

process.on('unhandledRejection', (reason) => {
  if (isCursorSdkRejection(reason)) {
    console.error('[CursorSDK] Unhandled rejection (non-fatal):', reason);
    return;
  }
  console.error('[FATAL] Unhandled rejection:', reason);
  engineLogger.flush().finally(() => process.exit(1));
});

await timeStartupStep('event_service_initialize', () => eventService.initialize());

async function checkActiveSSHSessions(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('who | grep -v "^$" | wc -l', { encoding: 'utf-8' });
    const sessionCount = parseInt(stdout.trim(), 10);
    return sessionCount > 0;
  } catch {
    return false;
  }
}

function checkDesktopReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: DESKTOP_STREAM_PORT });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

const app = new Hono();
const bootTimeMs = Date.now();

const authMiddleware = async (c: Context, next: Next) => {
  const secret = c.req.header('X-Okidoki-Engine-Secret');
  if (!secret) {
    return c.json<ApiErrorResponse>({ error: 'Unauthorized: X-Okidoki-Engine-Secret header required' }, 401);
  }

  const activating = c.req.path === ENGINE_ACTIVATE_PATH;
  // A parked engine cloned from a snapshot only knows the snapshot's secret. Writing the new
  // one into the settings file needs sandbox-level access, so that file proves ownership.
  const accepted = secret === ENGINE_ENV.OKIDOKI_ENGINE_SECRET
    || (activating && lifecycle.state === 'parked' && secret === readRuntimeEnvFile()?.values.OKIDOKI_ENGINE_SECRET);
  if (!accepted) {
    return c.json<ApiErrorResponse>({ error: 'Unauthorized: Invalid secret' }, 401);
  }

  if (!lifecycle.active && !activating && c.req.path !== ENGINE_SLEEP_PATH
    && !PARKED_PATH_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
    && !(lifecycle.state === 'sleeping' && SLEEPING_PATHS.includes(c.req.path))) {
    return c.json<ApiErrorResponse>({ error: `Engine is ${lifecycle.state}` }, 503);
  }

  await next();
};

const agentChatActivityTrackerService = new AgentChatActivityTrackerService();
const agentTokenUsageTracker = new AgentTokenUsageTracker(uploadAnalytics);
const chatService = new ChatService(
  gitService.getWorkspaceRoot(),
  agentChatActivityTrackerService,
  agentTokenUsageTracker,
);

app.get('/health', async (c) => {
  const requestedWaitMs = Number(c.req.query(ENGINE_HEALTH_WAIT_QUERY_PARAM));
  const waitMs = Number.isFinite(requestedWaitMs)
    ? Math.min(Math.max(requestedWaitMs, 0), ENGINE_HEALTH_MAX_WAIT_MS)
    : 0;

  if (!lifecycle.active && waitMs > 0) {
    await lifecycle.waitForActive(waitMs);
  }

  c.header(ENGINE_HEALTH_WAIT_HEADER, '1');
  const response: EngineHealthResponse = {
    status: lifecycle.active ? 'active' : 'initializing',
    state: lifecycle.state,
    timestamp: new Date().toISOString(),
    startup: {
      elapsedMs: performance.now() - startupStartedAt,
      steps: startupTimings,
    },
    execProtocol: EXEC_PROTOCOL_VERSION,
  };
  return c.json(response, lifecycle.active ? 200 : 503);
});

app.use('*', authMiddleware);

const lifecycleResponse = (c: Context, result: Result<EngineLifecycleResponse, 400 | 409>) =>
  result.ok ? c.json(result.data) : c.json<ApiErrorResponse>({ error: result.error.message }, result.error.code);

app.post(ENGINE_ACTIVATE_PATH, async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const workspaceId = isRecord(body) && typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  return lifecycleResponse(c, await lifecycle.transition(() => activate(workspaceId === undefined ? undefined : { workspaceId })));
});

app.post(ENGINE_SLEEP_PATH, async (c) => lifecycleResponse(c, await lifecycle.transition(sleep)));

app.get('/status', async (c) => {
  try {
    const [repos, hasActiveSSHSessions, desktopReady] = await Promise.all([
      gitService.listRepos(),
      checkActiveSSHSessions(),
      checkDesktopReady(),
    ]);
    const status: EngineStatusSnapshot = {
      uptimeSeconds: Math.floor((Date.now() - bootTimeMs) / 1000),
      hasActiveSSHSessions,
      activeSseClients: eventService.getSubscriberCount(),
      chatsTotal: chatService.listChats().length,
      chatsProcessing: chatService.getProcessingCount(),
      chatsWithActiveTurn: chatService.getActiveTurnCount(),
      reposTotal: repos.length,
      hooksRunning: okidokiConfigService.areHooksRunning(),
      desktopReady,
    };

    return c.json(status);
  } catch (error) {
    return c.json<ApiErrorResponse>({
      error: 'Failed to get engine status',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

app.get('/token-refresh/health', async (c) => {
  return c.json({
    github: githubTokenManager.getHealthStatus(),
    gitlab: gitlabTokenManager.getHealthStatus(),
    claude: claudeTokenManager.getHealthStatus(),
    codex: codexTokenManager.getHealthStatus(),
    infisical: infisicalTokenManager.getHealthStatus(),
  });
});

app.post(GITHUB_CREDENTIAL_REFRESH_PATH, async (c) => {
  const result = await githubTokenManager.refreshShared(c.req.query('rejected') !== undefined);
  if (!result.ok) {
    return c.json<ApiErrorResponse>({
      error: 'Failed to refresh GitHub credentials',
      details: result.error.message,
    }, 502);
  }
  return c.body(null, 204);
});

app.post(GITLAB_CREDENTIAL_REFRESH_PATH, async (c) => {
  const result = await gitlabTokenManager.refreshShared(c.req.query('rejected') !== undefined);
  if (!result.ok) {
    return c.json<ApiErrorResponse>({
      error: 'Failed to refresh GitLab credentials',
      details: result.error.message,
    }, 502);
  }
  return c.body(null, 204);
});

const repoFileService = new RepoFileService(gitService);
app.route('/', createV1Routes({ chatService, repoFileService, canvasService }));

const port = ENGINE_ENV.OKIDOKI_ENGINE_PORT;

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every stop so a tick still in flight cannot reschedule itself next to a newer chain.
let broadcastGeneration = 0;

function stopStatusBroadcaster(): void {
  broadcastGeneration += 1;
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
}

function startStatusBroadcaster(): void {
  if (broadcastTimer) return;
  const generation = broadcastGeneration;
  let previousRepoStatus = '';
  let previousHookStatus = '';
  let previousEngineStatus = '';
  let lastHooksRunning = okidokiConfigService.areHooksRunning();

  const BROADCAST_INTERVAL_MS = 2000;

  // setTimeout chain (not setInterval) so a slow tick can't overlap the next.
  const scheduleNext = (): void => {
    if (generation === broadcastGeneration) broadcastTimer = setTimeout(tick, BROADCAST_INTERVAL_MS);
  };

  const tick = async (): Promise<void> => {
    try {
      const [repos, hasActiveSSHSessions, desktopReady] = await Promise.all([
        gitService.listRepos(),
        checkActiveSSHSessions(),
        checkDesktopReady(),
      ]);
      if (generation !== broadcastGeneration) return;

      const serialized = JSON.stringify(repos);
      if (serialized !== previousRepoStatus) {
        previousRepoStatus = serialized;
        eventService.publish({
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'repo.status.changed',
          payload: { repos },
        }).catch(() => {});
      }

      const engineStatus: EngineStatusSnapshot = {
        uptimeSeconds: Math.floor((Date.now() - bootTimeMs) / 1000),
        hasActiveSSHSessions,
        activeSseClients: eventService.getSubscriberCount(),
        chatsTotal: chatService.listChats().length,
        chatsProcessing: chatService.getProcessingCount(),
        chatsWithActiveTurn: chatService.getActiveTurnCount(),
        reposTotal: repos.length,
        hooksRunning: okidokiConfigService.areHooksRunning(),
        desktopReady,
      };
      const engineStatusJson = JSON.stringify(engineStatus);
      if (engineStatusJson !== previousEngineStatus) {
        previousEngineStatus = engineStatusJson;
        eventService.publish({
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'engine.status.changed',
          payload: { status: engineStatus },
        }).catch(() => {});
      }

      const hooksRunning = okidokiConfigService.areHooksRunning();
      const hooksCompleted = okidokiConfigService.areHooksCompleted();
      const hooksFailed = okidokiConfigService.didHooksFail();

      const hookSnapshot = JSON.stringify({
        running: hooksRunning,
        completed: hooksCompleted,
        failed: hooksFailed,
      });

      if (hookSnapshot !== previousHookStatus) {
        previousHookStatus = hookSnapshot;

        if (!lastHooksRunning && hooksRunning) {
          eventService.publish({
            id: randomUUID(),
            ts: new Date().toISOString(),
            type: 'hooks.started',
            payload: { running: true, completed: false },
          }).catch(() => {});
        }

        if (hooksRunning) {
          eventService.publish({
            id: randomUUID(),
            ts: new Date().toISOString(),
            type: 'hooks.progress',
            payload: { running: true, completed: false },
          }).catch(() => {});
        }

        if (lastHooksRunning && !hooksRunning && hooksCompleted && !hooksFailed) {
          eventService.publish({
            id: randomUUID(),
            ts: new Date().toISOString(),
            type: 'hooks.completed',
            payload: { running: false, completed: true },
          }).catch(() => {});
        }

        if (lastHooksRunning && !hooksRunning && hooksFailed) {
          eventService.publish({
            id: randomUUID(),
            ts: new Date().toISOString(),
            type: 'hooks.failed',
            payload: { running: false, completed: hooksCompleted },
          }).catch(() => {});
        }

        eventService.publish({
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'hooks.status',
          payload: {
            running: hooksRunning,
            completed: hooksCompleted,
          },
        }).catch(() => {});

        lastHooksRunning = hooksRunning;
      }
    } catch { /* best-effort */ } finally {
      scheduleNext();
    }
  };

  broadcastTimer = setTimeout(tick, BROADCAST_INTERVAL_MS);
}

// Activation can arrive as soon as a parked engine listens, and the routes it opens need the chats loaded.
const engineBooted = Promise.withResolvers<void>();
const tokenManagers = [githubTokenManager, gitlabTokenManager, claudeTokenManager, codexTokenManager, infisicalTokenManager];
let backgroundController: AbortController | undefined;
let backgroundServices: Promise<void> | undefined;
let identityProxyStarted = false;

async function stopWorkspaceServices(): Promise<void> {
  backgroundController?.abort();
  stopStatusBroadcaster();
  heartbeatService.stop();
  keepAliveService.stop();
  // Drain credential writes before a pause or runtime-environment reload can overtake them.
  await backgroundServices;
  await Promise.all(tokenManagers.map((manager) => manager.stop()));
}

async function activate(requested?: EngineActivateRequest): Promise<Result<EngineLifecycleResponse, 400 | 409>> {
  await engineBooted.promise;
  const runtimeEnvFile = readRuntimeEnvFile();
  const workspaceId = runtimeEnvFile
    ? readOkidokiRuntimeEnv((name) => runtimeEnvFile.values[name], OKIDOKI_RUNTIME_ENV_ALIASES.workspaceId)
    : ENGINE_ENV.OKIDOKI_WORKSPACE_ID;
  if (!workspaceId) {
    return createErrorResult({ message: 'Settings file has no workspace id', code: 400 });
  }
  if (requested && requested.workspaceId !== workspaceId) {
    return createErrorResult({ message: `Settings file names workspace ${workspaceId}, not ${requested.workspaceId}`, code: 409 });
  }
  if (lifecycle.workspaceId && lifecycle.workspaceId !== workspaceId) {
    return createErrorResult({ message: `Engine already belongs to workspace ${lifecycle.workspaceId}`, code: 409 });
  }

  // Claimed before the work, not after: a crash partway through activation still restarts
  // into this workspace instead of parking until the next wake that is never coming.
  lifecycle.claim(workspaceId);
  await stopWorkspaceServices();
  // Sockets pooled before a pause were closed remotely while frozen; reusing one fails with ECONNRESET.
  if (!LOCAL) {
    const pausedDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(new Agent());
    void pausedDispatcher.close?.();
  }
  if (runtimeEnvFile) reloadEngineEnv(runtimeEnvFile);
  startupStartedAt = performance.now();
  backgroundController = new AbortController();
  const signal = backgroundController.signal;
  const devicesConnected = connectDevices(signal).catch((error) => {
    if (!signal.aborted) console.error('Connecting devices failed:', error);
  });

  await Promise.all([
    // Start hooks may ssh to a device.
    !okidokiConfigService.areHooksRunning()
      && timeStartupStep('okidoki_config_initialize', () => okidokiConfigService.initialize(devicesConnected)),
    LOCAL
      ? Promise.resolve()
      : timeStartupStep('git_credential_helper_initialize', () =>
          configureManagedGitCredentialHelper(ENGINE_ENV.HOME_DIR)
        ),
    timeStartupStep('git_push_tracker_start', startGitPushTracker),
    // Block readiness on the first GitHub token refresh so hosts.yml exists
    // before any inbound request can hit a diagnostic that checks for it.
    LOCAL ? Promise.resolve() : timeStartupStep('github_token_initialize', () => githubTokenManager.start()),
    // A parked or paused engine started before the hooks that added tools to the login profile.
    timeStartupStep('login_path_reload', async () => {
      const { stdout } = await execAsync(`bash -lc 'printf "\\n%s" "$PATH"'`, { timeout: 10_000 }).catch(() => ({ stdout: '' }));
      const loginPath = stdout.split('\n').pop() ?? '';
      process.env.PATH = [...new Set([...loginPath.split(':'), ...(process.env.PATH ?? '').split(':')].filter(Boolean))].join(':');
    }),
  ]);

  lifecycle.set('active');
  chatService.resumeAfterRestart();
  backgroundServices = Promise.allSettled([
    LOCAL ? Promise.resolve() : registerDesktopPreview(signal),
    devicesConnected,
    startBackgroundServices(signal),
  ]).then((results) => {
    for (const result of results) {
      if (!signal.aborted && result.status === 'rejected') console.error('Engine background startup failed:', result.reason);
    }
  });
  return createSuccessResult({ state: lifecycle.state, workspaceId });
}

/** Runs after readiness so the remaining token refreshers cannot hold up the caller; a sleep that lands mid-way wins. */
async function startBackgroundServices(signal: AbortSignal): Promise<void> {
  if (!LOCAL) {
    heartbeatService.start(bootTimeMs);
    if (!identityProxyStarted) {
      identityProxyStarted = true;
      createIdentityProxy(workspaceIdentityTokens, mcpOAuthTokens)
        .on('error', (error) => console.error('[identity-proxy] failed to listen:', error))
        .listen(IDENTITY_PROXY_PORT, '127.0.0.1');
    }
  }
  if (signal.aborted) return;
  if (!LOCAL) await Promise.all(tokenManagers.slice(1).map((manager) => manager.start()));

  if (signal.aborted) return;
  const repos = await gitService.listRepos();
  for (const event of [
    { type: 'repo.discovered', payload: { repos } },
    { type: 'repo.status.changed', payload: { repos } },
    { type: 'engine.ready', payload: { version: 'v1' } },
  ] as const) {
    if (signal.aborted) return;
    await eventService.publish({ id: randomUUID(), ts: new Date().toISOString(), ...event });
  }

  if (!signal.aborted) startStatusBroadcaster();
}

async function sleep(): Promise<Result<EngineLifecycleResponse, 400 | 409>> {
  if (lifecycle.state === 'parked') {
    return createErrorResult({ message: 'A parked engine has no workspace to sleep', code: 409 });
  }
  lifecycle.set('sleeping');
  lifecycle.releaseClaim();
  await stopWorkspaceServices();
  await engineLogger.flush();
  return createSuccessResult({ state: lifecycle.state, workspaceId: lifecycle.workspaceId });
}

const webSockets = new WebSocketServer({ noServer: true });
const TERMINAL_SOCKET_PATH = /^\/terminal\/sessions\/([^/]+)\/ws$/;
const DEVICE_SOCKET_PATH = /^\/devices\/([^/]+)\/ws$/;

if (LOCAL) {
  // The brain owns this process; if it is force-quit, do not linger on the port.
  setInterval(() => {
    const ppid = process.ppid;
    if (!ppid || ppid === 1) process.exit(0);
  }, 3_000).unref?.();
}

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  async (info) => {
    console.log(`Okidoki Engine running on port ${info.port}${START_PARKED ? ' (parked)' : ''}`);

    if (!LOCAL) await timeStartupStep('workspace_sdk_install', installWorkspaceSdk);
    await timeStartupStep('chat_initialize', () => chatService.initialize());

    // Reset preview ports on startup (processes die on restart)
    await timeStartupStep('preview_initialize', () => previewService.initialize());
    engineBooted.resolve();

    // Every restart — engine crash, OOM, or systemd restarting the whole unit — comes back
    // through the boot unit's park flag. A claim left by the previous run names the workspace
    // that is still live, so re-activate for it rather than waiting on a wake that already ran.
    const claimedWorkspaceId = START_PARKED ? lifecycle.claimedWorkspaceId : null;
    if (START_PARKED && !claimedWorkspaceId) return;
    const result = await lifecycle.transition(() =>
      activate(claimedWorkspaceId ? { workspaceId: claimedWorkspaceId } : undefined));
    if (!result.ok) {
      console.error(`Engine stays parked: ${result.error.message}`);
    }
  }
);

server.on('connection', recordProxyConnection);

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://engine').pathname;
  const sessionId = TERMINAL_SOCKET_PATH.exec(path)?.[1];
  const device = DEVICE_SOCKET_PATH.exec(path)?.[1];
  const exec = path === EXEC_SOCKET_PATH;
  if (!(sessionId || device || exec) || req.headers['x-okidoki-engine-secret'] !== ENGINE_ENV.OKIDOKI_ENGINE_SECRET || !lifecycle.active) {
    socket.end(`HTTP/1.1 ${sessionId || device || exec ? '401 Unauthorized' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
    return;
  }
  webSockets.handleUpgrade(req, socket, head, (ws) => {
    if (exec) attachExecSocket(ws);
    else if (sessionId) attachTerminalSocket(decodeURIComponent(sessionId), ws);
    else if (device) acceptDeviceConnection(decodeURIComponent(device), ws, String(req.headers[DEVICE_HOST_KEYS_HEADER] ?? '').split(',').filter(Boolean));
  });
});
