import { isValidAgentProvider, getThinkingLevelOptions, isProviderSpecificThinkingLevel, isValidThinkingLevel, VALID_THINKING_LEVELS, type AgentProvider, type ThinkingLevel } from '../agent';
import { getAgentModelOptions, isAgentModelAllowed, normalizeClaudeModel, type AgentModelOverrides } from '../engine/types';
import { createErrorResult, createSuccessResult, type Result } from '../result';

export type AgentSelection = {
  agentProvider: AgentProvider | null | undefined;
  model: string | null | undefined;
  thinkingLevel: ThinkingLevel | null | undefined;
};

export type AgentSelectionInput = {
  agent_provider?: AgentProvider | null;
  model?: string | null;
  thinking_level?: ThinkingLevel | null;
};

export type ExistingAgentSelection = {
  agentProvider: AgentProvider | null | undefined;
  model: string | null | undefined;
  thinkingLevel?: ThinkingLevel | null;
};

export type AgentSelectionResult = Result<AgentSelection>;

export function validateAgentSelection(
  body: AgentSelectionInput,
  existing: ExistingAgentSelection,
  allowedProviders: readonly AgentProvider[],
  modelCatalogs: AgentModelOverrides = {},
): AgentSelectionResult {
  const agentProvider = body.agent_provider;
  if (agentProvider !== undefined && agentProvider !== null) {
    if (!isValidAgentProvider(agentProvider) || !allowedProviders.includes(agentProvider)) {
      return createErrorResult({ message: `Invalid agent_provider: must be one of ${allowedProviders.join(', ')}` });
    }
  }

  const executionAgent: AgentProvider | null | undefined =
    agentProvider !== undefined ? agentProvider : existing.agentProvider;
  const agentChanged = agentProvider !== undefined && agentProvider !== existing.agentProvider;

  let model: string | null | undefined = body.model;
  if (agentChanged && model === undefined && existing.model) {
    model = null;
  }
  let thinkingLevel = body.thinking_level;
  if (agentChanged && thinkingLevel === undefined && existing.thinkingLevel && executionAgent
    && !getThinkingLevelOptions(executionAgent).includes(existing.thinkingLevel)) {
    thinkingLevel = null;
  }

  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return createErrorResult({ message: 'model must be a non-empty string' });
    }
    model = normalizeClaudeModel(model) ?? model;
    if (!executionAgent) {
      return createErrorResult({ message: 'Cannot set model without an agent_provider (the model would be applied against the org default agent and may not be valid for it)' });
    }
    const allowed = getAgentModelOptions(executionAgent, modelCatalogs);
    if (!isAgentModelAllowed(executionAgent, model, modelCatalogs)) {
      return createErrorResult({ message: `Invalid model "${model}" for agent ${executionAgent}. Valid models: ${allowed.join(', ')}` });
    }
  }

  if (thinkingLevel !== undefined && thinkingLevel !== null) {
    if (!executionAgent && isProviderSpecificThinkingLevel(thinkingLevel)) {
      return createErrorResult({ message: `Cannot set ${thinkingLevel} without an agent_provider` });
    }
    if (!isValidThinkingLevel(thinkingLevel) || (executionAgent && !getThinkingLevelOptions(executionAgent).includes(thinkingLevel))) {
      const validLevels = executionAgent ? getThinkingLevelOptions(executionAgent) : VALID_THINKING_LEVELS;
      return createErrorResult({ message: `Invalid thinking_level: must be one of ${validLevels.join(', ')}` });
    }
  }

  return createSuccessResult({ agentProvider, model, thinkingLevel });
}
