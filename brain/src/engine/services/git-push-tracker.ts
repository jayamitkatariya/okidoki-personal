import { mkdir, rm } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { gitService } from '../git/service';
import { isRecord } from '../utils/type-guards';
import { ENGINE_DIR } from './chat/history-paths';
import { pullRequestCheckService } from './pull-request-check-service';

const SOCKET_PATH = join(ENGINE_DIR, 'git-trace2.sock');
const MAX_LINE_LENGTH = 1024 * 1024;

let listening: Promise<void> | null = null;

// Git skips tracing silently while nothing is listening, so a missing socket never blocks a push.
export function startGitPushTracker(): Promise<void> {
  return listening ??= listen().catch((error) => {
    listening = null;
    console.error('[GitPushTracker] Failed to listen:', error);
  });
}

async function listen(): Promise<void> {
  await mkdir(ENGINE_DIR, { recursive: true });
  await rm(SOCKET_PATH, { force: true });
  const server = createServer((socket) => {
    let buffered = '';
    let ignored = false;
    let push = false;
    let worktree: string | null = null;
    let exitCode: number | null = null;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    // Other commands are drained rather than closed, which could fail git's writes.
    socket.on('data', (chunk: string) => {
      if (ignored) return;
      const lines = (buffered + chunk).split('\n');
      buffered = lines.pop() ?? '';
      if (buffered.length > MAX_LINE_LENGTH) {
        ignored = true;
        buffered = '';
      }
      for (const line of lines) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(event)) continue;
        if (event.event === 'def_repo' && typeof event.worktree === 'string') worktree = event.worktree;
        if ((event.event === 'exit' || event.event === 'atexit') && typeof event.code === 'number') exitCode = event.code;
        if (event.event === 'cmd_name') {
          push = event.name === 'push';
          ignored = !push;
          if (ignored) return;
        }
      }
    });
    socket.on('end', () => {
      if (!push || exitCode !== 0 || !worktree) return;
      gitService.trackPushedRepository(worktree)
        .then(async (tracked) => {
          if (tracked) await pullRequestCheckService.check();
        })
        .catch((error) => console.error('[GitPushTracker] Failed to track pushed repository:', error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      server.off('error', reject);
      server.on('error', (error) => console.error('[GitPushTracker] Socket error:', error));
      resolve();
    });
  });
  process.env.GIT_TRACE2_EVENT = `af_unix:stream:${SOCKET_PATH}`;
}
