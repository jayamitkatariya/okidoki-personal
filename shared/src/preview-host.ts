export function isPreviewHostname(hostname: string, domainBase: string): boolean {
  if (!hostname.endsWith(`.${domainBase}`)) return false;
  return /^\d+-[a-f0-9-]+$/.test(hostname.slice(0, -(domainBase.length + 1)));
}

export const parentDomain = (hostname: string) => hostname.split('.').slice(-2).join('.');
