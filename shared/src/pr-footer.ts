import { BRAND_COLORS } from './design-tokens';
import { SLACK_ICON_DEFINITION, renderIconSvg } from './provider-icons';
import { DEFAULT_WEBSITE_URL, getWorkspaceDashboardUrl } from './urls';

/**
 * Context for building a PR footer. All fields are optional —
 * the footer gracefully omits sections when data is missing.
 */
export interface PrFooterContext {
  /** Workspace UUID — used to build the workspace dashboard link */
  workspaceId?: string;
  /** Display name of the person who created the workspace */
  creatorName?: string;
  /** Email of the person who created the workspace */
  creatorEmail?: string;
  /** Full URL to the Linear issue (when workspace was triggered from Linear) */
  linearIssueUrl?: string;
  /** Human-readable Linear issue identifier, e.g. "REP-398" */
  linearIssueIdentifier?: string;
  /** Full permalink to the Slack thread (when workspace was triggered from Slack) */
  slackThreadUrl?: string;
}

/**
 * Sanitize user-controlled strings for use in HTML text content.
 * Encodes HTML-special characters and strips control characters.
 */
function sanitize(input: string): string {
  return input
    .replace(/[\n\r`]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}

/**
 * Sanitize a URL for use in an HTML href attribute.
 * Blocks dangerous schemes and encodes quotes to prevent attribute breakout.
 */
function sanitizeUrl(input: string): string {
  const trimmed = input.trim();
  // Block javascript: and data: schemes
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return '';
  }
  return trimmed.replace(/"/g, '%22').replace(/'/g, '%27');
}

function buildBadge(
  href: string,
  label: string,
  message: string,
  color: string,
  logo?: string,
  logoColor?: string,
): string {
  const safeLabel = label.replace(/[\n\r`]/g, '').trim();
  const safeMessage = message.replace(/[\n\r`]/g, '').trim();
  const params = new URLSearchParams({
    label: safeLabel,
    message: safeMessage,
    color,
    labelColor: BRAND_COLORS.badge.label.slice(1),
    style: 'for-the-badge',
  });
  if (logo) {
    params.set('logo', logo.startsWith('<svg') ? `data:image/svg+xml;base64,${btoa(logo)}` : logo);
  }
  if (logoColor) {
    params.set('logoColor', logoColor);
  }
  const badgeUrl = `https://img.shields.io/static/v1?${params.toString().replace(/&/g, '&amp;')}`;
  return `<a href="${href}"><img alt="${sanitize(`${safeLabel} ${safeMessage}`)}" src="${badgeUrl}"></a>`;
}

/**
 * Builds a formatted HTML footer for GitHub PR descriptions.
 *
 * GitHub PR descriptions support a subset of HTML, so this generates
 * a clean, centered footer with attribution and contextual links.
 *
 * Returns an empty string if no meaningful context is provided.
 */
export function buildPrFooter(context: PrFooterContext): string {
  const { workspaceId, creatorName, creatorEmail, linearIssueUrl, linearIssueIdentifier, slackThreadUrl } = context;

  // Need at least a workspace ID or creator info to render anything useful
  if (!workspaceId && !creatorName && !creatorEmail) {
    return '';
  }

  const lines: string[] = [];

  const creatorParts: string[] = [];
  if (creatorName) {
    creatorParts.push(`<b>${sanitize(creatorName)}</b>`);
  }
  if (creatorEmail) {
    const safeEmail = sanitize(creatorEmail);
    if (creatorName) {
      creatorParts.push(`(${safeEmail})`);
    } else {
      creatorParts.push(`<b>${safeEmail}</b>`);
    }
  }

  if (creatorParts.length > 0) {
    lines.push(`Created by ${creatorParts.join(' ')} with <a href="https://okidoki.dev">Okidoki</a>`);
  } else {
    lines.push(`Created with <a href="https://okidoki.dev">Okidoki</a>`);
  }

  const links: string[] = [];

  if (workspaceId) {
    const workspaceUrl = getWorkspaceDashboardUrl(workspaceId);
    links.push(`<a href="${workspaceUrl}"><img alt="Okidoki Workspace" src="${DEFAULT_WEBSITE_URL}/pr-footer-workspace.svg"></a>`);
  }

  if (linearIssueUrl) {
    const safeUrl = sanitizeUrl(linearIssueUrl);
    if (safeUrl) {
      const label = linearIssueIdentifier || 'Linear Issue';
      links.push(buildBadge(safeUrl, 'Linear', label, BRAND_COLORS.badge.linear.slice(1), 'linear', BRAND_COLORS.badge.linear.slice(1)));
    }
  }

  if (slackThreadUrl) {
    const safeUrl = sanitizeUrl(slackThreadUrl);
    if (safeUrl) {
      // Shields no longer ships Slack's mark, so pass the official multicolor SVG directly.
      links.push(buildBadge(safeUrl, 'Slack', 'Thread', BRAND_COLORS.badge.slack.slice(1), renderIconSvg(SLACK_ICON_DEFINITION)));
    }
  }

  const attribution = lines[0];
  const linksLine = links.join('&nbsp;');

  const footerContent = linksLine
    ? `<sub>\n${attribution}\n</sub><br>\n<br>\n${linksLine}`
    : `<sub>\n${attribution}\n</sub>`;

  return `\n---\n\n<div align="center">\n${footerContent}\n</div>`;
}

/**
 * Matches on the workspace dashboard link rather than the surrounding markup:
 * agents reformat the HTML, and humans edit descriptions afterwards, but the
 * link is the part downstream reporting actually counts.
 */
export function hasPrFooter(body: string | null | undefined): boolean {
  return getPrFooterWorkspaceId(body) !== null;
}

/** The workspace that opened the PR: later footers from other workspaces keep the first one. */
export function getPrFooterWorkspaceId(body: string | null | undefined): string | null {
  return body?.match(/https:\/\/(?:(?:app\.)?okidoki\.dev|tryokidoki\.com)\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1]?.toLowerCase() ?? null;
}
