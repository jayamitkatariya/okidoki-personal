import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execFileAsync, SUBPROCESS_MAX_BUFFER } from '../utils/exec';

// Git octal-escapes non-ASCII bytes in the paths it prints unless quotePath is off.
export const UNQUOTED_PATHS_CONFIG = ['-c', 'core.quotePath=false'];

export interface RunGitCommandOptions {
  maxBuffer?: number;
}

export async function runGitCommand(
  args: string[],
  cwd: string,
  options: RunGitCommandOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: options.maxBuffer ?? SUBPROCESS_MAX_BUFFER,
  });
  return stdout.trim();
}

// Read administrative HEAD files so even worktrees outside the workspace root
// are observed without spawning git on every agent event.
export function readRepoHeadBranches(repoPath: string): Set<string> {
  const branches = new Set<string>();
  try {
    let gitDir = join(repoPath, '.git');
    if (statSync(gitDir).isFile()) {
      const target = readFileSync(gitDir, 'utf8').trim().match(/^gitdir: (.+)$/)?.[1];
      if (!target) return branches;
      gitDir = resolve(repoPath, target);
    }
    let commonDir = gitDir;
    try {
      commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch { /* Main checkouts have no commondir file. */ }
    const headDirs = new Set([gitDir, commonDir]);
    try {
      for (const entry of readdirSync(join(commonDir, 'worktrees'))) {
        headDirs.add(join(commonDir, 'worktrees', entry));
      }
    } catch { /* Repositories without linked worktrees have no worktrees directory. */ }
    for (const dir of headDirs) {
      try {
        const branch = readFileSync(join(dir, 'HEAD'), 'utf8').trim().match(/^ref:\s+refs\/heads\/(.+)$/)?.[1];
        if (branch) branches.add(branch);
      } catch { /* A worktree can disappear during observation. */ }
    }
  } catch { /* Repository discovery can race with cloning or removal. */ }
  return branches;
}

async function branchExists(branchName: string, cwd: string): Promise<boolean> {
  try {
    await runGitCommand(['rev-parse', '--verify', branchName], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getOriginDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const output = await runGitCommand(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath);
    return output.match(/^origin\/(.+)$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch (error) {
    console.error('Error getting current branch:', error);
    return null;
  }
}

// Resolves a ref to diff `HEAD` against for "what changed in this workspace"
// queries. Tries the merge-base with `origin/<defaultBranch>` first, then the
// remote-tracking branch directly, and finally falls back to `HEAD` so callers
// degrade to working-dir + untracked instead of silently dropping the diff
// when origin/<defaultBranch> is unreachable (shallow clones, mid-clone race,
// agent-cloned repos whose origin/HEAD points at an unfetched branch).
export async function resolveDiffBase(repoPath: string, defaultBranch: string): Promise<string> {
  const baseBranch = `origin/${defaultBranch}`;
  try {
    return await runGitCommand(['merge-base', baseBranch, 'HEAD'], repoPath);
  } catch { /* fall through */ }
  return await branchExists(baseBranch, repoPath) ? baseBranch : 'HEAD';
}
