import type { GitHubAccessToken } from './routes/github';
import type { CodeHostProvider } from './code-host';
import { parseRepoUrlSlug } from './github/url';
import { shellQuotePosix } from './runtime-env';
import { ENGINE_PORT } from './engine/environment';

export const GIT_PARTIAL_CLONE_FILTER = 'blob:none';
export const GIT_CREDENTIAL_HELPER_FILENAME = '.git-credential-okidoki';
export const GITHUB_CREDENTIAL_REFRESH_PATH = '/git-credentials/github/refresh';
export const GITLAB_CREDENTIAL_REFRESH_PATH = '/git-credentials/gitlab/refresh';

function githubOwnerTokens(access: Record<string, string>): Map<string, Set<string>> {
  const ownerTokens = new Map<string, Set<string>>();
  for (const [repository, token] of Object.entries(access)) {
    const owner = repository.split('/')[0];
    if (!owner) continue;
    const tokens = ownerTokens.get(owner) ?? new Set<string>();
    tokens.add(token);
    ownerTokens.set(owner, tokens);
  }
  return ownerTokens;
}

export function getGitHubAccessToken(access: GitHubAccessToken, repositoryUrl?: string): string | null {
  if (repositoryUrl === undefined) {
    const tokens = new Set(Object.values(access));
    return tokens.size === 1 ? tokens.values().next().value ?? null : null;
  }
  const slug = parseRepoUrlSlug(repositoryUrl);
  if (!slug) return null;
  const exact = access[`${slug.owner}/${slug.repo}`];
  if (exact) return exact;
  const tokens = githubOwnerTokens(access).get(slug.owner);
  return tokens?.size === 1 ? tokens.values().next().value ?? null : null;
}

export function githubCredentialLines(access: GitHubAccessToken): string[] {
  const entries = Object.entries(access);
  // Private dependencies and skill registries use the same owner's token and its existing permissions.
  const ownerTokens = githubOwnerTokens(access);
  return [...entries.flatMap(([repository, token]) => [
    `https://x-access-token:${token}@github.com/${repository}`,
    `https://x-access-token:${token}@github.com/${repository}.git`,
  ]), ...[...ownerTokens].flatMap(([owner, tokens]) => tokens.size === 1
    ? [`https://x-access-token:${[...tokens][0]}@github.com/${owner}`]
    : [])];
}

export function buildGitCredentialHelperScript(credentialsPath: string): string {
  return `#!/bin/sh
request=$(cat)
if printf '%s\n' "$request" | grep -q '^host=github.com$'; then
  request=$(printf '%s\n' "$request" | awk '/^path=/ { $0 = tolower($0) } { print }')
fi

get_credential() {
  credential=$(printf '%s\n' "$request" | git credential-store --file=${shellQuotePosix(credentialsPath)} get)
  if [ -z "$credential" ] && printf '%s\n' "$request" | grep -q '^host=github.com$'; then
    credential=$(printf '%s\n' "$request" | sed 's|^path=\\([^/]*\\)/.*|path=\\1|' | git credential-store --file=${shellQuotePosix(credentialsPath)} get)
  fi
  printf '%s\n' "$credential"
}

refresh_credential() {
  case "$1" in
    x-access-token) refresh_path=${GITHUB_CREDENTIAL_REFRESH_PATH} ;;
    oauth2) refresh_path=${GITLAB_CREDENTIAL_REFRESH_PATH} ;;
    *) return 1 ;;
  esac
  [ -n "\${OKIDOKI_ENGINE_SECRET:-}" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  curl --silent --fail --connect-timeout 1 --max-time 5 \
    -X POST \
    -H "X-Okidoki-Engine-Secret: $OKIDOKI_ENGINE_SECRET" \
    "http://127.0.0.1:\${OKIDOKI_ENGINE_PORT:-${ENGINE_PORT}}$refresh_path$2" \
    >/dev/null 2>&1
}

if [ "$1" = "get" ]; then
  credential=$(get_credential)
  username=$(printf '%s\n%s\n' "$request" "$credential" | sed -n 's/^username=//p' | head -n 1)
  if [ -n "$username" ]; then
    if refresh_credential "$username"; then
      refreshed_credential=$(get_credential)
      if [ -n "$refreshed_credential" ]; then
        credential=$refreshed_credential
      fi
    fi
  fi
  if ! printf '%s\n' "$credential" | grep -q '^password='; then
    host=$(printf '%s\n' "$request" | sed -n 's/^host=//p')
    repository=$(printf '%s\n' "$request" | sed -n 's/^path=//p' | sed 's/\\.git$//')
    # The engine drops every github.com line when GitHub refuses a refresh, so other lines for the host mean this repository was never granted.
    if grep -q "@$host" ${shellQuotePosix(credentialsPath)} 2>/dev/null; then
      echo "Okidoki: this workspace has no credentials for \${repository:-this repository}. Only the repositories in its environment get them, so the fix is a workspace on an environment that includes it." >&2
    else
      echo "Okidoki: this workspace has no credentials for $host. Either its environment includes no repository there, or Okidoki could not refresh its access; the engine log says which." >&2
    fi
  fi
  printf '%s\n' "$credential"
elif [ "$1" = "erase" ]; then
  username=$(printf '%s\n' "$request" | sed -n 's/^username=//p' | head -n 1)
  refresh_credential "$username" "?rejected" || true
fi
exit 0
`;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export type ProviderGitIdentities = Partial<Record<CodeHostProvider, GitIdentity>>;

export function parseGitRemote(
  remoteUrl: string,
): { host: string; path: string; protocol: 'http' | 'https' | 'ssh' } | null {
  const normalized = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
    const path = parsed.pathname.replace(/^\/+/, '');
    const host = parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host;
    if (!host || !path) return null;
    return {
      host: host.toLowerCase(),
      path,
      protocol: parsed.protocol === 'http:' ? 'http' : parsed.protocol === 'https:' ? 'https' : 'ssh',
    };
  } catch {}

  const match = normalized.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?:(?:\d+)\/)?(.+)$/);
  if (!match) return null;
  const [, host, path] = match;
  return host && path ? { host: host.toLowerCase(), path, protocol: 'ssh' } : null;
}

export function gitIdentityConfigCommands(
  identity: GitIdentity,
  scope: 'global' | 'local' = 'global',
): [args: string[], args2: string[]] {
  return [
    ['config', `--${scope}`, 'user.name', identity.name],
    ['config', `--${scope}`, 'user.email', identity.email],
  ];
}

export function gitIdentityShellCommand(identity: GitIdentity, scope: 'global' | 'local' = 'global'): string {
  return gitIdentityConfigCommands(identity, scope).map((args) => `git ${args.map(shellQuotePosix).join(' ')}`).join(' && ');
}
