import type { Media } from './object-store/types';

export function getMediaDisplayName(media: Pick<Media, 'id' | 'key' | 'display_name'>): string {
  const base = media.display_name ?? media.id;
  const keyName = media.key.split('/').pop() ?? '';
  const dot = keyName.lastIndexOf('.');
  const ext = dot === -1 ? '' : keyName.slice(dot);
  // Append the key's extension, unless the name already ends with it, to avoid `photo.png.png`.
  return ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? `${base}${ext}` : base;
}
