import { join } from 'path';
import type { EngineAgentProvider } from '@okidoki/shared';

// Outside HOME: workspace code can delete the home folder (a repo test cleaning up HOME did), and chats must survive it.
export const ENGINE_DIR = join(process.env.OKIDOKI_ENGINE_STATE_DIR ?? '/var/lib/okidoki', 'engine');
export const CHATS_FILE = join(ENGINE_DIR, 'chats.json');
export const CLAUDE_HISTORY_DIR = join(ENGINE_DIR, 'claude-histories');
export const CODEX_HISTORY_DIR = join(ENGINE_DIR, 'codex-histories');
export const CURSOR_HISTORY_DIR = join(ENGINE_DIR, 'cursor-histories');
export const OPENCODE_HISTORY_DIR = join(ENGINE_DIR, 'opencode-histories');
export const PI_HISTORY_DIR = join(ENGINE_DIR, 'pi-histories');
const GEMINI_HISTORY_DIR = join(ENGINE_DIR, 'gemini-histories');
export const MUSE_HISTORY_DIR = join(ENGINE_DIR, 'muse-histories');
export const FORKS_DIR = join(ENGINE_DIR, 'forks');

export const HISTORY_DIR_BY_PROVIDER: Record<EngineAgentProvider, string> = {
  claude: CLAUDE_HISTORY_DIR,
  codex: CODEX_HISTORY_DIR,
  cursor: CURSOR_HISTORY_DIR,
  gemini: GEMINI_HISTORY_DIR,
  muse: MUSE_HISTORY_DIR,
  opencode: OPENCODE_HISTORY_DIR,
  pi: PI_HISTORY_DIR,
};

