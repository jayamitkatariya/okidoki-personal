import { formatCreditRate, WORKSPACE_SIZE_CREDIT_RATES } from '../pricing';
import { AUTO_WORKSPACE_SIZE, WORKSPACE_SIZE_LABELS, WORKSPACE_SIZES, type WorkspaceSizeOption } from '../sandbox';
import { getTriggerEvent } from './registry';
import type { AutomationLifecyclePolicy, AutomationTrigger, AutomationTriggerType } from './types';

export interface AutomationWorkspaceTarget {
  reuseWorkspace: boolean;
  targetWorkspaceId: string | null;
}

export const AUTOMATION_WORKSPACE_MODES = [
  { reuseWorkspace: false, label: 'New workspace each run', description: 'Every run starts fresh' },
  { reuseWorkspace: true, label: 'One workspace for every run', description: 'Made on the first run, then reused' },
] as const;

export function describeWorkspaceTarget(target: AutomationWorkspaceTarget, workspaceName?: string): string {
  if (!target.reuseWorkspace) return AUTOMATION_WORKSPACE_MODES[0].label;
  if (!target.targetWorkspaceId) return AUTOMATION_WORKSPACE_MODES[1].label;
  return workspaceName ?? 'Existing workspace';
}

export function describeWorkspaceHint(target: AutomationWorkspaceTarget): string {
  if (!target.reuseWorkspace) return 'Each run starts in a fresh workspace.';
  return target.targetWorkspaceId
    ? 'Each run is sent to this workspace as a new message, waking it if it is asleep. If the workspace is deleted, the next run creates a replacement.'
    : 'The first run creates a workspace. Every later run is sent to it as a new message.';
}

export const AUTOMATION_GROUPING_LABELS: Partial<Record<AutomationTriggerType, string>> = {
  slack: 'Thread replies go to the workspace their thread started',
  github: 'Later events on the same PR go to that PR’s workspace',
  gitlab: 'Later events on the same MR go to that MR’s workspace',
};

export function automationGroupingParam(trigger: AutomationTrigger): 'group_thread_replies' | 'group_pr_events' | null {
  if (trigger.type === 'slack') return 'group_thread_replies';
  if ((trigger.type === 'github' || trigger.type === 'gitlab')
    && getTriggerEvent(trigger.type, trigger.config.event)?.parameters?.some((param) => param.id === 'group_pr_events')) {
    return 'group_pr_events';
  }
  return null;
}

export function isAutomationTriggerGrouped(trigger: AutomationTrigger): boolean {
  if (trigger.type === 'slack') return trigger.config.group_thread_replies !== false;
  if (trigger.type === 'github' || trigger.type === 'gitlab') return trigger.config.group_pr_events === true;
  return false;
}

export function setAutomationTriggerGrouping(trigger: AutomationTrigger, grouped: boolean): AutomationTrigger {
  if (trigger.type === 'slack') return { ...trigger, config: { ...trigger.config, group_thread_replies: grouped } };
  if (trigger.type === 'github' || trigger.type === 'gitlab') return { ...trigger, config: { ...trigger.config, group_pr_events: grouped || undefined } };
  return trigger;
}

export function describeLifecyclePolicy(policy: AutomationLifecyclePolicy, autoStopMinutes: number | null): string {
  switch (policy) {
    case 'archive_when_done':
      return 'Archive when done';
    case 'sleep_when_done':
      return 'Sleep when done';
    case 'delete_when_done':
      return 'Delete when done';
    case 'default':
    default:
      return autoStopMinutes
        ? `Keep alive (sleeps after ${autoStopMinutes} minute${autoStopMinutes === 1 ? '' : 's'} of inactivity, archives after 7 days asleep)`
        : 'Keep alive (sleeps after inactivity, archives after 7 days asleep)';
  }
}

export function formatWorkspaceSizeSpecs(size: WorkspaceSizeOption) {
  const rate = size === AUTO_WORKSPACE_SIZE
    ? `${formatCreditRate(WORKSPACE_SIZE_CREDIT_RATES[WORKSPACE_SIZES[0]].included)}–${formatCreditRate(WORKSPACE_SIZE_CREDIT_RATES[WORKSPACE_SIZES[WORKSPACE_SIZES.length - 1]].included).slice(1)}`
    : formatCreditRate(WORKSPACE_SIZE_CREDIT_RATES[size].included);
  return `${WORKSPACE_SIZE_LABELS[size]} · ${rate}/min`;
}
