import { OKIDOKI_INSTRUCTIONS_TAG, stripOkidokiInstructionBlock, wrapInTag } from './prompts';
import { isRecord } from './type-guards';
import { UUID_RE } from './uuid';

export type MessageOrigin =
  | { kind: 'workspace'; id: string; name: string; body: string }
  | { kind: 'automation'; id: string; name: string; body: string; firedAt?: string }
  | { kind: 'board'; body: string };

// Answers from the Manager board, which older chats still hold.
const BOARD_ANSWER_NOTE = 'The user answered on the board.';
const UUID = UUID_RE.source.slice(1, -1);
const WORKSPACE_SENDER_LINE = String.raw`<${OKIDOKI_INSTRUCTIONS_TAG}>\nFrom the workspace ("(?:[^"\\\n]|\\.)*") \((${UUID})\)\.\n</${OKIDOKI_INSTRUCTIONS_TAG}>`;
const WORKSPACE_SENDER = new RegExp(String.raw`^\s*${WORKSPACE_SENDER_LINE}`);
// The engine puts its sender line ahead of the message.
const BOARD_ANSWER = new RegExp(String.raw`^\s*(?:<${OKIDOKI_INSTRUCTIONS_TAG}>\nFrom [^\n]*\n</${OKIDOKI_INSTRUCTIONS_TAG}>\s*)?<${OKIDOKI_INSTRUCTIONS_TAG}>\n${BOARD_ANSWER_NOTE.replace(/\./g, '\\.')}\n</${OKIDOKI_INSTRUCTIONS_TAG}>`);
const AUTOMATION_RUN_PREFIX = 'Automation run: ';
// Machine-written into the hidden instructions block, after any sender lines the monolith or engine put ahead of it.
const AUTOMATION_RUN = new RegExp(String.raw`^\s*(?:<${OKIDOKI_INSTRUCTIONS_TAG}>\n[^\n]*\n</${OKIDOKI_INSTRUCTIONS_TAG}>\s*)*?<${OKIDOKI_INSTRUCTIONS_TAG}>\n${AUTOMATION_RUN_PREFIX}(\{[^\n]*\})\n</${OKIDOKI_INSTRUCTIONS_TAG}>`);
const SCHEDULED_NOTE = 'This is a message you or a teammate scheduled earlier, delivered into this workspace.';
const SCHEDULED_FOLLOW_UP = new RegExp(String.raw`^\s*\*\*Scheduled follow-up: ([^\n]+)\*\*\n\nThe automation "[^\n]*" \((${UUID})\) fired at \S+\. ${SCHEDULED_NOTE.replace(/\./g, '\\.')}`);

/** Hidden from every client with the rest of the instructions block, and tells the agent which workspace wrote the message. */
export function formatWorkspaceSenderMessage(workspace: { id: string; name: string }, message: string): string {
  return `${wrapInTag(`From the workspace ${JSON.stringify(workspace.name)} (${workspace.id}).`, OKIDOKI_INSTRUCTIONS_TAG)}\n\n${message}`;
}

export const WORKSPACE_REPLY_NOTE = 'Your final response this turn goes back to that workspace as your reply, so don\'t also message it.';

// A queued turn can carry several merged messages, each with its own sender line.
export function parseWorkspaceSenderIds(text: string): string[] {
  return [...text.matchAll(new RegExp(WORKSPACE_SENDER_LINE, 'g'))].map((match) => match[2]);
}

export function formatScheduledFollowUp(automation: { id: string; name: string; prompt: string }, firedAt: string): string {
  return [
    `**Scheduled follow-up: ${automation.name}**`,
    '',
    `The automation "${automation.name}" (${automation.id}) fired at ${firedAt}. ${SCHEDULED_NOTE}`,
    '',
    automation.prompt,
  ].join('\n');
}

export function formatAutomationRunMessage(automation: { id: string; name: string }, firedAt: string, message: string): string {
  return `${wrapInTag(`${AUTOMATION_RUN_PREFIX}${JSON.stringify({ id: automation.id, name: automation.name, firedAt })}`, OKIDOKI_INSTRUCTIONS_TAG)}\n\n${message}`;
}

function parseAutomationRun(raw: string): MessageOrigin | null {
  const match = raw.match(AUTOMATION_RUN);
  if (!match) return null;
  let run: unknown;
  try { run = JSON.parse(match[1]); } catch { return null; }
  if (!isRecord(run) || typeof run.id !== 'string' || typeof run.name !== 'string') return null;
  const rest = raw.slice(match[0].length);
  const body = stripOkidokiInstructionBlock(rest.replace(SCHEDULED_FOLLOW_UP, ''));
  return { kind: 'automation', id: run.id, name: run.name, body, ...(typeof run.firedAt === 'string' ? { firedAt: run.firedAt } : {}) };
}

export function parseMessageOrigin(raw: string): MessageOrigin | null {
  const run = parseAutomationRun(raw);
  if (run) return run;
  const workspace = raw.match(WORKSPACE_SENDER);
  if (workspace) {
    let name: unknown;
    try { name = JSON.parse(workspace[1]); } catch { return null; }
    if (typeof name === 'string') return { kind: 'workspace', id: workspace[2], name, body: stripOkidokiInstructionBlock(raw.slice(workspace[0].length)) };
  }
  const board = raw.match(BOARD_ANSWER);
  if (board) return { kind: 'board', body: stripOkidokiInstructionBlock(raw.slice(board[0].length)) };
  const automation = raw.match(SCHEDULED_FOLLOW_UP);
  return automation ? { kind: 'automation', id: automation[2], name: automation[1].trim(), body: stripOkidokiInstructionBlock(raw.slice(automation[0].length)) } : null;
}
