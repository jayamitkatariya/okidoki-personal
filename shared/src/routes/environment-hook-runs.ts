import { z } from 'zod';
import type { EnvironmentChange } from './environment';

export const ENVIRONMENT_HOOK_RUN_KINDS = ['warm', 'start'] as const;
export type EnvironmentHookRunKind = (typeof ENVIRONMENT_HOOK_RUN_KINDS)[number];

export const ENVIRONMENT_HOOK_RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export type EnvironmentHookRunStatus = (typeof ENVIRONMENT_HOOK_RUN_STATUSES)[number];

/** Full logs live in object storage up to this many characters, keeping the end. */
export const ENVIRONMENT_HOOK_RUN_LOG_LIMIT = 5 * 1024 * 1024;
/** Postgres keeps only the end of the log, for the failure panel and the failure classifier. */
export const ENVIRONMENT_HOOK_RUN_TAIL_LIMIT = 8 * 1024;

/** One unit a hook run executed: the app hooks together (`repository: null`), or one repository's own hook, by checkout name. */
export const environmentHookRunStepsSchema = z.array(z.object({
  repository: z.string().max(255).nullable(),
  status: z.enum(['succeeded', 'failed', 'skipped']),
})).max(1024);
export type EnvironmentHookRunStep = z.infer<typeof environmentHookRunStepsSchema>[number];

/** A warm hook run belongs to a warm pool build; a start hook run to the workspace it started. */
export interface EnvironmentHookRunSummary {
  id: string;
  environment_id: string;
  kind: EnvironmentHookRunKind;
  status: EnvironmentHookRunStatus;
  exit_code: number | null;
  timed_out: boolean;
  warm_pool_build_id: string | null;
  warm_pool_build_changes: EnvironmentChange[];
  workspace_id: string | null;
  workspace_name: string | null;
  /** The warm pool workspace building this run; stream its output while the run is running. */
  builder_workspace_id: string | null;
  started_at: string;
  finished_at: string | null;
  /** Null when the engine that ran it didn't report steps. */
  steps: EnvironmentHookRunStep[] | null;
}

export interface EnvironmentHookRun extends EnvironmentHookRunSummary {
  /** The stored log once the run finishes; empty while it runs. */
  output: string;
  /** Characters the hook printed, which exceeds `output.length` when the log was cut to its end. */
  output_length: number;
  output_truncated: boolean;
}

export interface ListEnvironmentHookRunsResponse {
  runs: EnvironmentHookRunSummary[];
}

export interface GetEnvironmentHookRunResponse {
  run: EnvironmentHookRun;
}

export function isEnvironmentHookRunKind(value: string): value is EnvironmentHookRunKind {
  return ENVIRONMENT_HOOK_RUN_KINDS.some((kind) => kind === value);
}
