import { getProviderDisplayName, isValidAgentProvider } from '../agent';
import type { CodexAspTranscriptPatchOperation } from '../engine/v1';
import { extractManagerEvents, type ManagerEvent } from '../manager-events';
import { LEARNED_SKILL_DIR_PREFIX } from '../learned-skills';
import { OKIDOKI_MCP_SERVER_NAME, OKIDOKI_MCP_TOOLS } from '../okidoki-mcp';
import { isRecord } from '../type-guards';
import { UUID_RE } from '../uuid';
import { workspaceTargetFromToolOutput } from '../workspace-target';
import { parseShellScript, SHELL_OPAQUE } from '../shell-commands';
import { isSubagentMcpToolName, SUBAGENT_MCP_TOOLS, type SubagentMcpToolName } from '../subagent-mcp';
import { formatTurnElapsed } from '../format';
import { commandDisplayFromCommand, getDisplayMessageStatus, getFileLabel, operationDiffStats, peerChatName, plural, fileNameFromPath } from './format';
import { parseMcpToolName } from './parsers/mcp';
import { skillNameFromFilePath } from './parsers/utils';
import { subagentChatId, subagentToolName } from './subagent-tools';
import { parseToolCallInput } from './tool-call';
import { isCompaction, isGoalUpdate } from './turns';
import type { BackgroundTaskMessage, DisplayMessage, ToolCallMessage } from './types';

export type StepCategory = 'edit' | 'read' | 'search' | 'command' | 'web' | 'agent' | 'message' | 'think' | 'compact' | 'tool' | 'skill' | 'learning' | 'task' | 'retry';
export type StepIcon = 'archive' | 'bell' | 'book' | 'bot' | 'brain' | 'clock' | 'file-pen' | 'file-plus' | 'file-x' | 'fold' | 'folder' | 'globe'
  | 'lightbulb' | 'list' | 'message' | 'network' | 'search' | 'send' | 'target' | 'terminal' | 'trash' | 'wrench' | 'zap';
type StepDetail = 'shell' | 'diff' | 'results' | 'reasoning' | 'io' | 'subagent' | 'manager' | 'peer';

interface ManagerCall {
  action: 'spawn' | 'send' | 'list' | 'read' | 'archive' | 'wait';
  name?: string;
  agentId?: string;
  chatId?: string;
  text?: string;
  events?: ManagerEvent[];
}

export interface DisplayStep {
  key: string;
  message: DisplayMessage;
  category: StepCategory;
  icon: StepIcon;
  live: string;
  done: string;
  target?: { text: string; path?: string; plain?: boolean };
  scope?: string;
  meta?: string;
  running: boolean;
  stopped?: boolean;
  failed: boolean;
  durationMs?: number;
  detail?: StepDetail;
  operation?: CodexAspTranscriptPatchOperation;
  background?: BackgroundTaskMessage;
  manager?: ManagerCall;
  workspace?: { id: string; name?: string };
}

export function stepVerb(step: DisplayStep): string {
  if (step.category === 'think' && !step.running && (step.durationMs ?? 0) >= 1000) return `Thought for ${formatTurnElapsed(step.durationMs ?? 0)}`;
  return step.running ? step.live : step.done;
}

export function stepLabel(step: DisplayStep): string {
  const target = step.category === 'think' ? undefined : step.target?.path ? getFileLabel(step.target.path) : step.target?.text;
  return target ? `${stepVerb(step)} ${target}` : stepVerb(step);
}

export function inputString(input: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

const COMMAND_PARSE_LIMIT = 4096;

function shellPayload(command: string): string {
  const [first] = parseShellScript(command, null);
  const flag = first?.wrapper ? first.argv.findIndex((arg, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) : -1;
  return (flag > 0 ? first.argv[flag + 1] : undefined)?.replaceAll(SHELL_OPAQUE, '…') ?? command.trim();
}

function commandLabel(command: string): string {
  const lines = shellPayload(command.slice(0, COMMAND_PARSE_LIMIT)).replace(/^cd\s+\S+\s*&&\s*/, '').split('\n').filter((line) => line.trim());
  const shown = lines.length > 1 && /(["']|<<-?\s*['"]?\w+['"]?)\s*$/.test(lines[0]) ? 2 : 1;
  const label = lines.slice(0, shown).map((line) => line.trim()).join(' ');
  return lines.length > shown ? `${label} …` : label;
}

const BACKGROUND_META: Record<BackgroundTaskMessage['status'], string> = {
  in_progress: 'Running in background',
  completed: 'Done in background',
  failed: 'Failed in background',
  stopped: 'Stopped in background',
};

const OPERATION_VERBS: Record<string, [string, string, StepIcon]> = {
  add: ['Creating', 'Created', 'file-plus'],
  delete: ['Deleting', 'Deleted', 'file-x'],
  update: ['Editing', 'Edited', 'file-pen'],
};

type StepBase = Omit<DisplayStep, 'key' | 'category' | 'icon' | 'live' | 'done'>;

function skillStep(base: StepBase, key: string, skillName: string): DisplayStep {
  return skillName.startsWith(LEARNED_SKILL_DIR_PREFIX)
    ? { ...base, key, category: 'learning', icon: 'lightbulb', live: 'Using learning', done: 'Used learning', target: { text: skillName.slice(LEARNED_SKILL_DIR_PREFIX.length) } }
    : { ...base, key, category: 'skill', icon: 'zap', live: 'Using skill', done: 'Used skill', target: { text: skillName } };
}

function describeMessageSteps(message: DisplayMessage, durationMs?: number, background?: BackgroundTaskMessage): DisplayStep[] {
  const status = getDisplayMessageStatus(message);
  const base = {
    message,
    running: status === 'in_progress',
    failed: status === 'failed',
    durationMs,
  };

  switch (message.type) {
    case 'reasoning':
      if (isCompaction(message)) {
        return [{ ...base, key: message.id, category: 'compact', icon: 'fold', live: 'Compacting context', done: base.failed ? 'Context compaction' : 'Compacted context' }];
      }
      if (!message.content.trim()) return [];
      return [{ ...base, key: message.id, category: 'think', icon: 'brain', live: 'Thinking', done: 'Thought', failed: false, detail: 'reasoning' }];
    case 'command': {
      const policyBlocked = message.status === 'failed' && message.exitCode == null
        && Boolean(message.output?.toLowerCase().includes('blocked by organization policy'));
      const display = policyBlocked || message.command.length > COMMAND_PARSE_LIMIT ? null : commandDisplayFromCommand(message.command);
      const failed = policyBlocked || base.failed || (message.exitCode != null && message.exitCode !== 0) || background?.status === 'failed';
      const running = background ? background.status === 'in_progress' : base.running;
      const meta = policyBlocked
        ? 'Blocked by policy'
        : background
          ? BACKGROUND_META[background.status]
          : failed && message.exitCode != null ? `Exit code ${message.exitCode}` : undefined;
      const shell: StepBase = { ...base, meta, running, failed, detail: 'shell', background };
      const pathSkills = display?.paths.map(skillNameFromFilePath) ?? [];
      if ((display?.title.startsWith('Read') || display?.title === 'List' || (display?.title === 'Search' && pathSkills.every(Boolean))) && display.paths.length > 0) {
        return display.paths.map((path, index): DisplayStep => {
          const key = index ? `${message.id}-${index}` : message.id;
          const skillName = pathSkills[index];
          if (skillName) return skillStep(shell, key, skillName);
          return display.title === 'List'
            ? { ...shell, key, category: 'read', icon: 'folder', live: 'Listing', done: 'Listed', target: { text: path, path } }
            : { ...shell, key, category: 'read', icon: 'book', live: 'Reading', done: 'Read', target: { text: path, path } };
        });
      }
      if (display?.title === 'Write') {
        return [{ ...shell, key: message.id, category: 'edit', icon: 'file-pen', live: 'Writing', done: 'Wrote', target: { text: display.paths[0], path: display.paths[0] } }];
      }
      return [...(message.skillNames ?? []).map((skillName) => skillStep(shell, `${message.id}-${skillName}`, skillName)), {
        ...shell,
        key: message.id,
        category: display?.title === 'Search' ? 'search' : 'command',
        icon: 'terminal',
        live: 'Running',
        done: 'Ran',
        target: { text: commandLabel(message.command) },
      }];
    }
    case 'patch':
      return message.operations.map((operation, index): DisplayStep => {
        const [live, done, icon] = OPERATION_VERBS[operation.action] ?? OPERATION_VERBS.update;
        return {
          ...base,
          key: `${message.id}-${index}`,
          category: 'edit',
          icon,
          live,
          done,
          target: { text: operation.moveTo ?? operation.path, path: operation.moveTo ?? operation.path },
          detail: operation.diff ? 'diff' : undefined,
          operation,
        };
      });
    case 'file_change':
      return message.changes.map((change, index): DisplayStep => {
        const [live, done, icon] = OPERATION_VERBS[change.kind] ?? OPERATION_VERBS.update;
        return { ...base, key: `${message.id}-${index}`, category: 'edit', icon, live, done, target: { text: change.path, path: change.path } };
      });
    case 'web_search':
      return [{ ...base, key: message.id, category: 'web', icon: 'globe', live: 'Searching the web for', done: 'Searched the web for', target: { text: message.query } }];
    case 'skill':
      return [skillStep(base, message.id, message.skillName)];
    case 'subagent':
      return [{
        ...base,
        // A foreground agent's spawning call returns only when it finishes, so its result settles the step even when the
        // task's own completion was never recorded. A backgrounded agent's call returns at launch.
        ...(background?.isBackgrounded && { running: background.status === 'in_progress', failed: background.status === 'failed' }),
        key: message.id,
        category: 'agent',
        icon: 'bot',
        live: 'Running',
        done: 'Ran',
        target: { text: message.description, plain: true },
        background,
      }];
    case 'background_task':
      if (message.toolUseId) return [];
      return [{ ...base, key: message.id, category: 'task', icon: 'bell', live: 'Running', done: 'Ran', target: { text: message.description ?? message.summary ?? 'background task', plain: true } }];
    case 'peer_message':
      return [message.direction === 'received'
        ? { ...base, key: message.id, category: 'message', icon: 'message', live: 'Message from', done: 'Message from', target: { text: peerChatName(message), plain: true }, detail: 'peer' }
        : { ...base, key: message.id, category: 'message', icon: 'send', live: 'Messaging', done: 'Messaged', target: { text: peerChatName(message), plain: true }, detail: 'peer' }];
    case 'tool_call': {
      const step = describeToolCall(message, base);
      return step ? [step] : [];
    }
    case 'capacity_retry':
      return [{
        ...base,
        key: message.id,
        category: 'retry',
        icon: 'clock',
        live: 'Retrying',
        done: 'Retried',
        target: { text: `(${message.reason ?? 'model at capacity'}, ${message.attempt} of ${message.maxAttempts})`, plain: true },
      }];
    default:
      return [];
  }
}

const SUBAGENT_STEPS: Record<Exclude<SubagentMcpToolName, typeof SUBAGENT_MCP_TOOLS.spawnAgent>, Pick<DisplayStep, 'icon' | 'live' | 'done'>> = {
  [SUBAGENT_MCP_TOOLS.messageAgent]: { icon: 'message', live: 'Messaging', done: 'Messaged' },
  [SUBAGENT_MCP_TOOLS.waitAgent]: { icon: 'clock', live: 'Waiting for', done: 'Waited for' },
  [SUBAGENT_MCP_TOOLS.getAgent]: { icon: 'search', live: 'Checking', done: 'Checked' },
  [SUBAGENT_MCP_TOOLS.deleteAgent]: { icon: 'trash', live: 'Deleting', done: 'Deleted' },
  [SUBAGENT_MCP_TOOLS.getProviders]: { icon: 'list', live: 'Listing available providers', done: 'Listed available providers' },
};

const MANAGER_TOOL_ACTIONS: Record<string, ManagerCall['action']> = {
  [OKIDOKI_MCP_TOOLS.spawnSubagent]: 'spawn',
  [OKIDOKI_MCP_TOOLS.messageSubagent]: 'send',
  [OKIDOKI_MCP_TOOLS.listSubagents]: 'list',
  [OKIDOKI_MCP_TOOLS.readSubagent]: 'read',
  [OKIDOKI_MCP_TOOLS.archiveSubagent]: 'archive',
  [OKIDOKI_MCP_TOOLS.waitForSubagents]: 'wait',
};

const OKIDOKI_API_STEPS: Record<string, Pick<DisplayStep, 'icon' | 'live' | 'done'>> = {
  [OKIDOKI_MCP_TOOLS.createReplica]: { icon: 'network', live: 'Creating workspace', done: 'Created workspace' },
  [OKIDOKI_MCP_TOOLS.listOkidoki]: { icon: 'list', live: 'Listing workspaces', done: 'Listed workspaces' },
  [OKIDOKI_MCP_TOOLS.getReplica]: { icon: 'search', live: 'Checking workspace', done: 'Checked workspace' },
  [OKIDOKI_MCP_TOOLS.deleteReplica]: { icon: 'trash', live: 'Deleting workspace', done: 'Deleted workspace' },
  [OKIDOKI_MCP_TOOLS.wakeReplica]: { icon: 'zap', live: 'Waking workspace', done: 'Woke workspace' },
  [OKIDOKI_MCP_TOOLS.sleepReplica]: { icon: 'clock', live: 'Putting workspace to sleep', done: 'Put workspace to sleep' },
  [OKIDOKI_MCP_TOOLS.archiveReplica]: { icon: 'archive', live: 'Archiving workspace', done: 'Archived workspace' },
  [OKIDOKI_MCP_TOOLS.waitForReplica]: { icon: 'clock', live: 'Waiting for workspace', done: 'Waited for workspace' },
  [OKIDOKI_MCP_TOOLS.runCommand]: { icon: 'terminal', live: 'Running', done: 'Ran' },
  [OKIDOKI_MCP_TOOLS.getReplicaHooks]: { icon: 'terminal', live: 'Reading hook logs', done: 'Read hook logs' },
  [OKIDOKI_MCP_TOOLS.whoami]: { icon: 'search', live: 'Checking identity', done: 'Checked identity' },
  [OKIDOKI_MCP_TOOLS.sendReplicaMessage]: { icon: 'message', live: 'Messaging workspace', done: 'Messaged workspace' },
  [OKIDOKI_MCP_TOOLS.readReplicaHistory]: { icon: 'book', live: 'Reading workspace history', done: 'Read workspace history' },
  [OKIDOKI_MCP_TOOLS.listChats]: { icon: 'list', live: 'Listing chats', done: 'Listed chats' },
  [OKIDOKI_MCP_TOOLS.createChat]: { icon: 'message', live: 'Creating chat', done: 'Created chat' },
  [OKIDOKI_MCP_TOOLS.deleteChat]: { icon: 'trash', live: 'Deleting chat', done: 'Deleted chat' },
  [OKIDOKI_MCP_TOOLS.listRepositories]: { icon: 'folder', live: 'Listing repositories', done: 'Listed repositories' },
  [OKIDOKI_MCP_TOOLS.listEnvironments]: { icon: 'list', live: 'Listing environments', done: 'Listed environments' },
  [OKIDOKI_MCP_TOOLS.createAutomation]: { icon: 'clock', live: 'Creating automation', done: 'Created automation' },
  [OKIDOKI_MCP_TOOLS.getLinearRouting]: { icon: 'search', live: 'Checking Linear routing', done: 'Checked Linear routing' },
  [OKIDOKI_MCP_TOOLS.setLinearRouting]: { icon: 'wrench', live: 'Setting Linear routing', done: 'Set Linear routing' },
  [OKIDOKI_MCP_TOOLS.clearLinearRouting]: { icon: 'trash', live: 'Clearing Linear routing', done: 'Cleared Linear routing' },
  [OKIDOKI_MCP_TOOLS.getSlackChannel]: { icon: 'search', live: 'Checking Slack channel', done: 'Checked Slack channel' },
  [OKIDOKI_MCP_TOOLS.linkSlackChannel]: { icon: 'wrench', live: 'Linking Slack channel', done: 'Linked Slack channel' },
  [OKIDOKI_MCP_TOOLS.createSlackChannel]: { icon: 'wrench', live: 'Creating Slack channel', done: 'Created Slack channel' },
  [OKIDOKI_MCP_TOOLS.unlinkSlackChannel]: { icon: 'trash', live: 'Unlinking Slack channel', done: 'Unlinked Slack channel' },
  [OKIDOKI_MCP_TOOLS.setSlackChannelLevel]: { icon: 'wrench', live: 'Changing Slack channel level', done: 'Changed Slack channel level' },
  // Tools Managers no longer have, so older chats still label them.
  get_board: { icon: 'book', live: 'Reading board', done: 'Read board' },
  update_board: { icon: 'file-pen', live: 'Updating board', done: 'Updated board' },
  update_ticket: { icon: 'file-pen', live: 'Updating ticket', done: 'Updated ticket' },
  reply_on_ticket: { icon: 'file-pen', live: 'Replying on ticket', done: 'Replied on ticket' },
  [OKIDOKI_MCP_TOOLS.sendToChat]: { icon: 'message', live: 'Sending to chat', done: 'Sent to chat' },
  [OKIDOKI_MCP_TOOLS.setStatus]: { icon: 'message', live: 'Setting status', done: 'Set status' },
  [OKIDOKI_MCP_TOOLS.mergeWhenReady]: { icon: 'target', live: 'Setting merge when ready', done: 'Set merge when ready' },
};

function okidokiToolName(message: ToolCallMessage): string | undefined {
  const mcp = parseMcpToolName(message.tool);
  return (mcp?.server ?? message.server) === OKIDOKI_MCP_SERVER_NAME ? mcp?.tool ?? message.tool
    : message.tool.startsWith(`${OKIDOKI_MCP_SERVER_NAME}_`) ? message.tool.slice(OKIDOKI_MCP_SERVER_NAME.length + 1) : undefined;
}


export function sentToChat(message: DisplayMessage): string | undefined {
  if (message.type !== 'tool_call' || message.status === 'failed' || okidokiToolName(message) !== OKIDOKI_MCP_TOOLS.sendToChat) return undefined;
  return inputString(parseToolCallInput(message.input).inputObject, 'message');
}

export function statusSet(message: DisplayMessage): string | undefined {
  if (message.type !== 'tool_call' || message.status === 'failed' || okidokiToolName(message) !== OKIDOKI_MCP_TOOLS.setStatus) return undefined;
  return inputString(parseToolCallInput(message.input).inputObject, 'status');
}

export function startsOrMessagesShip(message: DisplayMessage): boolean {
  if (message.type !== 'tool_call') return false;
  const tool = okidokiToolName(message);
  return tool === OKIDOKI_MCP_TOOLS.spawnSubagent || tool === OKIDOKI_MCP_TOOLS.messageSubagent;
}

const INTERNAL_TOOLS = new Set(['ToolSearch', 'ListAgents', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'TaskOutput', 'BashOutput']);

function describeToolCall(
  message: Extract<DisplayMessage, { type: 'tool_call' }>,
  base: Pick<DisplayStep, 'message' | 'running' | 'failed' | 'durationMs'>,
): DisplayStep | null {
  const { inputObject: input, filePath } = parseToolCallInput(message.input);
  const tool = message.tool;
  const key = message.id;

  if (INTERNAL_TOOLS.has(tool)) return null;
  if (isGoalUpdate(message)) {
    const objective = inputString(input, 'objective');
    return objective
      ? { ...base, key, category: 'tool', icon: 'target', live: 'Setting goal', done: 'Set goal', target: { text: objective, plain: true } }
      : { ...base, key, category: 'tool', icon: 'target', live: 'Clearing goal', done: 'Cleared goal' };
  }
  const subagentTool = subagentToolName(message);
  if (subagentTool && isSubagentMcpToolName(subagentTool)) {
    const failed = base.failed || typeof parseToolCallInput(message.output).inputObject?.error === 'string';
    if (subagentTool === SUBAGENT_MCP_TOOLS.spawnAgent) {
      return { ...base, key, category: 'agent', icon: 'bot', live: 'Running', done: 'Started', failed, target: { text: inputString(input, 'title', 'prompt') ?? 'subagent', plain: true } };
    }
    const chatId = subagentChatId(message);
    const provider = typeof input?.provider === 'string' && isValidAgentProvider(input.provider) ? input.provider : null;
    const agent = inputString(input, 'title') ?? chatId?.slice(0, 8) ?? (provider ? getProviderDisplayName(provider) : undefined);
    return { ...base, key, category: 'tool', ...SUBAGENT_STEPS[subagentTool], failed, target: agent ? { text: agent, plain: true } : undefined, detail: 'subagent' };
  }
  const mcp = parseMcpToolName(tool);
  const okidokiTool = okidokiToolName(message);
  const managerAction = okidokiTool ? MANAGER_TOOL_ACTIONS[okidokiTool] : undefined;
  if (managerAction) {
    const target = workspaceTargetFromToolOutput(message.output);
    const step = {
      ...base,
      key,
      failed: base.failed || Boolean(message.output?.startsWith('Error:')),
      manager: { action: managerAction, name: inputString(input, 'name') ?? target?.label, agentId: inputString(input, 'agent_id') ?? target?.id, chatId: inputString(input, 'chat_id'), text: inputString(input, 'prompt', 'message') },
    };
    if (managerAction === 'spawn') return { ...step, category: 'agent', icon: 'network', live: 'Spawning', done: 'Spawned', detail: 'manager' };
    if (managerAction === 'send') return { ...step, category: 'agent', icon: 'message', live: 'Messaging', done: 'Messaged', detail: 'manager' };
    if (managerAction === 'wait') {
      return { ...step, category: 'agent', icon: 'clock', live: 'Waiting for ships', done: 'Waited for ships', detail: 'manager', manager: { ...step.manager, events: extractManagerEvents(message.output ?? '') } };
    }
    if (managerAction === 'archive') return { ...step, category: 'tool', icon: 'archive', live: 'Archiving ship', done: 'Archived ship', detail: 'io' };
    return managerAction === 'list'
      ? { ...step, category: 'tool', icon: 'network', live: 'Listing ships', done: 'Listed ships', detail: 'io' }
      : { ...step, category: 'tool', icon: 'network', live: 'Reading ship response', done: 'Read ship response', detail: 'io' };
  }
  const okidokiStep = okidokiTool ? OKIDOKI_API_STEPS[okidokiTool] : undefined;
  if (okidokiStep) {
    const replica = parseToolCallInput(message.output).inputObject?.replica;
    const replicaFields = isRecord(replica) ? replica : null;
    const command = okidokiTool === OKIDOKI_MCP_TOOLS.runCommand ? inputString(input, 'command') : undefined;
    const name = inputString(input, 'name') ?? inputString(replicaFields, 'name');
    const workspaceId = inputString(input, 'id') ?? inputString(replicaFields, 'id');
    const label = command ? commandLabel(command) : okidokiTool === OKIDOKI_MCP_TOOLS.setStatus ? inputString(input, 'status') : inputString(input, 'title') ?? (okidokiTool === OKIDOKI_MCP_TOOLS.createAutomation ? name : undefined);
    return {
      ...base,
      key,
      category: 'tool',
      ...okidokiStep,
      target: label ? { text: label, plain: !command } : undefined,
      workspace: workspaceId && UUID_RE.test(workspaceId) ? { id: workspaceId, name } : undefined,
      detail: message.input || message.output ? 'io' : undefined,
    };
  }
  const shellCommand = /^(bash|shell|run_shell_command)$/i.test(tool) ? inputString(input, 'command', 'cmd') : undefined;
  if (shellCommand) {
    return { ...base, key, category: 'command', icon: 'terminal', live: 'Running', done: 'Ran', target: { text: commandLabel(shellCommand) }, detail: 'io' };
  }
  if (/^(read|read_file|view)$/i.test(tool) && filePath) {
    return { ...base, key, category: 'read', icon: 'book', live: 'Reading', done: 'Read', target: { text: filePath, path: filePath }, detail: 'io' };
  }
  if (/^(grep|glob|search|find|codebase_search|file_search)$/i.test(tool)) {
    const scope = inputString(input, 'path', 'glob', 'include', 'target_directories');
    return {
      ...base,
      key,
      category: 'search',
      icon: 'search',
      live: 'Searching for',
      done: 'Searched for',
      target: { text: inputString(input, 'pattern', 'query', 'glob_pattern', 'globPattern') ?? tool },
      scope,
      detail: message.output ? 'results' : undefined,
    };
  }
  if (/^(ls|list_dir|list_directory)$/i.test(tool)) {
    const path = inputString(input, 'path', 'relative_workspace_path') ?? '.';
    return { ...base, key, category: 'read', icon: 'folder', live: 'Listing', done: 'Listed', target: { text: path, path }, detail: 'io' };
  }
  if (/^(webfetch|web_fetch|fetch)$/i.test(tool)) {
    return { ...base, key, category: 'web', icon: 'globe', live: 'Fetching', done: 'Fetched', target: { text: inputString(input, 'url') ?? tool }, detail: 'io' };
  }
  if (/^(websearch|web_search)$/i.test(tool)) {
    return { ...base, key, category: 'web', icon: 'globe', live: 'Searching the web for', done: 'Searched the web for', target: { text: inputString(input, 'query') ?? tool } };
  }
  if ((/^(edit|write|multiedit|notebookedit|apply_patch|str_replace)/i.test(tool)) && filePath) {
    return { ...base, key, category: 'edit', icon: 'file-pen', live: 'Editing', done: 'Edited', target: { text: filePath, path: filePath }, detail: 'io' };
  }
  return {
    ...base,
    key,
    category: 'tool',
    icon: 'wrench',
    live: 'Calling',
    done: 'Called',
    target: { text: mcp?.tool ?? tool },
    scope: mcp?.server ?? (message.server && message.server !== 'claude' ? message.server : undefined),
    detail: message.input || message.output ? 'io' : undefined,
  };
}

type DiffStats = { added: number; removed: number };

export interface TurnStep extends DisplayStep {
  stats?: DiffStats;
}

const stepCache = new WeakMap<DisplayMessage, { durationMs?: number; background?: BackgroundTaskMessage; steps: TurnStep[] }>();

export function describeSteps(
  message: DisplayMessage,
  { durations, backgroundTasks }: { durations: ReadonlyMap<string, number>; backgroundTasks?: ReadonlyMap<string, BackgroundTaskMessage> },
): TurnStep[] {
  const durationMs = durations.get(message.id);
  const backgroundId = message.type === 'command' ? /^Command running in background with ID: (\w+)/.exec(message.output ?? '')?.[1]
    : message.type === 'subagent' ? message.toolUseId
      : undefined;
  const background = backgroundId ? backgroundTasks?.get(backgroundId) : undefined;
  const cached = stepCache.get(message);
  if (cached && cached.durationMs === durationMs && cached.background === background) return cached.steps;
  const steps = describeMessageSteps(message, durationMs, background).map((step): TurnStep => ({
    ...step,
    stats: step.operation && !step.failed ? operationDiffStats(step.operation) : undefined,
  }));
  stepCache.set(message, { durationMs, background, steps });
  return steps;
}

// Unchanged steps keep the same array and set so rows skip re-rendering on each token.
const groupStepCache = new WeakMap<DisplayMessage, TurnStep[]>();
const fixedKeyCache = new WeakMap<DisplayMessage, ReadonlySet<string>>();

const NO_DURATIONS = new Map<string, number>();

function plainStepLabel(step: TurnStep): string | undefined {
  const { message } = step;
  const description = message.type === 'command' ? message.description
    : message.type === 'tool_call' && step.category === 'command' ? inputString(parseToolCallInput(message.input).inputObject, 'description') : undefined;
  if (description) return description;
  if (step.category === 'command' || (step.category === 'search' && message.type === 'command')) return undefined;
  if (step.category === 'tool' && step.scope) {
    const server = step.scope.replace(/^(claude_ai|plugin_[^_]+)_/, '').replace(/[-_]+/g, ' ').replace(/ mcp$/i, '');
    return `Using ${server.charAt(0).toUpperCase()}${server.slice(1)}`;
  }
  const target = step.target?.path ? fileNameFromPath(step.target.path) : step.target?.text;
  return [step.live, target].filter(Boolean).join(' ');
}

export function lastPlainStepLabel(messages: DisplayMessage[]): string | undefined {
  const step = messages.slice(messages.findLastIndex((message) => message.type === 'user') + 1)
    .flatMap((message) => describeSteps(message, { durations: NO_DURATIONS }))
    .findLast((candidate) => candidate.category !== 'think' && candidate.category !== 'compact' && plainStepLabel(candidate));
  return step && plainStepLabel(step);
}

// The engine reads one event at a time, so it passes the last plain step from its earlier events.
export function currentStepLabel(messages: DisplayMessage[], earlierPlainStep?: string): string | undefined {
  const step = messages.flatMap((message) => describeSteps(message, { durations: NO_DURATIONS })).findLast((candidate) => candidate.running);
  if (!step) return undefined;
  return plainStepLabel(step) ?? lastPlainStepLabel(messages) ?? earlierPlainStep;
}

export function describeGroupSteps(messages: DisplayMessage[], context: Parameters<typeof describeSteps>[1]): TurnStep[] {
  const steps = messages.flatMap((message) => describeSteps(message, context));
  const cached = groupStepCache.get(messages[0]);
  if (cached && cached.length === steps.length && cached.every((step, index) => step === steps[index])) return cached;
  groupStepCache.set(messages[0], steps);
  return steps;
}

function joinSentence(rawParts: string[]): string {
  const parts: string[] = [];
  for (const part of rawParts) {
    const verb = part.split(' ')[0];
    const previous = parts.at(-1);
    if (previous?.startsWith(`${verb} `) && !previous.includes(' and ') && Number.isFinite(Number(part.split(' ')[1]))) {
      parts[parts.length - 1] = `${previous} and ${part.slice(verb.length + 1)}`;
    } else {
      parts.push(part);
    }
  }
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2 && !parts.some((part) => part.includes(' and '))) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, ${parts.length > 2 ? 'and ' : ''}${parts.at(-1)}`;
}

const addStats = (a: DiffStats | undefined, b: DiffStats | undefined) => a && b ? { added: a.added + b.added, removed: a.removed + b.removed } : a ?? b;

export const appliedEdit = (step: TurnStep) => step.category === 'edit' && !step.failed && !step.running && !step.stopped;

export function changedFiles(steps: TurnStep[]): { files: Map<string, { step: TurnStep; verb: string; stats?: DiffStats }>; stats?: DiffStats } {
  const files = new Map<string, { step: TurnStep; verb: string; stats?: DiffStats }>();
  for (const step of steps) {
    if (!appliedEdit(step) || !step.target?.path) continue;
    const file = files.get(step.target.path);
    files.set(step.target.path, { step, verb: step.done === 'Deleted' ? step.done : file?.verb ?? step.done, stats: addStats(file?.stats, step.stats) });
  }
  return { files, stats: [...files.values()].reduce<DiffStats | undefined>((sum, file) => addStats(sum, file.stats), undefined) };
}

export function summarizeSteps(steps: TurnStep[], fixedKeys: ReadonlySet<string>): { text: string; icon: StepIcon; stats?: DiffStats; failed: number; fixed: number; stopped: number } {
  const count = (category: StepCategory) => steps.filter((step) => step.category === category).length;
  const fileVerbs = new Map<string, string>();
  for (const step of steps) if (appliedEdit(step)) fileVerbs.set(step.target?.path ?? step.key, fileVerbs.get(step.target?.path ?? step.key) ?? step.done.toLowerCase());
  const filesWith = (verb: string) => [...fileVerbs.values()].filter((value) => value === verb).length;
  const unique = (match: (step: TurnStep) => boolean) => new Set(steps.filter(match).map((step) => step.target?.path ?? step.target?.text ?? step.key)).size;
  const listed = unique((step) => step.category === 'read' && step.icon === 'folder');
  const read = unique((step) => step.category === 'read' && step.icon !== 'folder');
  const skills = unique((step) => step.category === 'skill');
  const learnings = unique((step) => step.category === 'learning');
  const searches = count('search');
  const commands = count('command');
  const agents = count('agent');
  const web = count('web');
  const tools = count('tool');
  const tasks = count('task');
  const thought = steps.filter((step) => step.category === 'think').reduce((sum, step) => sum + (step.durationMs ?? 0), 0);

  const parts = [
    ...['created', 'deleted', 'edited', 'wrote'].map((verb) => filesWith(verb) && `${verb} ${plural(filesWith(verb), 'file')}`),
    skills && `used ${plural(skills, 'skill')}`,
    learnings && `used ${plural(learnings, 'learning')}`,
    read && `read ${plural(read, 'file')}`,
    listed && `listed ${plural(listed, 'folder')}`,
    searches && `ran ${plural(searches, 'search', 'es')}`,
    commands && `ran ${plural(commands, 'command')}`,
    agents && `ran ${plural(agents, 'agent')}`,
    web && 'searched the web',
    tools && `called ${plural(tools, 'tool')}`,
    tasks && `ran ${plural(tasks, 'background task')}`,
  ].filter((part): part is string => Boolean(part));
  const sentence = joinSentence(parts) || (thought >= 1000 ? `thought for ${Math.round(thought / 1000)}s` : count('think') ? 'thought' : 'worked');

  const stats = steps.reduce<DiffStats | undefined>((sum, step) => appliedEdit(step) ? addStats(sum, step.stats) : sum, undefined);
  const failedSteps = steps.filter((step) => step.failed);
  const fixed = failedSteps.filter((step) => fixedKeys.has(step.key)).length;

  return {
    text: sentence[0].toUpperCase() + sentence.slice(1),
    icon: agents ? 'bot' : fileVerbs.size ? 'file-pen' : read ? 'book' : listed ? 'folder' : searches ? 'search' : commands ? 'terminal' : tools ? 'wrench' : steps[0]?.icon ?? 'brain',
    stats,
    failed: failedSteps.length - fixed,
    fixed,
    stopped: steps.filter((step) => step.stopped).length,
  };
}

export function fixedStepKeys(steps: TurnStep[]): ReadonlySet<string> {
  const fixed = new Set<string>();
  const succeeded = new Set<string>();
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const retried = step.message.type === 'command' ? step.message.command
      : step.category === 'edit' ? step.target?.path
        : step.message.type === 'tool_call' && step.category === 'command' ? inputString(parseToolCallInput(step.message.input).inputObject, 'command', 'cmd')
          : undefined;
    if (retried === undefined) continue;
    if (step.failed && succeeded.has(retried)) fixed.add(step.key);
    else if (!step.failed && !step.running && !step.stopped) succeeded.add(retried);
  }
  const key = steps[0]?.message;
  if (!key) return fixed;
  const cached = fixedKeyCache.get(key);
  if (cached && cached.size === fixed.size && [...fixed].every((stepKey) => cached.has(stepKey))) return cached;
  fixedKeyCache.set(key, fixed);
  return fixed;
}

export function settleSteps(steps: TurnStep[]): TurnStep[] {
  return steps.map((step) => !step.running || (step.background?.status === 'in_progress' && (step.category !== 'agent' || step.background.isBackgrounded))
    ? step
    : step.category === 'think' || step.category === 'compact'
      ? { ...step, running: false }
      : { ...step, running: false, stopped: true, done: `Stopped ${step.live[0].toLowerCase()}${step.live.slice(1)}` });
}

export function isAgentStep(step: TurnStep | undefined): boolean {
  const message = step?.message;
  return message?.type === 'subagent'
    || message?.type === 'peer_message'
    || (message?.type === 'tool_call' && subagentToolName(message) === 'spawn_agent')
    || step?.detail === 'manager';
}

export interface WaitSummary {
  chatId?: string;
  running: boolean;
  waitedMs: number;
  events: ManagerEvent[];
  failed: TurnStep[];
}

export function groupWaitSteps(steps: TurnStep[]): { steps: TurnStep[]; waits: Map<string, WaitSummary> } {
  const runs = new Map<string, TurnStep[]>();
  const grouped = steps.filter((step, index) => {
    if (step.manager?.action !== 'wait') return true;
    const run = steps[index - 1]?.manager?.action === 'wait' ? [...runs.values()].at(-1) : undefined;
    if (run) run.push(step);
    else runs.set(step.key, [step]);
    return !run;
  });
  const waits = new Map([...runs].map(([key, run]) => [key, {
    chatId: run[0].manager?.chatId,
    running: run.some((step) => step.running),
    waitedMs: run.reduce((total, step) => total + (step.durationMs ?? 0), 0),
    events: run.flatMap((step) => step.manager?.events ?? []).filter((event) => !event.noticed),
    failed: run.filter((step) => step.failed),
  }]));
  return { steps: grouped, waits };
}
