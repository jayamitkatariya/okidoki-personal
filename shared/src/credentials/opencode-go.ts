import { fetchModelsDevCatalog } from '../models-dev';

export const OPENCODE_GO_PROVIDER = 'opencode-go';
export const OPENCODE_ZEN_PROVIDER = 'opencode';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_OPENCODE_GO_MODEL = 'glm-5.3';

export interface OpenCodeGoModelDefinition {
  id: string;
  name: string;
  description?: string;
  status?: 'alpha' | 'beta' | 'deprecated';
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
}

export interface OpenCodeGoCatalog {
  models: Record<string, OpenCodeGoModelDefinition>;
  authoritative: boolean;
}

export function isOpenCodeZenModel(model: string): boolean {
  return model.startsWith(`${OPENCODE_ZEN_PROVIDER}/`);
}

// OpenCode serves Zen's free models without a key, but only to OpenCode itself (https://opencode.ai/docs/zen/).
export async function fetchOpenCodeGoCatalog(
  agent: 'opencode' | 'pi',
  fallbackModelIds: readonly string[] = [DEFAULT_OPENCODE_GO_MODEL],
): Promise<OpenCodeGoCatalog> {
  try {
    const catalog = await fetchModelsDevCatalog();
    const provider = catalog[OPENCODE_GO_PROVIDER];
    if (!provider) throw new Error('OpenCode Go model catalog is unavailable');
    const zenFreeModels = agent === 'opencode'
      ? Object.entries(catalog[OPENCODE_ZEN_PROVIDER]?.models ?? {})
        // OpenCode's own free-tier rule: keyless requests keep the models whose input is free.
        .filter(([, definition]) => definition.cost?.input === 0)
        .map(([id, definition]) => [`${OPENCODE_ZEN_PROVIDER}/${id}`, definition] as const)
      : [];
    const models = Object.fromEntries(
      [...Object.entries(provider.models), ...zenFreeModels]
        .filter(([, definition]) => definition.status !== 'deprecated' && definition.status !== 'alpha')
        .map(([id, definition]) => [id, {
          id: definition.id ?? id,
          name: definition.name,
          api: definition.provider?.npm === '@ai-sdk/anthropic'
            ? 'anthropic-messages'
            : definition.provider?.npm === '@ai-sdk/openai'
              ? 'openai-responses'
              : undefined,
          ...(definition.description ? { description: definition.description } : {}),
          ...(definition.status ? { status: definition.status } : {}),
        } satisfies OpenCodeGoModelDefinition]),
    );
    if (Object.keys(models).length === 0) throw new Error('OpenCode Go model catalog is unavailable');
    return { models, authoritative: true };
  } catch {
    return {
      authoritative: false,
      models: Object.fromEntries(fallbackModelIds
        .filter((id) => agent === 'opencode' || !isOpenCodeZenModel(id))
        .map((id) => [id, {
          id,
          name: id === DEFAULT_OPENCODE_GO_MODEL ? 'GLM 5.3' : id,
        }])),
    };
  }
}
