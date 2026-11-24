import type { ModelCost } from '@earendil-works/pi-ai';

export const GPT_6_2_SOL_MODEL = 'gpt-6.2-sol';
export const GPT_6_1_SOL_MODEL = 'gpt-6.1-sol';
export const GPT_6_1_TERRA_MODEL = 'gpt-6.1-terra';
export const GPT_6_2_ASTRA_MODEL = 'gpt-6.2-astra';
export const CLAUDE_OPUS_5_5_MODEL = 'claude-opus-5-5';
export const CLAUDE_FABLE_5_2_MODEL = 'claude-fable-5-2';
export const DEEPSEEK_V4_1_FLASH_MODEL = 'deepseek-v4.1-flash';
export const GEMINI_4_NEON_MODEL = 'gemini-4-neon';

/** Who serves a model. Customers never see it: Baseten runs open models on our key only. */
export const OKIDOKI_MODEL_PROVIDERS = ['openai', 'anthropic', 'baseten', 'google-vertex'] as const;
export type OkidokiModelProvider = (typeof OKIDOKI_MODEL_PROVIDERS)[number];
export const OKIDOKI_KEY_ONLY_PROVIDERS: readonly OkidokiModelProvider[] = ['baseten', 'google-vertex'];
/** The environment variable holding our own key for each provider, set on the monolith's task, which the harness worker's inherits. */
export const OKIDOKI_KEY_ENV: Record<OkidokiModelProvider, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', baseten: 'BASETEN_API_KEY', 'google-vertex': 'GOOGLE_VERTEX_CREDENTIALS' };

interface OkidokiCatalogModel {
  label: string;
  provider: OkidokiModelProvider;
  /** USD per million tokens. A tier prices the whole request once its prompt, cache reads and writes included, passes `inputTokensAbove`. */
  cost: ModelCost;
  /** Changes whenever `cost` does, so a recorded call can name the prices it was charged at. */
  priceVersion: string;
}

/**
 * Cache writes use Anthropic's 5-minute and OpenAI's 30-minute rates; pi-ai prices Anthropic's 1-hour writes at 2x input.
 * Sources: https://developers.openai.com/api/docs/pricing and https://platform.claude.com/docs/en/about-claude/pricing.
 */
export const OKIDOKI_MODEL_CATALOG = {
  [GPT_6_2_SOL_MODEL]: {
    label: 'GPT-6.2 Sol',
    provider: 'openai',
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
    priceVersion: '2026-11-19',
  },
  [GPT_6_1_SOL_MODEL]: {
    label: 'GPT-6.1 Sol',
    provider: 'openai',
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
    priceVersion: '2026-11-19',
  },
  [GPT_6_1_TERRA_MODEL]: {
    label: 'GPT-6.1 Terra',
    provider: 'openai',
    cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] },
    priceVersion: '2026-11-19',
  },
  [GPT_6_2_ASTRA_MODEL]: {
    label: 'GPT-6.2 Astra',
    provider: 'openai',
    cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] },
    priceVersion: '2026-11-19',
  },
  [CLAUDE_OPUS_5_5_MODEL]: {
    label: 'Opus 5.5',
    provider: 'anthropic',
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    priceVersion: '2026-11-19',
  },
  [CLAUDE_FABLE_5_2_MODEL]: {
    label: 'Fable 5.2',
    provider: 'anthropic',
    cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
    priceVersion: '2026-11-19',
  },
  // Baseten's standard endpoint (https://www.baseten.co/pricing, also in its /v1/models), which charges no cache writes.
  [DEEPSEEK_V4_1_FLASH_MODEL]: {
    label: 'DeepSeek V4.1 Flash',
    provider: 'baseten',
    cost: { input: 0.3, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
    priceVersion: '2026-11-21',
  },
  // https://cloud.google.com/vertex-ai/generative-ai/pricing. Caching is implicit and its writes are free.
  [GEMINI_4_NEON_MODEL]: {
    label: 'Gemini 4 Neon',
    provider: 'google-vertex',
    cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
    priceVersion: '2026-11-21',
  },
} as const satisfies Record<string, OkidokiCatalogModel>;

export type OkidokiModelId = keyof typeof OKIDOKI_MODEL_CATALOG;

const CATALOG_IDS = Object.keys(OKIDOKI_MODEL_CATALOG).filter(isOkidokiModel);

export const OKIDOKI_MODELS: Record<OkidokiModelProvider, readonly OkidokiModelId[]> = {
  openai: CATALOG_IDS.filter((id) => OKIDOKI_MODEL_CATALOG[id].provider === 'openai'),
  anthropic: CATALOG_IDS.filter((id) => OKIDOKI_MODEL_CATALOG[id].provider === 'anthropic'),
  baseten: CATALOG_IDS.filter((id) => OKIDOKI_MODEL_CATALOG[id].provider === 'baseten'),
  'google-vertex': CATALOG_IDS.filter((id) => OKIDOKI_MODEL_CATALOG[id].provider === 'google-vertex'),
};

export function isOkidokiModel(model: string): model is OkidokiModelId {
  return Object.hasOwn(OKIDOKI_MODEL_CATALOG, model);
}

export function okidokiModelLabel(model: string): string {
  return isOkidokiModel(model) ? OKIDOKI_MODEL_CATALOG[model].label : model;
}

// Models Okidoki chats used to offer, so chats, automations and settings saved on one keep running on the nearest model offered now.
const RETIRED_OKIDOKI_MODELS: Record<string, OkidokiModelId> = {
  'claude-sonnet-5-5': CLAUDE_OPUS_5_5_MODEL,
  'claude-haiku-5-5': CLAUDE_OPUS_5_5_MODEL,
  'gpt-6-sol': GPT_6_1_SOL_MODEL,
  'gpt-6-astra': GPT_6_2_ASTRA_MODEL,
  'gpt-6-luna': GPT_6_1_TERRA_MODEL,
  'gpt-5.6-sol': GPT_6_1_SOL_MODEL,
  'gpt-5.6-terra': GPT_6_1_TERRA_MODEL,
  'gpt-5.6-luna': GPT_6_1_TERRA_MODEL,
  'gpt-5.5': GPT_6_1_SOL_MODEL,
  'gpt-5.4': GPT_6_1_SOL_MODEL,
  'gpt-5.4-mini': GPT_6_1_TERRA_MODEL,
  'gpt-5.2': GPT_6_1_SOL_MODEL,
};

export function okidokiChatModel(model: string): string;
export function okidokiChatModel(model: string | undefined): string | undefined;
export function okidokiChatModel(model: string | undefined): string | undefined {
  return (model && RETIRED_OKIDOKI_MODELS[model]) || model;
}

export function okidokiModelProvider(model: string | undefined): OkidokiModelProvider {
  const current = okidokiChatModel(model);
  return current && isOkidokiModel(current) ? OKIDOKI_MODEL_CATALOG[current].provider : 'openai';
}
