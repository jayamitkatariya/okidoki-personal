import type { EngineRepoState, IntegrationErrorNotificationTarget, TurnStopped } from './v1';
import type { AgentQuotaExhaustedPayload } from '../chat-fork';
import type { EnvironmentHookRunStatus, EnvironmentHookRunStep } from '../routes/environment-hook-runs';
import type { ToolInputOption, ToolInputQuestion } from '../display-message/types';
import type { ProxyRouteCheck } from '../start-hook-network';

export type LinearThought = { type: 'thought'; body: string };
export type LinearAction = { type: 'action'; action: string; parameter: string; result?: string };
export type LinearResponse = { type: 'response'; body: string };
export type LinearActivityContent = LinearThought | LinearAction | LinearResponse;

export type LinearAgentPlanItemStatus = 'pending' | 'inProgress' | 'completed' | 'canceled';

export interface LinearAgentPlanItem {
  content: string;
  status: LinearAgentPlanItemStatus;
}

export interface LinearActivityEvent<TContent extends LinearActivityContent> {
  linearSessionId: string;
  content: TContent;
}

export type LinearThoughtEvent = LinearActivityEvent<LinearThought>;
export type LinearActionEvent = LinearActivityEvent<LinearAction>;
export type LinearResponseEvent = LinearActivityEvent<LinearResponse>;

export type LinearEvent = LinearThoughtEvent | LinearActionEvent | LinearResponseEvent;

export interface StartHooksReport {
  runId: string;
  status: Exclude<EnvironmentHookRunStatus, 'cancelled'>;
  exitCode?: number;
  timedOut?: boolean;
  /** The tail of the output; `outputChars` counts all of it. */
  output?: string;
  outputChars?: number;
  network?: ProxyRouteCheck;
  steps?: EnvironmentHookRunStep[];
}

export type EngineWebhookEvent =
  | {
      type: 'workspace_ready';
      payload: {};
    }
  | {
      type: 'workspace_agent_idle';
      payload: { failedWithoutWork?: true };
    }
  | {
      type: 'agent_update';
      payload: LinearEvent;
    }
  | {
      type: 'agent_response_complete';
      payload: {
        completedAt?: string;
        processing?: boolean;
        chatId?: string;
        finalMessage?: string;
        request?: string;
        pullRequestFeedback?: boolean;
      };
    }
  | {
      type: 'agent_turn_complete';
      payload: {
        linearSessionId?: string;
        completedAt?: string;
        processing?: boolean;
        chatId?: string;
        /** The chat history's `afterCursor` once the turn landed; absent on older engines. */
        historyCursor?: string;
        repoStatuses: EngineRepoState[];
        /** User-facing messages when the turn ended in a terminal error. */
        errors?: string[];
        /** Automated notices about how a turn that did not error ran, such as falling back to an older model. */
        notices?: string[];
        /** An engine restart cut the turn off, and `errors` holds the whole notice for whoever asked for it. */
        turnLost?: boolean;
        /** A Stop ended this turn; `byUserId` is who pressed it, absent when no person did. Absent on older engines. */
        stopped?: TurnStopped;
        /** This turn's message, when a Stop took it back before the agent had it, so nothing ran. Absent on older engines. */
        handedBackMessageId?: string;
        errorNotificationTarget?: IntegrationErrorNotificationTarget;
        errorNotificationTargets?: IntegrationErrorNotificationTarget[];
        /** Set when the turn stopped because every credential in the fallback chain ran out. */
        quotaExhaustion?: AgentQuotaExhaustedPayload;
        unlinkedPullRequestUrls?: string[];
        pullRequestFeedback?: boolean;
      };
    }
  | {
      type: 'agent_input_requested';
      payload: {
        chatId: string;
        requestId?: string;
        toolName?: string;
        question?: string;
        questions?: Array<Pick<ToolInputQuestion, 'id' | 'multiSelect' | 'allowCustom'> & { options: Pick<ToolInputOption, 'id' | 'label'>[] }>;
        plan?: string;
        /** Engine time. Older engines leave it out. */
        at?: string;
      };
    }
  | {
      /** Answered, aborted or interrupted. Older engines never send it. */
      type: 'agent_input_resolved';
      payload: { chatId: string; requestId: string };
    }
  | {
      /** The step the agent is running, sent when it changes and at most every 20 seconds. Older monoliths ignore it. */
      type: 'agent_progress';
      payload: { chatId: string; step: string };
    }
  | {
      type: 'pull_request_check';
      payload: { repoStatuses: EngineRepoState[] };
    }
  | {
      /** Sent when a workspace's start hooks begin and again when they finish, with the same `runId`. */
      type: 'start_hooks';
      payload: StartHooksReport;
    }
  | {
      type: 'agent_plan_update';
      payload: {
        linearSessionId: string;
        plan: LinearAgentPlanItem[];
      };
    };
