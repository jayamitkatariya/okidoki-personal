import { describeAuthFallback } from '../auth-fallback';
import { describeSwitchNotice } from './chat-thread';
import type { CodexAspTranscriptPatchOperation } from '../engine/v1';
import { formatTurnElapsed } from '../format';
import { parseShellScript, resolveShellPath, SHELL_OPAQUE, type ShellCommand } from '../shell-commands';
import { skillNameFromFilePath, stringifyDisplayValue } from './parsers/utils';
import type { DisplayMessage, InterruptionMessage, PeerMessage, QuotaStatusMessage, Status, TodoItemStatus, UserMessage } from './types';

export function userMessageText(message: UserMessage): string {
  return message.cancelled ? `[Cancelled before it started]\n\n${message.content}` : message.content;
}

export function describeQuotaStatus(message: QuotaStatusMessage): string {
  return message.state === 'rate_limited'
    ? `Codex hit a rate limit${message.rateLimitResetType ? ` (${message.rateLimitResetType})` : ''} — try again after reset`
    : 'Codex is out of credits — top up your OpenAI account to resume';
}

export type PlanItem = { text: string; status: TodoItemStatus };

export type DisplayMessageActivity = {
  kind: 'command' | 'tool' | 'file' | 'search' | 'task' | 'plan' | 'error';
  title: string;
  summary: string;
  content: string;
  items?: PlanItem[];
};

export function planItemsFromMessage(message: DisplayMessage): PlanItem[] | null {
  if (message.type === 'todo_list') {
    return message.items.map((item) => ({ text: item.text, status: todoItemStatus(item) }));
  }
  if (message.type !== 'tool_call' || (message.tool !== 'TodoWrite' && message.tool !== 'write_todos')) return null;
  const input = typeof message.input === 'object' ? message.input : null;
  const todos = Array.isArray(input?.todos) ? input.todos : null;
  if (!todos) return null;
  return todos.flatMap((todo): PlanItem[] => {
    if (!todo || typeof todo !== 'object') return [];
    const text = 'content' in todo && typeof todo.content === 'string' ? todo.content : 'text' in todo && typeof todo.text === 'string' ? todo.text : null;
    const status = 'status' in todo ? todo.status : null;
    if (!text) return [];
    return [{ text, status: status === 'completed' || status === 'in_progress' ? status : 'pending' }];
  });
}

export function peerChatName(message: PeerMessage): string {
  return message.chat ?? 'another chat';
}

export function peerMessagePreview(message: PeerMessage): string | undefined {
  // Agents often open with the sender's name, which the row already shows.
  const senderPrefix = message.direction === 'received' && message.chat ? `${message.chat}:` : undefined;
  return message.content.split('\n').map((line) => {
    const text = line.replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, '').trim();
    return senderPrefix && text.startsWith(senderPrefix) ? text.slice(senderPrefix.length).trim() : text;
  }).find(Boolean);
}

export function getDisplayMessageStatus(message: DisplayMessage): Status | undefined {
  if (message.type === 'error' || message.type === 'quota_status') return 'failed';
  if (message.type === 'auth_fallback') return message.status === 'switched' ? 'completed' : 'failed';
  if (message.type === 'interruption' || message.type === 'multitask_event' || message.type === 'harness_switch' || message.type === 'model_fallback') return 'completed';
  if (message.type === 'background_task') return message.status === 'stopped' ? 'completed' : message.status;
  if (message.type === 'command' || message.type === 'patch') {
    return message.status ?? (message.exitCode === undefined ? 'in_progress' : message.exitCode === 0 ? 'completed' : 'failed');
  }
  return 'status' in message ? message.status : undefined;
}

function todoItemStatus(item: { completed: boolean; itemStatus?: TodoItemStatus }): TodoItemStatus {
  return item.itemStatus ?? (item.completed ? 'completed' : 'pending');
}

export function getDisplayMessageActivity(message: DisplayMessage): DisplayMessageActivity | null {
  if (message.type === 'user' || message.type === 'agent' || message.type === 'reasoning') return null;
  if (message.type === 'command') return { kind: 'command', title: 'Command', summary: message.command, content: message.output ?? '' };
  if (message.type === 'patch') {
    const operations = message.operations.map((operation) => `${operation.action.toUpperCase()} ${operation.path}${operation.moveTo ? ` → ${operation.moveTo}` : ''}${operation.diff ? `\n${operation.diff}` : ''}`).join('\n\n');
    return { kind: 'file', title: 'Apply patch', summary: message.operations.map((operation) => operation.path).join(', '), content: [operations, message.output].filter(Boolean).join('\n\n') };
  }
  if (message.type === 'file_change') return { kind: 'file', title: 'File changes', summary: message.changes.map((change) => change.path).join(', '), content: message.changes.map((change) => `${change.kind.toUpperCase()} ${change.path}`).join('\n') };
  if (message.type === 'tool_call') return { kind: 'tool', title: `Tool · ${message.tool}`, summary: message.server, content: [stringifyDisplayValue(message.input), message.output].filter(Boolean).join('\n\n') };
  if (message.type === 'web_search') return { kind: 'search', title: 'Web search', summary: message.query, content: '' };
  if (message.type === 'todo_list') {
    const items = planItemsFromMessage(message) ?? [];
    return { kind: 'plan', title: 'Plan', summary: `${items.filter((item) => item.status === 'completed').length}/${items.length}`, content: '', items };
  }
  if (message.type === 'subagent') return { kind: 'task', title: 'Subagent', summary: message.description, content: [message.prompt, message.model ? `Model: ${message.model}` : '', message.receiverThreadIds?.length ? `Threads: ${message.receiverThreadIds.join(', ')}` : '', message.output].filter(Boolean).join('\n\n') };
  if (message.type === 'background_task') return { kind: 'task', title: message.description ?? message.summary ?? 'Background task', summary: message.taskType ?? '', content: [message.prompt, message.outputFile, message.error].filter(Boolean).join('\n\n') };
  if (message.type === 'skill') return { kind: 'tool', title: `Skill · ${message.skillName}`, summary: message.args ?? '', content: '' };
  if (message.type === 'quota_status') {
    const rateLimited = message.state === 'rate_limited';
    return { kind: 'error', title: rateLimited ? 'Codex rate limit' : 'Codex credits', summary: '', content: `${describeQuotaStatus(message)}.` };
  }
  if (message.type === 'auth_fallback') {
    const { headline, outcomeClause } = describeAuthFallback(message);
    return { kind: 'error', title: message.toModel ? 'Model fallback' : 'Credential fallback', summary: headline, content: [`The workspace ${outcomeClause}.`, message.detail].filter(Boolean).join('\n\n') };
  }
  if (message.type === 'harness_switch' || message.type === 'model_fallback') return { kind: 'error', title: describeSwitchNotice(message), summary: '', content: '' };
  if (message.type === 'interruption') return { kind: 'error', title: 'Agent stopped', summary: '', content: '' };
  if (message.type === 'capacity_retry') return { kind: 'task', title: message.reason ? `${message.reason[0].toUpperCase()}${message.reason.slice(1)}` : 'Model at capacity', summary: `Retry ${message.attempt} of ${message.maxAttempts}`, content: '' };
  if (message.type === 'peer_message') return { kind: 'task', title: `${message.direction === 'received' ? 'Message from' : 'Message to'} ${peerChatName(message)}`, summary: '', content: message.content };
  if (message.type === 'multitask_event') return { kind: 'task', title: 'Ship update', summary: message.events.map((event) => `${event.agentName}: ${event.summary}`).join(' · '), content: '' };
  return { kind: 'error', title: 'Agent error', summary: '', content: message.message };
}

export function formatStoppedAfter({ durationMs, steered }: InterruptionMessage): string {
  const after = durationMs === undefined ? '' : ` after ${formatTurnElapsed(durationMs)}`;
  return steered ? `Stopped${after} for your next message` : `You stopped${after}`;
}

export function lineCountFromOutput(output: string | undefined): number | null {
  if (!output) return null;
  let end = output.length;
  while (end > 0 && output[end - 1] === '\n') end--;
  if (end === 0) return null;
  let lines = 1;
  for (let i = 0; i < end; i++) {
    if (output[i] === '\n') lines++;
  }
  return lines;
}

const PARENT_QUALIFIED_FILE_NAMES = new Set([
  'skill.md',
  'skills.md',
  'agent.md',
  'agents.md',
  'claude.md',
  'readme.md',
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'page.tsx',
  'layout.tsx',
  'route.ts',
  'mod.rs',
  '__init__.py',
]);

export function getFileLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const parts = trimmed.split('/');
  const name = parts.at(-1) || trimmed;
  return PARENT_QUALIFIED_FILE_NAMES.has(name.toLowerCase()) && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}

export function fileContentDiff(path: string, content: string, action: 'add' | 'delete'): string {
  const lines = content.replace(/\n$/, '').split('\n');
  return [
    `--- ${action === 'add' ? '/dev/null' : `a/${path}`}`,
    `+++ ${action === 'add' ? `b/${path}` : '/dev/null'}`,
    action === 'add' ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `${action === 'add' ? '+' : '-'}${line}`),
  ].join('\n');
}

export const plural = (count: number, word: string, suffix = 's') => `${count} ${word}${count === 1 ? '' : suffix}`;

export function isRawFileContent(diff: string, action: 'add' | 'delete'): boolean {
  const lines = diff.split('\n');
  return !lines[0].startsWith('diff --git ')
    && !(lines[0].startsWith('--- ') && lines[1]?.startsWith('+++ '))
    && !(action === 'add' && lines.every((line) => line === '' || line.startsWith('+')));
}

export function operationDiffStats({ diff, action }: CodexAspTranscriptPatchOperation): { added: number; removed: number } | undefined {
  if (!diff) return undefined;
  if (action === 'update' || !isRawFileContent(diff, action)) return getDiffStats(diff);
  const lines = diff.replace(/\n$/, '').split('\n').length;
  return action === 'add' ? { added: lines, removed: 0 } : { added: 0, removed: lines };
}

export function getDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let lineStart = 0;
  for (let i = 0; i <= diff.length; i++) {
    if (i !== diff.length && diff[i] !== '\n') continue;
    const first = diff[lineStart];
    const hunk = first === '@' ? /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(diff.slice(lineStart, i)) : null;
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    } else if (oldLeft > 0 || newLeft > 0) {
      if (first === '+') {
        added++;
        newLeft--;
      } else if (first === '-') {
        removed++;
        oldLeft--;
      } else if (first === ' ') {
        oldLeft--;
        newLeft--;
      }
    } else if (!diff.startsWith('+++', lineStart) && !diff.startsWith('---', lineStart)) {
      if (first === '+') added++;
      else if (first === '-') removed++;
    }
    lineStart = i + 1;
  }
  return { added, removed };
}

export interface CommandDisplay {
  title: string;
  paths: string[];
}

const READ_COMMANDS = new Set([
  'cat',
  'find',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'tail',
  'tree',
  'wc',
]);

const SEARCH_COMMANDS = new Set(['grep', 'rg']);

const LIST_COMMANDS = new Set(['find', 'ls', 'tree']);

const PIPE_FILTERS = new Set(['awk', 'cat', 'column', 'cut', 'grep', 'head', 'jq', 'nl', 'rg', 'sed', 'sort', 'tail', 'tr', 'uniq', 'wc']);

const NEUTRAL_COMMANDS = new Set(['cd', 'echo', 'printf', 'true']);

const GIT_READ_COMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'ls-files',
  'show',
  'status',
]);

const GH_READ_COMMANDS = new Set([
  'api',
  'issue',
  'pr',
  'repo',
  'run',
]);

const LINE_COUNT_VALUE_FLAGS = new Set(['-c', '-n', '--bytes', '--lines']);

// Options that take the next word as their value, per command: the same letter can differ, like -A (a count for grep, a boolean for cat).
const SEARCH_VALUE_FLAGS = ['-A', '-B', '-C', '-d', '-e', '-f', '-m', '--after-context', '--before-context', '--context', '--file', '--max-count', '--regexp'];
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  grep: new Set([...SEARCH_VALUE_FLAGS, '-D', '--devices', '--directories', '--exclude', '--exclude-dir', '--include']),
  rg: new Set([...SEARCH_VALUE_FLAGS, '-E', '-M', '-T', '-g', '-j', '-t', '--encoding', '--glob', '--iglob', '--max-columns', '--max-depth', '--sort', '--sortr', '--threads', '--type', '--type-add', '--type-not']),
  head: LINE_COUNT_VALUE_FLAGS,
  tail: LINE_COUNT_VALUE_FLAGS,
  ls: new Set(['-I', '-T', '-w', '--hide', '--ignore', '--tabsize', '--width']),
  nl: new Set(['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w']),
  tree: new Set(['-I', '-L', '-P', '--filelimit']),
};

// A pattern given as an option leaves every positional word a path.
const PATTERN_FLAGS = new Set(['-e', '-f', '--file', '--regexp']);

const SCRIPT_ROOT = '/\u0001';

const commandName = (argv: string[]) => argv[0].split('/').pop() ?? argv[0];
const fileWrites = ({ writes }: ShellCommand) => writes.filter(({ path }) => path !== '/dev/null');

function displayPath(dir: string | null, path: string): string | null {
  if (path.startsWith('~')) return path;
  const resolved = resolveShellPath(dir, path);
  if (resolved === null) return null;
  if (resolved === SCRIPT_ROOT) return '.';
  if (resolved.startsWith(`${SCRIPT_ROOT}/`)) return resolved.slice(SCRIPT_ROOT.length + 1);
  return path.startsWith('/') ? resolved : null;
}

function shellCommands(command: string): ShellCommand[] {
  return parseShellScript(command, SCRIPT_ROOT).filter(({ wrapper }) => !wrapper);
}

function simpleCommands(command: string) {
  const commands = shellCommands(command);
  const hasRedirectOrSubshell = commands.some((shellCommand) => shellCommand.subshell || shellCommand.stdinFile !== null
    || (!shellCommand.piped && shellCommand.stdin !== undefined) || fileWrites(shellCommand).length > 0);
  if (commands.length === 0 || hasRedirectOrSubshell) return null;
  return commands.map((shellCommand) => {
    const argv = shellCommand.argv.map((word) => word.replaceAll(SHELL_OPAQUE, '…'));
    return { ...shellCommand, argv, name: commandName(argv) };
  });
}

const SKILL_READ_COMMANDS = new Set(['awk', 'bat', 'cat', 'head', 'less', 'more', 'nl', 'sed', 'tail']);

export function skillNamesFromCommand(command: string): string[] {
  return Array.from(new Set(shellCommands(command).flatMap((shellCommand) => {
    const argv = shellCommand.argv.map((word) => word.replaceAll(SHELL_OPAQUE, '…'));
    const name = argv[0] ? commandName(argv) : '';
    if (!SKILL_READ_COMMANDS.has(name) || writesFiles(name, argv) || fileWrites(shellCommand).length > 0) return [];
    const paths = readCommandPaths(name, argv);
    const stdinTarget = shellCommand.stdinTarget?.replaceAll(SHELL_OPAQUE, '…');
    return (paths.length === 0 && stdinTarget ? [stdinTarget] : paths).flatMap((path) => {
      const resolved = path.startsWith('~') ? path : resolveShellPath(shellCommand.dir, path)?.replace(SCRIPT_ROOT, '');
      const skillName = resolved && skillNameFromFilePath(resolved);
      return skillName ? [skillName] : [];
    });
  })));
}

function pathArgs(command: string, words: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // In a group like -rn or -bn, the first letter that takes a value takes the rest of the word, or the next word when it's last.
    const valueAt = /^-[A-Za-z]{2,}$/.test(word) ? [...word.slice(1)].findIndex((letter) => VALUE_FLAGS[command]?.has(`-${letter}`)) : -1;
    if (VALUE_FLAGS[command]?.has(word) || (valueAt >= 0 && valueAt === word.length - 2)) {
      i++;
      continue;
    }
    if (word.startsWith('-')) continue;
    paths.push(word);
  }
  return Array.from(new Set(paths));
}

function readCommandPaths(command: string, words: string[]): string[] {
  if (SEARCH_COMMANDS.has(command)) {
    const args = pathArgs(command, words.slice(1));
    return words.some((word) => PATTERN_FLAGS.has(word) || /^-[A-Za-z]+[ef]$/.test(word) || /^--(file|regexp)=/.test(word)) ? args : args.slice(1);
  }
  if (command === 'find') {
    // Paths come before the expression, which starts at the first test or action, "(" or "!".
    const paths = words.slice(1).filter((word) => !/^(-[HLP]|-O\d|--)$/.test(word));
    const expression = paths.findIndex((word) => word.startsWith('-') || word === '(' || word === '!');
    return expression === -1 ? paths : paths.slice(0, expression);
  }
  if (command === 'sed') {
    const paths: string[] = [];
    let sawScript = false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (word === '-n' || word.startsWith('-n')) continue;
      if (word === '-e' || word === '-f' || word === '--expression' || word === '--file') {
        i++;
        sawScript = true;
        continue;
      }
      if (word.startsWith('--expression=') || word.startsWith('--file=')) {
        sawScript = true;
        continue;
      }
      if (word.startsWith('-')) continue;
      if (!sawScript) {
        sawScript = true;
        continue;
      }
      paths.push(word);
    }
    return Array.from(new Set(paths));
  }
  return pathArgs(command, words.slice(1));
}

function readTitle(search: boolean, output: string | undefined, paths: string[]): string {
  const lines = lineCountFromOutput(output);
  if (lines) return `Read ${lines} line${lines === 1 ? '' : 's'}${paths.length > 1 ? ` from ${paths.length} files` : ''}`;
  return search
    ? 'Search'
    : paths.length > 1
      ? `Read ${paths.length} files`
      : 'Read';
}

function writtenFile(command: string): string | null {
  const [write, ...rest] = shellCommands(command).filter(({ argv }) => !['cd', 'mkdir'].includes(commandName(argv)));
  if (!write || rest.length > 0 || write.piped || write.subshell || write.stdinFile !== null) return null;
  if (!['cat', 'echo', 'printf'].includes(commandName(write.argv))) return null;
  const writes = fileWrites(write);
  return writes.length === 1 && writes[0].path ? displayPath(write.dir, writes[0].target) : null;
}

function writesFiles(name: string, argv: string[]): boolean {
  if (name === 'sed') return argv.some((word) => /^(-[a-zA-Z]*i|--in-place)/.test(word));
  return name === 'find' && argv.some((word) => /^-(exec|ok|delete|fprint|fls)/.test(word));
}

export function commandDisplayFromCommand(command: string, output?: string): CommandDisplay | null {
  const written = writtenFile(command);
  if (written) return { title: 'Write', paths: [written] };
  const commands = simpleCommands(command);
  if (!commands || commands.some(({ name, argv, piped }) => writesFiles(name, argv) || (piped && !PIPE_FILTERS.has(name)))) return null;
  const mainCommands = commands.filter(({ name, piped }) => !piped && !NEUTRAL_COMMANDS.has(name));
  if (mainCommands.length === 0) return null;

  if (mainCommands.length === 1) {
    const [{ name, argv: words }] = mainCommands;
    if (name === 'git' && words[1] && GIT_READ_COMMANDS.has(words[1])) {
      return { title: `Git ${words[1]}`, paths: [] };
    }
    if (name === 'gh' && words[1] && GH_READ_COMMANDS.has(words[1])) {
      return { title: words[1] === 'pr' && words[2] ? `GitHub PR ${words[2]}` : 'GitHub', paths: [] };
    }
  }
  if (!mainCommands.every(({ name }) => READ_COMMANDS.has(name))) return null;

  const paths = new Set<string>();
  for (const { name, argv, dir } of mainCommands) {
    for (const path of readCommandPaths(name, argv)) {
      const shown = displayPath(dir, path);
      if (shown === null) return null;
      paths.add(shown);
    }
  }
  if (mainCommands.every(({ name }) => LIST_COMMANDS.has(name))) return { title: 'List', paths: [...paths] };
  const search = mainCommands.every(({ name }) => SEARCH_COMMANDS.has(name));
  return { title: readTitle(search, output, [...paths]), paths: [...paths] };
}

export function fileNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || path;
}
