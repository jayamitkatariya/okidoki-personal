// engine types should be split in multiple files
// right now there just isn't enough types but if we ever end up adding
// a lot more, it is worth reorganizing. right now types.ts vs v1.ts isn't super clear.

import { z } from 'zod';
import type { WorkspaceStatus } from '../routes/workspaces';
import type { UserPreferences } from '../routes/preferences';
import type { AgentProvider, EngineAgentProvider } from '../agent';
import type { CoAuthorInfo } from '../prompts';
import { ASTER_MODELS, ASTER_MODEL_LABELS } from '../aster';
import { DEFAULT_OPENCODE_GO_MODEL, isOpenCodeZenModel } from '../credentials/opencode-go';
import type { EngineEnvironmentDetails } from './environment';
import type { ChatSummary, EngineRepoDiff, EngineRepoState } from './v1';
import { getChatKind } from '../chat-kind';
import { GPT_6_2_SOL_MODEL, GPT_6_1_SOL_MODEL, GPT_6_1_TERRA_MODEL, GPT_6_2_ASTRA_MODEL, CLAUDE_OPUS_5_5_MODEL, CLAUDE_FABLE_5_2_MODEL, OKIDOKI_MODEL_CATALOG, OKIDOKI_MODELS, okidokiChatModel } from '../harness/models';
import { isPullRequestReviewChat } from '../routes/reviews';
import { isRecord } from '../type-guards';
import { detectLanguageByPath } from '../languages';

export { GPT_6_2_SOL_MODEL, GPT_6_1_SOL_MODEL, GPT_6_1_TERRA_MODEL, GPT_6_2_ASTRA_MODEL, CLAUDE_OPUS_5_5_MODEL, CLAUDE_FABLE_5_2_MODEL } from '../harness/models';

export const DEFAULT_CHAT_TITLES = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  muse: 'Muse Code',
  opencode: 'Opencode',
  pi: 'Pi',
  okidoki: 'Okidoki',
} as const;

export function isDefaultChat(chat: Pick<ChatSummary, 'provider' | 'title'>): boolean {
  return chat.title === DEFAULT_CHAT_TITLES[chat.provider];
}

export function hasGeneratedChatTitle(chat: Pick<ChatSummary, 'provider' | 'title'>): boolean {
  return chat.title.replace(/ \d+$/, '') === DEFAULT_CHAT_TITLES[chat.provider] || chat.title === `${chat.provider} chat`;
}

export function getPullRequestFeedbackChatTitle(codeHost: 'github' | 'gitlab', number: number): string {
  return codeHost === 'gitlab' ? `MR !${number} fixes` : `PR #${number} fixes`;
}

export function isPullRequestFeedbackChat(chat: Pick<ChatSummary, 'title' | 'kind'>): boolean {
  return getChatKind(chat) === 'pull_request_fixes';
}

// ISO timestamps sort the same by code unit; Hermes on Android runs localeCompare through Java's Collator, which is slow.
export const newestChatFirst = (a: Pick<ChatSummary, 'updatedAt'>, b: Pick<ChatSummary, 'updatedAt'>) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export function isPullRequestSideChat(chat: Pick<ChatSummary, 'title' | 'kind'>): boolean {
  return isPullRequestFeedbackChat(chat) || isPullRequestReviewChat(chat);
}

/** Select the best initial chat: prefer the preferred provider's most active chat, fall back to the other provider. */
export function getInitialChatId(
  chats: Pick<ChatSummary, 'id' | 'provider' | 'title' | 'createdAt' | 'updatedAt' | 'kind' | 'parentChatId'>[],
  preferredProvider: AgentProvider = 'claude',
): string | null {
  const rootChats = chats.filter((chat) => !chat.parentChatId);

  const hasActivity = (c: typeof chats[number]) => c.updatedAt > c.createdAt;
  const mostActive = (list: typeof chats) =>
    list.filter(hasActivity).sort(newestChatFirst)[0] ?? null;

  // Bots and reviewers keep PR feedback and review chats the most recently active, which would otherwise pull users away from the main chat.
  const mainChats = rootChats.filter((c) => !isPullRequestSideChat(c));
  const preferred = mainChats.filter((c) => c.provider === preferredProvider);
  const others = mainChats.filter((c) => c.provider !== preferredProvider);

  return (
    mostActive(preferred)?.id ??
    mostActive(others)?.id ??
    preferred.find(isDefaultChat)?.id ??
    others.find(isDefaultChat)?.id ??
    rootChats[0]?.id ??
    null
  );
}

export const CLAUDE_OPUS_1M_MODEL = 'opus[1m]';
export const LEGACY_CLAUDE_OPUS_1M_MODEL = 'opus-1m';
export const CLAUDE_FABLE_5_1_MODEL = 'claude-fable-5-1';
export const CLAUDE_FABLE_5_MODEL = 'claude-fable-5';
export const CLAUDE_OPUS_5_MODEL = 'claude-opus-5';
export const CLAUDE_OPUS_4_8_MODEL = 'claude-opus-4-8';
export const CLAUDE_SONNET_5_5_MODEL = 'claude-sonnet-5-5';
export const CLAUDE_SONNET_5_MODEL = 'claude-sonnet-5';
export const CLAUDE_HAIKU_5_5_MODEL = 'claude-haiku-5-5';
export const CLAUDE_HAIKU_4_5_MODEL = 'claude-haiku-4-5';
export const DEFAULT_CLAUDE_MODEL = CLAUDE_OPUS_5_5_MODEL;
export const GPT_6_ASTRA_MODEL = 'gpt-6-astra';
export const GPT_6_SOL_MODEL = 'gpt-6-sol';
export const GPT_6_LUNA_MODEL = 'gpt-6-luna';
export const GPT_5_6_SOL_MODEL = 'gpt-5.6-sol';
export const GPT_5_6_TERRA_MODEL = 'gpt-5.6-terra';
export const GPT_5_6_LUNA_MODEL = 'gpt-5.6-luna';
export const DEFAULT_CODEX_MODEL = GPT_6_1_SOL_MODEL;
export const DEFAULT_CURSOR_MODEL = 'composer-2.5';
export const DEFAULT_OPENCODE_MODEL = 'z-ai/glm-5.3';
export const GLM_5_3_FLASH_MODEL = 'z-ai/glm-5.3-flash';
const DEEPSEEK_V4_PRO_MODEL = 'deepseek/deepseek-v4-pro-0813';
const DEEPSEEK_V4_FLASH_MODEL = 'deepseek/deepseek-v4-flash-0731';
export const MUSE_WONDER_1_0_MODEL = 'muse-wonder-1.0';
export const MUSE_SPARK_1_3_MODEL = 'muse-spark-1.3';
export const DEFAULT_MUSE_MODEL = 'muse-spark-1.2';
export const DEFAULT_PI_MODEL = DEFAULT_OPENCODE_MODEL;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_OPENROUTER_MODELS: string[] = [
  DEFAULT_OPENCODE_MODEL,
  DEEPSEEK_V4_PRO_MODEL,
  'moonshotai/kimi-k3',
  'google/gemini-3.8-flash',
];
export const OPENROUTER_MODELS: string[] = [
  ...DEFAULT_OPENROUTER_MODELS,
  GLM_5_3_FLASH_MODEL,
  'minimax/minimax-m3',
  'meta/muse-spark-1.3',
  'qwen/qwen4-max',
];

export type AgentModelOverrides = Partial<Record<AgentProvider, readonly string[] | null>> & {
  defaultModels?: Partial<Record<AgentProvider, string | null>>;
};

export type AgentModelVisibilityPreferences = Partial<Pick<
  UserPreferences,
  | 'claude_models' | 'codex_models' | 'cursor_models'
  | 'claude_hidden_models' | 'codex_hidden_models' | 'cursor_hidden_models'
>>;

export type AgentModelVisibility = Record<'claude' | 'codex' | 'cursor', string[]>;

const FALLBACK_AGENT_MODEL: Record<AgentProvider, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: DEFAULT_CODEX_MODEL,
  cursor: DEFAULT_CURSOR_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  muse: DEFAULT_MUSE_MODEL,
  opencode: DEFAULT_OPENCODE_MODEL,
  pi: DEFAULT_PI_MODEL,
  okidoki: DEFAULT_CODEX_MODEL,
};

// List order is display order, not preference: the provider's default wins unless an org hid it.
export function getDefaultAgentModel(
  provider: AgentProvider,
  overrides?: AgentModelOverrides,
): string {
  const catalogDefault = overrides?.defaultModels?.[provider];
  if (catalogDefault === null) return '';
  const options = getAgentModelOptions(provider, overrides);
  if (catalogDefault && options.includes(catalogDefault)) return catalogDefault;
  const fallback = FALLBACK_AGENT_MODEL[provider];
  return options.includes(fallback) ? fallback : options[0] ?? '';
}

export function normalizeClaudeModel(model: string | undefined): string | undefined {
  if (model === 'opus' || model === CLAUDE_OPUS_1M_MODEL || model === LEGACY_CLAUDE_OPUS_1M_MODEL) {
    return DEFAULT_CLAUDE_MODEL;
  }
  if (model === 'fable') {
    return CLAUDE_FABLE_5_1_MODEL;
  }
  if (model === 'sonnet') {
    return CLAUDE_SONNET_5_MODEL;
  }
  if (model === 'haiku') {
    return CLAUDE_HAIKU_4_5_MODEL;
  }
  return model;
}

export const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  [CLAUDE_FABLE_5_2_MODEL]: 1_000_000,
  [CLAUDE_FABLE_5_1_MODEL]: 1_000_000,
  [CLAUDE_FABLE_5_MODEL]: 1_000_000,
  [CLAUDE_OPUS_5_5_MODEL]: 1_000_000,
  [CLAUDE_OPUS_5_MODEL]: 1_000_000,
  [CLAUDE_OPUS_4_8_MODEL]: 1_000_000,
  [CLAUDE_SONNET_5_5_MODEL]: 1_000_000,
  [CLAUDE_SONNET_5_MODEL]: 1_000_000,
  [CLAUDE_HAIKU_5_5_MODEL]: 1_000_000,
  [CLAUDE_HAIKU_4_5_MODEL]: 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-haiku-4-5@20251001': 200_000,
};

export function getClaudeModelContextWindow(model: string | null | undefined): number | null {
  if (!model) return null;
  const firstParty = model.replace(/^(?:[a-z-]+\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '');
  const normalized = normalizeClaudeModel(firstParty) ?? firstParty;
  return CLAUDE_MODEL_CONTEXT_WINDOWS[normalized] ?? CLAUDE_MODEL_CONTEXT_WINDOWS[firstParty] ?? null;
}

export function canUseClaudeFastMode(model: string | undefined): boolean {
  const normalized = normalizeClaudeModel(model);
  return normalized === CLAUDE_OPUS_5_5_MODEL || normalized === CLAUDE_OPUS_5_MODEL || normalized === CLAUDE_OPUS_4_8_MODEL || model === 'claude-opus-4-7';
}

// `null` is reserved for models every live image already ran when gating began (pinned by a test). Key order is picker display order.
export const CLAUDE_MODEL_MIN_SANDBOX_IMAGE: Record<string, string | null> = {
  [CLAUDE_FABLE_5_2_MODEL]: 'okidoki-sandbox-2026-11-09-v5',
  [CLAUDE_FABLE_5_1_MODEL]: 'okidoki-sandbox-2026-09-01-v6',
  [CLAUDE_FABLE_5_MODEL]: null,
  [CLAUDE_OPUS_5_5_MODEL]: 'okidoki-sandbox-2026-09-22-v4',
  [CLAUDE_OPUS_5_MODEL]: null,
  [CLAUDE_OPUS_4_8_MODEL]: null,
  [CLAUDE_SONNET_5_5_MODEL]: 'okidoki-sandbox-2026-09-28-v7',
  [CLAUDE_SONNET_5_MODEL]: null,
  [CLAUDE_HAIKU_5_5_MODEL]: 'okidoki-sandbox-2026-10-08-v4',
  [CLAUDE_HAIKU_4_5_MODEL]: null,
};
export const CODEX_MODEL_MIN_SANDBOX_IMAGE: Record<string, string | null> = {
  [GPT_6_2_SOL_MODEL]: 'okidoki-sandbox-2026-11-17-v12',
  [DEFAULT_CODEX_MODEL]: 'okidoki-sandbox-2026-09-30-v11',
  [GPT_6_1_TERRA_MODEL]: 'okidoki-sandbox-2026-11-10-v7',
  [GPT_6_2_ASTRA_MODEL]: 'okidoki-sandbox-2026-11-17-v12',
  [GPT_6_SOL_MODEL]: 'okidoki-sandbox-2026-09-24-v1',
  [GPT_6_ASTRA_MODEL]: 'okidoki-sandbox-2026-09-04-v7',
  [GPT_6_LUNA_MODEL]: 'okidoki-sandbox-2026-09-24-v1',
  [GPT_5_6_SOL_MODEL]: null,
  [GPT_5_6_TERRA_MODEL]: null,
  [GPT_5_6_LUNA_MODEL]: null,
  'gpt-5.5': null,
  'gpt-5.4': null,
  'gpt-5.4-mini': null,
  'gpt-5.2': null,
};

export const AGENT_MODELS: Record<AgentProvider, string[]> = {
  claude: Object.keys(CLAUDE_MODEL_MIN_SANDBOX_IMAGE),
  codex: Object.keys(CODEX_MODEL_MIN_SANDBOX_IMAGE),
  okidoki: Object.values(OKIDOKI_MODELS).flat(),
  cursor: [
    CLAUDE_FABLE_5_1_MODEL,
    CLAUDE_FABLE_5_MODEL,
    CLAUDE_OPUS_5_5_MODEL,
    CLAUDE_OPUS_5_MODEL,
    CLAUDE_OPUS_4_8_MODEL,
    GPT_5_6_SOL_MODEL,
    GPT_5_6_TERRA_MODEL,
    GPT_5_6_LUNA_MODEL,
    'gpt-5.5',
    'composer-2.5',
    CLAUDE_SONNET_5_5_MODEL,
    CLAUDE_SONNET_5_MODEL,
    'claude-opus-4-7',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5-mini',
    'gemini-3.8-flash',
    'gemini-3.1-pro',
    'gemini-3-flash',
    'grok-4.7',
    'grok-4.6',
    'grok-4.5',
    'grok-4.3',
    CLAUDE_HAIKU_4_5_MODEL,
    'kimi-k2.5',
  ],
  // Every plan has Gemini 3.8 Flash; Google AI Pro and Ultra add the Gemini 4 and Claude 5.5 models (antigravity.google/pricing).
  gemini: [
    DEFAULT_GEMINI_MODEL,
    'gemini-4-neon',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-hydrogen',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator-g1-pro',
    CLAUDE_OPUS_5_5_MODEL,
    CLAUDE_SONNET_5_5_MODEL,
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
  ],
  muse: [MUSE_WONDER_1_0_MODEL, MUSE_SPARK_1_3_MODEL, DEFAULT_MUSE_MODEL],
  opencode: [...DEFAULT_OPENROUTER_MODELS, ...ASTER_MODELS],
  pi: [...DEFAULT_OPENROUTER_MODELS, ...ASTER_MODELS],
};

export type StaticAgentModelProvider = 'claude' | 'codex';

// Saved lists add to the defaults and hidden lists subtract from them, so newly shipped
// defaults reach every organization without a preference migration.
// Older models stay supported, so orgs can add them back; they just leave the default pickers.
const HIDDEN_BY_DEFAULT_MODELS = new Set<string>([
  CLAUDE_FABLE_5_MODEL,
  CLAUDE_OPUS_5_MODEL,
  CLAUDE_OPUS_4_8_MODEL,
  CLAUDE_SONNET_5_MODEL,
  'claude-opus-4-7',
  GPT_6_SOL_MODEL,
  GPT_6_ASTRA_MODEL,
  GPT_5_6_SOL_MODEL,
  GPT_5_6_TERRA_MODEL,
  GPT_5_6_LUNA_MODEL,
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5-mini',
  'gemini-3-flash',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'kimi-k2.5',
]);
const withoutHiddenByDefault = (models: readonly string[]) => models.filter((model) => !HIDDEN_BY_DEFAULT_MODELS.has(model));

export const DEFAULT_STATIC_AGENT_MODELS: Record<StaticAgentModelProvider, readonly string[]> = {
  // Fable 5.2 and Haiku 5.5 replace them for Claude Code; Cursor has neither, so it keeps them.
  claude: withoutHiddenByDefault(AGENT_MODELS.claude).filter((model) => model !== CLAUDE_FABLE_5_1_MODEL && model !== CLAUDE_HAIKU_4_5_MODEL),
  codex: withoutHiddenByDefault(AGENT_MODELS.codex),
};

export const DEFAULT_CURSOR_MODELS = withoutHiddenByDefault(AGENT_MODELS.cursor);

function resolveVisibleModels(
  provider: keyof AgentModelVisibility,
  defaults: readonly string[],
  configured: string[],
  hidden?: readonly unknown[] | null,
): string[] {
  const hiddenModels = new Set(sanitizeHiddenModels(provider, hidden));
  const models = [...new Set([...defaults, ...configured])];
  const visible = models.filter((model) => !hiddenModels.has(model));
  // Hiding every model would reopen the unrestricted catalog downstream, so it hides none.
  return visible.length > 0 ? visible : models;
}

export type AgentModelPreferences = { models: Partial<Record<AgentProvider, string>> };

export function getAgentModelOptions(
  provider: AgentProvider,
  overrides?: AgentModelOverrides,
): readonly string[] {
  const override = overrides?.[provider];
  if (override?.length) return override;
  if (provider === 'claude' || provider === 'codex') return DEFAULT_STATIC_AGENT_MODELS[provider];
  if (provider === 'cursor') return DEFAULT_CURSOR_MODELS;
  // Old engines can still report retired providers (e.g. Relay) at runtime; an empty catalog keeps pickers from throwing.
  return AGENT_MODELS[provider] ?? [];
}

// Otherwise a chat on a model that left the defaults would be moved to the default model on its next send, without anyone picking it.
export function withChatModel(
  provider: AgentProvider,
  overrides: AgentModelOverrides,
  chatModel?: string,
  preferences?: AgentModelVisibilityPreferences,
  images?: SandboxImages,
  catalogSource?: string,
): AgentModelOverrides {
  // A custom endpoint's catalog lists only what it serves.
  if (!chatModel || (provider !== 'claude' && provider !== 'codex') || (catalogSource && catalogSource !== 'static')) return overrides;
  const options = getAgentModelOptions(provider, overrides);
  const hidden = sanitizeHiddenModels(provider, provider === 'claude' ? preferences?.claude_hidden_models : preferences?.codex_hidden_models);
  if (options.includes(chatModel) || !AGENT_MODELS[provider].includes(chatModel) || hidden.includes(chatModel)
    || !isModelSupportedBySandboxImage(chatModel, images)) return overrides;
  return { ...overrides, [provider]: [...options, chatModel] };
}

export const MODEL_PREDECESSORS: Record<string, string> = {
  [CLAUDE_FABLE_5_2_MODEL]: CLAUDE_FABLE_5_1_MODEL,
  [CLAUDE_OPUS_5_5_MODEL]: CLAUDE_OPUS_5_MODEL,
  [CLAUDE_SONNET_5_5_MODEL]: CLAUDE_SONNET_5_MODEL,
  [CLAUDE_HAIKU_5_5_MODEL]: CLAUDE_HAIKU_4_5_MODEL,
  [GPT_6_2_SOL_MODEL]: GPT_6_1_SOL_MODEL,
  [GPT_6_1_SOL_MODEL]: GPT_6_SOL_MODEL,
  [GPT_6_1_TERRA_MODEL]: GPT_6_ASTRA_MODEL,
  [GPT_6_2_ASTRA_MODEL]: GPT_6_ASTRA_MODEL,
  [GPT_6_SOL_MODEL]: GPT_5_6_SOL_MODEL,
  [GPT_6_ASTRA_MODEL]: GPT_5_6_TERRA_MODEL,
  [GPT_6_LUNA_MODEL]: GPT_5_6_LUNA_MODEL,
};

// A workspace whose image is not known yet counts as the oldest, so a gated model only appears once its engine is confirmed to run it.
export const UNKNOWN_SANDBOX_IMAGE = 'okidoki-sandbox-0000-00-00-v0';

function parseSandboxImage(image: string): { date: string; revision: number } | null {
  const match = image.match(/^okidoki-sandbox-(\d{4}-\d{2}-\d{2})-v(\d+)/);
  return match ? { date: match[1], revision: Number(match[2]) } : null;
}

export function isSandboxImageAtLeast(sandboxImage: string | undefined, minimum: string): boolean {
  const current = parseSandboxImage(sandboxImage ?? '');
  const required = parseSandboxImage(minimum);
  // `development` and any unrecognized name build from source, so they track the newest features.
  if (!current || !required) return true;
  return current.date === required.date
    ? current.revision >= required.revision
    : current.date > required.date;
}

// Older engines bundle OpenCode 1.17.9, which Zen's free tier rejects.
const OPENCODE_ZEN_MIN_SANDBOX_IMAGE = 'okidoki-sandbox-2026-10-25-v24';

/** `undefined` stands for a workspace whose engine hasn't reported yet, which runs a current image. */
export interface SandboxImages {
  sandbox: string;
  /** The image release the running engine shipped with, newer than `sandbox` once the engine upgraded in place. */
  engine?: string;
}

export function isModelSupportedBySandboxImage(model: string, images: SandboxImages | undefined): boolean {
  const engineMinimum = CLAUDE_MODEL_MIN_SANDBOX_IMAGE[normalizeClaudeModel(model) ?? model] ?? CODEX_MODEL_MIN_SANDBOX_IMAGE[model];
  const minimum = engineMinimum ?? (isOpenCodeZenModel(model) ? OPENCODE_ZEN_MIN_SANDBOX_IMAGE : null);
  if (!minimum || !images) return true;
  // An engine upgraded in place brings its models: Claude Code comes from its Agent SDK, and it installs the Codex CLI
  // its image pins before starting Codex (MIN_CODEX_CLI_VERSION). OpenCode stays the image's.
  return isSandboxImageAtLeast(images.sandbox, minimum)
    || (Boolean(engineMinimum) && images.engine !== undefined && isSandboxImageAtLeast(images.engine, minimum));
}

export function resolveSandboxImageModel(model: string, images: SandboxImages | undefined): string | undefined {
  let resolved: string | undefined = model;
  while (resolved && !isModelSupportedBySandboxImage(resolved, images)) resolved = MODEL_PREDECESSORS[resolved];
  return resolved;
}

// Cursor is left alone: it reaches its models through its own service, not a bundled CLI.
export function withSandboxImageModelSupport(
  overrides: AgentModelOverrides,
  images: SandboxImages | undefined,
): AgentModelOverrides {
  const narrowed: AgentModelOverrides = { ...overrides };
  for (const provider of ['claude', 'codex', 'opencode'] as const) {
    if (provider === 'opencode' && !overrides.opencode) continue;
    const options = getAgentModelOptions(provider, overrides);
    const compatible = [...new Set(options.flatMap((model) => resolveSandboxImageModel(model, images) ?? []))];
    // Every option needs a newer image, so the turn fails either way; reopening hidden models is worse.
    narrowed[provider] = compatible.length > 0 ? compatible : options;
  }
  return narrowed;
}

export function isAgentModelAllowed(
  provider: AgentProvider,
  model: string,
  overrides?: AgentModelOverrides,
): boolean {
  return overrides?.[provider] === null || getAgentModelOptions(provider, overrides).includes(provider === 'okidoki' ? okidokiChatModel(model) : model);
}

export function getPreferredAgentModel(
  provider: AgentProvider,
  preferences: AgentModelPreferences,
  overrides?: AgentModelOverrides,
): string {
  const savedModel = provider === 'okidoki' ? okidokiChatModel(preferences.models[provider]) : preferences.models[provider];
  return savedModel && getAgentModelOptions(provider, overrides).includes(savedModel)
    ? savedModel
    : getDefaultAgentModel(provider, overrides);
}

export function sanitizeCursorModels(configured?: readonly unknown[] | null): string[] {
  return [
    ...new Set(
      (configured ?? []).filter(
        (model): model is string => typeof model === 'string' && model.trim().length > 0,
      ),
    ),
  ];
}

export function resolveCursorModels(
  configured?: readonly string[] | null,
  hidden?: readonly unknown[] | null,
): string[] {
  return resolveVisibleModels('cursor', DEFAULT_CURSOR_MODELS, sanitizeCursorModels(configured), hidden);
}

export function sanitizeStaticAgentModels(
  provider: keyof AgentModelVisibility,
  configured?: readonly unknown[] | null,
): string[] {
  const supportedModels = new Set(AGENT_MODELS[provider]);
  return [
    ...new Set(
      (configured ?? []).filter(
        (model): model is string => typeof model === 'string' && supportedModels.has(model),
      ),
    ),
  ];
}

// Only built-in models can be hidden; an added model is removed by dropping it from its list.
export const sanitizeHiddenModels = sanitizeStaticAgentModels;

export function resolveStaticAgentModels(
  provider: StaticAgentModelProvider,
  configured?: readonly unknown[] | null,
  hidden?: readonly unknown[] | null,
): string[] {
  return resolveVisibleModels(
    provider,
    DEFAULT_STATIC_AGENT_MODELS[provider],
    sanitizeStaticAgentModels(provider, configured),
    hidden,
  );
}

export function resolveAgentModelVisibility(
  preferences?: AgentModelVisibilityPreferences | null,
): AgentModelVisibility {
  return {
    claude: resolveStaticAgentModels('claude', preferences?.claude_models, preferences?.claude_hidden_models),
    codex: resolveStaticAgentModels('codex', preferences?.codex_models, preferences?.codex_hidden_models),
    cursor: resolveCursorModels(preferences?.cursor_models, preferences?.cursor_hidden_models),
  };
}

type DynamicAgentModelCatalogs = Pick<
  AgentModelOverrides,
  'claude' | 'codex' | 'opencode' | 'pi'
>;

const DYNAMIC_MODEL_CATALOG_PROVIDERS: readonly (keyof DynamicAgentModelCatalogs)[] = [
  'claude', 'codex', 'opencode', 'pi',
];

export function resolveAgentModelOverrides(
  preferences?: AgentModelVisibilityPreferences | null,
  dynamicModels: DynamicAgentModelCatalogs = {},
): AgentModelOverrides {
  const overrides: AgentModelOverrides = resolveAgentModelVisibility(preferences);
  for (const provider of DYNAMIC_MODEL_CATALOG_PROVIDERS) {
    const models = dynamicModels[provider];
    // An empty catalog has not loaded (or mirrors the static list), so the visibility list stands.
    if (models === undefined || (models !== null && models.length === 0)) continue;
    overrides[provider] = models;
  }
  return overrides;
}

export const sanitizeOpenRouterModels = sanitizeCursorModels;

export function resolveOpenRouterModels(configured?: readonly string[] | null): string[] {
  const valid = sanitizeOpenRouterModels(configured);
  return valid.length > 0 ? valid : [...DEFAULT_OPENROUTER_MODELS];
}

export const sanitizeOpenCodeGoModels = sanitizeCursorModels;

export function resolveOpenCodeGoModels(
  configured?: readonly string[] | null,
  available?: readonly string[],
): string[] {
  const valid = sanitizeOpenCodeGoModels(configured);
  const models = valid.length > 0 ? valid : [
    DEFAULT_OPENCODE_GO_MODEL,
    'kimi-k3',
    'deepseek-v4.1-flash',
    'minimax-m3',
  ];
  if (!available) return models;
  const enabled = models.filter((model) => available.includes(model));
  // Empty overrides reopen built-in models downstream; retain the selection until an admin replaces it.
  return enabled.length > 0 ? enabled : models;
}

export const MODEL_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OKIDOKI_MODEL_CATALOG).map(([id, { label }]) => [id, label])),
  fable: 'Fable 5.1',
  [CLAUDE_FABLE_5_1_MODEL]: 'Fable 5.1',
  [CLAUDE_FABLE_5_MODEL]: 'Fable 5',
  sonnet: 'Sonnet 5',
  'claude-sonnet-5': 'Sonnet 5',
  [CLAUDE_SONNET_5_5_MODEL]: 'Sonnet 5.5',
  opus: 'Opus 5',
  [CLAUDE_OPUS_5_MODEL]: 'Opus 5',
  [CLAUDE_OPUS_1M_MODEL]: 'Opus (1M)',
  [LEGACY_CLAUDE_OPUS_1M_MODEL]: 'Opus (1M)',
  haiku: 'Haiku 4.5',
  [GPT_6_ASTRA_MODEL]: 'GPT-6 Astra',
  [GPT_6_SOL_MODEL]: 'GPT-6 Sol',
  [GPT_6_LUNA_MODEL]: 'GPT-6 Luna',
  [GPT_5_6_SOL_MODEL]: 'GPT-5.6 Sol',
  [GPT_5_6_TERRA_MODEL]: 'GPT-5.6 Terra',
  [GPT_5_6_LUNA_MODEL]: 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  [DEFAULT_OPENCODE_MODEL]: 'GLM 5.3 via OpenRouter',
  'z-ai/glm-5.2': 'GLM 5.2 via OpenRouter',
  [GLM_5_3_FLASH_MODEL]: 'GLM 5.3 Flash via OpenRouter',
  [DEEPSEEK_V4_PRO_MODEL]: 'DeepSeek V4 Pro via OpenRouter',
  [DEEPSEEK_V4_FLASH_MODEL]: 'DeepSeek V4 Flash via OpenRouter',
  'minimax/minimax-m3': 'MiniMax M3 via OpenRouter',
  'xiaomi/mimo-v2.5-pro': 'MiMo V2.5 Pro via OpenRouter',
  'moonshotai/kimi-k2.6': 'Kimi K2.6 via OpenRouter',
  'moonshotai/kimi-k3': 'Kimi K3 via OpenRouter',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-pro-orchestrator-neon': 'Orchestrator (Neon)',
  'gemini-pro-orchestrator-g1-pro': 'Orchestrator (Argon)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gpt-oss-120b-medium': 'GPT-OSS 120B',
  [MUSE_WONDER_1_0_MODEL]: 'Muse Wonder 1.0',
  [MUSE_SPARK_1_3_MODEL]: 'Muse Spark 1.3',
  [DEFAULT_MUSE_MODEL]: 'Muse Spark 1.2',
  'meta/muse-spark-1.3': 'Muse Spark 1.3 via OpenRouter',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash via OpenRouter',
  'qwen/qwen4-max': 'Qwen4 Max via OpenRouter',
  ...ASTER_MODEL_LABELS,
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.1': 'GPT-5.1',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5-mini': 'GPT-5 Mini',
  'composer-2.5': 'Composer 2.5',
  [CLAUDE_OPUS_4_8_MODEL]: 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  [CLAUDE_HAIKU_5_5_MODEL]: 'Haiku 5.5',
  [CLAUDE_HAIKU_4_5_MODEL]: 'Haiku 4.5',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3-flash': 'Gemini 3 Flash',
  'grok-4.7': 'Grok 4.7',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
  'grok-4.3': 'Grok 4.3',
  'kimi-k2.5': 'Kimi K2.5',
};

// API Request/Response types

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * Base64 encoded image source.
 */
export interface Base64ImageSource {
  type: 'base64';
  media_type: ImageMediaType;
  /** Base64 encoded image data */
  data: string;
}

/**
 * URL-based image source.
 */
export interface UrlImageSource {
  type: 'url';
  /** URL to the image */
  url: string;
}

/**
 * Image content block for multimodal inputs.
 * Supports both base64 encoded images and image URLs.
 */
export interface ImageContent {
  type: 'image';
  source: Base64ImageSource | UrlImageSource;
  label?: string;
}

export type GitDiff = EngineRepoDiff;

const resourcePressure = z.number().min(0).max(100).nullable();
export const sandboxResourceMinuteSchema = z.object({
  minute: z.iso.datetime(),
  samples: z.number().int().min(1).max(255),
  cpuCount: z.number().int().min(1),
  memoryTotalMb: z.number().min(0),
  cpuBusyAvg: z.number().min(0),
  cpuBusyMax: z.number().min(0),
  memoryUsedAvgMb: z.number().min(0),
  memoryUsedMaxMb: z.number().min(0),
  memoryCacheAvgMb: z.number().min(0),
  memoryAvailableMinMb: z.number().min(0),
  cpuPressureSomeMax: resourcePressure,
  cpuPressureFullMax: resourcePressure,
  memoryPressureSomeMax: resourcePressure,
  memoryPressureFullMax: resourcePressure,
  ioPressureSomeMax: resourcePressure,
  ioPressureFullMax: resourcePressure,
  oomKills: z.number().int().min(0),
  // Engines from before these fields omit them.
  cpuStealAvg: z.number().min(0).optional(),
  cpuProbeMs: z.number().min(0).optional(),
});
export type SandboxResourceMinute = z.infer<typeof sandboxResourceMinuteSchema>;
export const MAX_PENDING_RESOURCE_MINUTES = 120;
export const sandboxResourceMinutesSchema = z.array(sandboxResourceMinuteSchema).max(MAX_PENDING_RESOURCE_MINUTES);
export const sandboxMemorySampleSchema = z.object({
  at: z.iso.datetime(),
  memoryTotalMb: z.number().min(0),
  memoryUsedMb: z.number().min(0),
  memoryPressureSome: resourcePressure,
});
export type SandboxMemorySample = z.infer<typeof sandboxMemorySampleSchema>;

export interface EngineHeartbeatRequest {
  bootTimeMs?: number;
  uptimeSeconds?: number;
  status?: 'active';
  resources?: SandboxResourceMinute[];
  memorySpike?: SandboxMemorySample;
  engineImage?: string;
}

export interface EngineKeepAliveRequest {
  /** A duration, not a time, so sandbox and monolith clocks aren't compared. */
  idleMs?: number;
}

export interface EngineHeartbeatResponse {
  success: true;
  receivedAt: string;
  resourcesRecorded: boolean;
  autoSize: boolean;
}

export interface WorkspaceEngineHeartbeatSnapshot {
  lastSeenAt: string | null;
  ageMs: number | null;
  fresh: boolean;
  staleAfterMs: number;
  bootTimeMs?: number;
  uptimeSeconds?: number;
  status?: string;
  /** Last image the engine reported, kept so clients can gate models while it sleeps. */
  sandboxImage?: string;
  engineImage?: string;
}

export type EngineHealthFailureReason =
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'network_error'; message: string; errorName: string }
  | { kind: 'http_status'; status: number }
  | { kind: 'wrong_content_type'; contentType: string };

export type EngineHealthProbeResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; elapsedMs: number; failure: EngineHealthFailureReason };

type WorkspaceNotFound = 'not_found';
/**
 * Why the engine health probe failed: 'overloaded' when sandbox metrics show
 * memory/CPU pegged (agent workload starving the engine), 'unreachable'
 * otherwise. Lets the UI say "under heavy load" instead of implying an
 * infrastructure fault.
 */
export type EngineUnavailableReason = 'overloaded' | 'unreachable';

export const ENGINE_UPDATE_BUSY_MESSAGE = 'Finish or stop the current turn first';

const versionChangeSchema = z.object({ from: z.string(), to: z.string() });
export type VersionChange = z.infer<typeof versionChangeSchema>;

const engineUpdateChangesSchema = z.object({ engine: versionChangeSchema.optional(), cli: versionChangeSchema.optional() });
export const engineUpdateProgressSchema = z.discriminatedUnion('state', [
  engineUpdateChangesSchema.extend({ state: z.enum(['updating', 'updated']) }),
  engineUpdateChangesSchema.extend({ state: z.literal('failed'), reason: z.string() }),
]);
export type EngineUpdateProgress = z.infer<typeof engineUpdateProgressSchema>;

export type EngineUpdateAvailability =
  | { state: 'up_to_date' | 'preparing' | 'ready' }
  | { state: 'blocked'; reason: string };

interface RuntimePackageUpdate {
  /** Null when the image predates in-place updates. */
  version: string | null;
  latestVersion: string;
  availability: EngineUpdateAvailability;
}

/** The engine's own update at the top level, so clients that predate the CLI still read it. */
export interface WorkspaceEngineUpdateResponse extends RuntimePackageUpdate {
  /** Absent while the web app runs ahead of a monolith deploy that predates CLI updates. */
  cli?: RuntimePackageUpdate;
}

export function combinedRuntimeAvailability({ availability, cli }: WorkspaceEngineUpdateResponse): EngineUpdateAvailability {
  // A CLI that failed to download retries at the next wake, so it never blocks the update or shows as one.
  const parts = [availability, cli?.availability.state === 'blocked' ? availability : cli?.availability ?? availability];
  return parts.find((part) => part.state === 'preparing')
    ?? parts.find((part) => part.state === 'ready')
    ?? availability;
}

export interface WorkspaceStatusResponse {
  status: WorkspaceStatus | WorkspaceNotFound;
  lastChecked: string;
  error?: string;
  engineUnavailableReason?: EngineUnavailableReason;
  message?: string;
  engineHeartbeat?: WorkspaceEngineHeartbeatSnapshot;
  isCodexProcessing?: boolean;
  isClaudeProcessing?: boolean;
  isCursorProcessing?: boolean;
  isGeminiProcessing?: boolean;
  isMuseProcessing?: boolean;
  isOpencodeProcessing?: boolean;
  isPiProcessing?: boolean;
  isOkidokiProcessing?: boolean;
  /** True when every working top-level chat is a PR feedback fork, so UIs can tell review work apart from the main agent. */
  isOnlyPullRequestFeedbackProcessing?: boolean;
  /** Set with `isOnlyPullRequestFeedbackProcessing`: the name of the most recently active of those chats. Omitted otherwise. */
  pullRequestFeedbackChatTitle?: string;
  /**
   * True when at least one chat for that provider has an unresolved
   * interactive tool call (e.g. a question for the user). Implies
   * `processing` is also true; use this to render an "awaiting your input"
   * state instead of "thinking" — the agent is blocked on the user.
   */
  isCodexAwaitingInput?: boolean;
  isClaudeAwaitingInput?: boolean;
  isCursorAwaitingInput?: boolean;
  isGeminiAwaitingInput?: boolean;
  isOpencodeAwaitingInput?: boolean;
  isPiAwaitingInput?: boolean;
  isCodexUsed?: boolean;
  isClaudeUsed?: boolean;
  isCursorUsed?: boolean;
  isGeminiUsed?: boolean;
  isOpencodeUsed?: boolean;
  isPiUsed?: boolean;
  /** Lags behind `status === 'active'` while the desktop stack boots; `undefined` on engines predating the field (treat as ready). */
  desktopReady?: boolean;
  hasActiveSSHSessions?: boolean;
  repoStatuses?: EngineRepoState[];
  environmentDetails?: EngineEnvironmentDetails;
  gitAuthor?: {
    name: string;
    email: string;
  };
  gitCoAuthors?: CoAuthorInfo[];
  lastChatMessage?: {
    text: string;
    provider: AgentProvider;
    at: string;
  } | null;
  /** A prompt was accepted but the engine has not taken it yet. Counts as processing in `isWorkspaceStatusProcessing`. */
  pendingDelivery?: boolean;
  engineUpdate?: EngineUpdateProgress;
}

const WORKSPACE_PROCESSING_FLAGS = {
  claude: 'isClaudeProcessing',
  codex: 'isCodexProcessing',
  cursor: 'isCursorProcessing',
  gemini: 'isGeminiProcessing',
  muse: 'isMuseProcessing',
  opencode: 'isOpencodeProcessing',
  pi: 'isPiProcessing',
  okidoki: 'isOkidokiProcessing',
} as const satisfies Record<AgentProvider, keyof WorkspaceStatusResponse>;

type WorkspaceProcessingFlag = (typeof WORKSPACE_PROCESSING_FLAGS)[AgentProvider];

export function deriveWorkspaceProcessingStatus(
  chats: ChatSummary[],
): Record<WorkspaceProcessingFlag | 'isOnlyPullRequestFeedbackProcessing', boolean> & { pullRequestFeedbackChatTitle?: string } {
  const processing = (provider: AgentProvider) =>
    chats.some((chat) => chat.provider === provider && chat.processing);
  // Subagent chats work on behalf of the top-level chat that spawned them, and can outlive its turn.
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  const rootChat = (chat: ChatSummary): ChatSummary => {
    const parent = chat.parentChatId ? chatsById.get(chat.parentChatId) : undefined;
    return parent ? rootChat(parent) : chat;
  };
  const workingChats = chats.filter((chat) => chat.processing);
  const workingRootChats = workingChats.map(rootChat);
  const isOnlyPullRequestFeedbackProcessing = workingRootChats.length > 0 && workingRootChats.every(isPullRequestFeedbackChat);
  // Compare the working chats themselves: a subagent's activity does not bump its root's updatedAt.
  const latestFeedbackChat = isOnlyPullRequestFeedbackProcessing
    ? rootChat(workingChats.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)))
    : null;
  return {
    isOnlyPullRequestFeedbackProcessing,
    ...(latestFeedbackChat ? { pullRequestFeedbackChatTitle: latestFeedbackChat.displayName ?? latestFeedbackChat.title } : {}),
    isClaudeProcessing: processing('claude'),
    isCodexProcessing: processing('codex'),
    isCursorProcessing: processing('cursor'),
    isGeminiProcessing: processing('gemini'),
    isMuseProcessing: processing('muse'),
    isOpencodeProcessing: processing('opencode'),
    isPiProcessing: processing('pi'),
    isOkidokiProcessing: processing('okidoki'),
  };
}

export function isWorkspaceStatusProcessing(status: WorkspaceStatusResponse | null | undefined): boolean {
  return status?.pendingDelivery === true || Object.values(WORKSPACE_PROCESSING_FLAGS).some((flag) => status?.[flag]);
}

const WORKSPACE_AWAITING_INPUT_FLAGS = {
  claude: 'isClaudeAwaitingInput',
  codex: 'isCodexAwaitingInput',
  cursor: 'isCursorAwaitingInput',
  gemini: 'isGeminiAwaitingInput',
  opencode: 'isOpencodeAwaitingInput',
  pi: 'isPiAwaitingInput',
} as const satisfies Record<Exclude<EngineAgentProvider, 'muse'>, keyof WorkspaceStatusResponse>;

export function isWorkspaceStatusAwaitingInput(status: WorkspaceStatusResponse | null | undefined): boolean {
  return Object.values(WORKSPACE_AWAITING_INPUT_FLAGS).some((flag) => status?.[flag]);
}

export const CANVAS_ITEM_KINDS = [
  'markdown',
  'mermaid',
  'html',
  'text',
  'image',
  'pdf',
  'docx',
  'video',
  'audio',
  'other',
] as const;

const CANVAS_ITEM_KIND_VALUES: readonly string[] = CANVAS_ITEM_KINDS;

export type CanvasItemKind = (typeof CANVAS_ITEM_KINDS)[number];

export const MAX_CANVAS_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_CANVAS_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_CANVAS_PREVIEW_BYTES = 5 * 1024 * 1024;

export function isCanvasItemKind(value: unknown): value is CanvasItemKind {
  return typeof value === 'string' && CANVAS_ITEM_KIND_VALUES.includes(value);
}

export function isCanvasTextKind(kind: CanvasItemKind): boolean {
  return kind === 'markdown' || kind === 'mermaid' || kind === 'html' || kind === 'text';
}

export function sanitizeCanvasFilename(filename: string): string | null {
  if (filename.includes('\\')) return null;
  const segments = filename.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return null;
  }
  return filename;
}

export interface CanvasItem {
  filename: string;
  kind: CanvasItemKind;
  sizeBytes: number;
}

export interface CanvasListResponse {
  items: CanvasItem[];
}

export interface CanvasContentResponse {
  filename: string;
  kind: CanvasItemKind;
  sizeBytes: number;
  mimeType: string;
  content?: string;
  base64?: string;
  tooLarge?: boolean;
  revision?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function serializeCanvasContentResponse(input: {
  filename: string;
  kind: CanvasItemKind;
  sizeBytes: number;
  mimeType: string;
  bytes: Uint8Array;
  revision?: string;
}): CanvasContentResponse {
  const base = {
    filename: input.filename,
    kind: input.kind,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    revision: input.revision,
  };
  if (isCanvasTextKind(input.kind)) {
    return { ...base, content: new TextDecoder().decode(input.bytes) };
  }
  return { ...base, base64: bytesToBase64(input.bytes) };
}

const CANVAS_KIND_BY_EXTENSION: Record<string, { kind: CanvasItemKind; mimeType: string }> = {
  '.md': { kind: 'markdown', mimeType: 'text/markdown; charset=utf-8' },
  '.markdown': { kind: 'markdown', mimeType: 'text/markdown; charset=utf-8' },
  '.mmd': { kind: 'mermaid', mimeType: 'text/plain; charset=utf-8' },
  '.mermaid': { kind: 'mermaid', mimeType: 'text/plain; charset=utf-8' },
  '.html': { kind: 'html', mimeType: 'text/html; charset=utf-8' },
  '.htm': { kind: 'html', mimeType: 'text/html; charset=utf-8' },
  '.txt': { kind: 'text', mimeType: 'text/plain; charset=utf-8' },
  '.log': { kind: 'text', mimeType: 'text/plain; charset=utf-8' },
  '.csv': { kind: 'text', mimeType: 'text/csv; charset=utf-8' },
  '.tsv': { kind: 'text', mimeType: 'text/tab-separated-values; charset=utf-8' },
  '.json': { kind: 'text', mimeType: 'application/json; charset=utf-8' },
  '.json5': { kind: 'text', mimeType: 'application/json5; charset=utf-8' },
  '.yaml': { kind: 'text', mimeType: 'application/yaml; charset=utf-8' },
  '.yml': { kind: 'text', mimeType: 'application/yaml; charset=utf-8' },
  '.toml': { kind: 'text', mimeType: 'application/toml; charset=utf-8' },
  '.ini': { kind: 'text', mimeType: 'text/plain; charset=utf-8' },
  '.xml': { kind: 'text', mimeType: 'application/xml; charset=utf-8' },
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.apng': { kind: 'image', mimeType: 'image/apng' },
  '.avif': { kind: 'image', mimeType: 'image/avif' },
  '.bmp': { kind: 'image', mimeType: 'image/bmp' },
  '.ico': { kind: 'image', mimeType: 'image/x-icon' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jfif': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.svg': { kind: 'image', mimeType: 'image/svg+xml' },
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.docx': { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
};

export function extensionForMimeType(mimeType: string): string | undefined {
  return Object.keys(CANVAS_KIND_BY_EXTENSION).find((extension) => CANVAS_KIND_BY_EXTENSION[extension].mimeType.split(';')[0] === mimeType);
}

export function classifyCanvasFilename(filename: string): { kind: CanvasItemKind; mimeType: string } {
  const idx = filename.lastIndexOf('.');
  const ext = idx === -1 ? '' : filename.slice(idx).toLowerCase();
  return CANVAS_KIND_BY_EXTENSION[ext]
    ?? (detectLanguageByPath(filename)
      ? { kind: 'text', mimeType: 'text/plain; charset=utf-8' }
      : { kind: 'other', mimeType: 'application/octet-stream' });
}

// Engine logs
export interface EngineLogSessionInfo {
  sessionId: string;
  filename: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface EngineLogsListResponse {
  currentSessionId: string | null;
  sessions: EngineLogSessionInfo[];
}

export interface EngineLogReadResponse {
  sessionId: string;
  totalLines: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  lines: string[];
}

export function isEngineLogsListResponse(value: unknown): value is EngineLogsListResponse {
  if (!isRecord(value) || (value.currentSessionId !== null && typeof value.currentSessionId !== 'string')) return false;
  return Array.isArray(value.sessions) && value.sessions.every((session) =>
    isRecord(session)
    && typeof session.sessionId === 'string'
    && typeof session.filename === 'string'
    && typeof session.sizeBytes === 'number'
    && typeof session.updatedAt === 'string'
  );
}

export function isEngineLogReadResponse(value: unknown): value is EngineLogReadResponse {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && typeof value.totalLines === 'number'
    && typeof value.offset === 'number'
    && typeof value.limit === 'number'
    && typeof value.hasMore === 'boolean'
    && Array.isArray(value.lines)
    && value.lines.every((line) => typeof line === 'string');
}

export function isValidEngineLogSessionId(sessionId: string): boolean {
  return Boolean(sessionId) && !/[/\\]/.test(sessionId) && !sessionId.includes('..');
}

export function paginateEngineLogContent(input: {
  sessionId: string;
  content: string;
  offset?: string;
  limit?: string;
}): EngineLogReadResponse {
  const parsedOffset = Number.parseInt(input.offset ?? '0', 10);
  const parsedLimit = Number.parseInt(input.limit ?? '500', 10);
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.min(parsedLimit, 5000) : 500;
  const lines = input.content.split('\n');
  if (lines.at(-1) === '') lines.pop();

  return {
    sessionId: input.sessionId,
    totalLines: lines.length,
    offset,
    limit,
    hasMore: offset + limit < lines.length,
    lines: lines.slice(offset, offset + limit),
  };
}
