import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

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
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 72,
      waveColor: "#3f3f46",
      progressColor: "#52525b",
      cursorColor: "#a1a1aa",
      normalize: true,
      plugins: [regions],
    });

    ws.on("decode", (duration) => {
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

    // Click region body to play just that slice (unprocessed preview of trim).
    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      region.play();
    });

    return () => {
      ws.destroy();
    };
  }, [url]);

  return <div ref={containerRef} className="w-full cursor-text" />;
}
