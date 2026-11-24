import { z } from 'zod';
import type { ChatSummary } from '../engine/v1';
import type { DisplayMessage } from '../display-message/types';
import { getChatKind } from '../chat-kind';
import type { PullRequestChecksSummary, PullRequestCiStatus, PullRequestDetails, PullRequestMergeability, PullRequestReviewDecision, PullRequestStatus, WorkspacePullRequestAction } from './pull-requests';
import { WEB_APP_PATHS, buildCodeHostPrUrl, decodePathSegments, formatPullRequestNumber, getPullRequestNoun, getPullRequestViewUrl, parseCodeHostPrUrl, type ParsedCodeHostPrUrl } from '../urls';

export interface PullRequestReviewActor {
  login: string;
  avatarUrl: string | null;
  isBot: boolean;
}

export interface PullRequestReviewTeam {
  slug: string;
  name: string;
}

export interface PullRequestReviewBotScore {
  value: number;
  max: number;
}

export interface PullRequestReviewBotSummary {
  actor: PullRequestReviewActor;
  score: PullRequestReviewBotScore;
}

const REVIEW_BOTS: Record<string, { name: string; retriggerComment: string }> = {
  'greptile-apps': { name: 'Greptile', retriggerComment: '@greptileai' },
  coderabbitai: { name: 'CodeRabbit', retriggerComment: '@coderabbitai review' },
  cursor: { name: 'Cursor Bugbot', retriggerComment: 'bugbot run' },
};

/** REST logins end in `[bot]` and GraphQL logins don't, so both resolve to the same bot. */
export function getReviewBot(login: string) {
  return REVIEW_BOTS[login.replace(/\[bot\]$/, '').toLowerCase()] ?? null;
}

export function latestReviewStates(items: PullRequestReviewDiscussionItem[]) {
  const states = new Map<string, { actor: PullRequestReviewActor; state: PullRequestReviewState }>();
  for (const item of items) {
    if (item.kind !== 'review' || !item.author || !item.reviewState || item.author.isBot) continue;
    if (item.reviewState === 'commented' && states.has(item.author.login)) continue;
    states.set(item.author.login, { actor: item.author, state: item.reviewState });
  }
  return states;
}

/** Bots post long status comments in bursts, so consecutive ones fold into one run. */
export function groupReviewDiscussion(items: PullRequestReviewDiscussionItem[], newestFirst: boolean) {
  const sorted = [...items].sort((a, b) => newestFirst ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt));
  const runs: PullRequestReviewDiscussionItem[][] = [];
  for (const item of sorted) {
    const last = runs.at(-1);
    if (last && item.author?.isBot && last[0].author?.isBot) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

export function summarizeReviewRun(items: PullRequestReviewDiscussionItem[]) {
  const authors = [...new Map(items.flatMap((item) => item.author ? [[item.author.login, item.author] as const] : [])).values()];
  const latest = items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, items[0].createdAt);
  return { authors, latest };
}

export function parseReviewBotScore(body: string): PullRequestReviewBotScore | null {
  const match = /\b(?:confidence|score)\b[^\d\n]{0,40}?(\d+(?:\.\d+)?)\s*\/\s*(\d+)\b/i.exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  const max = Number(match[2]);
  return max > 0 && value <= max ? { value, max } : null;
}

// Bots that only post status comments (deploy previews, CI trackers) aren't reviewers, so only bots that review, score, or can be retriggered are listed.
export function listReviewBots(discussion: PullRequestReviewDiscussionItem[]) {
  const byLogin = new Map<string, { actor: PullRequestReviewActor; score: PullRequestReviewBotScore | null; reviewed: boolean }>();
  for (const item of discussion) {
    if (!item.author?.isBot) continue;
    const current = byLogin.get(item.author.login);
    byLogin.set(item.author.login, {
      actor: item.author,
      score: parseReviewBotScore(item.body) ?? current?.score ?? null,
      reviewed: item.kind !== 'comment' || Boolean(current?.reviewed),
    });
  }
  return [...byLogin.values()].filter((bot) => bot.score || bot.reviewed || getReviewBot(bot.actor.login));
}

export type PullRequestReviewFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface PullRequestReviewFile {
  path: string;
  previousPath: string | null;
  status: PullRequestReviewFileStatus;
  additions: number;
  deletions: number;
  /** Null when GitHub omits the patch (binary or too large). */
  patch: string | null;
}

export type PullRequestReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface PullRequestReviewDiscussionItem {
  id: string;
  kind: 'comment' | 'review' | 'review_comment';
  author: PullRequestReviewActor | null;
  body: string;
  reviewState: PullRequestReviewState | null;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  createdAt: string;
  url: string;
  /** In the viewer's review on the code host, which only they see until they submit it. */
  pending?: true;
  threadId?: string;
}

export interface PullRequestReviewCommit {
  sha: string;
  message: string;
  author: PullRequestReviewActor | null;
  committedAt: string;
  url: string;
}

export interface PullRequestReviewSession {
  workspaceId: string;
  tourChatId: string | null;
  chatId: string | null;
}

export interface PullRequestReviewOverview extends PullRequestDetails {
  sameRepository: boolean;
  body: string;
  createdAt: string;
  headSha: string;
  author: PullRequestReviewActor | null;
  /** People on the PR's commits, including Co-authored-by trailers, without bots. */
  coAuthors: PullRequestReviewActor[];
  labels: Array<{ name: string; color: string }>;
  requestedReviewers: PullRequestReviewActor[];
  requestedTeams: PullRequestReviewTeam[];
  assignees: PullRequestReviewActor[];
}

export interface PullRequestReviewStackItem {
  number: number;
  title: string;
  state: PullRequestStatus;
  ciStatus: PullRequestCiStatus;
  reviewDecision: PullRequestReviewDecision | null;
}

export interface PullRequestReviewStack {
  source: 'github' | 'graphite' | 'branches';
  baseBranch: string;
  /** Top of the stack first, as GitHub and Graphite list it. */
  pullRequests: PullRequestReviewStackItem[];
}

export interface GetPullRequestReviewResponse {
  pullRequest: PullRequestReviewOverview;
  stack: PullRequestReviewStack | null;
  files: PullRequestReviewFile[];
  filesTruncated: boolean;
  discussionTruncated: boolean;
  commits: PullRequestReviewCommit[];
  discussion: PullRequestReviewDiscussionItem[];
  /** The viewer's GitHub account, null until they connect GitHub. */
  viewer: PullRequestReviewActor | null;
  session: PullRequestReviewSession | null;
  sourceWorkspaceId: string | null;
  /** Served from cache while a refresh runs, so fetching again shortly returns fresher data. */
  stale: boolean;
  /** How long before this response the copy was read from the code host. Relative, so a wrong client clock can't misjudge it. */
  ageMs: number;
}

export const PULL_REQUEST_REVIEW_INBOX_SECTIONS = ['needs_review', 'open', 'merged'] as const;

export type PullRequestReviewInboxSection = (typeof PULL_REQUEST_REVIEW_INBOX_SECTIONS)[number];
export const PULL_REQUEST_REVIEW_INBOX_SORTS = ['updated', 'newest', 'oldest'] as const;
export type PullRequestReviewInboxSort = (typeof PULL_REQUEST_REVIEW_INBOX_SORTS)[number];

export interface PullRequestReviewInboxItem {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  state: PullRequestStatus | null;
  author: PullRequestReviewActor | null;
  coAuthors: PullRequestReviewActor[];
  reviewDecision: PullRequestReviewDecision | null;
  ciStatus: PullRequestCiStatus;
  checks: PullRequestChecksSummary | null;
  additions: number | null;
  deletions: number | null;
  reviewBot: PullRequestReviewBotSummary | null;
  mergeability: PullRequestMergeability | null;
  createdAt: string | null;
  updatedAt: string;
  baseBranch: string | null;
  /** Null when it's in a fork, where no pull request in this repository can build on it, or on a workspace's row. */
  headBranch: string | null;
  workspaceId: string | null;
  section: PullRequestReviewInboxSection;
}

type StackableInboxItem = Pick<PullRequestReviewInboxItem, 'url' | 'number' | 'baseBranch' | 'headBranch'>;

export function groupPullRequestStacks<T extends StackableInboxItem>(sections: ReadonlyArray<readonly T[]>): T[][][] {
  const items = sections.flat();
  const branchKey = (item: T, branch: string) => `${parseCodeHostPrUrl(item.url)?.repoUrl.toLowerCase()}\n${branch}`;
  const byHead = new Map(items.flatMap((item) => (item.headBranch ? [[branchKey(item, item.headBranch), item] as const] : [])));
  const below = (item: T) => (item.baseBranch ? byHead.get(branchKey(item, item.baseBranch)) : undefined);
  const above = new Map<T, T[]>();
  for (const item of items) {
    const base = below(item);
    if (base) above.set(base, [...(above.get(base) ?? []), item]);
  }
  const stack = (item: T): T[] => [item, ...(above.get(item) ?? []).sort((a, b) => a.number - b.number).flatMap(stack)];
  const stackOf = new Map(items.filter((item) => above.has(item) && !below(item)).flatMap((bottom) => {
    const members = stack(bottom);
    return members.map((item) => [item, members] as const);
  }));
  const placed = new Set<T[]>();
  return sections.map((section) => section.flatMap((item) => {
    const members = stackOf.get(item);
    if (!members) return [[item]];
    if (placed.has(members)) return [];
    placed.add(members);
    return [members];
  }));
}

export interface ListPullRequestReviewsResponse {
  pullRequests: PullRequestReviewInboxItem[];
  nextCursor: string | null;
  /** Served from cache while a refresh runs, so fetching again shortly returns fresher data. */
  stale: boolean;
  githubConnected: boolean;
  gitlabConnected: boolean;
  viewerLogin: string | null;
  gitlabViewerLogin: string | null;
}

export interface StartPullRequestTourRequest {
  replacesTourChatId: string | null;
}

export interface StartPullRequestTourResponse {
  session: PullRequestReviewSession;
}

export interface GetPullRequestTourResponse {
  tour: PullRequestTour | null;
}

export type PullRequestReviewAction = WorkspacePullRequestAction | 'update_branch' | 'reopen' | 'enable_auto_merge' | 'disable_auto_merge';

export interface PullRequestReviewActionResponse {
  success: true;
}

const PULL_REQUEST_COMMENT_DESTINATIONS = ['comment', 'review', 'agent'] as const;
export type PullRequestCommentDestination = (typeof PULL_REQUEST_COMMENT_DESTINATIONS)[number];

/** GitHub puts every inline comment into a pending review while one is open, and only inline comments can join one. */
export function getPullRequestCommentDestinations(pr: PullRequestRef, review: GetPullRequestReviewResponse, inline: boolean): PullRequestCommentDestination[] {
  const agent: PullRequestCommentDestination[] = review.pullRequest.readOnly ? [] : ['agent'];
  if (pr.provider === 'gitlab') return agent;
  const host: PullRequestCommentDestination[] = !inline ? ['comment'] : review.discussion.some((item) => item.pending) ? ['review'] : ['comment', 'review'];
  return [...host, ...agent];
}

export function canRequestPullRequestChanges(pr: PullRequestRef, review: GetPullRequestReviewResponse): boolean {
  const { pullRequest, viewer } = review;
  return pr.provider === 'github' && pullRequest.state === 'open' && !pullRequest.readOnly && viewer !== null && viewer.login.toLowerCase() !== pullRequest.authorLogin?.toLowerCase();
}

const diffSideSchema = z.enum(['additions', 'deletions']);

export const createPullRequestCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(65_536),
  destination: z.enum(PULL_REQUEST_COMMENT_DESTINATIONS),
  quote: z.string().optional(),
  target: z.union([
    z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      side: diffSideSchema,
      startLine: z.number().int().positive().optional(),
      startSide: diffSideSchema.optional(),
    }),
    z.object({ replyTo: z.string().min(1) }),
  ]),
});
export type CreatePullRequestCommentRequest = z.infer<typeof createPullRequestCommentRequestSchema>;

export interface CreatePullRequestCommentResponse {
  chat: { workspaceId: string; chatId: string } | null;
}

export const PULL_REQUEST_REVIEW_EVENTS = ['comment', 'approve', 'request_changes'] as const;
export type PullRequestReviewEvent = (typeof PULL_REQUEST_REVIEW_EVENTS)[number];

export const submitPullRequestReviewRequestSchema = z.object({
  event: z.enum(PULL_REQUEST_REVIEW_EVENTS),
  body: z.string().trim().max(65_536).default(''),
});
export type SubmitPullRequestReviewRequest = z.input<typeof submitPullRequestReviewRequestSchema>;

// Clients that predate `merge` send no body and expect a merge, which only a pull request a workspace opened supports.
export const resolvePullRequestConflictsRequestSchema = z.object({ merge: z.boolean().default(true) }).strict();
export type ResolvePullRequestConflictsRequest = z.input<typeof resolvePullRequestConflictsRequestSchema>;

export const updatePullRequestReviewersRequestSchema = z.object({
  action: z.enum(['request', 'remove']),
  users: z.array(z.string().min(1)).max(15),
  teams: z.array(z.string().min(1)).max(15),
}).refine((request) => request.users.length + request.teams.length > 0);
export type UpdatePullRequestReviewersRequest = z.infer<typeof updatePullRequestReviewersRequestSchema>;

export interface ListPullRequestReviewerSuggestionsResponse {
  users: PullRequestReviewActor[];
  teams: PullRequestReviewTeam[];
}

export interface RetriggerReviewBotRequest {
  login: string;
}

export interface SendPullRequestReviewMessageResponse {
  session: PullRequestReviewSession;
}

export const GITHUB_ATTACHMENT_URL_PREFIX = 'https://github.com/user-attachments/assets/';
export const MAX_PULL_REQUEST_ATTACHMENT_IDS = 50;

export interface GetPullRequestReviewFileResponse {
  oldContents: string | null;
  newContents: string | null;
}

export interface GetPullRequestAttachmentsResponse {
  /** Short-lived signed URLs keyed by attachment id; ids GitHub didn't sign are omitted. */
  urls: Record<string, string>;
}

export type PullRequestRef = ParsedCodeHostPrUrl;

export function getPullRequestUrl(pr: PullRequestRef): string {
  return buildCodeHostPrUrl(pr.repoUrl, pr.provider, pr.number);
}

export function getPullRequestFilesUrl(pr: PullRequestRef): string {
  return `${getPullRequestUrl(pr)}/${pr.provider === 'gitlab' ? 'diffs' : 'files'}`;
}

export function isSamePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return getPullRequestUrl(a).toLowerCase() === getPullRequestUrl(b).toLowerCase();
}

// GitHub keeps its original `owner/repo/number` shape so links already shared still open. GitLab mirrors the MR URL without its scheme.
export function getPullRequestReviewPagePath(pr: PullRequestRef): string {
  return `${WEB_APP_PATHS.review}/${pr.provider === 'gitlab'
    ? `${pr.host}/${pr.repositoryPath.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/${pr.number}`
    : `${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${pr.number}`}`;
}

/** GitLab's project path rides in the query, since nested groups don't fit a fixed number of path segments. */
export function getPullRequestReviewApiPath(pr: PullRequestRef, action = '', query = new URLSearchParams()): string {
  if (pr.provider === 'gitlab') query.set('project', pr.repositoryPath);
  const search = query.toString();
  const base = pr.provider === 'gitlab'
    ? `/v1/reviews/gitlab/${encodeURIComponent(pr.host)}/merge_requests/${pr.number}`
    : `/v1/reviews/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/${pr.number}`;
  return `${base}${action ? `/${action}` : ''}${search ? `?${search}` : ''}`;
}

/** GitHub owners can't contain `.` or `:`, so a first segment with either is a GitLab host. */
export function parsePullRequestReviewPath(segments: string[]): PullRequestRef | null {
  const decoded = decodePathSegments(segments);
  if (decoded.length === 3 && !/[.:]/.test(decoded[0])) {
    const parsed = parseCodeHostPrUrl(`https://github.com/${decoded[0]}/${decoded[1]}/pull/${decoded[2]}`);
    return parsed?.provider === 'github' ? parsed : null;
  }
  const [host, ...path] = decoded;
  const parsed = host ? parseCodeHostPrUrl(`https://${host}/${path.map(encodeURIComponent).join('/')}`) : null;
  return parsed?.provider === 'gitlab' ? parsed : null;
}

/** Canvas-relative path the tour agent writes, so the page can read it while the agent works. */
/** A review file diff with more changed lines than this starts collapsed, so opening a big PR doesn't render thousands of rows at once. */
export const REVIEW_LARGE_FILE_LINES = 800;

export function getPullRequestTourFilename(pr: PullRequestRef): string {
  // GitLab paths never contain `~`, so joining host and nested groups with it can't make two MRs share a file.
  const name = pr.provider === 'gitlab'
    ? `gitlab-${[pr.host.replaceAll(':', '_'), ...pr.repositoryPath.split('/')].join('~')}`
    : `${pr.owner}-${pr.repo}`;
  return `pr-tours/${name}-${pr.number}.json`.toLowerCase();
}

export function codeHostName(pr: Pick<PullRequestRef, 'provider'> | string): 'GitHub' | 'GitLab' {
  return (typeof pr === 'string' ? parseCodeHostPrUrl(pr)?.provider : pr.provider) === 'gitlab' ? 'GitLab' : 'GitHub';
}

export function getPullRequestHostLink(url: string, openInGraphite: boolean): { url: string; label: string } {
  const viewUrl = getPullRequestViewUrl(url, openInGraphite);
  return { url: viewUrl, label: viewUrl === url ? `Open on ${codeHostName(url)}` : 'Open in Graphite' };
}

export function getPullRequestTourChatTitle(pr: Pick<PullRequestRef, 'provider' | 'number'>): string {
  return `${getPullRequestNoun(pr)} ${formatPullRequestNumber(pr)} tour`;
}

export function getPullRequestReviewChatTitle(pr: Pick<PullRequestRef, 'provider' | 'number'>): string {
  return `${getPullRequestNoun(pr)} ${formatPullRequestNumber(pr)} review`;
}

export function isPullRequestReviewChat(chat: Pick<ChatSummary, 'title' | 'kind'>): boolean {
  const kind = getChatKind(chat);
  return kind === 'pull_request_review' || kind === 'pull_request_tour';
}

// Every field falls back on its own so a tour the agent is still writing renders what it has.
const text = z.string().trim().catch('');
const optionalText = z.string().trim().min(1).optional().catch(undefined);

const pullRequestTourSchema = z.object({
  /** The tour chat that wrote this file, so a rerun doesn't show the previous run's tour as in progress. */
  runId: optionalText,
  headSha: optionalText,
  status: z.enum(['writing', 'done']).catch('writing'),
  summary: text,
  diagram: optionalText,
  files: z.array(z.object({ path: text, explanation: text })).catch([]),
  skip: z.array(z.object({ path: text, note: text })).catch([]),
});

export type PullRequestTour = z.infer<typeof pullRequestTourSchema>;

export function parsePullRequestTour(content: string | undefined): PullRequestTour | null {
  if (!content) return null;
  try {
    const result = pullRequestTourSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const TEST_FILE_PATTERNS = [
  /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|spec|e2e|fixtures)\//,
  /\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/,
];
const GENERATED_FILE_PATTERNS = [
  /(^|\/)(generated|__generated__)\/|\.(gen|generated)\.[^/]+$|\.(snap|min\.js|min\.css|pb\.go)$|_pb2\.pyi?$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum)$|\.lock$/,
];
const matchesAny = (patterns: RegExp[], path: string) => patterns.some((pattern) => pattern.test(path));

export type ReviewFileKind = 'code' | 'tests' | 'generated';
export const reviewFileKind = (path: string): ReviewFileKind => matchesAny(GENERATED_FILE_PATTERNS, path) ? 'generated' : matchesAny(TEST_FILE_PATTERNS, path) ? 'tests' : 'code';

export interface TourOrder {
  main: PullRequestReviewFile[];
  skipped: PullRequestReviewFile[];
}

function orderTourFiles(tour: PullRequestTour | null, files: PullRequestReviewFile[]): TourOrder {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const explained = new Set(tour?.files.map((item) => item.path).filter((path) => !matchesAny(GENERATED_FILE_PATTERNS, path)));
  const skipped = new Set(tour?.skip.map((item) => item.path).filter((path) => !explained.has(path)));
  const rest = files.filter((file) => !explained.has(file.path) && !skipped.has(file.path));
  const isSupporting = (file: PullRequestReviewFile) => reviewFileKind(file.path) !== 'code';
  return {
    main: [...[...explained].flatMap((path) => filesByPath.get(path) ?? []), ...rest.filter((file) => !isSupporting(file))],
    skipped: [...[...skipped].flatMap((path) => filesByPath.get(path) ?? []), ...rest.filter(isSupporting)],
  };
}

export type TourState = 'idle' | 'running' | 'ready' | 'stopped';

export function getPullRequestTourView({ tourChatId, running, file, headSha, files }: {
  tourChatId: string | null;
  running: boolean;
  file: PullRequestTour | null;
  headSha: string;
  files: PullRequestReviewFile[];
}) {
  // A rerun keeps the last run's file until the agent rewrites it, so hide a file from another run while this one works.
  const tour = running && file?.runId !== tourChatId ? null : file;
  const state: TourState = running ? 'running' : tour?.status === 'done' ? 'ready' : tourChatId ? 'stopped' : tour ? 'ready' : 'idle';
  const stale = state === 'ready' && Boolean(tour?.headSha) && tour?.headSha !== headSha;
  const explained = tour?.files.filter((item) => item.explanation).length ?? 0;
  return {
    tour,
    state,
    stale,
    hasContent: tour !== null && (tour.summary !== '' || tour.files.length > 0),
    order: orderTourFiles(tour, files),
    message: state === 'running'
      ? tour?.files.length ? `Explaining files · ${explained} of ${tour.files.length}` : 'Reading the diff'
      : state === 'stopped' ? 'The tour stopped before it finished.' : stale ? 'This tour was written for an older commit.' : null,
  };
}

// The newest words are at the end of a streaming thought, so a long one keeps its tail.
export function getPullRequestTourThought(messages: DisplayMessage[]): string {
  const reasoning = messages.findLast((message) => message.type === 'reasoning');
  const paragraph = reasoning?.type === 'reasoning' ? reasoning.content.replace(/\*\*/g, '').trim().split(/\n\s*\n/).at(-1)?.replace(/\s+/g, ' ') ?? '' : '';
  return paragraph.length > 240 ? `…${paragraph.slice(paragraph.indexOf(' ', paragraph.length - 240) + 1)}` : paragraph;
}
