import { readOllamaAuthEnv, listOllamaModels, listOpenAICompatibleModels, resolveOpenAICompatibleModelsUrl } from '@okidoki/shared';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_ENV } from '../../engine-env';
import { execFileAsync, SUBPROCESS_MAX_BUFFER } from '../../utils/exec';
import { isRecord } from '../../utils/type-guards';

const CATALOG_TTL_MS = 60_000;
const CODEX_MODEL_CATALOG_PATH = join(tmpdir(), 'okidoki-openai-compatible-model-catalog.json');

let cachedCatalog: { key: string; expiresAt: number; config: Promise<string[]> } | null = null;

async function writeCodexModelCatalog(modelsUrl: string): Promise<string[]> {
  const ollama = ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD === 'ollama' ? readOllamaAuthEnv('codex', process.env) : null;
  const [models, { stdout }] = await Promise.all([
    ollama ? listOllamaModels(ollama) : listOpenAICompatibleModels({
      apiKey: ENGINE_ENV.OPENAI_API_KEY,
      authorizationHeader: ENGINE_ENV.CODEX_OPENAI_AUTHORIZATION_HEADER,
      baseUrl: ENGINE_ENV.CODEX_OPENAI_BASE_URL ?? '',
      modelsUrl,
    }),
    execFileAsync('codex', ['debug', 'models'], { maxBuffer: SUBPROCESS_MAX_BUFFER }),
  ]);
  const payload: unknown = JSON.parse(stdout);
  // Responses Lite and code mode are OpenAI-only: compatible endpoints reject the request or the tool calls.
  const template = isRecord(payload) && Array.isArray(payload.models)
    ? payload.models.find((model) => isRecord(model) && !model.use_responses_lite && !model.tool_mode)
    : null;
  if (!isRecord(template)) throw new Error('Codex did not return a model catalog template');

  const catalog = models.flatMap((model) => model.contextWindow ? [{
    ...template,
    // The template's freeform apply_patch, verbosity and tool search are OpenAI-only; other models reject the request.
    apply_patch_tool_type: null,
    support_verbosity: false,
    supports_search_tool: false,
    ...(ollama ? { input_modalities: ['text'] } : {}),
    slug: model.id,
    display_name: model.displayName,
    description: model.description ?? model.displayName,
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 100,
    auto_compact_token_limit: Math.floor(model.contextWindow * 0.9),
  }] : []);
  // Codex refuses to start on an empty catalog, but runs fine on its defaults without one.
  if (catalog.length === 0) throw new Error('The models endpoint reported no context windows');
  await writeFile(CODEX_MODEL_CATALOG_PATH, JSON.stringify({ models: catalog }));
  return [
    `model_catalog_json=${JSON.stringify(CODEX_MODEL_CATALOG_PATH)}`,
    'features.remote_models=false',
  ];
}

export async function getOpenAICompatibleCodexModelCatalogConfig(): Promise<string[]> {
  if ((ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD !== 'openai-compatible' && ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD !== 'ollama') || !ENGINE_ENV.CODEX_OPENAI_BASE_URL) return [];

  const modelsUrl = resolveOpenAICompatibleModelsUrl({
    baseUrl: ENGINE_ENV.CODEX_OPENAI_BASE_URL,
    modelsUrl: ENGINE_ENV.CODEX_OPENAI_MODELS_URL ?? '',
  });
  const key = `${modelsUrl}:${JSON.stringify(ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex ?? null)}`;
  if (!cachedCatalog || cachedCatalog.key !== key || cachedCatalog.expiresAt <= Date.now()) {
    cachedCatalog = {
      key,
      expiresAt: Date.now() + CATALOG_TTL_MS,
      config: writeCodexModelCatalog(modelsUrl).catch((error) => {
        console.warn('[CodexAspManager] Failed to prepare OpenAI-compatible model catalog:', error);
        return [];
      }),
    };
  }
  return cachedCatalog.config;
}
