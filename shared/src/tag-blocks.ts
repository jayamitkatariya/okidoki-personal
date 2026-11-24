const ATTRIBUTE = /(\w+)="([^"]*)"/g;

export const MULTITASK_EVENT_TAG = 'multitask_event';

export const tagBlockPattern = (tag: string) => new RegExp(`<${tag}((?:\\s+\\w+="[^"]*")*)>\\n?([\\s\\S]*?)\\n?</${tag}>`, 'g');

export const escapeTagAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const parseTagAttributes = (raw: string): Record<string, string> =>
  Object.fromEntries([...raw.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
