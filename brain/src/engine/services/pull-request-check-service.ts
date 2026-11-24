import { buildCodeHostPrUrl, parseCodeHostPrUrl, shouldRefreshPullRequests, withTimeout, type EngineRepoState, type PullRequestToolResult } from '@okidoki/shared';
import { gitService } from '../git/service';
import { refreshRepoStatuses } from './refresh-repo-state';
import { monolithService } from './monolith-service';
import { publishedPullRequestUrls } from './published-pull-request-urls';

// A hung git or remote call would otherwise pin the single-flight slot for the
// rest of the session. An abandoned run still delivers its webhook if it ever
// finishes, so the cap only costs a duplicate refresh.
const CHECK_TIMEOUT_MS = 30_000;

function canonicalPrUrl(url: string): string {
  const parsed = parseCodeHostPrUrl(url);
  return parsed ? buildCodeHostPrUrl(parsed.repoUrl, parsed.provider, parsed.number) : url;
}

function addBranches(target: Map<string, Set<string>>, source: ReadonlyMap<string, ReadonlySet<string>>): void {
  for (const [repoName, branches] of source) target.set(repoName, new Set([...target.get(repoName) ?? [], ...branches]));
}

class PullRequestCheckService {
  private running: Promise<EngineRepoState[]> | null = null;
  private trailing: Promise<EngineRepoState[]> | null = null;
  // Hook-reported publications carry no chat, so any turn may claim them.
  private readonly unclaimedPublishedUrls = new Map<string | undefined, Set<string>>();
  private pendingBranches = new Map<string, Set<string>>();
  private turnBranches = new Map<string, Set<string>>();

  async recordPublishedPullRequest(url: string, created = true, chatId?: string): Promise<void> {
    if (await this.recordPublication(url, created, chatId)) {
      this.check().catch((error) => console.error('[PullRequestCheck] Failed to report published PR:', error));
    }
  }

  takeUnlinkedPublishedUrls(chatIds: string[], repoStatuses: EngineRepoState[]): string[] {
    const linked = new Set(repoStatuses.flatMap((repo) => repo.prUrls.map(canonicalPrUrl)));
    const unclaimed = new Set<string>();
    for (const chatId of [...chatIds, undefined]) {
      for (const url of this.unclaimedPublishedUrls.get(chatId) ?? []) unclaimed.add(url);
      this.unclaimedPublishedUrls.delete(chatId);
    }
    return [...unclaimed].filter((url) => !linked.has(url));
  }

  private async recordPublication(url: string, created: boolean, chatId?: string): Promise<boolean> {
    const recorded = await gitService.recordPublishedPullRequest(url);
    if (!recorded && created && parseCodeHostPrUrl(url)) {
      const unclaimed = this.unclaimedPublishedUrls.get(chatId) ?? new Set();
      this.unclaimedPublishedUrls.set(chatId, unclaimed.add(canonicalPrUrl(url)));
    }
    return recorded;
  }

  async onToolResult(result: PullRequestToolResult, chatId?: string): Promise<void> {
    if (!result.success) return;
    const urls = publishedPullRequestUrls(result);
    if (urls.length === 0 && !shouldRefreshPullRequests(result.toolName, result.toolInput)) return;
    // The agent can switch branches before the check runs, so it also looks up the ones checked out now.
    const snapshot = await gitService.snapshotCurrentBranches();
    addBranches(this.pendingBranches, snapshot);
    addBranches(this.turnBranches, snapshot);
    try {
      for (const url of urls) await this.recordPublication(url, true, chatId);
    } finally {
      this.check().catch((error) => console.error('[PullRequestCheck] Failed to report tool result:', error));
    }
  }

  async observeBranches(): Promise<void> {
    addBranches(this.turnBranches, await gitService.snapshotCurrentBranches());
  }

  checkTurn(): Promise<EngineRepoState[]> {
    addBranches(this.pendingBranches, this.turnBranches);
    this.turnBranches = new Map();
    return this.check();
  }

  // Plain single-flight would hand a caller a result gathered before its PR
  // existed, so callers arriving mid-run instead share one trailing run that
  // starts after the current one settles.
  check(): Promise<EngineRepoState[]> {
    const running = this.running;
    const refresh = !running ? this.start() : this.trailing ??= running.catch(() => {}).then(() => {
      this.trailing = null;
      return this.start();
    });
    return refresh;
  }

  private start(): Promise<EngineRepoState[]> {
    const run = withTimeout(this.refresh(), CHECK_TIMEOUT_MS, 'Pull request check timed out').finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async refresh(): Promise<EngineRepoState[]> {
    const observedBranches = this.pendingBranches;
    this.pendingBranches = new Map();
    const repoStatuses = await refreshRepoStatuses(observedBranches);
    await monolithService.sendEvent({ type: 'pull_request_check', payload: { repoStatuses } });
    return repoStatuses;
  }
}

export const pullRequestCheckService = new PullRequestCheckService();
