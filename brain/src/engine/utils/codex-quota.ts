import type { AgentEvent, CodexQuotaState, CodexQuotaStatusPayload, EngineAuthMethod } from '@okidoki/shared';
import { CODEX_QUOTA_STATUS_EVENT_TYPE } from '@okidoki/shared';

export interface CodexRateLimitsSnapshot {
  state: CodexQuotaState;
  balance: string | null;
  rateLimitResetType: string | null;
  planType: string | null;
}

interface CodexRateLimitFields {
  authMethod: EngineAuthMethod;
  unlimited: boolean | null;
  balance: string | null;
  rateLimitResetType: string | null;
  planType: string | null;
}

export function buildCodexRateLimitsSnapshot(fields: CodexRateLimitFields): CodexRateLimitsSnapshot | null {
  if (fields.authMethod !== 'oauth') return null;
  if (fields.unlimited === true) return null;

  let state: CodexQuotaState = 'ok';
  if (fields.rateLimitResetType?.endsWith('_credits_depleted')) {
    state = 'out_of_credits';
  } else if (fields.rateLimitResetType !== null) {
    state = 'rate_limited';
  }

  return {
    state,
    balance: fields.balance,
    rateLimitResetType: fields.rateLimitResetType,
    planType: fields.planType,
  };
}

export class CodexQuotaStatusTracker {
  private lastEmittedQuotaState: CodexQuotaState = 'ok';
  private latestQuotaSnapshot: CodexRateLimitsSnapshot | null = null;

  // OpenAI keeps `rate_limit_reached_type` set in snapshots even while requests
  // still succeed (the flag is sticky until an authoritative snapshot clears it),
  // so an out_of_credits reading on its own is not trustworthy. Record it here,
  // and only surface it via confirmOutOfCredits() once a turn actually fails
  // with a quota error.
  observe(snapshot: CodexRateLimitsSnapshot): AgentEvent | null {
    this.latestQuotaSnapshot = snapshot;
    if (snapshot.state === 'out_of_credits') return null;
    if (snapshot.state === this.lastEmittedQuotaState) return null;
    return this.emit(snapshot);
  }

  confirmOutOfCredits(): AgentEvent | null {
    if (this.latestQuotaSnapshot?.state !== 'out_of_credits') return null;
    return this.emit(this.latestQuotaSnapshot);
  }

  recordTurnSuccess(): AgentEvent | null {
    if (this.lastEmittedQuotaState === 'ok') return null;
    return this.emit({
      state: 'ok',
      balance: this.latestQuotaSnapshot?.balance ?? null,
      rateLimitResetType: null,
      planType: this.latestQuotaSnapshot?.planType ?? null,
    });
  }

  private emit(snapshot: CodexRateLimitsSnapshot): AgentEvent {
    this.lastEmittedQuotaState = snapshot.state;
    this.latestQuotaSnapshot = snapshot;

    const payload = {
      state: snapshot.state,
      balance: snapshot.balance,
      rateLimitResetType: snapshot.rateLimitResetType,
      planType: snapshot.planType,
    } satisfies CodexQuotaStatusPayload;

    return {
      timestamp: new Date().toISOString(),
      type: CODEX_QUOTA_STATUS_EVENT_TYPE,
      payload,
    };
  }
}
