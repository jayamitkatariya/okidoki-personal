export function fnv1a(text: string, hash = 0x811c9dc5) {
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

export function hashContent(text: string) {
  return `${text.length}.${fnv1a(text).toString(36)}`;
}
