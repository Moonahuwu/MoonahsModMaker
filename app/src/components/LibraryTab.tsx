import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { libraryAdd, libraryRemove, probeAudio } from "../lib/api";
import { copySound, useCopiedSound } from "../lib/soundClipboard";
import type { Settings } from "../lib/settings";
import type { LibraryItem } from "../types";
import { useToast } from "./Toaster";

const AUDIO_FILTERS = [
  { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
];

/** Matches the default gain new tracks get when added to a slot. */
const DEFAULT_GAIN_DB = 6;

/**
 * The sound library: a personal shelf of audio files (copied into app-data so
 * originals can move or vanish). Drop sounds in, preview them, and Copy puts
 * one on the sound clipboard - paste it into any slot from there.
 */
export function LibraryTab({
  settings,
  update,
  ffmpegPath,
  dropRef,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  ffmpegPath?: string;
  /** The window drop handler calls this with audio paths dropped on this tab. */
  dropRef?: React.MutableRefObject<((paths: string[]) => void) | null>;
}) {
  const { push } = useToast();
  const items = settings.soundLibrary ?? [];
  const [adding, setAdding] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const copied = useCopiedSound();

  // Stop playback when the tab unmounts.
  useEffect(() => () => audioRef.current?.pause(), []);

  // Register for window-level audio drops while this tab is open.
  useEffect(() => {
    if (!dropRef) return;
    dropRef.current = (paths) => void addFiles(paths);
    return () => {
      dropRef.current = null;
    };
  });

  async function addFiles(paths?: string[]) {
    let files = paths;
    if (!files) {
      const sel = await open({
        multiple: true,
        title: "Add which sound(s) to the library?",
        filters: AUDIO_FILTERS,
      });
      if (!sel) return;
      files = Array.isArray(sel) ? sel : [sel];
    }
    setAdding(true);
    try {
      const added: LibraryItem[] = [];
      for (const f of files) {
        try {
          const copy = await libraryAdd(f);
          added.push({
            id: crypto.randomUUID(),
            name: copy.name,
            path: copy.path,
            source: "dropped in",
            addedAt: new Date().toISOString(),
          });
        } catch (e) {
          push("error", `${f.split(/[\\/]/).pop()}: ${e}`);
        }
      }
      if (added.length > 0) {
        update({ soundLibrary: [...(settings.soundLibrary ?? []), ...added] });
        push("success", `Added ${added.length} sound${added.length > 1 ? "s" : ""} to the library`);
      }
    } finally {
      setAdding(false);
    }
  }

  function rename(id: string, name: string) {
    update({
      soundLibrary: items.map((i) => (i.id === id ? { ...i, name } : i)),
    });
  }

  async function remove(item: LibraryItem) {
    audioRef.current?.pause();
    setPlaying(null);
    try {
      await libraryRemove(item.path);
    } catch {
      // The copy may already be gone - drop the row regardless.
    }
    update({ soundLibrary: items.filter((i) => i.id !== item.id) });
  }

  function playPause(item: LibraryItem) {
    if (playing === item.id) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(convertFileSrc(item.path));
    audioRef.current = audio;
    audio.onended = () => setPlaying((p) => (p === item.id ? null : p));
    audio.onerror = () => {
      push("error", "Playback failed (the library copy may be missing)");
      setPlaying((p) => (p === item.id ? null : p));
    };
    void audio.play();
    setPlaying(item.id);
  }

  async function copyToClipboard(item: LibraryItem) {
    try {
      const info = await probeAudio(item.path, ffmpegPath);
      copySound({
        label: item.name,
        sourceMp3: item.path,
        trimStart: 0,
        trimEnd: info.duration,
        gainDb: DEFAULT_GAIN_DB,
        fadeIn: 0,
        fadeOut: 0,
        looping: false,
      });
      push("success", `Copied "${item.name}" - paste it into any slot`);
    } catch (e) {
      push("error", `Couldn't read that file: ${e}`);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-200">
          Sound library{items.length > 0 ? ` (${items.length})` : ""}
        </h3>
        <button
          onClick={() => void addFiles()}
          disabled={adding}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add sounds…"}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Your personal shelf of sounds, kept safe in the app's own folder (originals can
        move or vanish). Drop audio files anywhere on this tab to add them. Copy puts a
        sound on the clipboard - then paste it into any track slot, or use it as a layer
        source from its file path.
      </p>
      {copied && (
        <p className="mt-1.5 text-[11px] text-emerald-400/80">
          "{copied.label}" is on the clipboard - open any slot to paste it.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-1.5">
        {items.length === 0 && (
          <span className="text-xs text-zinc-600">
            Nothing here yet - add or drop a sound to start your collection.
          </span>
        )}
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5"
            >
              <button
                onClick={() => playPause(item)}
                aria-label="Preview"
                className="shrink-0 rounded p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-emerald-300"
              >
                {playing === item.id ? "⏸" : "▶"}
              </button>
              <input
                value={item.name}
                onChange={(e) => rename(item.id, e.target.value)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-zinc-500"
              />
              <span
                className="hidden shrink-0 truncate text-[10px] text-zinc-600 sm:inline"
                title={item.path}
              >
                {item.source}
              </span>
              <button
                onClick={() => void copyToClipboard(item)}
                title="Copy - paste it into any slot"
                className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-emerald-500/70 hover:text-emerald-300"
              >
                Copy
              </button>
              <button
                onClick={() => void remove(item)}
                aria-label="Remove from library"
                className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
              >
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}
