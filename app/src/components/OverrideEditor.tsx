import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { SoundOverride } from "../types";

/**
 * Compact editor for one loose-file sound override: swap the source file, preview
 * it, and tweak gain / fades / loop / trim before it compiles. Deliberately
 * lighter than the music SidePanel — most game sounds are short SFX/VO.
 */
export function OverrideEditor({
  override,
  onChange,
  onPickFile,
}: {
  override: SoundOverride;
  onChange: (patch: Partial<SoundOverride>) => void;
  onPickFile: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const fileName = override.sourceAudio.split(/[\\/]/).pop() ?? override.sourceAudio;

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.currentTime = override.trimStart || 0;
      void a.play();
      setPlaying(true);
    }
  }

  const num = (v: number) => (Number.isFinite(v) ? v : 0);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <audio
        ref={audioRef}
        src={convertFileSrc(override.sourceAudio)}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />

      {/* Source file row */}
      <div className="flex items-center gap-2">
        <button
          onClick={togglePlay}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          {playing ? "▮▮" : "▶"}
        </button>
        <span className="min-w-0 flex-1 truncate text-zinc-300" title={override.sourceAudio}>
          {fileName}
        </span>
        <button
          onClick={onPickFile}
          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          Change file…
        </button>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Field label="Trim start (s)">
          <input
            type="number"
            min={0}
            step={0.1}
            value={num(override.trimStart)}
            onChange={(e) => onChange({ trimStart: Math.max(0, parseFloat(e.target.value) || 0) })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
          />
        </Field>
        <Field label="Trim end (s)">
          <input
            type="number"
            min={0}
            step={0.1}
            value={num(override.trimEnd)}
            onChange={(e) => onChange({ trimEnd: Math.max(0, parseFloat(e.target.value) || 0) })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
          />
        </Field>
        <Field label="Gain (dB)">
          <input
            type="number"
            step={1}
            value={num(override.gainDb)}
            onChange={(e) => onChange({ gainDb: parseFloat(e.target.value) || 0 })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
          />
        </Field>
        <Field label="Loop">
          <label className="flex h-[30px] items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={override.looping}
              onChange={(e) => onChange({ looping: e.target.checked })}
              className="h-4 w-4 accent-emerald-500"
            />
            loop in-game
          </label>
        </Field>
        <Field label="Fade in (s)">
          <input
            type="number"
            min={0}
            step={0.1}
            value={num(override.fadeIn)}
            onChange={(e) => onChange({ fadeIn: Math.max(0, parseFloat(e.target.value) || 0) })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
          />
        </Field>
        <Field label="Fade out (s)">
          <input
            type="number"
            min={0}
            step={0.1}
            value={num(override.fadeOut)}
            onChange={(e) => onChange({ fadeOut: Math.max(0, parseFloat(e.target.value) || 0) })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-200 outline-none focus:border-zinc-500"
          />
        </Field>
      </div>
      <p className="text-[11px] text-zinc-600">
        Trim 0 → 0 uses the whole file. This replaces the game's file directly — no
        soundevent is changed, so it works even for sounds with no editable event.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
