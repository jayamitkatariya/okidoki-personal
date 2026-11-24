import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeBackgroundTasks {
  readonly active = new Set<string>();
  // Background agents and workflows end on an interrupt; shell commands keep running.
  runsAgents = false;
  // The main agent's blocking tasks, by tool_use id; a subagent's own commands are its to wait on.
  readonly foreground = new Map<string, string>();
  // A task counts as the main agent's only when its tool call is one the main agent made, so a task
  // whose owner can't be told apart is left running.
  private readonly mainToolUses = new Set<string>();

  reset(): void {
    this.active.clear();
    this.runsAgents = false;
    this.foreground.clear();
    this.mainToolUses.clear();
  }

  update(message: SDKMessage): void {
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      for (const block of message.message.content) if (block.type === 'tool_use') this.mainToolUses.add(block.id);
    }
    if (message.type === 'result') this.mainToolUses.clear();
    if (message.type !== 'system') return;
    // Claude Code sends owned_by_subagent (missing from the SDK types) for workflow and teammate tasks too, which have no parent_task_id.
    const ownedBySubagent = 'owned_by_subagent' in message && message.owned_by_subagent === true;
    if (message.subtype === 'task_started' && message.is_backgrounded === false && !message.parent_task_id && !ownedBySubagent
      && message.tool_use_id && this.mainToolUses.delete(message.tool_use_id)) {
      this.foreground.set(message.task_id, message.tool_use_id);
    }
    if (message.subtype === 'task_notification') this.foreground.delete(message.task_id);
    if (message.subtype === 'task_updated' && (message.patch.is_backgrounded || (message.patch.status && message.patch.status !== 'running'))) {
      this.foreground.delete(message.task_id);
    }
    if (message.subtype !== 'background_tasks_changed') return;
    this.active.clear();
    this.runsAgents = message.tasks.some((task) => task.task_type !== 'local_bash');
    for (const task of message.tasks) {
      if (!task.ambient) this.active.add(task.task_id);
    }
  }
}
