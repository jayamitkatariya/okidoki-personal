const ANSI_ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitizeTerminalLine(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').trim();
}

export function stripAnsiEscapes(value: string): string {
  return value.replace(ANSI_ESCAPES, '');
}
