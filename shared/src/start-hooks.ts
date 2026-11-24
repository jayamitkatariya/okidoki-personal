import type { StartHookConfig } from './okidoki-config';
import { resolveHookConfig, type ResolvedHookConfig } from './hook-config';

type ResolvedStartHookConfig = ResolvedHookConfig;

export function resolveStartHookConfig(value: StartHookConfig | undefined): ResolvedStartHookConfig | null {
  return resolveHookConfig(value);
}
