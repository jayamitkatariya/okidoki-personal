import { listOpenAICompatibleModels } from './openai';
import type { OllamaCredentials } from './ollama';
import type { ModelCatalogItem } from '../routes/model-catalog';
import { isRecord } from '../type-guards';
import { validateExternalApiHost } from '../external-api-host';

export const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b';

const catalogs = new Map<string, { expiresAt: number; models: Promise<ModelCatalogItem[]> }>();

export function getDefaultOllamaModel(models: readonly ModelCatalogItem[]): string | null {
  return models.find((model) => model.id === DEFAULT_OLLAMA_MODEL
    && model.capabilities?.includes('tools') && (model.contextWindow ?? 0) >= 64_000)?.id ?? null;
}

export function parseOllamaModelDetails(model: ModelCatalogItem, payload: unknown): ModelCatalogItem {
  if (!isRecord(payload)) return model;
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((value): value is string => typeof value === 'string') : undefined;
  const info = isRecord(payload.model_info) ? payload.model_info : {};
  const context = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
  const configured = typeof payload.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(payload.parameters)?.[1] : undefined;
  const contextWindow = configured ? Number(configured) : context;
  return {
    ...model,
    ...(capabilities ? { capabilities } : {}),
    ...(typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  };
}

export function listOllamaModels(credential: OllamaCredentials): Promise<ModelCatalogItem[]> {
  const key = JSON.stringify([credential.baseUrl, credential.apiKey]);
  const cached = catalogs.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const models = loadOllamaModels(credential).catch((error: unknown) => {
    if (catalogs.get(key)?.models === models) catalogs.delete(key);
    throw error;
  });
  catalogs.set(key, { expiresAt: Date.now() + 60_000, models });
  return models;
}

async function loadOllamaModels(credential: OllamaCredentials): Promise<ModelCatalogItem[]> {
  const models = await listOpenAICompatibleModels({ apiKey: credential.apiKey, baseUrl: `${credential.baseUrl}/v1` });
  const url = `${credential.baseUrl}/api/show`;
  validateExternalApiHost(url, 'Ollama model details');
  const detailed: ModelCatalogItem[] = [];
  const signal = AbortSignal.timeout(10_000);
  for (let offset = 0; offset < models.length; offset += 10) {
    if (signal.aborted) {
      detailed.push(...models.slice(offset));
      break;
    }
    detailed.push(...await Promise.all(models.slice(offset, offset + 10).map(async (model) => {
      try {
        const response = await fetch(url, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model.id }),
        });
        return response.ok ? parseOllamaModelDetails(model, await response.json()) : model;
      } catch {
        return model;
      }
    })));
  }
  return detailed.sort((left, right) => left.id.localeCompare(right.id));
}
