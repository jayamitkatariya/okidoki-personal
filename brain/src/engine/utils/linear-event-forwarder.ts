import type { LinearAgentPlanItem, LinearEvent, LinearThoughtEvent } from '@okidoki/shared';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { TaskAccumulator } from '@okidoki/shared';
import { monolithService } from '../services/monolith-service';
import { linearThoughtToResponse, mapTodoStatus } from './linear-converter';

function isLinearThoughtEvent(event: LinearEvent): event is LinearThoughtEvent {
  return event.content.type === 'thought';
}

export class LinearEventForwarder {
  private readonly getLinearSessionId: () => string | undefined;
  private readonly taskAccumulator = new TaskAccumulator();
  private latestThoughtEvent: LinearThoughtEvent | null = null;

  constructor(getLinearSessionId: () => string | undefined) {
    this.getLinearSessionId = getLinearSessionId;
  }

  private get linearSessionId(): string | undefined {
    return this.getLinearSessionId();
  }

  sendPlan(plan: LinearAgentPlanItem[] | null | undefined): void {
    if (!this.linearSessionId || !plan) return;
    monolithService.sendEvent({
      type: 'agent_plan_update',
      payload: { linearSessionId: this.linearSessionId, plan },
    }).catch(() => {});
  }

  processClaudeEventForPlan(event: SDKMessage): void {
    if (!this.linearSessionId) return;
    if (!this.routeEventToAccumulator(event)) return;
    const plan = this.taskAccumulator.getTasks().map((task) => ({
      content: task.subject,
      status: mapTodoStatus(task.status),
    }));
    this.sendPlan(plan);
  }

  private routeEventToAccumulator(event: SDKMessage): boolean {
    if (event.type !== 'assistant' && event.type !== 'user') return false;
    const content = event.message.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const block of content) {
      if (this.taskAccumulator.processContentBlock(block)) changed = true;
    }
    return changed;
  }

  sendEvent(linearEvent: LinearEvent | null | undefined): void {
    if (!this.linearSessionId || !linearEvent) return;
    if (this.latestThoughtEvent) {
      monolithService.sendEvent({ type: 'agent_update', payload: this.latestThoughtEvent }).catch(() => {});
    }

    if (isLinearThoughtEvent(linearEvent)) {
      this.latestThoughtEvent = linearEvent;
      return;
    }

    this.latestThoughtEvent = null;
    monolithService.sendEvent({ type: 'agent_update', payload: linearEvent }).catch(() => {});
  }

  flushThoughtAsResponse(): void {
    if (!this.linearSessionId || !this.latestThoughtEvent) return;
    monolithService.sendEvent({
      type: 'agent_update',
      payload: linearThoughtToResponse(this.latestThoughtEvent),
    }).catch(() => {});
    this.latestThoughtEvent = null;
  }
}
