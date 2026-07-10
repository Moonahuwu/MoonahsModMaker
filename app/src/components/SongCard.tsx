import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import WaveSurfer from "wavesurfer.js";
import { probeAudio, processAudio } from "../lib/api";
import { getCachedPeaks, setCachedPeaks } from "../lib/peaksCache";
import { songStatus } from "../lib/songHash";
import type { Song, SongLayer } from "../types";
import { Waveform } from "./Waveform";
import { StockWaveform } from "./StockWaveform";

const AUDIO_FILTERS = [
  { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
];

/** Round to 10ms - keeps dragged values (and the JSON they save to) tidy. */
function snap(v: number): number {
  return Math.round(v * 100) / 100;
}

/** A layer's waveform, drawn non-interactively inside its timeline block (the
 *  block's own drag handlers do the work; the wave is just the picture). */
function LayerWave({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const url = convertFileSrc(path);
    const cached = getCachedPeaks(url);
    const ws = WaveSurfer.create({
      container: ref.current,
      url,
      height: 44,
      waveColor: "#7dd3fcaa",
      progressColor: "#7dd3fcaa",
      cursorWidth: 0,
      interact: false,
      normalize: true,
      ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
    });
    ws.on("decode", (d) => {
      if (!cached) setCachedPeaks(url, ws.exportPeaks(), d);
    });
    return () => ws.destroy();
  }, [path]);
  return <div ref={ref} className="pointer-events-none h-full w-full" />;
}

// Exception-based status: compiled is the normal state, so it gets only the
// colored dot — badges are reserved for rows that still need a compile.
const STATUS_BADGE: Record<string, { label: string; cls: string } | null> = {
  new: { label: "New", cls: "bg-emerald-500/10 text-emerald-300" },
  compiled: null,
  stale: { label: "Out of date", cls: "bg-amber-500/10 text-amber-300" },
};
const STATUS_DOT: Record<string, string> = {
  new: "bg-emerald-400",
  compiled: "bg-sky-400/80",
  stale: "bg-amber-400",
};

interface SongCardProps {
  song: Song;
  soundFolder: string;
  ffmpegPath?: string;
  /** Optional drag handle (rendered in the header) for reordering. */
  handle?: ReactNode;
  /** Whether the card is expanded (controlled by the parent so it survives
   *  tab switches). */
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<Song>) => void;
  onRename: (raw: string) => void;
  onRemove: () => void;
  onDownload: () => void;
  /** Copy this track (file + trims/gain/fades/loop) to the sound clipboard. */
  onCopy: () => void;
  /** Accent color + the event's stock track, so the card can optionally show
   *  the original waveform stacked above yours for comparison. */
  accent: string;
  stockName: string;
  stockUrl: string | null;
  stockLoading: boolean;
  stockErr: string | null;
  /** Lazily decode the original track (called when compare is first opened). */
  onLoadStock: () => void;
  /** Open the compare panel by default (from settings). */
  compareDefault: boolean;
  /** Registers the EXPANDED body element - the window drop handler uses it so
   *  audio dropped on an open card lands as a layer, not a new track. */
  bodyRef?: (el: HTMLElement | null) => void;
}

function fmtTime(s: number): string {
  return `${s.toFixed(2)}s`;
}

type PlayState = "idle" | "loading" | "playing" | "paused";

export function SongCard({
  song,
  soundFolder,
  ffmpegPath,
  handle,
  expanded,
  onToggleExpanded,
  onChange,
  onRename,
  onRemove,
  onDownload,
  onCopy,
  accent,
  stockName,
  stockUrl,
  stockLoading,
  stockErr,
  onLoadStock,
  compareDefault,
  bodyRef,
}: SongCardProps) {
  const [state, setState] = useState<PlayState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(compareDefault);
  // Decoded lengths of both tracks, so they can share one px/second scale.
  const [stockDur, setStockDur] = useState<number | null>(null);
  const [mineDur, setMineDur] = useState<number | null>(null);
  // Live playhead positions while each waveform plays.
  const [stockTime, setStockTime] = useState(0);
  const [mineTime, setMineTime] = useState(0);
  const [nameDraft, setNameDraft] = useState(song.soundName);

  // If compare defaults open, decode the original up front (idempotent).
  useEffect(() => {
    if (compareDefault) onLoadStock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scale each waveform to a shared timeline: the longer track fills the width,
  // the shorter one ends proportionally early.
  const maxDur = Math.max(stockDur ?? 0, mineDur ?? 0);
  const pct = (d: number | null) =>
    maxDur > 0 && d != null ? (d / maxDur) * 100 : 100;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Key the rendered audio was produced for; re-render when trim/gain change.
  const renderedKey = useRef<string>("");

  const url = convertFileSrc(song.sourceMp3);
  const length = Math.max(0, song.trimEnd - song.trimStart);
  // Layers with a file picked - what the preview mixes and the compile ships.
  const activeLayers = (song.layers ?? []).filter((l) => l.sourceAudio);
  const layersKey = activeLayers
    .map(
      (l) =>
        `${l.sourceAudio}@${l.gainDb}@${l.offset ?? 0}@${l.trimStart ?? 0}@${l.trimEnd ?? 0}`,
    )
    .join(",");
  const paramKey = `${song.sourceMp3}|${song.trimStart}|${song.trimEnd}|${song.gainDb}|${song.fadeIn}|${song.fadeOut}|${layersKey}`;

  // Keep the rename draft in sync if soundName changes elsewhere.
  useEffect(() => setNameDraft(song.soundName), [song.soundName]);

  // Detached Audio objects outlive the component — stop playback on unmount
  // (tab switch, song removal).
  useEffect(() => () => audioRef.current?.pause(), []);

  // Invalidate cached playback when the trim/gain change.
  useEffect(() => {
    if (renderedKey.current && renderedKey.current !== paramKey) {
      audioRef.current?.pause();
      audioRef.current = null;
      renderedKey.current = "";
      setState("idle");
    }
  }, [paramKey]);

  async function playPause() {
    setError(null);
    if (state === "playing") {
      audioRef.current?.pause();
      setState("paused");
      return;
    }
    if (state === "paused" && audioRef.current) {
      await audioRef.current.play();
      setState("playing");
      return;
    }
    // idle → render (if needed) then play
    setState("loading");
    try {
      const outPath = await processAudio({
        sourcePath: song.sourceMp3,
        trimStart: song.trimStart,
        trimEnd: song.trimEnd,
        gainDb: song.gainDb,
        fadeIn: song.fadeIn,
        fadeOut: song.fadeOut,
        layers: activeLayers.map((l) => ({
          sourceAudio: l.sourceAudio,
          gainDb: l.gainDb,
          offset: l.offset ?? 0,
          trimStart: l.trimStart ?? 0,
          trimEnd: l.trimEnd ?? 0,
        })),
        ffmpegPath,
      });
      const audio = new Audio(convertFileSrc(outPath));
      audioRef.current = audio;
      renderedKey.current = paramKey;
      audio.onended = () => setState("idle");
      audio.onpause = () => {
        // only reflect external pauses; our explicit pause already set state
      };
      audio.onerror = () => {
        setError("playback failed");
        setState("idle");
      };
      await audio.play();
      setState("playing");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }

  function stop() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setState("idle");
  }

  const playIcon = state === "loading" ? "…" : state === "playing" ? "⏸" : state === "paused" ? "▶" : "▶";

  // Compact one-liner for the collapsed row: just length + gain + loop —
  // fades are editing detail, visible in the expanded view.
  const summary = [
    fmtTime(length),
    song.gainDb !== 0 ? `${song.gainDb > 0 ? "+" : ""}${song.gainDb}dB` : null,
    song.looping ? "loop" : null,
    activeLayers.length > 0
      ? `${activeLayers.length} layer${activeLayers.length > 1 ? "s" : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  async function addLayers() {
    const sel = await open({
      multiple: true,
      title: "Mix which audio file(s) into this track?",
      filters: AUDIO_FILTERS,
    });
    if (!sel) return;
    const files = Array.isArray(sel) ? sel : [sel];
    const added: SongLayer[] = files.map((f) => ({
      id: crypto.randomUUID(),
      sourceAudio: f,
      gainDb: 0,
      offset: 0,
      trimStart: 0,
      trimEnd: 0,
    }));
    onChange({ layers: [...(song.layers ?? []), ...added] });
  }

  function updateLayer(id: string, patch: Partial<SongLayer>) {
    onChange({
      layers: (song.layers ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  }

  function removeLayer(id: string) {
    onChange({ layers: (song.layers ?? []).filter((l) => l.id !== id) });
  }

  // ---- Layer timeline ----
  // Source durations, probed once per layer (needed to size blocks and to
  // clamp the right-edge trim).
  const [layerDurs, setLayerDurs] = useState<Record<string, number>>({});
  const probed = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const l of song.layers ?? []) {
      if (!l.sourceAudio || probed.current.has(l.id)) continue;
      probed.current.add(l.id);
      probeAudio(l.sourceAudio, ffmpegPath)
        .then((info) => setLayerDurs((d) => ({ ...d, [l.id]: info.duration })))
        .catch(() => setLayerDurs((d) => ({ ...d, [l.id]: 0 })));
    }
  }, [song.layers, ffmpegPath]);

  // The bite's timeline: the base track's trimmed length. Lanes render on the
  // SOURCE timeline (the same scale as the waveform above them) so layers sit
  // visually aligned; a layer's offset stays anchored to the trim start.
  const clipLen = Math.max(0.1, length);
  const tlDur = mineDur ?? Math.max(song.trimEnd, 0.1);
  /** A layer's effective clip window (end falls back to its file's length). */
  function layerWin(l: SongLayer): { ts: number; te: number; dur: number } {
    const dur = layerDurs[l.id] ?? 0;
    const ts = Math.max(0, l.trimStart ?? 0);
    const rawTe = l.trimEnd ?? 0;
    const te = rawTe > ts ? rawTe : dur > 0 ? dur : Math.min(clipLen, ts + clipLen);
    return { ts, te: Math.max(ts + 0.05, te), dur };
  }

  // One drag at a time: move the block, or trim either edge. Values write
  // straight into the layer via onChange; `orig` keeps the drag anchored.
  const drag = useRef<{
    id: string;
    mode: "move" | "l" | "r";
    startX: number;
    pxPerSec: number;
    orig: { offset: number; ts: number; te: number; dur: number };
  } | null>(null);

  function beginDrag(
    e: React.PointerEvent,
    l: SongLayer,
    mode: "move" | "l" | "r",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]");
    const w = lane?.clientWidth ?? 1;
    const { ts, te, dur } = layerWin(l);
    drag.current = {
      id: l.id,
      mode,
      startX: e.clientX,
      pxPerSec: w / tlDur,
      orig: { offset: Math.max(0, l.offset ?? 0), ts, te, dur },
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dsec = (e.clientX - d.startX) / d.pxPerSec;
    const { offset, ts, te, dur } = d.orig;
    if (d.mode === "move") {
      updateLayer(d.id, {
        offset: snap(Math.min(Math.max(0, offset + dsec), Math.max(0, clipLen - 0.05))),
      });
    } else if (d.mode === "l") {
      // In-point trim: content stays anchored on the timeline, so the offset
      // shifts by the same amount (exactly like edge-trimming in an editor).
      const lo = -Math.min(ts, offset);
      const hi = te - ts - 0.05;
      const dd = Math.min(Math.max(dsec, lo), hi);
      updateLayer(d.id, { trimStart: snap(ts + dd), offset: snap(offset + dd) });
    } else {
      const max = dur > 0 ? dur : te + Math.max(0, dsec) + 1;
      updateLayer(d.id, {
        trimEnd: snap(Math.min(Math.max(te + dsec, ts + 0.05), max)),
      });
    }
  }

  function endDrag() {
    drag.current = null;
  }

  const status = songStatus(song);
  const badge = STATUS_BADGE[status];

  return (
    <div className="group rounded-lg border border-zinc-700/60 bg-zinc-900/80 shadow-sm transition hover:border-zinc-600">
      {/* Header row — always visible; the whole card collapses to just this. */}
      <div className="flex items-center gap-2 p-2.5">
        {handle}
        <button
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span
          title={status === "compiled" ? "Compiled" : status === "stale" ? "Changed since last compile" : "Not compiled yet"}
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
        />
        <input
          value={song.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-zinc-100 outline-none transition hover:border-zinc-700 focus:border-zinc-500"
          placeholder="Track name"
        />
        {!expanded && (
          <span className="hidden shrink-0 truncate text-[11px] tabular-nums text-zinc-600 sm:inline">
            {summary}
          </span>
        )}
        {badge && (
          <span
            className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}
          >
            {badge.label}
          </span>
        )}
        <button
          onClick={playPause}
          disabled={state === "loading"}
          aria-label="Preview"
          title="Preview the processed clip"
          className="shrink-0 rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-emerald-300 disabled:opacity-50"
        >
          {playIcon}
        </button>
        {(state === "playing" || state === "paused") && (
          <button
            onClick={stop}
            aria-label="Stop"
            className="shrink-0 rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            ■
          </button>
        )}
        {/* Secondary actions surface on hover to keep the header calm. */}
        <button
          onClick={onDownload}
          aria-label="Download a copy"
          title="Copy this source file to your Downloads folder"
          className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ⤓
        </button>
        <button
          onClick={onCopy}
          aria-label="Copy track"
          title="Copy - paste it into any other slot (file + trims/gain/fades come along)"
          className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ⧉
        </button>
        <button
          onClick={onRemove}
          aria-label="Remove track"
          className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:bg-red-950/50 hover:text-red-300"
        >
          ✕
        </button>
      </div>

      {/* Expanded body — filename, waveform, and the adjust controls. */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div ref={bodyRef} className="px-3.5 pb-3.5">
              {/* Filename (drives the .vsnd / .vsnd_c / soundevent reference) */}
              <div className="mb-2.5 flex items-center gap-1 pl-1 font-mono text-[11px] text-zinc-500">
                <span className="text-zinc-600">{soundFolder}/</span>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    if (nameDraft !== song.soundName) onRename(nameDraft);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  spellCheck={false}
                  className="w-32 rounded border border-transparent bg-transparent px-1 text-zinc-300 outline-none transition hover:border-zinc-700 focus:border-zinc-500"
                  title="Rename the file (updates the .vsnd_c and soundevent reference)"
                />
                <span className="text-zinc-600">.vsnd</span>
              </div>

              {/* Optional: stack the original game track above yours to
                  compare length / beats against what you're replacing. */}
              <div className="mb-2 flex items-center justify-between">
                <button
                  onClick={() => {
                    const next = !compareOpen;
                    setCompareOpen(next);
                    if (next) onLoadStock();
                  }}
                  className="text-[11px] text-zinc-500 transition hover:text-zinc-300"
                  title="Show the original in-game track above yours to compare"
                >
                  {compareOpen ? "▾" : "▸"} Compare to original
                </button>
                {compareOpen && (
                  <span className="truncate pl-2 text-[10px] text-zinc-600">
                    {stockName}
                  </span>
                )}
              </div>

              <AnimatePresence initial={false}>
                {compareOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <div className="mb-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-2.5 py-2">
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-amber-300/70">
                          Original
                        </span>
                        {stockDur != null && (
                          <span className="text-[10px] tabular-nums text-zinc-600">
                            {stockTime > 0 && (
                              <span className="text-amber-300/80">
                                {stockTime.toFixed(1)} /{" "}
                              </span>
                            )}
                            {stockDur.toFixed(1)}s
                          </span>
                        )}
                      </div>
                      {stockLoading && (
                        <span className="text-xs text-zinc-600">decoding original…</span>
                      )}
                      {stockErr && <span className="text-xs text-red-400">{stockErr}</span>}
                      {stockUrl && (
                        <StockWaveform
                          url={stockUrl}
                          accent={accent}
                          widthPct={pct(stockDur)}
                          onDuration={setStockDur}
                          onTime={setStockTime}
                          timeline
                        />
                      )}
                    </div>
                    <div className="mb-1 flex items-baseline justify-between pl-1">
                      <span className="text-[10px] uppercase tracking-wide text-emerald-300/70">
                        Yours
                      </span>
                      {mineDur != null && (
                        <span className="text-[10px] tabular-nums text-zinc-600">
                          {mineTime > 0 && (
                            <span className="text-emerald-300/80">
                              {mineTime.toFixed(1)} /{" "}
                            </span>
                          )}
                          {mineDur.toFixed(1)}s
                        </span>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* When comparing, gutter matches the original's play-button column
                  (w-7 + gap-2) so both timelines share a left origin. */}
              <div className={compareOpen ? "flex items-start gap-2" : undefined}>
                {compareOpen && <div className="w-7 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <Waveform
                    url={url}
                    trimStart={song.trimStart}
                    trimEnd={song.trimEnd}
                    onTrimChange={(start, end) => onChange({ trimStart: start, trimEnd: end })}
                    widthPct={compareOpen ? pct(mineDur) : undefined}
                    onDuration={setMineDur}
                    onTime={setMineTime}
                    timeline
                  />
                  {/* Layer lanes: stacked under the waveform on the same time
                      scale, editor-style. Drag a wave to place it, edges to
                      trim; each bakes into this one track at compile. */}
                  {(song.layers ?? []).length > 0 && (
                    <div
                      style={compareOpen ? { width: `${pct(mineDur)}%` } : undefined}
                    >
                      {(song.layers ?? []).map((l) => {
                        const { ts, te } = layerWin(l);
                        const len = te - ts;
                        const off = Math.max(0, l.offset ?? 0);
                        const srcDur = layerDurs[l.id] ?? 0;
                        // The clip window's position on the shared timeline,
                        // and the FULL waveform anchored so its in-point sits
                        // at the window's left edge. Trims never rescale the
                        // wave - the highlighted window just grows/shrinks
                        // over it, exactly like the trim region up top.
                        const start = song.trimStart + off;
                        const regionLeft = Math.min(100, (start / tlDur) * 100);
                        const regionW = Math.max(
                          0.75,
                          Math.min(100 - regionLeft, (len / tlDur) * 100),
                        );
                        const waveLeft = ((start - ts) / tlDur) * 100;
                        const waveW = ((srcDur || len) / tlDur) * 100;
                        return (
                          <div key={l.id} className="mt-1">
                            <div
                              data-lane
                              className="relative h-11 overflow-hidden rounded bg-zinc-900/60"
                            >
                              {srcDur > 0 && (
                                <div
                                  className="absolute inset-y-0"
                                  style={{ left: `${waveLeft}%`, width: `${waveW}%` }}
                                >
                                  <LayerWave path={l.sourceAudio} />
                                </div>
                              )}
                              {/* Dim the wave outside the clip window. */}
                              <div
                                className="pointer-events-none absolute inset-y-0 left-0 bg-zinc-950/70"
                                style={{ width: `${Math.max(0, regionLeft)}%` }}
                              />
                              <div
                                className="pointer-events-none absolute inset-y-0 right-0 bg-zinc-950/70"
                                style={{
                                  width: `${Math.max(0, 100 - regionLeft - regionW)}%`,
                                }}
                              />
                              {/* The clip window: drag to move (the wave slides
                                  along), edges to trim (the wave stays put). */}
                              <div
                                onPointerDown={(e) => beginDrag(e, l, "move")}
                                onPointerMove={onDragMove}
                                onPointerUp={endDrag}
                                title={`starts ${off.toFixed(2)}s into the clip - drag to move, edges to trim`}
                                className="absolute inset-y-0 flex cursor-grab touch-none items-stretch justify-between rounded-sm bg-sky-400/15 ring-1 ring-inset ring-sky-400/40 active:cursor-grabbing"
                                style={{ left: `${regionLeft}%`, width: `${regionW}%` }}
                              >
                                <span
                                  onPointerDown={(e) => beginDrag(e, l, "l")}
                                  onPointerMove={onDragMove}
                                  onPointerUp={endDrag}
                                  className="w-1.5 shrink-0 cursor-ew-resize touch-none bg-sky-400/60 transition hover:bg-sky-300"
                                />
                                <span
                                  onPointerDown={(e) => beginDrag(e, l, "r")}
                                  onPointerMove={onDragMove}
                                  onPointerUp={endDrag}
                                  className="w-1.5 shrink-0 cursor-ew-resize touch-none bg-sky-400/60 transition hover:bg-sky-300"
                                />
                              </div>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 pl-1 text-[10px] text-zinc-500">
                              <span
                                className="max-w-[38%] truncate"
                                title={l.sourceAudio}
                              >
                                {l.sourceAudio.split(/[\\/]/).pop()}
                              </span>
                              <input
                                type="range"
                                min={-24}
                                max={12}
                                step={0.5}
                                value={l.gainDb}
                                onChange={(e) =>
                                  updateLayer(l.id, { gainDb: Number(e.target.value) })
                                }
                                title="Layer volume"
                                className="h-1 w-24 accent-sky-400"
                              />
                              <span className="w-10 tabular-nums">
                                {l.gainDb > 0 ? "+" : ""}
                                {l.gainDb}dB
                              </span>
                              <span className="tabular-nums text-zinc-600">
                                {len.toFixed(2)}s at {off.toFixed(2)}s
                              </span>
                              <button
                                onClick={() => removeLayer(l.id)}
                                aria-label="Remove layer"
                                className="ml-auto rounded p-0.5 text-zinc-600 transition hover:bg-red-950/40 hover:text-red-300"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="rounded bg-zinc-800/80 px-2 py-1 text-[11px] tabular-nums text-zinc-400">
                  {fmtTime(song.trimStart)}–{fmtTime(song.trimEnd)}
                  <span className="ml-1 text-zinc-600">({fmtTime(length)})</span>
                </span>

                {mineTime > 0 && (
                  <span
                    className="rounded bg-emerald-500/10 px-2 py-1 text-[11px] tabular-nums text-emerald-300"
                    title="Playhead position - click the waveform to play from there"
                  >
                    ▶ {fmtTime(mineTime)}
                  </span>
                )}

                <label
                  className="flex items-center gap-1.5 text-xs text-zinc-400"
                  title="Loop this track (writes loop points to encoding.txt - needed for _lp slots)"
                >
                  <input
                    type="checkbox"
                    checked={song.looping}
                    onChange={(e) => onChange({ looping: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  Loop
                </label>

                <button
                  onClick={() => void addLayers()}
                  title="Mix another sound on top of this one - it shows as a draggable lane under the waveform (or just drop audio on this open card)"
                  className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-sky-500/70 hover:text-sky-300"
                >
                  + Layer
                </button>
              </div>

              {/* Sliders in an even grid — no ragged wrap. */}
              <div className="mt-2 grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-3">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="whitespace-nowrap text-zinc-500">Gain</span>
                  <input
                    type="range"
                    min={-12}
                    max={24}
                    step={0.5}
                    value={song.gainDb}
                    onChange={(e) => onChange({ gainDb: Number(e.target.value) })}
                    className="min-w-[70px] flex-1 accent-emerald-500"
                  />
                  <span className="w-14 text-right tabular-nums text-zinc-300">
                    {song.gainDb > 0 ? "+" : ""}
                    {song.gainDb}dB
                  </span>
                </label>

                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="whitespace-nowrap text-zinc-500">Fade&nbsp;in</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.round(length))}
                    step={0.1}
                    value={song.fadeIn}
                    onChange={(e) => onChange({ fadeIn: Number(e.target.value) })}
                    className="min-w-[70px] flex-1 accent-emerald-500"
                  />
                  <span className="w-12 text-right tabular-nums text-zinc-300">
                    {song.fadeIn.toFixed(1)}s
                  </span>
                </label>

                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="whitespace-nowrap text-zinc-500">Fade&nbsp;out</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, Math.round(length))}
                    step={0.1}
                    value={song.fadeOut}
                    onChange={(e) => onChange({ fadeOut: Number(e.target.value) })}
                    className="min-w-[70px] flex-1 accent-emerald-500"
                  />
                  <span className="w-12 text-right tabular-nums text-zinc-300">
                    {song.fadeOut.toFixed(1)}s
                  </span>
                </label>
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <p className="px-3.5 pb-2.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}
