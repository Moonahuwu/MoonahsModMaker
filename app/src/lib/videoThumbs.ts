import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * Video-card thumbnails without any webview video decode: the backend runs
 * ffmpeg once per file identity (path+size+mtime) and caches a small jpeg in
 * app-data, so cards are plain <img>s — instant on every visit, in every
 * session. The in-memory map here just dedupes concurrent requests; the real
 * cache is the disk.
 *
 * Resolves to an asset URL for the jpeg, or null when a frame couldn't be
 * extracted — callers should show a static placeholder then (never fall back
 * to autoplaying video; that's the lag this exists to prevent).
 */
const cache = new Map<string, Promise<string | null>>();

// Small gate so a big library doesn't spawn 15 ffmpeg processes at once on
// the very first visit.
let active = 0;
const waiters: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= 3) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** Cached thumbnail URL for a local video file path. */
export function videoThumb(path: string, ffmpegPath?: string): Promise<string | null> {
  let p = cache.get(path);
  if (!p) {
    p = gated(async () => {
      try {
        const jpg = await invoke<string>("media_thumb", {
          ffmpegPath: ffmpegPath || null,
          mediaPath: path,
        });
        return convertFileSrc(jpg);
      } catch {
        return null;
      }
    });
    cache.set(path, p);
  }
  return p;
}
