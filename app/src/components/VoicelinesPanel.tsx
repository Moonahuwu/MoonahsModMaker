import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { VoiceLine } from "../lib/api";
import { PauseIcon } from "./PauseIcon";

/**
 * A hero's voicelines (often 1000+ single-clip events). Rendered compactly: a
 * searchable, capped list where each row is just a label + a quick preview
 * button. The full editor (renderSound) only materializes for a voiceline once
 * the user expands it to replace/add their own clip.
 */
const PAGE = 60;

export function VoicelinesPanel({
  heroName,
  accent,
  voicelines,
  loading,
  onBack,
  onPreview,
  onOpen,
  onBulkReplace,
  onBulkClear,
  renderSound,
  modifiedFilter,
  hasContent,
}: {
  heroName: string;
  accent: string;
  voicelines: VoiceLine[] | null;
  loading: boolean;
  onBack: () => void;
  /** Decode a stock clip ref → playable src (for the per-row preview). */
  onPreview: (ref: string) => Promise<string>;
  /** Materialize the editor slot for a voiceline (lazy, on first expand). */
  onOpen: (vl: VoiceLine) => void;
  /** Bulk replace: apply ONE picked audio file to every given voiceline.
   *  Resolves true when applied (the selection clears then). */
  onBulkReplace: (vls: VoiceLine[]) => Promise<boolean>;
  /** Bulk revert: remove custom audio from every given voiceline (back to
   *  the stock clip). Resolves true when applied. */
  onBulkClear: (vls: VoiceLine[]) => Promise<boolean>;
  /** Render the editor panel for an opened voiceline. */
  renderSound: (sound: { eventName: string; label: string }) => React.ReactNode;
  /** "Modified only": when set, list only voicelines this returns true for. */
  modifiedFilter?: ((eventName: string) => boolean) | null;
  /** True if the voiceline already has your custom audio (row marker). */
  hasContent?: (eventName: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Multi-select ("Deadlock Forge"-style): pick many lines, then apply one
  // audio file to (or remove audio from) all of them at once. The mode is a
  // sticky preference - it survives hero switches and restarts.
  const [selectMode, setSelectModeRaw] = useState(
    () => localStorage.getItem("eim.vlSelectMode") === "1",
  );
  const setSelectMode = (v: boolean) => {
    setSelectModeRaw(v);
    try {
      localStorage.setItem("eim.vlSelectMode", v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Media elements keep playing after DOM removal — stop on unmount.
  useEffect(() => () => audioRef.current?.pause(), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = voicelines ?? [];
    if (modifiedFilter) list = list.filter((v) => modifiedFilter(v.eventName));
    if (!q) return list;
    return list.filter(
      (v) => v.label.toLowerCase().includes(q) || v.eventName.toLowerCase().includes(q),
    );
  }, [voicelines, query, modifiedFilter]);

  const shown = filtered.slice(0, limit);

  function toggle(vl: VoiceLine) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(vl.eventName)) {
        next.delete(vl.eventName);
      } else {
        next.add(vl.eventName);
        onOpen(vl);
      }
      return next;
    });
  }

  // Range selection: a plain click sets the anchor; a shift-click applies the
  // anchor's state (select or deselect) to every row between the two.
  const anchor = useRef<{ index: number; on: boolean } | null>(null);

  function clickSelect(name: string, index: number, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor.current) {
        const a = Math.min(anchor.current.index, index);
        const b = Math.max(anchor.current.index, index);
        for (let i = a; i <= b; i++) {
          const n = shown[i]?.eventName;
          if (!n) continue;
          if (anchor.current.on) next.add(n);
          else next.delete(n);
        }
      } else {
        const on = !next.has(name);
        if (on) next.add(name);
        else next.delete(name);
        anchor.current = { index, on };
      }
      return next;
    });
  }

  async function applySelected(action: "replace" | "clear") {
    const chosen = (voicelines ?? []).filter((v) => selected.has(v.eventName));
    if (chosen.length === 0) return;
    setApplying(true);
    try {
      const run = action === "replace" ? onBulkReplace : onBulkClear;
      if (await run(chosen)) setSelected(new Set());
    } finally {
      setApplying(false);
    }
  }

  async function preview(vl: VoiceLine) {
    if (!vl.stockRef) return;
    try {
      const src = await onPreview(vl.stockRef);
      const a = audioRef.current;
      if (!a) return;
      a.src = src;
      setPlaying(vl.eventName);
      await a.play();
    } catch {
      setPlaying(null);
    }
  }

  return (
    <div>
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          ← {heroName}
        </button>
        <h2 className="text-lg font-bold tracking-tight text-white">Voicelines</h2>
        {voicelines && (
          <span className="text-xs text-zinc-500">
            {filtered.length}
            {query ? ` of ${voicelines.length}` : ""} lines
          </span>
        )}
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
            anchor.current = null; // list order changes - old index is stale
          }}
          placeholder="Search voicelines…"
          className="ml-auto w-56 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
        <button
          onClick={() => {
            setSelectMode(!selectMode);
            setSelected(new Set());
            anchor.current = null;
          }}
          style={selectMode ? { borderColor: accent, color: accent } : undefined}
          title="Pick several voicelines, then replace them all with one audio file"
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          {selectMode ? "✕ Cancel select" : "☑ Select multiple"}
        </button>
      </div>

      {/* Bulk action bar: pick lines below, then one file replaces them all.
          Sticky: it follows the scroll so applying never means a trip back to
          the top of a 1400-line list. */}
      {selectMode && (
        <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 shadow-lg shadow-black/40 backdrop-blur">
          <span className="text-xs font-medium text-zinc-300">
            {selected.size} selected
          </span>
          <button
            onClick={() =>
              setSelected(new Set(filtered.map((v) => v.eventName)))
            }
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            title={query ? "Select every line matching the search" : "Select every line"}
          >
            Select all {filtered.length}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-40"
          >
            Deselect
          </button>
          <span className="text-[11px] text-zinc-600">
            tip: search first, then Select all - e.g. every "laugh" line at once
          </span>
          <button
            onClick={() => void applySelected("clear")}
            disabled={selected.size === 0 || applying}
            title="Remove your custom audio from the selected lines - they go back to the stock clips"
            className="ml-auto rounded-md border border-red-500/40 px-3 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
          >
            Remove audio{selected.size ? ` from ${selected.size}` : ""}
          </button>
          <button
            onClick={() => void applySelected("replace")}
            disabled={selected.size === 0 || applying}
            style={{ backgroundColor: accent }}
            className="rounded-md px-3 py-1 text-xs font-semibold text-zinc-950 transition hover:opacity-90 disabled:opacity-40"
          >
            {applying
              ? "Applying…"
              : `Replace ${selected.size || ""} with one audio file…`}
          </button>
        </div>
      )}

      {loading && !voicelines && (
        <p className="py-8 text-center text-sm text-zinc-500">Loading voicelines…</p>
      )}
      {voicelines && voicelines.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">
          This hero has no voiceline data.
        </p>
      )}
      {modifiedFilter && voicelines && voicelines.length > 0 && filtered.length === 0 && !query && (
        <p className="py-8 text-center text-sm text-zinc-500">
          No modified voicelines yet - turn off “Modified only” to browse all of them.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {shown.map((vl, idx) => {
          const isOpen = expanded.has(vl.eventName);
          const modded = hasContent?.(vl.eventName) ?? false;
          const isSel = selected.has(vl.eventName);
          return (
            <div
              key={vl.eventName}
              onClick={
                selectMode
                  ? (e) => clickSelect(vl.eventName, idx, e.shiftKey)
                  : undefined
              }
              className={`rounded-lg border border-zinc-800 bg-zinc-900/40${
                selectMode ? " cursor-pointer select-none" : ""
              }${isSel ? " bg-zinc-800/70" : ""}`}
              style={isSel || modded ? { borderColor: accent } : undefined}
            >
              <div className="flex items-center gap-2 px-3 py-1.5">
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => {}}
                    onClick={(e) => {
                      e.stopPropagation();
                      clickSelect(vl.eventName, idx, e.shiftKey);
                    }}
                    title="Click to select - shift-click selects the whole range from your last click"
                    className="h-4 w-4 shrink-0"
                    style={{ accentColor: accent }}
                  />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void preview(vl);
                  }}
                  disabled={!vl.stockRef}
                  title={vl.stockRef ? "Preview stock clip (the original - your replacement plays in game)" : "No stock clip"}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-30"
                >
                  {playing === vl.eventName ? <PauseIcon /> : "▶"}
                </button>
                {modded && (
                  <span
                    title="Has your custom / imported audio"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: accent }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" title={vl.eventName}>
                  {vl.label}
                </span>
                {!selectMode && (
                  <button
                    onClick={() => toggle(vl)}
                    style={isOpen || modded ? { borderColor: accent, color: accent } : undefined}
                    className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                  >
                    {isOpen ? "Close" : modded ? "Edit ✓" : "Replace"}
                  </button>
                )}
              </div>
              {isOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="border-t border-zinc-800 p-3"
                >
                  {renderSound({ eventName: vl.eventName, label: vl.label })}
                </motion.div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length > limit && (
        <button
          onClick={() => setLimit((n) => n + PAGE)}
          className="mt-3 w-full rounded-lg border border-zinc-800 py-2 text-sm text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
        >
          Show more ({filtered.length - limit} remaining)
        </button>
      )}
    </div>
  );
}
