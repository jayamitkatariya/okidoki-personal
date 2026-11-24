import type { TriggerDefinition, TriggerParameterDefinition } from '../types';

interface GitLabTriggerParameterDefinition extends TriggerParameterDefinition {
  type: 'repository_ids' | 'boolean' | 'excluded_actors';
}

const REPO_FILTER_PARAM: GitLabTriggerParameterDefinition = {
  id: 'repository_ids',
  label: 'Filter by project',
  type: 'repository_ids',
};

const EXCLUDED_ACTORS_PARAM: GitLabTriggerParameterDefinition = {
  id: 'excluded_actors',
  label: 'Exclude users',
  type: 'excluded_actors',
};

const GROUP_MR_EVENTS_PARAM: GitLabTriggerParameterDefinition = {
  id: 'group_pr_events',
  label: 'Group MR events to same workspace',
  type: 'boolean',
};

export const GITLAB_TRIGGER: TriggerDefinition = {
  type: 'gitlab',
  label: 'GitLab',
  description: 'Trigger on project events',
  icon: 'gitlab',
  events: [
    { id: 'merge_request.opened', label: 'MR opened', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_MR_EVENTS_PARAM] },
    { id: 'merge_request.updated', label: 'MR updated (new commits)', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM, GROUP_MR_EVENTS_PARAM] },
    { id: 'merge_request.merged', label: 'MR merged', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM] },
    { id: 'merge_request.closed', label: 'MR closed', parameters: [REPO_FILTER_PARAM, EXCLUDED_ACTORS_PARAM] },
  ],
};
