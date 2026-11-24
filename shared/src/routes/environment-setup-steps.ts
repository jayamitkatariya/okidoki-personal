import type { EnvironmentSetupSourceMode } from './environment';
import type { EnvironmentHookRunKind } from './environment-hook-runs';

type EnvironmentHookStepSource =
  | {
    type: 'environment';
    environment_id: string;
    environment_name: string;
    /** Set when the environment's configuration file manages this hook, which makes it read-only. */
    config_file: { filename: string; file_url: string | null } | null;
  }
  | {
    type: 'repository';
    repository_id: string;
    repository_name: string;
    checkout_name: string;
    filename: string | null;
    file_url: string | null;
  };

export interface EnvironmentHookStep {
  kind: EnvironmentHookRunKind;
  source: EnvironmentHookStepSource;
  content: string;
  error: string | null;
}

export interface GetEnvironmentSetupStepsResponse {
  source_mode: EnvironmentSetupSourceMode;
  /** Warm steps, then start steps, each in the order they run. */
  steps: EnvironmentHookStep[];
}
