const SECRET_PATTERNS: readonly RegExp[] = [
  // Not after a letter or digit, so words like "task-" or "ask-" in ordinary text are not keys.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abps]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:authorization\s*:\s*bearer|bearer)\s+[a-z0-9._~+/=-]{16,}/gi,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,}["']?/gi,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]{12,}/g,
];

const MIN_SECRET_MATCH_CHARS = 16;
const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

// Hand-rolled rather than via Buffer: this module is typechecked inside packages that have no Node types.
function secretEncodings(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return [
    secret,
    base64,
    base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    [...secret].reverse().join(''),
  ];
}

export function containsKnownSecret(value: string, secrets: string[]): boolean {
  const haystack = flatten(value);
  if (!haystack) return false;
  return secrets.some((secret) => secretEncodings(secret).some((needle) => {
    const flattened = flatten(needle);
    return flattened.length >= MIN_SECRET_MATCH_CHARS && haystack.includes(flattened);
  }));
}

export function isUnsafeMemoryOutput(value: string, secrets: string[], maxChars?: number): boolean {
  return (maxChars !== undefined && value.length > maxChars) || containsSecret(value) || containsKnownSecret(value, secrets);
}
