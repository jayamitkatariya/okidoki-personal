import { normalizeGitHubLogin } from '../github/login';

export function isTriggerActorListed(
  actors: string[] | undefined,
  actor: string | null | undefined
): boolean {
  if (!actors?.length || !actor) return false;
  // All three actor kinds (GitHub/GitLab login, Slack member ID) compare as
  // trimmed + `@`-stripped + lowercased, which is exactly normalizeGitHubLogin.
  const target = normalizeGitHubLogin(actor);
  return actors.some((listed) => normalizeGitHubLogin(listed) === target);
}

export function addTriggerActors(list: string[], raw: string): string[] {
  let next = list;
  for (const part of raw.split(/[\s,]+/)) {
    const actor = part.replace(/^@+/, '');
    if (!actor || isTriggerActorListed(next, actor)) continue;
    next = [...next, actor];
  }
  return next;
}
