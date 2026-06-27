import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { getCachedPeaks, setCachedPeaks } from "../lib/peaksCache";

/** Plain display waveform with play/pause — used to compare the stock track
 *  against your clips (length / beats). No trim region. */
export function StockWaveform({ url, accent }: { url: string; accent: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cached = getCachedPeaks(url);
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url,
      height: 48,
      waveColor: "#52525b",
      progressColor: accent,
      cursorColor: "#a1a1aa",
      normalize: true,
      // Reuse decoded peaks if available to skip re-decoding on remount.
      ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
    });
    wsRef.current = ws;
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    ws.on("decode", (d) => {
      if (!cached) setCachedPeaks(url, ws.exportPeaks(), d);
      setDuration(d);
    });
    ws.on("interaction", () => ws.play());
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [url, accent]);

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => wsRef.current?.playPause()}
        className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500"
      >
        {playing ? "⏸" : "▶"}
      </button>
      <div ref={containerRef} className="min-w-0 flex-1" />
      {duration != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
          {duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
}
