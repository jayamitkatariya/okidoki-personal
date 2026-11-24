import { readdir, readFile, realpath, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { isAbsolute, join } from 'path';
import {
  InFlightMap,
  buildCodeHostPrUrl,
  decodePathSegments,
  isGitHubUrl,
  parseCodeHostPrUrl,
  parseGitRemote,
  type CodeHostProvider,
  type EngineRepoState,
} from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { loadEngineState, loadRepoState, markRepoRemoved, saveRepoState } from '../utils/state';
import { execFileAsync, SUBPROCESS_MAX_BUFFER } from '../utils/exec';
import { runGitCommand, getCurrentBranch, getOriginDefaultBranch, readRepoHeadBranches, resolveDiffBase, UNQUOTED_PATHS_CONFIG } from './commands';
import { isRecord } from '../utils/type-guards';

const FULL_DIFF_MAX_BUFFER = 50 * 1024 * 1024;
// Status polls every 2s, so oversized files are never read; diffs mark them binary like git's bigFileThreshold.
const MAX_DIFF_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_DIFF_BYTES = 10 * 1024 * 1024;
const UNTRACKED_STAT_CONCURRENCY = 64;
const DIFF_CONFIG = ['-c', `core.bigFileThreshold=${MAX_DIFF_FILE_BYTES}`, ...UNQUOTED_PATHS_CONFIG];

type PrLookupResult =
  | { status: 'found'; url: string }
  | { status: 'not_found' }
  | { status: 'error' };

interface DiscoveredRepo {
  name: string;
  path: string;
  defaultBranch: string;
}

interface PrCache {
  prUrl: string;
  currentBranch: string;
}

interface GitLabRemote {
  host: string;
  instanceUrl: string;
  projectPath: string;
}

type OriginInfo =
  | { provider: 'github' }
  | { provider: 'gitlab'; gitLab: GitLabRemote }
  | { provider: 'unknown' };

function appendUniqueUrl(urls: string[], url: string): string[] {
  return urls.includes(url) ? urls : [...urls, url];
}

interface ListReposOptions {
  includeDiffs?: boolean;
}

interface ListReposResult {
  repos: EngineRepoState[];
  complete: boolean;
}

export class GitService {
  private readonly defaultBranchCache = new Map<string, string>();
  private readonly cachedPrByRepo = new Map<string, PrCache>();
  // An 'unknown' result usually means the origin isn't wired up yet during provisioning, so caching it would permanently mask a remote added moments later.
  private readonly originInfoCache = new Map<string, OriginInfo>();
  // A scratch path can be re-cloned from another repository between two polls, which only its origin reveals.
  private readonly trackedCloneOrigins = new Map<string, string | null>();
  // Broadcaster + UI /repos requests fan in here every ~2s; one shared run.
  private readonly listReposInFlight = new InFlightMap<string, ListReposResult>();
  private readonly diffStatsInFlight = new InFlightMap<string, EngineRepoState['gitDiff']>();
  private readonly fullDiffInFlight = new InFlightMap<string, string | null>();

  getWorkspaceRoot(): string {
    return ENGINE_ENV.WORKSPACE_ROOT;
  }

  async listRepositories(): Promise<DiscoveredRepo[]> {
    return (await this.listRepositoriesWithCompleteness()).repos;
  }

  private async listRepositoriesWithCompleteness(): Promise<{ repos: DiscoveredRepo[]; complete: boolean }> {
    const root = this.getWorkspaceRoot();
    const rootStat = await this.safeStat(root);
    if (!rootStat?.isDirectory()) {
      return { repos: [], complete: false };
    }

    const entries = await readdir(root);
    const repos: DiscoveredRepo[] = [];
    let complete = true;

    for (const entry of entries) {
      const fullPath = join(root, entry);
      try {
        const entryStat = await stat(fullPath);
        if (!entryStat.isDirectory()) {
          continue;
        }

        const hasGit = Boolean(await this.safeStat(join(fullPath, '.git')));
        if (!hasGit) {
          continue;
        }

        repos.push({
          name: entry,
          path: fullPath,
          defaultBranch: await this.resolveDefaultBranch(fullPath),
        });
      } catch {
        complete = false;
      }
    }

    return { repos: repos.sort((a, b) => a.name.localeCompare(b.name)), complete };
  }

  private async listTrackedRepositories(): Promise<{ repos: DiscoveredRepo[]; deleted: EngineRepoState[]; complete: boolean }> {
    const [discovered, state] = await Promise.all([this.listRepositoriesWithCompleteness(), loadEngineState()]);
    const repos = [...discovered.repos];
    const removed = new Map(Object.entries(state.removedRepos));
    for (const repo of Object.values(state.repos)) {
      if (!isAbsolute(repo.name)) continue;
      const exists = Boolean(await this.safeStat(join(repo.path, '.git')));
      const origin = exists
        ? (await readFile(join(repo.path, '.git', 'config'), 'utf-8').catch(() => '')).match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1] ?? null
        : null;
      const known = this.trackedCloneOrigins.has(repo.path) ? this.trackedCloneOrigins.get(repo.path) : origin;
      if (exists && origin === known) {
        this.trackedCloneOrigins.set(repo.path, origin);
        repos.push({ name: repo.name, path: repo.path, defaultBranch: await this.resolveDefaultBranch(repo.path) });
      } else {
        this.trackedCloneOrigins.delete(repo.path);
        this.defaultBranchCache.delete(repo.path);
        this.originInfoCache.delete(repo.path);
        this.cachedPrByRepo.delete(repo.name);
        await markRepoRemoved(repo.name);
        removed.set(repo.name, repo);
      }
    }
    const deleted = [...removed.values()]
      .filter((repo) => !repos.some((live) => live.name === repo.name))
      .map((repo) => ({ ...repo, gitDiff: { added: 0, removed: 0 } }));
    return { repos, deleted, complete: discovered.complete };
  }

  async findTrackedRepository(name: string): Promise<DiscoveredRepo | undefined> {
    return (await this.listTrackedRepositories()).repos.find((repo) => repo.name === name);
  }

  async trackPushedRepository(worktree: string): Promise<boolean> {
    const commonDir = await runGitCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree).catch(() => null);
    if (!commonDir) return false;
    // Tracked repositories already observe the branches of their linked worktrees.
    const { repos } = await this.listTrackedRepositories();
    if (repos.some((repo) => repo.path === worktree || join(repo.path, '.git') === commonDir)) return false;
    const defaultBranch = await this.resolveDefaultBranch(worktree);
    await saveRepoState(worktree, {}, {
      name: worktree,
      path: worktree,
      defaultBranch,
      currentBranch: await getCurrentBranch(worktree) ?? defaultBranch,
      prUrls: [],
      gitDiff: null,
      startHooksCompleted: true,
    });
    return true;
  }

  async listRepos(options?: ListReposOptions): Promise<EngineRepoState[]> {
    return (await this.listReposWithCompleteness(options)).repos;
  }

  async listReposWithCompleteness(options?: ListReposOptions): Promise<ListReposResult> {
    const includeDiffs = options?.includeDiffs === true;
    const key = includeDiffs ? 'diffs' : 'base';
    return this.listReposInFlight.run(key, () => this.computeListRepos(includeDiffs));
  }

  private async computeListRepos(includeDiffs: boolean): Promise<ListReposResult> {
    const discovered = await this.listTrackedRepositories();
    let complete = discovered.complete;

    const states = await Promise.all(discovered.repos.map(async (repo): Promise<EngineRepoState | null> => {
      try {
        const [persistedState, currentBranchRaw, gitDiff, codeHost] = await Promise.all([
          loadRepoState(repo.name),
          getCurrentBranch(repo.path),
          this.getGitDiffStats(repo.path, repo.defaultBranch),
          this.resolveCodeHost(repo.path),
        ]);
        const currentBranch = currentBranchRaw ?? repo.defaultBranch;
        const fullDiff = includeDiffs && gitDiff
          ? await this.getFullGitDiff(repo.path, repo.defaultBranch)
          : undefined;
        if (gitDiff === null) complete = false;
        if (fullDiff === null) complete = false;

        return {
          name: repo.name,
          path: repo.path,
          defaultBranch: repo.defaultBranch,
          currentBranch,
          prUrls: persistedState?.prUrls ?? [],
          gitDiff: includeDiffs && gitDiff
            ? { ...gitDiff, ...(fullDiff === null ? {} : { fullDiff }) }
            : gitDiff,
          startHooksCompleted: persistedState?.startHooksCompleted ?? false,
          ...codeHost,
        };
      } catch {
        complete = false;
        return null;
      }
    }));

    return { repos: [...states.filter((state) => state !== null), ...discovered.deleted], complete };
  }

  async refreshRepos(
    observedBranchesByRepo?: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<EngineRepoState[]> {
    const discovered = await this.listTrackedRepositories();
    // Linked worktrees share one git config and observe each other's branches, so they share each branch's lookup.
    const prLookupsByGitDir = new Map<string, Map<string, Promise<PrLookupResult>>>();

    const states = await Promise.all(discovered.repos.map(async (repo): Promise<EngineRepoState | null> => {
      try {
        const [gitDir, persistedState, currentBranchRaw] = await Promise.all([
          runGitCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo.path).catch(() => repo.path),
          loadRepoState(repo.name),
          getCurrentBranch(repo.path),
        ]);
        const prLookups = prLookupsByGitDir.get(gitDir) ?? new Map<string, Promise<PrLookupResult>>();
        prLookupsByGitDir.set(gitDir, prLookups);
        const currentBranch = currentBranchRaw ?? repo.defaultBranch;
        const startHooksCompleted = persistedState?.startHooksCompleted ?? false;
        const observed = new Set([
          ...readRepoHeadBranches(repo.path),
          ...(observedBranchesByRepo?.get(repo.name) ?? []),
        ]);
        return await this.refreshRepoMetadata(
          repo,
          currentBranch,
          startHooksCompleted,
          persistedState,
          observed,
          prLookups,
        );
      } catch {
        return null;
      }
    }));

    return [...states.filter((state) => state !== null), ...discovered.deleted];
  }

  async snapshotCurrentBranches(): Promise<Map<string, Set<string>>> {
    const { repos } = await this.listTrackedRepositories();
    return new Map(repos.map((repo) => [repo.name, readRepoHeadBranches(repo.path)]));
  }

  async recordPublishedPullRequest(prUrl: string): Promise<boolean> {
    if (!URL.canParse(prUrl)) return false;
    const parsed = parseCodeHostPrUrl(prUrl);
    if (!parsed || !Number.isSafeInteger(parsed.number) || parsed.number <= 0) return false;
    const url = new URL(prUrl);
    if (url.host.toLowerCase() !== parsed.host || !['https:', 'http:'].includes(url.protocol)) return false;
    const canonicalUrl = buildCodeHostPrUrl(parsed.repoUrl, parsed.provider, parsed.number);
    const { repos } = await this.listTrackedRepositories();
    for (const repo of repos) {
      const remote = parseGitRemote(await runGitCommand(['remote', 'get-url', 'origin'], repo.path).catch(() => ''));
      if (!remote || remote.host !== parsed.host) continue;
      const sameRepository = parsed.provider === 'github'
        ? remote.path.toLowerCase() === parsed.repositoryPath.toLowerCase()
        : remote.path === parsed.repositoryPath;
      if (!sameRepository) continue;
      await saveRepoState(repo.name, { prUrls: [canonicalUrl] }, {
        ...repo,
        currentBranch: await getCurrentBranch(repo.path) ?? repo.defaultBranch,
        prUrls: [],
        gitDiff: null,
        startHooksCompleted: false,
      });
      return true;
    }
    return false;
  }

  private getGitDiffStats(repoPath: string, defaultBranch: string): Promise<EngineRepoState['gitDiff']> {
    return this.diffStatsInFlight.run(repoPath, async () => {
      try {
        const diffBase = await resolveDiffBase(repoPath, defaultBranch);
        const shortstat = await runGitCommand([...DIFF_CONFIG, 'diff', diffBase, '--shortstat', '-M'], repoPath);

        let added = 0;
        let removed = 0;

        const addedMatch = shortstat.match(/(\d+) insertion/);
        const removedMatch = shortstat.match(/(\d+) deletion/);

        if (addedMatch) {
          added = parseInt(addedMatch[1], 10);
        }
        if (removedMatch) {
          removed = parseInt(removedMatch[1], 10);
        }

        // New-files-only workspaces would otherwise report a zero diff.
        added += await this.countUntrackedAddedLines(repoPath);

        return {
          added,
          removed,
        };
      } catch (error) {
        console.warn(`[GitService] getGitDiffStats failed for ${repoPath} (defaultBranch=${defaultBranch}):`, error instanceof Error ? error.message : error);
        return null;
      }
    });
  }

  private async listUntrackedFiles(repoPath: string): Promise<{ path: string; tooLarge: boolean }[]> {
    const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    const paths = stdout.split('\0').filter(Boolean);
    const files: { path: string; size: number }[] = [];
    for (let i = 0; i < paths.length; i += UNTRACKED_STAT_CONCURRENCY) {
      const batch = await Promise.all(paths.slice(i, i + UNTRACKED_STAT_CONCURRENCY).map(async (path) => {
        try {
          return { path, size: (await stat(join(repoPath, path))).size };
        } catch {
          return null;
        }
      }));
      files.push(...batch.filter((file) => file !== null));
    }
    let remainingBytes = MAX_UNTRACKED_DIFF_BYTES;
    return files.map(({ path, size }) => {
      const tooLarge = size > MAX_DIFF_FILE_BYTES || size > remainingBytes;
      if (!tooLarge) remainingBytes -= size;
      return { path, tooLarge };
    });
  }

  private async getUntrackedDiff(repoPath: string): Promise<string> {
    const files = await this.listUntrackedFiles(repoPath);
    const largeFilesDiff = files
      .filter((file) => file.tooLarge)
      .map(({ path }) => {
        // Match git's C-style quoting so control characters can't break the line-based headers.
        const quote = (prefixed: string) => /[\x00-\x1f"\\]/.test(prefixed) ? JSON.stringify(prefixed) : prefixed;
        return `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\nnew file mode 100644\nBinary files /dev/null and ${quote(`b/${path}`)} differ\n`;
      })
      .join('');
    const paths = files.filter((file) => !file.tooLarge).map((file) => file.path);
    if (paths.length === 0) return largeFilesDiff;

    try {
      await execFileAsync('git', ['add', '--intent-to-add', '--', ...paths], {
        cwd: repoPath,
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      });
      return await this.readUntrackedDiff(repoPath, paths) + largeFilesDiff;
    } finally {
      try {
        await execFileAsync('git', ['reset', '--', ...paths], {
          cwd: repoPath,
          maxBuffer: SUBPROCESS_MAX_BUFFER,
        });
      } catch { /* best-effort reset */ }
    }
  }

  private readUntrackedDiff(repoPath: string, paths: string[]): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn('git', [...DIFF_CONFIG, 'diff', '--', ...paths], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        total += chunk.length;
        if (total > FULL_DIFF_MAX_BUFFER) {
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, FULL_DIFF_MAX_BUFFER - (total - chunk.length))));
          child.kill('SIGTERM');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', () => {});
      child.on('error', () => resolve(''));
      child.on('close', (code) => {
        // git diff exits 1 when differences are present, not just 0.
        if (code === 0 || code === 1 || truncated) {
          resolve(Buffer.concat(chunks).toString('utf-8'));
        } else {
          resolve('');
        }
      });
    });
  }

  private async countUntrackedAddedLines(repoPath: string): Promise<number> {
    try {
      const files = await this.listUntrackedFiles(repoPath);
      let total = 0;
      for (const { path, tooLarge } of files) {
        if (tooLarge) continue;
        try {
          const contents = await readFile(join(repoPath, path));
          if (contents.length === 0 || contents.includes(0)) {
            continue;
          }

          let lines = 0;
          for (let index = contents.indexOf(10); index !== -1; index = contents.indexOf(10, index + 1)) {
            lines += 1;
          }
          total += lines + (contents[contents.length - 1] === 10 ? 0 : 1);
        } catch { /* skip */ }
      }
      return total;
    } catch (error) {
      console.error('Error counting untracked added lines:', error);
      return 0;
    }
  }

  private async getFullGitDiff(repoPath: string, defaultBranch: string): Promise<string | null> {
    // Keyed by the real path: a symlinked alias of a checkout shares its index, and concurrent untracked diffs would race on it.
    const key = await realpath(repoPath).catch(() => repoPath);
    return this.fullDiffInFlight.run(key, async () => {
      try {
        const diffBase = await resolveDiffBase(repoPath, defaultBranch);
        const { stdout: trackedDiff } = await execFileAsync('git', [...DIFF_CONFIG, 'diff', diffBase, '-M', '-C'], {
          cwd: repoPath,
          encoding: 'utf-8',
          maxBuffer: FULL_DIFF_MAX_BUFFER,
        });
        const untrackedDiff = await this.getUntrackedAsDiff(repoPath);
        return trackedDiff + untrackedDiff;
      } catch {
        return null;
      }
    });
  }

  private async getUntrackedAsDiff(repoPath: string): Promise<string> {
    try {
      return await this.getUntrackedDiff(repoPath);
    } catch (error) {
      console.error('Error building untracked diff:', error);
      return '';
    }
  }

  private async getPullRequestUrl(
    repoName: string,
    repoPath: string,
    prLookups: Map<string, Promise<PrLookupResult>>,
    currentBranchArg?: string,
    persistedRepoStateArg?: EngineRepoState | null,
  ): Promise<PrLookupResult> {
    try {
      const currentBranch = currentBranchArg ?? await getCurrentBranch(repoPath);
      if (!currentBranch) {
        return { status: 'not_found' };
      }

      const cachedPr = this.cachedPrByRepo.get(repoName);
      if (cachedPr && cachedPr.currentBranch === currentBranch) {
        return { status: 'found', url: cachedPr.prUrl };
      }

      const persistedRepoState = persistedRepoStateArg ?? await loadRepoState(repoName);
      this.cachedPrByRepo.delete(repoName);

      const result = await this.lookupPrOnce(prLookups, repoName, repoPath, currentBranch);
      if (result.status === 'found') {
        this.cachedPrByRepo.set(repoName, { prUrl: result.url, currentBranch });
        if (persistedRepoState && !persistedRepoState.prUrls.includes(result.url)) {
          await saveRepoState(
            repoName,
            { prUrls: appendUniqueUrl(persistedRepoState.prUrls, result.url) },
            persistedRepoState,
          );
        }
      }
      return result;
    } catch (error) {
      console.error('Error checking for pull request:', error);
      return { status: 'error' };
    }
  }

  private lookupPrOnce(
    prLookups: Map<string, Promise<PrLookupResult>>,
    repoName: string,
    repoPath: string,
    branch: string,
  ): Promise<PrLookupResult> {
    let lookup = prLookups.get(branch);
    if (!lookup) {
      lookup = this.lookupPrOnRemote(repoName, repoPath, branch);
      prLookups.set(branch, lookup);
    }
    return lookup;
  }

  private async lookupPrOnRemote(repoName: string, repoPath: string, branch: string): Promise<PrLookupResult> {
    const origin = await this.getOriginInfo(repoPath);
    if (origin.provider === 'unknown') {
      return { status: 'not_found' };
    }

    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', branch], {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      });
      if (!stdout.trim()) {
        return { status: 'not_found' };
      }
    } catch {
      return { status: 'error' };
    }

    if (origin.provider === 'gitlab') {
      return this.lookupGitLabMrOnRemote(repoName, origin.gitLab, branch);
    }

    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      });
      const prInfo = stdout.trim();
      return prInfo ? { status: 'found', url: prInfo } : { status: 'not_found' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GitService] gh pr view ${branch} failed for ${repoName}: ${message}`);
      return { status: 'error' };
    }
  }

  private async lookupGitLabMrOnRemote(
    repoName: string,
    remote: GitLabRemote,
    branch: string,
  ): Promise<PrLookupResult> {
    const token = await this.getGitLabAccessToken(remote.host);
    if (!token) {
      return { status: 'not_found' };
    }

    // No state filter so merged/closed MRs stay discoverable after engine-state loss.
    const url = `${remote.instanceUrl}/api/v4/projects/${encodeURIComponent(remote.projectPath)}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        console.warn(`[GitService] GitLab MR lookup failed for ${repoName}: ${response.status}`);
        return response.status === 404 ? { status: 'not_found' } : { status: 'error' };
      }

      const data = await response.json();
      if (!Array.isArray(data)) return { status: 'not_found' };
      const branchMatches = data.filter((item): item is Record<string, unknown> => (
        isRecord(item)
        && item.source_branch === branch
      ));
      const mergeRequest = branchMatches.find((item) => item.state === 'opened')
        ?? branchMatches[0];
      if (!isRecord(mergeRequest)) return { status: 'not_found' };
      const webUrl = mergeRequest.web_url;
      if (typeof webUrl === 'string' && webUrl.length > 0) return { status: 'found', url: webUrl };
      const iid = mergeRequest.iid;
      return typeof iid === 'number'
        ? { status: 'found', url: `${remote.instanceUrl}/${remote.projectPath}/-/merge_requests/${iid}` }
        : { status: 'not_found' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GitService] GitLab MR lookup failed for ${repoName}: ${message}`);
      return { status: 'error' };
    }
  }

  private async resolveCodeHost(repoPath: string): Promise<{
    provider?: CodeHostProvider;
    repositoryUrl?: string;
  }> {
    const origin = await this.getOriginInfo(repoPath);
    if (origin.provider === 'unknown') return {};
    if (origin.provider === 'github') return { provider: origin.provider };
    return {
      provider: origin.provider,
      repositoryUrl: `${origin.gitLab.instanceUrl}/${origin.gitLab.projectPath}`,
    };
  }

  async getRepositoryOriginHost(repoPath: string, refresh = false): Promise<string | null> {
    if (refresh) this.originInfoCache.delete(repoPath);
    const origin = await this.getOriginInfo(repoPath);
    if (origin.provider === 'github') return 'github.com';
    if (origin.provider === 'gitlab') return origin.gitLab.host;
    return null;
  }

  private async getOriginInfo(repoPath: string): Promise<OriginInfo> {
    const cached = this.originInfoCache.get(repoPath);
    if (cached !== undefined) {
      return cached;
    }

    let info: OriginInfo = { provider: 'unknown' };
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: SUBPROCESS_MAX_BUFFER,
      });
      const originUrl = stdout.trim();
      if (isGitHubUrl(originUrl)) {
        info = { provider: 'github' };
      } else {
        const gitLabRemote = this.parseGitLabRemote(originUrl);
        if (gitLabRemote) info = { provider: 'gitlab', gitLab: gitLabRemote };
      }
    } catch {
      info = { provider: 'unknown' };
    }

    if (info.provider !== 'unknown') this.originInfoCache.set(repoPath, info);
    return info;
  }

  private parseGitLabRemote(remoteUrl: string): GitLabRemote | null {
    const parsed = parseGitRemote(remoteUrl);
    if (!parsed) return null;
    const projectPath = decodePathSegments(parsed.path.split('/').filter(Boolean)).join('/');
    return {
      host: parsed.host,
      instanceUrl: `${parsed.protocol === 'http' ? 'http' : 'https'}://${parsed.host}`,
      projectPath,
    };
  }

  private async getGitLabAccessToken(host: string): Promise<string | null> {
    try {
      const credentials = await readFile(join(ENGINE_ENV.HOME_DIR, '.git-credentials'), 'utf-8');
      for (const line of credentials.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol === 'https:' && parsed.host.toLowerCase() === host && parsed.password) {
            return decodeURIComponent(parsed.password);
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  private async resolveDefaultBranch(repoPath: string): Promise<string> {
    const cached = this.defaultBranchCache.get(repoPath);
    if (cached) {
      return cached;
    }

    const fromSymbolicRef = await getOriginDefaultBranch(repoPath);
    if (fromSymbolicRef) {
      this.defaultBranchCache.set(repoPath, fromSymbolicRef);
      return fromSymbolicRef;
    }

    // Don't cache the fallback. The broadcaster polls every 2s and an
    // agent-issued `git clone` can be observed mid-clone, before
    // refs/remotes/origin/HEAD has been written — caching 'main' there
    // would lock in the wrong default for the whole session even after
    // the clone finishes. Recompute next tick instead.
    return 'main';
  }

  private async refreshRepoMetadata(
    repo: DiscoveredRepo,
    currentBranch: string,
    startHooksCompleted: boolean,
    persistedState: EngineRepoState | null,
    observedBranches: ReadonlySet<string>,
    prLookups: Map<string, Promise<PrLookupResult>>,
  ): Promise<EngineRepoState> {
    // Never look up PRs/MRs by the default branch: since the lookup matches any
    // state, historical PRs whose source branch was the default (e.g. git-flow
    // master→develop sync MRs) would get linked to the workspace.
    const notFound: PrLookupResult = { status: 'not_found' };
    const [prUrls, gitDiff, codeHost] = await Promise.all([
      (async () => {
        const prResult = currentBranch === repo.defaultBranch
          ? notFound
          : await this.getPullRequestUrl(repo.name, repo.path, prLookups, currentBranch, persistedState);

        let urls = persistedState?.prUrls ?? [];
        if (prResult.status === 'found') {
          urls = appendUniqueUrl(urls, prResult.url);
        }

        // The agent may have opened PRs on branches it switched away from during the turn.
        for (const branch of observedBranches) {
          if (branch === currentBranch || branch === repo.defaultBranch) continue;
          const branchResult = await this.lookupPrOnce(prLookups, repo.name, repo.path, branch);
          if (branchResult.status === 'found') {
            urls = appendUniqueUrl(urls, branchResult.url);
          }
        }
        return urls;
      })(),
      this.getGitDiffStats(repo.path, repo.defaultBranch),
      this.resolveCodeHost(repo.path),
    ]);

    const state: EngineRepoState = {
      name: repo.name,
      path: repo.path,
      defaultBranch: repo.defaultBranch,
      currentBranch,
      prUrls,
      gitDiff,
      startHooksCompleted,
      ...codeHost,
    };

    return saveRepoState(repo.name, state, state);
  }

  private async safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
    try {
      return await stat(path);
    } catch {
      return null;
    }
  }
}

export const gitService = new GitService();
