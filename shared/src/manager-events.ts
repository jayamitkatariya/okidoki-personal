import { z } from 'zod';
import { MERGED_MESSAGE_SEPARATOR, type InterruptChatResponse } from './engine/v1';
import { stripAgentInstructionBlocks, stripInstructionBlocksOutside } from './prompts';
import { parseMessageOrigin } from './message-origin';
import { formatCodeHostRequestRef } from './urls';
import type { PullRequestDeployment } from './routes/pull-requests';
import { escapeTagAttribute, MULTITASK_EVENT_TAG, parseTagAttributes, tagBlockPattern } from './tag-blocks';
import { extractIssueEvents, ISSUE_EVENT_TAG, issueEventChangeSchema } from './issue-events';

const MANAGER_EVENT_KINDS = ['finished', 'ready', 'needs_attention', 'approved', 'merged', 'closed', 'archived', 'replied'] as const;
// A client built before a kind was added shows it as a plain update, not as the raw block in a user bubble.
const UNKNOWN_EVENT_KIND = 'update';
export type ManagerEventKind = (typeof MANAGER_EVENT_KINDS)[number] | typeof UNKNOWN_EVENT_KIND | 'issue';

// These keep their pre-rename values, which stored transcripts and running engines already carry.
export const MANAGER_FOLLOWING_UP_SUMMARY = 'Finished its turn. Its pull requests are open and being followed up through CI and review.';

// Failed turns are reported as `finished` with this summary, which stored events already carry.
export const MANAGER_TURN_ERROR_SUMMARY = 'Turn ended with an error.';

// Stored `ready` events carry one of these, so the label can say whether GitHub would merge the pull requests yet.
export const MANAGER_READY_TO_MERGE_SUMMARY = 'Pull requests are ready to merge: CI is passing and automatic fixes are done.';
export const MANAGER_READY_FOR_REVIEW_SUMMARY = 'Pull requests are ready for review: CI is passing and automatic fixes are done.';

export function isFailedManagerEvent(event: ManagerEvent): boolean {
  return event.kind === 'finished' && event.summary.startsWith(MANAGER_TURN_ERROR_SUMMARY);
}

export const isWorkspaceReplyEvent = (event: ManagerEvent) => event.kind === 'replied' && !event.issue;

export const managerEventGlyph = (event: ManagerEvent): ManagerEventKind | 'failed' => (isFailedManagerEvent(event) ? 'failed' : event.kind);

export const MANAGER_EVENT_TYPE = 'multitask-event';
export const MANAGER_EVENT_MESSAGE_TYPE = 'multitask_event';

export const managerEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum([...MANAGER_EVENT_KINDS, UNKNOWN_EVENT_KIND, 'issue']),
  agentId: z.string(),
  agentName: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  // Set when the subagent is a chat in this workspace rather than a ship; agentId is then that chat's id.
  chatId: z.string().optional(),
  issue: z.object({ title: z.string(), url: z.string(), changes: z.array(issueEventChangeSchema) }).optional(),
  // Set on events recorded before every kind woke the orchestrator, which were shown as a row when they happened.
  noticed: z.boolean().optional(),
});
export type ManagerEvent = z.infer<typeof managerEventSchema>;

const TAG = MULTITASK_EVENT_TAG;
const BLOCK = tagBlockPattern(TAG);
const ISSUE_BLOCK = tagBlockPattern(ISSUE_EVENT_TAG);

const EVENT_RESPONSE_MAX_CHARS = 8_000;

export function truncateManagerEventResponse(response: string, readTool: string): string {
  return response.length > EVENT_RESPONSE_MAX_CHARS ? `${response.slice(0, EVENT_RESPONSE_MAX_CHARS)}…\n\n(Truncated; ${readTool} returns the full response.)` : response;
}

export function formatManagerEvents(events: ManagerEvent[]): string {
  return events.map((event) => {
    const attributes = { id: event.id, at: event.at, kind: event.kind, agent: event.agentName, agent_id: event.agentId, ...(event.chatId ? { chat_id: event.chatId } : {}), ...(event.noticed ? { noticed: 'true' } : {}) };
    const body = [event.summary, event.detail].filter(Boolean).join('\n\n').replaceAll(`</${TAG}`, `<\\/${TAG}`);
    return `<${TAG}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeTagAttribute(value)}"`).join('')}>\n${body}\n</${TAG}>`;
  }).join('\n\n');
}

export function extractManagerEvents(text: string): ManagerEvent[] {
  return [...text.matchAll(BLOCK)].flatMap((match) => {
    const attributes = parseTagAttributes(match[1]);
    if (!attributes.kind || !attributes.id || !attributes.agent_id) return [];
    const kind = MANAGER_EVENT_KINDS.find((candidate) => candidate === attributes.kind) ?? UNKNOWN_EVENT_KIND;
    const [summary, ...rest] = match[2].replaceAll(`<\\/${TAG}`, `</${TAG}`).split('\n\n');
    const detail = stripAgentInstructionBlocks(rest.join('\n\n'));
    return [{
      id: attributes.id,
      at: attributes.at ?? '',
      kind,
      agentId: attributes.agent_id,
      agentName: attributes.agent ?? 'ship',
      summary: summary.trim(),
      ...(detail ? { detail } : {}),
      ...(attributes.chat_id ? { chatId: attributes.chat_id } : {}),
      ...(attributes.noticed === 'true' ? { noticed: true } : {}),
    }];
  });
}

export function parseManagerEvents(text: string): ManagerEvent[] | null {
  const events = [...extractManagerEvents(text), ...extractIssueEvents(text)];
  return events.length > 0 && text.replace(BLOCK, '').replace(ISSUE_BLOCK, '').replaceAll(MERGED_MESSAGE_SEPARATOR.trim(), '').trim() === '' ? events : null;
}

/** Also true for previews cut off mid-block. */
export function isManagerEventMessage(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith(`<${TAG} `) || start.startsWith(`<${ISSUE_EVENT_TAG} `);
}

// A report or an issue comment is someone's own text and may quote instruction tags, so a tag inside an event never opens or closes a note.
export function stripManagerEventNotes(content: string): string {
  return stripInstructionBlocksOutside(content, [...content.matchAll(BLOCK), ...content.matchAll(ISSUE_BLOCK)].map((block) => [block.index, block.index + block[0].length]));
}

// Merged bursts are parsed whole, since a separator can also appear inside a quoted report.
export function parseManagerEventMessage(content: string): ManagerEvent[] | null {
  return parseManagerEvents(stripManagerEventNotes(content));
}

// Ship updates wait in the same queue as the user's messages, but the user never sees or acts on them there.
export function isUserQueuedMessage(message: string, senderUserId?: string): boolean {
  return parseManagerEventMessage(message) === null && (Boolean(senderUserId) || !parseMessageOrigin(message));
}

// A running workspace keeps the engine it started with, so the app still meets engines that send no senders.
export const isOwnQueuedMessage = ({ queueSenderUserIds }: Pick<InterruptChatResponse, 'queueSenderUserIds'>, userId: string | undefined) =>
  (message: string, index: number) => isUserQueuedMessage(message, queueSenderUserIds?.[index] ?? undefined) && (!queueSenderUserIds || queueSenderUserIds[index] === userId);

const MANAGER_EVENT_LABELS: Record<ManagerEventKind, string> = {
  finished: 'Finished',
  ready: 'Ready to merge',
  needs_attention: 'Needs attention',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
  archived: 'Archived',
  replied: 'Replied',
  update: 'Update',
  issue: 'Updated',
};

export function managerEventLabel(event: ManagerEvent): string {
  if (isFailedManagerEvent(event)) return 'Failed';
  if (event.kind === 'issue' && event.summary) return event.summary;
  return event.summary === MANAGER_READY_FOR_REVIEW_SUMMARY ? 'Ready for review' : MANAGER_EVENT_LABELS[event.kind];
}

// For "<ship> <verb>", keeping a ticket title's own capitals and the name an issue change starts with.
export function managerEventVerb(event: ManagerEvent): string {
  const label = managerEventLabel(event);
  return event.kind === 'issue' ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

const PULL_REQUEST_URL = /https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/g;

export function managerReportPreview(report: string): string {
  const firstLine = report.split('\n').find((line) => line.trim())?.trim().replace(/`|\*\*/g, '') ?? '';
  return firstLine.replace(PULL_REQUEST_URL, (url) => formatCodeHostRequestRef(url) ?? url);
}

/** A finished event's own response says more than its generic summary. */
export function managerEventPreview(event: ManagerEvent): string {
  return managerReportPreview((event.kind === 'finished' && event.detail?.trim()) || event.summary);
}

const NAME_WORDS: Record<string, string> = {
  api: 'API', ci: 'CI', cli: 'CLI', ga: 'GA', github: 'GitHub', gitlab: 'GitLab', mcp: 'MCP', mr: 'MR', pr: 'PR', prs: 'PRs', sdk: 'SDK', ui: 'UI', url: 'URL',
};

export function formatManagerSubagentName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) return name;
  const ticket = name.match(/^([a-z]{2,10})-(\d+)(?:-(?=\d*[a-z])|$)/);
  const rest = ticket ? name.slice(ticket[0].length) : name;
  const words = rest.split('-').map((word) => NAME_WORDS[word] ?? word).join(' ');
  return ticket ? `${ticket[1].toUpperCase()}-${ticket[2]} ${words}`.trim() : words.charAt(0).toUpperCase() + words.slice(1);
}

const LIFECYCLE_PRIORITY: ManagerEventKind[] = ['needs_attention', 'merged', 'closed', 'approved', 'ready', 'replied', 'issue'];

export const MANAGER_DEPLOYMENT_LABELS: Partial<Record<PullRequestDeployment['state'], string>> = { running: 'Deploying', succeeded: 'Deployed', failed: 'Deploy failed', blocked: 'Deploy blocked' };

export type ManagerLifecycleRow = { lead: ManagerEvent; events: ManagerEvent[]; label: string; urls: string[] };

export function managerLifecycleRows(events: ManagerEvent[]): ManagerLifecycleRow[] {
  const byShip = new Map<string, ManagerEvent[]>();
  for (const event of events) if (LIFECYCLE_PRIORITY.includes(event.kind)) {
    const key = event.agentId;
    byShip.set(key, [...byShip.get(key) ?? [], event]);
  }
  return [...byShip.values()].map((group) => {
    const ordered = [...group].sort((a, b) => LIFECYCLE_PRIORITY.indexOf(a.kind) - LIFECYCLE_PRIORITY.indexOf(b.kind));
    return {
      lead: ordered[0],
      events: group,
      label: [...new Set(group.map(managerEventLabel))].join(' · '),
      urls: [...new Set(group.flatMap((event) => event.summary.match(PULL_REQUEST_URL) ?? []))],
    };
  });
}
