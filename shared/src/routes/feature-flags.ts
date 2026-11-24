// Feature Flags

/** Well-known feature flag names */
export const FEATURE_FLAGS = {
  LLM_ENVIRONMENT_AUTOSELECT: 'llm_environment_autoselect',
  STATIC_EGRESS: 'static_egress',
  ENVIRONMENT_CONFIG_IN_GIT: 'environment_config_in_git',
  LIVE_ACTIVITY_ALERTS: 'live_activity_alerts',
  OKIDOKI_HARNESS: 'okidoki-harness',
  MACOS_SANDBOXES: 'macos_sandboxes',
  BROWSER_TAB: 'browser_tab',
  AUTO_SIZE_CPU_FLOOR: 'auto_size_cpu_floor',
} as const;

export interface FeatureFlagRecord {
  id: string;
  organization_id: string;
  flag: string;
  created_at: string;
  created_by: string | null;
}

// Org-facing: get flags for current org
export interface GetFeatureFlagsResponse {
  flags: string[];
}

// Admin: list flags for an org
export interface AdminGetOrgFeatureFlagsResponse {
  flags: FeatureFlagRecord[];
}

// Admin: add a flag to an org
export interface AdminAddFeatureFlagRequest {
  flag: string;
}

export interface AdminAddFeatureFlagResponse {
  flag: FeatureFlagRecord;
}

// Admin: remove a flag from an org
export interface AdminRemoveFeatureFlagResponse {
  success: boolean;
}

// Admin: list all orgs that have a given flag
export interface AdminListFlagOrgsResponse {
  organizations: { id: string; name: string; plan: string }[];
}
