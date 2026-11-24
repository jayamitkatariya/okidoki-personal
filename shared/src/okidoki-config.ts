import { parse as parseYaml } from 'yaml';
import { createErrorResult, createSuccessResult, type Result } from './result';
import { parseWarmHookConfig } from './warm-hooks';
import { okidokiEnvironmentConfigSchema, type OkidokiEnvironmentConfig } from './environment-config';

export interface StartHookConfig {
  timeout?: number;
  commands: string[];
  separate?: boolean;
}

export interface WarmHookConfig {
  commands: string[];
  timeout?: number;
  separate?: boolean;
}

export interface OkidokiConfig {
  infra?: string;
  organizationId?: string;
  systemPrompt?: string;
  startHook?: StartHookConfig;
  warmHook?: string | WarmHookConfig;
  environment?: OkidokiEnvironmentConfig;
}

/**
 * Config file names in priority order: JSON first, then YAML.
 */
export const OKIDOKI_CONFIG_FILENAMES = ['okidoki.json', 'okidoki.yaml', 'okidoki.yml'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse and validate a raw object into a OkidokiConfig.
 * Throws descriptive errors for invalid fields.
 */
export function parseOkidokiConfig(value: unknown, filename = 'okidoki.json'): OkidokiConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${filename}: expected an object`);
  }

  const config: OkidokiConfig = {};

  if ('infra' in value) {
    if (typeof value.infra !== 'string' || !value.infra.trim()) {
      throw new Error(`Invalid ${filename}: "infra" must be a non-empty file path`);
    }
    if ('environment' in value) throw new Error(`Invalid ${filename}: use either "infra" or "environment", not both`);
    config.infra = value.infra;
  }


  if ('organizationId' in value) {
    if (typeof value.organizationId !== 'string') {
      throw new Error(`Invalid ${filename}: "organizationId" must be a string`);
    }
    config.organizationId = value.organizationId;
  }

  if ('systemPrompt' in value) {
    if (typeof value.systemPrompt !== 'string') {
      throw new Error(`Invalid ${filename}: "systemPrompt" must be a string`);
    }
    config.systemPrompt = value.systemPrompt;
  }

  if ('startHook' in value) {
    if (!isRecord(value.startHook)) {
      throw new Error(`Invalid ${filename}: "startHook" must be an object with "commands" array`);
    }
    const { commands, timeout, separate } = value.startHook;

    if (!Array.isArray(commands) || !commands.every((entry) => typeof entry === 'string')) {
      throw new Error(`Invalid ${filename}: "startHook.commands" must be an array of shell commands`);
    }

    if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0)) {
      throw new Error(`Invalid ${filename}: "startHook.timeout" must be a positive number`);
    }

    if (separate !== undefined && typeof separate !== 'boolean') {
      throw new Error(`Invalid ${filename}: "startHook.separate" must be a boolean`);
    }

    config.startHook = { commands, timeout, separate };
  }

  if ('warmHook' in value) {
    config.warmHook = parseWarmHookConfig(value.warmHook, filename);
  }

  if ('environment' in value) {
    const parsed = okidokiEnvironmentConfigSchema.safeParse(value.environment);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid ${filename}: "environment${issue.path.length ? `.${issue.path.join('.')}` : ''}" ${issue.message}`);
    }
    config.environment = parsed.data;
  }

  return config;
}

export function repositorySystemPrompts(repositories: { repoName: string; config: OkidokiConfig }[]): string[] {
  return repositories.flatMap(({ repoName, config }) => {
    const prompt = typeof config.systemPrompt === 'string' ? config.systemPrompt.trim() : '';
    return prompt ? [`[${repoName}] ${prompt}`] : [];
  });
}

/**
 * Parse a config string as JSON or YAML based on the filename extension.
 * Returns a validated OkidokiConfig.
 */
export function parseOkidokiConfigString(content: string, filename: string): OkidokiConfig {
  const isYaml = filename.endsWith('.yaml') || filename.endsWith('.yml');

  let parsed: unknown;
  if (isYaml) {
    parsed = parseYaml(content);
  } else {
    parsed = JSON.parse(content);
  }

  return parseOkidokiConfig(parsed, filename);
}

export async function resolveOkidokiEnvironmentConfig<K extends number>(
  entrypoint: { filename: string; config: OkidokiConfig },
  loadInfra: (pointer: string) => Promise<Result<{ filename: string; config: OkidokiConfig }, K>>,
): Promise<Result<{ filename: string; config: OkidokiConfig & { environment: OkidokiEnvironmentConfig } }, K | 400>> {
  let selected = entrypoint;
  if (entrypoint.config.infra) {
    const target = await loadInfra(entrypoint.config.infra);
    if (!target.ok) return target;
    selected = target.data;
    if (selected.config.infra) return createErrorResult({ message: `${selected.filename}: nested infra pointers are not supported; declare an "environment" section`, code: 400 });
  }
  if (!selected.config.environment) return createErrorResult({ message: `${selected.filename} needs an "environment" section${entrypoint.config.infra ? '' : ' or an "infra" pointer to a file containing one'} before it can manage an environment`, code: 400 });
  return createSuccessResult({ filename: selected.filename, config: { ...entrypoint.config, environment: selected.config.environment } });
}
