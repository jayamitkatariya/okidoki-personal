import { z } from 'zod';
import { isRecord } from '../type-guards';
import { UUID_RE } from '../uuid';
import { managerAvatarSchema } from './manager';
import { WORKSPACE_KINDS, WORKSPACE_STATUSES } from './workspaces';

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'approved', 'done', 'canceled', 'duplicate'] as const;
export const CLOSED_ISSUE_STATUSES: readonly IssueStatus[] = ['done', 'canceled', 'duplicate'];
export const ISSUE_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
export const ISSUE_ACTOR_TYPES = ['user', 'workspace', 'system'] as const;
export const ISSUE_SUBSCRIBER_ROLES = ['assignee', 'creator', 'mentioned', 'manual'] as const;
export const ISSUE_RELATION_TYPES = ['blocks', 'duplicate_of'] as const;
export const ISSUE_PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed'] as const;

/** `in_review` became `review`; clients and rows from before the rename still send or hold it. */
export const normalizeIssueStatus = (status: string): string => status === 'in_review' ? 'review' : status;
export const issueStatusSchema = z.preprocess((value) => typeof value === 'string' ? normalizeIssueStatus(value) : value, z.enum(ISSUE_STATUSES));
export const issuePrioritySchema = z.enum(ISSUE_PRIORITIES);
export const issueSubscriberRoleSchema = z.enum(ISSUE_SUBSCRIBER_ROLES);
export const issueRelationTypeSchema = z.enum(ISSUE_RELATION_TYPES);
export const issuePullRequestStateSchema = z.enum(ISSUE_PULL_REQUEST_STATES);
export type IssueStatus = z.infer<typeof issueStatusSchema>;
export type IssuePriority = z.infer<typeof issuePrioritySchema>;
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = { backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', review: 'Review', approved: 'Approved', done: 'Done', canceled: 'Canceled', duplicate: 'Duplicate' };
export const ISSUE_PRIORITY_LABELS: Record<IssuePriority, string> = { none: 'No priority', urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
export type IssueSubscriberRole = z.infer<typeof issueSubscriberRoleSchema>;
export type IssueRelationType = z.infer<typeof issueRelationTypeSchema>;
export type IssuePullRequestState = z.infer<typeof issuePullRequestStateSchema>;

let unknownValues: string[] | null = null;
/** A value from a newer build (a status added later) reads as its raw string instead of failing the record. */
const knownOrRaw = <T extends z.ZodType<string>>(known: T) => z.union([known, z.custom<string & {}>((value) => {
  if (typeof value !== 'string') return false;
  unknownValues?.push(value);
  return true;
})]);
function readUnknownIssueValues<T>(parse: () => T): { result: T; unknown: string[] } {
  const unknown: string[] = [];
  unknownValues = unknown;
  try {
    return { result: parse(), unknown };
  } finally {
    unknownValues = null;
  }
}

export interface IssueContractReport { problems: Set<string>; dropped: number; kept: number }
export const createIssueContractReport = (): IssueContractReport => ({ problems: new Set(), dropped: 0, kept: 0 });

export function parseIssueContractRecord<S extends z.core.$ZodType>(schema: S, value: unknown, at: string, report: IssueContractReport): z.output<S> | undefined {
  const { result, unknown } = readUnknownIssueValues(() => z.safeParse(schema, value, { reportInput: true }));
  if (result.success) {
    if (unknown.length) report.kept++;
    for (const raw of unknown) report.problems.add(`${at || 'snapshot'} unknown_value ${raw.slice(0, 40)}`);
    return result.data;
  }
  for (const issue of result.error.issues) {
    const path = [at, ...issue.path.map((key) => (typeof key === 'number' || UUID_RE.test(String(key)) ? '*' : String(key)))].filter(Boolean).join('.');
    report.problems.add(`${path} ${issue.code}${issue.code === 'invalid_value' ? ` ${String(issue.input).slice(0, 40)}` : ''}`);
  }
  report.dropped++;
  return undefined;
}

/** Drops each array row that breaks the contract on its own, so a record from a newer server never fails the whole response. */
export function parseIssueContractResponse<S extends z.ZodObject>(schema: S, value: unknown, report: IssueContractReport): z.output<S> | undefined {
  const rows = isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    const field = schema.shape[key];
    return [key, field instanceof z.ZodArray && Array.isArray(raw) ? raw.filter((row) => parseIssueContractRecord(field.element, row, key, report) !== undefined) : raw];
  })) : value;
  const parsed = z.safeParse(schema, rows);
  if (!parsed.success) for (const issue of parsed.error.issues) report.problems.add(`${issue.path.join('.')} ${issue.code}`);
  return parsed.data;
}

/** A person (`user`, the auth user id), an agent (`workspace`, the workspace id), or Okidoki itself (`system`). Managers are workspaces. */
export const knownIssueActorSchema = z.object({
  type: z.enum(ISSUE_ACTOR_TYPES),
  id: z.string().toLowerCase().uuid(),
});
export const issueActorSchema = knownIssueActorSchema.extend({ type: knownOrRaw(knownIssueActorSchema.shape.type) });
export type IssueActor = z.infer<typeof issueActorSchema>;
/** An actor a client may send: requests only accept the types this build knows. */
export type KnownIssueActor = z.infer<typeof knownIssueActorSchema>;
export const ISSUE_SYSTEM_ACTOR: IssueActor = { type: 'system', id: '00000000-0000-0000-0000-000000000000' };

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
export const ISSUE_IDENTIFIER_RE = /\b([A-Z][A-Z0-9]{0,9})-(\d{1,9})\b/g;

export function formatIssueIdentifier(issueKey: string, number: number): string {
  return `${issueKey}-${number}`;
}

export function issueStatusTimestamps<T>(status: IssueStatus, at: T): { completed_at: T | null; canceled_at: T | null } {
  return {
    completed_at: status === 'done' ? at : null,
    canceled_at: status === 'canceled' || status === 'duplicate' ? at : null,
  };
}

/** A mention is a markdown link (`[@Ada](mention://user/<id>)`), so it still reads as a link where chips aren't rendered. */
export const ISSUE_MENTION_LINK = /\[@([^\]]*)\]\(mention:\/\/(user|workspace)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function formatIssueMention(actor: IssueActor, label: string): string {
  return `[@${label.replace(/[[\]\\`]/g, '')}](mention://${actor.type}/${actor.id})`;
}

export function parseIssueMentions(markdown: string): IssueActor[] {
  const seen = new Map<string, IssueActor>();
  for (const [, , type, id] of markdown.matchAll(ISSUE_MENTION_LINK)) {
    const actor: IssueActor = { type: type.toLowerCase() === 'user' ? 'user' : 'workspace', id: id.toLowerCase() };
    seen.set(`${actor.type}:${actor.id}`, actor);
  }
  return [...seen.values()];
}

const timestamp = z.string();
const nullableTimestamp = timestamp.nullable();

export const issueSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  number: z.number().int(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  status: knownOrRaw(issueStatusSchema),
  priority: knownOrRaw(issuePrioritySchema),
  parent_id: z.string().uuid().nullable(),
  manager_id: z.string().uuid().nullable(),
  creator: issueActorSchema,
  /** Fractional: to move an issue between two others, send the midpoint of their sort orders. */
  sort_order: z.number(),
  created_at: timestamp,
  updated_at: timestamp,
  completed_at: nullableTimestamp,
  canceled_at: nullableTimestamp,
  archived_at: nullableTimestamp,
});
export type Issue = z.infer<typeof issueSchema>;

/** An assignee is a subscriber with role `assignee`. Every principal has at most one row per issue. */
export const issueSubscriberSchema = z.object({
  issue_id: z.string().uuid(),
  subscriber: issueActorSchema,
  role: issueSubscriberRoleSchema,
  created_at: timestamp,
});
export type IssueSubscriber = z.infer<typeof issueSubscriberSchema>;

export const issueRelationSchema = z.object({
  id: z.string().uuid(),
  type: issueRelationTypeSchema,
  issue_id: z.string().uuid(),
  related_issue_id: z.string().uuid(),
  created_at: timestamp,
});
export type IssueRelation = z.infer<typeof issueRelationSchema>;

export const issuePullRequestSchema = z.object({
  id: z.string().uuid(),
  issue_id: z.string().uuid(),
  url: z.string(),
  pull_request_id: z.string().uuid().nullable(),
  title: z.string().nullable(),
  state: knownOrRaw(issuePullRequestStateSchema),
  approved: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type IssuePullRequest = z.infer<typeof issuePullRequestSchema>;

export const issueCommentSchema = z.object({
  id: z.string().uuid(),
  issue_id: z.string().uuid(),
  author: issueActorSchema,
  body: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type IssueComment = z.infer<typeof issueCommentSchema>;

const change = <T extends z.ZodType>(value: T) => z.object({ from: value, to: value });
const nullableId = z.string().uuid().nullable();

/**
 * Every event carries what a client needs to apply it to its bootstrap state.
 * Field changes also move the issue's `updated_at` to the event's `created_at`.
 */
export const ISSUE_EVENT_TYPES = [
  'created', 'title_changed', 'description_changed', 'status_changed', 'priority_changed', 'parent_changed', 'manager_changed',
  'sort_order_changed', 'assignee_added', 'assignee_removed', 'subscriber_added', 'subscriber_removed', 'relation_added',
  'relation_removed', 'pr_linked', 'pr_unlinked', 'pr_state_changed', 'comment_added', 'comment_edited', 'comment_deleted',
  'archived', 'restored',
] as const;
export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];

export const issueEventDataSchemas = {
  created: z.object({ issue: issueSchema }),
  title_changed: change(z.string()),
  description_changed: change(z.string()),
  status_changed: change(knownOrRaw(issueStatusSchema)).extend({ completed_at: nullableTimestamp, canceled_at: nullableTimestamp, reason: z.string().optional() }),
  priority_changed: change(knownOrRaw(issuePrioritySchema)),
  parent_changed: change(nullableId),
  manager_changed: change(nullableId),
  sort_order_changed: change(z.number()),
  /** `subscriber` is the row after the change: an unassigned principal stays subscribed with role `manual`. */
  assignee_added: z.object({ subscriber: issueSubscriberSchema }),
  assignee_removed: z.object({ subscriber: issueSubscriberSchema }),
  subscriber_added: z.object({ subscriber: issueSubscriberSchema }),
  subscriber_removed: z.object({ subscriber: issueSubscriberSchema }),
  relation_added: z.object({ relation: issueRelationSchema }),
  relation_removed: z.object({ relation: issueRelationSchema }),
  pr_linked: z.object({ pull_request: issuePullRequestSchema }),
  pr_unlinked: z.object({ pull_request: issuePullRequestSchema }),
  pr_state_changed: z.object({ pull_request: issuePullRequestSchema, from: knownOrRaw(issuePullRequestStateSchema) }),
  comment_added: z.object({ comment: issueCommentSchema }),
  comment_edited: z.object({ comment: issueCommentSchema, from: z.string() }),
  comment_deleted: z.object({ comment: issueCommentSchema }),
  archived: z.object({ archived_at: timestamp }),
  restored: z.object({
    issue: issueSchema,
    subscribers: z.array(issueSubscriberSchema),
    relations: z.array(issueRelationSchema),
    pull_requests: z.array(issuePullRequestSchema),
  }),
} as const satisfies Record<IssueEventType, z.ZodType>;

export type IssueEventData<T extends IssueEventType = IssueEventType> = z.infer<(typeof issueEventDataSchemas)[T]>;

const issueEventBase = z.object({
  sync_id: z.number().int(),
  issue_id: z.string().uuid(),
  actor: issueActorSchema,
  /** Echo of the `client_mutation_id` sent with the write, so the writer can settle its optimistic change. */
  client_mutation_id: z.string().nullable(),
  created_at: timestamp,
});

export type IssueEvent = { [T in IssueEventType]: z.infer<typeof issueEventBase> & { type: T; data: IssueEventData<T> } }[IssueEventType];
const v = <T extends IssueEventType>(type: T) => issueEventBase.extend({ type: z.literal(type), data: issueEventDataSchemas[type] });
// Keyed by every IssueEventType, so a new event type fails to compile until it has a variant here.
const issueEventVariants: { [T in IssueEventType]: ReturnType<typeof v<T>> } = { created: v('created'), title_changed: v('title_changed'), description_changed: v('description_changed'), status_changed: v('status_changed'), priority_changed: v('priority_changed'), parent_changed: v('parent_changed'), manager_changed: v('manager_changed'), sort_order_changed: v('sort_order_changed'), assignee_added: v('assignee_added'), assignee_removed: v('assignee_removed'), subscriber_added: v('subscriber_added'), subscriber_removed: v('subscriber_removed'), relation_added: v('relation_added'), relation_removed: v('relation_removed'), pr_linked: v('pr_linked'), pr_unlinked: v('pr_unlinked'), pr_state_changed: v('pr_state_changed'), comment_added: v('comment_added'), comment_edited: v('comment_edited'), comment_deleted: v('comment_deleted'), archived: v('archived'), restored: v('restored') };
const { created, ...laterVariants } = issueEventVariants;
export const issueEventSchema = z.discriminatedUnion('type', [created, ...Object.values(laterVariants)]);

export function describeIssueEvent(event: IssueEvent, name: (actor: IssueActor) => string, identifierOf: (issueId: string) => string, quote?: (text: string) => string): string | null {
  const withText = (line: string, lead: string, text: string | undefined) => (quote && text ? `${line}${lead}\n${quote(text)}` : line);
  switch (event.type) {
    case 'created': return withText(`created it (${event.data.issue.status}, priority ${event.data.issue.priority})`, ':', event.data.issue.description);
    case 'title_changed': return `renamed it: "${event.data.from}" → "${event.data.to}"`;
    case 'description_changed': return quote ? `edited the description. Now:\n${quote(event.data.to)}` : 'edited the description';
    case 'status_changed': return withText(`changed the status: ${event.data.from} → ${event.data.to}`, '', event.data.reason);
    case 'priority_changed': return `changed the priority: ${event.data.from} → ${event.data.to}`;
    case 'parent_changed': return event.data.to ? `made it a sub-issue of ${identifierOf(event.data.to)}` : 'made it a top-level issue';
    case 'manager_changed': return event.data.to ? `moved it to Manager ${name({ type: 'workspace', id: event.data.to })}` : 'removed it from its Manager';
    case 'assignee_added': return `assigned ${name(event.data.subscriber.subscriber)}`;
    case 'assignee_removed': return `unassigned ${name(event.data.subscriber.subscriber)}`;
    case 'relation_added': return event.data.relation.type === 'blocks'
      ? `marked that ${identifierOf(event.data.relation.issue_id)} blocks ${identifierOf(event.data.relation.related_issue_id)}`
      : `marked ${identifierOf(event.data.relation.issue_id)} a duplicate of ${identifierOf(event.data.relation.related_issue_id)}`;
    case 'relation_removed': return `removed the ${event.data.relation.type === 'blocks' ? 'blocking' : 'duplicate'} link between ${identifierOf(event.data.relation.issue_id)} and ${identifierOf(event.data.relation.related_issue_id)}`;
    case 'pr_linked': return `linked a pull request: ${event.data.pull_request.url}${event.data.pull_request.title ? ` (${event.data.pull_request.title})` : ''}`;
    case 'pr_unlinked': return `unlinked a pull request: ${event.data.pull_request.url}`;
    case 'pr_state_changed': return event.data.from === event.data.pull_request.state
      ? `pull request ${event.data.pull_request.url}: ${event.data.pull_request.approved ? 'approved' : 'no longer approved'}`
      : `pull request ${event.data.pull_request.url}: ${event.data.from} → ${event.data.pull_request.state}`;
    case 'comment_added': return withText('commented', ':', event.data.comment.body);
    case 'comment_edited': return withText('edited a comment', '. Now:', event.data.comment.body);
    case 'comment_deleted': return 'deleted a comment';
    case 'archived': return 'archived it';
    case 'restored': return 'restored it';
    case 'subscriber_added':
    case 'subscriber_removed':
    case 'sort_order_changed': return null;
  }
}

export const issueActorDirectorySchema = z.record(z.string(), z.object({ name: z.string(), handle: z.string() }));
export type IssueActorDirectory = z.infer<typeof issueActorDirectorySchema>;

export function issueActorHandle(actor: IssueActor, directory: IssueActorDirectory): string | null {
  return actor.type === 'system' ? 'system' : actor.type === 'workspace' ? `workspace:${actor.id}` : directory[`${actor.type}:${actor.id}`]?.handle ?? null;
}

export function formatIssueActor(actor: IssueActor, directory: IssueActorDirectory): string {
  if (actor.type === 'system') return 'Okidoki';
  const known = directory[`${actor.type}:${actor.id}`];
  return known ? `${known.name} (${known.handle})` : actor.type === 'workspace' ? `An agent (workspace:${actor.id})` : 'Someone';
}

export function renderIssueMentions(markdown: string, directory: IssueActorDirectory): string {
  return markdown.replace(ISSUE_MENTION_LINK, (_link, label: string, type: string, id: string) => {
    const known = directory[`${type.toLowerCase()}:${id.toLowerCase()}`];
    return known ? `@${known.name} (${known.handle})` : `@${label}`;
  });
}

export function mapIssueActors(value: unknown, map: { actor: (actor: IssueActor) => unknown; text: (text: string) => string }): unknown {
  if (typeof value === 'string') return map.text(value);
  if (Array.isArray(value)) return value.map((item) => mapIssueActors(item, map));
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 2 && typeof value.id === 'string' && ISSUE_ACTOR_TYPES.some((type) => type === value.type)) return map.actor({ type: String(value.type), id: value.id });
  const manager = (id: unknown) => (typeof id === 'string' ? map.actor({ type: 'workspace', id }) : id);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    if (key === 'manager_id') return [key, manager(inner)];
    if (key === 'data' && value.type === 'manager_changed' && isRecord(inner)) return [key, { ...inner, from: manager(inner.from), to: manager(inner.to) }];
    return [key, mapIssueActors(inner, map)];
  }));
}

const clientMutationId = z.string().min(1).max(128).optional();
const title = z.string().trim().min(1).max(500);
const description = z.string().max(100_000);
const body = z.string().trim().min(1).max(100_000);

export const createIssueRequestSchema = z.object({
  /** Client-generated id, so an optimistic create can be referenced before the server answers. */
  id: z.string().uuid().optional(),
  title,
  description: description.optional(),
  status: issueStatusSchema.optional(),
  priority: issuePrioritySchema.optional(),
  parent_id: z.string().uuid().optional(),
  manager_id: z.string().uuid().optional(),
  sort_order: z.number().finite().optional(),
  assignees: z.array(knownIssueActorSchema).max(20).optional(),
  subscribers: z.array(knownIssueActorSchema).max(50).optional(),
  client_mutation_id: clientMutationId,
});
export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;

export const updateIssueRequestSchema = z.object({
  title: title.optional(),
  description: description.optional(),
  status: issueStatusSchema.optional(),
  priority: issuePrioritySchema.optional(),
  // PATCH semantics: null clears the parent or Manager, omitting it leaves it unchanged.
  parent_id: nullableId.optional(),
  manager_id: nullableId.optional(),
  sort_order: z.number().finite().optional(),
  client_mutation_id: clientMutationId,
});
export type UpdateIssueRequest = z.infer<typeof updateIssueRequestSchema>;

/** Add an assignee or subscriber. With no body, subscribes the caller. */
export const issueActorRequestSchema = knownIssueActorSchema.partial().extend({ client_mutation_id: clientMutationId });
export type IssueActorRequest = z.infer<typeof issueActorRequestSchema>;

export const createIssueCommentRequestSchema = z.object({
  id: z.string().uuid().optional(),
  body,
  client_mutation_id: clientMutationId,
});
export type CreateIssueCommentRequest = z.infer<typeof createIssueCommentRequestSchema>;

export const updateIssueCommentRequestSchema = z.object({ body, client_mutation_id: clientMutationId });
export type UpdateIssueCommentRequest = z.infer<typeof updateIssueCommentRequestSchema>;

export const createIssueRelationRequestSchema = z.object({
  id: z.string().uuid().optional(),
  type: issueRelationTypeSchema,
  related_issue: z.string().min(1),
  client_mutation_id: clientMutationId,
});
export type CreateIssueRelationRequest = z.infer<typeof createIssueRelationRequestSchema>;

export const linkIssuePullRequestRequestSchema = z.object({
  id: z.string().uuid().optional(),
  url: z.string().url().max(2_000),
  title: z.string().max(500).optional(),
  state: issuePullRequestStateSchema.optional(),
  pull_request_id: z.string().uuid().optional(),
  client_mutation_id: clientMutationId,
});
export type LinkIssuePullRequestRequest = z.infer<typeof linkIssuePullRequestRequestSchema>;

export const updateIssuePullRequestRequestSchema = z.object({
  state: issuePullRequestStateSchema,
  client_mutation_id: clientMutationId,
});
export type UpdateIssuePullRequestRequest = z.infer<typeof updateIssuePullRequestRequestSchema>;

export const issueMutationRequestSchema = z.object({ client_mutation_id: clientMutationId });
export type IssueMutationRequest = z.infer<typeof issueMutationRequestSchema>;

export const updateIssueSettingsRequestSchema = z.object({ issue_key: z.string().trim().toUpperCase().regex(ISSUE_KEY_RE) });
export type UpdateIssueSettingsRequest = z.infer<typeof updateIssueSettingsRequestSchema>;

/**
 * `GET /v1/issues` query. Comma-separate values to match any of them.
 * Actors are `user:<id>`, `workspace:<id>` or `me` (the caller). `parent_id=none` matches top-level issues.
 */
export const listIssuesQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  subscriber: z.string().optional(),
  creator: z.string().optional(),
  manager_id: z.string().optional(),
  parent_id: z.string().optional(),
  q: z.string().max(200).optional(),
  include_archived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
});
export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;


export interface IssueMutationResponse {
  issue: Issue;
  events: IssueEvent[];
}

export interface IssueCommentMutationResponse {
  comment: IssueComment;
  events: IssueEvent[];
}

export interface IssueRelationMutationResponse {
  relation: IssueRelation;
  events: IssueEvent[];
}

export interface IssuePullRequestMutationResponse {
  pull_request: IssuePullRequest;
  events: IssueEvent[];
}

export interface IssueSubscriberMutationResponse {
  subscriber: IssueSubscriber;
  events: IssueEvent[];
}

export const issueDetailResponseSchema = z.object({
  issue: issueSchema,
  subscribers: z.array(issueSubscriberSchema),
  relations: z.array(issueRelationSchema),
  pull_requests: z.array(issuePullRequestSchema),
  comments: z.array(issueCommentSchema),
  events: z.array(issueEventSchema),
  sub_issues: z.array(issueSchema),
});
export type IssueDetailResponse = z.infer<typeof issueDetailResponseSchema>;

export const listIssuesResponseSchema = z.object({ issues: z.array(issueSchema), next_cursor: z.number().nullable() });
export type ListIssuesResponse = z.infer<typeof listIssuesResponseSchema>;

export interface IssueSettingsResponse {
  issue_key: string;
}

export const issueDirectoryUserSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  email: z.string(),
  avatar_url: z.string().nullable(),
});
export type IssueDirectoryUser = z.infer<typeof issueDirectoryUserSchema>;

export const issueDirectoryWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(WORKSPACE_KINDS),
  status: z.enum(WORKSPACE_STATUSES),
  avatar: managerAvatarSchema.nullable(),
  manager_id: z.string().nullable(),
});
export type IssueDirectoryWorkspace = z.infer<typeof issueDirectoryWorkspaceSchema>;

/**
 * `GET /v1/issues/sync/bootstrap`: every non-archived issue in the org with its subscribers, relations
 * (where either side is non-archived) and PR links, as of `sync_id`. Comments load per issue.
 * Then pull `GET /v1/issues/sync/delta?after=<sync_id>` until `has_more` is false.
 * `workspaces` is every Manager in the org and every workspace that created or subscribes to a returned issue.
 */
export const issuesBootstrapResponseSchema = z.object({
  sync_id: z.number().int(),
  issue_key: z.string(),
  users: z.array(issueDirectoryUserSchema),
  workspaces: z.array(issueDirectoryWorkspaceSchema),
  issues: z.array(issueSchema),
  subscribers: z.array(issueSubscriberSchema),
  relations: z.array(issueRelationSchema),
  pull_requests: z.array(issuePullRequestSchema),
});
export type IssuesBootstrapResponse = z.infer<typeof issuesBootstrapResponseSchema>;

export const issuesDeltaQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});
export type IssuesDeltaQuery = z.infer<typeof issuesDeltaQuerySchema>;

/**
 * Events after `after`, oldest first. `sync_id` is the cursor for the next call. Events on archived
 * issues are included; `archived` drops an issue from the bootstrap set and `restored` brings it back.
 */
export const issuesDeltaResponseSchema = z.object({
  sync_id: z.number().int(),
  issue_key: z.string(),
  users: z.array(issueDirectoryUserSchema),
  workspaces: z.array(issueDirectoryWorkspaceSchema),
  events: z.array(issueEventSchema),
  has_more: z.boolean(),
});
export type IssuesDeltaResponse = z.infer<typeof issuesDeltaResponseSchema>;

export const issueInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.coerce.number().int().min(1).optional(),
});
export type IssueInboxQuery = z.infer<typeof issueInboxQuerySchema>;

interface IssueInboxItem {
  event: IssueEvent;
  issue: Pick<Issue, 'id' | 'identifier' | 'title' | 'status'>;
  reason: IssueSubscriberRole;
  unread: boolean;
}

export interface IssueInboxResponse {
  items: IssueInboxItem[];
  unread_count: number;
  next_cursor: number | null;
}

export const ISSUE_INBOX_UNREAD_MAX = 100;

export const markIssueInboxReadRequestSchema = z.object({ sync_id: z.number().int().min(0).optional() });

export type IssueInboxReadResponse = Pick<IssueInboxResponse, 'unread_count'>;

export const ISSUE_COMMANDS = {
  create: 'create',
  update: 'update',
  get: 'get',
  list: 'list',
  comment: 'comment',
  assign: 'assign',
  unassign: 'unassign',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  linkPr: 'link-pr',
  unlinkPr: 'unlink-pr',
  relate: 'relate',
} as const;
export type IssueCommand = (typeof ISSUE_COMMANDS)[keyof typeof ISSUE_COMMANDS];
