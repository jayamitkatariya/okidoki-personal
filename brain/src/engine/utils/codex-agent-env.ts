export function buildCodexAgentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  // A workspace-level key must not silently replace the credential selected by Okidoki.
  if (env.OKIDOKI_CODEX_AUTH_METHOD === 'oauth' || env.OKIDOKI_CODEX_AUTH_METHOD === 'foundry') {
    delete env.OPENAI_API_KEY;
  }
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_CONFIG_DIR;
  return env;
}
