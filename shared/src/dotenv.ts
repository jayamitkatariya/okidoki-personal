const ENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^\r\n]*?)(?:\s+#.*)?(?:$|$)/gm;

export function parseEnvText(text: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  const normalized = text.replace(/\r\n?/g, '\n');
  let match: RegExpExecArray | null;

  while ((match = ENV_LINE.exec(normalized)) !== null) {
    const quotedValue = (match[2] ?? '').trim();
    let value = quotedValue.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (quotedValue.startsWith('"')) {
      value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }
    entries.push({ key: match[1], value });
  }

  return entries;
}

// A paste only counts as a .env when it has a newline or "=", so a raw value pastes normally.
export const parsePastedEnv = (text: string) => (text.includes('\n') || text.includes('=') ? parseEnvText(text) : []);
