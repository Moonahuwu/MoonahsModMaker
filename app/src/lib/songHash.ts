import type { Song } from "../types";

// A stable fingerprint of everything that affects a song's compiled `.vsnd_c`:
// its source file, name (drives the output path), trim window, gain, fades, and
// loop flag. When this equals `song.lastCompiledHash` and the compiled file is
// still on disk, the compile pipeline skips re-rendering it.
//
// Must stay in sync with the backend's skip check (it only compares equality, so
// any stable string works — the frontend owns the format).
// Renderer version salt: bump when the ffmpeg render itself changes meaning
// (e.g. v2 = the -ss placement fix that put fades on the trimmed timeline), so
// every previously-compiled track re-renders once with the corrected output.
const RENDER_V = "v2";

export function songHash(song: Song): string {
  return [
    RENDER_V,
    song.sourceMp3,
    song.soundName,
    song.trimStart,
    song.trimEnd,
    song.gainDb,
    song.fadeIn,
    song.fadeOut,
    song.looping ? 1 : 0,
  ].join("|");
}

/** Fingerprint of a loose-file sound override (same idea as songHash). */
export function overrideHash(o: {
  sourceAudio: string;
  targetRef: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
}): string {
  return [
    RENDER_V,
    o.sourceAudio,
    o.targetRef,
    o.trimStart,
    o.trimEnd,
    o.gainDb,
    o.fadeIn,
    o.fadeOut,
    o.looping ? 1 : 0,
  ].join("|");
}

/** Fingerprint of a VFX recolor override (target + hue + saturation + mode). */
export function effectHash(e: {
  targetRef: string;
  hue: number;
  saturation: number;
  mode: string;
}): string {
  return [e.targetRef, e.hue, e.saturation, e.mode].join("|");
}

/** Fingerprint of one poster override. `sheetSiblings` is the sorted id+image
 * list of EVERY override on the same sheet: the compile works per sheet, so
 * adding/removing a sibling must invalidate the others or a removed poster's
 * art would linger in the previously-compiled atlas. */
export function posterHash(
  p: {
    id: string;
    sourceImage: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fit: string;
    rotation?: number;
    erase?: boolean;
  },
  sheetSiblings: string,
): string {
  return [
    p.id,
    p.sourceImage,
    p.x,
    p.y,
    p.w,
    p.h,
    p.fit,
    p.rotation ?? 0,
    p.erase ? 1 : 0,
    sheetSiblings,
  ].join("|");
}

/** Compile status of a song relative to its last successful compile. */
export type SongStatus = "new" | "compiled" | "stale";

export function songStatus(song: Song): SongStatus {
  if (!song.lastCompiledHash) return "new";
  return songHash(song) === song.lastCompiledHash ? "compiled" : "stale";
}
