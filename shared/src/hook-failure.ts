import { DEFAULT_START_HOOK_TIMEOUT_MS, DEFAULT_WARM_HOOK_TIMEOUT_MS } from './warm-hooks';
import type { EnvironmentHookRunKind } from './routes/environment-hook-runs';
import { ENGINE_UNREACHABLE_PATTERN } from './start-hook-network';

export type HookFailureCauseKind =
  | 'engine_unreachable'
  | 'timeout'
  | 'out_of_memory'
  | 'disk_full'
  | 'lockfile_mismatch'
  | 'install_collision'
  | 'missing_secret'
  | 'command_not_found'
  | 'network'
  | 'missing_file'
  | 'exit_code';

export interface HookFailureCause {
  kind: HookFailureCauseKind;
  summary: string;
  fix: string;
  line: string | null;
}

const ERROR_LINE = /\b(error|errors|err!|failed|failure|fatal|panic|exception|traceback|denied|unauthorized|forbidden|killed|not found|no such file|cannot|could not|couldn't|unable to)\b/i;
const ERROR_CODE = /\bE[A-Z]{3,}\b/;
const EXCEPTION_NAME = /\b[A-Z]\w*(Error|Exception)\b/;

export function isErrorLogLine(line: string): boolean {
  return ERROR_LINE.test(line) || ERROR_CODE.test(line) || EXCEPTION_NAME.test(line);
}

export function hookLogTail(output: string, count = 6, focus: string | null = null): string[] {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const at = focus ? lines.findLastIndex((line) => line.trim() === focus) : -1;
  if (at === -1) return lines.slice(-count);
  const start = Math.max(0, Math.min(at - Math.floor(count / 2), lines.length - count));
  return lines.slice(start, start + count);
}

interface Rule {
  kind: Exclude<HookFailureCauseKind, 'timeout' | 'exit_code'>;
  pattern: RegExp;
  describe: (match: RegExpMatchArray, hook: string, output: string) => Pick<HookFailureCause, 'summary' | 'fix'>;
}

const outOfMemory = (hook: string) => ({
  summary: `The ${hook} ran out of memory.`,
  fix: 'Lower its parallelism, or pick a larger workspace size.',
});

const REGISTRY_TOKENS: Array<[RegExp, string]> = [
  [/\bnpm\b|E40[13]|registry\.npmjs|\.npmrc/i, 'NPM_TOKEN'],
  [/yarn/i, 'NPM_TOKEN'],
  [/docker|ghcr\.io|ecr|gcr\.io|manifest/i, 'your container registry token'],
  [/pip|pypi|poetry/i, 'your Python package index token'],
];

const RULES: Rule[] = [
  {
    kind: 'engine_unreachable',
    pattern: ENGINE_UNREACHABLE_PATTERN,
    describe: (match) => ({ summary: match[1], fix: `${match[2]} See ${match[3]}` }),
  },
  {
    kind: 'out_of_memory',
    pattern: /out of memory|JavaScript heap out of memory|Killed\s*$|oom-kill|exit code 137|signal 9|Cannot allocate memory/im,
    describe: (_, hook) => outOfMemory(hook),
  },
  {
    kind: 'disk_full',
    pattern: /ENOSPC|No space left on device/i,
    describe: () => ({
      summary: 'The workspace ran out of disk space.',
      fix: 'Clear caches as part of the hook, or pick a larger workspace size.',
    }),
  },
  {
    kind: 'lockfile_mismatch',
    pattern: /ERR_PNPM_OUTDATED_LOCKFILE|can only install with an existing package-lock\.json|ERR_PNPM_LOCKFILE|npm ci` can only install|package\.json and package-lock\.json[^\n]*not in sync|lockfile needs to be updated|lockfile had changes, but lockfile is frozen|Cannot install with ["']?frozen-lockfile|poetry\.lock[^\n]*(not consistent|out of date)|Cargo\.lock needs to be updated|Gemfile\.lock[^\n]*(frozen|changed)/i,
    describe: () => ({
      summary: 'The lockfile is missing or out of date.',
      fix: 'Commit an up-to-date lockfile, or install without the frozen-lockfile flag.',
    }),
  },
  {
    kind: 'install_collision',
    pattern: /Extracting tar content of \S+ failed, the file appears to be corrupt/i,
    describe: (_, hook) => ({
      summary: `Another yarn install ran at the same time as the ${hook} and they broke each other's package cache.`,
      fix: 'Run the hook again once the other install finishes, or pass `--mutex network` to every yarn command that can overlap.',
    }),
  },
  {
    kind: 'missing_secret',
    pattern: /E401|E403|401 Unauthorized|403 Forbidden|unauthorized: authentication required|denied: (requested access|permission)|authentication (required|failed)|could not read Username|Permission denied \(publickey\)|invalid (credentials|token)|bad credentials|status code 40[13]|you do not have permission to access/i,
    describe: (match, _, output) => {
      const token = REGISTRY_TOKENS.find(([pattern]) => pattern.test(match.input ?? ''))?.[1]
        ?? REGISTRY_TOKENS.find(([pattern]) => pattern.test(output))?.[1];
      return {
        summary: 'A registry or remote rejected the credentials.',
        fix: token
          ? `Add or update ${token} in Variables & secrets.`
          : 'Add or update the token it needs in Variables & secrets.',
      };
    },
  },
  {
    kind: 'command_not_found',
    pattern: /(?:^|:\s)([\w./@+-]+): (?:command )?not found\s*$/m,
    describe: (match, hook) => ({
      summary: `\`${match[1]}\` isn't installed in the workspace.`,
      fix: `Install it earlier in the ${hook}, or call it by its full path.`,
    }),
  },
  {
    kind: 'missing_file',
    pattern: /'(\/[^'\n]+)'[^\n]*?(?:ENOENT|No such file or directory)|(?:ENOENT|No such file or directory)[^\n]*?'(\/[^'\n]+)'|(\/[^:\n]+): No such file or directory|(?:ENOENT|No such file or directory)[^\n]*?(?:open |stat )?(\/[\w./@+-]+)/i,
    describe: (match, hook) => ({
      summary: `\`${match.slice(1).find(Boolean)}\` doesn't exist when the ${hook} runs.`,
      fix: 'Check the hook’s working directory, cd into your repository if needed, or fix the path.',
    }),
  },
  {
    kind: 'network',
    pattern: /Could not resolve host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|Temporary failure in name resolution|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Connection timed out|network is unreachable|TLS handshake timeout/i,
    describe: () => ({
      summary: 'A download failed.',
      fix: 'Try again. If it keeps failing, check the URL and your network settings.',
    }),
  },
];

export function classifyHookFailure(params: {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  hook: EnvironmentHookRunKind;
}): HookFailureCause {
  const hook = `${params.hook} hook`;
  if (params.timedOut) {
    const minutes = (params.hook === 'warm' ? DEFAULT_WARM_HOOK_TIMEOUT_MS : DEFAULT_START_HOOK_TIMEOUT_MS) / 60_000;
    return {
      kind: 'timeout',
      summary: `The ${hook} ran past its ${minutes}-minute limit.`,
      fix: 'Move slow steps out of it, or cache their results.',
      line: null,
    };
  }
  const lines = params.output.split(/\r?\n/).slice(-200);
  for (const rule of RULES) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = lines[i].match(rule.pattern);
      if (match) return { kind: rule.kind, ...rule.describe(match, hook, params.output), line: lines[i].trim() };
    }
  }
  if (params.exitCode === 137) {
    return { kind: 'out_of_memory', ...outOfMemory(hook), line: null };
  }
  // Tools print advice after the error (pip's PEP 668 note), so back up from the last error line to the start of its block.
  let at = lines.findLastIndex(isErrorLogLine);
  while (at > 0 && isErrorLogLine(lines[at - 1])) at -= 1;
  return {
    kind: 'exit_code',
    summary: params.exitCode === null ? `The ${hook} failed.` : `The ${hook} exited with code ${params.exitCode}.`,
    fix: at === -1 ? 'The end of the log shows where it stopped.' : 'The highlighted log lines show where it stopped.',
    line: at === -1 ? null : lines[at].trim(),
  };
}
