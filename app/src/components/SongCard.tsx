import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import WaveSurfer from "wavesurfer.js";
import { measureLoudness, probeAudio, processAudio, renderSpecOf } from "../lib/api";
import { getCachedPeaks, setCachedPeaks } from "../lib/peaksCache";
import { songStatus } from "../lib/songHash";
import type { BiteMode, Song, SongLayer, SoundFx } from "../types";
import { Waveform } from "./Waveform";
import { StockWaveform } from "./StockWaveform";
import { FxStrip } from "./FxStrip";
import { applyLivePitch, createLimiter, createLiveFxChain, liveFxKey, type LiveFxChain } from "../lib/liveFx";

const AUDIO_FILTERS = [
  { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
];

/** Round to 10ms - keeps dragged values (and the JSON they save to) tidy. */
function snap(v: number): number {
  return Math.round(v * 100) / 100;
}

/** A layer's waveform, drawn non-interactively inside its timeline block (the
 *  block's own drag handlers do the work; the wave is just the picture). */
function LayerWave({ path, color }: { path: string; color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const url = convertFileSrc(path);
    const cached = getCachedPeaks(url);
    const ws = WaveSurfer.create({
      container: ref.current,
      url,
      height: 44,
      waveColor: color,
      progressColor: color,
      cursorWidth: 0,
      interact: false,
      normalize: true,
      ...(cached ? { peaks: cached.peaks, duration: cached.duration } : {}),
    });
    ws.on("decode", (d) => {
      if (!cached) setCachedPeaks(url, ws.exportPeaks(), d);
    });
    return () => ws.destroy();
  }, [path, color]);
  return <div ref={ref} className="pointer-events-none h-full w-full" />;
}

/** Seconds as "1.25" for the numeric fields. */
function fmtNum(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

/** A small "type the seconds" field that commits on blur/Enter. */
function NumField({
  value,
  onCommit,
  min,
  max,
  title,
  width = "w-14",
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  title?: string;
  width?: string;
}) {
  const [draft, setDraft] = useState(fmtNum(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(fmtNum(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(fmtNum(value));
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (Math.abs(c - value) > 1e-6) onCommit(snap(c));
    else setDraft(fmtNum(value));
  };
  return (
    <input
      value={draft}
      title={title}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(fmtNum(value));
          e.currentTarget.blur();
        }
        e.stopPropagation();
      }}
      className={`${width} rounded border border-zinc-800 bg-zinc-950/60 px-1 py-0.5 text-right text-[11px] tabular-nums text-zinc-300 outline-none transition hover:border-zinc-600 focus:border-zinc-500`}
    />
  );
}

/** Which non-default mix features a song uses (for the collapsed summary). */
function fxSummary(fx: SoundFx | undefined): string | null {
  if (!fx) return null;
  const names: string[] = [];
  if (fx.reverse) names.push("reverse");
  if (fx.pitch) names.push("pitch");
  if (fx.eq) names.push("eq");
  if (fx.crush) names.push("crush");
  if (fx.modulation) names.push(fx.modulation.kind);
  if (fx.compress) names.push("comp");
  if (fx.reverb) names.push("reverb");
  if (fx.limiter) names.push("limit");
  if (fx.loudness != null) names.push("loudness");
  return names.length ? names.join("+") : null;
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
  /** Decode the slot's original game sound to a local audio file, for mixing
   *  it in as a layer. Absent when the slot has no playable stock sound. */
  onFetchOriginal?: () => Promise<string>;
}

function fmtTime(s: number): string {
  return `${s.toFixed(2)}s`;
}

// Shared WebAudio context for the live preview chain. Gain and fades are
// applied to the playing render in real time, so dragging a slider is audible
// immediately instead of waiting for an ffmpeg re-render.
let liveCtx: AudioContext | null = null;
function audioCtx(): AudioContext {
  liveCtx ??= new AudioContext();
  return liveCtx;
}
const dbToLinear = (db: number) => Math.pow(10, db / 20);

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
  onFetchOriginal,
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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Key the rendered audio was produced for; re-render when trim/gain change.
  const renderedKey = useRef<string>("");
  // The card's preview plays a RENDERED file (mix included), not the wave -
  // this loop walks the waveform's playhead along with it. The mix's t=0 is
  // the trim start on the source timeline.
  const waveSeek = useRef<((t: number) => void) | null>(null);
  const trimStartRef = useRef(song.trimStart);
  trimStartRef.current = song.trimStart;
  const startOffsetRef = useRef(0);
  const syncRaf = useRef<number | null>(null);
  function startPlayheadSync() {
    if (syncRaf.current != null) cancelAnimationFrame(syncRaf.current);
    const tick = () => {
      const a = audioRef.current;
      if (!a || a.paused) {
        syncRaf.current = null;
        return;
      }
      applyLiveFx(a);
      // Bite time -> your source time (your clip starts at the start delay).
      waveSeek.current?.(trimStartRef.current + Math.max(0, a.currentTime - startOffsetRef.current));
      syncRaf.current = requestAnimationFrame(tick);
    };
    syncRaf.current = requestAnimationFrame(tick);
  }
  useEffect(
    () => () => {
      if (syncRaf.current != null) cancelAnimationFrame(syncRaf.current);
    },
    [],
  );

  const url = convertFileSrc(song.sourceMp3);
  const length = Math.max(0, song.trimEnd - song.trimStart);
  // Layers with a file picked - what the preview mixes and the compile ships.
  const activeLayers = (song.layers ?? []).filter((l) => l.sourceAudio);
  // Which lanes have their effect strip open.
  const [openLanes, setOpenLanes] = useState<Record<string, boolean>>({});
  const hasLanes = (song.layers ?? []).length > 0;
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

  const clipLen = Math.max(0.1, length);
  /** A layer's effective clip window (end falls back to its file's length). */
  function layerWin(l: SongLayer): { ts: number; te: number; dur: number } {
    const dur = layerDurs[l.id] ?? 0;
    const ts = Math.max(0, l.trimStart ?? 0);
    const rawTe = l.trimEnd ?? 0;
    const te = rawTe > ts ? rawTe : dur > 0 ? dur : Math.min(clipLen, ts + clipLen);
    return { ts, te: Math.max(ts + 0.05, te), dur };
  }

  const spec = renderSpecOf(song);
  const layersKey = JSON.stringify(spec.layers);
  // The preview render bakes everything EXCEPT the song's effects: those run
  // live through WebAudio (lib/liveFx) so a slider drag is audible at once.
  // Two are toggles the live chain can't do and stay baked: Reverse and
  // Match loudness (a toggle flips them with one quick re-render).
  const bakedFx =
    song.fx && (song.fx.reverse || song.fx.loudness != null)
      ? {
          ...(song.fx.reverse ? { reverse: true } : {}),
          ...(song.fx.loudness != null
            ? { loudness: song.fx.loudness, loudnessMethod: song.fx.loudnessMethod }
            : {}),
        }
      : null;
  const previewSpec = { ...spec, fx: bakedFx };
  const specKey = `${spec.biteMode}:${spec.biteSeconds}:${spec.startOffset}:${JSON.stringify(bakedFx)}`;
  // Fades are always applied live (they run post-mix in the compile too), and
  // the master gain is live when there are no layers. With layers, the master
  // gain scales only the base lane pre-mix, so it stays baked into the render
  // (a post-mix live gain would wrongly scale the layers with it).
  const liveGain = activeLayers.length === 0;
  const paramKey = `${song.sourceMp3}|${song.trimStart}|${song.trimEnd}|${liveGain ? "live" : song.gainDb}|${layersKey}|${specKey}`;
  // The finished bite's length (what the bite-wide fades run on): the base
  // clip, the last layer's end, or the custom length.
  const bo = spec.startOffset;
  startOffsetRef.current = bo;
  const biteLen = (() => {
    if (spec.biteMode === "custom" && spec.biteSeconds > 0) return spec.biteSeconds;
    if (spec.biteMode === "longest") {
      return activeLayers
        .filter((l) => !l.muted)
        .reduce((m, l) => {
          const { ts, te } = layerWin(l);
          return Math.max(m, Math.max(0, l.offset ?? 0) + (te - ts));
        }, bo + length);
    }
    return bo + length;
  })();
  // ---- Shared timeline ----
  // Every row (the original for comparison, your waveform, the lanes) is
  // drawn on ONE axis measured in your source file's seconds, so the trim
  // region and the lanes line up by construction. Bite time t sits at source
  // time trimStart + t - startOffset (your clip starts at bite time
  // `startOffset`). The axis runs from tlMin (0, or further left when the
  // bite or a layer starts before your source's t=0) to tlMax.
  const toSrc = (t: number) => song.trimStart + t - bo;
  const baseDur = mineDur ?? Math.max(song.trimEnd, 0.1);
  const laneSpans = activeLayers.map((l) => {
    const { ts, te } = layerWin(l);
    const from = toSrc(Math.max(0, l.offset ?? 0));
    return { from, to: from + (te - ts) };
  });
  const tlMin = Math.min(0, toSrc(0), ...laneSpans.map((x) => x.from));
  const tlMax = Math.max(
    baseDur,
    toSrc(biteLen),
    compareOpen && stockDur ? toSrc(stockDur) : 0,
    ...laneSpans.map((x) => x.to),
  );
  const tlSpan = Math.max(0.1, tlMax - tlMin);
  /** Source-time position -> % of the shared axis. */
  const pctAt = (src: number) => ((src - tlMin) / tlSpan) * 100;

  // The live chain (element → master gain → effects → fade gain → limiter →
  // meter → speakers) and the values it applies each frame. Slider drags land
  // here without touching the render; the order mirrors the ffmpeg render
  // (base volume before the mix, effects on the finished bite, then fades).
  const gainNode = useRef<GainNode | null>(null); // master (pre-effects)
  const fadeNode = useRef<GainNode | null>(null); // fades (post-effects)
  const fxChain = useRef<LiveFxChain | null>(null);
  const limiterNode = useRef<DynamicsCompressorNode | null>(null);
  const srcNode = useRef<MediaElementAudioSourceNode | null>(null);
  const liveFx = useRef({ gainDb: 0, liveGain: true, fadeIn: 0, fadeOut: 0, length: 0 });
  liveFx.current = {
    gainDb: song.gainDb,
    liveGain,
    fadeIn: song.fadeIn,
    fadeOut: song.fadeOut,
    length: biteLen,
  };
  // Level meter: peak of the last frame (0..1) + a sticky clip flag, read off
  // an analyser at the end of the live chain while the preview plays.
  const analyser = useRef<AnalyserNode | null>(null);
  const [meter, setMeter] = useState(0);
  const [clipped, setClipped] = useState(false);
  const meterBuf = useRef<Float32Array | null>(null);

  /** The fade envelope at clip time `t` - the same linear ramps ffmpeg's
   *  afade bakes at compile. */
  function liveEnv(t: number): number {
    const p = liveFx.current;
    let env = 1;
    const fi = Math.min(p.fadeIn, p.length);
    if (fi > 0 && t < fi) env *= Math.max(0, t / fi);
    const fo = Math.min(p.fadeOut, p.length);
    if (fo > 0 && t > p.length - fo) env *= Math.max(0, (p.length - t) / fo);
    return env;
  }
  /** The master gain the chain sits at (live only without layers). */
  function liveMaster(): number {
    const p = liveFx.current;
    return p.liveGain ? dbToLinear(p.gainDb) : 1;
  }

  function applyLiveFx(a: HTMLAudioElement) {
    const g = gainNode.current;
    const f = fadeNode.current;
    if (!g || !f) return;
    // A short ramp keeps slider drags click-free but still instant to the ear.
    const now = audioCtx().currentTime;
    g.gain.setTargetAtTime(liveMaster(), now, 0.03);
    f.gain.setTargetAtTime(liveEnv(a.currentTime), now, 0.03);
    const an = analyser.current;
    if (an) {
      const buf = (meterBuf.current ??= new Float32Array(an.fftSize));
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      setMeter(peak);
      if (peak >= 0.99) setClipped(true);
    }
  }

  function dropLiveChain() {
    srcNode.current?.disconnect();
    gainNode.current?.disconnect();
    fxChain.current?.dispose();
    fadeNode.current?.disconnect();
    limiterNode.current?.disconnect();
    analyser.current?.disconnect();
    srcNode.current = null;
    gainNode.current = null;
    fxChain.current = null;
    fadeNode.current = null;
    limiterNode.current = null;
    analyser.current = null;
    setMeter(0);
  }

  /** (Re)wire fade -> [limiter] -> meter: the limiter is a toggle. */
  function wireTail(ctx: AudioContext, withLimiter: boolean) {
    const f = fadeNode.current;
    const an = analyser.current;
    if (!f || !an) return;
    f.disconnect();
    limiterNode.current?.disconnect();
    limiterNode.current = null;
    if (withLimiter) {
      const lim = createLimiter(ctx);
      f.connect(lim);
      lim.connect(an);
      limiterNode.current = lim;
    } else {
      f.connect(an);
    }
  }

  // Effects edits while the preview chain is up: same structure -> re-tune
  // the nodes in place; a different set/kind/preset -> swap the chain. Pitch
  // rides the element's playback rate. Nothing here re-renders.
  useEffect(() => {
    const g = gainNode.current;
    const f = fadeNode.current;
    if (!g || !f) return;
    const ctx = audioCtx();
    const key = liveFxKey(song.fx);
    if (!fxChain.current || fxChain.current.key !== key) {
      const old = fxChain.current;
      g.disconnect();
      old?.dispose();
      const next = createLiveFxChain(ctx, song.fx);
      g.connect(next.input);
      next.output.connect(f);
      fxChain.current = next;
    } else {
      fxChain.current.update(song.fx);
    }
    wireTail(ctx, !!song.fx?.limiter);
    if (audioRef.current) applyLivePitch(audioRef.current, song.fx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.fx]);

  // Keep the rename draft in sync if soundName changes elsewhere.
  useEffect(() => setNameDraft(song.soundName), [song.soundName]);

  // Detached Audio objects outlive the component — stop playback on unmount
  // (tab switch, song removal).
  useEffect(
    () => () => {
      audioRef.current?.pause();
      dropLiveChain();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Invalidate cached playback when the trim / layers / effects change. Gain
  // and fades apply live and don't re-render. If it was playing, re-render
  // after the edits settle and pick up where it was - dragging an effect
  // slider keeps the sound going instead of stopping it dead.
  const resumeAt = useRef<number | null>(null);
  const resumeTimer = useRef<number | null>(null);
  useEffect(() => {
    if (renderedKey.current && renderedKey.current !== paramKey) {
      const a = audioRef.current;
      const wasPlaying = !!a && !a.paused;
      if (wasPlaying) resumeAt.current = a!.currentTime;
      a?.pause();
      audioRef.current = null;
      dropLiveChain();
      renderedKey.current = "";
      setState("idle");
      if (wasPlaying) {
        if (resumeTimer.current != null) window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => {
          resumeTimer.current = null;
          void playPause();
        }, 350);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      startPlayheadSync();
      setState("playing");
      return;
    }
    // idle → render (if needed) then play
    setState("loading");
    try {
      // Gain and fades stay OUT of the preview render - the live chain below
      // applies them during playback (compile still bakes everything).
      const outPath = await processAudio({
        sourcePath: song.sourceMp3,
        trimStart: song.trimStart,
        trimEnd: song.trimEnd,
        gainDb: liveGain ? 0 : song.gainDb,
        fadeIn: 0,
        fadeOut: 0,
        ...previewSpec,
        ffmpegPath,
      });
      const audio = new Audio();
      // The asset protocol sends CORS headers (the waveforms fetch it) - and
      // WebAudio needs a non-opaque stream to process it.
      audio.crossOrigin = "anonymous";
      audio.src = convertFileSrc(outPath);
      // Loop tracks preview looped, so the seam is audible before compiling.
      audio.loop = song.looping;
      audioRef.current = audio;
      renderedKey.current = paramKey;
      try {
        const ctx = audioCtx();
        dropLiveChain();
        const src = ctx.createMediaElementSource(audio);
        const g = ctx.createGain();
        const f = ctx.createGain();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        const chain = createLiveFxChain(ctx, song.fx);
        src.connect(g);
        g.connect(chain.input);
        chain.output.connect(f);
        an.connect(ctx.destination);
        srcNode.current = src;
        gainNode.current = g;
        fadeNode.current = f;
        fxChain.current = chain;
        analyser.current = an;
        wireTail(ctx, !!song.fx?.limiter);
        g.gain.value = liveMaster();
        f.gain.value = liveEnv(0);
        applyLivePitch(audio, song.fx);
        void ctx.resume();
      } catch {
        // No WebAudio: plain playback still works, edits just aren't live.
        dropLiveChain();
      }
      // Picking up after an edit-triggered re-render.
      if (resumeAt.current != null) {
        const t = resumeAt.current;
        resumeAt.current = null;
        if (Number.isFinite(t) && t > 0) audio.currentTime = Math.min(t, Math.max(0, biteLen - 0.05));
      }
      audio.onended = () => {
        setState("idle");
        // Park the playhead back at the clip start.
        waveSeek.current?.(trimStartRef.current);
      };
      audio.onpause = () => {
        // only reflect external pauses; our explicit pause already set state
      };
      audio.onerror = () => {
        setError("playback failed");
        setState("idle");
      };
      await audio.play();
      startPlayheadSync();
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
    waveSeek.current?.(trimStartRef.current);
    setState("idle");
  }

  const playIcon = state === "loading" ? "…" : state === "playing" ? "⏸" : state === "paused" ? "▶" : "▶";

  // Compact one-liner for the collapsed row: just length + gain + loop —
  // fades are editing detail, visible in the expanded view.
  const summary = [
    fmtTime(biteLen),
    song.gainDb !== 0 ? `${song.gainDb > 0 ? "+" : ""}${song.gainDb}dB` : null,
    song.looping ? "loop" : null,
    activeLayers.length > 0
      ? `${activeLayers.length} layer${activeLayers.length > 1 ? "s" : ""}`
      : null,
    fxSummary(song.fx),
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

  // Mix the slot's ORIGINAL game sound in as a layer (decoded once to a local
  // file, then it behaves like any dropped audio: move/trim/gain per lane).
  const [origBusy, setOrigBusy] = useState(false);
  async function addOriginalLayer() {
    if (!onFetchOriginal || origBusy) return;
    setOrigBusy(true);
    try {
      const path = await onFetchOriginal();
      // The game's own clip rides under yours: full length, a touch quieter,
      // with a short tail so it never ends on a hard cut when the bite does.
      onChange({
        layers: [
          ...(song.layers ?? []),
          {
            id: crypto.randomUUID(),
            sourceAudio: path,
            gainDb: -4,
            offset: 0,
            trimStart: 0,
            trimEnd: 0,
            fadeOut: 0.15,
            label: "Original",
            original: true,
          },
        ],
      });
    } catch (e) {
      setError(`Couldn't decode the original: ${e}`);
    } finally {
      setOrigBusy(false);
    }
  }

  function updateLayer(id: string, patch: Partial<SongLayer>) {
    edit({
      layers: (song.layers ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
  }

  function removeLayer(id: string) {
    edit({ layers: (song.layers ?? []).filter((l) => l.id !== id) });
  }

  // One drag at a time: move the block, or trim either edge. Values write
  // straight into the layer via onChange; `orig` keeps the drag anchored.
  // `moved` distinguishes a real drag from a plain click (click = play mix).
  const drag = useRef<{
    id: string;
    mode: "move" | "l" | "r";
    startX: number;
    pxPerSec: number;
    moved: boolean;
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
      pxPerSec: w / tlSpan,
      moved: false,
      orig: { offset: Math.max(0, l.offset ?? 0), ts, te, dur },
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    // A couple px of jitter is a click, not a drag - don't nudge the layer.
    if (!d.moved && Math.abs(e.clientX - d.startX) <= 3) return;
    d.moved = true;
    const dsec = (e.clientX - d.startX) / d.pxPerSec;
    const { offset, ts, te, dur } = d.orig;
    if (d.mode === "move") {
      updateLayer(d.id, {
        offset: snap(Math.min(Math.max(0, offset + dsec), Math.max(0, Math.max(clipLen + bo, biteLen) - 0.05))),
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
    const d = drag.current;
    drag.current = null;
    // Plain click on a layer: hear the whole thing - base + every layer,
    // exactly what compiles.
    if (d && !d.moved && d.mode === "move") void playPause();
  }

  // ---- Undo (Ctrl+Z inside the card) ----
  // A ring of the song's editable state before each local change. External
  // changes (paste, compile stamps) aren't recorded - only what this card did.
  const history = useRef<Partial<Song>[]>([]);
  const EDIT_KEYS: (keyof Song)[] = ["trimStart", "trimEnd", "gainDb", "fadeIn", "fadeOut", "looping", "layers", "biteMode", "biteSeconds", "fx", "startOffset"];
  function snapshot(): Partial<Song> {
    const out: Partial<Song> = {};
    for (const k of EDIT_KEYS) (out as Record<string, unknown>)[k] = song[k];
    return out;
  }
  function edit(patch: Partial<Song>) {
    history.current.push(snapshot());
    if (history.current.length > 40) history.current.shift();
    onChange(patch);
  }
  function undo() {
    const prev = history.current.pop();
    if (prev) onChange(prev);
  }
  /** The trim edge the last drag / key touched (arrow keys nudge it). */
  const [activeEdge, setActiveEdge] = useState<"start" | "end">("end");
  function nudge(edge: "start" | "end", delta: number) {
    const max = mineDur ?? Math.max(song.trimEnd, 1);
    if (edge === "start") {
      edit({ trimStart: snap(Math.min(Math.max(0, song.trimStart + delta), song.trimEnd - 0.01)) });
    } else {
      edit({ trimEnd: snap(Math.max(song.trimStart + 0.01, Math.min(max, song.trimEnd + delta))) });
    }
  }
  function onKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === " ") {
      e.preventDefault();
      void playPause();
    } else if (e.key === "[") {
      e.preventDefault();
      edit({ trimStart: snap(Math.min(mineTime, song.trimEnd - 0.01)) });
      setActiveEdge("start");
    } else if (e.key === "]") {
      e.preventDefault();
      edit({ trimEnd: snap(Math.max(mineTime, song.trimStart + 0.01)) });
      setActiveEdge("end");
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : e.ctrlKey ? 1 : 0.01;
      nudge(activeEdge, e.key === "ArrowLeft" ? -step : step);
    } else if (e.key === "Home") {
      e.preventDefault();
      waveSeek.current?.(song.trimStart);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  }

  function setBite(mode: BiteMode, seconds?: number) {
    edit({ biteMode: mode, biteSeconds: seconds ?? song.biteSeconds ?? snap(biteLen) });
  }

  // "Match the original": trim the clip to the stock clip's length, or target
  // its loudness (the FX strip's Match-loudness chip measures it).
  function matchOriginalLength() {
    if (stockDur == null) return;
    const max = mineDur ?? Infinity;
    edit({ trimEnd: snap(Math.min(max, song.trimStart + stockDur)) });
  }
  async function measureOriginal(): Promise<{ value: number; method: "lufs" | "rms" }> {
    if (!onFetchOriginal) throw new Error("no original");
    const path = await onFetchOriginal();
    const m = await measureLoudness(path, ffmpegPath);
    return m.lufs != null ? { value: m.lufs, method: "lufs" } : { value: m.rms, method: "rms" };
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
            <div
              ref={bodyRef}
              tabIndex={0}
              onKeyDown={onKey}
              className="rounded-b-lg px-3.5 pb-3.5 outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
            >
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
                          <span className="flex items-center gap-2 text-[10px] tabular-nums text-zinc-600">
                            {stockTime > 0 && (
                              <span className="text-amber-300/80">
                                {stockTime.toFixed(1)} /{" "}
                              </span>
                            )}
                            {stockDur.toFixed(1)}s
                            {Math.abs(length - stockDur) > 0.02 && (
                              <button
                                onClick={matchOriginalLength}
                                title="Trim your clip to exactly the original's length (from your in-point)"
                                className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-300/80 transition hover:border-amber-400 hover:text-amber-200"
                              >
                                Match length
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      {stockLoading && (
                        <span className="text-xs text-zinc-600">decoding original…</span>
                      )}
                      {stockErr && <span className="text-xs text-red-400">{stockErr}</span>}
                      {stockUrl && (
                        <div className="flex items-start gap-1.5">
                          {/* Same label gutter as the lanes, so the original
                              lines up with your track and the layers. */}
                          {hasLanes && <div className="w-20 shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <div
                              style={{
                                marginLeft: `${Math.max(0, pctAt(toSrc(0)))}%`,
                                width: `${Math.min(100, ((stockDur ?? 0) / tlSpan) * 100) || 100}%`,
                              }}
                            >
                              <StockWaveform
                                url={stockUrl}
                                accent={accent}
                                widthPct={100}
                                onDuration={setStockDur}
                                onTime={setStockTime}
                                timeline
                              />
                            </div>
                          </div>
                        </div>
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
                  <div className="flex items-stretch gap-1.5">
                    {hasLanes && (
                      <div className="flex w-20 shrink-0 flex-col justify-center gap-0.5 pl-1">
                        <span className="truncate text-[10px] font-semibold" style={{ color: accent }}>
                          Yours
                        </span>
                        <label
                          className="flex items-center gap-1 text-[9px] tabular-nums text-zinc-600"
                          title="When YOUR track starts within the bite: seconds of silence before it, so it can come in after the original (layers keep their own positions)"
                        >
                          <span>at</span>
                          <NumField
                            value={bo}
                            min={0}
                            max={120}
                            width="w-11"
                            onCommit={(v) => edit({ startOffset: v > 0 ? v : undefined })}
                          />
                        </label>
                      </div>
                    )}
                  <div className="min-w-0 flex-1">
                  <div style={{ marginLeft: `${Math.max(0, pctAt(0))}%`, width: `${Math.min(100, (baseDur / tlSpan) * 100)}%` }}>
                  <Waveform
                    url={url}
                    trimStart={song.trimStart}
                    trimEnd={song.trimEnd}
                    onTrimChange={(start, end) => {
                      if (Math.abs(start - song.trimStart) > 1e-6) setActiveEdge("start");
                      else if (Math.abs(end - song.trimEnd) > 1e-6) setActiveEdge("end");
                      edit({ trimStart: start, trimEnd: end });
                    }}
                    onDuration={setMineDur}
                    onTime={setMineTime}
                    timeline
                    onRegionPlay={
                      activeLayers.length > 0
                        ? () => {
                            void playPause();
                            return true;
                          }
                        : undefined
                    }
                    seekRef={waveSeek}
                  />
                  </div>
                  </div>
                  </div>
                  {/* Layer lanes: stacked under the waveform on the same time
                      scale, editor-style. Drag a wave to place it, edges to
                      trim; each bakes into this one track at compile. */}
                  {(song.layers ?? []).length > 0 && (
                    <div>
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
                        const start = toSrc(off);
                        const regionLeft = Math.min(100, pctAt(start));
                        const regionW = Math.max(
                          0.75,
                          Math.min(100 - regionLeft, (len / tlSpan) * 100),
                        );
                        const waveLeft = pctAt(start - ts);
                        const waveW = ((srcDur || len) / tlSpan) * 100;
                        const isOrig = !!l.original;
                        const tint = isOrig ? "#fbbf24" : "#38bdf8";
                        const laneOpen = !!openLanes[l.id];
                        const name = l.label || (isOrig ? "Original" : (l.sourceAudio.split(/[\\/]/).pop() ?? ""));
                        // Where the bite ends on this lane's timeline: content
                        // past it is cut (shown hatched) unless the bite mode
                        // lets the layer ring out.
                        const biteEndPct = Math.min(100, pctAt(toSrc(biteLen)));
                        const cutPct = Math.max(0, Math.min(100, regionLeft + regionW) - biteEndPct);
                        return (
                          <div key={l.id} className={`mt-1.5 ${l.muted ? "opacity-50" : ""}`}>
                            <div className="flex items-stretch gap-1.5">
                              {/* Lane label column */}
                              <div className="flex w-20 shrink-0 flex-col justify-center gap-0.5 pl-1">
                                <span
                                  className="truncate text-[10px] font-semibold"
                                  style={{ color: tint }}
                                  title={l.sourceAudio}
                                >
                                  {isOrig ? "★ " : ""}
                                  {name}
                                </span>
                                <span className="text-[9px] tabular-nums text-zinc-600">
                                  {len.toFixed(2)}s at {off.toFixed(2)}s
                                </span>
                              </div>
                              <div
                                data-lane
                                className="relative h-11 min-w-0 flex-1 overflow-hidden rounded bg-zinc-900/60"
                              >
                                {srcDur > 0 && (
                                  <div
                                    className="absolute inset-y-0"
                                    style={{ left: `${waveLeft}%`, width: `${waveW}%` }}
                                  >
                                    <LayerWave path={l.sourceAudio} color={`${tint}aa`} />
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
                                {/* Past the bite's end: this part never plays. */}
                                {cutPct > 0.5 && (
                                  <div
                                    className="pointer-events-none absolute inset-y-0"
                                    title="Past the end of the bite - cut. Set Length to 'Longest' to let it ring out."
                                    style={{
                                      left: `${biteEndPct}%`,
                                      width: `${cutPct}%`,
                                      backgroundImage:
                                        "repeating-linear-gradient(135deg, rgba(248,113,113,0.25) 0 4px, transparent 4px 9px)",
                                    }}
                                  />
                                )}
                                {/* The clip window: drag to move (the wave slides
                                    along), edges to trim (the wave stays put). */}
                                <div
                                  onPointerDown={(e) => beginDrag(e, l, "move")}
                                  onPointerMove={onDragMove}
                                  onPointerUp={endDrag}
                                  title={`starts ${off.toFixed(2)}s into the clip - drag to move, edges to trim, click to hear the mix`}
                                  className="absolute inset-y-0 flex cursor-grab touch-none items-stretch justify-between rounded-sm ring-1 ring-inset active:cursor-grabbing"
                                  style={{
                                    left: `${regionLeft}%`,
                                    width: `${regionW}%`,
                                    backgroundColor: `${tint}22`,
                                    boxShadow: `inset 0 0 0 1px ${tint}66`,
                                  }}
                                >
                                  <span
                                    onPointerDown={(e) => beginDrag(e, l, "l")}
                                    onPointerMove={onDragMove}
                                    onPointerUp={endDrag}
                                    className="w-1.5 shrink-0 cursor-ew-resize touch-none transition hover:brightness-125"
                                    style={{ backgroundColor: `${tint}99` }}
                                  />
                                  {/* Fade ramps drawn inside the window. */}
                                  {(l.fadeIn ?? 0) > 0 && (
                                    <span
                                      className="pointer-events-none absolute inset-y-0 left-0"
                                      style={{
                                        width: `${Math.min(100, ((l.fadeIn ?? 0) / len) * 100)}%`,
                                        background: `linear-gradient(to right, rgba(9,9,11,0.75), transparent)`,
                                      }}
                                    />
                                  )}
                                  {(l.fadeOut ?? 0) > 0 && (
                                    <span
                                      className="pointer-events-none absolute inset-y-0 right-0"
                                      style={{
                                        width: `${Math.min(100, ((l.fadeOut ?? 0) / len) * 100)}%`,
                                        background: `linear-gradient(to left, rgba(9,9,11,0.75), transparent)`,
                                      }}
                                    />
                                  )}
                                  <span
                                    onPointerDown={(e) => beginDrag(e, l, "r")}
                                    onPointerMove={onDragMove}
                                    onPointerUp={endDrag}
                                    className="w-1.5 shrink-0 cursor-ew-resize touch-none transition hover:brightness-125"
                                    style={{ backgroundColor: `${tint}99` }}
                                  />
                                </div>
                              </div>
                            </div>
                            {/* Lane controls: volume always; fades / duck / fx behind "more". */}
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-[5.375rem] text-[10px] text-zinc-500">
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
                                className="h-1 w-24"
                                style={{ accentColor: tint }}
                              />
                              <span className="w-10 tabular-nums">
                                {l.gainDb > 0 ? "+" : ""}
                                {l.gainDb}dB
                              </span>
                              <label className="flex items-center gap-1" title="Fade this layer in (seconds)">
                                <span>in</span>
                                <NumField
                                  value={l.fadeIn ?? 0}
                                  min={0}
                                  max={len}
                                  width="w-11"
                                  onCommit={(v) => updateLayer(l.id, { fadeIn: v })}
                                />
                              </label>
                              <label className="flex items-center gap-1" title="Fade this layer out (seconds) - how long it keeps sounding before it's gone">
                                <span>out</span>
                                <NumField
                                  value={l.fadeOut ?? 0}
                                  min={0}
                                  max={len}
                                  width="w-11"
                                  onCommit={(v) => updateLayer(l.id, { fadeOut: v })}
                                />
                              </label>
                              <label className="flex items-center gap-1" title="Duck: lower YOUR track by this much while this layer plays">
                                <span>duck</span>
                                <input
                                  type="range"
                                  min={0}
                                  max={24}
                                  step={1}
                                  value={l.duckDb ?? 0}
                                  onChange={(e) => updateLayer(l.id, { duckDb: Number(e.target.value) })}
                                  className="h-1 w-16"
                                  style={{ accentColor: tint }}
                                />
                                <span className="w-8 tabular-nums">{l.duckDb ? `-${l.duckDb}dB` : "off"}</span>
                              </label>
                              <button
                                onClick={() => updateLayer(l.id, { muted: !l.muted })}
                                title={l.muted ? "Muted - click to hear it again" : "Mute this layer (kept, just silent)"}
                                className={`rounded border px-1.5 py-0.5 transition ${
                                  l.muted
                                    ? "border-amber-500/50 text-amber-300"
                                    : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                                }`}
                              >
                                M
                              </button>
                              <button
                                onClick={() => setOpenLanes((o) => ({ ...o, [l.id]: !laneOpen }))}
                                title="Effects on this layer only"
                                style={l.fx ? { borderColor: tint, color: tint } : undefined}
                                className={`rounded border px-1.5 py-0.5 transition ${
                                  laneOpen ? "border-zinc-500 text-zinc-200" : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                                }`}
                              >
                                FX{l.fx ? " ✓" : ""}
                              </button>
                              <button
                                onClick={() => removeLayer(l.id)}
                                aria-label="Remove layer"
                                title="Remove this layer"
                                className="ml-auto rounded p-0.5 text-zinc-600 transition hover:bg-red-950/40 hover:text-red-300"
                              >
                                ✕
                              </button>
                            </div>
                            {laneOpen && (
                              <div className="pl-[5.375rem]">
                                <FxStrip
                                  fx={l.fx}
                                  onChange={(fx) => updateLayer(l.id, { fx })}
                                  accent={tint}
                                  compact
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Clip row: the trim window (type or drag), the bite length,
                  loop, and the layer buttons. */}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-600">Clip</span>
                <span className="flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-400">
                  <NumField
                    value={song.trimStart}
                    min={0}
                    max={song.trimEnd - 0.01}
                    title="Start (seconds into the file) - or press [ while playing"
                    onCommit={(v) => edit({ trimStart: v })}
                  />
                  <span className="text-zinc-600">–</span>
                  <NumField
                    value={song.trimEnd}
                    min={song.trimStart + 0.01}
                    max={mineDur ?? undefined}
                    title="End (seconds into the file) - or press ] while playing"
                    onCommit={(v) => edit({ trimEnd: v })}
                  />
                  <span className="ml-1 text-zinc-600">({fmtTime(length)})</span>
                </span>
                {activeLayers.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400" title="How long the finished sound is. Base = your clip, layers are cut to it. Longest = whoever ends last keeps going. Custom = an exact length.">
                    <span className="text-zinc-500">Length</span>
                    <select
                      value={song.biteMode ?? "base"}
                      onChange={(e) => setBite(e.target.value as BiteMode)}
                      className="rounded border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none hover:border-zinc-500"
                    >
                      <option value="base">Your clip ({fmtTime(length)})</option>
                      <option value="longest">Longest layer</option>
                      <option value="custom">Custom…</option>
                    </select>
                    {(song.biteMode ?? "base") === "custom" && (
                      <NumField
                        value={song.biteSeconds ?? biteLen}
                        min={0.05}
                        max={600}
                        title="Bite length in seconds (padded with silence or cut)"
                        onCommit={(v) => setBite("custom", v)}
                      />
                    )}
                    {(song.biteMode ?? "base") !== "base" && (
                      <span className="tabular-nums text-zinc-500">= {fmtTime(biteLen)}</span>
                    )}
                  </label>
                )}

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
                  title="Loop this track (writes loop points to encoding.txt - needed for _lp slots). The preview loops too, so you can hear the seam."
                >
                  <input
                    type="checkbox"
                    checked={song.looping}
                    onChange={(e) => edit({ looping: e.target.checked })}
                    className="accent-emerald-500"
                  />
                  Loop
                </label>
                <span className="ml-auto flex items-center gap-1.5">
                  {/* Level meter while the preview plays + sticky clip flag. */}
                  {(state === "playing" || clipped) && (
                    <span
                      className="flex h-2 w-20 overflow-hidden rounded-full bg-zinc-800"
                      title={clipped ? "Clipped - the preview hit full scale. Lower the gain or add the Limiter effect." : "Level"}
                    >
                      <span
                        className="h-full rounded-full transition-[width] duration-75"
                        style={{
                          width: `${Math.min(100, meter * 100)}%`,
                          backgroundColor: meter > 0.95 ? "#f87171" : meter > 0.7 ? "#fbbf24" : "#34d399",
                        }}
                      />
                    </span>
                  )}
                  {clipped && (
                    <button
                      onClick={() => setClipped(false)}
                      title="The preview clipped (hit full scale). Lower the gain or add the Limiter. Click to reset."
                      className="rounded border border-red-500/50 px-1.5 py-0.5 text-[10px] font-semibold text-red-300"
                    >
                      CLIP
                    </button>
                  )}
                  <button
                    onClick={() => void addLayers()}
                    title="Mix another sound on top of this one - it shows as a draggable lane under the waveform (or just drop audio on this open card)"
                    className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-sky-500/70 hover:text-sky-200"
                  >
                    + Layer
                  </button>
                  {onFetchOriginal && (
                    <button
                      onClick={() => void addOriginalLayer()}
                      disabled={origBusy}
                      title="Mix the game's original sound in as a layer - your track and the stock one play together"
                      className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition hover:border-amber-500/70 hover:text-amber-200 disabled:opacity-50"
                    >
                      {origBusy ? "Adding…" : "★ + Original"}
                    </button>
                  )}
                </span>
              </div>
              {/* Levels row: sliders in an even grid - no ragged wrap. */}
              <div className="mt-2 grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-3">
                <label className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="whitespace-nowrap text-zinc-500">Gain</span>
                  <input
                    type="range"
                    min={-12}
                    max={24}
                    step={0.5}
                    value={song.gainDb}
                    onChange={(e) => edit({ gainDb: Number(e.target.value) })}
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
                    max={Math.max(1, Math.round(biteLen))}
                    step={0.1}
                    value={song.fadeIn}
                    onChange={(e) => edit({ fadeIn: Number(e.target.value) })}
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
                    max={Math.max(1, Math.round(biteLen))}
                    step={0.1}
                    value={song.fadeOut}
                    onChange={(e) => edit({ fadeOut: Number(e.target.value) })}
                    className="min-w-[70px] flex-1 accent-emerald-500"
                  />
                  <span className="w-12 text-right tabular-nums text-zinc-300">
                    {song.fadeOut.toFixed(1)}s
                  </span>
                </label>
              </div>
              {/* Effects on the whole track. */}
              <FxStrip
                fx={song.fx}
                onChange={(fx) => edit({ fx })}
                accent={accent}
                onMeasureOriginal={onFetchOriginal ? measureOriginal : undefined}
              />
              <p className="mt-2 text-[10px] text-zinc-600">
                Effects, gain and fades change live while playing (pitch previews tape-style; the compiled sound keeps its length). Space play/pause · [ ] set start/end at the playhead · ← → nudge (Shift = 0.1s, Ctrl = 1s) · Ctrl+Z undo
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && <p className="px-3.5 pb-2.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}
