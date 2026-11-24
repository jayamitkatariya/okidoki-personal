import { ACCENT_COLORS, contrast, linearChannels, luminance, mix, PALETTE_COLORS } from './design-tokens';
import type { AvatarColor, ManagerPresetAvatar } from './routes/manager';

export const PIXEL_CREW_ROLE_NAMES = ['detective', 'builder', 'scientist', 'accountant', 'pilot', 'artist', 'medic', 'guard', 'courier', 'captain', 'chef', 'astronaut', 'wizard', 'hacker', 'operator', 'explorer'] as const;
export type PixelCrewRole = (typeof PIXEL_CREW_ROLE_NAMES)[number];

// Pixel Crew preset avatars: 16×16 letter maps. '.' is the tile, P the primary, p its shade, K a pupil, k its catchlight, any other letter an accent.
const PIXEL_CREW_ROLES = {
  detective: ["................", "................", "................", "....BBBBBBBB....", "....DDDDDDDD....", "..BBBBBBBBBBBB..", "...PPPPPPPPPP...", "...WWWWPPWWWW...", "...WKkWWWWKkW...", "...WKKWPPWKKW...", "...WWWWPPWWWW...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..YYYYYBBYYYYY..", "..YYYYYBBYYYYY..", "..YYYYYBBYYYYY.."],
  builder: ["................", "................", "....YYYWWYYY....", "....YYYWWYYY....", "....YYYWWYYY....", "..YYYYYYYYYYYY..", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..OOOOOOOOOOOO..", "..WWWWWWWWWWWW..", "..OOOOOOOOOOOO.."],
  scientist: ["................", "................", "................", "......WWWW......", "..WWWWWWWWWWWW..", "..WWWWWWWWWWWW..", "..WWWPPPPPPWWW..", "..WVVVVVVVVVVW..", "...VLKLVVLKLV...", "...VLLLVVLLLV...", "...VVVVVVVVVV...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..HHHHVVVVHHHH..", "..HHHHVVVVHHHH..", "..HHHHVVVVHHHH.."],
  accountant: ["................", "................", "............I...", "............Y...", "...CCCCCCCCCY...", "...CCCCCCCCCY...", ".CCCCCCCCCCCYCC.", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..NNNNWWWWNNNN..", "..NNNNNWWNNNNN..", "..NNNNNWWNNNNN.."],
  pilot: ["................", "................", "................", "...BBBBBBBBBB...", "...BSSSDDSSSB...", "...BSSSBBSSSB...", "..BBBBBBBBBBBB..", "..BBPPPPPPPPBB..", "..BBPKkPPKkPBB..", "..BBPKKPPKKPBB..", "..BBPPPPPPPPBB..", "...PPPppppPPP...", "...PPPPPPPPPP...", "..AAAAAARRRRRR..", "..AAAAAAAAAARR..", "..AAAAAAAAAARR.."],
  artist: ["................", "................", "........M..MMM..", ".....MMMMMMMMM..", "...MMMMMMMMMM...", "...MMMMMMMMMM...", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPPS..", "...PPKKPPKKPPB..", "...PDPPPPPPDPB..", "...PPDDDDDDPPB..", "...PPPPPPPPPPB..", "..WWWWWWWWWWWW..", "..IIIIIIIIIIII..", "..WWWWWWWWWWWW.."],
  medic: ["................", "................", "................", "....WWWRRWWW....", "....WWRRRRWW....", "....WWWRRWWW....", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...FFFFFFFFFF...", "...PFFFFFFFFP...", "...PFFFFFFFFP...", "..THTTTTTTTTHT..", "..THTTTTTTTTHT..", "..THTTTTTTTTHT.."],
  guard: ["................", "................", "...NNNNNNNNNN...", "...NNNNYYNNNN...", "...NNNNYYNNNN...", "....DDDDDDDD....", "...DDDDDDDDDD...", "...PDDDDDDDDP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..NNNNNNNNNNNN..", "..NNYYNNNNNNNN..", "..NNNNNNNNNNNN.."],
  courier: ["................", "................", "................", "....QQQQQQQQ....", "....QQWWQQQQ....", "....QQQQQQQQQQQ.", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPWWWWWW.", "..RRRRRRRWRWWRW.", "..RRRRRRRWWRRWW.", "..RRRRRRRWWWWWW."],
  captain: ["................", "...WWWWWWWWWW...", "...WWWWYYWWWW...", "...WWWWYYWWWW...", "....DDDDDDDD....", "...DDDDDDDDDD...", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...WPKKPPKKPW...", "...WWWWWWWWWW...", "...WWWJJJJWWW...", "...WWWWWWWWWW...", "..YYYGGGGGGYYY..", "..GGGGGYYGGGGG..", "..GGGGGGGGGGGG.."],
  chef: [".....WWWWWW.....", "....WWWWWWWW....", "....WWWWWWWW....", "....WWWWWWWW....", ".....WWWWWW.....", "...WWWWWWWWWW...", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..WWWRRRRRRWWW..", "..WWWWWRRWWWWW..", "..WWWWWWWWWWWW.."],
  astronaut: ["................", "................", ".......W........", ".....WWWWWW.....", "...WWWWWWWWWW...", "..WWWWWWWWWWWW..", ".WWPPPPPPPPPPWW.", ".WWPPPPPPPPPPWW.", ".WWPPKkPPKkPPWW.", ".WWPPKKPPKKPPWW.", ".WWPPPPPPPPPPWW.", ".WWPPPppppPPPWW.", ".WWPPPPPPPPPPWW.", "..WWWWWWWWWWWW..", "..WWWWWRRWWWWW..", "..WWWNNWWNNWWW.."],
  wizard: [".......V........", "......VV........", "......VVV.......", ".....VVYVV......", "....VVVVVVV.....", ".VVVVVVVVVVVVVV.", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PWWWWWWWWP...", "...WWWWWWWWWW...", "....WWWWWWWW....", "..VVVVWWWWVVVV..", "..VVVVVWWVVVVV..", "..VVVVVVVVVVVV.."],
  hacker: ["................", "................", ".....DDDDDD.....", "....DDDDDDDD....", "...DDDDDDDDDD...", "..DDDDDDDDDDDD..", "..DDPPPPPPPPDD..", "..DPPPPPPPPPPD..", "..DPPKkPPKkPPD..", "..DPPKKPPKKPPD..", "..DPPPPPPPPPPD..", "..DPPPppppPPPD..", "..DDPPPPPPPPDD..", "..DDDDDDDDDDDD..", "..DDDDDHHDDDDD..", "..DDDDDHHDDDDD.."],
  operator: ["................", "................", "................", "....NNNNNNNN....", "...N........N...", "..N..........N..", "..NPPPPPPPPPPN..", ".NNPPPPPPPPPPNN.", ".NNPPKkPPKkPPNN.", ".NNPPKKPPKKPPNN.", "...PPPPPPPPPP.N.", "...PPPppppPPYN..", "...PPPPPPPPPP...", "..NNNNNNNNNNNN..", "..NNNNNNNNNNNN..", "..NNNNNNNNNNNN.."],
  explorer: ["................", "................", "......EEEE......", "....EEEEEEEE....", "...EEEEEEEEEE...", "EEEEEEEEEEEEEEEE", "...PPPPPPPPPP...", "...PPPPPPPPPP...", "...PPKkPPKkPP...", "...PPKKPPKKPP...", "...PPPPPPPPPP...", "...PPPppppPPP...", "...PPPPPPPPPP...", "..BBBBBBBBBBBB..", "..BBBBBYYBBBBB..", "..BBBBBBBBBBBB.."],
} as const satisfies Record<PixelCrewRole, readonly string[]>;

const ACCENTS: Record<string, string> = {
  W: '#ffffff', D: '#111111', B: '#92400e', Y: '#f59e0b', O: '#f97316', C: '#60a5fa', R: '#ef4444', M: '#db2777',
  N: '#2563eb', V: '#9333ea', E: '#b9c1b8', S: '#0ea5e9', L: '#c084fc', I: '#f472b6', Q: '#ff6f63', T: '#14b8a6',
  G: '#2a2a2a', H: '#ededed', J: '#a3a3a3', A: '#5c5c5c', F: '#f2f3f1',
};

// Every value a 'theme' slot can take: the tile is each palette's darkest dark surface or its light ink, and the body each accent's bright value.
const THEME_PRIMARIES = Object.values(ACCENT_COLORS).map((accent) => accent.dark.primary);
const THEME_INKS = [...Object.values(PALETTE_COLORS.dark).map((palette) => palette.background), ...Object.values(PALETTE_COLORS.light).map((palette) => palette.foreground)];
const THEME_VARS = { primary: 'var(--avatar-primary)', tile: 'var(--avatar-tile)' };

const worst = (color: string, against: string[]) => Math.min(...against.map((other) => contrast(color, other)));
const oklab = (color: string) => {
  const [r, g, b] = linearChannels(color);
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const distance = (a: string, b: string) => { const x = oklab(a), y = oklab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const nearest = (color: string, against: string[]) => Math.min(...against.map((other) => distance(color, other)));
export const themeAvatarTile = (ink: string, primary: string) => mix(ink, primary, 0.15);
const THEME_TILES = THEME_INKS.flatMap((ink) => THEME_PRIMARIES.map((primary) => themeAvatarTile(ink, primary)));

function fit(color: string, against: string[], min: number) {
  if (worst(color, against) >= min) return color;
  const toward = Math.max(...against.map(luminance)) > 0.18 ? '#000000' : '#ffffff';
  for (let t = 0.05; t < 1; t += 0.05) { const moved = mix(color, toward, t); if (worst(moved, against) >= min) return moved; }
  return toward;
}

function resolve(primary: AvatarColor, background: AvatarColor, theme?: { primary: string; tile: string }) {
  let bodies = primary === 'theme' ? THEME_PRIMARIES : [primary];
  let tile: string = background;
  if (background !== 'theme') tile = fit(background, bodies, 3);
  else if (primary !== 'theme') bodies = [fit(primary, THEME_TILES, 3)];
  const tiles = background === 'theme' ? THEME_TILES : [tile];
  const themePrimary = theme?.primary ?? THEME_VARS.primary;
  const slots: Record<string, string> = {
    '.': background === 'theme' ? theme?.tile ?? THEME_VARS.tile : tile,
    P: primary === 'theme' ? themePrimary : bodies[0],
    p: primary === 'theme'
      ? theme ? mix(theme.primary, '#000000', 0.3) : `color-mix(in srgb, ${THEME_VARS.primary} 70%, #000)`
      : mix(bodies[0], luminance(bodies[0]) < 0.12 ? '#ffffff' : '#000000', 0.3),
    // Eyes are always dark pupils with a white catchlight: white eyes on dark bodies read as blank and creepy.
    K: '#111111',
    k: '#ffffff',
  };
  const away = Math.max(...tiles.map(luminance)) > 0.3 ? '#000000' : '#ffffff';
  const apart = (color: string) => Math.min(nearest(color, tiles), nearest(color, bodies));
  for (const [letter, color] of Object.entries(ACCENTS)) {
    const steps = [away, away === '#000000' ? '#ffffff' : '#000000'].flatMap((toward) => [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t) => mix(color, toward, t)));
    slots[letter] = apart(color) >= 0.15 ? color : steps.find((step) => apart(step) >= 0.15) ?? steps.reduce((best, step) => (apart(step) > apart(best) ? step : best));
  }
  return slots;
}

// `pixels` is the tile width in device pixels; edges snap to whole pixels toward the centre so symmetric art stays symmetric at 1.5px a cell.
export function pixelCrewArt(role: PixelCrewRole, { primary, background }: { primary: AvatarColor; background: AvatarColor }, pixels: number, theme?: { primary: string; tile: string }) {
  const slots = resolve(primary, background, theme);
  const snap = (edge: number) => (edge <= 8 ? Math.floor((edge * pixels) / 16) : pixels - Math.floor(((16 - edge) * pixels) / 16)) * 16 / pixels;
  const cells = (x: number, y: number, width: number) => ({ x: snap(x), y: snap(y), width: snap(x + width) - snap(x), height: snap(y + 1) - snap(y) });
  const runs: { x: number; y: number; width: number; height: number; fill: string; eye: boolean }[] = [];
  const eyeBacks: { x: number; y: number; width: number; height: number; fill: string }[] = [];
  PIXEL_CREW_ROLES[role].forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      let end = x + 1;
      while (end < row.length && row[end] === row[x]) end++;
      const eye = row[x] === 'K' || row[x] === 'k';
      if (row[x] !== '.') runs.push({ ...cells(x, y, end - x), fill: slots[row[x]], eye });
      if (eye) {
        let left = x - 1;
        while (row[left] === 'K' || row[left] === 'k') left--;
        eyeBacks.push({ ...cells(x, y, end - x), fill: slots[row[left]] });
      }
      x = end;
    }
  });
  return { tile: slots['.'], runs, eyeBacks };
}

const ROLE_KEYWORDS: [PixelCrewRole, RegExp][] = [
  ['detective', /feedback|research|bug|triage|investigat/i],
  ['builder', /infra|platform|migrat|build|backend/i],
  ['scientist', /growth|experiment|data|analytic|ml\b/i],
  ['accountant', /billing|financ|pric|payment|invoice/i],
  ['pilot', /release|deploy|ship|launch/i],
  ['artist', /design|docs|brand|ui\b|ux\b/i],
  ['medic', /incident|on-?call|outage|alert/i],
  ['guard', /secur|complian|auth|privacy/i],
  ['courier', /support|inbox|email|notif/i],
  ['captain', /chief|admin|plan|ops\b|roadmap/i],
  ['chef', /template|content|recipe/i],
  ['wizard', /automat|workflow/i],
  ['hacker', /review|refactor|cli\b|code/i],
  ['operator', /success|sales|customer|call|onboard/i],
  ['explorer', /competitor|seo|explor|market/i],
  ['astronaut', /bet|new|moonshot/i],
];

export const stableIndex = (id: string, count: number) => parseInt(id.replace(/-/g, '').slice(-8), 16) % count;

function defaultPixelCrewRole(workspace: { id: string; name: string }): PixelCrewRole {
  return ROLE_KEYWORDS.find(([, pattern]) => pattern.test(workspace.name))?.[0]
    ?? PIXEL_CREW_ROLE_NAMES[stableIndex(workspace.id, PIXEL_CREW_ROLE_NAMES.length)];
}

export function defaultManagerAvatar(workspace: { id: string; name: string }): ManagerPresetAvatar {
  return { kind: 'preset', role: defaultPixelCrewRole(workspace), primary: 'theme', background: 'theme' };
}
