export function validateExternalApiHost(url: string, providerLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${providerLabel}: ${url}`);
  }

  if (parsed.protocol !== 'https:') throw new Error(`${providerLabel} must use HTTPS`);

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.includes(':') || hostname.startsWith('[')) {
    throw new Error(`${providerLabel} cannot be an IP address literal`);
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    throw new Error(`${providerLabel} cannot point to localhost`);
  }
  if (/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(hostname)) {
    throw new Error(`${providerLabel} cannot point to a private or internal IP address`);
  }
  if (hostname === '0.0.0.0' || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new Error(`${providerLabel} cannot point to a non-routable address`);
  }
  if (!hostname.includes('.')) throw new Error(`${providerLabel} must be a fully qualified domain name`);
}
