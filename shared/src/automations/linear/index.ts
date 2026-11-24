import { z } from 'zod';
import { LINEAR_WORKFLOW_STATE_TYPES, type LinearWorkflowStateType } from '../../routes/linear';
import type { TriggerDefinition, TriggerParameterDefinition } from '../types';

export const LINEAR_ISSUE_STATE_CHANGED_EVENT = 'issue.state_changed';
export const LINEAR_ISSUE_MATCHED_EVENT = 'issue.matched';

export const linearIssueFiltersSchema = z.object({
  current_cycle: z.boolean().optional(),
  label_ids: z.array(z.string().min(1)).min(1).optional(),
  project_id: z.string().min(1).optional(),
  assignee_id: z.string().min(1).optional(),
});
export type LinearIssueFilters = z.infer<typeof linearIssueFiltersSchema>;

export type LinearStateType = Exclude<LinearWorkflowStateType, 'duplicate'>;
export const LINEAR_STATE_TYPES = LINEAR_WORKFLOW_STATE_TYPES.filter((type): type is LinearStateType => type !== 'duplicate');
/** Linear's default state names for each type; teams can rename their states. */
export const LINEAR_STATE_TYPE_LABELS: Record<LinearStateType, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Todo',
  started: 'In Progress',
  completed: 'Done',
  canceled: 'Canceled',
};

interface LinearTriggerParameterDefinition extends TriggerParameterDefinition {
  type: 'team_ids' | 'state_types';
}

export const LINEAR_TRIGGER: TriggerDefinition = {
  type: 'linear',
  label: 'Linear',
  description: 'Trigger on Linear issue changes',
  icon: 'linear',
  events: [
    {
      id: LINEAR_ISSUE_STATE_CHANGED_EVENT,
      label: 'Issue changed state',
      parameters: [
        { id: 'team_ids', label: 'Filter by team', type: 'team_ids' },
        { id: 'state_types', label: 'Filter by new state', type: 'state_types' },
      ] satisfies LinearTriggerParameterDefinition[],
    },
    { id: LINEAR_ISSUE_MATCHED_EVENT, label: 'Issue matches filters' },
  ],
};
