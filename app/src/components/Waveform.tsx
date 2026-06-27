import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { getCachedPeaks, setCachedPeaks } from "../lib/peaksCache";

interface WaveformProps {
  /** Playable URL of the FULL source audio (via convertFileSrc). */
  url: string;
  /** Initial trim window, in seconds. */
  trimStart: number;
  trimEnd: number;
  /** Called when the user drags/resizes the trim region. */
  onTrimChange: (start: number, end: number) => void;
}

/**
 * Renders the full source waveform with a single draggable/resizable region
 * marking the trim window. The region is the source of truth for trim edits;
 * `trimStart/trimEnd` seed it on load.
 */
export function Waveform({ url, trimStart, trimEnd, onTrimChange }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep latest trim/callback without re-creating wavesurfer on every change.
  const trimRef = useRef({ trimStart, trimEnd });
  trimRef.current = { trimStart, trimEnd };
  const onTrimChangeRef = useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const regions = RegionsPlugin.create();
    const cached = getCachedPeaks(url);
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 72,
      waveColor: "#3f3f46",
      progressColor: "#52525b",
      cursorColor: "#a1a1aa",
      normalize: true,
      plugins: [regions],
      // Reuse decoded peaks if we have them — skips the costly re-decode and
      // renders instantly; the media element still lazy-loads for playback.
      ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
    });

    // `decode` fires whether peaks were decoded fresh or supplied from cache,
    // so the trim region is added in both paths.
    ws.on("decode", (duration) => {
      if (!cached) setCachedPeaks(url, ws.exportPeaks(), duration);
      const { trimStart: s, trimEnd: e } = trimRef.current;
      regions.addRegion({
        start: Math.max(0, s),
        end: Math.min(e || duration, duration),
        color: "rgba(16, 185, 129, 0.18)",
        drag: true,
        resize: true,
      });
    });

    regions.on("region-updated", (region) => {
      onTrimChangeRef.current(region.start, region.end);
    });

    // Left-click the trim region to play that slice; click again to pause/resume.
    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      if (ws.isPlaying()) {
        ws.pause();
      } else {
        region.play();
      }
    });

    // Right-click anywhere on the waveform to move the playhead to that point.
    const el = containerRef.current!;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const dur = ws.getDuration();
      if (dur > 0) ws.setTime(ratio * dur);
    };
    el.addEventListener("contextmenu", onContext);

    return () => {
      el.removeEventListener("contextmenu", onContext);
      ws.destroy();
    };
  }, [url]);

  return <div ref={containerRef} className="w-full cursor-pointer" />;
}
