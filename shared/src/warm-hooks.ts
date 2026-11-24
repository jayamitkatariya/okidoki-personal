import type { WarmHookConfig } from './okidoki-config';
import { resolveHookConfig, type ResolvedHookConfig } from './hook-config';

// Heavyweight warm hooks (lockfile installs + multi-image `docker pull` for a
// monorepo) routinely run past 5 minutes, so the default has to leave them room
// instead of aborting mid-pull. Warm pool builds are background work that users
// never wait on directly, so we pick a generous default and an even more
// generous cap; repo configs can dial *down* via `okidoki.json` if they want
// fail-fast.
export const DEFAULT_WARM_HOOK_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_WARM_HOOK_TIMEOUT_MS = 120 * 60 * 1000;
// Start hooks fire on every workspace boot, so a tighter default keeps boot
// latency predictable — heavy setup work belongs in the warm hook, which only
// runs once during pool build-up.
export const DEFAULT_START_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
// Per-log preview size returned by the list endpoint. Full output is stored on
// disk and served by a separate "full log" endpoint to keep the list response
// small and the dashboard fast even when many repos report logs.
export const DEFAULT_HOOK_OUTPUT_PREVIEW_CHARS = 100_000;
// Hard cap on stdout/stderr the engine will buffer from a single command. We
// rely on this rather than truncating after capture, so the on-disk log is
// always faithful to what the exec produced.
export const HOOK_EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export type ResolvedWarmHookConfig = ResolvedHookConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function clampWarmHookTimeoutMs(timeoutMs?: number): number {
  if (!timeoutMs || Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_WARM_HOOK_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, MAX_WARM_HOOK_TIMEOUT_MS);
}

export interface HookOutputPreview {
  output: string;
  outputTruncated: boolean;
  outputTotalChars: number;
}

export type OutputTruncateFrom = 'head' | 'tail';

type BuildOutputPreviewOptions = {
  maxChars?: number;
  truncateFrom?: OutputTruncateFrom;
  marker?: string;
};

export function buildOutputPreview(
  text: string,
  {
    maxChars = DEFAULT_HOOK_OUTPUT_PREVIEW_CHARS,
    truncateFrom = 'head',
    marker = '\n...[truncated — download the full log to see the rest]',
  }: BuildOutputPreviewOptions = {},
): HookOutputPreview {
  if (text.length <= maxChars) {
    return { output: text, outputTruncated: false, outputTotalChars: text.length };
  }

  const previewChars = Math.max(0, maxChars - marker.length);
  const output = previewChars === 0
    ? marker.slice(0, maxChars)
    : truncateFrom === 'tail'
      ? `${marker}${text.slice(-previewChars)}`
      : `${text.slice(0, previewChars)}${marker}`;

  return {
    output,
    outputTruncated: true,
    outputTotalChars: text.length,
  };
}

export function buildHookOutputPreview(
  text: string,
  maxChars: number = DEFAULT_HOOK_OUTPUT_PREVIEW_CHARS,
): HookOutputPreview {
  return buildOutputPreview(text, { maxChars });
}

export function parseWarmHookConfig(value: unknown, filename = 'okidoki.json'): string | WarmHookConfig {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid ${filename}: "warmHook" must be a string or object`);
  }

  if (!Array.isArray(value.commands) || !value.commands.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid ${filename}: "warmHook.commands" must be an array of shell commands`);
  }

  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || value.timeout <= 0)) {
    throw new Error(`Invalid ${filename}: "warmHook.timeout" must be a positive number`);
  }

  if (value.separate !== undefined && typeof value.separate !== 'boolean') {
    throw new Error(`Invalid ${filename}: "warmHook.separate" must be a boolean`);
  }

  return {
    commands: value.commands,
    timeout: value.timeout as number | undefined,
    separate: value.separate as boolean | undefined,
  } satisfies WarmHookConfig;
}

export function resolveWarmHookConfig(value: unknown): ResolvedWarmHookConfig | null {
  if (value === undefined) {
    return null;
  }

  return resolveHookConfig(parseWarmHookConfig(value));
}
