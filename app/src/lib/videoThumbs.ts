import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Session-wide first-frame thumbnail cache for local video files (same idea
 * as peaksCache for waveforms). A page full of `<video autoplay>` decodes
 * every clip simultaneously on every mount — laggy. Instead each card shows
 * a captured still (generated once per session, two at a time) and only
 * decodes real video on hover.
 *
 * Resolves to a jpeg data-URL, or null when capture isn't possible (e.g. a
 * tainted canvas) — callers should fall back to a live <video> then.
 */
const cache = new Map<string, Promise<string | null>>();

// Tiny concurrency gate: thumbnailing is background work; two at a time keeps
// first paint smooth even with a big library.
let active = 0;
const waiters: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= 2) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function capture(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    let settled = false;
    const done = (r: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 8000);
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.addEventListener("error", () => done(null));
    v.addEventListener("loadeddata", () => {
      // Frame 0 is often black — grab a beat in.
      const t = Math.min(0.4, (v.duration || 1) * 0.25);
      if (Math.abs(v.currentTime - t) < 0.01) drawNow();
      else v.currentTime = t;
    });
    const drawNow = () => {
      try {
        const w = 320;
        const h = Math.max(2, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, w, h);
        done(c.toDataURL("image/jpeg", 0.72));
      } catch {
        done(null); // tainted canvas or decode hiccup — caller falls back
      }
    };
    v.addEventListener("seeked", drawNow);
    v.src = url;
  });
}

/** Cached first-frame still for a local video file path. */
export function videoThumb(path: string): Promise<string | null> {
  let p = cache.get(path);
  if (!p) {
    p = gated(() => capture(convertFileSrc(path)));
    cache.set(path, p);
  }
  return p;
}
