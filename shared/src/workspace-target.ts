import { DEFAULT_WEB_APP_URL, getWorkspaceDashboardUrl } from './urls';
import { sanitizeTerminalLine } from './terminal';
import { UUID_RE } from './uuid';

export function workspaceTargetFromToolOutput(output?: string) {
  const value = output?.split(/\r?\n/).find((line) => line.startsWith('Workspace: '))?.slice('Workspace: '.length);
  if (!value) return null;

  const nameEnd = value.endsWith(')') ? value.lastIndexOf(' (') : -1;
  const label = nameEnd > 0 ? value.slice(0, nameEnd) : '';
  const href = nameEnd > 0 ? value.slice(nameEnd + 2, -1) : value;

  try {
    const segments = new URL(href, DEFAULT_WEB_APP_URL).pathname.split('/').filter(Boolean);
    const id = segments.length === 2 && segments[0] === 'workspaces' ? segments[1] : null;
    if (!id || !UUID_RE.test(id)) return null;
    return {
      id,
      label: sanitizeTerminalLine(label) || 'Workspace',
      href: getWorkspaceDashboardUrl(id, { webAppUrl: '' }),
    };
  } catch {
    return null;
  }
}
