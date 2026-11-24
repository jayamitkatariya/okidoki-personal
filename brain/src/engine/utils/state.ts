import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { EngineRepoState } from '@okidoki/shared';
import { ENGINE_DIR } from '../services/chat/history-paths';
import { atomicWriteFile } from './file';
import { isRecord } from './type-guards';
import { AsyncLock } from './async-lock';

export interface EngineState {
  repos: Record<string, EngineRepoState>;
  removedRepos: Record<string, EngineRepoState>;
}

const STATE_FILE = join(ENGINE_DIR, 'engine-state.json');

const DEFAULT_STATE: EngineState = {
  repos: {},
  removedRepos: {},
};

const stateWriteLock = new AsyncLock();

async function updateEngineState(updater: (currentState: EngineState) => EngineState): Promise<EngineState> {
  return stateWriteLock.run(async () => {
    await mkdir(ENGINE_DIR, { recursive: true });
    const currentState = await loadEngineState();
    const nextState = updater(currentState);
    await atomicWriteFile(STATE_FILE, JSON.stringify(nextState, null, 2));
    return nextState;
  });
}

function isEngineRepoDiff(value: unknown): value is NonNullable<EngineRepoState['gitDiff']> {
  return isRecord(value) && typeof value.added === 'number' && typeof value.removed === 'number';
}

function coerceRepoState(value: unknown): EngineRepoState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.name !== 'string') return null;
  if (typeof value.path !== 'string') return null;
  if (typeof value.defaultBranch !== 'string') return null;
  if (typeof value.currentBranch !== 'string') return null;

  if (!Array.isArray(value.prUrls)) return null;
  const prUrls: string[] = [];
  for (const entry of value.prUrls) {
    if (typeof entry !== 'string') return null;
    if (!prUrls.includes(entry)) prUrls.push(entry);
  }

  if (!(value.gitDiff === null || isEngineRepoDiff(value.gitDiff))) return null;
  if (typeof value.startHooksCompleted !== 'boolean') return null;

  return {
    name: value.name,
    path: value.path,
    defaultBranch: value.defaultBranch,
    currentBranch: value.currentBranch,
    prUrls,
    gitDiff: value.gitDiff,
    startHooksCompleted: value.startHooksCompleted,
  };
}

function coerceEngineState(value: unknown): Partial<EngineState> {
  if (!isRecord(value)) {
    return {};
  }

  const partial: Partial<EngineState> = {};

  for (const key of ['repos', 'removedRepos'] as const) {
    const entries = value[key];
    if (!isRecord(entries)) continue;
    const repos: Record<string, EngineRepoState> = {};
    for (const [repoName, repoState] of Object.entries(entries)) {
      const coerced = coerceRepoState(repoState);
      if (coerced) {
        repos[repoName] = coerced;
      }
    }
    partial[key] = repos;
  }

  return partial;
}

/**
 * Load the persisted engine state from disk.
 */
export async function loadEngineState(): Promise<EngineState> {
  try {
    if (!existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE };
    }

    const content = await readFile(STATE_FILE, 'utf-8');
    const state = coerceEngineState(JSON.parse(content));

    return {
      ...DEFAULT_STATE,
      ...state,
      repos: state.repos ?? {},
      removedRepos: state.removedRepos ?? {},
    };
  } catch (error) {
    console.error('[EngineState] Failed to load state, using defaults:', error);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Get repo-specific state.
 */
export async function loadRepoState(repoName: string): Promise<EngineRepoState | null> {
  const state = await loadEngineState();
  return state.repos[repoName] ?? null;
}

/**
 * Save repo-specific state changes.
 */
export async function saveRepoState(repoName: string, state: Partial<EngineRepoState>, fallbackState: EngineRepoState): Promise<EngineRepoState> {
  const updated = await updateEngineState((currentState) => {
    const currentRepoState = currentState.repos[repoName] ?? fallbackState;
    return {
      ...currentState,
      repos: {
        ...currentState.repos,
        [repoName]: {
          ...currentRepoState,
          ...state,
          // Publication events and repository refreshes can finish in either order.
          prUrls: [...new Set([...currentRepoState.prUrls, ...(state.prUrls ?? [])])],
        },
      },
    };
  });
  return updated.repos[repoName];
}

// A clone later recreated at the same path may be a different repository, so it must not inherit these PR URLs.
export async function markRepoRemoved(repoName: string): Promise<void> {
  await updateEngineState((currentState) => {
    const { [repoName]: removed, ...repos } = currentState.repos;
    if (!removed) return currentState;
    return { ...currentState, repos, removedRepos: { ...currentState.removedRepos, [repoName]: removed } };
  });
}
