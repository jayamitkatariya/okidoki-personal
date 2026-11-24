import { spawn } from 'node:child_process';
import { codexReasoningEffortForThinkingLevel, isRecord, type ThinkingLevel } from '@okidoki/shared';
import { AspClient } from './codex-asp/asp-client';
import { uuidV7 } from '../utils/uuid-v7';

export function spawnMuseMsp(workingDirectory: string, env?: Record<string, string>) {
  const child = spawn('muse', ['serve', '--disable-sandbox', '--trust-workspace'], {
    cwd: workingDirectory,
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: '1', NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, client: new AspClient({ stdin: child.stdin, stdout: child.stdout, jsonRpcVersion: '2.0' }) };
}

export async function initializeMuse(client: AspClient, clientName: string, timeoutMs?: number): Promise<void> {
  await client.request('initialize', { clientInfo: { name: clientName, version: '1' } }, { timeoutMs });
  client.notify('initialized');
}

export async function startMuseSession(
  client: AspClient,
  params: { approvalMode: 'allowAll' | 'denyUnmatched'; modelId: string; workspaceRoot: string },
  timeoutMs?: number,
): Promise<string> {
  const result = await client.request('session/start', { commandId: uuidV7(), providerId: 'meta', ...params }, { timeoutMs });
  const sessionId = isRecord(result) && isRecord(result.session) ? result.session.sessionId : undefined;
  if (typeof sessionId !== 'string') throw new Error('Muse did not return a session id.');
  return sessionId;
}

export function museTurnStartParams(sessionId: string, input: Array<Record<string, unknown>>, thinkingLevel: ThinkingLevel | undefined) {
  return { commandId: uuidV7(), sessionId, input, reasoningEffort: codexReasoningEffortForThinkingLevel(thinkingLevel) };
}
