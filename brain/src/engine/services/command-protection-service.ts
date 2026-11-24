import { readFile, stat } from 'fs/promises';
import type {
  CommandProtectionEvaluateRequest,
  CommandProtectionEvaluateResponse,
  CommandProtectionGitContext,
  CommandProtectionGitLookups,
  CommandProtectionRepoState,
} from '@okidoki/shared';
import {
  COMMAND_PROTECTION_MAX_MESSAGE_FILE_BYTES,
  COMMAND_PROTECTION_REPO_GIT_ARGS,
  commandProtectionEvaluateResponseSchema,
  extractCommandProtectionCommandText,
  findCommandProtectionGitLookups,
  findGitCommitSignals,
  findPrMergeSignals,
  findScoutRepoWriteSignals,
  parseCommandProtectionRequest,
  toCommandProtectionRepoState,
  withRetry,
} from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { runGitCommand } from '../git/commands';
import { monolithRequest } from './monolith-service';

const DEFAULT_COMMAND_PROTECTION_BLOCK_MESSAGE = 'Blocked by Okidoki command protection.';
const GATEWAY_ERROR_STATUSES = new Set([502, 503, 504]);
const SCOUT_REPO_WRITE_BLOCK_MESSAGE = 'Scout never clones, commits, pushes, or opens pull requests. Spawn a workspace on an environment that has the repository, or relay this to the thread\'s workspace.';

async function resolveGitContext({ repoDirs, messageFiles }: CommandProtectionGitLookups): Promise<CommandProtectionGitContext | undefined> {
  if (repoDirs.length === 0 && messageFiles.length === 0) return undefined;
  const git = (dir: string, args: string[]) => runGitCommand(args, dir).then((output) => output || null, () => null);
  const [repos, files] = await Promise.all([
    Promise.all(repoDirs.map(async (dir): Promise<[string, CommandProtectionRepoState]> => {
      const outputs = await Promise.all(COMMAND_PROTECTION_REPO_GIT_ARGS.map((args) => git(dir, [...args])));
      return [dir, toCommandProtectionRepoState(outputs)];
    })),
    Promise.all(messageFiles.map(async (path): Promise<Array<[string, string]>> => {
      const info = await stat(path).catch(() => null);
      const content = info?.isFile() && info.size <= COMMAND_PROTECTION_MAX_MESSAGE_FILE_BYTES ? await readFile(path, 'utf8').catch(() => null) : null;
      return content === null ? [] : [[path, content]];
    })),
  ]);
  return { repos: Object.fromEntries(repos), messageFiles: Object.fromEntries(files.flat()) };
}

type CommandProtectionHistoryRecorder = (type: string, payload: Record<string, unknown>) => void;

function failClosed(reason: string, matchedSignals: string[]): CommandProtectionEvaluateResponse {
  return {
    allowed: false,
    enabled: true,
    reason,
    matchedSignals,
  };
}

export async function evaluateCommandProtection(
  request: CommandProtectionEvaluateRequest,
  signal?: AbortSignal,
): Promise<CommandProtectionEvaluateResponse> {
  const parsed = parseCommandProtectionRequest(request);
  const scoutSignals = ENGINE_ENV.OKIDOKI_SCOUT ? findScoutRepoWriteSignals(parsed) : [];
  if (scoutSignals.length > 0) {
    return { allowed: false, enabled: true, reason: SCOUT_REPO_WRITE_BLOCK_MESSAGE, matchedSignals: scoutSignals };
  }
  const gitContext = await resolveGitContext(findCommandProtectionGitLookups(parsed));
  const matchedSignals = [...findGitCommitSignals(parsed), ...findPrMergeSignals(parsed, gitContext).signals];
  if (matchedSignals.length === 0) {
    return { allowed: true, enabled: true };
  }

  let response: Response;
  try {
    response = await withRetry('evaluate', async () => {
      const attempt = await monolithRequest('/v1/engine/command-protection/evaluate', {
        body: { ...request, gitContext },
        signal,
      });
      if (!GATEWAY_ERROR_STATUSES.has(attempt.status)) return attempt;
      throw new Error(`${attempt.status} ${await attempt.text().catch(() => '')}`);
    }, {
      backoffsMs: [500, 1_500],
      retryable: (error) => !signal?.aborted && (error instanceof TypeError || /^50[234] /.test(error instanceof Error ? error.message : '')),
      logPrefix: 'command-protection',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failClosed(`Command protection failed closed: ${detail}`, matchedSignals);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return failClosed(`Command protection failed closed: ${response.status} ${detail}`, matchedSignals);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failClosed(`Command protection failed closed: ${detail}`, matchedSignals);
  }
  const verdict = commandProtectionEvaluateResponseSchema.safeParse(payload);
  return verdict.success
    ? verdict.data
    : failClosed('Command protection failed closed: invalid response from policy service', matchedSignals);
}

export function extractToolCommand(input: unknown): string | null {
  return extractCommandProtectionCommandText({ toolInput: input }, { stringifyFallback: false });
}

export function reportCommandProtectionBlock(options: {
  managerName: string;
  action: string;
  eventType: string;
  result: CommandProtectionEvaluateResponse;
  command: string | null;
  recordHistoryEvent: CommandProtectionHistoryRecorder;
  context?: Record<string, unknown>;
}): string {
  const message = options.result.reason || DEFAULT_COMMAND_PROTECTION_BLOCK_MESSAGE;
  console.warn(`[${options.managerName}] blocked ${options.action} by command protection: ${message}`);
  options.recordHistoryEvent(options.eventType, {
    type: 'error',
    message,
    ...options.context,
    command: options.command,
  });
  return message;
}
