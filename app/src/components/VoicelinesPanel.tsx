import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { VoiceLine } from "../lib/api";

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
  renderSound,
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
  /** Render the editor panel for an opened voiceline. */
  renderSound: (sound: { eventName: string; label: string }) => React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = voicelines ?? [];
    if (!q) return list;
    return list.filter(
      (v) => v.label.toLowerCase().includes(q) || v.eventName.toLowerCase().includes(q),
    );
  }, [voicelines, query]);

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
          }}
          placeholder="Search voicelines…"
          className="ml-auto w-56 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>

      {loading && !voicelines && (
        <p className="py-8 text-center text-sm text-zinc-500">Loading voicelines…</p>
      )}
      {voicelines && voicelines.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">
          This hero has no voiceline data.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {shown.map((vl) => {
          const isOpen = expanded.has(vl.eventName);
          return (
            <div
              key={vl.eventName}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40"
            >
              <div className="flex items-center gap-2 px-3 py-1.5">
                <button
                  onClick={() => void preview(vl)}
                  disabled={!vl.stockRef}
                  title={vl.stockRef ? "Preview stock clip" : "No stock clip"}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-30"
                >
                  {playing === vl.eventName ? "▮▮" : "▶"}
                </button>
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" title={vl.eventName}>
                  {vl.label}
                </span>
                <button
                  onClick={() => toggle(vl)}
                  style={isOpen ? { borderColor: accent, color: accent } : undefined}
                  className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                >
                  {isOpen ? "Close" : "Replace"}
                </button>
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
