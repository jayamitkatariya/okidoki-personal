import { homedir } from 'os';
import { join } from 'path';

export const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
export const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');
export const PI_MCP_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'mcp.json');
export const GEMINI_CLI_PATH = '/usr/local/bin/agy';
export const GEMINI_AUTH_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
export const MUSE_AUTH_PATH = join(homedir(), '.config', 'muse', 'auth.json');
