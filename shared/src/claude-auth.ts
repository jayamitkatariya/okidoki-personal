/**
 * Credential-is-broken failures only. Spend exhaustion (empty API credit
 * balance, subscription usage limit) is `detectAgentQuotaLimit`.
 */
export function isClaudeAuthErrorText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('failed to authenticate') ||
    lower.includes('authentication_error') ||
    lower.includes('authentication_failed') ||
    lower.includes('authentication failed') ||
    lower.includes('invalid authentication credentials') ||
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    (lower.includes('401') && lower.includes('authentic'))
  );
}
