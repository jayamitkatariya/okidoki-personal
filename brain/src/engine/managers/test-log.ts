import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentEvent } from '@okidoki/shared';
import { CodexHistoryFile } from './codex-asp/codex-history-file';

export function testLog(
  path = join(mkdtempSync(join(tmpdir(), 'okidoki-history-')), 'history.jsonl'),
  onEvent: (event: AgentEvent) => void = () => {},
) {
  const history = new CodexHistoryFile(path);
  return {
    history,
    onEvent,
    record: (event: AgentEvent): void => {
      onEvent(event);
      history.record(event);
    },
  };
}
