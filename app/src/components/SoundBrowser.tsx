import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { type SoundBrowse } from "../lib/api";
import { cBrowseGameSounds } from "../lib/dataCache";
import type { SoundOverride } from "../types";
import { PauseIcon } from "./PauseIcon";

/**
 * Loose-file sound replacement browser. The game has ~79k sounds, so this never
 * loads a flat list: a curated set of top categories (each a path prefix) →
 * drill into subfolders (often per-hero) → files, with recursive search inside a
 * category. Each file can be previewed (stock clip) and replaced with your own
 * audio, which compiles to a `.vsnd_c` staged at the vanilla path (no soundevents).
 */
export interface SoundCategory {
  key: string;
  label: string;
  /** Path prefix into the game's sound tree, e.g. `sounds/vo`. */
  prefix: string;
  hint?: string;
}

export function SoundBrowser({
  helperPath,
  pakPath,
  categories,
  overrides,
  accent,
  onPreview,
  onReplace,
  onRemoveOverride,
  onDownloadMany,
  renderEditor,
  modifiedOnly,
}: {
  helperPath: string;
  pakPath: string;
  categories: SoundCategory[];
  overrides: SoundOverride[];
  accent: string;
  /** Decode a stock `.vsnd` ref → playable src for preview. */
  onPreview: (reference: string) => Promise<string>;
  /** Begin a replacement for this sound (pick audio + create the override). */
  onReplace: (reference: string, label: string) => void;
  onRemoveOverride: (reference: string) => void;
  /** Decode + save stock sounds into Downloads (one or many). */
  onDownloadMany: (refs: string[]) => Promise<void>;
  /** Render the editor for an existing override (trim/gain/fade/loop). */
  renderEditor: (override: SoundOverride) => React.ReactNode;
  /** "Modified only": show just categories/folders/files with a replacement. */
  modifiedOnly?: boolean;
}) {
  // Navigation: null = category grid; otherwise a {prefix,label} into the tree.
  const [cat, setCat] = useState<SoundCategory | null>(null);
  const [prefix, setPrefix] = useState<string>("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SoundBrowse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Multi-select for batch downloads (persists while drilling across folders).
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  // Anchor for shift-click range selection (index into the shown file list).
  const lastSelIdx = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Media elements keep playing after DOM removal — stop on unmount.
  useEffect(() => () => audioRef.current?.pause(), []);

  const overrideByRef = useMemo(
    () => new Map(overrides.map((o) => [o.targetRef, o])),
    [overrides],
  );

  // Load a folder level (debounced for search).
  useEffect(() => {
    if (cat === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      cBrowseGameSounds(helperPath, pakPath, prefix, query)
        .then((d) => !cancelled && setData(d))
        .catch((e) => !cancelled && setError(String(e)))
        .finally(() => !cancelled && setLoading(false));
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cat, prefix, query, helperPath, pakPath]);

  async function preview(reference: string) {
    try {
      const src = await onPreview(reference);
      const a = audioRef.current;
      if (!a) return;
      a.src = src;
      setPlaying(reference);
      await a.play();
    } catch {
      setPlaying(null);
    }
  }

  function enterCategory(c: SoundCategory) {
    setCat(c);
    setPrefix(c.prefix);
    setQuery("");
    setData(null);
    setOpenRow(null);
  }

  function leaveToCategories() {
    setCat(null);
    setData(null);
    setQuery("");
  }

  // Breadcrumb segments from the current prefix, relative to the category root.
  const crumbs = useMemo(() => {
    if (!cat) return [];
    const rest = prefix.slice(cat.prefix.length).split("/").filter(Boolean);
    const segs: { label: string; prefix: string }[] = [];
    let acc = cat.prefix;
    for (const r of rest) {
      acc = `${acc}/${r}`;
      segs.push({ label: r, prefix: acc });
    }
    return segs;
  }, [cat, prefix]);

  // ---- Category grid -------------------------------------------------------
  if (!cat) {
    return (
      <div>
        <p className="mb-4 text-sm text-zinc-500">
          Replace any in-game sound with your own audio - no soundevents touched.
          Pick a category, find the sound, preview it, then drop in a replacement.
          {overrides.length > 0 && (
            <span className="ml-1 text-emerald-400">
              {overrides.length} replacement{overrides.length === 1 ? "" : "s"} queued.
            </span>
          )}
        </p>
        {modifiedOnly &&
          !categories.some((c) => overrides.some((o) => o.targetRef.startsWith(`${c.prefix}/`))) && (
            <p className="py-8 text-center text-sm text-zinc-500">
              No replaced sounds yet - turn off “Modified only” to browse everything.
            </p>
          )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((c) => {
            const n = overrides.filter((o) => o.targetRef.startsWith(`${c.prefix}/`)).length;
            if (modifiedOnly && n === 0) return null;
            return (
              <button
                key={c.key}
                onClick={() => enterCategory(c)}
                className="group relative flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-left transition hover:border-zinc-600 hover:bg-zinc-900"
              >
                <span className="text-sm font-semibold text-zinc-100">{c.label}</span>
                {c.hint && <span className="mt-1 text-[11px] text-zinc-500">{c.hint}</span>}
                {n > 0 && (
                  <span className="absolute right-2 top-2 rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Folder / file view --------------------------------------------------
  return (
    <div>
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />

      {/* Breadcrumb + search */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={leaveToCategories}
          className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          ← Categories
        </button>
        <button
          onClick={() => {
            setPrefix(cat.prefix);
            setQuery("");
          }}
          className="text-xs font-semibold text-zinc-200 hover:text-white"
        >
          {cat.label}
        </button>
        {crumbs.map((c) => (
          <span key={c.prefix} className="flex items-center gap-2 text-xs text-zinc-500">
            <span>/</span>
            <button
              onClick={() => {
                setPrefix(c.prefix);
                setQuery("");
              }}
              className="text-zinc-300 hover:text-white"
            >
              {c.label}
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search in ${cat.label}…`}
          className="ml-auto w-60 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {loading && !data && (
        <p className="py-8 text-center text-sm text-zinc-500">Loading sounds…</p>
      )}

      {data && (
        <>
          {/* Subfolders (with "modified only" on, just those holding a replacement) */}
          {!query && data.folders.length > 0 && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {data.folders
                .filter(
                  (f) =>
                    !modifiedOnly ||
                    overrides.some((o) => o.targetRef.startsWith(`${f.prefix}/`)),
                )
                .map((f) => (
                <button
                  key={f.prefix}
                  onClick={() => setPrefix(f.prefix)}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900"
                >
                  <span className="truncate">▸ {f.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-zinc-500">{f.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Batch download bar (shows once anything is ticked) */}
          {sel.size > 0 && (
            <div className="mb-2 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-1.5">
              <span className="text-xs font-semibold text-zinc-200">
                {sel.size} selected
              </span>
              <button
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void onDownloadMany(Array.from(sel))
                    .then(() => setSel(new Set()))
                    .finally(() => setDownloading(false));
                }}
                className="rounded-md bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
              >
                {downloading ? "Downloading…" : "⬇ Download selected"}
              </button>
              <button
                onClick={() =>
                  setSel((prev) => {
                    const next = new Set(prev);
                    for (const f of data.files) next.add(f.reference);
                    return next;
                  })
                }
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                Select shown
              </button>
              <button onClick={() => setSel(new Set())} className="text-xs text-zinc-400 hover:text-zinc-200">
                Clear
              </button>
            </div>
          )}

          {/* Files (with "modified only" on, just the replaced ones) */}
          <div className="flex flex-col gap-1.5">
            {(() => {
              const shownFiles = data.files.filter(
                (file) => !modifiedOnly || overrideByRef.has(file.reference),
              );
              // Toggle one row; shift-click selects the whole range from the
              // last-clicked row (like a file manager).
              const toggleSelect = (idx: number, reference: string, shift: boolean) => {
                setSel((prev) => {
                  const next = new Set(prev);
                  if (shift && lastSelIdx.current !== null && lastSelIdx.current !== idx) {
                    const [a, b] =
                      lastSelIdx.current < idx ? [lastSelIdx.current, idx] : [idx, lastSelIdx.current];
                    for (let i = a; i <= b && i < shownFiles.length; i++) {
                      next.add(shownFiles[i].reference);
                    }
                  } else if (next.has(reference)) {
                    next.delete(reference);
                  } else {
                    next.add(reference);
                  }
                  lastSelIdx.current = idx;
                  return next;
                });
              };
              return shownFiles.map((file, idx) => {
              const ov = overrideByRef.get(file.reference);
              const isOpen = openRow === file.reference;
              return (
                <div
                  key={file.reference}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/40"
                  style={ov ? { borderColor: `${accent}66` } : undefined}
                >
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={sel.has(file.reference)}
                      onClick={(e) =>
                        toggleSelect(idx, file.reference, (e as React.MouseEvent).shiftKey)
                      }
                      onChange={() => {}}
                      title="Select for batch download (shift-click to select a range)"
                      className="shrink-0 accent-emerald-500"
                    />
                    <button
                      onClick={() => void preview(file.reference)}
                      title="Preview stock clip"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                    >
                      {playing === file.reference ? <PauseIcon /> : "▶"}
                    </button>
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-zinc-200"
                      title={file.reference}
                    >
                      {file.label}
                    </span>
                    {ov ? (
                      <>
                        <span
                          className="rounded px-1.5 text-[10px] font-semibold"
                          style={{ backgroundColor: `${accent}22`, color: accent }}
                        >
                          replaced
                        </span>
                        <button
                          onClick={() => setOpenRow(isOpen ? null : file.reference)}
                          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                        >
                          {isOpen ? "Close" : "Edit"}
                        </button>
                        <button
                          onClick={() => {
                            onRemoveOverride(file.reference);
                            if (isOpen) setOpenRow(null);
                          }}
                          title="Remove replacement"
                          className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 transition hover:border-red-600/60 hover:text-red-300"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => onReplace(file.reference, file.label)}
                        className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                      >
                        Replace
                      </button>
                    )}
                    <button
                      onClick={() => void onDownloadMany([file.reference])}
                      title="Download a copy to your Downloads folder"
                      className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-white"
                    >
                      ⬇
                    </button>
                  </div>
                  {ov && isOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="border-t border-zinc-800 p-3"
                    >
                      {renderEditor(ov)}
                    </motion.div>
                  )}
                </div>
              );
              });
            })()}
            {data.files.length === 0 && data.folders.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500">
                {query ? "No sounds match your search." : "No sounds here."}
              </p>
            )}
          </div>

          {data.truncated && (
            <p className="mt-3 text-center text-xs text-zinc-500">
              Showing the first {data.files.length}. Narrow it with search.
            </p>
          )}
        </>
      )}
    </div>
  );
}
