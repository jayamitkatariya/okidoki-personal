/** Anthropic key from the request, then the environment the Mac injected. */
export function anthropicKey(header: string | null | undefined): string | undefined {
  const fromHeader = header?.trim();
  if (fromHeader) return fromHeader;
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  return fromEnv || undefined;
}

/** Apify token from the request, then the environment the Mac injected. */
export function apifyToken(fromRequest?: string): string | undefined {
  const given = fromRequest?.trim();
  if (given) return given;
  const fromEnv = process.env.APIFY_API_KEY?.trim();
  return fromEnv || undefined;
}

/** Moss project credentials from the request, then the environment. */
export function mossCredentials(projectId?: string, projectKey?: string): { projectId: string; projectKey: string } | null {
  const id = (projectId || process.env.MOSS_PROJECT_ID || "").trim();
  const key = (projectKey || process.env.MOSS_PROJECT_KEY || "").trim();
  if (!id || !key) return null;
  return { projectId: id, projectKey: key };
}
