import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { RgbaColor } from "../lib/api";

/**
 * Approximate, live particle preview. Uses the effect's REAL decoded sprites,
 * additively blended and tinted by the effect's base color shifted with the
 * user's hue/saturation — the same recolor the compile applies. Motion is faked
 * (spawn → drift → fade), so this isn't the game renderer; it's a fast, faithful
 * way to judge a recolor. Use the "Open in real viewer" button for true fidelity.
 */
export function EffectPreview({
  sprites,
  baseColor,
  hue,
  saturation,
  mode = "static",
  height = 260,
}: {
  sprites: string[];
  baseColor: RgbaColor | null;
  hue: number;
  saturation: number;
  mode?: "static" | "rainbow" | "pulse";
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Live values read by the animation loop without restarting it.
  const params = useRef({ hue, saturation, mode });
  params.current = { hue, saturation, mode };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    const base = baseColor ?? { r: 200, g: 200, b: 220, a: 255 };
    const baseHsl = rgbToHsl(base.r, base.g, base.b);

    // Load the first usable sprite (the dominant one for most effects).
    const img = new Image();
    let ready = false;
    const tint = document.createElement("canvas");
    const tg = tint.getContext("2d")!;
    let lastKey = "";
    function retint(tSec: number) {
      if (!ready) return;
      const { hue, saturation, mode } = params.current;
      let h = baseHsl.h + hue;
      let s = Math.min(1, baseHsl.s * saturation);
      let l = baseHsl.l;
      if (mode === "rainbow") {
        h += tSec * 120; // ~3s per full cycle
        s = Math.min(1, Math.max(baseHsl.s, 0.65) * saturation);
      } else if (mode === "pulse") {
        l = baseHsl.l * (0.55 + 0.45 * Math.sin(tSec * 4)); // brightness oscillation
      }
      h = ((h % 360) + 360) % 360;
      const c = hslToRgb(h, s, l);
      const key = `${c.r},${c.g},${c.b}`;
      if (key === lastKey) return;
      lastKey = key;
      tint.width = img.width;
      tint.height = img.height;
      tg.globalCompositeOperation = "source-over";
      tg.clearRect(0, 0, tint.width, tint.height);
      tg.drawImage(img, 0, 0);
      tg.globalCompositeOperation = "source-in";
      tg.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      tg.fillRect(0, 0, tint.width, tint.height);
    }
    img.onload = () => {
      ready = true;
      lastKey = "";
      retint(0);
    };
    if (sprites[0]) img.src = convertFileSrc(sprites[0]);

    type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; sz: number; rot: number; vr: number };
    const particles: P[] = [];
    function spawn() {
      const a = Math.random() * Math.PI * 2;
      const sp = 10 + Math.random() * 40;
      particles.push({
        x: W / 2 + (Math.random() - 0.5) * 36,
        y: H / 2 + (Math.random() - 0.5) * 26,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 22,
        life: 0,
        max: 1.0 + Math.random() * 1.2,
        sz: 46 + Math.random() * 80,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 1.1,
      });
    }

    let raf = 0;
    const start = performance.now();
    let prev = start;
    function frame(now: number) {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      retint((now - start) / 1000);
      for (let i = 0; i < 3; i++) spawn();
      g.globalCompositeOperation = "source-over";
      g.fillStyle = "rgba(0,0,0,0.26)";
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "lighter";
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.max) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 12 * dt;
        p.rot += p.vr * dt;
        const k = p.life / p.max;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.globalAlpha = Math.sin(k * Math.PI) * 0.5;
        if (ready) g.drawImage(tint, -p.sz / 2, -p.sz / 2, p.sz, p.sz);
        g.restore();
      }
      g.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprites, baseColor]);

  return (
    <canvas
      ref={canvasRef}
      width={420}
      height={height}
      className="w-full rounded-lg border border-zinc-800 bg-black"
      style={{ maxWidth: 420 }}
    />
  );
}

// --- HSL helpers (match the backend recolor) ---
function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}
function hslToRgb(h: number, s: number, l: number) {
  h /= 360;
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const t = (x: number) => {
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    r = t(h + 1 / 3);
    g = t(h);
    b = t(h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}
