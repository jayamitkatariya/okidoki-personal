import { formatManagerSubagentName } from './manager-events';
import type { InputRequestRaised, WorkspaceTurnCompletion } from './routes/workspace-events';
import { isManagerWorkspace } from './routes/workspaces';
import { formatCodeHostRequestRef } from './urls';

const MANAGER_RELAY_WINDOW_MS = 5 * 60_000;

interface WorkspaceTurnAlert {
  kind: 'question' | 'blocked' | 'finished';
  title: string;
  body: string;
}

export function workspaceTurnAlert(
  completion: WorkspaceTurnCompletion,
  workspace: { kind: string },
  viewerId: string | undefined,
  lastSubagentAlertAt: number | undefined,
): WorkspaceTurnAlert | null {
  if (completion.processing) return null;
  const attention = completion.attention?.userId === viewerId ? completion.attention?.reason : undefined;
  if (completion.pullRequestFeedback && !attention) return null;
  // A Manager ends a turn for every subagent update, and often relays a subagent that just alerted.
  if (isManagerWorkspace(workspace) && (!attention || (lastSubagentAlertAt !== undefined && Date.parse(completion.completedAt) - lastSubagentAlertAt < MANAGER_RELAY_WINDOW_MS))) return null;
  const name = completion.workspaceName || 'Your workspace';
  if (attention === 'question') return { kind: 'question', ...inputRequestAlert('question', name) };
  if (attention === 'blocked') return { kind: 'blocked', title: 'Agent is stuck', body: `${name} needs your help to continue.` };
  return { kind: 'finished', title: 'Turn finished', body: `${name} is ready for you.` };
}

export function inputRequestAlert(reason: InputRequestRaised['reason'], workspaceName: string): { title: string; body: string } {
  return reason === 'plan'
    ? { title: 'Plan ready for approval', body: `${workspaceName} is waiting on your approval.` }
    : { title: 'Needs your input', body: `${workspaceName} is waiting on your answer.` };
}

export function subagentReviewAlert(subagent: { name: string; prUrl: string | null }, managerName: string): { title: string; body: string } {
  const pullRequest = subagent.prUrl && formatCodeHostRequestRef(subagent.prUrl);
  return { title: 'Ready for review', body: `${formatManagerSubagentName(subagent.name)}${pullRequest ? ` · ${pullRequest}` : ''} in ${managerName}` };
}
