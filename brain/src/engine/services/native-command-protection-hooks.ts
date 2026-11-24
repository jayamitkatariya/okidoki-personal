import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_ENV } from '../engine-env';
import { atomicWriteFile } from '../utils/file';
import { isRecord } from '../utils/type-guards';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const hookPath = [
  join(moduleDirectory, 'command-protection-hook.js'),
  join(moduleDirectory, '..', 'command-protection-hook.ts'),
].find(existsSync);
const postToolHookPath = [
  join(moduleDirectory, 'post-tool-pr-hook.js'),
  join(moduleDirectory, '..', 'post-tool-pr-hook.ts'),
].find(existsSync);

function shellCommand(path: string | undefined, provider?: 'cursor' | 'gemini'): string {
  if (!path) throw new Error('Okidoki hook executable is missing.');
  const args = [
    process.execPath,
    ...(path.endsWith('.ts') && basename(process.execPath) !== 'bun' ? ['--import', 'tsx'] : []),
    path,
    ...(provider ? [provider] : []),
  ];
  return args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

export function getCommandProtectionHookPath(): string {
  if (!hookPath) throw new Error('Okidoki command protection hook executable is missing.');
  return hookPath;
}

export function getPostToolPrHookPath(): string {
  if (!postToolHookPath) throw new Error('Okidoki post-tool PR hook executable is missing.');
  return postToolHookPath;
}

/** Hook files are rewritten at every engine start, so an in-place write would let another chat read a truncated file. */
async function updateHooksFile(path: string, label: string, update: (config: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  let config: Record<string, unknown> = {};
  try {
    const content = await readFile(path, 'utf8');
    // Older engines truncated this file in place, and a crash mid-write left it empty.
    const parsed: unknown = content.trim() ? JSON.parse(content) : {};
    if (!isRecord(parsed)) throw new Error(`Invalid ${label} hooks configuration.`);
    config = parsed;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(update(config), null, 2)}\n`);
}

export async function ensureCursorCommandProtectionHook(): Promise<void> {
  await updateHooksFile(join(ENGINE_ENV.HOME_DIR, '.cursor', 'hooks.json'), 'Cursor', (config) => {
    const hooks = isRecord(config.hooks) ? config.hooks : {};
    const existing = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
    hooks.preToolUse = [
      ...existing.filter((entry) => !isRecord(entry)
        || typeof entry.command !== 'string' || !entry.command.includes('command-protection-hook')),
      { command: shellCommand(hookPath, 'cursor') },
    ];
    const existingPost = Array.isArray(hooks.postToolUse) ? hooks.postToolUse : [];
    hooks.postToolUse = [
      ...existingPost.filter((entry) => !isRecord(entry)
        || typeof entry.command !== 'string' || !entry.command.includes('post-tool-pr-hook')),
      { command: shellCommand(postToolHookPath) },
    ];
    return { ...config, version: 1, hooks };
  });
}

/** Antigravity loads global hooks from ~/.gemini/config/hooks.json, keyed by hook name. */
export async function ensureGeminiCommandProtectionHook(): Promise<void> {
  await updateHooksFile(join(ENGINE_ENV.HOME_DIR, '.gemini', 'config', 'hooks.json'), 'Antigravity', (config) => ({
    ...config,
    'okidoki-command-protection': {
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: shellCommand(hookPath, 'gemini'), timeout: 60 }] }],
      PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: shellCommand(postToolHookPath) }] }],
    },
  }));
}
