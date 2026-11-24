import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { HOOK_EXEC_MAX_BUFFER_BYTES } from '@okidoki/shared';

export const execAsync = promisify(exec);
export const execFileAsync = promisify(execFile);

// Aliased so git/* call sites don't read as "hook" buffer.
export const SUBPROCESS_MAX_BUFFER = HOOK_EXEC_MAX_BUFFER_BYTES;
