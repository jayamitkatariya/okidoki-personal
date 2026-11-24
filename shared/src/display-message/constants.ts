export const USER_MESSAGE_MATCH_GRACE_PERIOD_MS = 30_000;
export const COMPACTION_CONTENT = 'Context compacted';
export const GOAL_TOOL_NAME = 'goal';
export const CLAUDE_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);
// Claude Code's result for a tool call that a Stop cuts off; its permission denials go on differently.
export const CLAUDE_STOPPED_TOOL_RESULT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing";
