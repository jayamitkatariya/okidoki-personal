import { z } from 'zod';
import { UUID_RE } from '../uuid';
import { ENGINE_AGENT_PROVIDERS, type AgentProvider, type ThinkingLevel } from '../agent';
import type { AppshotDestination, AppshotShortcut } from '../desktop';
import type { KeyboardShortcutOverrides } from '../keyboard-shortcuts';
import type { FallbackChains } from '../fallback-chains';
import type { SendKey } from '../keyboard-shortcuts';
import type { ScoutOrgPreferences } from '../scout';
import type { LinearStateKind } from './linear';
import { PUSH_HOLD_MINUTES } from './push';
import {
  OKIDOKI_AGENT_ABILITIES,
  OKIDOKI_AGENT_ABILITY_REGISTRY,
  type OkidokiAgentAbility,
  type OkidokiAgentAbilityFlags,
} from '../default-skills/okidoki-agent/registry';

export type PreferencesScope = 'user' | 'org';

export interface AgentDefaultSettings {
  agent_provider: AgentProvider | null;
  model: string | null;
  thinking_level: ThinkingLevel | null;
  goal_mode: boolean | null;
  fast_mode: boolean | null;
}

export const EMPTY_AGENT_DEFAULT_SETTINGS: AgentDefaultSettings = {
  agent_provider: null,
  model: null,
  thinking_level: null,
  goal_mode: null,
  fast_mode: null,
};

export const DEFAULT_ORG_AGENT_DEFAULT_SETTINGS: AgentDefaultSettings = {
  agent_provider: null,
  model: null,
  thinking_level: null,
  goal_mode: false,
  fast_mode: false,
};

export interface GetDefaultAgentResponse {
  default_agent: AgentProvider | null;
  default_model: string | null;
}

export const DEFAULT_SUBAGENT_MCP_PROVIDERS: AgentProvider[] = [...ENGINE_AGENT_PROVIDERS];

export const ALERT_SOUND_FAMILIES = {
  glass: ['glint', 'tap', 'ripple', 'halo'],
  wood: ['ready', 'pluck', 'knock', 'bloom', 'steps'],
} as const;
type AlertSoundFamily = keyof typeof ALERT_SOUND_FAMILIES;
const ALERT_SOUNDS = [...ALERT_SOUND_FAMILIES.glass, ...ALERT_SOUND_FAMILIES.wood] as const;
export type AlertSound = (typeof ALERT_SOUNDS)[number] | 'none';
export const MAX_ALERT_ENTRIES = 500;

export function isAlertSound(value: unknown): value is AlertSound {
  return value === 'none' || ALERT_SOUNDS.some((sound) => sound === value);
}

export interface WorkspaceAlertSettings {
  priority?: 'muted' | 'high';
}

export type AlertSoundFile = `${AlertSoundFamily}-${string}`;

export function alertSoundFile(priority: WorkspaceAlertSettings['priority'], alertSound: AlertSound | null): AlertSoundFile | null {
  const family = ALERT_SOUND_FAMILIES.wood.some((sound) => sound === alertSound) ? 'wood' : 'glass';
  if (priority === 'high') return `${family}-needs-you`;
  return alertSound && alertSound !== 'none' ? `${family}-${alertSound}` : null;
}

export const CHAT_TEXT_SIZES = ['small', 'default', 'large', 'larger'] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];
export const APP_FONTS = ['inter', 'system', 'atkinson', 'geist', 'ibm-plex-sans', 'source-sans', 'lexend'] as const;
export type AppFont = (typeof APP_FONTS)[number];
export const CODE_FONTS = ['geist-mono', 'system', 'atkinson-mono', 'jetbrains-mono', 'fira-code', 'source-code-pro', 'ibm-plex-mono'] as const;
export type CodeFont = (typeof CODE_FONTS)[number];
export const WALLPAPER_EFFECTS = ['soft', 'duotone', 'dither', 'none'] as const;
type WallpaperEffect = (typeof WALLPAPER_EFFECTS)[number];
/** `key` is the uploaded image or video in the media bucket, so a shared theme can point at the same file. A video's first frame is stored next to it as a JPEG. */
export interface Wallpaper {
  key: string;
  effect: WallpaperEffect;
}
export type ServedWallpaper = Wallpaper & { url: string; video: string | null };
export const WALLPAPER_VIDEO_EXTENSIONS = { 'video/mp4': 'mp4', 'video/webm': 'webm' } as const;
export const WALLPAPER_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
/** A video wallpaper is converted in the browser and arrives with its first frame as a JPEG `image`, stored under the same name so the poster is found from the key. */
export type WallpaperUpload = { image: File; video: File | null };
export type ServedUserPreferences = Omit<UserPreferences, 'wallpaper'> & { wallpaper: ServedWallpaper | null };

export const AUTOMATION_ALERT_LEVELS = ['muted', 'normal', 'every'] as const;
export type AutomationAlertLevel = (typeof AUTOMATION_ALERT_LEVELS)[number];

export const AUTOMATION_ALERT_LEVEL_COPY: Record<AutomationAlertLevel, { label: string; description: string }> = {
  muted: { label: 'Muted', description: 'No pushes. It still shows in the app.' },
  normal: { label: 'Normal', description: 'When it needs you or stops working' },
  every: { label: 'Every run', description: 'Each result, too' },
};

export interface AutomationAlertSettings {
  level?: AutomationAlertLevel;
}

export const PUSH_TYPES = ['needs_you', 'finished', 'automations', 'usage_limit'] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export const PUSH_TYPE_COPY: Record<PushType, { label: string; description: string }> = {
  needs_you: { label: 'Needs you', description: 'When an agent is waiting on you, like a question or a plan to approve' },
  finished: { label: 'Finished', description: 'When work you started finishes, including reminders you set' },
  automations: { label: 'Automations', description: 'When one stops working, and each result from the ones set to Every run' },
  usage_limit: { label: 'Usage limit', description: 'When your organization reaches its usage limit' },
};

export const PUSH_WHEN_ACTIVE_OPTIONS = ['wait', 'skip', 'send'] as const;
type PushWhenActive = (typeof PUSH_WHEN_ACTIVE_OPTIONS)[number];

export const PUSH_WHEN_ACTIVE_LABEL = 'When I’m at my computer';
export const PUSH_WHEN_ACTIVE_COPY: Record<PushWhenActive, string> = {
  wait: `Wait ${PUSH_HOLD_MINUTES} minutes`,
  skip: 'Don’t send',
  send: 'Send right away',
};

/** False until the push server ships, so desktop doesn't offer phone pushes that nothing sends. */
export const PHONE_PUSHES_ENABLED = false;

export function isPreferencesScope(value: string): value is PreferencesScope {
  return value === 'user' || value === 'org';
}

export interface UserPreferences {
  default_agent: AgentProvider | null;
  default_model: string | null;
  claude_models: string[] | null;
  codex_models: string[] | null;
  cursor_models: string[] | null;
  claude_hidden_models: string[] | null;
  codex_hidden_models: string[] | null;
  cursor_hidden_models: string[] | null;
  openrouter_models: string[] | null;
  opencode_go_models: string[] | null;
  close_workspace_on_pr_close: boolean;
  close_workspace_on_pr_merge: boolean;
  /**
   * Org-level default environment for Slack and Linear intake. When set, the
   * intake skips the env picker and creates the workspace in this env. Stored
   * on UserPreferences for shape symmetry, but only consumed at org scope.
   */
  default_environment_id: string | null;
  respond_to_ci_workflows: boolean;
  respond_to_ci_checks: boolean;
  respond_to_human_pr_reviews: boolean;
  /** When true, PRs created by workspace agents are attributed to the user instead of the bot */
  pr_user_attribution: boolean;
  /** Overrides the name and email Okidoki uses for the user's GitHub commits. `null` uses their GitHub profile. */
  github_commit_name: string | null;
  github_commit_email: string | null;
  /** When true, PRs created by workspace agents are opened as drafts by default */
  auto_draft_prs: boolean;
  open_prs_in_graphite: boolean;
  open_links_in_desktop_app: boolean;
  /** Every workspace the user owns may run commands on their computer, without asking first. Off: each workspace asks and is allowed on its own. */
  local_control: boolean;
  spotify_controls: boolean;
  /** Both of these modifier keys attach the frontmost window in the macOS app. `null` turns Appshots off. */
  appshot_shortcut: AppshotShortcut | null;
  appshot_destination: AppshotDestination;
  appshot_sound: boolean;
  keyboard_shortcuts: KeyboardShortcutOverrides;
  manager_tour_seen: boolean;
  slack_settings_moved_notice: boolean;
  follow_up_mode: 'steer' | 'queue';
  send_key: SendKey;
  memory_enabled: boolean | null;
  /** Experimental: replace native subagent tools with the Okidoki subagent MCP. `null` inherits the organization setting. */
  subagent_mcp_enabled: boolean | null;
  default_fast_mode: boolean;
  auto_compact_tokens: number | null;
  agent_defaults: AgentDefaultSettings;
  /**
   * Per-harness order of credentials to switch to and harnesses to fork to when
   * the active credential fails or runs out. `null` uses the built-in credential
   * order with no fork points. Credentials the member owns are still tried
   * before the organization's; the chain only orders methods within a scope.
   */
  fallback_chains: FallbackChains | null;
  /** `null` keeps the operating system's notification sound in the desktop app and stays silent on the web. */
  alert_sound: AlertSound | null;
  /** Keyed by workspace ID. Saving an empty entry for a workspace removes it. */
  workspace_alerts: Record<string, WorkspaceAlertSettings>;
  /** Keyed by automation ID. Saving an empty entry for an automation removes it. */
  automation_alerts: Record<string, AutomationAlertSettings>;
  push_types: Record<PushType, boolean>;
  push_when_active: PushWhenActive;
  chat_text_size: ChatTextSize;
  app_font: AppFont;
  code_font: CodeFont;
  code_text_size: ChatTextSize;
  code_wrap: boolean;
  wallpaper: Wallpaper | null;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  default_agent: null,
  default_model: null,
  claude_models: null,
  codex_models: null,
  cursor_models: null,
  claude_hidden_models: null,
  codex_hidden_models: null,
  cursor_hidden_models: null,
  openrouter_models: null,
  opencode_go_models: null,
  close_workspace_on_pr_close: false,
  close_workspace_on_pr_merge: false,
  default_environment_id: null,
  respond_to_ci_workflows: true,
  respond_to_ci_checks: true,
  respond_to_human_pr_reviews: false,
  pr_user_attribution: false,
  github_commit_name: null,
  github_commit_email: null,
  auto_draft_prs: false,
  open_prs_in_graphite: false,
  open_links_in_desktop_app: false,
  local_control: false,
  spotify_controls: false,
  appshot_shortcut: 'command',
  appshot_destination: 'automatic',
  appshot_sound: true,
  keyboard_shortcuts: {},
  manager_tour_seen: false,
  slack_settings_moved_notice: false,
  follow_up_mode: 'steer',
  send_key: 'enter',
  memory_enabled: null,
  subagent_mcp_enabled: null,
  default_fast_mode: false,
  auto_compact_tokens: null,
  agent_defaults: { ...EMPTY_AGENT_DEFAULT_SETTINGS },
  fallback_chains: null,
  alert_sound: null,
  workspace_alerts: {},
  automation_alerts: {},
  push_types: { needs_you: true, finished: true, automations: true, usage_limit: true },
  push_when_active: 'wait',
  chat_text_size: 'default',
  app_font: 'inter',
  code_font: 'geist-mono',
  code_text_size: 'default',
  code_wrap: false,
  wallpaper: null,
};

export interface OkidokiAgentDefaultSkillPreferences {
  enabled: boolean;
  abilities: OkidokiAgentAbilityFlags;
}

export interface DefaultSkillsPreferences {
  okidoki_agent: OkidokiAgentDefaultSkillPreferences;
}

function defaultOkidokiAgentAbilities(): OkidokiAgentAbilityFlags {
  const abilities: Partial<OkidokiAgentAbilityFlags> = {};
  for (const key of OKIDOKI_AGENT_ABILITIES) {
    abilities[key] = true;
  }
  if (hasAllOkidokiAgentAbilities(abilities)) return abilities;
  throw new Error('Default Okidoki agent ability flags are incomplete');
}

function hasAllOkidokiAgentAbilities(
  abilities: Partial<OkidokiAgentAbilityFlags>,
): abilities is OkidokiAgentAbilityFlags {
  return OKIDOKI_AGENT_ABILITIES.every((key) => typeof abilities[key] === 'boolean');
}

export function pickDefaultEnvironmentId({
  userPreferences,
  orgPreferences,
  availableEnvironmentIds,
}: {
  userPreferences?: UserPreferences;
  orgPreferences?: OrgPreferences;
  availableEnvironmentIds?: Set<string>;
}): string | null {
  const userDefault = userPreferences?.default_environment_id ?? null;
  if (userDefault && (!availableEnvironmentIds || availableEnvironmentIds.has(userDefault))) {
    return userDefault;
  }

  const orgDefault = orgPreferences?.default_environment_id ?? null;
  if (orgDefault && (!availableEnvironmentIds || availableEnvironmentIds.has(orgDefault))) {
    return orgDefault;
  }

  return null;
}

export const DEFAULT_DEFAULT_SKILLS: DefaultSkillsPreferences = {
  okidoki_agent: {
    enabled: true,
    abilities: defaultOkidokiAgentAbilities(),
  },
};

/** Sparse default skills: only the switches set at one level of an environment's fork chain. */
export const defaultSkillsOverridesSchema = z.strictObject({
  okidoki_agent: z.strictObject({
    enabled: z.boolean().optional(),
    abilities: z.partialRecord(z.enum(OKIDOKI_AGENT_ABILITIES), z.boolean()).optional(),
  }).optional(),
});
export type DefaultSkillsOverrides = z.infer<typeof defaultSkillsOverridesSchema>;

/** Layers overrides root first, so later keys win. */
export function mergeDefaultSkillsOverrides(
  layers: Array<DefaultSkillsOverrides | null | undefined>,
): DefaultSkillsOverrides {
  const enabled = layers.reduce<boolean | undefined>((current, layer) => layer?.okidoki_agent?.enabled ?? current, undefined);
  const abilities = Object.assign({}, ...layers.map((layer) => layer?.okidoki_agent?.abilities ?? {}));
  return { okidoki_agent: { ...(enabled === undefined ? {} : { enabled }), abilities } };
}

export function diffDefaultSkills(
  value: DefaultSkillsPreferences,
  inherited: DefaultSkillsPreferences,
): DefaultSkillsOverrides | null {
  const abilities = Object.fromEntries(OKIDOKI_AGENT_ABILITIES
    .filter((key) => value.okidoki_agent.abilities[key] !== inherited.okidoki_agent.abilities[key])
    .map((key) => [key, value.okidoki_agent.abilities[key]]));
  const enabledChanged = value.okidoki_agent.enabled !== inherited.okidoki_agent.enabled;
  if (!enabledChanged && Object.keys(abilities).length === 0) return null;
  return {
    okidoki_agent: {
      ...(enabledChanged ? { enabled: value.okidoki_agent.enabled } : {}),
      ...(Object.keys(abilities).length > 0 ? { abilities } : {}),
    },
  };
}

export function normalizeDefaultSkills(
  raw: DefaultSkillsOverrides | undefined | null,
): DefaultSkillsPreferences {
  const okidokiAgentRaw = raw?.okidoki_agent;
  const okidokiAgentEnabled =
    typeof okidokiAgentRaw?.enabled === 'boolean' ? okidokiAgentRaw.enabled : true;
  const abilitiesRaw = okidokiAgentRaw?.abilities ?? {};
  const abilities = defaultOkidokiAgentAbilities();
  for (const key of OKIDOKI_AGENT_ABILITIES) {
    // Locked abilities are forced on regardless of input — the platform
    // doesn't work if the agent can't read about Okidoki itself.
    if (OKIDOKI_AGENT_ABILITY_REGISTRY[key].locked) {
      abilities[key] = true;
      continue;
    }
    const value = abilitiesRaw[key];
    if (typeof value === 'boolean') {
      abilities[key] = value;
    }
  }

  return {
    okidoki_agent: {
      enabled: okidokiAgentEnabled,
      abilities,
    },
  };
}

export function getEnabledOkidokiAgentAbilities(
  defaultSkills: DefaultSkillsPreferences,
): OkidokiAgentAbility[] {
  if (!defaultSkills.okidoki_agent.enabled) return [];
  return OKIDOKI_AGENT_ABILITIES.filter(
    (ability) => defaultSkills.okidoki_agent.abilities[ability],
  );
}

const ENVIRONMENT_SETUP_REQUIRED_ABILITIES: OkidokiAgentAbility[] = [
  'okidoki', 'environment_setup', 'computer', 'media', 'previews', 'docker', 'github', 'gitlab',
];

export function buildEnvironmentSetupDefaultSkills(
  defaultSkills: DefaultSkillsPreferences,
): DefaultSkillsPreferences {
  const abilities = { ...defaultSkills.okidoki_agent.abilities };
  for (const ability of ENVIRONMENT_SETUP_REQUIRED_ABILITIES) abilities[ability] = true;
  return { okidoki_agent: { enabled: true, abilities } };
}

/**
 * Unlike {@link normalizeDefaultSkills}, this is an allowlist: abilities omitted from
 * `abilities` are disabled rather than defaulted on.
 */
// `okidoki` is locked on regardless; `slack` lets Scout reply and authorize in threads; the rest supply the context it triages from.
const SCOUT_ABILITIES: ReadonlySet<OkidokiAgentAbility> = new Set(['okidoki', 'slack', 'linear', 'github']);

export function buildScoutDefaultSkills(): DefaultSkillsPreferences {
  const flags: Partial<OkidokiAgentAbilityFlags> = {};
  for (const key of OKIDOKI_AGENT_ABILITIES) {
    flags[key] = SCOUT_ABILITIES.has(key) || OKIDOKI_AGENT_ABILITY_REGISTRY[key].locked === true;
  }
  if (!hasAllOkidokiAgentAbilities(flags)) throw new Error('Scout Okidoki agent ability flags are incomplete');
  return { okidoki_agent: { enabled: true, abilities: flags } };
}

/**
 * Organization-level security policies that admins can enforce.
 * These are separate from UserPreferences because they only apply at the org scope.
 */
export interface OrgSecurityPolicies {
  require_okidoki_account: boolean;
  require_github_connected: boolean;
  /** When true, all workspaces in this org attribute PRs to the user regardless of user preference */
  require_pr_user_attribution: boolean;
  block_agent_pr_merges: boolean;
}

export const DEFAULT_ORG_SECURITY_POLICIES: OrgSecurityPolicies = {
  require_okidoki_account: false,
  require_github_connected: false,
  require_pr_user_attribution: false,
  block_agent_pr_merges: false,
};

export function normalizeSecurityPolicies(raw?: Partial<OrgSecurityPolicies>): OrgSecurityPolicies {
  const policies = { ...DEFAULT_ORG_SECURITY_POLICIES, ...raw };

  if (policies.require_github_connected || policies.require_pr_user_attribution) {
    policies.require_okidoki_account = true;
  }

  return policies;
}

/**
 * Per-team Linear workflow state overrides keyed by Linear team id, then by
 * Okidoki concept. A value of `null`/missing means "use the name-match
 * heuristic" — only explicitly mapped kinds wire through.
 */
export type LinearTeamStateOverridesMap = Record<
  string,
  Partial<Record<LinearStateKind, string>>
>;

export const LINEAR_ROUTING_SKILL_MAX_LENGTH = 50_000;

export const linearRoutingSkillSchema = z.union([
  z.object({ name: z.string().min(1), content: z.string().trim().min(1).max(LINEAR_ROUTING_SKILL_MAX_LENGTH) }),
  z.object({ name: z.string().min(1), repository_id: z.string().regex(UUID_RE), path: z.string().min(1) }),
]);

export interface LinearRoutingPreferences {
  enabled: boolean;
  instructions?: string;
  skill?: z.infer<typeof linearRoutingSkillSchema>;
}

export interface OrgPreferences extends UserPreferences {
  memory_enabled: boolean;
  subagent_mcp_enabled: boolean;
  subagent_mcp_providers: AgentProvider[];
  credential_fallbacks_enabled: boolean;
  /** Members' workspaces use only their own coding agent credentials; workspaces with no member still use the organization's. */
  require_personal_credentials: boolean;
  security_policies?: OrgSecurityPolicies;
  linear_team_state_overrides?: LinearTeamStateOverridesMap;
  linear_agent_defaults?: AgentDefaultSettings;
  linear_routing?: LinearRoutingPreferences;
  slack_agent_defaults?: AgentDefaultSettings;
  enable_team_workspaces?: boolean;
  persist_chat_transcripts?: boolean;
  scout?: ScoutOrgPreferences;
  slack_onboarding?: (typeof SLACK_ONBOARDING_STATUSES)[number];
}

export const SLACK_ONBOARDING_STATUSES = ['pending', 'done'] as const;

export const DEFAULT_ENABLE_TEAM_WORKSPACES = false;
export const DEFAULT_PERSIST_CHAT_TRANSCRIPTS = true;
export const DEFAULT_MEMORY_ENABLED = true;
export const DEFAULT_SUBAGENT_MCP_ENABLED = false;
export const DEFAULT_CREDENTIAL_FALLBACKS_ENABLED = true;
export const DEFAULT_REQUIRE_PERSONAL_CREDENTIALS = false;
export interface GetOrgPreferencesResponse {
  preferences: OrgPreferences;
}

// Claude Code's autoCompactWindow accepts 100K to 1M tokens.
export const AUTO_COMPACT_TOKEN_OPTIONS = [100_000, 150_000, 200_000, 300_000, 500_000];

// Every turn re-reads the whole context, so long chats on a 1M window cost far more past this.
export const LONG_CONTEXT_AUTO_COMPACT_TOKENS = 400_000;

export interface GetAutoCompactConfigResponse {
  tokens: number | null;
}

export interface GetSubagentMcpConfigResponse {
  enabled: boolean;
  providers: AgentProvider[];
  disable_native?: boolean;
}

export interface GetOrgOpenRouterModelsResponse {
  models: string[];
}

export interface UpdateOrgPreferencesRequest {
  preferences: Partial<OrgPreferences>;
}

export interface UpdateOrgPreferencesResponse {
  success: boolean;
  preferences: OrgPreferences;
}

export interface PreferencesRecord {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  scope: PreferencesScope;
  preferences: UserPreferences | OrgPreferences;
}

export interface GetUserPreferencesResponse {
  preferences: ServedUserPreferences;
}

/** Saves merge `push_types`, so an update names only the types it changes. */
export type UserPreferencesUpdate = Omit<Partial<UserPreferences>, 'push_types'> & {
  push_types?: Partial<Record<PushType, boolean>>;
};

export interface UpdateUserPreferencesRequest {
  preferences: UserPreferencesUpdate;
}

export interface UpdateUserPreferencesResponse {
  success: boolean;
  preferences: ServedUserPreferences;
}
