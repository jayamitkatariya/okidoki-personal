import { useEffect, useRef } from "react";

// The okidoki mark, rebuilt as a grid of square pixels and set into the dashboard
// background. Cells develop diagonally on load, then a few light up in brand green
// on a steps() clock. Decorative only: aria-hidden, no pointer events.

const CELL = 8;

export function PixelMark({ src = "brand.png", className = "" }: { src?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const img = new Image();
    let cells: { x: number; y: number; delay: number }[] = [];
    let size = 0;
    let raf = 0;
    let started = 0;
    let last = 0;

    const build = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size = Math.round(box.width);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // downsample the mark to the pixel grid, then keep the cells that are mostly filled
      const n = Math.max(1, Math.floor(size / CELL));
      const sample = document.createElement("canvas");
      sample.width = n;
      sample.height = n;
      const sctx = sample.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;
      sctx.drawImage(img, 0, 0, n, n);
      const data = sctx.getImageData(0, 0, n, n).data;
      cells = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const alpha = data[(y * n + x) * 4 + 3] / 255;
          if (alpha > 0.5) cells.push({ x, y, delay: (x + (n - y)) * 22 });
        }
      }
    };

    const paint = (now: number) => {
      if (!size) return;
      const elapsed = now - started;
      const ink = getComputedStyle(canvas).getPropertyValue("--ink").trim() || "#0e1512";
      const accent = getComputedStyle(canvas).getPropertyValue("--accent-bright").trim() || "#44e45e";
      const gap = Math.max(1, Math.round(CELL * 0.18));
      const beat = Math.floor(elapsed / 420);
      ctx.clearRect(0, 0, size, size);
      cells.forEach((cell, i) => {
        const develop = Math.min(Math.max((elapsed - cell.delay) / 260, 0), 1);
        if (develop <= 0) return;
        // a deterministic handful of cells blink in brand green each beat
        const lit = !reduced && (i * 7 + beat * 13) % 61 === 0;
        ctx.globalAlpha = develop * (lit ? 0.9 : 0.16);
        ctx.fillStyle = lit ? accent : ink;
        ctx.fillRect(cell.x * CELL + gap, cell.y * CELL + gap, CELL - gap * 2, CELL - gap * 2);
      });
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      // blink at 2.4 beats a second: the steps() feel, not a smooth fade
      if (now - last > 420 || last === 0) {
        last = now;
        paint(now);
      }
      raf = requestAnimationFrame(loop);
    };

    img.onload = () => {
      build();
      started = performance.now();
      if (reduced) {
        paint(started + 10_000);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    img.src = src;

    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      build();
      if (reduced) paint(started + 10_000);
      else raf = requestAnimationFrame(loop);
    });
    resize.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
    };
  }, [src]);

  return <canvas ref={ref} className={`pixel-mark ${className}`} aria-hidden="true" />;
}
