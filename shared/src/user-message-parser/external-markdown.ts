import { isRecord } from '../type-guards';

const LINEAR_IMAGE_NODE = /\{"type":"image","attrs":(\{[^{}]*\})\}/g;
const LINEAR_UPLOAD_IMAGE = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;

/** Linear webhooks serialize some images as ProseMirror JSON nodes instead of markdown. */
export function linearImageNodesToMarkdown(text: string): string {
  return text.replace(LINEAR_IMAGE_NODE, (node, attrs: string) => {
    try {
      const parsed: unknown = JSON.parse(attrs);
      if (!isRecord(parsed) || typeof parsed.src !== 'string') return node;
      const { src, alt, title } = parsed;
      const label = [alt, title].find((value): value is string => typeof value === 'string' && value !== '') ?? '';
      return `![${label.replace(/[[\]]/g, '')}](${src})`;
    } catch {
      return node;
    }
  });
}

// Linear uploads need auth or carry short-lived signatures, so inline <img> tags break; show links instead.
export function linearMarkdownForDisplay(text: string): string {
  return linearImageNodesToMarkdown(text).replace(
    LINEAR_UPLOAD_IMAGE,
    (_, alt: string, url: string) => `[${alt ? `Image: ${alt}` : 'Image'}](${url})`,
  );
}

function convertSlackMrkdwn(text: string, link: (url: string, label: string) => string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, (_, url: string, label: string) => link(url, label))
    .replace(/<((?:https?|mailto):[^|>\s]+)>/g, '$1')
    .replace(/<([@#])([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, sigil: string, id: string, label?: string) => `${sigil}${label ?? id}`)
    .replace(/<!(?:subteam\^\w+|date\^[^|>]+)\|([^>]+)>/g, '$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');
}

export function slackMrkdwnToMarkdown(text: string): string {
  return convertSlackMrkdwn(text, (url, label) => `[${label}](${url})`);
}

export function slackMrkdwnToPlainText(text: string): string {
  return convertSlackMrkdwn(text, (_, label) => label).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
