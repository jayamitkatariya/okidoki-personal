import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { ASTER_BASE_URL, ASTER_PROVIDER, CREDENTIAL_METHOD, readOllamaAuthEnv, readOpenAICompatibleAuthEnv, type ThinkingLevel } from '@okidoki/shared';
import { isOpenCodeZenModel, OPENCODE_GO_PROVIDER, OPENCODE_ZEN_PROVIDER } from '@okidoki/shared/opencode-go';
import type { Config as OpencodeConfig, OpencodeClient } from '@opencode-ai/sdk/v2';
import { OPENCODE_AUTH_PATH } from './agent-auth-paths';
import { thinkingVariant } from '../utils/thinking-variant';

const OPENCODE_WORKSPACE_PERMISSION = 'allow' satisfies NonNullable<OpencodeConfig['permission']>;
// BaseTen rejects normal agent requests as too long, and OpenRouter doesn't fall back on that error.
const OPENROUTER_IGNORED_PROVIDERS = ['baseten'];

// The v2 model list leaves `variants` empty; the config provider list carries them.
export async function fetchOpencodeModelVariants(client: OpencodeClient, directory: string, provider: string): Promise<Map<string, Set<string>>> {
  const result = await client.config.providers({ directory }, { throwOnError: true });
  const models = result.data.providers.find((candidate) => candidate.id === provider)?.models ?? {};
  return new Map(Object.entries(models).map(([id, model]) => [id, new Set(Object.keys(model.variants ?? {}))]));
}

export function opencodeThinkingVariant(variants: ReadonlySet<string> | undefined, thinkingLevel: ThinkingLevel | undefined): string | undefined {
  return thinkingVariant(variants, thinkingLevel);
}

const opencodeAuthSchema = z.record(z.string(), z.object({
  type: z.string().optional(),
  key: z.string().optional(),
}));
export async function hasOpencodeCredentials(provider: string): Promise<boolean> {
  if (provider === 'ollama') return !!readOllamaAuthEnv('opencode', process.env);
  if (provider === CREDENTIAL_METHOD.OPENAI_COMPATIBLE) return !!readOpenAICompatibleAuthEnv('opencode', process.env);
  if (!existsSync(OPENCODE_AUTH_PATH)) return false;
  try {
    const auth = opencodeAuthSchema.safeParse(JSON.parse(await readFile(OPENCODE_AUTH_PATH, 'utf8')));
    return auth.success
      && auth.data[provider]?.type === 'api'
      && Boolean(auth.data[provider]?.key);
  } catch {
    return false;
  }
}

export async function getOpencodeProvider(): Promise<string> {
  if (readOllamaAuthEnv('opencode', process.env)) return 'ollama';
  if (readOpenAICompatibleAuthEnv('opencode', process.env)) return CREDENTIAL_METHOD.OPENAI_COMPATIBLE;
  if (await hasOpencodeCredentials(OPENCODE_GO_PROVIDER)) return OPENCODE_GO_PROVIDER;
  if (await hasOpencodeCredentials(ASTER_PROVIDER)) return ASTER_PROVIDER;
  return 'openrouter';
}

export function getOpenCodeGoModel(model: string): string {
  return isOpenCodeZenModel(model) ? model : model.replace(/^[^/]+\//, '');
}

export function opencodeModelRef(provider: string, model: string): { providerID: string; modelID: string } {
  if (provider !== OPENCODE_GO_PROVIDER) return { providerID: provider, modelID: model };
  return isOpenCodeZenModel(model)
    ? { providerID: OPENCODE_ZEN_PROVIDER, modelID: model.slice(OPENCODE_ZEN_PROVIDER.length + 1) }
    : { providerID: OPENCODE_GO_PROVIDER, modelID: getOpenCodeGoModel(model) };
}

export function opencodeConfig(provider: string, model: string, providerModels: readonly string[] = [model]): OpencodeConfig {
  let config: OpencodeConfig;
  if (provider === OPENCODE_GO_PROVIDER) {
    const { providerID, modelID } = opencodeModelRef(provider, model);
    config = {
      // Without a key OpenCode's own provider serves only its free Zen models.
      enabled_providers: [OPENCODE_GO_PROVIDER, OPENCODE_ZEN_PROVIDER],
      model: `${providerID}/${modelID}`,
      provider: {
        [OPENCODE_GO_PROVIDER]: {
          models: Object.fromEntries(providerModels.filter((candidate) => !isOpenCodeZenModel(candidate)).map((candidate) => [candidate, {}])),
        },
      },
      permission: OPENCODE_WORKSPACE_PERMISSION,
      share: 'disabled',
    };
  } else if (provider === ASTER_PROVIDER || provider === 'ollama' || provider === CREDENTIAL_METHOD.OPENAI_COMPATIBLE) {
    const ollama = provider === 'ollama' ? readOllamaAuthEnv('opencode', process.env) : null;
    const compatible = provider === CREDENTIAL_METHOD.OPENAI_COMPATIBLE ? readOpenAICompatibleAuthEnv('opencode', process.env) : null;
    config = {
      enabled_providers: [provider],
      model: `${provider}/${model}`,
      provider: {
        [provider]: {
          // Responses API: OpenAI models reject function tools with reasoning on Chat Completions.
          npm: compatible ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
          name: ollama ? 'Ollama' : compatible ? 'OpenAI-compatible endpoint' : 'Aster',
          options: ollama
            ? { baseURL: `${ollama.baseUrl}/v1`, apiKey: ollama.apiKey }
            : compatible
              ? {
                  baseURL: compatible.baseUrl,
                  // The SDK refuses to start without a key; an exact Authorization header replaces the bearer it builds.
                  apiKey: compatible.apiKey ?? 'unused',
                  ...(compatible.authorizationHeader ? { headers: { Authorization: compatible.authorizationHeader } } : {}),
                }
              : { baseURL: ASTER_BASE_URL },
          models: Object.fromEntries(providerModels.map((candidate) => [candidate, {}])),
        },
      },
      permission: OPENCODE_WORKSPACE_PERMISSION,
      share: 'disabled',
    };
  } else {
    config = {
      enabled_providers: ['openrouter'],
      model: `openrouter/${model}`,
      provider: {
        openrouter: {
          options: { extraBody: { provider: { ignore: OPENROUTER_IGNORED_PROVIDERS } } },
          models: Object.fromEntries(providerModels.map((candidate) => [candidate, {}])),
        },
      },
      permission: OPENCODE_WORKSPACE_PERMISSION,
      share: 'disabled',
    };
  }
  // The blanket allow above would hand subagents the question tool, but only the chat's own session can reach the user.
  config.experimental = { primary_tools: ['question'] };
  return config;
}

