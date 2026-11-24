import type { AgentProvider } from '../agent';
import type { AgentFallbackReason } from '../agent-quota';
import type { ChatForkTrigger } from '../chat-fork';

// =============================================================================
// Parsed Prompt Types
// =============================================================================

export type PromptSource =
  | 'ci_failure'
  | 'linear_issue'
  | 'github_issue_new'
  | 'github_issue_existing'
  | 'gitlab_issue_new'
  | 'gitlab_issue_existing'
  | 'github_pr_new'
  | 'github_pr_existing_review'
  | 'github_pr_existing_pr_review'
  | 'github_pr_existing_general'
  | 'gitlab_mr_existing_general'
  | 'slack_task'
  | 'text_message'
  | 'automation_triggered'
  | 'plan_quote'
  | 'inline_diff_comments'
  | 'chat_fork'
  | 'merged'
  | 'raw';

export interface CIFailureParsed {
  source: 'ci_failure';
  prNumber: number;
  isMergeRequest: boolean;
  workflowName: string;
  workflowFile: string;
  conclusion: string;
  runUrl: string;
  conclusionText: string;
  prUrl?: string;
  fileUrl?: string;
}

export interface LinearIssueParsed {
  source: 'linear_issue';
  identifier: string;
  title: string;
  creatorName?: string;
  parentIssue?: {
    identifier: string;
    title: string;
    description: string;
  };
  description: string;
  request: string;
  previousComments?: string;
  issueUrl?: string;
}

export interface GitHubIssueNewParsed {
  source: 'github_issue_new';
  issueNumber: number;
  issueTitle: string;
  issueDescription: string;
  triggeringUser: string;
  triggeringComment: string;
  issueUrl?: string;
  userUrl?: string;
}

export interface GitHubIssueExistingParsed {
  source: 'github_issue_existing';
  issueNumber: number;
  commentUser: string;
  commentBody: string;
  issueUrl?: string;
  userUrl?: string;
}

export interface GitLabIssueNewParsed {
  source: 'gitlab_issue_new';
  issueNumber: number;
  issueTitle: string;
  issueDescription: string;
  triggeringUser: string;
  triggeringComment: string;
  issueUrl?: string;
  userUrl?: string;
}

export interface GitLabIssueExistingParsed {
  source: 'gitlab_issue_existing';
  issueNumber: number;
  commentUser: string;
  commentBody: string;
  issueUrl?: string;
  userUrl?: string;
}

export interface GitHubPRNewParsed {
  source: 'github_pr_new';
  prNumber: number;
  mentioningUser: string;
  contextMessage: string;
  prUrl?: string;
  userUrl?: string;
}

export interface GitHubPRExistingReviewParsed {
  source: 'github_pr_existing_review';
  prNumber: number;
  commentUser: string;
  commentBody: string;
  filePath: string;
  diffHunk: string;
  prUrl?: string;
  userUrl?: string;
  fileUrl?: string;
}

export interface GitHubPRExistingPRReviewParsed {
  source: 'github_pr_existing_pr_review';
  prNumber: number;
  reviewUser: string;
  reviewAction: string;
  commentBody: string;
  prUrl?: string;
  userUrl?: string;
}

export interface GitHubPRExistingGeneralParsed {
  source: 'github_pr_existing_general';
  prNumber: number;
  commentUser: string;
  commentBody: string;
  prUrl?: string;
  userUrl?: string;
}

export interface GitLabMRExistingGeneralParsed {
  source: 'gitlab_mr_existing_general';
  mergeRequestIid: number;
  commentUser: string;
  commentBody: string;
  commentUrl?: string;
}

export interface SlackTaskParsed {
  source: 'slack_task';
  workspaceTarget: string;
  threadContext: string;
  latestMessageUser: string;
  latestMessageText: string;
  threadUrl?: string;
  targetUrl?: string;
}

export interface TextMessageParsed {
  source: 'text_message';
  sender: string;
  text: string;
  reaction?: string;
}

export interface AutomationTriggeredParsed {
  source: 'automation_triggered';
  automationName: string;
  triggerType: string;
  triggeredAt: string;
  event?: string;
  repositoryName?: string;
  repositoryUrl?: string;
  prNumber?: number;
  prUrl?: string;
  triggeredBy?: string;
  triggeredByUrl?: string;
  triggerPayload?: string;
  userPrompt: string;
}

export interface PlanQuoteBlock {
  /** Filename of the plan the quote is from (e.g. `implementation.md`). */
  planFilename: string;
  /** The raw, selected text from the plan document. */
  quotedText: string;
  /** User's reply text associated with this quote. May be empty. */
  replyText: string;
}

export interface PlanQuoteParsed {
  source: 'plan_quote';
  /**
   * Ordered list of quote -> reply pairs. A message can quote and reply to
   * multiple chunks of the plan in a single turn.
   */
  blocks: PlanQuoteBlock[];
  /**
   * Text that appears before the first quote block in the message.
   * May be empty if the message starts with a quote marker.
   */
  leadingText: string;
}

export interface InlineDiffCommentBlock {
  path: string;
  startLineNumber?: number;
  lineNumber: number;
  location: string;
  side: string;
  lineText: string;
  body: string;
}

export interface InlineDiffCommentsParsed {
  source: 'inline_diff_comments';
  comments: InlineDiffCommentBlock[];
  leadingText: string;
  leadingPlanQuote?: PlanQuoteParsed;
}

export interface ChatForkParsed {
  source: 'chat_fork';
  sourceProvider: AgentProvider;
  sourceTitle: string;
  trigger: ChatForkTrigger;
  reason?: AgentFallbackReason;
  sourceModel?: string;
  model?: string;
  excerpt: string;
  replyText: string;
}

export interface RawPromptParsed {
  source: 'raw';
  content: string;
}

export interface MergedParsed {
  source: 'merged';
  messages: NonMergedParsedPrompt[];
}

export type NonMergedParsedPrompt =
  | CIFailureParsed
  | LinearIssueParsed
  | GitHubIssueNewParsed
  | GitHubIssueExistingParsed
  | GitLabIssueNewParsed
  | GitLabIssueExistingParsed
  | GitHubPRNewParsed
  | GitHubPRExistingReviewParsed
  | GitHubPRExistingPRReviewParsed
  | GitHubPRExistingGeneralParsed
  | GitLabMRExistingGeneralParsed
  | SlackTaskParsed
  | TextMessageParsed
  | AutomationTriggeredParsed
  | PlanQuoteParsed
  | InlineDiffCommentsParsed
  | ChatForkParsed
  | RawPromptParsed;

export type ParsedPrompt = NonMergedParsedPrompt | MergedParsed;
