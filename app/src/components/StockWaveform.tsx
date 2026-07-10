import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { getCachedPeaks, setCachedPeaks } from "../lib/peaksCache";
import { makeTimeline } from "./Waveform";

/** Plain display waveform with play/pause — used to compare the stock track
 *  against your clips (length / beats). No trim region.
 *  `widthPct` scales the drawing area (left-aligned) so two stacked waveforms
 *  can share one px/second scale; `onDuration` reports the decoded length. */
export function StockWaveform({
  url,
  accent,
  widthPct,
  onDuration,
  timeline,
  onTime,
  autoplay,
}: {
  url: string;
  accent: string;
  widthPct?: number;
  onDuration?: (d: number) => void;
  timeline?: boolean;
  onTime?: (t: number) => void;
  /** Start playing as soon as the audio is ready (GameBanana previews). */
  autoplay?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
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
      ...(timelineRef.current ? { plugins: [makeTimeline()] } : {}),
      // Reuse decoded peaks if available to skip re-decoding on remount.
      ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
    });
    wsRef.current = ws;
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => {
      setPlaying(false);
      onTimeRef.current?.(0);
    });
    ws.on("timeupdate", (t) => onTimeRef.current?.(t));
    ws.on("decode", (d) => {
      if (!cached) setCachedPeaks(url, ws.exportPeaks(), d);
      setDuration(d);
      onDurationRef.current?.(d);
    });
    ws.on("interaction", () => ws.play());
    if (autoplay) ws.on("ready", () => void ws.play());
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [url, accent]);

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => wsRef.current?.playPause()}
        className="w-7 shrink-0 rounded-md border border-zinc-700 py-1 text-center text-xs text-zinc-300 transition hover:border-zinc-500"
      >
        {playing ? "⏸" : "▶"}
      </button>
      <div className="min-w-0 flex-1">
        <div
          ref={containerRef}
          style={widthPct != null ? { width: `${widthPct}%` } : undefined}
        />
      </div>
      {widthPct == null && duration != null && (
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
          {duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
}
