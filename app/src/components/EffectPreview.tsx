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
  driver = "age",
  gradientStops = null,
  cycleSecs = 3,
  height = 260,
}: {
  sprites: string[];
  baseColor: RgbaColor | null;
  hue: number;
  saturation: number;
  mode?: "static" | "rainbow" | "pulse";
  /** What samples the gradient (mirrors the compile): age, noise, index,
   *  rope (position), or a looping time cycle. */
  driver?: string | null;
  gradientStops?: { pos: number; color: [number, number, number] }[] | null;
  cycleSecs?: number | null;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Live values read by the animation loop without restarting it.
  const params = useRef({ hue, saturation, mode, driver, gradientStops, cycleSecs });
  params.current = { hue, saturation, mode, driver, gradientStops, cycleSecs };

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
    // A bank of pre-tinted sprites sampled across the gradient, so each
    // particle can wear its own color (age/index/rope drivers) without
    // re-tinting per particle per frame.
    const BANK = 14;
    const bank: HTMLCanvasElement[] = [];
    let lastBankKey = "";

    /** Gradient sample at k (0..1): custom stops, or the hue wheel offset by
     *  the user's hue (rainbow), or the base color (static/pulse). */
    function sampleGradient(k: number): { r: number; g: number; b: number } {
      const { hue, saturation, mode, gradientStops } = params.current;
      if (mode === "rainbow" && gradientStops && gradientStops.length >= 2) {
        const stops = [...gradientStops].sort((a, b) => a.pos - b.pos);
        const kk = Math.min(1, Math.max(0, k));
        let lo = stops[0];
        let hi = stops[stops.length - 1];
        for (let i = 0; i < stops.length - 1; i++) {
          if (kk >= stops[i].pos && kk <= stops[i + 1].pos) {
            lo = stops[i];
            hi = stops[i + 1];
            break;
          }
        }
        const span = hi.pos - lo.pos || 1;
        const t = Math.min(1, Math.max(0, (kk - lo.pos) / span));
        return {
          r: Math.round(lo.color[0] + (hi.color[0] - lo.color[0]) * t),
          g: Math.round(lo.color[1] + (hi.color[1] - lo.color[1]) * t),
          b: Math.round(lo.color[2] + (hi.color[2] - lo.color[2]) * t),
        };
      }
      if (mode === "rainbow") {
        const h = (((baseHsl.h + hue + k * 360) % 360) + 360) % 360;
        const s = Math.min(1, Math.max(baseHsl.s, 0.65) * saturation);
        return hslToRgb(h, s, 0.5);
      }
      // static/pulse: one hue-shifted color; pulse dims over the bank index.
      let l = baseHsl.l;
      if (mode === "pulse") l = baseHsl.l * (0.2 + 0.8 * k);
      const h = (((baseHsl.h + hue) % 360) + 360) % 360;
      return hslToRgb(h, Math.min(1, baseHsl.s * saturation), l);
    }

    function rebuildBank() {
      if (!ready) return;
      const { hue, saturation, mode, gradientStops } = params.current;
      const key = JSON.stringify([hue, saturation, mode, gradientStops]);
      if (key === lastBankKey) return;
      lastBankKey = key;
      bank.length = 0;
      for (let i = 0; i < BANK; i++) {
        const c = sampleGradient(i / (BANK - 1));
        const t = document.createElement("canvas");
        t.width = img.width;
        t.height = img.height;
        const tg = t.getContext("2d")!;
        tg.drawImage(img, 0, 0);
        tg.globalCompositeOperation = "source-in";
        tg.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
        tg.fillRect(0, 0, t.width, t.height);
        bank.push(t);
      }
    }
    img.onload = () => {
      ready = true;
      lastBankKey = "";
      rebuildBank();
    };
    if (sprites[0]) img.src = convertFileSrc(sprites[0]);

    type P = { x: number; y: number; vx: number; vy: number; life: number; max: number; sz: number; rot: number; vr: number; seed: number };
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
        seed: Math.random(),
      });
    }

    /** Which gradient sample this particle wears right now. */
    function gradientPos(p: P, tSec: number): number {
      const { mode, driver, cycleSecs } = params.current;
      if (mode === "pulse") return 0.6 + 0.4 * Math.sin(tSec * 4);
      if (mode !== "rainbow") return 0.5;
      switch (driver ?? "age") {
        case "time":
          return (tSec / Math.max(0.5, cycleSecs ?? 3)) % 1;
        case "noise":
          return (p.seed + tSec * 0.22) % 1;
        case "index":
          return p.seed;
        case "rope":
          return Math.min(1, Math.max(0, p.x / W));
        default: // age
          return p.life / p.max;
      }
    }

    let raf = 0;
    const start = performance.now();
    let prev = start;
    function frame(now: number) {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const tSec = (now - start) / 1000;
      rebuildBank();
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
        if (ready && bank.length > 0) {
          const idx = Math.min(
            BANK - 1,
            Math.max(0, Math.round(gradientPos(p, tSec) * (BANK - 1))),
          );
          g.drawImage(bank[idx], -p.sz / 2, -p.sz / 2, p.sz, p.sz);
        }
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
