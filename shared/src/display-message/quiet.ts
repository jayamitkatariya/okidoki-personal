import { formatCodeHostRequestRef } from '../urls';
import { workspaceTargetFromToolOutput } from '../workspace-target';
import { plural } from './format';
import { isFailedManagerEvent, isWorkspaceReplyEvent, managerEventVerb, managerLifecycleRows, type ManagerLifecycleRow } from '../manager-events';
import { describeGroupSteps, sentToChat, settleSteps, startsOrMessagesShip, statusSet, stepLabel, type TurnStep } from './steps';
import { answeringTurns, askedByPerson, chatReply, deliveredManagerEvents, hasPendingQuestion, reasoningHeading, typedByPerson, type TranscriptEntry, type Turn } from './turns';
import type { UserMessage } from './types';

export type QuietRow =
  | { kind: 'lifecycle'; key: string; row: ManagerLifecycleRow; count: number }
  | { kind: 'ship'; key: string; step: TurnStep; count: number }
  | { kind: 'origin'; key: string; message: UserMessage; count: number };

export function quietLifecycleRows(turn: Turn): ManagerLifecycleRow[] {
  return managerLifecycleRows([...deliveredManagerEvents(turn.user) ?? [], ...turn.notices.flatMap((message) => message.type === 'multitask_event' ? message.events : [])]);
}

// A spawn names its ship only in its output, so two spawns with the same task are still two ships.
const shipId = (step: TurnStep) => step.manager?.agentId ?? (step.message.type === 'tool_call' ? workspaceTargetFromToolOutput(step.message.output)?.id : undefined);

function quietShipSteps(turn: Turn): TurnStep[] {
  const steps = turn.units.flatMap((unit) => unit.kind === 'group' ? describeGroupSteps(unit.steps, turn) : []);
  return (turn.live ? steps : settleSteps(steps)).filter((step) => startsOrMessagesShip(step.message));
}

export function quietLiveStatus(turn: Turn, steps: TurnStep[]): string {
  const status = turn.messages.map(statusSet).findLast(Boolean);
  if (status) return status;
  const step = steps.findLast((candidate) => candidate.running);
  if (!step) return 'Thinking';
  if (step.message.type === 'reasoning') return reasoningHeading(step.message.content) ?? 'Thinking';
  if (step.category === 'command') return 'Running commands';
  if (step.category === 'search') return 'Searching the code';
  if (step.category === 'read' && step.icon === 'folder') return 'Looking through files';
  if (step.manager?.action === 'spawn') return 'Starting a ship';
  if (step.manager?.action === 'send') return `Messaging ${step.manager.name ?? 'a ship'}`;
  return stepLabel(step);
}

function quietTurnShowsMore(turn: Turn, answersPerson: boolean): boolean {
  const asked = askedByPerson(turn);
  return ((typedByPerson(turn) || answersPerson) && Boolean(chatReply(turn)))
    || turn.messages.some((message) => sentToChat(message) !== undefined)
    || (asked && (turn.live || Boolean(turn.interruption) || turn.notices.some((message) => message.type !== 'multitask_event')))
    || hasPendingQuestion(turn)
    || Boolean(turn.handoff)
    || turn.switches.length > 0;
}

export function quietTimeline(entries: TranscriptEntry[]): { rows: Turn[]; turn?: Turn; answersPerson: boolean }[] {
  const answering = answeringTurns(entries);
  const timeline: { rows: Turn[]; turn?: Turn; answersPerson: boolean }[] = [];
  let rows: Turn[] = [];
  for (const turn of entries.flatMap((entry) => (entry.kind === 'turn' ? [entry.turn] : entry.turns))) {
    const typed = typedByPerson(turn);
    if (!typed && quietRowGroup([turn]).length > 0) rows.push(turn);
    if (!typed && !quietTurnShowsMore(turn, answering.has(turn))) continue;
    timeline.push({ rows, turn, answersPerson: answering.has(turn) });
    rows = [];
  }
  if (rows.length) timeline.push({ rows, answersPerson: false });
  return timeline;
}

export function quietRowGroup(turns: Turn[]): QuietRow[] {
  const rows: QuietRow[] = [];
  const byKey = new Map<string, QuietRow>();
  const add = (row: QuietRow) => {
    const seen = byKey.get(row.key);
    if (seen) seen.count++;
    else {
      byKey.set(row.key, row);
      rows.push(row);
    }
  };
  for (const turn of turns) {
    if (turn.user?.origin) add({ kind: 'origin', key: turn.user.id, message: turn.user, count: 1 });
    for (const row of quietLifecycleRows(turn)) add({ kind: 'lifecycle', key: row.events.some(isWorkspaceReplyEvent) ? row.lead.id : ['lifecycle', row.lead.agentId, row.label, ...row.urls].join('\n'), row, count: 1 });
    for (const step of quietShipSteps(turn)) {
      const agentId = shipId(step);
      add({ kind: 'ship', key: agentId && !step.running && !step.failed ? ['ship', step.done, agentId, step.manager?.text].join('\n') : step.key, step, count: 1 });
    }
  }
  return rows;
}

/** One line for a collapsed group: what needs the person first, then pull requests, then what the Manager did. */
export function quietGroupSummary(rows: QuietRow[]): { text: string; lead: QuietRow } {
  const parts: { text: string; row: QuietRow }[] = [];
  const lifecycle = rows.flatMap((row) => (row.kind === 'lifecycle' ? [{ row, lifecycle: row.row }] : []));
  const shown = new Set<QuietRow>();
  const take = (match: (row: ManagerLifecycleRow) => boolean) => lifecycle.filter(({ row, lifecycle }) => !shown.has(row) && match(lifecycle)).map((entry) => (shown.add(entry.row), entry));
  const attention = take((row) => row.events.some((event) => event.kind === 'needs_attention' || isFailedManagerEvent(event)));
  const ships = new Set(attention.map(({ lifecycle }) => lifecycle.lead.agentId)).size;
  if (attention.length) parts.push({ text: ships > 1 ? `${ships} need attention` : 'Needs attention', row: attention[0].row });
  for (const kind of ['merged', 'approved'] as const) {
    const group = take((row) => row.events.some((event) => event.kind === kind));
    const urls = [...new Set(group.flatMap(({ lifecycle }) => lifecycle.urls))].filter((url) => kind === 'merged' || !parts.some((part) => part.text === `${formatCodeHostRequestRef(url) ?? url} merged`));
    const row = group[0]?.row;
    if (!row || (kind === 'approved' && group.every(({ lifecycle }) => lifecycle.urls.length) && !urls.length)) continue;
    if (urls.length && urls.length <= 2) urls.forEach((url) => parts.push({ text: `${formatCodeHostRequestRef(url) ?? url} ${kind}`, row }));
    else parts.push({ text: `${urls.length || group.length} ${kind}`, row });
  }
  for (const [action, verb] of [['send', 'Messaged'], ['spawn', 'Spawned']] as const) {
    const steps = rows.flatMap((row) => (row.kind === 'ship' && row.step.manager?.action === action ? [row] : []));
    if (steps.length) parts.push({ text: `${verb} ${plural(new Set(steps.map((row) => shipId(row.step) ?? row.step.manager?.name)).size, 'ship')}`, row: steps[0] });
  }
  const origins = new Map<string, { text: (count: number) => string; rows: QuietRow[] }>();
  for (const row of rows) {
    const origin = row.kind === 'origin' ? row.message.origin : undefined;
    if (!origin) continue;
    const key = origin.kind === 'board' ? 'board' : `${origin.kind}:${origin.name}`;
    const group = origins.get(key) ?? { rows: [], text: origin.kind === 'board' ? () => 'Answered on the board'
      : origin.kind === 'automation' ? (count) => `${origin.name} ran${count > 1 ? ` ×${count}` : ''}`
        : (count) => `${origin.name} sent ${count > 1 ? `${count} updates` : 'an update'}` };
    origins.set(key, { ...group, rows: [...group.rows, row] });
  }
  for (const { text, rows: grouped } of origins.values()) parts.push({ text: text(grouped.length), row: grouped[0] });
  for (const { row, lifecycle: rest } of lifecycle) if (!shown.has(row)) parts.push({ text: `${rest.lead.agentName} ${managerEventVerb(rest.lead)}`, row });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return { text: [plural(total, 'update'), ...parts.map(({ text }) => text)].join(' · '), lead: parts[0]?.row ?? rows[0] };
}
