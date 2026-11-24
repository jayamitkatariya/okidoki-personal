import type { PromptSource } from './types';

export interface SourceConfig {
  /** Human-readable label for the source */
  label: string;
}

export const SOURCE_CONFIG: Record<Exclude<PromptSource, 'raw'>, SourceConfig> = {
  ci_failure: { label: 'CI Failure' },
  linear_issue: { label: 'Linear' },
  github_issue_new: { label: 'GitHub Issue' },
  github_issue_existing: { label: 'GitHub Issue' },
  gitlab_issue_new: { label: 'GitLab Issue' },
  gitlab_issue_existing: { label: 'GitLab Issue' },
  github_pr_new: { label: 'GitHub PR' },
  github_pr_existing_review: { label: 'Code Review' },
  github_pr_existing_pr_review: { label: 'PR Review' },
  github_pr_existing_general: { label: 'GitHub PR' },
  gitlab_mr_existing_general: { label: 'GitLab MR' },
  slack_task: { label: 'Slack' },
  text_message: { label: 'Text' },
  automation_triggered: { label: 'Automation' },
  plan_quote: { label: 'Plan' },
  inline_diff_comments: { label: 'Diff Comments' },
  chat_fork: { label: 'Forked chat' },
  merged: { label: 'Bundled' },
};
