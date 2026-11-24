import { spawn } from 'node:child_process';
import { isRecord } from '@okidoki/shared';
import { AspClient } from './codex-asp/asp-client';

export interface GeminiSession {
  sessionId: string;
  configOptions: unknown[];
}

export function spawnGeminiAcp(workingDirectory: string, env?: Record<string, string>) {
  const child = spawn('agy', ['acp', '--dangerously-skip-permissions', '--disable-telemetry'], {
    cwd: workingDirectory,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1', NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { child, client: new AspClient({ stdin: child.stdin, stdout: child.stdout, jsonRpcVersion: '2.0' }) };
}

export async function initializeGeminiAcp(client: AspClient, timeoutMs?: number): Promise<void> {
  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'okidoki', title: 'Okidoki', version: '1' },
  }, { timeoutMs });
}

export async function startGeminiSession(
  client: AspClient,
  params: { cwd: string; resumeSessionId?: string; systemPrompt?: string },
  timeoutMs?: number,
): Promise<GeminiSession> {
  const request = {
    cwd: params.cwd,
    mcpServers: [],
    ...(params.systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: params.systemPrompt } } } } : {}),
  };
  const result = params.resumeSessionId
    ? await client.request('session/resume', { ...request, sessionId: params.resumeSessionId }, { timeoutMs })
    : await client.request('session/new', request, { timeoutMs });
  const sessionId = params.resumeSessionId ?? (isRecord(result) ? result.sessionId : undefined);
  if (typeof sessionId !== 'string') throw new Error('Antigravity did not return a session id.');
  return { sessionId, configOptions: isRecord(result) && Array.isArray(result.configOptions) ? result.configOptions : [] };
}

export function geminiSelectOption(configOptions: unknown[], category: string) {
  const option = configOptions.find((candidate) => isRecord(candidate) && (candidate.category === category || candidate.id === category));
  if (!isRecord(option) || option.type !== 'select' || typeof option.id !== 'string' || !Array.isArray(option.options)) return null;
  const values = option.options
    .flatMap((entry) => (isRecord(entry) && Array.isArray(entry.options) ? entry.options : [entry]))
    .flatMap((entry) => (isRecord(entry) && typeof entry.value === 'string' ? [entry.value] : []));
  return { id: option.id, currentValue: typeof option.currentValue === 'string' ? option.currentValue : null, values };
}

export async function selectGeminiModel(client: AspClient, session: GeminiSession, model: string, timeoutMs?: number): Promise<void> {
  const option = geminiSelectOption(session.configOptions, 'model');
  if (!option || option.currentValue === model) return;
  if (!option.values.includes(model)) {
    throw new Error(`${model} is not available for this Google account. Available models: ${option.values.join(', ')}.`);
  }
  const result = await client.request('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: model }, { timeoutMs });
  if (isRecord(result) && Array.isArray(result.configOptions)) session.configOptions = result.configOptions;
}
