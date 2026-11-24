export function normalizeGitHubLogin(login: string): string {
  return login.trim().replace(/^@+/, '').toLowerCase();
}

export function ensureBotSuffix(login: string): string {
  const normalized = normalizeGitHubLogin(login);
  if (!normalized) return '';
  return normalized.endsWith('[bot]') ? normalized : `${normalized}[bot]`;
}

export function stripBotSuffix(login: string): string {
  return normalizeGitHubLogin(login).replace(/\[bot\]$/, '');
}

export const GITHUB_LOGIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/;

export function isValidGitHubLogin(login: string): boolean {
  return GITHUB_LOGIN_REGEX.test(login);
}
