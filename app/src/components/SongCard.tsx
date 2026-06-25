import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { processAudio } from "../lib/api";
import type { Song } from "../types";
import { Waveform } from "./Waveform";

interface SongCardProps {
  song: Song;
  soundFolder: string;
  ffmpegPath?: string;
  onChange: (patch: Partial<Song>) => void;
  onRename: (raw: string) => void;
  onRemove: () => void;
}

function fmtTime(s: number): string {
  return `${s.toFixed(2)}s`;
}

type PlayState = "idle" | "loading" | "playing" | "paused";

export function SongCard({
  song,
  soundFolder,
  ffmpegPath,
  onChange,
  onRename,
  onRemove,
}: SongCardProps) {
  const [state, setState] = useState<PlayState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(song.soundName);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Key the rendered audio was produced for; re-render when trim/gain change.
  const renderedKey = useRef<string>("");

  const url = convertFileSrc(song.sourceMp3);
  const length = Math.max(0, song.trimEnd - song.trimStart);
  const paramKey = `${song.sourceMp3}|${song.trimStart}|${song.trimEnd}|${song.gainDb}|${song.fadeOut}`;

  // Keep the rename draft in sync if soundName changes elsewhere.
  useEffect(() => setNameDraft(song.soundName), [song.soundName]);

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
        fadeOut: song.fadeOut,
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

  const playLabel =
    state === "playing" ? "⏸ Pause" : state === "paused" ? "▶ Resume" : state === "loading" ? "…" : "▶ Preview";

  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-3.5 shadow-sm transition hover:border-zinc-600">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
        <input
          value={song.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-zinc-100 outline-none transition hover:border-zinc-700 focus:border-zinc-500"
          placeholder="Track name"
        />
        <span className="shrink-0 rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
          {song.lastCompiledHash ? "Compiled" : "New"}
        </span>
        <button
          onClick={onRemove}
          aria-label="Remove track"
          className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
        >
          ✕
        </button>
      </div>

      {/* Filename (drives the .vsnd / .vsnd_c / soundevent reference) */}
      <div className="mb-2.5 flex items-center gap-1 pl-4 font-mono text-[11px] text-zinc-500">
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

      <Waveform
        url={url}
        trimStart={song.trimStart}
        trimEnd={song.trimEnd}
        onTrimChange={(start, end) => onChange({ trimStart: start, trimEnd: end })}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="rounded bg-zinc-800/80 px-2 py-1 text-[11px] tabular-nums text-zinc-400">
          {fmtTime(song.trimStart)}–{fmtTime(song.trimEnd)}
          <span className="ml-1 text-zinc-600">({fmtTime(length)})</span>
        </span>

        <label className="flex flex-1 items-center gap-2 text-xs text-zinc-400">
          <span className="whitespace-nowrap text-zinc-500">Gain</span>
          <input
            type="range"
            min={-12}
            max={24}
            step={0.5}
            value={song.gainDb}
            onChange={(e) => onChange({ gainDb: Number(e.target.value) })}
            className="min-w-[80px] flex-1 accent-emerald-500"
          />
          <span className="w-12 text-right tabular-nums text-zinc-300">
            {song.gainDb > 0 ? "+" : ""}
            {song.gainDb}
          </span>
        </label>

        <label className="flex flex-1 items-center gap-2 text-xs text-zinc-400">
          <span className="whitespace-nowrap text-zinc-500">Fade&nbsp;out</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(length))}
            step={0.1}
            value={song.fadeOut}
            onChange={(e) => onChange({ fadeOut: Number(e.target.value) })}
            className="min-w-[80px] flex-1 accent-emerald-500"
          />
          <span className="w-12 text-right tabular-nums text-zinc-300">
            {song.fadeOut.toFixed(1)}s
          </span>
        </label>

        <div className="flex items-center gap-1.5">
          <button
            onClick={playPause}
            disabled={state === "loading"}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {playLabel}
          </button>
          {(state === "playing" || state === "paused") && (
            <button
              onClick={stop}
              aria-label="Stop"
              className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 transition hover:text-zinc-200"
            >
              ■
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
