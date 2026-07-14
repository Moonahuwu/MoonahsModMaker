import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEscape } from "../lib/useEscape";

/** One decoded sound from the downloaded pack, playable from disk. */
export interface PickClip {
  /** Decoded audio file on disk (what gets added as a track). */
  path: string;
  /** Display name (original stem, decode prefix stripped). */
  name: string;
  /** The vpk-internal ref it came from (`sounds/x.vsnd`). */
  ref: string;
}

/** A destination bucket: checked clips are added to `targetSlotId`. */
export interface PickGroup {
  key: string;
  label: string;
  accent: string;
  targetSlotId: string;
  note?: string;
  clips: PickClip[];
  /** Start checked (the group matching the slot the search came from). */
  defaultOn: boolean;
}

/** GameBanana slot mode hit a pack that changes more than the chosen slot:
 *  let the user pick which sounds land where, or hand the whole vpk to the
 *  normal import review so nothing is lost. */
export function SlotSoundPicker({
  modName,
  slotLabel,
  groups,
  truncated,
  onAdd,
  onWholeMod,
  onCancel,
}: {
  modName: string;
  slotLabel: string;
  groups: PickGroup[];
  /** The decode cap was hit - the pack holds more sounds than shown. */
  truncated: boolean;
  onAdd: (picks: { slotId: string; path: string }[]) => void;
  onWholeMod: () => void;
  onCancel: () => void;
}) {
  useEscape(onCancel);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(groups.filter((g) => g.defaultOn).flatMap((g) => g.clips.map((c) => c.path))),
  );

  // One preview at a time; stop on unmount.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);
  function togglePlay(path: string) {
    audioRef.current?.pause();
    if (playing === path) {
      setPlaying(null);
      return;
    }
    const a = new Audio(convertFileSrc(path));
    a.onended = () => setPlaying((p) => (p === path ? null : p));
    audioRef.current = a;
    void a.play().catch(() => setPlaying(null));
    setPlaying(path);
  }

  const toggleClip = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleGroup = (g: PickGroup) =>
    setChecked((prev) => {
      const next = new Set(prev);
      const allOn = g.clips.every((c) => next.has(c.path));
      for (const c of g.clips) {
        if (allOn) next.delete(c.path);
        else next.add(c.path);
      }
      return next;
    });

  const picks = useMemo(
    () =>
      groups.flatMap((g) =>
        g.clips
          .filter((c) => checked.has(c.path))
          .map((c) => ({ slotId: g.targetSlotId, path: c.path })),
      ),
    [groups, checked],
  );
  const total = groups.reduce((n, g) => n + g.clips.length, 0);

  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        initial={{ scale: 0.97, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 8 }}
        transition={{ type: "spring", stiffness: 400, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-800 p-5 pb-4">
          <h3 className="text-base font-bold text-zinc-100">
            “{modName}” changes {total} sounds
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            That's more than just {slotLabel}. Pick which sounds to add - or install the
            whole mod so every file (and the author's credits) comes along.
          </p>
          {truncated && (
            <p className="mt-1 text-[11px] text-amber-400/80">
              Only the first 64 sounds could be previewed - "Install the whole mod" covers
              everything.
            </p>
          )}
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {groups.map((g) => {
            const on = g.clips.filter((c) => checked.has(c.path)).length;
            const allOn = on === g.clips.length;
            return (
              <section
                key={g.key}
                className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2"
              >
                <div className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && !allOn;
                    }}
                    onChange={() => toggleGroup(g)}
                    className="accent-emerald-500"
                  />
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: g.accent }}
                  />
                  <span className="font-semibold text-zinc-200">{g.label}</span>
                  <span className="ml-auto text-zinc-600">
                    {on}/{g.clips.length}
                  </span>
                </div>
                {g.note && (
                  <p className="mt-1 pl-6 text-[11px] leading-relaxed text-zinc-500">{g.note}</p>
                )}
                <ul className="mt-2 space-y-1">
                  {g.clips.map((c) => (
                    <li key={c.path} className="flex items-center gap-2 pl-6 text-xs">
                      <input
                        type="checkbox"
                        checked={checked.has(c.path)}
                        onChange={() => toggleClip(c.path)}
                        className="accent-emerald-500"
                      />
                      <button
                        onClick={() => togglePlay(c.path)}
                        title={playing === c.path ? "Stop" : "Play"}
                        className="w-5 shrink-0 rounded text-zinc-500 transition hover:text-zinc-200"
                      >
                        {playing === c.path ? "■" : "▶"}
                      </button>
                      <span className="truncate text-zinc-300">{c.name}</span>
                      <span className="ml-auto truncate pl-2 text-[10px] text-zinc-600" title={c.ref}>
                        {c.ref}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <footer className="flex items-center gap-2 border-t border-zinc-800 p-4">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={onWholeMod}
            title="Opens the normal import review: keeps every file the mod ships and the author's credits"
            className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          >
            Install the whole mod…
          </button>
          <button
            onClick={() => onAdd(picks)}
            disabled={picks.length === 0}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
          >
            Add {picks.length > 0 ? picks.length : ""} selected
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
