import { createErrorResult, createSuccessResult, type Result } from '../result';
import { isRecord } from '../type-guards';
import { validateExternalApiHost } from '../external-api-host';
import type { ModelCatalogItem } from '../routes/model-catalog';
import type { OpenAICompatibleCredentials, OpenAICompatibleCredentialValues } from './types';

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

const CONTEXT_WINDOW_KEYS = new Set([
  'context_window',
  'context_length',
  'contextWindow',
  'contextLength',
  'max_context_length',
  'maxContextLength',
]);

const MAX_CATALOG_PAGES = 20;

function getModelContextWindow(model: Record<string, unknown>): number | null {
  const directValues = Object.entries(model).flatMap(([key, value]) => {
    const contextWindow = CONTEXT_WINDOW_KEYS.has(key) ? positiveInteger(value) : null;
    return contextWindow === null ? [] : [contextWindow];
  });
  if (directValues.length > 0) return Math.max(...directValues);

  const values: number[] = [];
  const pending: unknown[] = Object.entries(model)
    .filter(([key]) => !CONTEXT_WINDOW_KEYS.has(key))
    .map(([, value]) => value);
  for (let inspected = 0; pending.length > 0 && inspected < 1_000; inspected += 1) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    if (current.availability_status !== undefined && current.availability_status !== 'available') continue;
    for (const [key, value] of Object.entries(current)) {
      if (CONTEXT_WINDOW_KEYS.has(key)) {
        const contextWindow = positiveInteger(value);
        if (contextWindow !== null) values.push(contextWindow);
      } else if (Array.isArray(value) || isRecord(value)) {
        pending.push(value);
      }
    }
  }
  return values.length > 0 ? Math.max(...values) : null;
}

export function parseOpenAICompatibleModels(payload: unknown): ModelCatalogItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('The models endpoint returned an invalid catalog');
  }

  return [...new Map(payload.data.flatMap((value): [string, ModelCatalogItem][] => {
    if (!isRecord(value) || (value.availability_status !== undefined && value.availability_status !== 'available')) {
      return [];
    }
    const id = typeof value.id === 'string' ? value.id : typeof value.model === 'string' ? value.model : null;
    if (!id) return [];
    const displayName = typeof value.display_name === 'string'
      ? value.display_name
      : typeof value.name === 'string'
        ? value.name
        : id;
    const contextWindow = getModelContextWindow(value);
    return [[id, {
      id,
      displayName,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(contextWindow !== null ? { contextWindow } : {}),
    }]];
  })).values()];
}

export async function listOpenAICompatibleModels(
  credential: Pick<OpenAICompatibleCredentials, 'apiKey' | 'baseUrl' | 'modelsUrl' | 'authorizationHeader'>,
): Promise<ModelCatalogItem[]> {
  const models = new Map<string, ModelCatalogItem>();
  const signal = AbortSignal.timeout(10_000);
  let modelsUrl = resolveOpenAICompatibleModelsUrl({
    baseUrl: credential.baseUrl ?? '',
    modelsUrl: credential.modelsUrl ?? '',
  });

  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    validateExternalApiHost(modelsUrl, 'Models endpoint');
    const response = await fetch(modelsUrl, {
      headers: { Accept: 'application/json', Authorization: credential.authorizationHeader || `Bearer ${credential.apiKey}` },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error(`Models request failed with status ${response.status}`);

    const payload: unknown = await response.json();
    for (const model of parseOpenAICompatibleModels(payload)) models.set(model.id, model);
    if (!isRecord(payload) || payload.has_more !== true) break;
    if (page === MAX_CATALOG_PAGES - 1) throw new Error(`The models endpoint exceeded ${MAX_CATALOG_PAGES} pages`);
    if (typeof payload.next_cursor !== 'string' || !payload.next_cursor) {
      throw new Error('The models endpoint did not return a cursor for the next page');
    }
    const nextUrl = new URL(modelsUrl);
    nextUrl.searchParams.set('cursor', payload.next_cursor);
    modelsUrl = nextUrl.toString();
  }

  if (models.size === 0) throw new Error('The models endpoint returned no available models');
  return [...models.values()];
}

export function hasOpenAICompatibleCredential(values: OpenAICompatibleCredentialValues): boolean {
  return !!values.baseUrl.trim() && (!!values.apiKey.trim() || !!values.authorizationHeader.trim());
}

export function normalizeOpenAICompatibleCredential(
  values: OpenAICompatibleCredentialValues,
  options: { hasStoredAuthorizationHeader?: boolean } = {},
): Result<OpenAICompatibleCredentialValues> {
  const apiKey = values.apiKey.trim();
  const baseUrl = values.baseUrl.trim().replace(/\/+$/, '');
  const modelsUrl = values.modelsUrl.trim().replace(/\/+$/, '');
  const authorizationHeader = values.authorizationHeader.trim();

  if (!apiKey && !authorizationHeader && !options.hasStoredAuthorizationHeader) {
    return createErrorResult({ message: 'API key or authorization header is required' });
  }
  if (!baseUrl) {
    return createErrorResult({ message: 'Endpoint URL is required' });
  }
  if (/\r|\n/.test(authorizationHeader)) {
    return createErrorResult({ message: 'Authorization header must be a single line' });
  }
  try {
    if (new URL(baseUrl).protocol !== 'https:') throw new Error();
  } catch {
    return createErrorResult({ message: 'Endpoint URL must be a valid HTTPS URL' });
  }

  if (modelsUrl) {
    try {
      if (new URL(modelsUrl).protocol !== 'https:') throw new Error();
    } catch {
      return createErrorResult({ message: 'Models endpoint must be a valid HTTPS URL' });
    }
  }

  return createSuccessResult({ apiKey, baseUrl, modelsUrl, authorizationHeader });
}

export function resolveOpenAICompatibleModelsUrl(
  values: Pick<OpenAICompatibleCredentialValues, 'baseUrl' | 'modelsUrl'>,
): string {
  return values.modelsUrl || `${values.baseUrl}/models`;
}

/** Codex reads its own `CODEX_OPENAI_*` env; these harnesses get a per-agent copy so switching one never rewires another. */
export type OpenAICompatibleEnvAgent = 'opencode' | 'pi';

const OPENAI_COMPATIBLE_ENV_FIELDS = ['apiKey', 'baseUrl', 'modelsUrl', 'authorizationHeader'] as const;

export function openAICompatibleAuthEnvKeys(agent: OpenAICompatibleEnvAgent): string[] {
  return ['API_KEY', 'BASE_URL', 'MODELS_URL', 'AUTHORIZATION_HEADER'].map((key) => `OKIDOKI_${agent.toUpperCase()}_OPENAI_COMPATIBLE_${key}`);
}

export function openAICompatibleAuthEnv(agent: OpenAICompatibleEnvAgent, credential: OpenAICompatibleCredentials): Record<string, string> {
  const keys = openAICompatibleAuthEnvKeys(agent);
  return Object.fromEntries(OPENAI_COMPATIBLE_ENV_FIELDS.flatMap((field, index) => {
    const value = credential[field];
    return value ? [[keys[index], value]] : [];
  }));
}

export function readOpenAICompatibleAuthEnv(agent: OpenAICompatibleEnvAgent, env: Record<string, string | undefined>): OpenAICompatibleCredentials | null {
  const [apiKey, baseUrl, modelsUrl, authorizationHeader] = openAICompatibleAuthEnvKeys(agent).map((key) => env[key] || undefined);
  return baseUrl && (apiKey || authorizationHeader) ? { apiKey, baseUrl, modelsUrl, authorizationHeader } : null;
}
