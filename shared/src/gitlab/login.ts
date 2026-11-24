export const GITLAB_USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9_.-]{0,253}[a-z0-9])?$/;

export function normalizeGitLabUsername(username: string): string {
  return username.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidGitLabUsername(username: string): boolean {
  return GITLAB_USERNAME_REGEX.test(username);
}
