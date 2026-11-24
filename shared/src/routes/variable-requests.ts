import { z } from 'zod';
import { ENVIRONMENT_SETUP_LIMITS, VARIABLE_KEY_RE } from './environment-setups';

export const VARIABLE_REQUEST_WAIT = { defaultMs: 10 * 60_000, maxMs: 30 * 60_000, pollMs: 3_000, waiterStaleMs: 15_000 };

export const VARIABLE_REQUEST_DESTINATIONS = ['environment', 'workspace'] as const;
type VariableRequestDestination = (typeof VARIABLE_REQUEST_DESTINATIONS)[number];

const requestedVariableSchema = z.object({
  key: z.string().regex(VARIABLE_KEY_RE, 'must be a valid environment variable name').max(ENVIRONMENT_SETUP_LIMITS.variableKeyChars),
  required: z.boolean(),
  replace: z.boolean().optional(),
});

export type RequestedVariable = z.infer<typeof requestedVariableSchema>;

export const requestedVariablesSchema = z.array(requestedVariableSchema)
  .min(1, 'must not be empty')
  .max(ENVIRONMENT_SETUP_LIMITS.variables)
  .refine((variables) => new Set(variables.map((variable) => variable.key)).size === variables.length, 'must have unique keys');

export const createVariableRequestSchema = z.object({
  variables: requestedVariablesSchema,
  reason: z.string().trim().max(500).nullish().transform((value) => value || null),
  wait: z.boolean().default(true),
});

export const respondVariableRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('provide'),
    destination: z.enum(VARIABLE_REQUEST_DESTINATIONS),
    /** Defaults to the workspace's environment, so older clients keep saving there. */
    environment_ids: z.array(z.string().uuid()).optional(),
    overwrite: z.boolean().optional(),
    values: z.record(z.string().regex(VARIABLE_KEY_RE), z.string()),
  }),
  z.object({ action: z.literal('skip') }),
]);

export type RespondVariableRequest = z.input<typeof respondVariableRequestSchema>;

export interface VariableRequestRecord {
  id: string;
  workspace_id: string;
  reason: string | null;
  variables: RequestedVariable[];
  status: 'pending' | 'provided' | 'skipped';
  destination: VariableRequestDestination | null;
  provided_keys: string[];
  created_at: string;
  resolved_at: string | null;
}

export interface VariableRequestResponse {
  request: VariableRequestRecord;
}

/** `wait` is false for `--no-wait` and when nobody is likely watching the dashboard (Slack, Linear, automations), where the agent shares `url` instead of blocking. */
export interface CreateVariableRequestResponse extends VariableRequestResponse {
  url: string;
  wait: boolean;
}

export interface VariableRequestEnvironment {
  id: string;
  name: string;
  personal: boolean;
  existing_keys: string[];
  locked_keys: string[];
}

export interface WorkspaceVariableRequestsResponse {
  requests: Array<VariableRequestRecord & { set_keys: string[]; locked_keys: string[] }>;
  environment: { id: string; name: string; can_write: boolean } | null;
  environments: VariableRequestEnvironment[];
}

export interface LoadVariableRequestResponse {
  variables: Array<{ key: string; value: string }>;
  already_loaded: string[];
  missing: string[];
}

export const VARIABLE_REQUESTS_QUERY_ROOT = 'variable-requests';

export const variableRequestsQueryKey = (organizationId: string | null, workspaceId: string | null) =>
  [VARIABLE_REQUESTS_QUERY_ROOT, organizationId, workspaceId];

export function variableRequestFormState(params: {
  data: WorkspaceVariableRequestsResponse;
  request: WorkspaceVariableRequestsResponse['requests'][number];
  environmentIds: string[] | null;
  values: Record<string, string>;
}) {
  const { data, request, values } = params;
  const workspaceEnvironmentId = data.environment?.id;
  const selected = data.environments.filter((environment) => params.environmentIds?.includes(environment.id));
  const environmentIds = selected.map((environment) => environment.id);
  const destination: VariableRequestDestination = selected.length > 0 ? 'environment' : 'workspace';
  const rows = request.variables.map((variable) => ({
    ...variable,
    saved: request.set_keys.includes(variable.key),
    locked: selected.find((environment) => environment.locked_keys.includes(variable.key))?.name ?? null,
  }));
  const filled = rows.filter((row) => !row.locked && (values[row.key] ?? '').length > 0);
  const filledKeys = filled.map((row) => row.key);
  return {
    destination,
    environmentIds,
    summary: selected.length === 0 ? 'This workspace only' : selected.length === 1 ? selected[0].name : `${selected.length} environments`,
    groups: [
      { heading: 'Personal', all: 'All my environments', personal: true },
      { heading: 'Shared', all: 'All shared environments', personal: false },
    ].map(({ personal, ...group }) => {
      const environments = data.environments.filter((environment) => environment.personal === personal);
      const allIds = environments.filter((environment) => environment.locked_keys.length === 0).map((environment) => environment.id);
      return {
        ...group,
        allIds,
        allSelected: allIds.every((id) => environmentIds.includes(id)),
        environments: environments.map((environment) => ({
          ...environment,
          selected: environmentIds.includes(environment.id),
          note: [
            environment.id === workspaceEnvironmentId && 'this workspace',
            environment.locked_keys.length > 0 ? 'locked' : environment.existing_keys.length > 0 && 'will overwrite',
          ].filter(Boolean).join(' · '),
        })),
      };
    }),
    select: (ids: string[], on: boolean) => [...environmentIds.filter((id) => !ids.includes(id)), ...(on ? ids : [])],
    rows,
    filled,
    hintKey: rows.find((row) => !row.saved && !row.locked)?.key,
    canSubmit: rows.every((row) => !row.required || row.saved || (!row.locked && values[row.key])) && (filled.length > 0 || rows.some((row) => row.saved)),
    submitValues: Object.fromEntries(filled.map((row) => [row.key, values[row.key]])),
    // The workspace's own environment holds the value the agent asked for, so replacing it there needs no confirmation.
    overwrites: selected.flatMap((environment) => {
      const keys = environment.existing_keys.filter((key) => filledKeys.includes(key));
      return environment.id !== workspaceEnvironmentId && keys.length > 0 ? [{ name: environment.name, keys }] : [];
    }),
  };
}

// A paste or file only fills the form when it names at least one requested key, so a raw value containing "=" still pastes normally.
export function matchVariableRequestEnv(rows: Array<{ key: string; locked: string | null }>, entries: Array<{ key: string; value: string }>) {
  const keys = new Set(rows.filter((row) => !row.locked).map((row) => row.key));
  const matched = entries.filter((entry) => keys.has(entry.key) && entry.value.length > 0);
  if (matched.length === 0) return null;
  return {
    values: Object.fromEntries(matched.map((entry) => [entry.key, entry.value])),
    filled: new Set(matched.map((entry) => entry.key)).size,
    ignored: [...new Set(entries.map((entry) => entry.key).filter((key) => !keys.has(key)))],
  };
}
