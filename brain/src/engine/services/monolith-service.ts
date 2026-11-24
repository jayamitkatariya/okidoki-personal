import {
  createErrorResult,
  createSuccessResult,
  type AgentProvider,
  type AuthMethod,
  type EngineWebhookEvent,
  type FallbackPlanResponse,
  type GetAutoCompactConfigResponse,
  type GetSubagentMcpConfigResponse,
  type Result,
} from '@okidoki/shared';
import type {
  GenerateChatNameResponse,
  GenerateWorkspaceNameWithImagesRequest,
} from '@okidoki/shared/routes/workspace-naming';

/**
 * Okidoki runs entirely on this Mac, so the engine configuration a hosted
 * control plane would answer is answered locally. Keeping the same surface
 * means the engine's refresh, fallback and naming paths stay unchanged.
 */
export async function monolithRequest(
  _path: string,
  _init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  return new Response(
    JSON.stringify({ error: 'Okidoki runs locally; no control plane is configured.' }),
    { status: 501, headers: { 'Content-Type': 'application/json' } },
  );
}

const LOCAL_SUBAGENT_PROVIDERS: AgentProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'pi',
  'muse',
];

export class MonolithService {
  async getSubagentMcpConfig(): Promise<GetSubagentMcpConfigResponse | null> {
    return { enabled: true, providers: LOCAL_SUBAGENT_PROVIDERS };
  }

  async getAutoCompactConfig(_provider: AgentProvider): Promise<GetAutoCompactConfigResponse | null> {
    return null;
  }

  async generateChatName(request: GenerateWorkspaceNameWithImagesRequest): Promise<string | null> {
    const firstLine = request.prompt
      .replace(/\s+/g, ' ')
      .replace(/^[#>*\-\s]+/, '')
      .trim();
    if (!firstLine) return null;
    const response: GenerateChatNameResponse = {
      name: firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine,
    };
    return response.name;
  }

  async getOpenRouterModels(): Promise<string[] | null> {
    return null;
  }

  async getFallbackPlan(_params: {
    provider: AgentProvider;
    exhaustedMethod?: AuthMethod;
    exclude: readonly AgentProvider[];
    userId?: string;
  }): Promise<Result<FallbackPlanResponse, 'unsupported' | 'unavailable'>> {
    return createErrorResult({ message: 'Local mode uses the configured provider directly', code: 'unsupported' });
  }

  async sendEvent(_event: EngineWebhookEvent, _signal?: AbortSignal): Promise<boolean> {
    return true;
  }
}

export const monolithService = new MonolithService();
