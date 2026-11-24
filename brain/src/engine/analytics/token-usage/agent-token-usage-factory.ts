import { AGENT } from '@okidoki/shared';
import { ClaudeTokenUsageService } from './claude';
import { CodexTokenUsageService } from './codex';
import { CursorTokenUsageService } from './cursor';
import { GeminiTokenUsageService } from './gemini';
import { MuseTokenUsageService } from './muse';
import { OpencodeTokenUsageService } from './opencode';
import { PiTokenUsageService } from './pi';
import type { AgentTokenUsageService, HarnessId } from './types';

export function createAgentTokenUsageService(harness: HarnessId): AgentTokenUsageService | undefined {
  switch (harness) {
    case AGENT.CLAUDE:
      return new ClaudeTokenUsageService();
    case AGENT.CODEX:
      return new CodexTokenUsageService();
    case AGENT.CURSOR:
      return new CursorTokenUsageService();
    case AGENT.GEMINI:
      return new GeminiTokenUsageService();
    case AGENT.MUSE:
      return new MuseTokenUsageService();
    case AGENT.OPENCODE:
      return new OpencodeTokenUsageService();
    case AGENT.PI:
      return new PiTokenUsageService();
    default:
      return undefined;
  }
}
