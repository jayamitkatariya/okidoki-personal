import { mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  AGENT,
  TENSORLAKE_IMAGE_NAME,
  type EngineEnvironmentDetails,
  type EngineEnvironmentTrackRequest,
  type EnvironmentExecutionStatus,
  type RepositoryEnvironmentExecution,
} from '@okidoki/shared';
import { listCredentialFallbacks } from './credential-fallbacks';
import { ENGINE_ENV } from '../engine-env';
import { gitService } from '../git/service';
import { atomicWriteFile } from '../utils/file';
import { execFileAsync } from '../utils/exec';
import { detectAgentAuthMethod } from '../managers/agent-auth-detection';
import { GEMINI_CLI_PATH } from '../managers/agent-auth-paths';
import { getPiProviderCredentials } from '../managers/pi-auth';
import { CODEX_ULTRAFAST_SERVICE_TIER, listCodexModelsForDetails } from '../managers/codex-asp/asp-host';

const OKIDOKI_DIR = join(homedir(), '.okidoki');
const DETAILS_FILE = join(OKIDOKI_DIR, 'environment-details.json');
const GH_HOSTS_PATH = join(homedir(), '.config', 'gh', 'hosts.yml');
const GIT_CREDENTIALS_PATH = join(homedir(), '.git-credentials');

async function detectGitIdentityConfigured(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', 'user.name']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function detectGitLabAccessConfigured(): Promise<boolean> {
  try {
    const credentials = await readFile(GIT_CREDENTIALS_PATH, 'utf-8');
    return credentials.split('\n').some((line) => {
      try {
        return new URL(line).username === 'oauth2';
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function upsertRepositoryStatus(
  current: RepositoryEnvironmentExecution[],
  incoming: RepositoryEnvironmentExecution[],
): RepositoryEnvironmentExecution[] {
  const byName = new Map(current.map((r) => [r.repositoryName, r]));
  for (const repo of incoming) {
    const existing = byName.get(repo.repositoryName);
    byName.set(repo.repositoryName, {
      repositoryName: repo.repositoryName,
      warmHookCompleted: repo.warmHookCompleted !== 'n/a'
        ? repo.warmHookCompleted
        : (existing?.warmHookCompleted ?? 'n/a'),
      startHookCompleted: repo.startHookCompleted !== 'n/a'
        ? repo.startHookCompleted
        : (existing?.startHookCompleted ?? 'n/a'),
    });
  }
  return [...byName.values()].sort((a, b) => a.repositoryName.localeCompare(b.repositoryName));
}

function createDefaultDetails(): EngineEnvironmentDetails {
  return {
    engineVersion: ENGINE_ENV.OKIDOKI_SANDBOX_IMAGE_VERSION,
    globalWarmHookCompleted: { status: 'n/a', details: null },
    environmentWarmHookCompleted: { status: 'n/a', details: null },
    environmentStartHookCompleted: { status: 'n/a', details: null },
    repositories: [],
    filesUploaded: [],
    envVarsSet: [],
    skillsInstalled: [],
    mcpsInstalled: [],
    gitIdentityConfigured: false,
    githubCredentialsConfigured: false,
    gitlabCredentialsConfigured: false,
    linearAccessConfigured: false,
    slackAccessConfigured: false,
    githubAccessConfigured: false,
    gitlabAccessConfigured: false,
    claudeAuthMethod: 'none',
    codexAuthMethod: 'none',
    cursorAuthMethod: 'none',
    museAuthMethod: 'none',
    opencodeAuthMethod: 'none',
    piAuthMethod: 'none',
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function readDetails(): Promise<EngineEnvironmentDetails> {
  try {
    if (!existsSync(DETAILS_FILE)) {
      return createDefaultDetails();
    }
    const raw = await readFile(DETAILS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EngineEnvironmentDetails> & { googleAccessConfigured?: unknown };
    delete parsed.googleAccessConfigured;
    return { ...createDefaultDetails(), ...parsed };
  } catch {
    return createDefaultDetails();
  }
}

async function writeDetails(details: EngineEnvironmentDetails): Promise<void> {
  await mkdir(OKIDOKI_DIR, { recursive: true });
  await atomicWriteFile(DETAILS_FILE, `${JSON.stringify(details, null, 2)}\n`);
}

class EnvironmentDetailsService {
  async getDetails(): Promise<EngineEnvironmentDetails> {
    const [details, repositories, gitIdentityConfigured, gitlabAccessConfigured, piCredentials, codexModels] = await Promise.all([
      readDetails(),
      gitService.listRepositories(),
      detectGitIdentityConfigured(),
      detectGitLabAccessConfigured(),
      getPiProviderCredentials(),
      listCodexModelsForDetails(),
    ]);

    details.engineVersion = ENGINE_ENV.OKIDOKI_SANDBOX_IMAGE_VERSION;
    details.engineImage = TENSORLAKE_IMAGE_NAME;
    details.supportsMidTurnSteering = true;
    details.supportsClaudeMidTurnSteering = true;
    details.supportsCursorMidTurnSteering = true;
    details.supportsPiMidTurnSteering = true;
    details.supportsSendNow = true;
    details.supportsCodexSendNow = true;
    details.supportsClaudeGoals = true;
    details.supportsGoalUpdates = true;
    details.supportsQueuedMessageEditing = true;
    details.supportsQueueEvents = true;
    details.supportsChatForking = true;
    details.supportsChatForkMessage = true;
    details.supportsDeferredChatForking = true;
    details.supportsMessageEditing = true;
    details.supportsHarnessSwitch = true;
    details.supportsSideChats = true;
    details.supportsMultipleSideChats = true;
    details.supportsCredentialSwitching = true;
    details.supportsChatCredentials = true;
    details.codexUltrafastModels = codexModels
      ?.filter((model) => model.serviceTiers.some((tier) => tier.id === CODEX_ULTRAFAST_SERVICE_TIER))
      .map((model) => model.model);
    details.agentCredentials = { ...ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS };
    details.claudeAuthMethod = detectAgentAuthMethod(AGENT.CLAUDE);
    details.codexAuthMethod = detectAgentAuthMethod(AGENT.CODEX);
    details.cursorAuthMethod = detectAgentAuthMethod(AGENT.CURSOR);
    // Images before the Gemini harness lack `agy`, even once their engine updates in place, so they report no Gemini support.
    details.geminiAuthMethod = existsSync(GEMINI_CLI_PATH) ? detectAgentAuthMethod(AGENT.GEMINI) : undefined;
    details.museAuthMethod = detectAgentAuthMethod(AGENT.MUSE);
    details.opencodeAuthMethod = detectAgentAuthMethod(AGENT.OPENCODE);
    details.piAuthMethod = detectAgentAuthMethod(AGENT.PI);
    details.piInferenceProvider = piCredentials.ok ? piCredentials.data.provider : undefined;
    details.credentialFallbacks = listCredentialFallbacks();
    details.gitIdentityConfigured = gitIdentityConfigured;
    const ghConfigured = existsSync(GH_HOSTS_PATH);
    details.githubAccessConfigured = ghConfigured;
    details.githubCredentialsConfigured = ghConfigured;
    details.gitlabAccessConfigured = gitlabAccessConfigured;
    details.gitlabCredentialsConfigured = gitlabAccessConfigured;
    details.linearAccessConfigured = Boolean(
      ENGINE_ENV.OKIDOKI_LINEAR_SESSION_ID || ENGINE_ENV.OKIDOKI_LINEAR_ACCESS_TOKEN || ENGINE_ENV.OKIDOKI_LINEAR_ACCESS_CONFIGURED,
    );
    details.slackAccessConfigured = Boolean(
      ENGINE_ENV.OKIDOKI_SLACK_BOT_TOKEN || ENGINE_ENV.OKIDOKI_SLACK_ACCESS_CONFIGURED,
    );

    const freshRepos = repositories.map((repo) => ({
      repositoryName: repo.name,
      warmHookCompleted: 'n/a' as const,
      startHookCompleted: 'n/a' as const,
    }));
    details.repositories = upsertRepositoryStatus(details.repositories, freshRepos);

    return details;
  }

  async trackEnvironment(req: EngineEnvironmentTrackRequest): Promise<void> {
    const details = await readDetails();
    if (req.filesUploaded) {
      details.filesUploaded = req.filesUploaded;
    }
    if (req.envVarsSet) {
      details.envVarsSet = req.envVarsSet;
    }
    if (req.skillsInstalled) {
      details.skillsInstalled = req.skillsInstalled;
    }
    if (req.mcpsInstalled) {
      details.mcpsInstalled = req.mcpsInstalled;
    }
    details.lastUpdatedAt = new Date().toISOString();
    await writeDetails(details);
  }


  async setEnvironmentWarmHook(status: EnvironmentExecutionStatus, details?: string | null): Promise<void> {
    const current = await readDetails();
    current.environmentWarmHookCompleted = { status, details: details ?? null };
    current.lastUpdatedAt = new Date().toISOString();
    await writeDetails(current);
  }

  async setEnvironmentStartHook(status: EnvironmentExecutionStatus, details?: string | null): Promise<void> {
    const current = await readDetails();
    current.environmentStartHookCompleted = { status, details: details ?? null };
    current.lastUpdatedAt = new Date().toISOString();
    await writeDetails(current);
  }

  async setRepositoryWarmHook(repositoryName: string, status: EnvironmentExecutionStatus): Promise<void> {
    const current = await readDetails();
    current.repositories = upsertRepositoryStatus(current.repositories, [{
      repositoryName,
      warmHookCompleted: status,
      startHookCompleted: 'n/a',
    }]);
    current.lastUpdatedAt = new Date().toISOString();
    await writeDetails(current);
  }

  async setRepositoryStartHook(repositoryName: string, status: EnvironmentExecutionStatus): Promise<void> {
    const current = await readDetails();
    current.repositories = upsertRepositoryStatus(current.repositories, [{
      repositoryName,
      warmHookCompleted: 'n/a',
      startHookCompleted: status,
    }]);
    current.lastUpdatedAt = new Date().toISOString();
    await writeDetails(current);
  }
}

export const environmentDetailsService = new EnvironmentDetailsService();
