import type { EngineRepoState } from '@okidoki/shared';
import { gitService } from '../git/service';
import { monolithRequest } from './monolith-service';

let uploadQueue = Promise.resolve();

async function sendRepoState(repos: EngineRepoState[]): Promise<void> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([JSON.stringify({ repos })], { type: 'application/json' }),
    'repo-state.json',
  );
  const response = await monolithRequest('/v1/engine/repo-state', { body: form });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`upload failed: ${response.status} ${errorText}`);
  }
}

export function uploadRepoState(repos: EngineRepoState[]): Promise<void> {
  const upload = uploadQueue.then(() => sendRepoState(repos));
  uploadQueue = upload.catch(() => {});
  return upload;
}

export async function flushRepoState(): Promise<{ flushed: number; skipped: number; failed: number }> {
  try {
    const { repos, complete } = await gitService.listReposWithCompleteness({ includeDiffs: true });
    if (!complete) return { flushed: 0, skipped: 1, failed: 0 };
    await uploadRepoState(repos);
    return { flushed: 1, skipped: 0, failed: 0 };
  } catch (err) {
    console.error('[RepoStateUploader] upload failed:', err);
    return { flushed: 0, skipped: 0, failed: 1 };
  }
}
