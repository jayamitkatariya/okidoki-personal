import { isAuthenticationErrorText } from './auth-errors';

export function isCodexAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    isAuthenticationErrorText(msg) ||
    lower.includes('authentication') ||
    lower.includes('incorrect api key') ||
    (lower.includes('api key') && lower.includes('invalid')) ||
    /"httpstatuscode":401\b/.test(lower) ||
    lower.includes('codexerrorinfo="unauthorized"') ||
    lower.includes('codexerrorinfo=unauthorized') ||
    lower.includes('failed to refresh token') ||
    lower.includes('your session has ended')
  );
}
