import { resolveShellPath, type ShellCommand } from './shell-commands';

const COMMIT_VALUE_OPTIONS = new Set(['message', 'file', 'trailer', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'template', 'author', 'date', 'cleanup', 'pathspec-from-file']);

export interface GitInvocation {
  dir: string | null;
  subcommand: string;
  args: string[];
  command: ShellCommand;
}

export function findGitInvocations(commands: ShellCommand[]): GitInvocation[] {
  return commands.flatMap((command): GitInvocation[] => {
    const { argv } = command;
    if (argv[0].split('/').pop() !== 'git') return [];
    let dir = command.dir;
    let index = 1;
    for (; argv[index]?.startsWith('-'); index++) {
      if (argv[index] === '-C' && argv[index + 1]) dir = resolveShellPath(dir, argv[index + 1]);
      if (/^--(?:git-dir|work-tree)\b/.test(argv[index])) dir = null;
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(argv[index])) index++;
    }
    return argv[index] ? [{ dir, subcommand: argv[index], args: argv.slice(index + 1), command }] : [];
  });
}

export function parseCommitArgs(args: string[]) {
  const messages: string[] = [];
  const trailers: string[] = [];
  let file: string | undefined;
  let reuse = false;
  let amend = false;
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index];
    const long = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (long) {
      const [, name, inline] = long;
      if (name === 'amend') amend = true;
      if (!COMMIT_VALUE_OPTIONS.has(name)) continue;
      const value = inline ?? args[++index] ?? '';
      if (name === 'message') messages.push(value);
      else if (name === 'file') file = value;
      else if (name === 'trailer') trailers.push(value);
      else if (['reuse-message', 'reedit-message', 'fixup', 'squash'].includes(name)) reuse = true;
      continue;
    }
    if (!/^-[^-]/.test(arg)) continue;
    for (let position = 1; position < arg.length && !'Su'.includes(arg[position]); position++) {
      const flag = arg[position];
      if (!'mFCct'.includes(flag)) continue;
      const value = arg.slice(position + 1) || (args[++index] ?? '');
      if (flag === 'm') messages.push(value);
      else if (flag === 'F') file = value;
      else if (flag !== 't') reuse = true;
      break;
    }
  }
  return { messages, trailers, file, reuse, amend };
}

export function parsePushArgs(args: string[]) {
  const positionals: string[] = [];
  const options: string[] = [];
  let all = false;
  let tags = false;
  let repo = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const long = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(arg);
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    } else if (long) {
      const [, name, inline] = long;
      all ||= ['all', 'mirror', 'branches'].includes(name);
      tags ||= name === 'tags';
      repo ||= name === 'repo';
      if (['repo', 'push-option', 'receive-pack', 'exec'].includes(name)) {
        const value = inline ?? args[++index] ?? '';
        if (name === 'push-option') options.push(value);
      }
    } else if (/^-[^-]/.test(arg)) {
      const option = arg.indexOf('o');
      if (option > 0) options.push(arg.slice(option + 1) || (args[++index] ?? ''));
    } else {
      positionals.push(arg);
    }
  }
  return { refspecs: repo ? positionals : positionals.slice(1), options, all, tags };
}

// `certain` is false for a plain `git checkout <name>`, which may restore a file rather than switch branches.
export function findCheckoutTarget(args: string[]): { branch: string | null; certain: boolean } | undefined {
  if (args.includes('--')) return undefined;
  const create = args.findIndex((arg) => /^(?:-[bBcC]|--orphan)$/.test(arg));
  if (create >= 0) return { branch: args[create + 1] ?? null, certain: true };
  if (args.some((arg) => arg === '-' || arg === '--detach' || arg === '-d')) return { branch: null, certain: true };
  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional === undefined ? undefined : { branch: positional, certain: false };
}
