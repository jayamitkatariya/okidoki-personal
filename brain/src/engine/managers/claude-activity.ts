export type ClaudeSessionState = 'idle' | 'running' | 'requires_action';

export interface ClaudeSessionActivity {
  state: ClaudeSessionState;
  observedAuthoritativeState: boolean;
}

interface ClaudeSessionActivityMessage {
  type: string;
  subtype?: string;
  state?: unknown;
}

export function createClaudeSessionActivity(): ClaudeSessionActivity {
  return { state: 'idle', observedAuthoritativeState: false };
}

export function resetClaudeSessionActivity(activity: ClaudeSessionActivity): void {
  activity.state = 'idle';
  activity.observedAuthoritativeState = false;
}

export function updateClaudeSessionActivity(
  activity: ClaudeSessionActivity,
  message: ClaudeSessionActivityMessage,
): void {
  if (
    message.type === 'system'
    && message.subtype === 'session_state_changed'
    && (message.state === 'idle' || message.state === 'running' || message.state === 'requires_action')
  ) {
    activity.state = message.state;
    activity.observedAuthoritativeState = true;
    return;
  }

  if (activity.observedAuthoritativeState) return;
  if (message.type === 'system' && message.subtype === 'init') {
    activity.state = 'running';
  } else if (message.type === 'result') {
    activity.state = 'idle';
  }
}

export function isClaudeSessionActive(activity: ClaudeSessionActivity): boolean {
  return activity.state !== 'idle';
}
