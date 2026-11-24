import { z } from 'zod';
import { defaultSkillsOverridesSchema } from './routes/preferences';
import { OKIDOKI_AGENT_ABILITIES, OKIDOKI_AGENT_ABILITY_REGISTRY } from './default-skills/okidoki-agent/registry';
import { ENVIRONMENT_SETUP_SOURCE_MODES, environmentMcpStdioConfigSchema, environmentMcpHttpConfigSchema, environmentMcpVariableReferenceSchema, isReservedMcpName, MCP_NAME_PATTERN, validateEnvironmentMcpAuthentication, type EnvironmentMcpConfig, type EnvironmentMcpVariableReference } from './routes/environment';
import { WORKSPACE_SIZE_OPTIONS } from './sandbox';
import { validateEnvironmentFilePath } from './environment-files';
import { isPluginId } from './routes/plugins';
import { VARIABLE_KEY_RE } from './routes/environment-setups';

const variableNameSchema = z.string().regex(VARIABLE_KEY_RE, 'must be a valid environment variable name');
const mcpValueSchema = z.union([
  z.string(),
  environmentMcpVariableReferenceSchema,
]);
const mcpValuesSchema = z.record(z.string(), mcpValueSchema);
const httpConfigSchema = environmentMcpHttpConfigSchema.pick({ url: true, auth: true }).extend({
  headers: mcpValuesSchema.default({}),
}).strict();

export const okidokiMcpDefinitionSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    config: environmentMcpStdioConfigSchema.pick({ command: true }).extend({
      args: environmentMcpStdioConfigSchema.shape.args.unwrap().default([]),
      env: z.record(variableNameSchema, mcpValueSchema).default({}),
    }).strict(),
  }),
  z.strictObject({ transport: z.literal('http'), config: httpConfigSchema }),
  z.strictObject({ transport: z.literal('sse'), config: httpConfigSchema }),
]).superRefine((definition, context) => {
  if (definition.transport === 'stdio') return;
  const result = validateEnvironmentMcpAuthentication(definition.transport, definition.config);
  if (!result.ok) context.addIssue({ code: 'custom', path: result.error.code === 'transport' ? ['transport'] : ['config', result.error.code ?? 'auth'], message: result.error.message });
});

type OkidokiMcpDefinition = z.infer<typeof okidokiMcpDefinitionSchema>;

export const okidokiEnvironmentConfigSchema = z.strictObject({
  inheritRepositories: z.boolean().optional(),
  memory: z.strictObject({ read: z.boolean().optional(), write: z.boolean().optional() }).nullable().optional(),
  gpu: z.boolean().nullable().optional(),
  mobileTesting: z.boolean().nullable().optional(),
  setupSourceMode: z.enum(ENVIRONMENT_SETUP_SOURCE_MODES).nullable().optional(),
  defaultSkills: defaultSkillsOverridesSchema.superRefine((skills, context) => {
    for (const ability of OKIDOKI_AGENT_ABILITIES) if (skills.okidoki_agent?.abilities?.[ability] === false && OKIDOKI_AGENT_ABILITY_REGISTRY[ability].locked) context.addIssue({ code: 'custom', path: ['okidoki_agent', 'abilities', ability], message: 'This built-in ability cannot be disabled' });
  }).nullable().optional(),
  repositories: z.array(z.string().trim().min(1)).optional(),
  workspaceSize: z.enum(WORKSPACE_SIZE_OPTIONS).optional(),
  files: z.record(z.string().trim().refine((path) => !validateEnvironmentFilePath(path), 'must be a file path starting with ~/'), z.strictObject({
    name: z.string().trim().min(1).optional(), content: z.string().max(65536),
  })).optional(),
  skills: z.record(z.string().trim().min(1), z.strictObject({ source: z.string().trim().min(1), name: z.string().trim().min(1).optional() })).optional(),
  requiredPlugins: z.array(z.string().refine(isPluginId, 'must be a supported plugin')).transform((plugins) => [...new Set(plugins)]).optional(),
  systemPrompt: z.string().optional(),
  warmHook: z.string().optional(),
  startHook: z.string().optional(),
  variables: z.record(variableNameSchema, z.string()).optional(),
  requiredSecrets: z.array(variableNameSchema).optional(),
  mcps: z.record(z.string().regex(MCP_NAME_PATTERN, 'must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit').refine((name) => !isReservedMcpName(name), 'is reserved for Okidoki'), okidokiMcpDefinitionSchema).optional(),
}).superRefine((config, context) => {
  if (config.inheritRepositories === true && config.repositories !== undefined) context.addIssue({ code: 'custom', path: ['repositories'], message: 'Inherited repositories cannot also be declared explicitly' });
  const skillNames = Object.keys(config.skills ?? {}).map((slug) => slug.toLowerCase());
  if (new Set(skillNames).size !== skillNames.length) context.addIssue({ code: 'custom', path: ['skills'], message: 'Skill slugs must be unique regardless of case' });
  const names = new Set<string>();
  for (const name of Object.keys(config.mcps ?? {})) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      context.addIssue({ code: 'custom', path: ['mcps', name], message: 'MCP names must be unique regardless of case' });
    }
    names.add(normalized);
  }
  for (const key of config.requiredSecrets ?? []) {
    if (config.variables && Object.hasOwn(config.variables, key)) {
      context.addIssue({ code: 'custom', path: ['requiredSecrets'], message: `"${key}" cannot also be declared as a non-secret variable` });
    }
  }
});

export type OkidokiEnvironmentConfig = z.infer<typeof okidokiEnvironmentConfigSchema>;

export function getOkidokiMcpReferencedVariables(definition: OkidokiMcpDefinition): string[] {
  const values = definition.transport === 'stdio' ? definition.config.env : definition.config.headers;
  return [...new Set(Object.values(values).flatMap((value) => typeof value === 'string' ? [] : [value.env]))];
}

export function storeOkidokiMcpConfig(definition: OkidokiMcpDefinition): EnvironmentMcpConfig {
  const values = definition.transport === 'stdio' ? definition.config.env : definition.config.headers;
  const literals: Record<string, string> = Object.create(null);
  const references: Record<string, EnvironmentMcpVariableReference> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') literals[key] = value;
    else references[key] = value;
  }
  const hasReferences = Object.keys(references).length > 0;
  if (definition.transport === 'stdio') {
    return { ...definition.config, env: literals, ...(hasReferences ? { envFrom: references } : {}) };
  }
  return { ...definition.config, headers: literals, ...(hasReferences ? { headersFrom: references } : {}) };
}

export function resolveEnvironmentMcpConfig(config: EnvironmentMcpConfig, variables: Record<string, string>): EnvironmentMcpConfig {
  const resolveReferences = (references: Record<string, EnvironmentMcpVariableReference> | undefined) => Object.fromEntries(
    Object.entries(references ?? {}).map(([key, reference]) => {
      if (!Object.hasOwn(variables, reference.env)) throw new Error(`Missing MCP environment variable "${reference.env}"`);
      return [key, `${reference.prefix ?? ''}${variables[reference.env]}`];
    }),
  );
  if ('command' in config) {
    const { envFrom, ...concrete } = config;
    return { ...concrete, env: { ...config.env, ...resolveReferences(envFrom) } };
  }
  const { headersFrom, ...concrete } = config;
  return { ...concrete, headers: { ...config.headers, ...resolveReferences(headersFrom) } };
}
