import type { TriggerDefinition, TriggerParameterDefinition } from '../types';
import { buildCodeHostPrUrl } from '../../urls';

interface GitHubTriggerParameterDefinition extends TriggerParameterDefinition {
  type: 'repository_ids' | 'boolean' | 'excluded_actors' | 'reviewer_logins';
}

const REPO_FILTER_PARAM: GitHubTriggerParameterDefinition = {
  id: 'repository_ids',
  label: 'Filter by repository',
  type: 'repository_ids',
};

const EXCLUDED_ACTORS_PARAM: GitHubTriggerParameterDefinition = {
  id: 'excluded_actors',
  label: 'Exclude users',
  type: 'excluded_actors',
};

const REVIEWER_LOGINS_PARAM: GitHubTriggerParameterDefinition = {
  id: 'reviewer_logins',
  label: 'Requested reviewers',
  type: 'reviewer_logins',
  required: true,
};

const GROUP_PR_EVENTS_PARAM: GitHubTriggerParameterDefinition = {
  id: 'group_pr_events',
  label: 'Group PR events to same workspace',
  type: 'boolean',
};

export const REVIEW_REQUESTED_EVENT = 'pull_request.review_requested';

export const GITHUB_TRIGGER: TriggerDefinition = {
  type: 'github',
  label: 'GitHub',
  description: 'Trigger on repository events',
  icon: 'github',
  events: [
    { id: 'pull_request.opened', label: 'PR opened', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_PR_EVENTS_PARAM] },
    { id: 'pull_request.synchronize', label: 'PR updated (new commits)', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_PR_EVENTS_PARAM] },
    { id: 'pull_request.ready_for_review', label: 'PR marked ready for review', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_PR_EVENTS_PARAM] },
    { id: REVIEW_REQUESTED_EVENT, label: 'PR review requested', parameters: [REVIEWER_LOGINS_PARAM, REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM] },
    { id: 'pull_request.merged', label: 'PR merged', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM] },
    { id: 'pull_request.closed', label: 'PR closed', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM] },
    { id: 'pull_request.command', label: 'PR command (/okidoki run)', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_PR_EVENTS_PARAM] },
  ],
};

export const PR_COMMAND_EVENT = 'pull_request.command';

export function getAutomationCommandSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildPrCommandTriggerPayload(params: {
  repositoryId: string;
  githubRepositoryId: number | null;
  repoFullName: string;
  repoUrl: string;
  prNumber: number;
  command?: string;
  trigger?: string;
  senderLogin?: string;
}) {
  return {
    event: PR_COMMAND_EVENT,
    ...(params.command !== undefined ? { command: params.command } : {}),
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    repositoryId: params.repositoryId,
    repository: { id: params.githubRepositoryId, full_name: params.repoFullName, html_url: params.repoUrl },
    pullRequest: { number: params.prNumber, html_url: buildCodeHostPrUrl(params.repoUrl, 'github', params.prNumber) },
    ...(params.senderLogin ? { sender: { login: params.senderLogin, html_url: `https://github.com/${params.senderLogin}` } } : {}),
  };
}

