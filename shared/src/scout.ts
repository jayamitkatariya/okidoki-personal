export const SCOUT_SOURCE_TYPES = ['slack', 'linear'] as const;
export type ScoutSourceType = (typeof SCOUT_SOURCE_TYPES)[number];

/** Lowest to highest. `tagged` hears only @Okidoki; the rest decide which untagged messages also reach Scout. */
export const SCOUT_PROACTIVITY_LEVELS = ['tagged', 'conservative', 'balanced', 'proactive'] as const;
export type ScoutProactivity = (typeof SCOUT_PROACTIVITY_LEVELS)[number];
export const DEFAULT_SCOUT_PROACTIVITY: ScoutProactivity = 'conservative';
export const SCOUT_EXTERNAL_CHANNEL_PROACTIVITY: ScoutProactivity = 'tagged';

export interface ScoutMonitoredSource {
  source: ScoutSourceType;
  external_id: string;
  instructions?: string;
  preset_id?: string;
  /** Slack only. Overrides the organization's level for this channel. */
  proactivity?: ScoutProactivity;
  /** Slack only. Overrides `mute_slack_connect` for this channel. */
  muted?: boolean;
}

export interface ScoutSlackConnectDefaults {
  preset_id?: string;
  instructions?: string;
  proactivity?: ScoutProactivity;
}

export type ScoutMonitoredChannel = ScoutMonitoredSource;

export function getScoutSourceId(source: ScoutSourceType, externalId: string): string {
  return `${source}:${externalId}`;
}

export const SCOUT_PRESET_NAME_MAX_LENGTH = 50;

export const SCOUT_THREAD_MUTE_TTL_HOURS = 6;

export const SCOUT_CHANNEL_SETTINGS_OFFERS = ['proactivity', 'raise_proactivity', 'instructions'] as const;
export const SCOUT_SETTINGS_OFFERS = [...SCOUT_CHANNEL_SETTINGS_OFFERS, 'organization_proactivity', 'raise_organization_proactivity'] as const;
export type ScoutSettingsOffer = (typeof SCOUT_SETTINGS_OFFERS)[number];

export const SCOUT_PRESET_ICONS = [
  'users', 'user', 'inbox', 'building', 'bug', 'message-circle',
  'headphones', 'heart', 'star', 'flag', 'zap', 'shield',
  'code', 'terminal', 'rocket', 'wrench', 'briefcase', 'globe',
  'book-open', 'lightbulb', 'target', 'bell', 'layers', 'tag',
] as const;

export type ScoutPresetIcon = typeof SCOUT_PRESET_ICONS[number];

export interface ScoutPreset {
  id: string;
  name: string;
  description?: string;
  icon?: ScoutPresetIcon;
  instructions: string;
}

export interface ScoutOrgPreferences {
  /** Slack entries carry a channel's own level and instructions; Linear teams are monitored only when listed. */
  monitored: ScoutMonitoredSource[];
  channel_presets?: ScoutPreset[];
  proactivity?: ScoutProactivity;
  mute_slack_connect?: boolean;
  slack_connect_defaults?: ScoutSlackConnectDefaults;
}

export const SCOUT_PRESETS: ScoutPreset[] = [
  {
    id: 'customer',
    name: 'Customer',
    icon: 'user',
    description: 'For customer channels. Keeps internal links and details private and leaves product decisions to your team.',
    instructions: `This is a customer channel.

- Answer clear informational and clarifying questions directly.
- For a trivial bug with an obvious fix, start the work without asking for confirmation. Do not post pull request links, workspace links, or internal implementation details in this channel.
- For feature requests, product decisions, or substantial work, do not respond or take action. Leave the conversation to internal teammates.`,
  },
  {
    id: 'triage',
    name: 'Triage',
    icon: 'bug',
    description: 'For bug-report channels. Investigates each report, checks for duplicates, and shares findings in the thread.',
    instructions: `This channel collects recurring issue reports and requests, such as Linear Triage or a bug-report channel.

- Triage each new Linear issue and each Slack report or request that pings Okidoki.
- Investigate the report, check for related work or duplicates, and act on clear, actionable bugs and requests.
- Ask for missing details when needed. Leave ambiguous product decisions and prioritization to the team.
- Share concise findings, progress, and workspace or pull request links in the originating thread.`,
  },
  {
    id: 'internal',
    name: 'Internal',
    icon: 'building',
    description: 'For your own team. Shares workspace and pull request links freely.',
    instructions: `This is an internal team channel.

- Answer clear questions directly and act on concrete requests addressed to Okidoki.
- Ask before acting only when a task is genuinely ambiguous or addressed to another person.
- Share concise workspace and pull request updates in the originating thread.`,
  },
];

export function resolveScoutChannelInstructions(
  channel: { instructions?: string; preset_id?: string },
  presets: ScoutPreset[],
): string | undefined {
  const presetInstructions = presets.find((preset) => preset.id === channel.preset_id)?.instructions;
  return [presetInstructions, channel.instructions].filter(Boolean).join('\n\n') || undefined;
}

export function resolveScoutChannelSource<T extends { instructions?: string; preset_id?: string }>(
  entry: T | undefined,
  external: boolean,
  slackConnectDefaults: ScoutSlackConnectDefaults | undefined,
): T | ScoutSlackConnectDefaults | undefined {
  return entry?.preset_id || entry?.instructions || !external ? entry : slackConnectDefaults;
}

/** The level a shared channel stores when it gets settings but no level of its own: Mentions only until the organization sets a shared-channel level, so settings alone never raise it. */
export function storedSlackConnectLevel(defaults: ScoutSlackConnectDefaults | undefined): ScoutProactivity | undefined {
  return defaults?.proactivity ? undefined : SCOUT_EXTERNAL_CHANNEL_PROACTIVITY;
}

/** `external` means a Slack Connect channel no Manager is linked to; an entry without its own level follows the organization's, as one an admin added did before levels. A Manager's linked channel is its inbox, so it hears at least Balanced. */
export function resolveScoutChannelProactivity(
  entry: { proactivity?: ScoutProactivity } | undefined,
  organization: ScoutProactivity,
  external: boolean,
  slackConnectDefaults: ScoutSlackConnectDefaults | undefined,
  manager = false,
): ScoutProactivity {
  if (entry?.proactivity) return entry.proactivity;
  if (manager) return SCOUT_PROACTIVITY_LEVELS.indexOf(organization) < SCOUT_PROACTIVITY_LEVELS.indexOf('balanced') ? 'balanced' : organization;
  // Until the organization sets a shared-channel level, a shared channel's entry stores its level, so one without it predates levels.
  return external && (!entry || slackConnectDefaults?.proactivity)
    ? slackConnectDefaults?.proactivity ?? SCOUT_EXTERNAL_CHANNEL_PROACTIVITY
    : organization;
}

/** A muted channel hears messages as its level allows, but nothing Okidoki does can post, react, or start work there. `external` is as in `resolveScoutChannelProactivity`. */
export function resolveScoutChannelMuted(
  entry: { muted?: boolean } | undefined,
  muteSlackConnect: boolean,
  external: boolean,
): boolean {
  return entry?.muted ?? (external && muteSlackConnect);
}
