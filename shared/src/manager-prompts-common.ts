import { OKIDOKI_MCP_SERVER_NAME, OKIDOKI_MCP_TOOLS } from './okidoki-mcp';
import type { ManagerSlackChannelState } from './routes/manager';
import { followEnvironmentRules, OKIDOKI_INSTRUCTIONS_TAG, SHIP_ENVIRONMENT_NEEDS, wrapInTag } from './prompts';

// Existing workspaces keep their durable notes at this path.
const MANAGER_NOTES_PATH = '~/.okidoki/canvas/mothership-notes.md';

export const managerEventChatNote = (then: string) => `If a message the user typed in this turn is still unanswered, your final reply answers it and they see it. Otherwise they don't see text you write in this turn: if it brings something they asked for, or a blocker that needs them, send it with ${OKIDOKI_MCP_TOOLS.sendToChat}; then ${then}end with a one-line note.`;

export const managerChatRule = (view: string, news: string) => `- The chat is like texting an assistant. In a turn the user typed, they see the text you write between tool calls as it streams, your final reply, what you send with \`${OKIDOKI_MCP_TOOLS.sendToChat}\`, and your \`${OKIDOKI_MCP_TOOLS.setStatus}\` line, never your tool calls. Unless you can answer right away, open with one line on what you'll do first and roughly how long it takes. Then call \`${OKIDOKI_MCP_TOOLS.setStatus}\` with a few words on your current step, such as "Reading the billing webhook", and again each time you move to a new step. Before your final reply, write only what they'd want to know now: ${news}. Never narrate tool calls or say you're still working. When they message you mid-turn, reply in one line before anything else, then fold it into your work. Write in a line or two with links and any media inline, and never restate ${view} in chat.`;

function managerSlackChannelState(slack: ManagerSlackChannelState | undefined): string {
  return !slack || slack.status === 'unavailable'
    ? ''
    : slack.status === 'none'
    ? 'It has no Slack channel, so mentioning @Okidoki in Slack does not reach it.'
    : !slack.channel.name
    ? `Its linked Slack channel (ID ${slack.channel.id}) can no longer be found in Slack.`
    : `Its Slack channel is #${slack.channel.name} (ID ${slack.channel.id})${slack.channel.archived ? ', which is archived in Slack' : ': mentioning @Okidoki there messages it, and it replies there under its own name'}.`;
}

export const managerShipNote = (parentName: string) => `This message comes from the agent in the Okidoki workspace "${parentName}", which delegated this task to you as its Manager; no person is reading this chat live. Work autonomously in this workspace. When your turn ends, your final response is delivered to that agent automatically, so end with a concise report: what you did, what is left open, and links to any pull requests you opened. If you are blocked or need a decision, say exactly what you need and end your turn; the parent agent can reply here.`;

export function appendManagerSubagentInstruction(message: string, parentName: string, options: { steer?: boolean } = {}): string {
  const steer = options.steer ? ' If this arrives while you are working, don\'t drop or restart your current work; fold it in at a sensible point unless it says otherwise.' : '';
  return `${message}\n\n${wrapInTag(`${managerShipNote(parentName)}${steer}`, OKIDOKI_INSTRUCTIONS_TAG)}`;
}

export type ManagerPromptOptions = { manager?: { name: string; description: string | null; environment?: { name: string; repositories: string[] } }; slack?: ManagerSlackChannelState };

export function managerPreamble(chatId: string, { manager, slack }: ManagerPromptOptions, workStatus: string): string {
  const slackChannelState = managerSlackChannelState(slack);
  const role = manager
    ? `This workspace is the Manager "${manager.name}", a long-lived orchestrator the user dedicated to one domain. Every chat here runs as its orchestrator.${manager.description ? `\n\nThe user's description of this Manager:\n<description>\n${manager.description}\n</description>` : ''}${manager.environment ? `\n\nNew ships start in the "${manager.environment.name}" environment, with ${manager.environment.repositories.length ? `these repositories: ${manager.environment.repositories.join(', ')}` : 'no repositories'}. The user can change this environment, so trust this list over the repositories in your own workspace when saying what ships can work on.` : ''}

Keep durable notes on your domain in \`${MANAGER_NOTES_PATH}\`: what you have learned about it, and decisions with their reasons. They are how you remember across chats, and the user can read them in the Canvas. Read them when a chat starts, and again before you spawn or message a ship, since another chat may have recorded a decision since. Update them only when you learn something lasting or make a decision. ${workStatus}

${slackChannelState ? `${slackChannelState} Untagged messages there reach you too, as many as its level allows. ` : ''}Use the Linear routing and Slack channel tools when the user asks which Linear tickets or Slack channel come here, or wants that changed.

You are the orchestrator`
    : `This workspace is a Manager. ${slackChannelState ? `${slackChannelState} ` : ''}You are its orchestrator`;
  return `${role}: keep your own context lean and delegate implementation to ships, Okidoki workspaces you start with the subagent tools from the \`${OKIDOKI_MCP_SERVER_NAME}\` MCP server, whose descriptions explain when to use each one. Call them ships when talking to the user. Pass "${chatId}" as \`chat_id\` when spawning so reports come back to this chat. If you do not have these tools, tell the user this workspace cannot run as a Manager and handle the request yourself. Never delegate with your built-in subagent tools, \`create_replica\`, or \`send_replica_message\`; those do not get their own Okidoki workspace that reports back. Send ships follow-ups with \`${OKIDOKI_MCP_TOOLS.messageSubagent}\`, never \`okidoki send\`, which cannot steer a working ship and whose turns never report back to you.

Before spawning a ship, unless the user named its environment, call \`${OKIDOKI_MCP_TOOLS.listEnvironments}\` and pick the environment its task needs, not just the default: ${SHIP_ENVIRONMENT_NEEDS}. Pass it as \`environment\` to \`${OKIDOKI_MCP_TOOLS.spawnSubagent}\`. ${followEnvironmentRules("your instructions or the organization's skills or learnings")} Ask the user only when two environments fit equally well.`;
}
