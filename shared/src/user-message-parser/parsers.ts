import { MERGED_MESSAGE_SEPARATOR } from '../engine/v1';
import { stripOkidokiInstructionBlock } from '../prompts';
import { parseInlineDiffComments } from './inline-diff-comments';
import { parsePlanQuote } from './plan-quote';
import { parseChatForkHandoff } from './chat-fork';
import { linearMarkdownForDisplay, slackMrkdwnToMarkdown } from './external-markdown';
import type {
  ParsedPrompt,
  NonMergedParsedPrompt,
  MergedParsed,
  CIFailureParsed,
  LinearIssueParsed,
  GitHubIssueNewParsed,
  GitHubIssueExistingParsed,
  GitLabIssueNewParsed,
  GitLabIssueExistingParsed,
  GitHubPRNewParsed,
  GitHubPRExistingReviewParsed,
  GitHubPRExistingPRReviewParsed,
  GitHubPRExistingGeneralParsed,
  GitLabMRExistingGeneralParsed,
  SlackTaskParsed,
  TextMessageParsed,
  AutomationTriggeredParsed,
} from './types';

// =============================================================================
// Individual Parsers
// =============================================================================

function parseCIFailure(content: string): CIFailureParsed | null {
  if (!content.startsWith('# CI/CD Workflow Failed')) return null;

  const prMatch = content.match(/Pull Request #(\d+)/);
  const mrMatch = content.match(/Merge Request !(\d+)/);
  const requestMatch = prMatch ?? mrMatch;
  const workflowNameMatch = content.match(/\*\*Workflow Name:\*\*\s*(.+)/);
  const workflowFileMatch = content.match(/\*\*Workflow File:\*\*\s*(.+)/);
  const conclusionMatch = content.match(/\*\*Conclusion:\*\*\s*(.+)/);
  const runUrlMatch = content.match(/\*\*Run URL:\*\*\s*(.+)/);
  const conclusionTextMatch = content.match(
    /has (failed|timed out|requires action|was cancelled|failed to start)/
  );
  const prUrlMatch = content.match(/\*\*PR URL:\*\*\s*(.+)/);
  const fileUrlMatch = content.match(/\*\*File URL:\*\*\s*(.+)/);

  if (!requestMatch) return null;

  return {
    source: 'ci_failure',
    prNumber: parseInt(requestMatch[1], 10),
    isMergeRequest: !prMatch && !!mrMatch,
    workflowName: workflowNameMatch?.[1]?.trim() ?? 'Unknown',
    workflowFile: workflowFileMatch?.[1]?.trim() ?? '',
    conclusion: conclusionMatch?.[1]?.trim() ?? 'failure',
    runUrl: runUrlMatch?.[1]?.trim() ?? '',
    conclusionText: conclusionTextMatch?.[1] ?? 'failed',
    prUrl: prUrlMatch?.[1]?.trim(),
    fileUrl: fileUrlMatch?.[1]?.trim(),
  };
}

function parseGitHubIssueNew(content: string): GitHubIssueNewParsed | null {
  const fields = parseIssueNewFields(content, /^# Task: GitHub Issue #(\d+)(?: -|:) (.+)$/m);
  return fields && { source: 'github_issue_new', ...fields };
}

function parseGitHubIssueExisting(
  content: string
): GitHubIssueExistingParsed | null {
  const fields = parseIssueExistingFields(content, /^You received a (?:new )?comment on GitHub Issue #(\d+)\./);
  return fields && { source: 'github_issue_existing', ...fields };
}

function parseGitLabIssueNew(content: string): GitLabIssueNewParsed | null {
  const fields = parseIssueNewFields(content, /^# Task: GitLab Issue #(\d+)(?: -|:) (.+)$/m);
  return fields && { source: 'gitlab_issue_new', ...fields };
}

// Mentions are `@login`, or a placeholder like "the requester" when the author is unknown.
const AUTHOR_MENTION = '(?:@(\\S+)|[^:\\n]+)';

function parseIssueNewFields(content: string, headerPattern: RegExp) {
  const headerMatch = content.match(headerPattern);
  if (!headerMatch) return null;

  const descMatch = content.match(/## Issue Description\n([\s\S]*?)(?=\n## Triggering Comment from |$)/);
  const triggerMatch = content.match(new RegExp(`## Triggering Comment from ${AUTHOR_MENTION}\\n`));
  const trigger = triggerMatch?.index === undefined
    ? undefined
    : splitAtUrlTrailer(content.slice(triggerMatch.index + triggerMatch[0].length));
  const issueDescription = descMatch?.[1]?.trim() ?? '';

  return {
    issueNumber: parseInt(headerMatch[1], 10),
    issueTitle: headerMatch[2].trim(),
    issueDescription: issueDescription === 'No description provided.' ? '' : issueDescription,
    triggeringUser: triggerMatch?.[1] ?? '',
    triggeringComment: trigger?.body ?? '',
    issueUrl: safeHttpsUrl((trigger?.trailer ?? content).match(/\*\*Issue URL:\*\*\s*(.+)/)?.[1]),
    userUrl: safeHttpsUrl((trigger?.trailer ?? content).match(/\*\*User URL:\*\*\s*(.+)/)?.[1]),
  };
}

// Comments can contain their own `**Issue URL:**` lines, so end at the template's URL block, which is followed by instructions or ends the prompt.
function splitAtUrlTrailer(text: string): { body: string; trailer?: string } {
  const trailer = [...text.matchAll(/\n\n((?:\*\*[\w ]+ URL:\*\* \S+(?:\n|$))+)(?:\n(?:IMPORTANT INSTRUCTIONS:|## Your Assignment)|$)/g)].at(-1);
  if (trailer) return { body: text.slice(0, trailer.index).trim(), trailer: trailer[1] };
  const end = text.search(/\n(?:IMPORTANT INSTRUCTIONS:|## Your Assignment)/);
  return { body: (end === -1 ? text : text.slice(0, end)).trim() };
}

function parseGitLabIssueExisting(content: string): GitLabIssueExistingParsed | null {
  const fields = parseIssueExistingFields(content, /^You received a (?:new )?comment on GitLab Issue #(\d+)\./);
  return fields && { source: 'gitlab_issue_existing', ...fields };
}

function parseIssueExistingFields(content: string, headerPattern: RegExp) {
  const headerMatch = content.match(headerPattern);
  if (!headerMatch) return null;

  const commentMatch = content.match(new RegExp(`Comment from ${AUTHOR_MENTION}:\\n`));
  const comment = commentMatch?.index === undefined
    ? undefined
    : splitAtUrlTrailer(content.slice(commentMatch.index + commentMatch[0].length));

  return {
    issueNumber: parseInt(headerMatch[1], 10),
    commentUser: commentMatch?.[1] ?? '',
    commentBody: comment?.body ?? '',
    issueUrl: safeHttpsUrl((comment?.trailer ?? content).match(/\*\*Issue URL:\*\*\s*(.+)/)?.[1]),
    userUrl: safeHttpsUrl((comment?.trailer ?? content).match(/\*\*User URL:\*\*\s*(.+)/)?.[1]),
  };
}

function parseGitHubPRNew(content: string): GitHubPRNewParsed | null {
  const fields = parseMentionPrompt(
    content,
    /^# Task: Review and work on Pull Request #(\d+)/m,
    /@(\S+) mentioned @(?:okidoki-connector|tryokidoki|okidoki).*?\n\n>([\s\S]*?)(?=\n\*\*(?:PR|Issue|User|File) URL:\*\*|\n## Your Assignment)/,
    'PR',
  );
  return fields && {
    source: 'github_pr_new',
    prNumber: fields.number,
    mentioningUser: fields.user,
    contextMessage: fields.message,
    prUrl: fields.url,
    userUrl: safeHttpsUrl(content.match(/\*\*User URL:\*\*\s*(.+)/)?.[1]),
  };
}

function parseMentionPrompt(content: string, header: RegExp, mention: RegExp, urlLabel: string) {
  const headerMatch = content.match(header);
  if (!headerMatch) return null;
  const mentionMatch = content.match(mention);
  return {
    number: parseInt(headerMatch[1], 10),
    user: mentionMatch?.[1] ?? '',
    message: mentionMatch ? unquote(mentionMatch[2]) : '',
    url: safeHttpsUrl(content.match(new RegExp(`\\*\\*${urlLabel} URL:\\*\\*\\s*(.+)`))?.[1]),
  };
}

function parseGitHubPRExistingPRReview(
  content: string
): GitHubPRExistingPRReviewParsed | null {
  const headerMatch = content.match(
    /^You received a pull request review on PR #(\d+)\./m
  );
  if (!headerMatch) return null;

  const prNumber = parseInt(headerMatch[1], 10);

  // Extract review action: "@user APPROVED the pull request" or "@user REQUESTED CHANGES..."
  const actionMatch = content.match(
    /@(\S+)\s+(APPROVED the pull request|REQUESTED CHANGES on the pull request|left a review comment on the pull request|had their review dismissed)/
  );

  // Extract comment body between "Comment from @user:" and "IMPORTANT INSTRUCTIONS:"
  const commentMatch = content.match(
    /Comment from @\S+:\n([\s\S]*?)(?=\n\*\*(?:PR|Issue|User|File) URL:\*\*|\nIMPORTANT INSTRUCTIONS:)/
  );

  // If no "Comment from" section, try to get the body after the header
  let commentBody = commentMatch?.[1]?.trim() ?? '';
  if (!commentBody) {
    // For PR reviews, the body might be directly in the prompt
    const bodyMatch = content.match(
      /reviewed the pull request\.\n([\s\S]*?)(?=\n\*\*(?:PR|Issue|User|File) URL:\*\*|\nIMPORTANT INSTRUCTIONS:)/
    );
    commentBody = bodyMatch?.[1]?.trim() ?? '';
  }

  const prUrlMatch = content.match(/\*\*PR URL:\*\*\s*(.+)/);
  const userUrlMatch = content.match(/\*\*User URL:\*\*\s*(.+)/);

  return {
    source: 'github_pr_existing_pr_review',
    prNumber,
    reviewUser: actionMatch?.[1] ?? '',
    reviewAction: actionMatch?.[2] ?? 'reviewed the pull request',
    commentBody,
    prUrl: prUrlMatch?.[1]?.trim(),
    userUrl: userUrlMatch?.[1]?.trim(),
  };
}

function parseGitHubPRExistingReview(
  content: string
): GitHubPRExistingReviewParsed | null {
  const headerMatch = content.match(
    /^You received a comment on Pull Request #(\d+)\./m
  );
  if (!headerMatch) return null;

  // Must have File: and Diff context: to be a code review comment
  const fileMatch = content.match(/\nFile: (.+)/);
  const diffMatch = content.match(/\nDiff context:\n```diff\n([\s\S]*?)```/);
  if (!fileMatch || !diffMatch) return null;

  const prNumber = parseInt(headerMatch[1], 10);
  const commentMatch = content.match(
    /Comment from @(\S+):\n([\s\S]*?)(?=\n\*\*(?:PR|Issue|User|File) URL:\*\*|\nIMPORTANT INSTRUCTIONS:)/
  );
  const prUrlMatch = content.match(/\*\*PR URL:\*\*\s*(.+)/);
  const userUrlMatch = content.match(/\*\*User URL:\*\*\s*(.+)/);
  const fileUrlMatch = content.match(/\*\*File URL:\*\*\s*(.+)/);

  return {
    source: 'github_pr_existing_review',
    prNumber,
    commentUser: commentMatch?.[1] ?? '',
    commentBody: commentMatch?.[2]?.trim() ?? '',
    filePath: fileMatch[1].trim(),
    diffHunk: diffMatch[1].trim(),
    prUrl: prUrlMatch?.[1]?.trim(),
    userUrl: userUrlMatch?.[1]?.trim(),
    fileUrl: fileUrlMatch?.[1]?.trim(),
  };
}

function parseGitHubPRExistingGeneral(
  content: string
): GitHubPRExistingGeneralParsed | null {
  const fields = parseHostReviewThreadFields(
    content,
    /^You received a comment on Pull Request #(\d+)\./m,
    /Comment from @(\S+):\n([\s\S]*?)(?=\n\*\*(?:PR|Issue|User|File) URL:\*\*|\nIMPORTANT INSTRUCTIONS:)/,
    /\*\*PR URL:\*\*\s*(.+)/
  );
  if (!fields) return null;

  const userUrlMatch = content.match(/\*\*User URL:\*\*\s*(.+)/);

  return {
    source: 'github_pr_existing_general',
    prNumber: fields.itemNumber,
    commentUser: fields.commentUser,
    commentBody: fields.commentBody,
    prUrl: fields.itemUrl,
    userUrl: userUrlMatch?.[1]?.trim(),
  };
}

function parseGitLabMRExistingGeneral(
  content: string
): GitLabMRExistingGeneralParsed | null {
  const fields = parseHostReviewThreadFields(
    content,
    /^You received a comment on GitLab Merge Request !(\d+)\./m,
    /Comment from @?([^:\n]+):\n([\s\S]*?)(?=\n\*\*(?:Merge Request|Comment)(?: URL)?:\*\*|\nIMPORTANT INSTRUCTIONS:)/,
    /\*\*Comment URL:\*\*\s*(.+)/
  );
  if (!fields) return null;

  return {
    source: 'gitlab_mr_existing_general',
    mergeRequestIid: fields.itemNumber,
    commentUser: fields.commentUser,
    commentBody: fields.commentBody,
    commentUrl: fields.itemUrl,
  };
}

function parseGitLabMRNew(content: string): GitLabMRExistingGeneralParsed | null {
  const fields = parseMentionPrompt(
    content,
    /^# Task: Review and work on GitLab Merge Request !(\d+)/,
    new RegExp(`^${AUTHOR_MENTION} mentioned @okidoki on this merge request with the following message:\\n\\n([\\s\\S]*?)\\n\\n## Merge Request\\n`, 'm'),
    'Merge Request',
  );
  return fields && {
    source: 'gitlab_mr_existing_general',
    mergeRequestIid: fields.number,
    commentUser: fields.user,
    commentBody: fields.message,
    commentUrl: fields.url,
  };
}

function unquote(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
}

function parseHostReviewThreadFields(
  content: string,
  headerPattern: RegExp,
  commentPattern: RegExp,
  itemUrlPattern: RegExp
) {
  const headerMatch = content.match(headerPattern);
  if (!headerMatch) return null;

  const commentMatch = content.match(commentPattern);
  const itemUrlMatch = content.match(itemUrlPattern);

  return {
    itemNumber: parseInt(headerMatch[1], 10),
    commentUser: commentMatch?.[1]?.trim() ?? '',
    commentBody: commentMatch?.[2]?.trim() ?? '',
    itemUrl: itemUrlMatch?.[1]?.trim(),
  };
}

function parseSlackTask(content: string): SlackTaskParsed | null {
  if (!content.startsWith('# Task from Slack')) return null;

  const targetMatch = content.match(/## Workspace Target\nWorking in: (.+?)(?=\n\*\*(?:Thread|Target) URL:\*\*|\n\n)/);
  const threadMatch = content.match(
    /## (?:Thread Context\n|(?:Source Thread Context|New Messages in Thread)\n.*\n\n)([\s\S]*?)(?=\n## Latest Message)/
  );
  const latestMatch = content.match(
    /## Latest Message \((?:mentions you|doesn't mention you)\)\n@(.+?): ([\s\S]*?)(?=\n## Response Instructions)/
  );
  const threadUrlMatch = content.match(/\*\*Thread URL:\*\*\s*(.+)/);
  const targetUrlMatch = content.match(/\*\*Target URL:\*\*\s*(.+)/);
  const latestMessageUser = latestMatch?.[1]?.trim() ?? '';
  const latestMessageText = slackMrkdwnToMarkdown(
    latestMatch?.[2]?.trim().replace(/\n\nEnvelope: channel_id=\S+ thread_ts=\S+ message_ts=\S+ user_id=\S+$/, '') ?? ''
  );
  const threadContext = slackMrkdwnToMarkdown(threadMatch?.[1]?.trim() ?? '');
  // The thread context ends with the latest message, which is already shown on its own.
  const latestLine = `@${latestMessageUser}: ${latestMessageText}`;

  return {
    source: 'slack_task',
    workspaceTarget: targetMatch?.[1]?.trim() ?? '',
    threadContext: latestMatch && (threadContext === latestLine || threadContext.endsWith(`\n${latestLine}`))
      ? threadContext.slice(0, -latestLine.length).trim()
      : threadContext,
    latestMessageUser,
    latestMessageText,
    threadUrl: threadUrlMatch?.[1]?.trim(),
    targetUrl: targetUrlMatch?.[1]?.trim(),
  };
}

function parseScoutSlackMessage(content: string): SlackTaskParsed | null {
  const match = content.match(
    /^\[Slack\] channel_id=\S+ thread_ts=\S+ message_ts=\S+ user_id=\S+(?: user_name=("(?:\\.|[^"\\])*")?)?(?: author_external=true(?: author_domain=\S+)?)? directed=(?:true|false) thread_has_workspace=(?:true|false) context=(?:full_thread|latest_only)(?: muted=true)?\n\n([\s\S]+)$/
  );
  if (!match) return null;

  const text = slackMrkdwnToMarkdown(match[2].trim());
  let senderName: string | undefined;
  try {
    const parsedUserName: unknown = match[1] ? JSON.parse(match[1]) : undefined;
    if (typeof parsedUserName === 'string') senderName = parsedUserName;
  } catch {
    // Legacy envelopes only carry the producer-formatted sender prefix.
  }
  if (!senderName) {
    return {
      source: 'slack_task',
      workspaceTarget: '',
      threadContext: '',
      latestMessageUser: text.match(/^@(.+?):(?:\s|$)/)?.[1]?.trim() ?? '',
      latestMessageText: text,
    };
  }

  // Thread messages are `@name: text` blocks joined by blank lines, ending with the sender's message.
  const prefix = `@${senderName}: `;
  const latestAt = text.lastIndexOf(`\n\n${prefix}`);
  const latest = latestAt === -1 ? text : text.slice(latestAt + 2);

  return {
    source: 'slack_task',
    workspaceTarget: '',
    threadContext: latestAt === -1 ? '' : text.slice(0, latestAt).trim(),
    latestMessageUser: senderName,
    latestMessageText: latest.startsWith(prefix) ? latest.slice(prefix.length).trim() : latest,
  };
}

function parseTextMessage(content: string): TextMessageParsed | null {
  const match = content.match(/^\[Text\] (?:message_id=\S+|reaction=(\S+)) user_name=("(?:\\.|[^"\\])*")(?:\n\n([\s\S]*))?$/);
  if (!match) return null;
  let sender: unknown;
  try {
    sender = JSON.parse(match[2]);
  } catch {
    // Anyone can type a message shaped like the envelope, so a bad escape falls back to an unnamed sender.
  }
  return { source: 'text_message', sender: typeof sender === 'string' ? sender : '', text: (match[3] ?? '').trim(), ...(match[1] ? { reaction: match[1] } : {}) };
}

function parseScoutLinearIssue(content: string): LinearIssueParsed | null {
  const match = content.match(
    /^\[Linear\] team_id=\S+ issue_id=\S+ identifier=([A-Z]+-\d+) creator_id=\S+ agent_session_id=\S+ issue_has_workspace=(?:true|false)\n\n## \1: ([^\n]+)\n([\s\S]+)$/
  );
  if (!match) return null;

  const details = match[3].trim();
  const sessionAt = details.lastIndexOf('\n## Agent session\n');
  const session = sessionAt === -1 ? '' : sectionAfter(details, sessionAt);
  const promptAt = [...session.matchAll(/^prompt: /gm)].at(-1)?.index ?? -1;
  const latestPrompt = promptAt === -1 ? '' : session.slice(promptAt + 'prompt: '.length);
  const promptEnd = latestPrompt.search(/\n(?:prompt|thought|response|action|elicitation|error): /);

  return {
    source: 'linear_issue',
    identifier: match[1],
    title: match[2].trim(),
    creatorName: details.match(/^\*\*Creator:\*\* (.+)$/m)?.[1]?.trim(),
    description: withoutPlaceholder(linearMarkdownForDisplay(
      (sessionAt === -1 ? details : details.slice(0, sessionAt)).replace(/^(?:\*\*[\w ]+:\*\* .*(?:\n|$))+/, '').trim()
    )),
    request: linearMarkdownForDisplay((promptEnd === -1 ? latestPrompt : latestPrompt.slice(0, promptEnd)).trim()),
    previousComments: linearMarkdownForDisplay(promptAt === -1 ? session : session.slice(0, promptAt).trim()),
    issueUrl: safeHttpsUrl(details.match(/^\*\*URL:\*\* (.+)$/m)?.[1]),
  };
}

function parseLinearIssue(content: string): LinearIssueParsed | null {
  const headerMatch = content.match(/^# Task: ([A-Z][A-Z0-9]*-\d+) - (.+)/);
  if (!headerMatch) return null;

  // Issue text often has its own `## ` headings, so slice at the template's markers instead.
  const instructionsAt = content.lastIndexOf('\n## Instructions\n');
  const body = instructionsAt === -1 ? content : content.slice(0, instructionsAt);
  const requestAt = Math.max(body.lastIndexOf('\n## Request\n'), body.lastIndexOf('\n## Additional Context\n'));
  const context = requestAt === -1 ? body : body.slice(0, requestAt);
  const commentsAt = context.lastIndexOf('\n## Previous Comments\n');
  const descriptionAt = context.indexOf('\n## Description\n');
  const parentAt = context.indexOf('\n## Parent Issue\n');
  const parentMatch = parentAt === -1
    ? null
    : sectionAfter(context, parentAt, descriptionAt).match(/^\*\*([A-Z][A-Z0-9]*-\d+)\*\*: (.+)\n?([\s\S]*)$/);

  return {
    source: 'linear_issue',
    identifier: headerMatch[1],
    title: headerMatch[2].trim(),
    parentIssue: parentMatch ? {
      identifier: parentMatch[1],
      title: parentMatch[2].trim(),
      description: withoutPlaceholder(linearMarkdownForDisplay(parentMatch[3].trim())),
    } : undefined,
    description: descriptionAt === -1
      ? ''
      : withoutPlaceholder(linearMarkdownForDisplay(sectionAfter(context, descriptionAt, commentsAt))),
    request: requestAt === -1 ? '' : linearMarkdownForDisplay(sectionAfter(body, requestAt)),
    previousComments: commentsAt === -1 ? '' : linearMarkdownForDisplay(sectionAfter(context, commentsAt)),
    issueUrl: content.match(/\*\*Issue URL:\*\*\s*(.+)/)?.[1]?.trim(),
  };
}

function sectionAfter(text: string, headingAt: number, end = -1): string {
  return text.slice(text.indexOf('\n', headingAt + 1) + 1, end === -1 ? undefined : end).trim();
}

function withoutPlaceholder(description: string): string {
  return description === 'No description provided.' ? '' : description;
}

function safeHttpsUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.startsWith('https://') ? trimmed : undefined;
}

function parseAutomationTriggered(content: string): AutomationTriggeredParsed | null {
  if (!content.startsWith('# Automation Triggered')) return null;

  const nameMatch = content.match(/\*\*Automation Name:\*\*\s*(.+)/);
  if (!nameMatch) return null;

  const triggerTypeMatch = content.match(/\*\*Trigger Type:\*\*\s*(.+)/);
  const triggeredAtMatch = content.match(/\*\*Triggered At:\*\*\s*(.+)/);
  const eventMatch = content.match(/\*\*Event:\*\*\s*(.+)/);
  const repoMatch = content.match(/\*\*Repository:\*\*\s*(.+)/);
  const repoUrlMatch = content.match(/\*\*Repository URL:\*\*\s*(.+)/);
  const prNumberMatch = content.match(/\*\*PR Number:\*\*\s*(.+)/);
  const prUrlMatch = content.match(/\*\*PR URL:\*\*\s*(.+)/);
  const triggeredByMatch = content.match(/\*\*Triggered By:\*\*\s*@?(.+)/);
  const triggeredByUrlMatch = content.match(/\*\*Triggered By URL:\*\*\s*(.+)/);
  const triggerPayloadMatch = content.match(/## Trigger Payload\n```json\n([\s\S]*?)\n```/);
  const promptMatch = content.match(/## Automation Prompt\n([\s\S]*)$/);

  const parsedPrNumber = prNumberMatch ? parseInt(prNumberMatch[1].trim(), 10) : NaN;

  return {
    source: 'automation_triggered',
    automationName: nameMatch[1].trim(),
    triggerType: triggerTypeMatch?.[1]?.trim() ?? 'unknown',
    triggeredAt: triggeredAtMatch?.[1]?.trim() ?? '',
    event: eventMatch?.[1]?.trim(),
    repositoryName: repoMatch?.[1]?.trim(),
    repositoryUrl: safeHttpsUrl(repoUrlMatch?.[1]),
    prNumber: isNaN(parsedPrNumber) ? undefined : parsedPrNumber,
    prUrl: safeHttpsUrl(prUrlMatch?.[1]),
    triggeredBy: triggeredByMatch?.[1]?.trim(),
    triggeredByUrl: safeHttpsUrl(triggeredByUrlMatch?.[1]),
    triggerPayload: triggerPayloadMatch?.[1]?.trim(),
    userPrompt: promptMatch?.[1]?.trim() ?? '',
  };
}

// =============================================================================
// Main Entry Point
// =============================================================================

function parseSingleMessage(content: string): NonMergedParsedPrompt {
  return (
    parseChatForkHandoff(content) ??
    parseCIFailure(content) ??
    parseGitHubIssueNew(content) ??
    parseGitHubIssueExisting(content) ??
    parseGitLabIssueNew(content) ??
    parseGitLabIssueExisting(content) ??
    parseGitHubPRNew(content) ??
    parseGitHubPRExistingPRReview(content) ??
    parseGitHubPRExistingReview(content) ??
    parseGitHubPRExistingGeneral(content) ??
    parseGitLabMRExistingGeneral(content) ??
    parseGitLabMRNew(content) ??
    parseScoutSlackMessage(content) ??
    parseTextMessage(content) ??
    parseScoutLinearIssue(content) ??
    parseSlackTask(content) ??
    parseLinearIssue(content) ??
    parseAutomationTriggered(content) ??
    parseInlineDiffComments(content) ??
    parsePlanQuote(content) ??
    { source: 'raw' as const, content }
  );
}

// Detection uses the full separator (not the trimmed marker) so a PR
// comment body containing only the bare `<!-- okidoki:merged -->`
// substring is not displayed as a merged burst.
function parseMerged(content: string): MergedParsed | null {
  if (!content.includes(MERGED_MESSAGE_SEPARATOR)) return null;
  const chunks = content
    .split(MERGED_MESSAGE_SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (chunks.length < 2) return null;
  return {
    source: 'merged',
    messages: chunks.map((chunk) => parseSingleMessage(chunk)),
  };
}

/**
 * Parses a raw user message string into a structured prompt object.
 * Strips okidoki_instructions tags first, checks for the engine's
 * merged-message marker (in which case it returns a `MergedParsed`),
 * then tries each known prompt format in order. Falls back to
 * { source: 'raw', content } if none match.
 */
export function parseUserMessage(rawContent: string): ParsedPrompt {
  const content = stripOkidokiInstructionBlock(rawContent).trim();
  return parseMerged(content) ?? parseSingleMessage(content);
}
