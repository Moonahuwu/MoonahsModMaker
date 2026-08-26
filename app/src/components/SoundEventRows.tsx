import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { PauseIcon } from "./PauseIcon";
import { arrayLabel, fileLabel, isPreviewableRef } from "../lib/soundInventory";

/** One "All sounds" row: an inventory entry plus what the app knows about it. */
export interface SoundRowView {
  key: string;
  eventsRelpath: string;
  eventName: string;
  arrayKey: string;
  label: string;
  stockEntry: string;
  entryCount: number;
  /** The materialized slot's id, once one exists. */
  slotId: string | null;
  /** Has your custom / imported audio. */
  modded: boolean;
  pinned: boolean;
}

const PAGE = 60;

/**
 * The rows of a sound tab's "All" mode: every sound event the tab covers that
 * isn't already a panel, grouped by source file, searchable, paged. Same model
 * as the hero "More sounds" section - a row previews the stock clip and lazily
 * materializes its editor slot when expanded (`onOpen`), rendered inline by
 * `renderSlot`.
 */
export function SoundEventRows({
  rows,
  loading,
  error,
  expanded,
  onOpen,
  onClose,
  onPreview,
  onTogglePin,
  renderSlot,
  registerRowEl,
  accent,
  query,
}: {
  rows: SoundRowView[];
  loading: boolean;
  error: string | null;
  expanded: Set<string>;
  onOpen: (row: SoundRowView) => void;
  onClose: (key: string) => void;
  /** Decode a stock clip ref -> playable src. */
  onPreview: (ref: string) => Promise<string>;
  onTogglePin: (row: SoundRowView) => void;
  /** Render the editor panel for a materialized slot (null while preparing). */
  renderSlot: (slotId: string | null, row: SoundRowView) => React.ReactNode;
  registerRowEl?: (key: string, el: HTMLElement | null) => void;
  accent: string;
  /** The tab bar's search text (filtering happens in the parent). */
  query: string;
}) {
  const [openFiles, setOpenFiles] = useState<Set<string> | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);

  // Sections in order of first appearance (file order = sweep order).
  const sections = useMemo(() => {
    const m = new Map<string, SoundRowView[]>();
    for (const r of rows) {
      const arr = m.get(r.eventsRelpath) ?? [];
      arr.push(r);
      m.set(r.eventsRelpath, arr);
    }
    return [...m.entries()];
  }, [rows]);

  // Default: a handful of files all start open; a long list starts with just
  // the first open. A search opens everything it matched.
  const isOpen = (file: string, idx: number) => {
    if (query.trim()) return true;
    if (openFiles) return openFiles.has(file);
    return sections.length <= 3 || idx === 0;
  };
  function toggleFile(file: string) {
    setOpenFiles((prev) => {
      // First toggle: start from whatever the default rule had open.
      const base = prev ?? new Set(sections.filter((s, i) => isOpen(s[0], i)).map((s) => s[0]));
      const next = new Set(base);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }

  async function preview(row: SoundRowView) {
    if (!isPreviewableRef(row.stockEntry)) return;
    const a = audioRef.current;
    if (!a) return;
    if (playing === row.key) {
      a.pause();
      setPlaying(null);
      return;
    }
    try {
      const src = await onPreview(row.stockEntry);
      a.src = src;
      setPlaying(row.key);
      await a.play();
    } catch {
      setPlaying(null);
    }
  }

  return (
    <div className="mt-5">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
      {loading && !rows.length && (
        <p className="py-6 text-sm text-zinc-500">Reading the game's sound events…</p>
      )}
      {error && (
        <p className="py-3 text-sm text-amber-300/90">
          Couldn't read the game's sound events: {error}. Run Fix for new patch to pull the
          game's sound data first.
        </p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p className="py-6 text-sm text-zinc-500">
          {query.trim()
            ? "No sound events match that search."
            : "Nothing extra here - this tab already shows every sound event it covers."}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {sections.map(([file, items], idx) => {
          const open = isOpen(file, idx);
          const limit = limits[file] ?? PAGE;
          const shown = items.slice(0, limit);
          return (
            <div key={file} className="rounded-xl border border-zinc-800 bg-zinc-900/30">
              <button
                onClick={() => toggleFile(file)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="text-sm text-zinc-500">▤</span>
                <span className="text-sm font-semibold text-zinc-200">{fileLabel(file)}</span>
                <span className="text-xs text-zinc-500">{items.length}</span>
                <span className="ml-auto text-xs text-zinc-500">{open ? "▾" : "▸"}</span>
              </button>

              {open && (
                <div className="flex flex-col gap-1.5 border-t border-zinc-800 p-2">
                  {shown.map((row) => {
                    const rowOpen = expanded.has(row.key);
                    const layer = arrayLabel(row.arrayKey);
                    const canPreview = isPreviewableRef(row.stockEntry);
                    return (
                      <div
                        key={row.key}
                        ref={(el) => registerRowEl?.(row.key, el)}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/50"
                        style={row.modded ? { borderColor: accent } : undefined}
                      >
                        <div className="flex items-center gap-2 px-3 py-1.5">
                          <button
                            onClick={() => void preview(row)}
                            disabled={!canPreview}
                            title={canPreview ? "Preview the game's clip" : "No previewable clip"}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-400 disabled:opacity-30"
                          >
                            {playing === row.key ? <PauseIcon /> : "▶"}
                          </button>
                          {row.modded && (
                            <span
                              title="Has your custom / imported audio"
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: accent }}
                            />
                          )}
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="truncate text-sm text-zinc-200" title={row.eventName}>
                              {row.label}
                            </span>
                            {layer && (
                              <span className="shrink-0 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">
                                {layer}
                              </span>
                            )}
                            <span className="hidden truncate text-[11px] text-zinc-600 md:inline">
                              {row.eventName}
                            </span>
                            {row.entryCount > 1 && (
                              <span className="shrink-0 text-[10px] text-zinc-600">{row.entryCount} clips</span>
                            )}
                          </span>
                          <button
                            onClick={() => onTogglePin(row)}
                            title={row.pinned ? "Pinned - shows in Most used. Click to unpin" : "Pin to Most used"}
                            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-xs transition ${
                              row.pinned
                                ? "border-amber-400/60 text-amber-300"
                                : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                            }`}
                          >
                            {row.pinned ? "⚑" : "⚐"}
                          </button>
                          <button
                            onClick={() => (rowOpen ? onClose(row.key) : onOpen(row))}
                            style={rowOpen || row.modded ? { borderColor: accent, color: accent } : undefined}
                            className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500"
                          >
                            {rowOpen ? "Close" : row.modded ? "Edit ✓" : "Replace"}
                          </button>
                        </div>
                        {rowOpen && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            className="border-t border-zinc-800 p-3"
                          >
                            {renderSlot(row.slotId, row)}
                          </motion.div>
                        )}
                      </div>
                    );
                  })}
                  {items.length > limit && (
                    <button
                      onClick={() => setLimits((l) => ({ ...l, [file]: limit + PAGE }))}
                      className="mt-1 self-start rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
                    >
                      Show {Math.min(PAGE, items.length - limit)} more of {items.length}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
