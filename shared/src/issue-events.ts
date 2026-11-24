import { z } from 'zod';
import type { ManagerEvent } from './manager-events';
import { ISSUE_MENTION_LINK, ISSUE_PRIORITY_LABELS, ISSUE_STATUS_LABELS, issuePrioritySchema, issueStatusSchema } from './routes/issues';
import { parseTagAttributes, tagBlockPattern } from './tag-blocks';

export const ISSUE_EVENT_TAG = 'issue_event';

const transitionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('status'), from: issueStatusSchema, to: issueStatusSchema }),
  z.object({ field: z.literal('priority'), from: issuePrioritySchema, to: issuePrioritySchema }),
]);

export const issueEventChangeSchema = z.object({ actor: z.string(), agent: z.boolean(), text: z.string(), quote: z.string().optional(), transition: transitionSchema.optional() });
export type IssueEventChange = z.infer<typeof issueEventChangeSchema>;

const ACTOR_HANDLE = / \((?:agent|user:[^\s)]+|workspace:[^\s)]+)\)/g;
const CHANGE_LINE = /^(.+?)(?:( \((?:agent|workspace:[^\s)]+)\))| \(user:[^\s)]+\))? (created it|renamed it|edited |changed the |made it|moved it|removed |assigned |unassigned |marked |linked |unlinked |pull request |commented|deleted a comment|archived it|restored it)(.*)$/;
const TRANSITION = /^changed the (status|priority): (\w+) → (\w+)$/;

function parseChange(line: string, quote: string): IssueEventChange {
  const match = line.match(CHANGE_LINE);
  const rest = (match ? match[3] + match[4] : line).replace(ACTOR_HANDLE, '').replace(/(?:\. Now)?:$/, '');
  const [, field, from, to] = rest.match(TRANSITION) ?? [];
  const transition = transitionSchema.safeParse({ field, from, to }).data;
  const labels = !transition ? [] : transition.field === 'status' ? [ISSUE_STATUS_LABELS[transition.from], ISSUE_STATUS_LABELS[transition.to]] : [ISSUE_PRIORITY_LABELS[transition.from], ISSUE_PRIORITY_LABELS[transition.to]];
  const text = transition ? `changed the ${transition.field}: ${labels.join(' → ')}` : rest;
  const excerpt = quote.split('\n').map((quoted) => quoted.trim()).find(Boolean);
  return { actor: match?.[1] ?? '', agent: Boolean(match?.[2]), text: excerpt ? `${text}: ${excerpt}` : text, ...(quote ? { quote } : {}), ...(transition ? { transition } : {}) };
}

const issueChangeSentence = (change: IssueEventChange) => [change.actor, change.text].filter(Boolean).join(' ');

export function extractIssueEvents(text: string): ManagerEvent[] {
  return [...text.matchAll(tagBlockPattern(ISSUE_EVENT_TAG))].flatMap((match) => {
    const attributes = parseTagAttributes(match[1]);
    if (!attributes.issue) return [];
    const detail = match[2].replaceAll(`<\\/${ISSUE_EVENT_TAG}`, `</${ISSUE_EVENT_TAG}`).trim();
    const changes = detail.split('\n\n').flatMap((paragraph) => {
      const [line, ...quoted] = paragraph.split('\n');
      if (!line.trim() || line.startsWith('>')) return [];
      return [parseChange(line, quoted.map((quote) => quote.replace(/^>\s?/, '').replace(ACTOR_HANDLE, '')).join('\n').trim())];
    });
    return [{
      id: `${attributes.issue}:${attributes.sync_id ?? ''}`,
      at: '',
      kind: 'issue',
      agentId: attributes.issue,
      agentName: attributes.issue,
      summary: changes.map(issueChangeSentence).join(' · ').replace(ISSUE_MENTION_LINK, '@$1'),
      ...(detail ? { detail } : {}),
      issue: { title: attributes.title ?? '', url: attributes.url ?? '', changes },
    }];
  });
}
