import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.OKIDOKI_ENGINE_STATE_DIR = mkdtempSync(join(tmpdir(), 'okidoki-engine-state-'));
