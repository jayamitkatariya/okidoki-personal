import { useEffect, useRef } from "react";

/** A 5x7 pixel face, the way a dot-matrix sign would draw it. */
const GLYPHS: Record<string, string[]> = {
  o: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  k: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  i: ["..#..", ".....", "..#..", "..#..", "..#..", "..#..", "..#.."],
  d: ["....#", "....#", ".###.", "#...#", "#...#", "#...#", ".###."],
  n: ["##...", "##...", "##...", "##...", "##...", "##...", "##..."],
  s: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  r: ["##...", "##...", "##...", "##...", "##...", "##...", "##..."],
};

function buildGrid(text: string): boolean[][] {
  const glyphs = [...text].map((char) => GLYPHS[char]).filter(Boolean) as string[][];
  if (!glyphs.length) return [[false]];
  const height = glyphs[0].length;
  const width = glyphs.reduce((sum, glyph) => sum + glyph[0].length, 0) + glyphs.length - 1;
  const grid: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  let offset = 0;
  for (const glyph of glyphs) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < glyph[y].length; x++) {
        if (glyph[y][x] === "#") grid[y][offset + x] = true;
      }
    }
    offset += glyph[0].length + 1;
  }
  return grid;
}

function readVar(canvas: HTMLCanvasElement, name: string, fallback: string): string {
  const value = getComputedStyle(canvas).getPropertyValue(name).trim();
  return value || fallback;
}

/** The okidoki wordmark, drawn as a dot-matrix sign: a ribbon of light sweeps through
 *  the pixels and the letters warm up as it passes. */
export function PixelWordmark({ text = "okidoki", className = "", maxCell = 12 }: { text?: string; className?: string; maxCell?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const grid = buildGrid(text);
    const rows = grid.length;
    const cols = grid[0].length;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let ink = "#cfe3d7";
    let glow = "#0b7a45";
    let hot = "#44e45e";
    let cell = 8;
    let size = 0;
    let frame = 0;
    let visible = true;
    let disposed = false;
    let started = 0;

    const colors = () => {
      ink = readVar(canvas, "--wordmark-ink", ink);
      glow = readVar(canvas, "--wordmark-glow", glow);
      hot = readVar(canvas, "--wordmark-hot", hot);
    };

    const paint = (now: number) => {
      if (!size) return;
      const step = size / cols;
      const gap = step * 0.16;
      const t = now - started;
      ctx.clearRect(0, 0, size, rows * step);

      // The reveal runs first: the sign powers up, left to right, one column at a time.
      const revealStep = 26;
      const revealTotal = cols * revealStep + 900;
      const still = media.matches;
      const front = still ? cols : t / revealStep;

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (!grid[y][x]) continue;
          const px = x * step;
          const py = y * step;

          // Base silhouette: lit once the reveal has passed it.
          const lit = front - x;
          if (lit < 0) continue;
          ctx.globalAlpha = 1;
          ctx.fillStyle = ink;
          ctx.fillRect(px + gap, py + gap, step - gap * 2, step - gap * 2);

          // A ribbon of light, angled across the sign so it sweeps rather than slides.
          const travel = Math.max(0, t - revealTotal);
          const ribbon = still ? 0 : Math.exp(-Math.pow((x - (travel * 0.075) % (cols + 34) - 17 + (y - rows / 2) * 1.4) / 5.2, 2));
          const echo = still ? 0 : 0.45 * Math.exp(-Math.pow((x - ((travel * 0.038) % (cols + 60) - 30 + (y - rows / 2) * 0.7)) / 9, 2));
          const flicker = 0.86 + 0.14 * Math.sin(t / 420 + x * 1.9 + y * 2.7);
          const glowAmount = Math.min(1, (ribbon + echo) * flicker);

          if (glowAmount > 0.04) {
            // The reveal flash: the column that is switching on right now burns brightest.
            const flash = Math.max(0, 1 - Math.abs(lit - 0.4) * 1.6);
            const heat = Math.min(1, glowAmount + flash * 0.9);
            ctx.globalAlpha = Math.min(1, 0.35 + heat * 0.65);
            ctx.fillStyle = heat > 0.72 ? hot : glow;
            ctx.shadowColor = heat > 0.72 ? hot : glow;
            ctx.shadowBlur = heat * step * 0.9;
            ctx.fillRect(px + gap, py + gap, step - gap * 2, step - gap * 2);
            ctx.shadowBlur = 0;
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      paint(now);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      if (disposed) return;
      started = performance.now();
      if (visible && !document.hidden && !media.matches) frame = requestAnimationFrame(tick);
      else paint(started);
    };

    const build = () => {
      const width = canvas.getBoundingClientRect().width;
      if (!width) return;
      cell = Math.max(4, Math.min(maxCell, Math.floor(width / cols)));
      size = cell * cols;
      const height = cell * rows;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      colors();
      paint(performance.now());
    };

    const resize = new ResizeObserver(build);
    resize.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    intersection.observe(canvas);
    const theme = new MutationObserver(() => {
      colors();
      paint(performance.now());
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);

    build();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      theme.disconnect();
      media.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
    };
  }, [text, maxCell]);

  return <canvas ref={ref} className={`pixel-wordmark ${className}`} aria-label={text} role="img" />;
}
