import type { CodeHostProvider } from './code-host';
import { stripCredentialsFromUrl } from './github/url';

export const DEFAULT_WEBSITE_URL = 'https://persona.dev';
export const DEFAULT_WEB_APP_URL = 'http://127.0.0.1:3000';
export const DEFAULT_SUPABASE_URL = 'https://mxeqiomwgdgaesecwtct.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZXFpb213Z2RnYWVzZWN3dGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4OTk2ODAsImV4cCI6MjA3NTQ3NTY4MH0.zLRoK4r9Zep-WaLNkvWcb7DXlJBZFH26QXWO1ljMctM';

const DASHBOARD_PATH = '/dashboard';

export const WEB_APP_PATHS = {
  home: '/',
  onboarding: '/onboarding',
  workspaces: '/workspace',
  environmentSetup: '/workspace/setup',
  automations: '/automations',
  environment: '/environment',
  analytics: '/analytics',
  review: '/review',
  issues: '/issues',
  dashboard: DASHBOARD_PATH,
  agents: `${DASHBOARD_PATH}/agents`,
  integrations: `${DASHBOARD_PATH}/integrations`,
  integrationsGithub: `${DASHBOARD_PATH}/integrations/github`,
  integrationsGitlab: `${DASHBOARD_PATH}/integrations/gitlab`,
  settings: `${DASHBOARD_PATH}/settings`,
  billing: `${DASHBOARD_PATH}/billing`,
  members: `${DASHBOARD_PATH}/members`,
  learnings: `${DASHBOARD_PATH}/learnings`,
  'audit-logs': `${DASHBOARD_PATH}/audit-logs`,
  accountAgents: `${DASHBOARD_PATH}/account/agents`,
  accountProfile: `${DASHBOARD_PATH}/account/profile`,
  accountAppearance: `${DASHBOARD_PATH}/account/appearance`,
  accountConnections: `${DASHBOARD_PATH}/account/connections`,
  accountIntegrations: `${DASHBOARD_PATH}/account/integrations`,
  accountApiKeys: `${DASHBOARD_PATH}/account/api-keys`,
  accountPreferences: `${DASHBOARD_PATH}/account/preferences`,
  accountKeyboardShortcuts: `${DASHBOARD_PATH}/account/keyboard-shortcuts`,
  fullscreenWorkspaces: '/workspaces',
} as const;

const UUID_PATTERN = '????????-????-????-????-????????????';

// Web pages the Okidoki app also has, as Apple app site association patterns: `?` is one character and `*` any run, slashes included.
// UUID-shaped segments keep web-only pages like /workspace/setup and /automations/new in the browser.
export const APP_LINK_PATHS = [
  `${WEB_APP_PATHS.workspaces}/${UUID_PATTERN}`,
  `${WEB_APP_PATHS.fullscreenWorkspaces}/${UUID_PATTERN}`,
  WEB_APP_PATHS.review,
  `${WEB_APP_PATHS.review}/*/*/*`,
  `/invite/${UUID_PATTERN}`,
  WEB_APP_PATHS.automations,
  `${WEB_APP_PATHS.automations}/${UUID_PATTERN}`,
];

const APP_LINK_PATTERNS = APP_LINK_PATHS.map((path) => new RegExp(`^${path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*')}$`));

export const isAppLinkPath = (pathname: string) => APP_LINK_PATTERNS.some((pattern) => pattern.test(pathname));

export const LEGACY_WEB_APP_PATHS = {
  app: '/app',
  home: '/home',
  dashboardWorkspaces: `${DASHBOARD_PATH}/workspaces`,
} as const;

export const ACCOUNT_SETTINGS_PARAM = 'accountSettings';

export const ACCOUNT_SETTINGS_SLUGS = {
  connections: 'connections',
  agents: 'agents',
  apiKeys: 'api-keys',
  preferences: 'preferences',
} as const;

export type AccountSettingsSlug = (typeof ACCOUNT_SETTINGS_SLUGS)[keyof typeof ACCOUNT_SETTINGS_SLUGS];

export function getAccountSettingsUrl(slug: AccountSettingsSlug, webAppUrl: string = DEFAULT_WEB_APP_URL): string {
  return `${webAppUrl}${WEB_APP_PATHS.dashboard}?${ACCOUNT_SETTINGS_PARAM}=${slug}`;
}

export type WorkspaceDashboardUrlOptions = {
  encodeWorkspaceId?: boolean;
  mode?: string;
  mediaId?: string;
  webAppUrl?: string;
};

export function getWorkspaceDashboardUrl(
  workspaceId: string,
  options: WorkspaceDashboardUrlOptions = {}
): string {
  const { encodeWorkspaceId = true, mode, mediaId, webAppUrl = DEFAULT_WEB_APP_URL } = options;
  const workspaceIdValue = encodeWorkspaceId ? encodeURIComponent(workspaceId) : workspaceId;

  const params: string[] = [];
  if (mode) params.push(`mode=${encodeURIComponent(mode)}`);
  if (mediaId) params.push(`media=${encodeURIComponent(mediaId)}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';

  return `${webAppUrl}${WEB_APP_PATHS.fullscreenWorkspaces}/${workspaceIdValue}${query}`;
}

/** A person mention is a markdown link to their member page, so sent messages render it as a chip and the server can read who was mentioned. */
export function getMemberMentionUrl(userId: string, webAppUrl: string = DEFAULT_WEB_APP_URL): string {
  return `${webAppUrl}${WEB_APP_PATHS.members}?user=${encodeURIComponent(userId)}`;
}

export const MEMBER_MENTION_PATTERN = new RegExp(String.raw`\[@((?:[^\]\\\n]|\\.)+)\]\(https?://[^\s/)]+${WEB_APP_PATHS.members}\?user=([0-9a-f-]{36})\)`, 'g');

export function parseMentionedMemberIds(message: string): string[] {
  return [...new Set(Array.from(message.matchAll(MEMBER_MENTION_PATTERN), (match) => match[2]))];
}

export function getOrganizationMediaPath(organizationId: string, mediaId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/media/${encodeURIComponent(mediaId)}`;
}

export function getOrganizationMediaUrl(
  organizationId: string,
  mediaId: string,
  webAppUrl: string = DEFAULT_WEB_APP_URL,
): string {
  return `${webAppUrl}${getOrganizationMediaPath(organizationId, mediaId)}`;
}

export function getAutomationDashboardUrl(
  automationId: string,
  options: { runPr?: { repositoryId: string; number: number; repoFullName: string } } = {}
): string {
  const base = `${DEFAULT_WEB_APP_URL}${WEB_APP_PATHS.automations}/${encodeURIComponent(automationId)}`;
  if (!options.runPr) return base;
  const { repositoryId, number, repoFullName } = options.runPr;
  return `${base}?run_pr=${number}&run_repo=${encodeURIComponent(repositoryId)}&run_repo_name=${encodeURIComponent(repoFullName)}`;
}

interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

export interface ParsedCodeHostPrUrl extends ParsedPrUrl {
  provider: CodeHostProvider;
  host: string;
  repositoryPath: string;
  repoUrl: string;
}

const PR_URL_REGEX = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

function parsePrUrl(url: string): ParsedPrUrl | null {
  const match = url.match(PR_URL_REGEX);
  if (!match) return null;
  const [, owner, repo, numberStr] = match;
  const number = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(number)) return null;
  return { owner, repo, number };
}

export function parseCodeHostPrUrl(url: string): ParsedCodeHostPrUrl | null {
  const github = parsePrUrl(url);
  if (github) {
    return {
      ...github,
      provider: 'github',
      host: 'github.com',
      repositoryPath: `${github.owner}/${github.repo}`,
      repoUrl: `https://github.com/${github.owner}/${github.repo}`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const separatorIndex = segments.indexOf('-');
  if (separatorIndex <= 0 || segments[separatorIndex + 1] !== 'merge_requests') return null;

  const number = Number.parseInt(segments[separatorIndex + 2] ?? '', 10);
  if (!Number.isFinite(number)) return null;

  const repositorySegments = decodePathSegments(segments.slice(0, separatorIndex));
  const repo = repositorySegments[repositorySegments.length - 1];
  const owner = repositorySegments[0];
  if (!owner || !repo) return null;

  const repositoryPath = repositorySegments.join('/');
  return {
    provider: 'gitlab',
    host: parsed.host.toLowerCase(),
    owner,
    repo,
    number,
    repositoryPath,
    repoUrl: `${parsed.origin}/${repositoryPath}`,
  };
}

export function decodePathSegments(segments: string[]): string[] {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function normalizedPullRequestNumber(value: number | string | null, fallback: number): number {
  if (value == null) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function getPullRequestNoun(pr: Pick<ParsedCodeHostPrUrl, 'provider'>): 'PR' | 'MR' {
  return pr.provider === 'gitlab' ? 'MR' : 'PR';
}

export function getPullRequestFullNoun(pr: Pick<ParsedCodeHostPrUrl, 'provider'>): 'pull request' | 'merge request' {
  return pr.provider === 'gitlab' ? 'merge request' : 'pull request';
}

export function formatPullRequestNumber(pr: Pick<ParsedCodeHostPrUrl, 'provider' | 'number'>): string {
  return `${pr.provider === 'gitlab' ? '!' : '#'}${pr.number}`;
}

export function getCodeHostRequestNoun(url: string): 'PR' | 'MR' {
  return getPullRequestNoun({ provider: parseCodeHostPrUrl(url)?.provider ?? 'github' });
}

export function formatCodeHostRequestRef(url: string, number?: number | null): string | null {
  const parsed = parseCodeHostPrUrl(url);
  const requestNumber = number ?? parsed?.number;
  if (!requestNumber) return null;
  return formatPullRequestNumber({ provider: parsed?.provider ?? 'github', number: requestNumber });
}

export function getPullRequestViewUrl(url: string, openInGraphite: boolean): string {
  if (!openInGraphite) return url;
  const parsed = parseCodeHostPrUrl(url);
  if (parsed?.provider !== 'github') return url;
  return `https://app.graphite.com/github/pr/${parsed.owner}/${parsed.repo}/${parsed.number}`;
}

export function normalizeRepositoryUrl(
  url: string | null | undefined,
  options: { lowercase?: boolean } = {},
): string | null {
  if (!url) return null;
  const stripped = stripCredentialsFromUrl(url).trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!stripped) return null;
  try {
    const parsed = new URL(stripped);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    const normalized = `${parsed.origin}${parsed.pathname}`;
    return options.lowercase ? normalized.toLowerCase() : normalized;
  } catch {
    return options.lowercase ? stripped.toLowerCase() : stripped;
  }
}

export function repositoryCheckoutName(repositoryUrl: string, fallback = 'workspace'): string {
  const normalized = normalizeRepositoryUrl(repositoryUrl) ?? '';
  return normalized.split(/[/:]/).filter(Boolean).pop() || fallback;
}

export function repositoryCheckoutNames(repositoryUrls: string[]): string[] {
  const names = repositoryUrls.map((url) => repositoryCheckoutName(url));
  return repositoryUrls.map((url, i) => {
    if (names.indexOf(names[i]) === names.lastIndexOf(names[i])) return names[i];
    const normalized = normalizeRepositoryUrl(url) ?? '';
    const path = URL.canParse(normalized) ? new URL(normalized).pathname : normalized.split(':').pop() ?? '';
    return path.split('/').filter(Boolean).join('-') || names[i];
  });
}

export function buildCodeHostPrUrl(repoUrl: string, provider: CodeHostProvider, prNumber: number): string {
  const normalizedRepoUrl = repoUrl.replace(/\.git$/, '');
  if (provider === 'gitlab') {
    return `${normalizedRepoUrl}/-/merge_requests/${prNumber}`;
  }
  return `${normalizedRepoUrl}/pull/${prNumber}`;
}
