import { z } from 'zod';
import { okidokiEnvironmentConfigSchema, type OkidokiEnvironmentConfig } from '../environment-config';

export const ENVIRONMENT_CONFIG_FIELDS = ['systemPrompt', 'warmHook', 'startHook'] as const;
export const ENVIRONMENT_CONFIG_PREFERENCES = [['memory', 'memory'], ['gpu', 'gpu'], ['mobileTesting', 'mobile_testing'], ['defaultSkills', 'default_skills'], ['setupSourceMode', 'setup_source_mode']] as const;
export const ENVIRONMENT_CONFIG_SETTING_FIELDS = ['repositories', 'workspaceSize', 'inheritRepositories', ...ENVIRONMENT_CONFIG_PREFERENCES.map(([field]) => field)] as const;
type EnvironmentConfigSettingField = (typeof ENVIRONMENT_CONFIG_SETTING_FIELDS)[number];
type EnvironmentConfigField = (typeof ENVIRONMENT_CONFIG_FIELDS)[number];
export type EnvironmentConfigManagedField = EnvironmentConfigField | EnvironmentConfigSettingField;

export const environmentConfigLocationSchema = z.union([
  z.object({
    kind: z.literal('git').default('git'),
    entrypoint_filename: z.string().optional(),
    repository_id: z.string(), repository_name: z.string(), filename: z.string(),
    commit_sha: z.string(), source_url: z.string(), file_sha: z.undefined().optional(),
  }),
  z.object({
    kind: z.literal('file'),
    repository_id: z.null(), repository_name: z.null(), filename: z.string(),
    commit_sha: z.null(), source_url: z.null(), file_sha: z.string(),
  }),
]);
export type EnvironmentConfigLocation = z.output<typeof environmentConfigLocationSchema>;
type EnvironmentConfigResponseLocation = z.input<typeof environmentConfigLocationSchema>;

export type EnvironmentConfigSource = EnvironmentConfigResponseLocation & {
  synced_at: string;
  managed: {
    variables: string[];
    mcps: string[];
    fields: EnvironmentConfigManagedField[];
    files?: string[];
    skills?: string[];
  };
  required_secrets: string[];
  required_plugins?: string[];
  pending_rebuild: boolean;
  last_error: string | null;
}

export type EnvironmentConfigPreview = EnvironmentConfigResponseLocation & {
  fingerprint: string;
  source_changed?: boolean;
  required_secrets?: { before: string[]; after: string[] };
  changes: Array<{
    kind: 'variable' | 'mcp' | 'file' | 'skill' | 'plugin' | EnvironmentConfigManagedField;
    key: string;
    operation: 'create' | 'update' | 'remove' | 'adopt';
    content?: { before: string | null; after: string | null; changed: boolean };
  }>;
  missing_secrets: string[];
  blockers: string[];
}

const sourceInput = {
  repository_id: z.string().min(1).optional(),
  file: z.strictObject({ filename: z.string().min(1).max(1024), environment: okidokiEnvironmentConfigSchema }).optional(),
};
export const previewEnvironmentConfigSourceRequestSchema = z.strictObject(sourceInput).refine(
  (input) => !input.file || !input.repository_id,
  { message: 'Choose either a repository or a file' },
);
export type PreviewEnvironmentConfigSourceRequest = z.infer<typeof previewEnvironmentConfigSourceRequestSchema>;

export const applyEnvironmentConfigSourceRequestSchema = z.strictObject({
  ...sourceInput,
  commit_sha: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
}).refine((input) => input.file ? !input.repository_id && !input.commit_sha : !!input.commit_sha, {
  message: 'File configuration requires file contents; Git configuration requires a reviewed commit',
});
export type ApplyEnvironmentConfigSourceRequest = z.infer<typeof applyEnvironmentConfigSourceRequestSchema>;

export interface GetEnvironmentConfigSourceResponse {
  source: EnvironmentConfigSource | null;
}

export interface PreviewEnvironmentConfigSourceResponse {
  preview: EnvironmentConfigPreview;
}

export interface ApplyEnvironmentConfigSourceResponse {
  source: EnvironmentConfigSource;
}

export interface DeleteEnvironmentConfigSourceResponse {
  source: null;
}

export interface GetEnvironmentConfigDefinitionResponse {
  environment: OkidokiEnvironmentConfig | null;
}

export const validateEnvironmentConfigRequestSchema = z.strictObject({ environment: okidokiEnvironmentConfigSchema });
export interface ValidateEnvironmentConfigResponse { valid: true }

export interface ExportEnvironmentConfigResponse {
  environment: OkidokiEnvironmentConfig;
  warnings: string[];
}
