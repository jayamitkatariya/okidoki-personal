import { parseMessageOrigin } from './message-origin';
import { parseUserMessage, readChatForkEnvelope } from './user-message-parser';
import type { NonMergedParsedPrompt } from './user-message-parser/types';

const USER_CAP = 8000;
const USER_TAIL = 2000;
const AGENT_CAP = 4000;
const LABEL_CAP = 300;
const OUTPUT_LINES = 5;
const OUTPUT_CAP = 400;
const TOOL_INPUT_CAP = 200;
const ERROR_LINES = 3;
const ERROR_LINE_CAP = 200;
const LINKS_PER_ACTIVITY = 5;
const OUTPUT_BUDGET = 16000;
const PATCH_MAX_CHANGED = 15;
const PATCH_LINE_CAP = 200;
const PATCH_BUDGET = 6000;
const FACT_CAP = 300;
const MAX_PR_REFS = 40;

const W = '[\\p{L}\\p{N}_]';
const NOT_BEFORE = `(?<!${W})`;
const NOT_AFTER = `(?!${W})`;

const URL_RE = new RegExp(`https?://(?:github\\.com/[\\p{L}\\p{N}_.\\-]+/[\\p{L}\\p{N}_.\\-]+/(?:pull|issues|commit)/[0-9a-f]+|gitlab\\.[\\p{L}\\p{N}_.\\-]+/[\\p{L}\\p{N}_./\\-]+?/-/(?:merge_requests|issues)/\\d+|linear\\.app/[\\p{L}\\p{N}_\\-]+/issue/[\\p{L}\\p{N}_\\-]+)`, 'gu');
const PR_URL_RE = new RegExp(`https?://github\\.com/([\\p{L}\\p{N}_.\\-]+/[\\p{L}\\p{N}_.\\-]+)/pull/(\\d+)|https?://gitlab\\.[\\p{L}\\p{N}_.\\-]+/([\\p{L}\\p{N}_./\\-]+?)/-/merge_requests/(\\d+)`, 'gu');
const PR_NUM_RE = new RegExp(`(?:${NOT_BEFORE}PR|${NOT_BEFORE}pull request|${NOT_BEFORE}MR)\\s*[#!]?(\\d{1,6})${NOT_AFTER}|(?<![\\p{L}\\p{N}_/#&])#(\\d{2,6})${NOT_AFTER}`, 'giu');
const ERR_RE = new RegExp(`${NOT_BEFORE}(errors?|failed|failures?|fail|fails|exception|traceback|denied|not found|fatal|panic|cannot|unable to|refused|timed out)${NOT_AFTER}`, 'iu');
const BENIGN_RE = new RegExp(`${NOT_BEFORE}0\\s+(?:fail${W}*|errors?)${NOT_AFTER}|${NOT_BEFORE}no errors?${NOT_AFTER}|${NOT_BEFORE}errors?:\\s*0${NOT_AFTER}|${NOT_BEFORE}fail(?:ed|ures)?:\\s*0${NOT_AFTER}|${NOT_BEFORE}0 failed${NOT_AFTER}`, 'giu');
const BROWSE = new Set(['sed', 'cat', 'head', 'tail', 'nl', 'rg', 'grep', 'ls', 'find', 'wc', 'tree', 'pwd', 'echo', 'stat', 'file',
  'less', 'printf', 'true', 'sleep', 'which', 'type', 'du', 'realpath', 'readlink', 'basename', 'dirname', 'date',
  'cd', 'ss', 'ps', 'free', 'env', 'export', 'set', 'source', '.', 'nproc', 'uname', 'id', 'whoami', 'hostname']);
const GIT_BROWSE = new Set(['status', 'diff', 'show', 'log', 'branch', 'rev-parse', 'ls-files', 'remote', 'fetch', 'config', 'blame', 'grep']);
const PATCH_OP_RE = /^(UPDATE|ADD|DELETE|CREATE|MOVE) (\S[^\n]*?)(?: → [^\n]*)?$/u;
const OPENERS_RE = new RegExp(`^(done|all done|all set|fixed|pushed|merged|complete|completed|finished|yes|no|sure|ok|okay|got it|great|perfect|thanks|thank you|sounds good|on it|here you go|here it is|updated|sorry|my mistake|good catch|you(?:'re| are| were) right)${NOT_AFTER}[^.!?]{0,24}[.!?:]?$`, 'iu');
const BOT_LOGIN_RE = /\[bot\]$|^(greptile|coderabbit|cursor|devin|copilot|sourcery|codecov|vercel|netlify|github-actions)/iu;
const NOISE_RE = /^Okidoki CLI \S+ → \S+ available|^npm notice/u;

// Product templates (shared/src/user-message-parser/parsers.ts). Their instruction sections are boilerplate.
const BOILERPLATE_RE = /^(Response Instructions|Workspace Target|Assignment|Your Assignment|Getting Workflow Logs|Getting Pipeline Logs|Tracker Comment[^\n]*|Important|Guidelines|Instructions|Okidoki-managed GitHub checks)$/u;
const TEMPLATE_HEADS = ['# Task from Slack', '# CI/CD Workflow Failed', '# Automation Triggered', 'You received a comment on',
  'You received a new comment on', 'You received a pull request review on', '# Task: ', '[Slack] ', '[Linear] ',
  '[Multitask] ', '**Scheduled follow-up: ', '<!-- okidoki:chat-fork ', 'Inline diff comments for the current changes:'];
const MERGED_MARKER = '<!-- okidoki:merged -->';
const FORK_GENERATED = ['Review the recent turns and the current workspace state', 'Say in one sentence that you are ready'];

export const GENERIC_CHAT_TITLE = new RegExp(
  `^(?:forked from [^\\n]*|(?:claude code|claude|codex|relay|pi|opencode|cursor|gemini|amp|droid|manager|mothership|agent|chat|`
  + `new chat|new session|untitled(?: session| chat)?|session|slack|linear(?: · [^\\n]*)?|#[\\p{L}\\p{N}_.\\-]+|[^\\n]+ \\(dm\\)|pr #\\d+ fixes)`
  + `(?: \\(${W}+\\))*(?: \\d+)?)$`, 'iu');

export interface CondensedTranscriptFacts {
  trigger: string | null;
  ask: string | null;
  outcome: string | null;
  prRefs: string[];
  prTitles: Record<string, string>;
  humanMessages: number;
}

export interface CondensedTranscript {
  markdown: string;
  facts: CondensedTranscriptFacts;
  trivial: boolean;
}

export const codePointLength = (value: string): number => {
  if (value.length < 2) return value.length;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
};

export const codePointHead = (value: string, count: number): string => {
  let units = 0;
  for (let taken = 0; taken < count && units < value.length; taken++) {
    const code = value.charCodeAt(units);
    units += code >= 0xd800 && code <= 0xdbff && units + 1 < value.length
      && value.charCodeAt(units + 1) >= 0xdc00 && value.charCodeAt(units + 1) <= 0xdfff ? 2 : 1;
  }
  return value.slice(0, units);
};

const cpTail = (value: string, count: number): string => {
  let units = value.length;
  for (let taken = 0; taken < count && units > 0; taken++) {
    const code = value.charCodeAt(units - 1);
    units -= code >= 0xdc00 && code <= 0xdfff && units - 2 >= 0
      && value.charCodeAt(units - 2) >= 0xd800 && value.charCodeAt(units - 2) <= 0xdbff ? 2 : 1;
  }
  return value.slice(units);
};

export function capCodePoints(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const length = codePointLength(value);
  return length <= limit ? value : `${codePointHead(value, limit)} …[+${length - limit} chars]`;
}

export function oneLine(value: string): string {
  return value.replace(/[￼​\x00-\x08]/gu, '').replace(/\s+/gu, ' ').trim();
}

const words = (value: string) => value.trim().split(/\s+/u).filter(Boolean);
const rsplitHead = (value: string) => {
  const at = value.lastIndexOf(' ');
  return at === -1 ? value : value.slice(0, at);
};

function isErrorLine(line: string): boolean {
  return ERR_RE.test(line.replace(BENIGN_RE, ''));
}

function errorLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() && isErrorLine(line)).slice(0, ERROR_LINES).map((line) => capCodePoints(line.trim(), ERROR_LINE_CAP));
}

function tailOutput(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() && !NOISE_RE.test(line)).map((line) => line.trimEnd());
  if (lines.length === 0) return '';
  const out = lines.slice(-OUTPUT_LINES).join('\n');
  return codePointLength(out) <= OUTPUT_CAP ? out : `…${cpTail(out, OUTPUT_CAP)}`;
}

function headOutput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_CAP || codePointLength(trimmed) <= OUTPUT_CAP ? trimmed : `${codePointHead(trimmed, OUTPUT_CAP)}…`;
}

function stripSections(text: string): string {
  const out: string[] = [];
  let skipLevel: number | null = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fence = !fence;
      if (skipLevel === null) out.push(line);
      continue;
    }
    const heading = fence ? null : line.match(/^(#{2,3}) ([^\n]+?)\s*$/u);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel !== null && level <= skipLevel) skipLevel = null;
      if (skipLevel === null && BOILERPLATE_RE.test(heading[2])) {
        skipLevel = level;
        continue;
      }
    }
    if (skipLevel === null) out.push(line);
  }
  return out.join('\n');
}

function forkReply(replyText: string): string | null {
  let reply = replyText;
  if (reply.startsWith('The previous agent was interrupted')) {
    reply = reply.split('\n').filter((line) => line.startsWith('>'))
      .map((line) => line.startsWith('> ') ? line.slice(2) : line.replace(/^>+/u, '')).join('\n').trim();
  } else if (FORK_GENERATED.some((prefix) => reply.startsWith(prefix))) {
    reply = '';
  }
  return reply || null;
}

function readFork(text: string): { title: string; reply: string | null } | null {
  const envelope = readChatForkEnvelope(text);
  if (!envelope) return null;
  return { title: typeof envelope.meta.sourceTitle === 'string' ? envelope.meta.sourceTitle : '', reply: forkReply(envelope.replyText) };
}

function classifyFork(title: string, reply: string | null): { label: string | null; human: string | null } {
  const fork = !title || GENERIC_CHAT_TITLE.test(title) ? 'Fork' : `Fork of ${oneLine(title)}`;
  if (!reply) return { label: fork, human: null };
  const inner = classifyUserMessage(reply);
  return { label: inner.label ? `${fork} · ${inner.label}` : fork, human: inner.human };
}

function trimTemplate(body: string): string {
  let text = body.trim();
  const fork = readFork(text);
  if (fork) return `[Chat fork of "${fork.title}"; its recent turns are omitted]${fork.reply ? `\n\n${trimTemplate(fork.reply)}` : ''}`;
  if (!TEMPLATE_HEADS.some((head) => text.startsWith(head))) return text;
  if (text.startsWith('# CI/CD Workflow Failed')) {
    const details = /## Workflow Details\n(?:- [^\n]*\n?)+/u.exec(text);
    return details ? text.slice(0, details.index + details[0].length).trimEnd() : text;
  }
  const cut = text.indexOf('\nIMPORTANT INSTRUCTIONS:');
  if (cut !== -1) text = text.slice(0, cut);
  return stripSections(text).trim();
}

function capUser(text: string): string {
  if (text.length <= USER_CAP) return text;
  const length = codePointLength(text);
  if (length <= USER_CAP) return text;
  return `${codePointHead(text, USER_CAP - USER_TAIL)}\n…[${length - USER_CAP} chars omitted]…\n${cpTail(text, USER_TAIL)}`;
}

function commandText(summary: string): string {
  let cmd = summary.trim();
  const match = cmd.match(/^(?:\/bin\/)?(?:ba|z)?sh -l?c ([\s\S]*)$/u);
  if (match) {
    cmd = match[1].trim();
    if (cmd.length >= 2 && (cmd[0] === '\'' || cmd[0] === '"') && cmd.at(-1) === cmd[0]) cmd = cmd.slice(1, -1);
  }
  return cmd;
}

function segments(cmd: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const segment of cmd.split(/&&|\|\||;|\n/u)) {
    const tokens = words(segment);
    if (tokens.length === 0) continue;
    if (tokens[0] === 'git') out.push(['git', tokens.slice(1).find((token) => !token.startsWith('-')) ?? '']);
    else out.push([tokens[0], '']);
  }
  return out;
}

const isBrowseWord = ([first, sub]: [string, string]) => first === 'git' ? GIT_BROWSE.has(sub) : BROWSE.has(first);
const isBrowse = (cmd: string) => segments(cmd).every(isBrowseWord);
const endsWithBrowse = (cmd: string) => {
  const all = segments(cmd);
  return all.length === 0 || isBrowseWord(all[all.length - 1]);
};

function splitTool(details: string): [string, string] {
  const end = details.indexOf('\n}\n\n');
  if (details.startsWith('{') && end !== -1) return [details.slice(0, end + 2), details.slice(end + 4)];
  if (details.startsWith('{') && details.trimEnd().endsWith('}')) return [details, ''];
  const at = details.indexOf('\n\n');
  return at === -1 ? [details, ''] : [details.slice(0, at), details.slice(at + 2)];
}

function parseActivity(body: string): { title: string; summary: string; exitCode: number | null; details: string } {
  const lines = body.split('\n');
  const summary = lines.find((line) => line.startsWith('Summary: '))?.slice(9) ?? '';
  const trimmed = body.trimEnd();
  const exit = /\nExit: (-?\d+)$/u.exec(trimmed);
  const rest = exit ? trimmed.slice(0, exit.index) : body;
  const at = rest.indexOf('Details:\n');
  return { title: lines[0], summary, exitCode: exit ? Number(exit[1]) : null, details: at === -1 ? '' : rest.slice(at + 9) };
}

function linksOf(...texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(URL_RE)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return found.slice(0, LINKS_PER_ACTIVITY);
}

function patchHunks(details: string): Array<{ path: string; action: string; changed: string[] }> {
  const ops: Array<{ path: string; action: string; changed: string[] }> = [];
  let current: (typeof ops)[number] | null = null;
  for (const line of details.split('\n')) {
    const op = line.match(PATCH_OP_RE);
    if (op) {
      current = { path: op[2].trim(), action: op[1], changed: [] };
      ops.push(current);
    } else if (current && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      current.changed.push(line);
    }
  }
  return ops;
}

function ghTitle(cmd: string): string | null {
  const match = cmd.match(/(?:--title|-t)(?:=|\s+)(?:\$?'((?:[^'\\]|\\[^\n])*)'|"((?:[^"\\]|\\[^\n])*)"|\\"((?:[^"\\]|\\[^\n])*?)\\"|(\S+))/u);
  if (!match) return null;
  const value = match.slice(1).find((group) => group !== undefined) ?? '';
  return oneLine(value.replaceAll('\\"', '"').replaceAll('\\\'', '\'')) || null;
}

const prKey = (match: RegExpMatchArray) => match[1] ? `${match[1]}#${match[2]}` : `${match[3]}!${match[4]}`;

export function firstSentence(text: string, limit: number): string | null {
  const cleaned = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/[*_`>#]+/gu, '');
  for (const raw of cleaned.split(/(?<=[.!?])\s+|\n+/u)) {
    let chunk = oneLine(raw.replace(/^\s*(?:[-+]|\d+[.)])\s+/u, ''));
    if (!chunk || OPENERS_RE.test(chunk) || chunk.endsWith(':') || words(chunk).length < 3) continue;
    if (codePointLength(chunk) > limit) chunk = `${rsplitHead(codePointHead(chunk, limit))}…`;
    return chunk;
  }
  return null;
}

const botAware = (user: string, body: string) => BOT_LOGIN_RE.test(user) ? null : body || null;

function classifyParsed(parsed: NonMergedParsedPrompt): { label: string | null; human: string | null } {
  switch (parsed.source) {
    case 'slack_task':
      return { label: 'Slack', human: parsed.latestMessageText.replace(/^@[^:\n]+: /u, '') || null };
    case 'text_message':
      return { label: 'Text', human: parsed.reaction ? null : parsed.text || null };
    case 'ci_failure':
      return { label: `CI #${parsed.prNumber} ${parsed.workflowName}`.trim(), human: null };
    case 'automation_triggered':
      return { label: `Automation ${parsed.automationName}`.trim(), human: parsed.userPrompt || null };
    case 'github_pr_existing_review':
    case 'github_pr_existing_general':
      return { label: `PR review #${parsed.prNumber}`, human: botAware(parsed.commentUser, parsed.commentBody) };
    case 'github_pr_existing_pr_review':
      return { label: `PR review #${parsed.prNumber}`, human: botAware(parsed.reviewUser, parsed.commentBody) };
    case 'gitlab_mr_existing_general':
      return { label: `PR review #${parsed.mergeRequestIid}`, human: botAware(parsed.commentUser, parsed.commentBody) };
    case 'github_pr_new':
      return { label: `PR #${parsed.prNumber} mention`, human: parsed.contextMessage || null };
    case 'github_issue_new':
    case 'gitlab_issue_new':
      return { label: `Issue #${parsed.issueNumber}`, human: parsed.issueTitle || null };
    case 'github_issue_existing':
    case 'gitlab_issue_existing':
      return { label: `Issue #${parsed.issueNumber}`, human: botAware(parsed.commentUser, parsed.commentBody) };
    case 'linear_issue':
      return { label: `Linear ${parsed.identifier}`, human: parsed.request || parsed.title };
    case 'chat_fork':
      return classifyFork(parsed.sourceTitle, forkReply(parsed.replyText));
    case 'raw':
      return { label: null, human: parsed.content };
    default:
      return { label: null, human: null };
  }
}

export function classifyUserMessage(body: string): { label: string | null; human: string | null } {
  const text = body.trim();
  const origin = parseMessageOrigin(text.split(MERGED_MARKER)[0].trim());
  if (origin?.kind === 'automation') return { label: `Automation ${origin.name}`, human: origin.body.trim() || null };
  if (origin?.kind === 'board') return { label: 'Board answer', human: origin.body.trim() || null };
  if (text.startsWith('[Multitask] ')) return { label: 'Manager report', human: null };
  const fork = readFork(text.split(MERGED_MARKER)[0].trim());
  if (fork) return classifyFork(fork.title, fork.reply);
  const parsed = parseUserMessage(text);
  const first = parsed.source === 'merged' ? parsed.messages[0] : parsed;
  return first.source === 'plan_quote' || first.source === 'inline_diff_comments'
    ? { label: null, human: text.split(MERGED_MARKER)[0].trim() }
    : classifyParsed(first);
}

const blockBody = (block: string) => {
  const at = block.indexOf('\n');
  return at === -1 ? '' : block.slice(at + 1);
};
const blockHead = (block: string) => {
  const at = block.indexOf('\n');
  return at === -1 ? block : block.slice(0, at);
};

function sessionFacts(blocks: readonly string[]): CondensedTranscriptFacts {
  let trigger: string | null = null;
  let ask: string | null = null;
  let finalAgent: string | null = null;
  let seenUser = false;
  let inHumanTurn = false;
  let turnFinal: string | null = null;
  let humanMessages = 0;
  const prRefs: string[] = [];
  const prTitles: Record<string, string> = {};
  for (const block of blocks) {
    const head = blockHead(block);
    const body = blockBody(block);
    if (head.startsWith('## User')) {
      const { label, human } = classifyUserMessage(body);
      if (!seenUser) {
        trigger = label;
        seenUser = true;
      }
      if (ask === null && human) ask = human;
      if (human) {
        humanMessages += 1;
        inHumanTurn = true;
        turnFinal = null;
      } else if (inHumanTurn && turnFinal) {
        inHumanTurn = false;
      }
    } else if (head.startsWith('## Agent') && !head.startsWith('## Agent reasoning')) {
      if (body.trim()) {
        finalAgent = body;
        if (inHumanTurn) turnFinal = body;
      }
    }
    if (head.startsWith('## Agent reasoning')) continue;
    for (const match of body.matchAll(PR_URL_RE)) {
      const key = prKey(match);
      if (!prRefs.includes(key)) prRefs.push(key);
    }
    for (const match of body.matchAll(PR_NUM_RE)) {
      const key = `#${match[1] ?? match[2]}`;
      if (!prRefs.includes(key)) prRefs.push(key);
    }
    if (head.startsWith('## Activity')) {
      const { title, summary, details } = parseActivity(body);
      const cmd = commandText(summary);
      if (title === 'Command' && /(?<![\p{L}\p{N}_])gh pr (?:create|edit)(?![\p{L}\p{N}_])/u.test(cmd)) {
        const prTitle = ghTitle(cmd);
        const urls = [...details.matchAll(PR_URL_RE)].map(prKey);
        const edit = cmd.match(/(?<![\p{L}\p{N}_])gh pr edit\s+(\d+)/u);
        if (prTitle && (urls.length > 0 || edit)) prTitles[urls.length > 0 ? urls[urls.length - 1] : `#${edit?.[1]}`] = prTitle;
      }
    }
  }
  // The outcome answers the last human turn; later bot-triggered turns (CI, review bots) are follow-up.
  const last = turnFinal ?? finalAgent;
  const askLine = ask ? oneLine(ask) : '';
  return {
    trigger,
    ask: askLine ? capCodePoints(askLine, FACT_CAP) : null,
    outcome: last ? firstSentence(last, FACT_CAP) : null,
    prRefs: prRefs.slice(0, MAX_PR_REFS),
    prTitles,
    humanMessages,
  };
}

function frontMatter(facts: CondensedTranscriptFacts): string {
  const lines = ['---'];
  for (const key of ['trigger', 'ask', 'outcome'] as const) {
    const value = facts[key];
    if (value) lines.push(`${key}: ${oneLine(value)}`);
  }
  if (facts.prRefs.length > 0) lines.push(`pr_refs: ${facts.prRefs.join(' ')}`);
  const titles = Object.entries(facts.prTitles);
  if (titles.length > 0) lines.push(`pr_titles: {${titles.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')}}`);
  lines.push('---');
  return lines.join('\n');
}

function isTrivial(blocks: readonly string[]): boolean {
  const users = blocks.filter((block) => block.startsWith('## User'));
  if (users.length === 0) return true;
  const hasAsk = users.some((block) => classifyUserMessage(blockBody(block)).human);
  const agentChars = blocks.filter((block) => block.startsWith('## Agent\n')).reduce((sum, block) => sum + codePointLength(blockBody(block).trim()), 0);
  const acted = blocks.some((block) => block.startsWith('## Activity'));
  return !hasAsk && agentChars < 280 && !acted;
}

export function condenseTranscriptBlocks(blocks: readonly string[]): CondensedTranscript {
  let finalAgent = -1;
  blocks.forEach((block, index) => {
    if (block.startsWith('## Agent\n') && blockBody(block).trim()) finalAgent = index;
  });
  const items: Array<{ kind: 'user' | 'agent' | 'act'; text: string }> = [];
  const outputs: Array<{ item: number; snippet: string }> = [];
  const patches: Array<{ item: number; rendered: string }> = [];
  const files: string[] = [];
  blocks.forEach((block, index) => {
    const head = blockHead(block);
    const body = blockBody(block);
    if (head.startsWith('## User')) {
      items.push({ kind: 'user', text: `${head}\n${capUser(trimTemplate(body))}` });
      return;
    }
    if (head.startsWith('## Agent reasoning')) return;
    if (head.startsWith('## Agent')) {
      const text = body.trim();
      if (text) items.push({ kind: 'agent', text: `${head}\n${index === finalAgent ? text : capCodePoints(text, AGENT_CAP)}` });
      return;
    }
    if (!head.startsWith('## Activity')) return;
    const { title, summary, exitCode, details } = parseActivity(body);
    const failed = exitCode !== null && exitCode !== 0;
    if (title === 'Apply patch' || title === 'File changes') {
      const ops = title === 'Apply patch' ? patchHunks(details) : [];
      for (const path of summary.split(',').map((part) => part.trim()).filter(Boolean)) {
        if (!files.includes(path)) files.push(path);
      }
      const sections = details.split('\n\n');
      const errs = failed || cpTail(details, 300).toLowerCase().includes('failed') ? errorLines(sections[sections.length - 1]) : [];
      for (const { path, action, changed } of ops) {
        if (changed.length > 0 && changed.length <= PATCH_MAX_CHANGED) {
          patches.push({ item: items.length, rendered: `- patch ${action.toLowerCase()} ${path}\n${changed.map((line) => `    ${capCodePoints(line, PATCH_LINE_CAP)}`).join('\n')}` });
        }
      }
      if (errs.length > 0) items.push({ kind: 'act', text: `- patch failed: ${capCodePoints(summary, LABEL_CAP)}${errs.map((error) => `\n    ! ${error}`).join('')}` });
      return;
    }
    let line: string;
    let snippet = '';
    let errs: string[] = [];
    if (title === 'Command') {
      const cmd = commandText(summary);
      errs = failed || exitCode === null ? errorLines(details) : [];
      if (isBrowse(cmd) && !(failed && errs.length > 0)) return;
      line = `- $ ${capCodePoints(oneLine(cmd), LABEL_CAP)}${failed ? ` [exit ${exitCode}]` : ''}`;
      if (!failed && errs.length === 0 && !endsWithBrowse(cmd)) {
        snippet = tailOutput(details);
      } else if (failed && errs.length === 0) {
        errs = tailOutput(details).split('\n').filter(Boolean).map((entry) => capCodePoints(entry, ERROR_LINE_CAP)).slice(-ERROR_LINES);
      }
    } else if (title.startsWith('Tool · ')) {
      const [input, output] = splitTool(details);
      line = input.trim() ? `- ${title}(${capCodePoints(oneLine(input), TOOL_INPUT_CAP)})` : `- ${title}`;
      errs = errorLines(output);
      if (errs.length === 0) snippet = headOutput(output);
    } else if (title.startsWith('Skill · ')) {
      line = `- ${title}${summary ? `: ${capCodePoints(oneLine(summary), 140)}` : ''}`;
    } else if (title === 'Web search') {
      line = `- Web search: ${capCodePoints(oneLine(summary), 140)}`;
    } else if (title === 'Subagent' || title === 'Subagent follow-up') {
      line = `- ${title}: ${capCodePoints(oneLine(summary), 200)}`;
      errs = errorLines(details);
    } else if (['Agent error', 'Credential fallback', 'Codex rate limit', 'Codex credits'].includes(title)) {
      line = `- ${title}${summary ? `: ${capCodePoints(oneLine(summary), 200)}` : ''}`;
      errs = details.trim() ? [capCodePoints(oneLine(details), 300)] : [];
    } else if (title === 'Agent stopped') {
      line = '- Agent stopped';
    } else if (title === 'Plan') {
      return;
    } else {
      line = `- ${capCodePoints(oneLine(title), 140)}`;
      errs = errorLines(details);
    }
    const links = linksOf(summary, details);
    let text = line + errs.map((error) => `\n    ! ${error}`).join('');
    if (links.length > 0) text += `\n    → ${links.join(' ')}`;
    if (snippet) outputs.push({ item: items.length, snippet });
    items.push({ kind: 'act', text });
  });

  // Budgets are spent from the end of the session, where final results and verification usually are.
  const keptOutputs = new Map<number, string>();
  let spent = 0;
  for (const { item, snippet } of [...outputs].reverse()) {
    const size = codePointLength(snippet);
    if (spent + size > OUTPUT_BUDGET) continue;
    spent += size;
    keptOutputs.set(item, snippet);
  }
  const keptPatches = new Map<number, string[]>();
  spent = 0;
  for (const { item, rendered } of [...patches].reverse()) {
    const size = codePointLength(rendered);
    if (spent + size > PATCH_BUDGET) continue;
    spent += size;
    keptPatches.set(item, [rendered, ...(keptPatches.get(item) ?? [])]);
  }

  const out: string[] = [];
  const acts: string[] = [];
  const flush = () => {
    if (acts.length > 0) out.push(`## Activity\n${acts.join('\n')}`);
    acts.length = 0;
  };
  for (let index = 0; index <= items.length; index++) {
    acts.push(...(keptPatches.get(index) ?? []));
    if (index === items.length) break;
    const { kind, text } = items[index];
    if (kind === 'act') {
      const output = keptOutputs.get(index);
      acts.push(output ? `${text}\n${output.split('\n').map((entry) => `    | ${entry}`).join('\n')}` : text);
    } else {
      flush();
      out.push(text);
    }
  }
  flush();
  if (files.length > 0) out.push(`## Files touched\n${[...files].sort(compareCodePoints).join('\n')}`);
  const facts = sessionFacts(blocks);
  return { markdown: `${frontMatter(facts)}\n\n${out.join('\n\n')}`, facts, trivial: isTrivial(blocks) };
}

// Python's sorted() order, which differs from the default UTF-16 sort only outside the Basic Multilingual Plane.
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}
