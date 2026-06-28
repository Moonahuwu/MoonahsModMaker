import type { Song } from "../types";

// A stable fingerprint of everything that affects a song's compiled `.vsnd_c`:
// its source file, name (drives the output path), trim window, gain, fades, and
// loop flag. When this equals `song.lastCompiledHash` and the compiled file is
// still on disk, the compile pipeline skips re-rendering it.
//
// Must stay in sync with the backend's skip check (it only compares equality, so
// any stable string works — the frontend owns the format).
export function songHash(song: Song): string {
  return [
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

/** Compile status of a song relative to its last successful compile. */
export type SongStatus = "new" | "compiled" | "stale";

export function songStatus(song: Song): SongStatus {
  if (!song.lastCompiledHash) return "new";
  return songHash(song) === song.lastCompiledHash ? "compiled" : "stale";
}
