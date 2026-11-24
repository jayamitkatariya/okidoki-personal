const GITHUB_HOST_RE = /(^|@|\/\/)github\.com[:/]/;
const GITHUB_REPO_SLUG_RE = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/i;

export function isGitHubUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return GITHUB_HOST_RE.test(url);
}

export function parseRepoUrlSlug(
  url: string | null | undefined,
): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = url.match(GITHUB_REPO_SLUG_RE);
  if (!match) return null;
  return { owner: match[1].toLowerCase(), repo: match[2].toLowerCase() };
}

export function findRepositoryByUrl<T extends { url: string }>(url: string, repositories: T[]): T | null {
  const slug = parseRepoUrlSlug(url);
  if (!slug) return null;
  return repositories.find((repo) => {
    const repoSlug = parseRepoUrlSlug(repo.url);
    return repoSlug && repoSlug.owner === slug.owner && repoSlug.repo === slug.repo;
  }) ?? null;
}

export function stripCredentialsFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {}
  return url;
}
