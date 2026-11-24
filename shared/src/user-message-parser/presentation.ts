import { getProviderDisplayName } from '../agent';
import { describeQuotaLimit } from '../chat-fork';
import { getSourceMetadataPills, type MetadataPillData } from './metadata-pills';
import type { InlineDiffCommentBlock, NonMergedParsedPrompt, PromptSource } from './types';

export type NonMergedPromptVisitor<Result> = {
  [Source in NonMergedParsedPrompt['source']]: (
    message: Extract<NonMergedParsedPrompt, { source: Source }>,
  ) => Result;
};

export function visitNonMergedPrompt<Result>(
  message: NonMergedParsedPrompt,
  visitor: NonMergedPromptVisitor<Result>,
): Result {
  switch (message.source) {
    case 'ci_failure':
      return visitor.ci_failure(message);
    case 'linear_issue':
      return visitor.linear_issue(message);
    case 'github_issue_new':
      return visitor.github_issue_new(message);
    case 'github_issue_existing':
      return visitor.github_issue_existing(message);
    case 'gitlab_issue_new':
      return visitor.gitlab_issue_new(message);
    case 'gitlab_issue_existing':
      return visitor.gitlab_issue_existing(message);
    case 'github_pr_new':
      return visitor.github_pr_new(message);
    case 'github_pr_existing_review':
      return visitor.github_pr_existing_review(message);
    case 'github_pr_existing_pr_review':
      return visitor.github_pr_existing_pr_review(message);
    case 'github_pr_existing_general':
      return visitor.github_pr_existing_general(message);
    case 'gitlab_mr_existing_general':
      return visitor.gitlab_mr_existing_general(message);
    case 'slack_task':
      return visitor.slack_task(message);
    case 'text_message':
      return visitor.text_message(message);
    case 'automation_triggered':
      return visitor.automation_triggered(message);
    case 'plan_quote':
      return visitor.plan_quote(message);
    case 'inline_diff_comments':
      return visitor.inline_diff_comments(message);
    case 'chat_fork':
      return visitor.chat_fork(message);
    case 'raw':
      return visitor.raw(message);
  }
}

export type StructuredContentBlock =
  | { kind: 'title'; content: string }
  | { kind: 'markdown'; content: string }
  | { kind: 'text'; content: string; tone?: 'danger' | 'muted' }
  | { kind: 'detail'; label: string; content: string; format?: 'code' }
  | { kind: 'quotes'; blocks: { source?: string; quote: string; reply: string }[] }
  | { kind: 'comments'; comments: InlineDiffCommentBlock[] };

export interface StructuredMessagePresentation {
  source: Exclude<PromptSource, 'raw' | 'merged'>;
  sourceHref?: string;
  pills: (MetadataPillData & { href?: string })[];
  blocks: StructuredContentBlock[];
}

export function getStructuredMessagePresentation(
  message: Exclude<NonMergedParsedPrompt, { source: 'raw' }>,
): StructuredMessagePresentation {
  const metadata = getSourceMetadataPills(message);
  const hrefs: Record<string, string | undefined> = {};
  const pills: (MetadataPillData & { href?: string })[] = [];
  const blocks: StructuredContentBlock[] = [];
  let sourceHref: string | undefined;

  switch (message.source) {
    case 'ci_failure': {
      const requestLabel = message.isMergeRequest ? 'MR' : 'PR';
      sourceHref = message.prUrl;
      hrefs[requestLabel] = message.prUrl;
      pills.push({ label: 'Status', value: message.conclusion });
      blocks.push({
        kind: 'text',
        content: `Workflow ${message.conclusionText} on ${requestLabel} ${metadata.pills[0]?.value ?? ''}`,
        tone: 'danger',
      });
      if (message.workflowFile)
        pills.push({ label: 'File', value: message.workflowFile, href: message.fileUrl });
      if (message.runUrl)
        pills.push({
          label: 'Run',
          value: message.isMergeRequest ? 'View on GitLab' : 'View on GitHub',
          href: message.runUrl,
        });
      break;
    }
    case 'linear_issue':
      sourceHref = message.issueUrl;
      hrefs[''] = message.issueUrl;
      if (message.request) {
        blocks.push({ kind: 'markdown', content: message.request });
        blocks.push(message.description
          ? { kind: 'detail', label: message.title, content: message.description }
          : { kind: 'text', content: message.title, tone: 'muted' });
      } else {
        blocks.push({ kind: 'title', content: message.title });
        if (message.description) blocks.push({ kind: 'markdown', content: message.description });
      }
      if (message.previousComments)
        blocks.push({ kind: 'detail', label: 'Earlier activity', content: message.previousComments });
      if (message.parentIssue)
        blocks.push({
          kind: 'detail',
          label: `Parent: ${message.parentIssue.identifier} – ${message.parentIssue.title}`,
          content: message.parentIssue.description,
        });
      break;
    case 'github_issue_new':
    case 'gitlab_issue_new':
      sourceHref = message.issueUrl;
      hrefs.Issue = message.issueUrl;
      hrefs.From = message.userUrl;
      if (message.triggeringComment)
        blocks.push({ kind: 'markdown', content: message.triggeringComment });
      blocks.push(message.issueDescription
        ? { kind: 'detail', label: message.issueTitle, content: message.issueDescription }
        : { kind: 'text', content: message.issueTitle, tone: 'muted' });
      break;
    case 'github_issue_existing':
    case 'gitlab_issue_existing':
      sourceHref = message.issueUrl;
      hrefs.Issue = message.issueUrl;
      hrefs.From = message.userUrl;
      blocks.push({ kind: 'markdown', content: message.commentBody });
      break;
    case 'github_pr_new':
      sourceHref = message.prUrl;
      hrefs.PR = message.prUrl;
      hrefs.From = message.userUrl;
      blocks.push({ kind: 'markdown', content: message.contextMessage });
      break;
    case 'github_pr_existing_review':
      sourceHref = message.prUrl;
      hrefs.PR = message.prUrl;
      hrefs.From = message.userUrl;
      if (message.filePath)
        pills.push({ label: 'File', value: message.filePath, href: message.fileUrl });
      blocks.push({ kind: 'markdown', content: message.commentBody });
      if (message.diffHunk)
        blocks.push({
          kind: 'detail',
          label: 'Diff context',
          content: message.diffHunk,
          format: 'code',
        });
      break;
    case 'github_pr_existing_pr_review':
      sourceHref = message.prUrl;
      hrefs.PR = message.prUrl;
      hrefs.From = message.userUrl;
      blocks.push({
        kind: 'text',
        content: `@${message.reviewUser} ${message.reviewAction}`,
        tone: 'muted',
      });
      if (message.commentBody) blocks.push({ kind: 'markdown', content: message.commentBody });
      break;
    case 'github_pr_existing_general':
      sourceHref = message.prUrl;
      hrefs.PR = message.prUrl;
      hrefs.From = message.userUrl;
      blocks.push({ kind: 'markdown', content: message.commentBody });
      break;
    case 'gitlab_mr_existing_general':
      sourceHref = message.commentUrl;
      hrefs.MR = message.commentUrl;
      blocks.push({ kind: 'markdown', content: message.commentBody });
      break;
    case 'slack_task':
      sourceHref = message.threadUrl;
      hrefs.Target = message.targetUrl;
      blocks.push({ kind: 'markdown', content: message.latestMessageText });
      if (message.threadContext)
        blocks.push({ kind: 'detail', label: 'Thread context', content: message.threadContext });
      break;
    case 'text_message':
      blocks.push(message.reaction
        ? { kind: 'text', content: `Reacted ${message.reaction} to “${message.text}”`, tone: 'muted' }
        : { kind: 'markdown', content: message.text });
      break;
    case 'automation_triggered':
      if (message.repositoryName)
        pills.push({ label: 'Repo', value: message.repositoryName, href: message.repositoryUrl });
      if (message.prNumber !== undefined)
        pills.push({ label: 'PR', value: `#${message.prNumber}`, href: message.prUrl });
      if (message.triggeredBy)
        pills.push({
          label: 'From',
          value: `@${message.triggeredBy}`,
          href: message.triggeredByUrl,
        });
      if (message.userPrompt) blocks.push({ kind: 'markdown', content: message.userPrompt });
      if (message.triggerPayload)
        blocks.push({
          kind: 'detail',
          label: 'Request payload',
          content: message.triggerPayload,
          format: 'code',
        });
      break;
    case 'plan_quote': {
      const sources = new Set(message.blocks.map((block) => block.planFilename));
      if (sources.size > 1) pills.push({ label: 'Quotes', value: `${message.blocks.length}` });
      if (message.leadingText) blocks.push({ kind: 'markdown', content: message.leadingText });
      blocks.push({
        kind: 'quotes',
        blocks: message.blocks.map((block) => ({
          source: sources.size > 1 ? block.planFilename.replace(/\.md$/, '') : undefined,
          quote: block.quotedText,
          reply: block.replyText,
        })),
      });
      break;
    }
    case 'inline_diff_comments': {
      const files = new Set(message.comments.map((comment) => comment.path));
      if (files.size > 1) pills.push({ label: 'Files', value: `${files.size}` });
      if (message.leadingText) blocks.push({ kind: 'markdown', content: message.leadingText });
      blocks.push({ kind: 'comments', comments: message.comments });
      break;
    }
    case 'chat_fork': {
      if (message.trigger === 'side') {
        blocks.push({ kind: 'markdown', content: message.replyText });
        break;
      }
      blocks.push({
        kind: 'text',
        content: `Continuing "${message.sourceTitle || 'chat'}" from ${getProviderDisplayName(message.sourceProvider, 'long')}${message.reason ? ` after it ${describeQuotaLimit(message.reason)}` : ''}`,
        tone: 'muted',
      });
      if (message.excerpt) blocks.push({ kind: 'detail', label: 'Recent turns', content: message.excerpt, format: 'code' });
      if (message.replyText) blocks.push({ kind: 'markdown', content: message.replyText });
      break;
    }
  }

  return {
    source: message.source,
    sourceHref,
    pills: [...metadata.pills.map((pill) => ({ ...pill, href: hrefs[pill.label] })), ...pills],
    blocks,
  };
}

export function getMergedMessageRowLabel(
  message: NonMergedParsedPrompt,
  index: number,
  total: number,
) {
  if (message.source === 'raw') return `Message ${index + 1} / ${total}`;
  const metadata = getSourceMetadataPills(message);
  const values = metadata.pills.map((pill) => pill.value);
  if (!values.length && metadata.preview) values.push(metadata.preview.slice(0, 60));
  return values.length ? values.join(' · ') : `${index + 1} / ${total}`;
}
