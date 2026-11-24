import { parseManagerEventMessage, type ManagerEvent } from '../manager-events';
import { drivesScreen, type ComputerScreen } from '../shell-commands';
import { isRecord } from '../type-guards';
import { parseTimestampMs } from '../user-message-matching';
import { COMPACTION_CONTENT, GOAL_TOOL_NAME } from './constants';
import { getDisplayMessageStatus, peerChatName, planItemsFromMessage, plural, type PlanItem } from './format';
import type {
  AgentMessage,
  BackgroundTaskMessage,
  DisplayMessage,
  HarnessSwitchMessage,
  InterruptionMessage,
  ManagerEventNoticeMessage,
  SwitchNoticeMessage,
  ToolCallMessage,
  ToolInputQuestion,
  UserMessage,
} from './types';

export function messageTimeMs(message: DisplayMessage | undefined): number {
  const ms = message ? Date.parse(message.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function isCompaction(message: DisplayMessage): boolean {
  return message.type === 'reasoning' && message.content === COMPACTION_CONTENT;
}

export function isGoalUpdate(message: DisplayMessage): boolean {
  return message.type === 'tool_call' && message.server === 'claude' && message.tool === GOAL_TOOL_NAME;
}

const isHarnessHandoff = (message: DisplayMessage | undefined): message is HarnessSwitchMessage => message?.type === 'harness_switch' && message.trigger === 'switch';

const joinsRun = (segment: DisplayMessage[], message: DisplayMessage, marksEnds: Map<DisplayMessage, boolean>) =>
  deliveredManagerEvents(message) !== null
  && (isStillRunning(segment.filter((entry, index) => index === 0 || entry.type !== 'user'), marksEnds) || segment.every((entry) => entry.type === 'user'));

export function turnRanges(messages: DisplayMessage[], marksEnds = endMarkingStretches(messages)): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < messages.length;) {
    let end = start + (isHarnessHandoff(messages[start]) && messages[start + 1]?.type === 'user' ? 2 : 1);
    const head = messages[end - 1];
    // Nothing ran for a cancelled message, so work after it is a run of its own.
    const alone = head.type === 'user' && Boolean(head.cancelled);
    let ended = false;
    while (!alone && end < messages.length && (messages[end].type !== 'user' || joinsRun(messages.slice(start, end), messages[end], marksEnds)) && !isHarnessHandoff(messages[end])) {
      const previous = messages[end - 1];
      ended ||= previous.type === 'agent' && Boolean(previous.endsTurn);
      if (ended && !isTrailingNotice(messages[end])) break;
      end++;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

export function turnTiming(head: DisplayMessage, body: DisplayMessage[], endMessage: DisplayMessage): { startedAtMs: number; elapsedMs: number } {
  const starts = [messageTimeMs(head), messageTimeMs(body[0])].filter(Boolean);
  const startedAtMs = starts.length > 0 ? Math.min(...starts) : 0;
  const endedAtMs = Math.max(messageTimeMs(endMessage), ...[endMessage, ...body].map((message) => message.type === 'reasoning' || message.type === 'agent' ? parseTimestampMs(message.completedAt ?? 0) : 0));
  return { startedAtMs, elapsedMs: startedAtMs ? Math.max(0, endedAtMs - startedAtMs) : 0 };
}

type WorkUnit =
  | { kind: 'commentary'; id: string; message: AgentMessage }
  | { kind: 'group'; id: string; steps: DisplayMessage[] }
  | { kind: 'plan'; id: string; items: PlanItem[] }
  | { kind: 'question'; id: string; message: ToolCallMessage };

export interface Turn {
  id: string;
  handoff?: HarnessSwitchMessage;
  user?: UserMessage;
  units: WorkUnit[];
  answer?: AgentMessage;
  switches: SwitchNoticeMessage[];
  notices: DisplayMessage[];
  interruption?: InterruptionMessage;
  steered: boolean;
  wokenBy?: string;
  live: boolean;
  waiting: boolean;
  messages: DisplayMessage[];
  startedAtMs: number;
  elapsedMs: number;
  waitedMs: number;
  pausedAtMs?: number;
  durations: Map<string, number>;
  backgroundTasks: Map<string, BackgroundTaskMessage>;
}

const NOTICE_TYPES = new Set<DisplayMessage['type']>(['error', 'quota_status', 'multitask_event']);

const isTrailingNotice = (message: DisplayMessage) => NOTICE_TYPES.has(message.type) || message.type === 'auth_fallback' || message.type === 'model_fallback' || message.type === 'harness_switch' || message.type === 'interruption' || isCompaction(message);

const isStandalone = (message: DisplayMessage) => isCompaction(message) || isGoalUpdate(message) || message.type === 'capacity_retry';

const turnCache = new WeakMap<DisplayMessage, { turn: Turn; cutBy: DisplayMessage | undefined; wokenAtMs: number | undefined }>();

// A compaction still running is work: a turn the agent starts on its own can begin with one, inside the ended turn's range.
export function isLastTurnEnded(messages: DisplayMessage[]): boolean {
  const last = messages.findLast((message) => !isTrailingNotice(message) || (message.type === 'reasoning' && message.status === 'in_progress'));
  return Boolean(last && 'endsTurn' in last && last.endsTurn);
}

function isStillRunning(segment: DisplayMessage[], marksEnds: Map<DisplayMessage, boolean>): boolean {
  const lastStepIndex = segment.findLastIndex((message) => !isTrailingNotice(message));
  const lastStep = segment[lastStepIndex];
  // Only harnesses that mark where a run ends say whether text without the mark was still mid-run.
  const unended = lastStep?.type === 'agent' ? !lastStep.endsTurn && Boolean(marksEnds.get(lastStep)) : lastStep !== undefined && lastStep.type !== 'user' && !('endsTurn' in lastStep && lastStep.endsTurn);
  const halted = segment.some((message) => message.type === 'interruption') || segment.slice(lastStepIndex + 1).some((message) => message.type === 'error');
  return unended && !halted;
}

// Kept per message so a rebuilt turn hands the transcript the same notice.
const eventNotices = new WeakMap<DisplayMessage, ManagerEventNoticeMessage>();

function asEventNotice(message: DisplayMessage): DisplayMessage {
  if (message.type !== 'user') return message;
  let notice = eventNotices.get(message);
  if (!notice) {
    notice = { id: message.id, type: 'multitask_event', events: deliveredManagerEvents(message) ?? [], timestamp: message.timestamp };
    eventNotices.set(message, notice);
  }
  return notice;
}

function buildTurn(messages: DisplayMessage[], start: number, end: number, live: boolean, waiting: boolean, marksEnds: Map<DisplayMessage, boolean>, wokenBy?: string, wokenAtMs?: number): Turn {
  const head = messages[start];
  // A person's message that lands mid-run starts the next turn while the run goes on, so this one's last step ran until then.
  const cutBy = end < messages.length && messages[end].type === 'user' && isStillRunning(messages.slice(start, end), marksEnds) ? messages[end] : undefined;
  const entry = turnCache.get(head);
  const cached = entry?.turn;
  if (
    cached
    && entry.cutBy === cutBy
    && entry.wokenAtMs === wokenAtMs
    && cached.messages.length === end - start
    && cached.live === live
    && cached.waiting === (live && waiting)
    && cached.wokenBy === wokenBy
    && cached.messages.every((message, index) => message === messages[start + index])
  ) {
    return cached;
  }

  const handoff = isHarnessHandoff(head) ? head : undefined;
  const first = handoff ? messages[start + 1] : head;
  const user = first?.type === 'user' && start + (handoff ? 1 : 0) < end ? first : undefined;
  const body = messages.slice(start + (handoff ? 1 : 0) + (user ? 1 : 0), end).map(asEventNotice);

  const lastAgent = body.findLastIndex((message) => message.type === 'agent');
  const candidate = body.findLast((message): message is AgentMessage => message.type === 'agent');
  const answer = candidate && body.slice(lastAgent + 1).every((message) => isTrailingNotice(message) || isGoalUpdate(message) || (!live && message.type === 'reasoning'))
    ? candidate
    : undefined;

  const units: WorkUnit[] = [];
  const notices: DisplayMessage[] = [];
  const switches: Turn['switches'] = [];
  const durations = new Map<string, number>();
  const backgroundTasks = new Map<string, BackgroundTaskMessage>();
  let interruption: InterruptionMessage | undefined;
  let plan: Extract<WorkUnit, { kind: 'plan' }> | undefined;
  let waitedMs = 0;
  let pausedAtMs: number | undefined;

  body.forEach((message, index) => {
    if (message === answer) return;
    const next = body[index + 1] ?? cutBy;
    if (next && getDisplayMessageStatus(message) !== 'in_progress') durations.set(message.id, Math.max(0, messageTimeMs(next) - messageTimeMs(message)));
    if (message.type === 'background_task') {
      backgroundTasks.set(message.taskId, message);
      if (message.toolUseId) backgroundTasks.set(message.toolUseId, message);
    }
    if (message.type === 'interruption') {
      interruption = message;
      return;
    }
    // A recovery only clears the earlier limit notice, so it has nothing to show.
    if (message.type === 'quota_status' && message.state === 'ok') return;
    if (NOTICE_TYPES.has(message.type)) {
      notices.push(message);
      return;
    }
    if (message.type === 'agent') {
      units.push({ kind: 'commentary', id: message.id, message });
      return;
    }
    if (message.type === 'harness_switch' || message.type === 'auth_fallback' || message.type === 'model_fallback') {
      switches.push(message);
      return;
    }
    const planItems = planItemsFromMessage(message);
    if (planItems) {
      if (plan) plan.items = planItems;
      else units.push(plan = { kind: 'plan', id: message.id, items: planItems });
      return;
    }
    if (message.type === 'tool_call' && message.inputRequest) {
      units.push({ kind: 'question', id: message.id, message });
      const resolvedAtMs = parseTimestampMs(message.inputRequest.resolvedAt ?? 0);
      if (resolvedAtMs) waitedMs += message.inputRequest.waitedMs ?? Math.max(0, resolvedAtMs - messageTimeMs(message));
      else pausedAtMs = messageTimeMs(message);
      return;
    }
    const last = units.at(-1);
    if (last?.kind === 'group' && !isStandalone(message) && !isStandalone(last.steps[0])) last.steps.push(message);
    else units.push({ kind: 'group', id: message.id, steps: [message] });
  });

  const { startedAtMs, elapsedMs } = turnTiming(user ?? head, body, cutBy ?? answer ?? body.at(-1) ?? user ?? head);
  // The parser counts a stop from the last message someone sent. A turn the agent started on its own began when it was woken, or at its first step.
  const ownStartMs = user || handoff ? 0 : wokenAtMs ?? startedAtMs;
  const stopped = interruption?.durationMs === undefined ? interruption : { ...interruption, durationMs: Math.max(0, (ownStartMs ? messageTimeMs(interruption) - ownStartMs : interruption.durationMs) - waitedMs) };
  const turn: Turn = {
    id: user?.id ?? head.id,
    handoff,
    user,
    units,
    answer,
    switches,
    notices,
    interruption: stopped,
    steered: Boolean(cutBy),
    wokenBy,
    live,
    waiting: live && waiting,
    messages: messages.slice(start, end),
    startedAtMs,
    elapsedMs: stopped?.durationMs ?? Math.max(0, (pausedAtMs ? Math.min(elapsedMs, pausedAtMs - startedAtMs) : elapsedMs) - waitedMs),
    waitedMs,
    pausedAtMs,
    durations,
    backgroundTasks,
  };
  turnCache.set(head, { turn, cutBy, wokenAtMs });
  return turn;
}

// End marks are a harness's habit, so each stretch between harness switches, automatic ones and those inside a turn included, decides for itself.
function endMarkingStretches(messages: DisplayMessage[]): Map<DisplayMessage, boolean> {
  const marks = new Map<DisplayMessage, boolean>();
  let from = 0;
  messages.forEach((message, index) => {
    if (index < messages.length - 1 && messages[index + 1].type !== 'harness_switch') return;
    const stretch = messages.slice(from, index + 1);
    const marking = stretch.some((entry) => entry.type === 'agent' && entry.endsTurn);
    for (const entry of stretch) marks.set(entry, marking);
    from = index + 1;
  });
  return marks;
}

export function groupTurns(messages: DisplayMessage[], live: boolean, waiting: boolean): Turn[] {
  const notified = messages.flatMap((message) => message.type === 'background_task' && message.notifiedAt ? [{ task: message, atMs: parseTimestampMs(message.notifiedAt) }] : []).sort((a, b) => a.atMs - b.atMs);
  const marksEnds = endMarkingStretches(messages);
  return turnRanges(messages, marksEnds).map(({ start, end }) => {
    const head = messages[start];
    const woken = start > 0 && head.type !== 'user' && !isHarnessHandoff(head)
      ? notified.findLast(({ atMs }) => atMs >= messageTimeMs(messages[start - 1]) && atMs <= messageTimeMs(head))
      : undefined;
    const task = woken?.task;
    // Claude Code names a background command by its command text when the agent gave no description.
    const wokenBy = start > 0 && head.type === 'peer_message' && head.direction === 'received' ? `Message from ${peerChatName(head)}`
      : task && (task.description && !messages.some((message) => message.type === 'command' && message.command === task.description) ? task.description : 'Background task finished');
    return buildTurn(messages, start, end, live && end === messages.length, waiting, marksEnds, wokenBy, woken?.atMs);
  });
}

// Only machine deliveries carry no sender, so a person's message never counts as a subagent update.
// Every render folds every turn, so each delivered message is parsed once rather than on every update.
const deliveredEventsCache = new WeakMap<DisplayMessage, ManagerEvent[] | null>();

export function deliveredManagerEvents(message: DisplayMessage | undefined): ManagerEvent[] | null {
  if (message?.type !== 'user' || message.senderUserId || message.cancelled || !message.content) return null;
  let events = deliveredEventsCache.get(message);
  if (events === undefined) {
    events = parseManagerEventMessage(message.content);
    deliveredEventsCache.set(message, events);
  }
  return events;
}

export function isPersonMessage(message: DisplayMessage | undefined): boolean {
  return message?.type === 'user' && deliveredManagerEvents(message) === null && !message.origin;
}

export function typedByPerson(turn: Turn): boolean {
  return isPersonMessage(turn.user);
}

export function askedByPerson(turn: Turn): boolean {
  return typedByPerson(turn) || turn.user?.origin?.kind === 'board';
}

// Text written mid-turn is only a reply once the turn ends. Codex can end with an empty final message after giving its reply as commentary; a ship event's commentary is never a reply.
// Agents sometimes end a turn they mean to be silent with a zero-width space, which trim() keeps.
export const hasVisibleText = (message: AgentMessage | undefined): message is AgentMessage => Boolean(message?.content.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, ''));

export function chatReply(turn: Turn): AgentMessage | undefined {
  if (turn.live) return undefined;
  const reply = hasVisibleText(turn.answer) || !turn.user || deliveredManagerEvents(turn.user)
    ? turn.answer
    : turn.units.flatMap((unit) => (unit.kind === 'commentary' ? [unit.message] : [])).at(-1) ?? turn.answer;
  return hasVisibleText(reply) ? reply : undefined;
}

export const showsWithoutReply = (turn: Turn) => Boolean(turn.interruption) || turn.notices.some((message) => message.type === 'error' || message.type === 'quota_status');

export function isUnfinishedTurn(turn: Turn): boolean {
  return !turn.answer && !turn.interruption;
}

// Until send_to_chat shipped, a Manager reached the person with its final text after an event or board answer.
const SEND_TO_CHAT_SINCE = '2026-11-10T08:57:41.000Z';

export type TranscriptEntry = { kind: 'turn'; turn: Turn; answersPerson?: boolean; repliesInChat?: boolean } | { kind: 'updates'; turns: Turn[]; events: ManagerEvent[]; reply?: Turn; answersPerson?: boolean; repliesInChat?: boolean };

export const managerEventAgentNames = (events: ManagerEvent[]) => [...new Set(events.map((event) => event.agentName))];

export function foldManagerUpdates(turns: Turn[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Progress text right before an update looks like an answer, so trust the reply's end marker when the provider records one.
  const marksEnds = endMarkingStretches(turns.flatMap((turn) => turn.messages));
  // An update delivered before a person's turn has its answer splits that turn, so the answer lands in the update's turn.
  let personTurnOpen = false;
  for (const turn of turns) {
    const events = deliveredManagerEvents(turn.user);
    const needsUser = !events
      || turn.live
      || turn.units.some((unit) => unit.kind === 'question');
    const answered = turn.answer && marksEnds.get(turn.answer) ? turn.answer.endsTurn : turn.answer;
    const answersPerson = personTurnOpen && Boolean(answered);
    const repliesInChat = Boolean(answered) && !typedByPerson(turn) && Boolean(turn.user && turn.user.timestamp < SEND_TO_CHAT_SINCE) && hasVisibleText(turn.answer);
    personTurnOpen = (typedByPerson(turn) || personTurnOpen) && !turn.interruption && !answered;
    if (needsUser) {
      entries.push({ kind: 'turn', turn, ...(answersPerson && !typedByPerson(turn) ? { answersPerson } : {}), ...(repliesInChat ? { repliesInChat } : {}) });
      continue;
    }
    const last = entries.at(-1);
    const group: Extract<TranscriptEntry, { kind: 'updates' }> = last?.kind === 'updates' && !last.reply ? last : { kind: 'updates', turns: [], events: [] };
    if (group !== last) entries.push(group);
    group.turns.push(turn);
    group.events.push(...events);
    if (answered) {
      group.reply = turn;
      group.answersPerson = answersPerson;
      group.repliesInChat = repliesInChat;
    }
  }
  return entries;
}

// A message the other harness answered can't be edited: turns before the last handoff, and the switch turn itself when it switched mid-turn.
export function firstEditableTurnIndex(turns: Turn[]): number {
  const switchesMidTurn = (turn: Turn) => turn.switches.some((message) => message.type === 'harness_switch');
  const last = turns.findLastIndex((turn) => turn.handoff || switchesMidTurn(turn));
  return last === -1 ? 0 : switchesMidTurn(turns[last]) ? last + 1 : last;
}

export function answeringTurns(entries: TranscriptEntry[]): Set<Turn> {
  return new Set(entries.flatMap((entry) => entry.kind === 'turn' ? (entry.answersPerson || entry.repliesInChat ? [entry.turn] : []) : (entry.answersPerson || entry.repliesInChat) && entry.reply ? [entry.reply] : []));
}

export function hasPendingQuestion(turn: Turn): boolean {
  return turn.units.some((unit) => unit.kind === 'question' && unit.message.inputRequest?.status === 'pending');
}

export function toolInputAnswer(selections: unknown, questionId: string): { custom: string; options: string[] } {
  const selection = isRecord(selections) ? selections[questionId] : undefined;
  if (!isRecord(selection)) return { custom: '', options: [] };
  return {
    custom: typeof selection.custom === 'string' ? selection.custom.trim() : '',
    options: Array.isArray(selection.options) ? selection.options.filter((option): option is string => typeof option === 'string') : [],
  };
}

function questionAnswers(questions: ToolInputQuestion[], selectionId: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(selectionId);
  } catch {
    return [];
  }
  return questions.flatMap((q) => {
    const { custom, options } = toolInputAnswer(payload, q.id);
    const answer = custom || options.map((id) => q.options.find((o) => o.id === id)?.label).filter(Boolean).join(', ');
    return answer ? [answer] : [];
  });
}

export function reasoningHeading(content: string): string | undefined {
  return [...content.matchAll(/\*\*(.+?)\*\*/g)].at(-1)?.[1];
}

export function questionSummary(message: ToolCallMessage): { label: string; answer?: string } {
  const { status, options, questions, selectionId, selectionSummary } = message.inputRequest ?? { status: 'pending' };
  const label = message.tool === 'ExitPlanMode'
    ? 'Exit plan mode'
    : questions?.length
      ? `Asked ${plural(questions.length, 'question')}`
      : 'Question';
  if (status === 'aborted') return { label, answer: 'Interrupted' };
  if (selectionId === 'declined') return { label, answer: 'Declined' };
  const answers = questions?.length && selectionId ? questionAnswers(questions, selectionId) : [];
  const answer = answers.length > 0
    ? answers.join(', ')
    : selectionSummary
      ?? options?.find((o) => o.id === selectionId)?.label
      ?? (status === 'resolved' && selectionId ? 'Submitted' : undefined);
  return { label, answer };
}

export function findScreenTurnId(turns: Turn[], screen: ComputerScreen) {
  return turns.findLast((turn) => turn.units.some((unit) => unit.kind === 'group' && unit.steps.some((step) => step.type === 'command' && drivesScreen(step.command, screen))))?.id;
}
