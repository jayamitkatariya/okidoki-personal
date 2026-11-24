import { ENGINE_AGENT_PROVIDERS, type AgentProvider } from './agent';
import { canUseClaudeFastMode } from './engine/types';

export type SlashCommandMode = 'goal' | 'fast';
export type SlashCommandModeState = Record<`${SlashCommandMode}Mode`, boolean>;
export type SlashCommandModeFlags = Partial<SlashCommandModeState>;

export interface ParsedSlashCommandPrefix extends SlashCommandModeState {
  message: string;
  commands: SlashCommandMode[];
}

export interface NormalizedSlashCommandModes extends SlashCommandModeState {
  message: string;
}

export interface SlashCommandModeRequestFields {
  goalMode?: true;
  fastMode?: true;
}

const EMPTY_SLASH_COMMAND_PREFIX: ParsedSlashCommandPrefix = {
  message: '',
  commands: [],
  goalMode: false,
  fastMode: false,
};

function isSlashCommandMode(value: string): value is SlashCommandMode {
  return value === 'goal' || value === 'fast';
}

export function parseSlashCommandPrefix(message: string): ParsedSlashCommandPrefix {
  let remaining = message.trimStart();
  const commands: ParsedSlashCommandPrefix['commands'] = [];

  for (;;) {
    const match = remaining.match(/^\/(goal|fast)(?=$|\s)/i);
    if (!match) break;

    const command = match[1].toLowerCase();
    if (!isSlashCommandMode(command)) break;

    commands.push(command);
    remaining = remaining.slice(match[0].length).trimStart();
  }

  if (commands.length === 0) {
    return { ...EMPTY_SLASH_COMMAND_PREFIX, message };
  }

  return {
    message: remaining,
    commands,
    goalMode: commands.includes('goal'),
    fastMode: commands.includes('fast'),
  };
}

export function normalizeSlashCommandModes(
  message: string,
  modes: SlashCommandModeFlags = {},
): NormalizedSlashCommandModes {
  const parsed = parseSlashCommandPrefix(message);
  return {
    message: (parsed.commands.length > 0 ? parsed.message : message).trim(),
    goalMode: Boolean(modes.goalMode || parsed.goalMode),
    fastMode: Boolean(modes.fastMode || parsed.fastMode),
  };
}

export function hasNormalizedSlashCommandMessage(modes: Pick<NormalizedSlashCommandModes, 'message'>): boolean {
  return modes.message.trim().length > 0;
}

export function getSlashCommandModeRequestFields(
  agent: AgentProvider,
  modes: SlashCommandModeFlags,
): SlashCommandModeRequestFields {
  return {
    ...(canUseGoalMode(agent) && modes.goalMode ? { goalMode: true } : {}),
    ...(canUseFastMode(agent) && modes.fastMode ? { fastMode: true } : {}),
  };
}

export interface SlashCommand {
  command: `/${string}`;
  description: string;
  argumentHint?: string;
  providers: AgentProvider[];
}

export function normalizeSlashCommandName(name: string): `/${string}` | null {
  const command = name.trim().replace(/^\/+/, '');
  if (!command || /\s/.test(command)) return null;
  return `/${command}`;
}

export function createProviderSlashCommand(
  provider: AgentProvider,
  name: string,
  description?: string,
  argumentHint?: string,
): SlashCommand | null {
  const command = normalizeSlashCommandName(name);
  if (!command) return null;
  const trimmedDescription = description?.trim();
  const trimmedArgumentHint = argumentHint?.trim();
  return {
    command,
    description: trimmedDescription || `Run ${command}.`,
    ...(trimmedArgumentHint ? { argumentHint: trimmedArgumentHint } : {}),
    providers: [provider],
  };
}

const SIDE_CHAT_COMMANDS: readonly `/${string}`[] = ['/btw', '/side'];

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: '/fast',
    description: 'Use the fast service tier for future turns.',
    providers: ['claude', 'codex'],
  },
  {
    command: '/goal',
    description: 'Set, pause, resume, or clear a task goal.',
    argumentHint: '<objective | pause | resume | clear>',
    providers: ['codex'],
  },
  {
    command: '/goal',
    description: 'Set or clear a completion condition to keep working toward.',
    argumentHint: '<condition | clear>',
    providers: ['claude'],
  },
  {
    command: '/compact',
    description: 'Compact the conversation context.',
    providers: ['codex', 'muse'],
  },
  ...SIDE_CHAT_COMMANDS.map((command) => ({
    command,
    description: 'Open a side chat about this chat without interrupting it.',
    argumentHint: '[question]',
    providers: [...ENGINE_AGENT_PROVIDERS],
  })),
];

export function canUseSlashCommandMode(
  provider: AgentProvider,
  mode: SlashCommandMode,
  commands: SlashCommand[] = SLASH_COMMANDS,
): boolean {
  return commands.some((command) => command.command === `/${mode}` && command.providers.includes(provider));
}

export function canUseGoalMode(provider: AgentProvider): boolean {
  return canUseSlashCommandMode(provider, 'goal');
}

// Claude Code goals can only be set or cleared; Codex goals can also be edited, paused, and resumed.
export function canUpdateGoal(provider: AgentProvider): boolean {
  return provider === 'codex';
}

export function canUseFastMode(provider: AgentProvider): boolean {
  return canUseSlashCommandMode(provider, 'fast');
}

export function getComposerCapabilities(provider: AgentProvider, model: string | undefined): {
  canUseThinkingLevel: boolean;
  canUseFastMode: boolean;
  canUseGoalMode: boolean;
} {
  return {
    canUseThinkingLevel: provider !== 'cursor',
    canUseFastMode: canUseFastMode(provider) && (provider !== 'claude' || canUseClaudeFastMode(model)),
    canUseGoalMode: canUseGoalMode(provider),
  };
}

export function withoutSideChatCommands(commands: SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => !SIDE_CHAT_COMMANDS.includes(command.command));
}

export function parseSideChatCommand(message: string): string | null {
  const trimmed = message.trim();
  const [command = ''] = trimmed.split(/\s/, 1);
  return SIDE_CHAT_COMMANDS.some((sideCommand) => sideCommand === command.toLowerCase())
    ? trimmed.slice(command.length).trim()
    : null;
}

export function mergeSlashCommands(...commandGroups: SlashCommand[][]): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const command of commandGroups.flat()) {
    const key = command.command.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
  }
  return commands;
}

export function getSlashCommandsForProvider(
  provider: AgentProvider,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  return commands.filter((command) => command.providers.includes(provider));
}

export function getSlashCommandQuery(input: string, caret = input.length): { query: string; start: number } | null {
  const match = input.slice(0, caret).match(/(?:^|\s)(\/\S*)$/);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length };
}

export function selectSlashCommandInput(input: string, command: string, caret = input.length): { input: string; caret: number; modes: ParsedSlashCommandPrefix } {
  const before = input.slice(0, getSlashCommandQuery(input, caret)?.start ?? caret);
  const after = input.slice(caret);
  const modes = parseSlashCommandPrefix(command);
  if (modes.commands.length > 0) return { input: `${before}${after.replace(/^[ \t]/, '')}`, caret: before.length, modes };
  return { input: `${before}${command}${/^[ \t]/.test(after) ? '' : ' '}${after}`, caret: before.length + command.length + 1, modes };
}

export function stripTypedSlashModePrefix(
  input: string,
  allowed: Pick<SlashCommandModeState, 'goalMode' | 'fastMode'>,
): { input: string; modes: ParsedSlashCommandPrefix } | null {
  const prefix = input.match(/^\/[a-z]+ /)?.[0] ?? '';
  const modes = parseSlashCommandPrefix(prefix);
  return (allowed.goalMode && modes.goalMode) || (allowed.fastMode && modes.fastMode) ? { input: input.slice(prefix.length), modes } : null;
}

export function filterSlashCommands(
  provider: AgentProvider,
  input: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
  caret = input.length,
): SlashCommand[] {
  const word = getSlashCommandQuery(input, caret);
  if (!word) return [];
  const query = word.query.toLowerCase();
  return getSlashCommandsForProvider(provider, commands)
    .filter((command) => command.command.startsWith(query));
}

export type GoalCommand =
  | { type: 'set'; objective: string }
  | { type: 'clear' }
  | { type: 'pause' }
  | { type: 'resume' };

export const MAX_CODEX_GOAL_OBJECTIVE_CHARS = 4000;

function classifyGoalValue(value: string): GoalCommand {
  if (/^(clear|reset|unset)$/i.test(value)) return { type: 'clear' };
  if (/^pause$/i.test(value)) return { type: 'pause' };
  if (/^resume$/i.test(value)) return { type: 'resume' };
  return { type: 'set', objective: value };
}

export function parseGoalCommand(message: string): GoalCommand | null {
  const match = message.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  const value = match?.[1]?.trim();
  if (!value) return null;
  return classifyGoalValue(value);
}

export function isCompactCommand(message: string): boolean {
  return /^\/compact$/i.test(message.trim());
}

export function getGoalCommand(message: string, goalMode?: boolean): GoalCommand | null {
  if (!goalMode) return parseGoalCommand(message);
  const value = message.trim();
  if (!value) return null;
  return classifyGoalValue(value);
}

export function getGoalCommandObjectiveValidationError(message: string, goalMode?: boolean): string | null {
  const command = getGoalCommand(message, goalMode);
  if (command?.type !== 'set') return null;

  const length = command.objective.length;
  if (length <= MAX_CODEX_GOAL_OBJECTIVE_CHARS) return null;

  return `Goal objective must be at most ${MAX_CODEX_GOAL_OBJECTIVE_CHARS} characters (${length} provided). Shorten the /goal objective, or send the extra details as a regular message after setting the goal.`;
}
