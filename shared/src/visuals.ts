import { DEFAULT_THEME, designColors, SERIES, type Theme, type Mode } from './design-tokens';
import { isRecord } from './type-guards';

export type VisualAppearance = Mode;
export type VisualHeights = Array<[width: number, height: number]>;

interface VisualTheme {
  appearance: VisualAppearance;
  variables: Record<string, string>;
  fontUrl?: string;
}

export const VISUAL_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 760, 880, 952] as const;
export const VISUAL_COLUMN_WIDTH = 760;
export const VISUAL_PHONE_WIDTH = 390;
const VISUAL_MIN_HEIGHT = 24;
// Only stops a page whose height follows its frame from growing forever; publishing already refuses most of those.
const VISUAL_MAX_HEIGHT = 20_000;
export const VISUAL_FONT_PATH = '/fonts/InterVariable.woff2';
export const VISUALS_MIN_SANDBOX_IMAGE = 'okidoki-sandbox-2026-10-20-v13';

// Older visuals and app builds still call the font "General Sans".
const FONT_FAMILIES = ['Inter', 'General Sans'];
const FONT_SANS = `${FONT_FAMILIES.map((family) => `"${family}"`).join(', ')}, system-ui, -apple-system, "Segoe UI", sans-serif`;
const FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function visualTheme(mode: Mode, fontUrl?: string, theme: Omit<Theme, 'mode'> = DEFAULT_THEME): VisualTheme {
  const colors = designColors({ ...theme, mode });
  return {
    appearance: mode,
    variables: {
      '--background': colors.background,
      '--foreground': colors.foreground,
      '--muted': colors.muted,
      '--muted-foreground': colors.mutedForeground,
      '--accent': colors.selected,
      '--primary': colors.primary,
      '--primary-foreground': colors.primaryForeground,
      '--success': colors.success,
      '--border': colors.border,
      '--ring': colors.primary,
      '--destructive': colors.destructive,
      '--warning': colors.warning,
      '--code-background': colors.background,
      '--code-foreground': colors.foreground,
      ...Object.fromEntries(SERIES.map((color, index) => [`--chart-${index + 1}`, colors[color]])),
      '--radius': '6px',
      '--font-sans': FONT_SANS,
      '--font-mono': FONT_MONO,
    },
    ...(fontUrl ? { fontUrl } : {}),
  };
}

export const VISUAL_PAGE_RULES = `- Write one self-contained HTML file with inline <style> and <script>; a fragment without <html> or <head> is fine. Put data inline instead of fetching it. Libraries may load from public CDNs such as cdn.jsdelivr.net. Local images written as absolute paths (src="/abs/shot.png", url(/abs/bg.webp)) are inlined when you publish.
- The page sits directly on the chat background, as wide as your reply (about ${VISUAL_COLUMN_WIDTH}px on desktop, ${VISUAL_PHONE_WIDTH - 30}px on phones), with its left edge aligned to your text. Leave html and body transparent, use a fluid width with no outer padding, and add no outer card, border, or title banner: the page is part of your reply.
- Let content set the height. Never use 100vh, height:100%, or min-height:100vh on html, body, or the outer element; publishing refuses a page whose height follows the frame. Give charts fixed pixel heights.
- Color everything with the theme variables so the page follows light and dark mode live: --foreground, --muted-foreground (secondary text), --background, --muted (subtle fills), --accent, --border, --primary and --primary-foreground (the brand accent, for emphasis), --success (passed, done, or added), --destructive, --warning, --code-background, --code-foreground, and --chart-1 to --chart-8 for series (use them in order and label series directly). Never hardcode a light or dark palette. A canvas or chart library that needs literal colors can read them with getComputedStyle(document.documentElement) and redraw on matchMedia("(prefers-color-scheme: dark)") changes.
- Text is 13px Inter, like the chat; --font-sans and --font-mono are set. Keep Okidoki' flat look: separate sections with 1px var(--border) lines or var(--muted) fills, without shadows or rounded cards. Use var(--radius) only on small controls.
- A mockup of a specific product's UI, such as a client's app or a competitor's screen, is the exception: give it its own panel with at least 16px of padding and use that product's real colors, fonts, corners, and shadows inside it, so it looks like the product. Everything around the panel follows the rules above.
- Interaction is welcome: hover details, tabs, toggles, sliders. Links open in a new browser tab.
- Keep the top-right corner (about 110×40px) free of anything essential: the chat shows the visual's actions there on hover.`;

const THEME_FRAGMENT_KEY = 'okidoki-theme';
const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed';
const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';
const OPEN_LINK_METHOD = 'ui/open-link';
const OPEN_IMAGE_METHOD = 'okidoki/open-image';

export function visualThemeFragment(theme: VisualTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

export function visualThemeMessage(theme: VisualTheme) {
  return {
    jsonrpc: '2.0',
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables }, fontUrl: theme.fontUrl },
  } as const;
}

type VisualMessage = { kind: 'size'; height: number } | { kind: 'link'; url: string } | { kind: 'image'; src: string; name: string };

export function readVisualMessage(data: unknown): VisualMessage | null {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || !isRecord(data.params)) return null;
  const { method, params: { height, url, src, name } } = data;
  if (method === SIZE_CHANGED_METHOD && typeof height === 'number' && Number.isFinite(height) && height > 0) {
    return { kind: 'size', height };
  }
  if (method === OPEN_LINK_METHOD && typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return { kind: 'link', url };
  }
  if (method === OPEN_IMAGE_METHOD && typeof src === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(src)) {
    return { kind: 'image', src, name: typeof name === 'string' ? name : '' };
  }
  return null;
}

// Page scripts in a native web view can post anything; only the bootstrap's JSON messages count.
export function readNativeVisualMessage(data: string): VisualMessage | null {
  try {
    return readVisualMessage(JSON.parse(data));
  } catch {
    return null;
  }
}

// A visual never navigates away: a tapped http(s) link opens outside it. iOS says which loads come from a tap; Android leaves the type out and only asks about loads the page starts.
export function visualNavigation(page: string, request: { url: string; isTopFrame?: boolean; navigationType?: string }): 'load' | 'open' | 'block' {
  if (request.isTopFrame === false || request.url.split('#')[0] === page) return 'load';
  return (request.navigationType ?? 'click') === 'click' && /^https?:/i.test(request.url) ? 'open' : 'block';
}

export function clampVisualHeight(height: number): number {
  return Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.round(height)));
}

// Before the page reports its height, take the taller neighbor: a breakpoint between measured widths can make it as tall as either.
export function visualFrameHeight(heights: VisualHeights, width: number, contentHeight?: number): number {
  if (contentHeight !== undefined) return clampVisualHeight(contentHeight);
  if (heights.length === 0) return VISUAL_MIN_HEIGHT;
  const high = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  if (high === -1) return clampVisualHeight(heights[heights.length - 1][1]);
  const low = heights[high][0] === width ? high : Math.max(0, high - 1);
  return clampVisualHeight(Math.max(heights[low][1], heights[high][1]));
}

export function parseVisualHeights(json: string): VisualHeights | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > VISUAL_MEASURE_WIDTHS.length) return null;
  const heights: VisualHeights = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [width, height]: unknown[] = entry;
    if (
      typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 10_000 ||
      typeof height !== 'number' || !Number.isInteger(height) || height < 0 || height > 100_000
    ) return null;
    heights.push([width, height]);
  }
  return heights.sort((left, right) => left[0] - right[0]);
}

export const VISUAL_CONTENT_HEIGHT_EXPRESSION =
  '(function(){var r=document.documentElement;return Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height)})()';

const BASE_CSS =
  'html{color:var(--foreground);font-family:var(--font-sans);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%;scrollbar-width:none}' +
  'html::-webkit-scrollbar{display:none}body{margin:0}:where(*,*::before,*::after){box-sizing:border-box}code,kbd,pre,samp{font-family:var(--font-mono)}' +
  ':where(:focus-visible){outline:2px solid var(--ring);outline-offset:-2px}';

function rootRule(theme: VisualTheme): string {
  const declarations = Object.entries(theme.variables).map(([name, value]) => `${name}:${value};`).join('');
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

const THEME_STYLE_ID = 'okidoki-visual-theme';

// Collapsed to one line when injected, so line numbers in the page's own errors match the agent's file.
// A host theme message re-reports the height, so a host that attached late still hears it.
const BOOTSTRAP_SCRIPT = `
(() => {
  const style = document.getElementById('${THEME_STYLE_ID}');
  const nativeView = window.ReactNativeWebView;
  const framed = window.parent !== window;
  const post = (message) => nativeView ? nativeView.postMessage(JSON.stringify(message)) : window.parent.postMessage(message, '*');
  const applyTheme = (theme) => {
    const variables = Object.entries(theme.variables).map(([name, value]) => name + ':' + value + ';').join('');
    const font = theme.fontUrl ? ${JSON.stringify(FONT_FAMILIES)}.map((family) => '@font-face{font-family:"' + family + '";src:url("' + theme.fontUrl + '") format("woff2");font-weight:100 900;font-display:swap}').join('') : '';
    style.textContent = ':root{color-scheme:' + theme.appearance + ';' + variables + '}' + font + ${JSON.stringify(BASE_CSS)};
  };
  try {
    const fragment = /[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);
    if (fragment) {
      applyTheme(JSON.parse(decodeURIComponent(fragment[1])));
      history.replaceState(history.state, '', location.pathname + location.search);
    }
  } catch {}
  if (!nativeView) {
    document.addEventListener('click', (event) => {
      const anchor = event.isTrusted && event.composedPath().find((target) => target instanceof Element && target.matches('a[href]'));
      if (!anchor) return;
      const url = new URL(anchor.getAttribute('href'), document.baseURI);
      if (!/^https?:$/.test(url.protocol) || url.href.split('#')[0] === location.href.split('#')[0]) return;
      if (framed) {
        event.preventDefault();
        post({ jsonrpc: '2.0', method: '${OPEN_LINK_METHOD}', params: { url: url.href } });
      } else {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
      }
    }, true);
  }
  if (!framed && !nativeView) return;
  window.addEventListener('click', (event) => {
    const image = event.composedPath()[0];
    if (!event.isTrusted || event.defaultPrevented || !(image instanceof HTMLImageElement) || image.closest('a[href], button')) return;
    let src = image.currentSrc || image.src;
    if (/^blob:/i.test(src) || (nativeView && /^data:image\\/svg|\\.svg(?:[?#]|$)/i.test(src))) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = (image.naturalWidth || image.width) * 2;
        canvas.height = (image.naturalHeight || image.height) * 2;
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        src = canvas.toDataURL('image/png');
      } catch {
        return;
      }
    }
    if (src) post({ jsonrpc: '2.0', method: '${OPEN_IMAGE_METHOD}', params: { src, name: image.alt } });
  });
  let reportedHeight;
  const reportHeight = () => {
    const height = ${VISUAL_CONTENT_HEIGHT_EXPRESSION};
    if (height === reportedHeight) return;
    reportedHeight = height;
    post({ jsonrpc: '2.0', method: '${SIZE_CHANGED_METHOD}', params: { height } });
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.method !== '${HOST_CONTEXT_CHANGED_METHOD}') return;
    const { theme, styles, fontUrl } = event.data.params;
    applyTheme({ appearance: theme, variables: styles.variables, fontUrl });
    reportedHeight = undefined;
    if (document.readyState !== 'loading') reportHeight();
  });
  const resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(document.documentElement);
  document.addEventListener('DOMContentLoaded', () => {
    resizeObserver.observe(document.body);
    reportHeight();
  });
  window.addEventListener('load', reportHeight);
})();
`.trim().replace(/\s*\n\s*/g, ' ');

function bootstrapMarkup(scan: string): string {
  const css = `${rootRule(visualTheme('dark'))}@media (prefers-color-scheme: light){${rootRule(visualTheme('light'))}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${THEME_STYLE_ID}">${css}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join('');
}

// Comments, raw text, and template contents are blanked to the same length, so offsets still line up
// and a <head> inside them never receives the bootstrap.
const blankNonMarkup = (html: string) =>
  html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => ' '.repeat(match.length),
  );

export function injectVisualBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(scan);
  const prefix = doctype ? '' : '<!doctype html>';
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${prefix}${html.slice(0, at)}${markup}${html.slice(at)}`;
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  const at = htmlOpen ? htmlOpen.index + htmlOpen[0].length : doctype ? doctype[0].length : 0;
  return `${prefix}${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
}
