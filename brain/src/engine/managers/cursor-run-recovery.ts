import { Agent as CursorAgent, AgentBusyError, type Run, type SDKAgent, type SDKUserMessage, type SendOptions } from '@cursor/sdk';

export async function sendCursorRun(
  agent: SDKAgent,
  message: string | SDKUserMessage,
  options: SendOptions,
  workingDirectory: string,
): Promise<Run> {
  try {
    return await agent.send(message, options);
  } catch (error) {
    if (!(error instanceof AgentBusyError) && !/^Agent agent-[\w-]+ already has active run$/.test(error instanceof Error ? error.message : '')) {
      throw error;
    }

    const { SqliteLocalAgentStore } = await import('@cursor/sdk/sqlite');
    const store = await SqliteLocalAgentStore.open({ workspaceRef: workingDirectory });
    try {
      const storedAgent = await store.agents.get({ agentId: agent.agentId });
      if (!storedAgent?.activeRunId) throw error;
      const activeRun = await store.runs.get({ agentId: agent.agentId, runId: storedAgent.activeRunId });
      if (!activeRun || ['finished', 'error', 'cancelled', 'expired'].includes(activeRun.status)) throw error;
      await CursorAgent.cancelRun(activeRun.runId, { runtime: 'local', cwd: workingDirectory, store });
      await agent.reload();
    } finally {
      await store.dispose();
    }

    return await agent.send(message, options);
  }
}
