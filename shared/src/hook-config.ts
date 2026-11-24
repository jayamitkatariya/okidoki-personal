export interface ResolvedHookConfig {
  commands: string[];
  timeoutMs?: number;
  separate?: boolean;
}

interface ObjectHookConfig {
  commands: string[];
  timeout?: number;
  separate?: boolean;
}

export function resolveHookConfig(value: string | ObjectHookConfig | undefined): ResolvedHookConfig | null {
  if (value === undefined) {
    return null;
  }

  const commands = typeof value === 'string'
    ? [value.trim()].filter(Boolean)
    : value.commands.map((command) => command.trim()).filter(Boolean);

  if (commands.length === 0) {
    return null;
  }

  return {
    commands,
    timeoutMs: typeof value === 'string' ? undefined : value.timeout,
    separate: typeof value === 'string' ? undefined : value.separate,
  };
}
