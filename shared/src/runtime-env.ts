export const OKIDOKI_RUNTIME_ENV_ALIASES = {
  monolithUrl: ['OKIDOKI_MONOLITH_URL', 'MONOLITH_URL'],
  workspaceId: ['OKIDOKI_WORKSPACE_ID', 'WORKSPACE_ID'],
  linearSessionId: ['OKIDOKI_LINEAR_SESSION_ID', 'LINEAR_SESSION_ID'],
  linearAccessToken: ['OKIDOKI_LINEAR_ACCESS_TOKEN', 'LINEAR_ACCESS_TOKEN'],
  slackBotToken: ['OKIDOKI_SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN'],
  slackChannelId: ['OKIDOKI_SLACK_CHANNEL_ID', 'SLACK_CHANNEL_ID'],
  slackThreadTs: ['OKIDOKI_SLACK_THREAD_TS', 'SLACK_THREAD_TS'],
} as const;

type OkidokiRuntimeEnvAlias = (typeof OKIDOKI_RUNTIME_ENV_ALIASES)[keyof typeof OKIDOKI_RUNTIME_ENV_ALIASES];

export function readOkidokiRuntimeEnv(
  readEnv: (name: string) => string | undefined,
  [namespacedKey, legacyKey]: OkidokiRuntimeEnvAlias,
): string | undefined {
  return readEnv(namespacedKey) ?? readEnv(legacyKey);
}

/**
 * Serializes a string for inclusion in a POSIX single-quoted shell literal.
 *
 * POSIX `'...'` quoting interprets nothing — every byte between the quotes is
 * literal, including newlines, tabs, backslashes, and dollar signs. The only
 * character that cannot appear inside is `'` itself, which we encode by
 * closing the quote, emitting an escaped `\'`, and reopening: `'\''`.
 *
 * We deliberately avoid bash ANSI-C `$'...'` quoting because the engine is
 * launched via `exec()`, which routes through `sh -c` —
 * `/bin/sh` on the sandbox image is dash, and dash does not implement
 * `$'...'`. With dash, a value containing an apostrophe hard-errors with
 * "Unterminated quoted string" (engine never starts), and other content gets
 * silently corrupted (a stray `$` prefix, literal `\n` instead of newlines).
 */
export function shellQuotePosix(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

export function serializePosixEnvFile(env: Record<string, string>, unsetKeys: Iterable<string> = []): string {
  return `${[
    ...[...unsetKeys].map((key) => `unset ${key}`),
    ...Object.entries(env)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => `export ${key}=${shellQuotePosix(value)}`),
  ].join('\n')}\n`;
}

export function parsePosixEnvFile(content: string): Record<string, string> {
  return parsePosixEnv(content).values;
}

/**
 * Parses a POSIX-shell-quoted runtime-env file into its exports and unset keys.
 *
 * Walks the file character by character so that values may contain literal
 * newlines (POSIX `'...'` allows them), and an `unset` line inside a value
 * stays part of that value. Recognizes only the format produced by
 * `serializePosixEnvFile`: `unset NAME` and `export NAME='...'` with embedded
 * `'\''` for quotes. Lines that don't match are ignored — this also drops any
 * older bash ANSI-C `$'...'` lines from previous deployments rather than
 * mis-parsing them.
 */
export function parsePosixEnv(content: string): { values: Record<string, string>; unsetKeys: string[] } {
  const result: Record<string, string> = {};
  const unsetKeys: string[] = [];
  let pos = 0;

  while (pos < content.length) {
    let lineStart: number;
    if (pos === 0 || content[pos - 1] === '\n') {
      lineStart = pos;
    } else {
      const nl = content.indexOf('\n', pos);
      if (nl === -1) break;
      lineStart = nl + 1;
    }
    if (!content.startsWith('export ', lineStart)) {
      const nl = content.indexOf('\n', lineStart);
      if (content.startsWith('unset ', lineStart)) {
        unsetKeys.push(content.slice(lineStart + 'unset '.length, nl === -1 ? undefined : nl).trim());
      }
      if (nl === -1) break;
      pos = nl + 1;
      continue;
    }

    const nameStart = lineStart + 'export '.length;
    const eqIdx = content.indexOf('=', nameStart);
    if (eqIdx === -1) break;

    const name = content.slice(nameStart, eqIdx).trim();
    let cursor = eqIdx + 1;

    if (content[cursor] !== "'") {
      const nl = content.indexOf('\n', cursor);
      pos = nl === -1 ? content.length : nl + 1;
      continue;
    }
    cursor += 1;

    let value = '';
    let closed = false;
    while (cursor < content.length) {
      const ch = content[cursor];
      if (ch === "'") {
        // `'\''` (4 chars: `'`, `\`, `'`, `'`) decodes to a single quote.
        if (content.startsWith("\\''", cursor + 1)) {
          value += "'";
          cursor += 4;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }
      value += ch;
      cursor += 1;
    }

    if (closed && name) {
      result[name] = value;
    }

    const nl = content.indexOf('\n', cursor);
    pos = nl === -1 ? content.length : nl + 1;
  }

  return { values: result, unsetKeys };
}
