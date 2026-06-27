// Module-level cache of decoded waveform peaks, keyed by audio URL.
//
// Decoding audio to peaks is the slow part of rendering a waveform. WaveSurfer
// re-decodes from scratch every time an instance is created (i.e. every remount:
// switching projects, reopening a panel, re-rendering a list). Caching the peaks
// lets later mounts skip decoding entirely — we hand the peaks + duration back to
// WaveSurfer.create(), which renders them immediately and only lazy-loads the
// media element when the user actually presses play.
//
// Keyed by URL: convertFileSrc() yields a stable asset URL per file path, and
// trim/gain edits never change the *source* audio, so a song's peaks stay valid
// for its whole lifetime.

export type CachedPeaks = {
  /** One array of normalized peak values per channel. */
  peaks: number[][];
  /** Track duration in seconds. */
  duration: number;
};

const cache = new Map<string, CachedPeaks>();

export function getCachedPeaks(url: string): CachedPeaks | undefined {
  return cache.get(url);
}

export function setCachedPeaks(url: string, peaks: number[][], duration: number): void {
  cache.set(url, { peaks, duration });
}
