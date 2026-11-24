import { z } from 'zod';
import { shellQuotePosix } from '../runtime-env';
import { isRecord } from '../type-guards';
import { findCheckoutTarget, findGitInvocations, parseCommitArgs, parsePushArgs, type GitInvocation } from '../git-invocations';
import { parseShellScript, resolveShellPath, SHELL_OPAQUE, type ShellCommand } from '../shell-commands';

const commandProtectionRepoStateSchema = z.object({
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  pushBranch: z.string().nullable(),
  pushConfig: z.string().nullable(),
  headMessage: z.string().nullable(),
  mergeInProgress: z.boolean().optional(),
});

const commandProtectionEvaluateRequestSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi', 'harness']),
  source: z.enum(['claude_pre_tool_use', 'codex_approval_request', 'cursor_pre_tool_use', 'gemini_pre_tool_use', 'opencode_pre_tool_use', 'pi_tool_call', 'harness_tool_call']),
  toolName: z.string(),
  toolInput: z.unknown(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  toolUseId: z.string().nullish(),
  // Read by the engine before the command runs, keyed by absolute path, so the
  // policy can see branches and commit messages the command text only references.
  gitContext: z.object({
    repos: z.record(z.string(), commandProtectionRepoStateSchema),
    messageFiles: z.record(z.string(), z.string()),
  }).optional(),
});

export type CommandProtectionRepoState = z.infer<typeof commandProtectionRepoStateSchema>;
export type CommandProtectionEvaluateRequest = z.infer<typeof commandProtectionEvaluateRequestSchema>;
export type CommandProtectionGitContext = NonNullable<CommandProtectionEvaluateRequest['gitContext']>;

export const commandProtectionEvaluateResponseSchema = z.object({
  allowed: z.boolean(),
  enabled: z.boolean(),
  reason: z.string().optional(),
  matchedSignals: z.array(z.string()).optional(),
});
export type CommandProtectionEvaluateResponse = z.infer<typeof commandProtectionEvaluateResponseSchema>;

export function isCommandProtectionEvaluateRequest(value: unknown): value is CommandProtectionEvaluateRequest {
  return commandProtectionEvaluateRequestSchema.safeParse(value).success;
}

const COMMAND_PROTECTION_COMMAND_KEYS = ['command', 'cmd', 'script', 'query', 'endpoint', 'path', 'url', 'mutation'] as const;

export function stringifyCommandProtectionInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeCommandProtectionText(text: string): string {
  return text
    .replace(/\\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function extractCommandProtectionCommandText(
  request: Pick<CommandProtectionEvaluateRequest, 'command' | 'toolInput'>,
  options: { stringifyFallback?: boolean } = {},
): string | null {
  if (request.command && request.command.trim()) return request.command;
  const input = request.toolInput;
  if (isRecord(input)) {
    for (const key of COMMAND_PROTECTION_COMMAND_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
    }
    if (isRecord(input.args)) {
      const nested = extractCommandProtectionCommandText({ toolInput: input.args }, options);
      if (nested) return nested;
    }
  }
  if (typeof input === 'string') return input;
  return options.stringifyFallback ? stringifyCommandProtectionInput(input) : null;
}

const PROTECTED_BRANCH = /^(?:main|master|trunk|develop)$/;
const TRAILER_LINE = /^[a-z0-9][\w-]*:[^\S\n]*\S/i;
const AUTO_MERGE_PUSH_OPTION = /merge_when_pipeline_succeeds|auto_merge/i;
// Push options also come from `push.pushOption` config, set earlier or through `git -c`.
const CONFIGURED_AUTO_MERGE_PUSH_OPTION = /^push\.pushoption[ =].*(?:merge_when_pipeline_succeeds|auto_merge)/im;

const MERGE_SIGNAL_CHECKS: Array<[string, RegExp]> = [
  ['gh-pr-merge', /\bgh\s+pr\s+merge\b/],
  ['glab-mr-merge', /\bglab\s+mr\s+merge\b/],
  ['gh-api-pulls-merge', /\bgh\s+api\b[\s\S]*\/pulls\/(?:\d+|[^/\s]+)\/merge\b/],
  ['github-rest-pulls-merge', /api\.github\.com\/repos\/[^/\s]+\/[^/\s]+\/pulls\/(?:\d+|[^/\s]+)\/merge\b/],
  ['gitlab-rest-mr-merge', /\/projects\/[^/\s]+\/merge_requests\/(?:\d+|[^/\s]+)\/merge\b/],
  ['gitlab-rest-mr-merge-query', /\/projects\/[^/\s]+\/merge_requests\/(?:\d+|[^/\s]+)\b[\s\S]*\bmerge_when_pipeline_succeeds\b/],
  ['github-rest-ref-update', /\b(?:gh\s+api|curl|wget|python3?)\b[\s\S]*(?:\/repos\/|repos\/)[^/\s]+\/[^/\s]+\/git\/refs\/heads\/(?:main|master|trunk|develop)\b[\s\S]*\b(?:patch|put|sha|oid|force)\b/],
  ['github-graphql-merge-pr', /\bmergepullrequest\b/],
  ['github-graphql-enable-auto-merge', /\benablepullrequestautomerge\b/],
  ['github-graphql-enqueue-pr', /\benqueuepullrequest\b/],
  ['github-graphql-update-ref', /\bupdateref\b/],
  ['hub-merge', /\bhub\s+merge\b/],
  ['obfuscated-gh-pr-merge', /printf\s+['"]?\\x67\\x68['"]?[\s\S]*\bpr\b[\s\S]*printf\s+['"]?m\\x65rge['"]?/],
  ['mcp-merge-tool', /\bmcp__[^\s"]*merge[^\s"]*\b/],
];

// Broad catch-alls that route anything merge-like to the classifier. In shell
// commands they skip git itself: a local git merge/pull/rebase cannot land
// code, and git pushes are judged by their resolved destination instead.
const BROAD_MERGE_SIGNAL_CHECKS: Array<[string, RegExp]> = [
  ['git-push-default-branch-text', /\bgit\s+push\b[^;&|\n]*?\s(?:\S+:)?(?:refs\/heads\/)?(?:main|master|trunk|develop)\b/],
  ['tool-merge-name', /\b(pr|pull[_-]?request|mr|merge[_-]?request).{0,40}\bmerge\b|\bmerge.{0,40}(pr|pull[_-]?request|mr|merge[_-]?request)\b/],
  ['merge-word', /(?:^|[^a-z0-9])merge(?:$|[^a-z0-9])/],
];

// A request's command, parsed once and shared by every check. Parsing does not
// depend on git context, so the engine parses before it reads that context.
export interface ParsedCommandProtectionRequest {
  request: CommandProtectionEvaluateRequest;
  // Null for tools that are not shell commands (task lists, MCP calls, file
  // writes): they may mention commands, but never run one.
  script: string | null;
  workingDirectory: string | null;
  commands: ShellCommand[];
  invocations: GitInvocation[];
  // Part of the script is nested too deeply to read, so it may run anything.
  truncated: boolean;
}

export interface CommandProtectionGitLookups {
  repoDirs: string[];
  messageFiles: string[];
}

function shellScript(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!isRecord(input)) return null;
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.map(shellQuotePosix).join(' ');
  }
  return isRecord(input.args) ? shellScript(input.args) : null;
}

function workingDirectory({ toolInput, cwd }: CommandProtectionEvaluateRequest): string | null {
  const input = isRecord(toolInput) ? toolInput : {};
  const dir = [input.workdir, input.cwd].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return dir ? resolveShellPath(cwd || null, dir) : cwd || null;
}

export function parseCommandProtectionRequest(request: CommandProtectionEvaluateRequest): ParsedCommandProtectionRequest {
  const script = shellScript(request.toolInput);
  const dir = workingDirectory(request);
  const commands = script === null ? [] : parseShellScript(script, dir);
  return { request, script, workingDirectory: dir, commands, invocations: findGitInvocations(commands), truncated: commands.some(({ truncated }) => truncated) };
}

const isProtectedBranch = (branch: string, repo: CommandProtectionRepoState | undefined) => branch === repo?.defaultBranch || PROTECTED_BRANCH.test(branch);

// The branch checked out when each invocation runs: the one checked out before
// the command, followed through the checkouts and switches inside it. A plain
// `git checkout <name>` may restore a file rather than switch, so it only moves
// the branch when that cannot hide a default-branch push.
function trackCheckedOutBranches(commands: ShellCommand[], invocations: GitInvocation[], context: CommandProtectionGitContext | undefined) {
  const switches = new Map<string | null, { branch: string | null; before: string | null; index: number }>();
  return invocations.map(({ dir, subcommand, args, command }) => {
    const repo = dir === null ? undefined : context?.repos[dir];
    const index = commands.indexOf(command);
    const last = switches.get(dir);
    // A switch that can fail without stopping this invocation leaves it on the previous branch.
    const mayStayOnBefore = last !== undefined && !commands.slice(last.index + 1, index + 1).every(({ afterAnd }) => afterAnd);
    const branch = last === undefined
      ? repo?.branch ?? null
      : mayStayOnBefore && (last.before === null || isProtectedBranch(last.before, repo)) ? null : last.branch;
    const target = subcommand === 'checkout' || subcommand === 'switch' ? findCheckoutTarget(args) : undefined;
    if (target) {
      const trusted = target.certain || isProtectedBranch(target.branch ?? '', repo) || (branch !== null && !isProtectedBranch(branch, repo));
      switches.set(dir, { branch: trusted ? target.branch : null, before: branch, index });
    }
    return { branch, switched: last !== undefined };
  });
}

// '*' pushes every matching branch, null is unknown, undefined is not a branch.
function refspecDestination(refspec: string, current: string | null): string | null | undefined {
  const spec = refspec.replace(/^\+/, '');
  const destination = spec.slice(spec.indexOf(':') + 1);
  if (destination === '' || destination.includes('*')) return '*';
  if (destination.includes(SHELL_OPAQUE)) return null;
  if (destination === 'HEAD' || destination === '@') return current;
  return destination.startsWith('refs/tags/') ? undefined : destination.replace(/^refs\/heads\//, '');
}

function findPushSignals({ commands, invocations, truncated }: ParsedCommandProtectionRequest, context: CommandProtectionGitContext | undefined): string[] {
  const branches = trackCheckedOutBranches(commands, invocations, context);
  const signals = invocations.flatMap(({ dir, subcommand, args, command }, index) => {
    if (subcommand === 'config') {
      return args.some((arg) => /^push\.pushoption$/i.test(arg)) && args.some((arg) => AUTO_MERGE_PUSH_OPTION.test(arg)) ? ['git-push-auto-merge'] : [];
    }
    if (subcommand !== 'push') return [];
    const repo = dir === null ? undefined : context?.repos[dir];
    const { branch, switched } = branches[index];
    const { refspecs, options, all, tags } = parsePushArgs(args);
    const pushSignals: string[] = [];
    if (all) pushSignals.push('git-push-all');
    if (options.some((option) => AUTO_MERGE_PUSH_OPTION.test(option))
      || CONFIGURED_AUTO_MERGE_PUSH_OPTION.test([repo?.pushConfig ?? '', ...command.argv].join('\n'))) {
      pushSignals.push('git-push-auto-merge');
    }
    // A bare push follows @{push}, unless push refspecs or `push.default matching` make it unknown.
    const bareDestination = /^remote\..+\.push |^push\.default matching$/m.test(repo?.pushConfig ?? '') ? null : switched ? branch : repo?.pushBranch ?? branch;
    const destinations = refspecs.length > 0 ? refspecs.map((refspec) => refspecDestination(refspec, branch)) : all || tags ? [] : [bareDestination];
    for (const destination of destinations) {
      if (destination === '*') pushSignals.push('git-push-all');
      else if (destination === null) pushSignals.push('git-push-unknown-destination');
      else if (destination !== undefined && isProtectedBranch(destination, repo)) pushSignals.push('git-push-default-branch');
    }
    return pushSignals;
  });
  return truncated ? [...signals, 'git-push-unknown-destination'] : signals;
}

const apiMethod = (args: string[]) => /(?:^|\s)(?:-X\s*|--method[\s=])(\w+)/i.exec(args.join(' '))?.[1]?.toUpperCase();

function isPrMergeCommand(argv: string[]): boolean {
  const name = argv[0].split('/').pop();
  if (name !== 'gh' && name !== 'glab') return false;
  const args = argv.slice(1);
  if (args.includes('--help') || args.includes('-h')) return false;
  const words = args.filter((arg, index) => !arg.startsWith('-') && !/^(?:-R|--repo)$/.test(args[index - 1] ?? ''));
  if (words[0] === (name === 'gh' ? 'pr' : 'mr') && words[1] === 'merge') return true;
  return words[0] === 'api' && apiMethod(args) === 'PUT' && words.some((word) => /\/(?:pulls|merge_requests)\/[^/]+\/merge$/.test(word));
}

const matchingChecks = (checks: Array<[string, RegExp]>, text: string) => checks.flatMap(([name, pattern]) => pattern.test(text) ? [name] : []);

// The words and input of the commands that run, minus git (judged structurally
// above) and parsed shells (represented by their own commands).
function executedText(commands: ShellCommand[], keepWord: (word: string) => boolean = () => true): string {
  return commands
    .filter(({ argv, wrapper, truncated }) => (!wrapper || truncated) && argv[0].split('/').pop() !== 'git')
    .map(({ argv, stdin }) => normalizeCommandProtectionText([...argv.filter(keepWord), stdin ?? ''].join(' ').replaceAll(SHELL_OPAQUE, ' ')))
    .join('\n');
}

function findShellMergeSignals(parsed: ParsedCommandProtectionRequest, context: CommandProtectionGitContext | undefined): string[] {
  // Paths and directory changes name places, not actions, so a repository
  // called `merge-service` does not look like a merge.
  const actions = parsed.commands.filter(({ argv }) => !['cd', 'pushd'].includes(argv[0].split('/').pop() ?? ''));
  return [...new Set([
    ...matchingChecks(MERGE_SIGNAL_CHECKS, executedText(parsed.commands)),
    ...matchingChecks(BROAD_MERGE_SIGNAL_CHECKS, executedText(actions, (word) => !word.includes('/'))),
    ...parsed.commands.some(({ argv }) => isPrMergeCommand(argv)) ? ['pr-merge-command'] : [],
    ...findPushSignals(parsed, context),
  ])];
}

function findToolMergeSignals({ toolName, toolInput }: CommandProtectionEvaluateRequest): string[] {
  // File tools only read or write the workspace; merge wording in their content is inert.
  if (/^(?:read|write|edit|multi_?edit|patch|apply_?patch|glob|grep|ls|list|notebook_?edit)$/i.test(toolName)) return [];
  const checks = [...MERGE_SIGNAL_CHECKS, ...BROAD_MERGE_SIGNAL_CHECKS];
  return [...new Set([...matchingChecks(checks, toolName.toLowerCase()), ...matchingChecks(checks, normalizeCommandProtectionText(stringifyCommandProtectionInput(toolInput)))])]
    .sort((a, b) => checks.findIndex(([name]) => name === a) - checks.findIndex(([name]) => name === b));
}

// Parsed from commands that will run, so their effect is certain and needs no judge.
const DEFINITE_MERGE_REASONS: Record<string, string> = {
  'git-push-default-branch': 'The command pushes to the default branch.',
  'git-push-auto-merge': 'The command enables auto-merge through a git push option.',
  'pr-merge-command': 'The command merges a pull request or merge request.',
};

// `signals` route the call to the merge policy; `definiteReasons` explain the
// ones certain enough to deny without asking a judge.
export function findPrMergeSignals(parsed: ParsedCommandProtectionRequest, context: CommandProtectionGitContext | undefined): { signals: string[]; definiteReasons: string[] } {
  const signals = parsed.script === null ? findToolMergeSignals(parsed.request) : findShellMergeSignals(parsed, context);
  return { signals, definiteReasons: signals.flatMap((signal) => DEFINITE_MERGE_REASONS[signal] ?? []) };
}

export function findGitCommitSignals({ invocations, truncated }: ParsedCommandProtectionRequest): string[] {
  return truncated || invocations.some(({ subcommand }) => subcommand === 'commit') ? ['git-commit'] : [];
}

const SCOUT_BLOCKED_GIT_SUBCOMMANDS = new Set(['clone', 'push']);
const SCOUT_BLOCKED_HOST_COMMANDS: Record<string, string[]> = {
  gh: ['repo clone', 'repo fork', 'pr create', 'pr new'],
  glab: ['repo clone', 'repo fork', 'mr create', 'mr new'],
};

// Scout triages and hands work off, so copying a repository or publishing changes to one is always a workspace's job.
export function findScoutRepoWriteSignals(parsed: ParsedCommandProtectionRequest): string[] {
  const { commands, invocations } = parsed;
  return [...new Set([
    ...findGitCommitSignals(parsed),
    ...invocations.flatMap(({ subcommand }) => SCOUT_BLOCKED_GIT_SUBCOMMANDS.has(subcommand) ? [`git-${subcommand}`] : []),
    ...commands.flatMap(({ argv }) => {
      const name = argv[0].split('/').pop() ?? '';
      const args = argv.slice(1);
      const words = args.filter((arg, index) => !arg.startsWith('-') && !/^(?:-R|--repo)$/.test(args[index - 1] ?? ''));
      const command = words.slice(0, 2).join(' ');
      if (SCOUT_BLOCKED_HOST_COMMANDS[name]?.includes(command)) return [`${name}-${command.replace(' ', '-')}`];
      if (name !== 'gh' || words[0] !== 'api' || !words.some((word) => /\/pulls\/?$/.test(word))) return [];
      // `gh api` sends a POST whenever it has fields, unless a method says otherwise.
      const method = apiMethod(args);
      const hasFields = args.some((arg) => /^(?:-[fF]|--(?:raw-)?field(?:=|$)|--input(?:=|$))/.test(arg));
      return (method ? method === 'POST' : hasFields) ? ['gh-api-create-pull-request'] : [];
    }),
  ])];
}

// Repositories and commit message files the engine should read before asking
// the policy service, since the command text only references them.
export const COMMAND_PROTECTION_REPO_GIT_ARGS = [
  ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
  ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'],
  ['config', '--get-regexp', '^(push\\.default|push\\.pushoption|remote\\..+\\.push)$'],
  ['log', '-1', '--format=%B'],
  ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'],
] as const;
export const COMMAND_PROTECTION_MAX_MESSAGE_FILE_BYTES = 64 * 1024;

export function toCommandProtectionRepoState(outputs: readonly (string | null)[]): CommandProtectionRepoState {
  const [branch, originHead, pushBranch, pushConfig, headMessage, mergeHead] = outputs.map((output) => output || null);
  return {
    branch: branch ?? null,
    defaultBranch: originHead?.match(/^origin\/(.+)$/)?.[1] ?? null,
    pushBranch: pushBranch?.replace(/^[^/]+\//, '') ?? null,
    pushConfig: pushConfig ?? null,
    headMessage: headMessage ?? null,
    mergeInProgress: Boolean(mergeHead),
  };
}

function catSources({ argv, dir, writes }: ShellCommand): Array<string | null> | null {
  const args = argv.slice(1);
  return writes.length > 0 && argv[0].split('/').pop() === 'cat' && args.length > 0 && args.every((arg) => !arg.startsWith('-'))
    ? args.map((arg) => resolveShellPath(dir, arg))
    : null;
}

export function findCommandProtectionGitLookups({ commands, invocations }: ParsedCommandProtectionRequest): CommandProtectionGitLookups {
  const writes = invocations.filter(({ subcommand }) => subcommand === 'commit' || subcommand === 'push');
  const messageFiles = writes.flatMap(({ subcommand, args, dir, command }) => {
    const { file } = subcommand === 'commit' ? parseCommitArgs(args) : { file: undefined };
    const path = file === '-' ? command.stdinFile : file === undefined ? null : resolveShellPath(dir, file);
    return path ? [path] : [];
  });
  const sources = writes.some(({ subcommand }) => subcommand === 'commit') ? commands.flatMap((command) => catSources(command) ?? []) : [];
  return {
    repoDirs: [...new Set(writes.flatMap(({ dir }) => dir === null ? [] : [dir]))],
    messageFiles: [...new Set([...messageFiles, ...sources.filter((path) => path !== null)])],
  };
}

export function shouldRefreshPullRequests(toolName: string, toolInput: unknown): boolean {
  const name = toolName.toLowerCase();
  if (/(?:^|[_-])(?:(?:create|open|submit)[_-]?(?:pr|pull[_-]?request|mr|merge[_-]?request)|(?:pr|pull[_-]?request|mr|merge[_-]?request)[_-]?(?:create|open|submit)|(?:checkout|create|switch)[_-]?branch|branch[_-]?(?:checkout|create|switch))(?:$|[_-])/.test(name)) return true;

  const command = normalizeCommandProtectionText(extractCommandProtectionCommandText({ toolInput }) ?? '');
  return [
    /\bgit\s+push\b/,
    /\bgit\s+(?:branch|checkout|switch|pull|merge|rebase|reset)\b/,
    /\bgit\s+worktree\s+add\b/,
    /\bgh(?:\s+(?:-r|--repo)\s+\S+)?\s+pr\s+(?:checkout|create|new|ready|reopen)\b/,
    /\b(?:glab|gitlab)(?:\s+(?:-r|--repo)\s+\S+)?\s+mr\s+(?:checkout|create)\b/,
    /\bhub\s+pull-request\b/,
    /\b(?:tea\s+pulls|bb\s+pr|az\s+repos\s+pr)\s+create\b/,
    /\bmutation\b[\s\S]*\b(?:createpullrequest|mergerequestcreate)\b/,
  ].some((pattern) => pattern.test(command))
    || (/\b(?:gh\s+api|glab\s+api|curl)\b/.test(command)
      && /(?:-x|--method|--request)[\s=]+['"]?post\b/.test(command)
      && /\/(?:pulls|merge_requests)\b/.test(command));
}

function findMissingCoAuthorEmailsInMessage(message: string, requiredEmails: string[]): string[] {
  const lines = message.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const coAuthorEmail = (line: string) => /^co-authored-by:[^<]*<([^>]+)>\s*$/i.exec(line)?.[1]?.trim().toLowerCase();
  const present = new Set(lines.map(coAuthorEmail));
  const absent = requiredEmails.filter((email) => !present.has(email));
  if (absent.length > 0) return absent;
  let blockStart = lines.length;
  while (blockStart > 0 && TRAILER_LINE.test(lines[blockStart - 1])) blockStart--;
  const block = new Set(lines.slice(blockStart).map(coAuthorEmail));
  return requiredEmails.every((email) => block.has(email)) ? [] : requiredEmails;
}

// The message a commit records before any --trailer, with SHELL_OPAQUE wherever
// it was not visible before the command ran.
function commitMessageBody(
  { dir, command }: GitInvocation,
  { messages, file, reuse, amend }: ReturnType<typeof parseCommitArgs>,
  readFile: (path: string | null) => string,
  context: CommandProtectionGitContext | undefined,
): string {
  if (messages.length > 0) return messages.join('\n\n');
  if (file === '-') return command.stdinFile ? readFile(command.stdinFile) : command.stdin ?? SHELL_OPAQUE;
  if (file !== undefined) return readFile(resolveShellPath(dir, file));
  if (amend && !reuse && dir !== null) return context?.repos[dir]?.headMessage ?? SHELL_OPAQUE;
  return SHELL_OPAQUE;
}

// Like git, joins an existing final trailer block instead of starting a new paragraph.
function appendTrailers(body: string, trailers: string[]): string {
  if (trailers.length === 0) return body;
  const message = body.trimEnd();
  return `${message}${TRAILER_LINE.test(message.split('\n').at(-1) ?? '') ? '\n' : '\n\n'}${trailers.map((trailer) => trailer.replace(/^([\w-]+)\s*[=:]\s*/, '$1: ')).join('\n')}`;
}

export function checkCommitCoAuthors(
  { commands, invocations, truncated }: ParsedCommandProtectionRequest,
  context: CommandProtectionGitContext | undefined,
  requiredCoAuthors: Array<{ email: string }>,
): { missingEmails: string[]; unreadable: boolean } {
  const requiredEmails = requiredCoAuthors.map(({ email }) => email.trim().toLowerCase()).filter(Boolean);
  if (requiredEmails.length === 0) return { missingEmails: [], unreadable: false };
  // An unread script may commit anything.
  if (truncated) return { missingEmails: requiredEmails, unreadable: true };
  const invocationOf = new Map(invocations.map((invocation) => [invocation.command, invocation]));
  // Replays the command's effects that decide which commits count: merges it
  // starts, repositories it creates, and files it writes before committing.
  const merging = new Set(Object.entries(context?.repos ?? {}).flatMap(([dir, repo]) => repo.mergeInProgress ? [dir] : []));
  const scratch = new Set<string | null>();
  const files = new Map<string, string>();
  const readFile = (path: string | null) => (path ? files.get(path) ?? context?.messageFiles[path] : undefined) ?? SHELL_OPAQUE;
  const missing = new Set<string>();
  let unreadable = false;
  const checkCommit = (commit: GitInvocation) => {
    const commitArgs = parseCommitArgs(commit.args);
    // Help and dry runs record nothing, a repository this command just created
    // is a scratch test rather than the workspace's history, and concluding a
    // merge with its prepared message records the same merge commit `git merge`
    // would have, which is not checked either.
    const concludesMerge = commit.dir !== null && merging.has(commit.dir) && commitArgs.messages.length === 0
      && commitArgs.trailers.length === 0 && commitArgs.file === undefined && !commitArgs.reuse && !commitArgs.amend;
    if (concludesMerge || scratch.has(commit.dir) || commit.args.some((arg) => arg === '-h' || arg === '--help' || arg === '--dry-run')) return;
    const message = appendTrailers(commitMessageBody(commit, commitArgs, readFile, context), commitArgs.trailers);
    const missingEmails = findMissingCoAuthorEmailsInMessage(message, requiredEmails);
    for (const email of missingEmails) missing.add(email);
    unreadable ||= missingEmails.length > 0 && message.includes(SHELL_OPAQUE);
  };

  for (const command of commands) {
    const invocation = invocationOf.get(command);
    if (invocation?.subcommand === 'commit') checkCommit(invocation);
    else if ((invocation?.subcommand === 'merge' || invocation?.subcommand === 'pull') && invocation.dir !== null) merging.add(invocation.dir);
    else if (invocation?.subcommand === 'init') {
      const path = invocation.args.find((arg) => !arg.startsWith('-'));
      scratch.add(path ? resolveShellPath(invocation.dir, path) : invocation.dir);
    }
    const sources = catSources(command);
    // Bash empties `>` targets before cat reads them.
    const output = sources?.some((source) => command.writes.some(({ path }) => path === source)) ? SHELL_OPAQUE : sources?.map(readFile).join('');
    command.writes.forEach(({ path, content, append }, index) => {
      if (path) files.set(path, (append ? readFile(path) : '') + (index === command.writes.length - 1 ? output ?? content : content));
    });
  }
  return { missingEmails: requiredEmails.filter((email) => missing.has(email)), unreadable };
}
