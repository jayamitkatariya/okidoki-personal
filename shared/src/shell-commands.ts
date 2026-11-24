import { SANDBOX_PATHS } from './sandbox';

export const SHELL_OPAQUE = '\u0000';

export interface ShellCommand {
  argv: string[];
  dir: string | null;
  stdin?: string;
  stdinFile: string | null;
  stdinTarget: string | null;
  writes: Array<{ path: string | null; target: string; content: string; append: boolean }>;
  wrapper: boolean;
  truncated: boolean;
  afterAnd: boolean;
  piped: boolean;
  subshell: boolean;
}

interface Heredoc { strip: boolean; delimiter: string; expand: boolean; body: string }
interface RawCommand { words: string[]; redirects: Array<{ op: string; target: string }>; heredocs: Heredoc[]; pipeFrom?: RawCommand; afterAnd: boolean; subshell: boolean; truncated?: boolean }
interface Scope { src: string; vars: Map<string, string>; dir: string | null; commands: ShellCommand[]; depth: number; subshell: boolean; loopBudget: { left: number } }

const MAX_DEPTH = 8;
const MAX_LOOP_VALUES = 20;
const MAX_LOOP_ITERATIONS = 500;
const OPERATOR = /&&|\|\||;;|\|&|<<<|<<-|<<|&>>|&>|>>|>&|>\||<&|<>|[;&|()<>]/y;
const NAME = /[A-Za-z_]\w*/y;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PREFIX_WORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'exec', 'command', 'builtin', 'nohup']);
const WRAPPER_VALUE_OPTIONS: Record<string, RegExp> = {
  env: /^(?:-[uCS]|--(?:unset|chdir|split-string))$/,
  sudo: /^(?:-[ugCpUrhDRT]|--(?:user|group|close-from|prompt|other-user|role|type|host|chdir|command-timeout))$/,
  nice: /^(?:-n|--adjustment)$/,
  timeout: /^(?:-[sk]|--(?:signal|kill-after))$/,
};
const ANSI_C_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };

export function parseShellScript(script: string, cwd: string | null): ShellCommand[] {
  const scope: Scope = { src: script, vars: new Map(), dir: cwd, commands: [], depth: 0, subshell: false, loopBudget: { left: MAX_LOOP_ITERATIONS } };
  parseUntil(scope, 0, false);
  return scope.commands;
}

export function resolveShellPath(dir: string | null, path: string): string | null {
  if (path.includes(SHELL_OPAQUE)) return null;
  if (!path.startsWith('/') && dir === null) return null;
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${dir}/${path}`).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function stripCommandPrefixes(words: string[]): { argv: string[]; assignments: string[] } {
  const assignments: string[] = [];
  let k = 0;
  while (k < words.length) {
    const word = words[k];
    if (/^[A-Za-z_]\w*=/.test(word)) assignments.push(word);
    else if (WRAPPER_VALUE_OPTIONS[word]) {
      while (words[k + 1]?.startsWith('-')) k += WRAPPER_VALUE_OPTIONS[word].test(words[k + 1]) ? 2 : 1;
      if (word === 'timeout') k++;
    } else if (!PREFIX_WORDS.has(word)) break;
    k++;
  }
  return { argv: words.slice(k), assignments };
}

function indexOrEnd(src: string, search: string, from: number): number {
  const index = src.indexOf(search, from);
  return index < 0 ? src.length : index;
}

function decodeAnsiC(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|[\s\S])/g, (_match, escape: string) => {
    if (escape[0] === 'x' || escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ANSI_C_ESCAPES[escape] ?? escape;
  });
}

function staticOutput(argv: string[], stdin: string | undefined): string | undefined {
  const [name, ...args] = argv;
  if (name === 'cat') return args.length === 0 || (args.length === 1 && args[0] === '-') ? stdin : undefined;
  if (name === 'echo') {
    let newline = true;
    let escapes = false;
    while (/^-[neE]+$/.test(args[0] ?? '')) {
      const flags = args.shift() ?? '';
      if (flags.includes('n')) newline = false;
      if (flags.includes('e')) escapes = true;
    }
    const text = args.join(' ');
    return (escapes ? decodeAnsiC(text) : text) + (newline ? '\n' : '');
  }
  if (name === 'printf' && args.length > 0) {
    const format = decodeAnsiC(args[0]);
    if (/%(?![s%])/.test(format)) return undefined;
    const values = args.slice(1);
    let output = '';
    let next = 0;
    do {
      output += format.replace(/%([s%])/g, (_match, directive: string) => directive === '%' ? '%' : values[next++] ?? '');
    } while (format.includes('%s') && next < values.length);
    return output;
  }
  return undefined;
}

function commandStdin(raw: RawCommand): string | undefined {
  const heredoc = raw.heredocs.at(-1);
  if (heredoc) return heredoc.body;
  const input = raw.redirects.findLast(({ op }) => op === '<<<' || op === '<' || op === '0<');
  if (input) return input.op === '<<<' ? `${input.target}\n` : SHELL_OPAQUE;
  if (raw.pipeFrom) return staticOutput(stripCommandPrefixes(raw.pipeFrom.words).argv, commandStdin(raw.pipeFrom)) ?? SHELL_OPAQUE;
  return undefined;
}

function assign(scope: Scope, assignments: string[]): void {
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    scope.vars.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
}

function emit(scope: Scope, raw: RawCommand): void {
  const { argv } = stripCommandPrefixes(raw.words);
  if (argv.length === 0) return;
  const stdin = commandStdin(raw);
  const output = staticOutput(argv, stdin) ?? SHELL_OPAQUE;
  const stdinFile = raw.redirects.findLast(({ op }) => op === '<' || op === '0<');
  const name = argv[0].split('/').pop() ?? '';
  const flag = SHELLS.has(name) ? argv.findIndex((arg, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) : -1;
  const script = flag > 0 ? argv[flag + 1]
    : SHELLS.has(name) && argv.length === 1 && stdin !== SHELL_OPAQUE ? stdin
    : name === 'eval' ? argv.slice(1).join(' ')
    : undefined;
  const truncated = script !== undefined && (scope.depth >= MAX_DEPTH || raw.truncated === true);
  scope.commands.push({
    argv,
    dir: scope.dir,
    stdin,
    afterAnd: raw.afterAnd,
    stdinFile: stdinFile ? resolveShellPath(scope.dir, stdinFile.target) : null,
    stdinTarget: stdinFile?.target ?? null,
    writes: raw.redirects
      .filter(({ op, target }) => /^(?:1?>|1?>\||1?>>|&>|&>>|>&)$/.test(op) && !/^(?:\d+|-)$/.test(target))
      .map(({ op, target }, index, outputs) => ({ path: resolveShellPath(scope.dir, target), target, content: index === outputs.length - 1 ? output : '', append: op.endsWith('>>') })),
    wrapper: script !== undefined,
    truncated,
    piped: raw.pipeFrom !== undefined,
    subshell: scope.subshell || raw.subshell,
  });

  if (name === 'cd' || name === 'pushd' || name === 'popd') {
    scope.dir = name !== 'popd' && argv[1] && argv[1] !== '-' ? resolveShellPath(scope.dir, argv[1]) : null;
  }
  if (script && !truncated) parseUntil({ src: script, vars: name === 'eval' ? scope.vars : new Map(), dir: scope.dir, commands: scope.commands, depth: scope.depth + 1, subshell: scope.subshell || raw.subshell, loopBudget: scope.loopBudget }, 0, false);
}

function readHeredocBodies(scope: Scope, heredocs: Heredoc[], start: number): number {
  const { src } = scope;
  let position = start;
  for (const heredoc of heredocs) {
    const lines: string[] = [];
    while (position < src.length) {
      const end = indexOrEnd(src, '\n', position);
      const line = heredoc.strip ? src.slice(position, end).replace(/^\t+/, '') : src.slice(position, end);
      position = end + 1;
      if (line === heredoc.delimiter) break;
      lines.push(line);
    }
    heredoc.body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    if (heredoc.expand) heredoc.body = readDoubleQuoted({ ...scope, src: heredoc.body }, 0, null).value;
  }
  return Math.min(position, src.length);
}

function readDoubleQuoted(scope: Scope, start: number, terminator: '"' | null): { value: string; end: number } {
  const { src } = scope;
  let value = '';
  let i = start;
  while (i < src.length && src[i] !== terminator) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === '\n') i += 2;
      else if ('$`\\'.includes(next) || next === terminator) { value += next; i += 2; } else { value += c; i++; }
    } else if (c === '$' || c === '`') {
      const expansion = readExpansion(scope, i, true);
      value += expansion.value;
      i = expansion.end;
    } else {
      value += c;
      i++;
    }
  }
  return { value, end: i };
}

function substitute(scope: Scope, src: string, start: number, closeParen: boolean): { value: string; end: number } {
  const child: Scope = { src, vars: new Map(scope.vars), dir: scope.dir, commands: [], depth: scope.depth + 1, subshell: true, loopBudget: scope.loopBudget };
  const end = parseUntil(child, start, closeParen);
  scope.commands.push(...child.commands);
  const [only] = child.commands;
  const output = child.commands.length === 1 ? staticOutput(only.argv, only.stdin) : undefined;
  return { value: output?.replace(/\n+$/, '') ?? SHELL_OPAQUE, end };
}

function readExpansion(scope: Scope, i: number, inDouble: boolean): { value: string; end: number; quoted?: boolean } {
  const { src } = scope;
  if (src[i] === '`') {
    let inner = '';
    let j = i + 1;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\' && '$`\\'.includes(src[j + 1] ?? '')) { inner += src[j + 1]; j += 2; } else inner += src[j++];
    }
    return { value: substitute(scope, inner, 0, false).value, end: j + 1 };
  }
  const next = src[i + 1];
  if (next === '(') return substitute(scope, src, i + 2, true);
  if (next === '{') {
    const end = indexOrEnd(src, '}', i + 2);
    return { value: scope.vars.get(src.slice(i + 2, end)) ?? SHELL_OPAQUE, end: end + 1 };
  }
  if (next === "'" && !inDouble) {
    let j = i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
    return { value: decodeAnsiC(src.slice(i + 2, j)), end: j + 1, quoted: true };
  }
  if (next === '"' && !inDouble) {
    const { value, end } = readDoubleQuoted(scope, i + 2, '"');
    return { value, end: end + 1, quoted: true };
  }
  NAME.lastIndex = i + 1;
  const name = NAME.exec(src)?.[0];
  if (name) return { value: scope.vars.get(name) ?? SHELL_OPAQUE, end: i + 1 + name.length };
  if (next && /[0-9@*#?$!-]/.test(next)) return { value: SHELL_OPAQUE, end: i + 2 };
  return { value: '$', end: i + 1 };
}

function parseUntil(scope: Scope, start: number, closeParen: boolean, untilDone = false): number {
  const { src } = scope;
  let i = start;
  let line: RawCommand[] = [];
  let current: RawCommand = { words: [], redirects: [], heredocs: [], afterAnd: false, subshell: false };
  let previous: RawCommand | undefined;
  let pendingHeredocs: Heredoc[] = [];
  let word: string | null = null;
  let quoted = false;
  let redirect: string | null = null;
  let parens = 0;
  let keyword: { word: 'do' | 'done'; header?: string[] } | null = null;
  let openLoops = 0;
  let afterOr = false;
  const conditional = new Set<string>();
  const scoped = new Set<string>();

  const append = (text: string, isQuoted = false) => {
    word = (word ?? '') + text;
    quoted ||= isQuoted;
  };
  const endWord = () => {
    if (word === null) return;
    if (redirect === '<<' || redirect === '<<-') {
      const heredoc = { strip: redirect === '<<-', delimiter: word, expand: !quoted, body: '' };
      current.heredocs.push(heredoc);
      pendingHeredocs.push(heredoc);
    } else if (redirect) {
      current.redirects.push({ op: redirect, target: word });
    } else {
      if (current.words.length === 0 && !quoted && (word === 'do' || word === 'done')) keyword = { word, header: previous?.words };
      current.words.push(word);
    }
    word = null;
    quoted = false;
    redirect = null;
  };
  const endCommand = (op?: string) => {
    endWord();
    const done = current;
    if (op === '&') done.subshell = true;
    current = { words: [], redirects: [], heredocs: [], pipeFrom: op === '|' || op === '|&' ? done : undefined, afterAnd: op === '&&', subshell: parens > 0 };
    // An assignment after && or || may be skipped, so once its chain ends its value is unknown. A loop header's separator does not end it.
    const endChain = () => {
      if (op === undefined || ['&&', '|', '|&'].includes(op) || done.words[0] === 'for') return;
      for (const name of conditional) scope.vars.set(name, SHELL_OPAQUE);
      conditional.clear();
    };
    if (done.words.length === 0 && done.redirects.length === 0 && done.heredocs.length === 0) {
      endChain();
      return;
    }
    line.push(done);
    previous = done;
    // Assignments take effect before the next command on the line expands its words.
    const { argv, assignments } = stripCommandPrefixes(done.words);
    const assigned = argv.length === 0 ? assignments
      : ['export', 'declare', 'local', 'readonly'].includes(argv[0]) ? argv.slice(1).filter((arg) => /^[A-Za-z_]\w*=/.test(arg)) : [];
    assign(scope, assigned);
    const names = assigned.map((assignment) => assignment.slice(0, assignment.indexOf('=')));
    if (done.afterAnd || afterOr) for (const name of names) conditional.add(name);
    // A subshell's assignments end with it.
    if (done.subshell) for (const name of names) scoped.add(name);
    if ((op === ')' && parens === 0) || op === '&') {
      for (const name of scoped) scope.vars.set(name, SHELL_OPAQUE);
      scoped.clear();
    }
    afterOr = op === '||';
    endChain();
    // eval runs now, before later assignments on the line; an earlier heredoc has no body yet.
    if (argv[0] === 'eval') {
      if (pendingHeredocs.length > 0) done.truncated = true;
      else {
        for (const raw of line) emit(scope, raw);
        line = [];
      }
    }
  };
  const unrollFor = (header: string[]) => {
    current = { words: [], redirects: [], heredocs: [], afterAnd: false, subshell: parens > 0 };
    flush();
    const words = header.slice(3);
    const literal = header[2] === 'in' && words.length > 0 && words.length <= MAX_LOOP_VALUES && words.every((value) => !value.includes(SHELL_OPAQUE) && !/[\s*?[{]/.test(value));
    const values = literal ? words : [SHELL_OPAQUE];
    // Nested loops multiply, so the iterations of the whole script share one budget.
    scope.loopBudget.left -= values.length;
    if (scope.loopBudget.left < 0) {
      scope.commands.push({ argv: header, dir: scope.dir, stdinFile: null, stdinTarget: null, writes: [], wrapper: true, truncated: true, afterAnd: false, piped: false, subshell: scope.subshell });
      values.splice(0, values.length, SHELL_OPAQUE);
    }
    let end = src.length;
    for (const value of values) {
      scope.vars.set(header[1], value);
      end = parseUntil(scope, i, false, true);
    }
    i = end;
  };
  const takeKeyword = () => {
    const taken = keyword;
    keyword = null;
    return taken;
  };
  const flush = (op?: string) => {
    endCommand(op);
    for (const raw of line) emit(scope, raw);
    line = [];
  };

  while (i < src.length) {
    const { word: boundary, header } = takeKeyword() ?? {};
    if (boundary === 'do') {
      if (header?.[0] === 'for' && /^[A-Za-z_]\w*$/.test(header[1] ?? '')) {
        unrollFor(header);
        continue;
      }
      openLoops++;
    } else if (boundary === 'done') {
      if (openLoops > 0) openLoops--;
      else if (untilDone) {
        flush();
        return i;
      }
    }
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') append(src[i + 1] ?? '', true);
      i += 2;
    } else if (c === "'") {
      const end = indexOrEnd(src, "'", i + 1);
      append(src.slice(i + 1, end), true);
      i = end + 1;
    } else if (c === '"') {
      const { value, end } = readDoubleQuoted(scope, i + 1, '"');
      append(value, true);
      i = end + 1;
    } else if (c === '$' || c === '`') {
      const expansion = readExpansion(scope, i, false);
      append(expansion.value, expansion.quoted);
      i = expansion.end;
    } else if (c === '#' && word === null) {
      i = indexOrEnd(src, '\n', i);
    } else if (c === '\n') {
      endWord();
      i = readHeredocBodies(scope, pendingHeredocs, i + 1);
      pendingHeredocs = [];
      flush('\n');
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === ')' && parens === 0 && closeParen) {
      flush();
      return i + 1;
    } else {
      OPERATOR.lastIndex = i;
      const op = OPERATOR.exec(src)?.[0];
      if (!op) {
        append(c === '~' && word === null && /^(?:[/\s;&|()<>]|$)/.test(src[i + 1] ?? '') ? scope.vars.get('HOME') ?? SANDBOX_PATHS.HOME_DIR : c);
        i++;
        continue;
      }
      const fd = /[<>]/.test(op) && !quoted && /^\d+$/.test(word ?? '') ? word : null;
      if (fd !== null) word = null;
      endWord();
      i += op.length;
      if (/[<>]/.test(op)) redirect = `${fd ?? ''}${op}`;
      else {
        if (op === '(') parens++;
        if (op === ')') parens = Math.max(0, parens - 1);
        endCommand(op);
      }
    }
  }
  flush();
  return i;
}

export type ComputerScreen = 'desktop' | 'mac';

const screenCommands = new Map<string, ComputerScreen[]>();
export function drivesScreen(command: string, screen: ComputerScreen): boolean {
  let screens = screenCommands.get(command);
  if (screens === undefined) {
    screens = parseShellScript(command, null).flatMap(({ wrapper, argv }): ComputerScreen[] => !wrapper && argv[0]?.split('/').pop() === 'okidoki' && argv[1] === 'computer'
      ? [argv[2] === 'mac' ? 'mac' : 'desktop']
      : []);
    if (screenCommands.size >= 5_000) screenCommands.clear();
    screenCommands.set(command, screens);
  }
  return screens.includes(screen);
}
