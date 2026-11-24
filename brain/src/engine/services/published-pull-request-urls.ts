import { extractCommandProtectionCommandText, isRecord, parseCodeHostPrUrl, type PullRequestToolResult } from '@okidoki/shared';

export function publishedPullRequestUrls(result: PullRequestToolResult): string[] {
  if (!result.success) return [];
  const name = result.toolName.toLowerCase();
  const publicationTool = /(?:^|[_-])(?:create[_-]?(?:pr|pull[_-]?request|mr|merge[_-]?request)|(?:pr|pull[_-]?request|mr|merge[_-]?request)[_-]?create)$/.test(name);
  const command = extractCommandProtectionCommandText({ toolInput: result.toolInput }) ?? '';
  // Quoted arguments and comments can describe publishing without executing it.
  // Opaque scripts and heredocs continue to use branch discovery.
  const shell = command.replace(/\\\r?\n/g, ' ').replace(/'[^']*'|"(?:\\.|[^"\\])*"|`[^`]*`|#[^\n]*/g, 'ARG');
  const commands = shell.split(/&&|[;\n]/).map((part) => part.trim()).filter(Boolean);
  const isPublicationCommand = (part: string): boolean => {
    if (/^(?:[\w]+=[^\s;&|]+\s+)*(?:\S*\/)?(?:gh(?:\s+(?:-R|--repo)\s+\S+)?\s+pr\s+create|glab(?:\s+(?:-R|--repo)\s+\S+)?\s+mr\s+create|git(?:\s+-C\s+\S+)?\s+push)\b/.test(part)) return true;
    return /^(?:gh\s+api|glab\s+api|curl)\s/.test(part)
      && /(?:^|\s)(?:-X\s*|--(?:method|request)[=\s]+)POST\b/i.test(part)
      && /\/(?:pulls|merge_requests)(?:\s|$)/.test(part);
  };
  // Mixed command output cannot tell us which command produced a URL.
  const publicationCommand = !shell.includes('<<') && !/[|&(){}\\]/.test(commands.join(' '))
    && commands.some(isPublicationCommand)
    && commands.every((part) => isPublicationCommand(part)
      || /^(?:cd|rm)\s/.test(part)
      || /^git(?:\s+-C\s+\S+)?\s+worktree\s+(?:add|remove)\b/.test(part)
      || /^git(?:\s+-C\s+\S+)?\s+(?:switch|checkout)\s+(?:(?:-[bcBC]|--detach)\s+)?[^\s-]\S*$/.test(part));
  if (!publicationTool && !publicationCommand) return [];

  const urls = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      const text = value.trim();
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== value) visit(parsed, depth + 1);
        return;
      } catch { /* CLI output is usually a URL rather than JSON. */ }
      for (const line of text.split('\n')) {
        const candidate = line.trim().replace(/^remote:\s*/, '');
        if (!/^https?:\/\/[^\s<>"']+\/(?:pull|merge_requests)\/\d+\/?(?:[?#][^\s<>"']*)?$/.test(candidate)) continue;
        if (parseCodeHostPrUrl(candidate)) urls.add(candidate);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (isRecord(value) && value.isError !== true) {
      // Follow result envelopes, never PR bodies, titles, or arbitrary metadata.
      for (const key of ['url', 'html_url', 'web_url', 'content', 'structuredContent', 'text', 'output', 'result', 'stdout', 'stderr']) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(result.output);
  return [...urls];
}
