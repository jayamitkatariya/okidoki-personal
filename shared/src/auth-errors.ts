const AUTHENTICATION_ERROR_PATTERNS: readonly RegExp[] = [
  /unauthorized/,
  /authentication error/,
  /invalid api key/,
];

export function isAuthenticationErrorText(text: string, extraPatterns: readonly RegExp[] = []): boolean {
  const normalized = text.toLowerCase();
  return AUTHENTICATION_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))
    || extraPatterns.some((pattern) => pattern.test(normalized));
}
