import { normalizeAutomationGithubCheckNames, validateAutomationGithubCheckNames } from './github-checks';
import {
  AUTOMATION_DEBOUNCE_MAX_SECONDS,
  AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MAX,
  AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MIN,
  lifecyclePolicySupportsAutoStop,
  type AutomationLifecyclePolicy,
  type AutomationTrigger,
} from './types';

export const AUTOMATION_AUTO_STOP_RANGE_LABEL = `${AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MIN}-${AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MAX}`;

export const AUTOMATION_LIFECYCLE_OPTIONS: { value: AutomationLifecyclePolicy; label: string; description: string }[] = [
  { value: 'default', label: 'Keep alive, sleep when idle', description: 'The workspace stays available, sleeps after the idle timeout, and is archived, then deleted, after 7 days dormant.' },
  { value: 'sleep_when_done', label: 'Sleep right away', description: 'History stays available and the workspace stops accruing usage as soon as the agent finishes.' },
  { value: 'archive_when_done', label: 'Archive right away', description: 'The workspace is archived as soon as the agent finishes, and its machine is deleted 3 days later.' },
  { value: 'delete_when_done', label: 'Delete right away', description: 'The workspace is deleted as soon as the agent finishes, unless runs reuse one workspace. Best for runs whose output lives elsewhere, like PR comments or checks.' },
];

export const AUTOMATION_SWITCHES = {
  readOnlyContents: { label: 'Read-only repository contents', description: "Can't commit or push. Can still comment on PRs, open issues, and report checks." },
  prFollowups: { label: 'PR follow-ups', description: "Auto-reply to CI failures and review comments on PRs this automation opens or touches." },
  githubChecks: { label: 'Report results as GitHub checks', description: "Creates in-progress checks when a PR opens or updates; the run's result completes them." },
  memory: { label: 'Retain workspace memory', description: "Include these runs in the session history future workspaces can search." },
  background: { label: 'Show in Background', description: "Keeps this out of the main automations list. Agents use this for offhand reminders." },
};

export function describeLifecyclePolicyHint(policy: AutomationLifecyclePolicy): string | undefined {
  return AUTOMATION_LIFECYCLE_OPTIONS.find((option) => option.value === policy)?.description;
}

export function parseAutomationAutoStop(policy: AutomationLifecyclePolicy, minutes: string) {
  const value = lifecyclePolicySupportsAutoStop(policy) && minutes.trim() !== '' ? Number(minutes.trim()) : null;
  const valid = value === null || (Number.isInteger(value) && value >= AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MIN && value <= AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MAX);
  return {
    value,
    error: valid ? null : `Sleep timeout must be a whole number between ${AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MIN} and ${AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MAX} minutes`,
  };
}

export function parseAutomationRunLimit(maxRuns: string, runCount: number, oneTime: boolean) {
  const value = maxRuns.trim() === '' ? null : Number(maxRuns);
  const error = value !== null && !oneTime && (!Number.isInteger(value) || value < Math.max(1, runCount))
    ? runCount > 0 ? `Enter a whole number of at least ${runCount}, the runs already used.` : 'Enter a whole number of at least 1.'
    : null;
  const hint = value === null || error
    ? 'Runs every time it is triggered. Set a number to make it temporary.'
    : `Deletes itself after ${value} run${value === 1 ? '' : 's'}${runCount > 0 ? ` (${runCount} used)` : ''}. If the last run fails, it stays so you can retry.`;
  return { value, error, hint };
}

export function parseAutomationDebounce(seconds: string) {
  const value = seconds.trim() === '' ? null : Number(seconds);
  const valid = value === null || (Number.isInteger(value) && value >= 0 && value <= AUTOMATION_DEBOUNCE_MAX_SECONDS);
  return {
    value,
    valid,
    hint: valid
      ? 'Wait for events to settle and run once with the latest payload. GitHub and GitLab events debounce per PR or MR.'
      : `Enter a whole number from 0 to ${AUTOMATION_DEBOUNCE_MAX_SECONDS}.`,
  };
}

export function parseAutomationGithubCheckNames(enabled: boolean, names: string, triggers: AutomationTrigger[]) {
  const value = normalizeAutomationGithubCheckNames(names.split('\n'));
  const validation = validateAutomationGithubCheckNames(enabled ? value : [], triggers);
  return {
    value,
    error: !enabled ? null : value.length === 0 ? 'Add at least one check name' : validation.ok ? null : validation.error.message,
  };
}
