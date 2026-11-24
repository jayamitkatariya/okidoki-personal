export const MAX_MESSAGE_IMAGES = 20;

// Past either limit the Claude API stops using extra pixels (https://platform.claude.com/docs/en/build-with-claude/vision),
// and Claude Code and Codex shrink below them before sending, so attached images lose nothing the agent would see.
export const MAX_LONG_EDGE = 2576;
export const MAX_PIXELS = 3_750_000;

/** WebP at this quality read as well as PNG for small text in our tests; lower qualities lost it. */
export const SHRUNK_IMAGE_QUALITY = 0.85;
/** Images this small are kept as they are, even when they fit, since re-encoding saves little. */
export const KEEP_IMAGE_UNDER_BYTES = 500_000;

export function shrunkImageSize(width: number, height: number): { width: number; height: number } | null {
  const scale = Math.min(MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return scale < 1 ? { width: Math.round(width * scale), height: Math.round(height * scale) } : null;
}
