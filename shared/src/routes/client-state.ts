export type ClientStateValue =
  | boolean
  | number
  | string
  | null
  | ClientStateValue[]
  | { [key: string]: ClientStateValue };

export interface ReadClientStateRequest {
  entries: Record<string, ClientStateValue>;
}

export interface ClientStateResponse {
  entries: Record<string, ClientStateValue>;
}

export interface UpdateClientStateRequest {
  entries: Record<string, ClientStateValue>;
}

export const MAX_CLIENT_STATE_ENTRIES_PER_REQUEST = 100;
export const MAX_CLIENT_STATE_REQUEST_BYTES = 5 * 1024 * 1024;
export const MAX_CLIENT_STATE_FIELDS_PER_USER = 1_000;
export const MAX_CLIENT_STATE_BYTES_PER_USER = 10 * 1024 * 1024;
export const MOBILE_AI_DATA_CONSENT_CLIENT_STATE_KEY = 'okidoki-mobile-ai-data-consent-v1';
export const THEME_PREFERENCE_STORAGE_KEY = 'okidoki-theme';
export const ACCENT_STORAGE_KEY = 'okidoki-accent';
export const PALETTE_STORAGE_KEY = 'okidoki-palette';
export const CUSTOM_THEME_STORAGE_KEY = 'okidoki-custom-theme';
export const SAVED_THEMES_STORAGE_KEY = 'okidoki-saved-themes';
export const THEME_STORAGE_KEYS = {
  theme: THEME_PREFERENCE_STORAGE_KEY,
  palette: PALETTE_STORAGE_KEY,
  accent: ACCENT_STORAGE_KEY,
  custom: CUSTOM_THEME_STORAGE_KEY,
} as const;

const CLIENT_STATE_KEYS = new Set([
  'dashboard-agent-selections',
  MOBILE_AI_DATA_CONSENT_CLIENT_STATE_KEY,
  ACCENT_STORAGE_KEY,
  'okidoki-create-workspace-selected-env',
  CUSTOM_THEME_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  'okidoki-provenance-expanded',
  'okidoki-provenance-pane-size',
  SAVED_THEMES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  'okidoki:dashboard-sidebar-open',
  'okidoki:dashboard-sidebar-width',
]);

export const WORKSPACE_LAST_VIEWED_AT_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-last-viewed-at-';
export const WORKSPACE_ATTACHED_IMAGES_DRAFT_KEY_PREFIX = 'okidoki-attached-images-';
export const WORKSPACE_ATTENTION_DONE_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-attention-done-';
export const PROVENANCE_EXPANDED_CLIENT_STATE_KEY_PREFIX =
  'okidoki-provenance-expanded-';
export const WORKSPACE_SPLITS_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-splits-v1-';
export const WORKSPACE_LIST_VIEW_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-list-view-';
export const WORKSPACE_SECTION_ORDER_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-section-order-';
const WORKSPACE_SHIP_ORDER_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-ship-order-';
export const WORKSPACE_STAGES_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-stages-';
export const WORKSPACE_MARKED_UNREAD_CLIENT_STATE_KEY_PREFIX =
  'okidoki-workspace-marked-unread-';
const WORKSPACE_PINNED_CLIENT_STATE_KEY_PREFIX = 'okidoki-pinned-workspaces-';
const PROMPT_HISTORY_CLIENT_STATE_KEY_PREFIX = 'okidoki-prompt-history-';
const WORKSPACE_SEARCH_OPENS_CLIENT_STATE_KEY_PREFIX = 'okidoki-workspace-search-opens-';
const AGENT_PREFERENCES_CLIENT_STATE_KEY_PREFIX = 'agent-preferences-';

const CLIENT_STATE_KEY_PREFIXES = [
  AGENT_PREFERENCES_CLIENT_STATE_KEY_PREFIX,
  'okidoki-active-content-tab-',
  'okidoki-active-diff-comment-draft-',
  'okidoki-diff-comments-',
  'okidoki-draft-',
  'okidoki-environment-order-',
  WORKSPACE_PINNED_CLIENT_STATE_KEY_PREFIX,
  'okidoki-plan-quotes-',
  PROMPT_HISTORY_CLIENT_STATE_KEY_PREFIX,
  'okidoki-provenance-artifact-lens-',
  PROVENANCE_EXPANDED_CLIENT_STATE_KEY_PREFIX,
  'okidoki-provenance-lens-',
  'okidoki-selected-chat-',
  'okidoki-selected-models-',
  'okidoki-selected-organization:',
  'okidoki-show-archived-workspaces-',
  'okidoki-tool-question-draft-',
  'okidoki-viewed-diffs-v1:',
  WORKSPACE_ATTENTION_DONE_CLIENT_STATE_KEY_PREFIX,
  'okidoki-workspace-filters-',
  WORKSPACE_LAST_VIEWED_AT_CLIENT_STATE_KEY_PREFIX,
  WORKSPACE_LIST_VIEW_CLIENT_STATE_KEY_PREFIX,
  WORKSPACE_MARKED_UNREAD_CLIENT_STATE_KEY_PREFIX,
  'okidoki-workspace-notes-',
  'okidoki-workspace-order-',
  WORKSPACE_SEARCH_OPENS_CLIENT_STATE_KEY_PREFIX,
  'okidoki-workspace-organization-',
  'okidoki-workspace-sort-',
  WORKSPACE_SECTION_ORDER_CLIENT_STATE_KEY_PREFIX,
  WORKSPACE_SHIP_ORDER_CLIENT_STATE_KEY_PREFIX,
  WORKSPACE_STAGES_CLIENT_STATE_KEY_PREFIX,
  WORKSPACE_SPLITS_CLIENT_STATE_KEY_PREFIX,
  'okidoki-workspace-views-',
  'okidoki:chat-tab-order:',
  'okidoki:collapsed-mobile-environments:',
  'okidoki:mobile-chat-drafts:',
  'ws-folder-',
] as const;

const orgUserClientStateKey = (prefix: string) => (organizationId: string, userId: string): string =>
  `${prefix}${organizationId}-${userId}`;

export const workspaceLastViewedAtClientStateKey = orgUserClientStateKey(WORKSPACE_LAST_VIEWED_AT_CLIENT_STATE_KEY_PREFIX);
export const workspaceAttentionDoneClientStateKey = orgUserClientStateKey(WORKSPACE_ATTENTION_DONE_CLIENT_STATE_KEY_PREFIX);
export const workspaceStagesClientStateKey = orgUserClientStateKey(WORKSPACE_STAGES_CLIENT_STATE_KEY_PREFIX);
export const workspaceSectionOrderClientStateKey = orgUserClientStateKey(WORKSPACE_SECTION_ORDER_CLIENT_STATE_KEY_PREFIX);
export const workspaceShipOrderClientStateKey = orgUserClientStateKey(WORKSPACE_SHIP_ORDER_CLIENT_STATE_KEY_PREFIX);
export const workspaceMarkedUnreadClientStateKey = orgUserClientStateKey(WORKSPACE_MARKED_UNREAD_CLIENT_STATE_KEY_PREFIX);
export const workspacePinnedClientStateKey = orgUserClientStateKey(WORKSPACE_PINNED_CLIENT_STATE_KEY_PREFIX);
export const promptHistoryClientStateKey = orgUserClientStateKey(PROMPT_HISTORY_CLIENT_STATE_KEY_PREFIX);
export const workspaceSearchOpensClientStateKey = orgUserClientStateKey(WORKSPACE_SEARCH_OPENS_CLIENT_STATE_KEY_PREFIX);
export const agentPreferencesClientStateKey = (workspaceId: string): string => `${AGENT_PREFERENCES_CLIENT_STATE_KEY_PREFIX}${workspaceId}`;

export function isClientStateKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 300
    && !/(?:^|[-:])(none|unknown|unresolved|unscoped)$/.test(value)
    && (CLIENT_STATE_KEYS.has(value)
      || CLIENT_STATE_KEY_PREFIXES.some((prefix) => value.startsWith(prefix)));
}

export function isClientStateValue(value: unknown): value is ClientStateValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isClientStateValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isClientStateValue);
}
