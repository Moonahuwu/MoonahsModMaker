import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import type { HeroSound, HeroSoundCategory } from "../lib/api";
import { PauseIcon } from "./PauseIcon";

/**
 * The hero's full non-VO sound set (gunfire, abilities, movement…) shown below
 * the ability bar. Events are auto-grouped into collapsible categories by name
 * pattern; each row previews the stock clip and lazily materializes the editor
 * (renderSound) when expanded — same model as the Voicelines panel.
 */

const GROUPS: { key: HeroSoundCategory; label: string; icon: string }[] = [
  { key: "gunfire", label: "Gunfire", icon: "⌖" },
  { key: "abilities", label: "Abilities", icon: "✦" },
  { key: "movement", label: "Movement & Melee", icon: "»" },
  { key: "other", label: "Other", icon: "•" },
];

export function HeroSoundsSection({
  accent,
  sounds,
  loading,
  onPreview,
  onOpen,
  renderSound,
  hasContent,
}: {
  accent: string;
  sounds: HeroSound[] | null;
  loading: boolean;
  /** Decode a stock clip ref → playable src (per-row preview). */
  onPreview: (ref: string) => Promise<string>;
  /** Materialize the editor slot for a sound (lazy, on first expand). */
  onOpen: (s: HeroSound) => void;
  /** Render the editor panel for an opened sound. */
  renderSound: (sound: { eventName: string; label: string }) => React.ReactNode;
  /** True if this event already has your custom/imported audio (shows a marker). */
  hasContent?: (eventName: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [openCats, setOpenCats] = useState<Set<string>>(new Set(["gunfire"]));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Media elements keep playing after DOM removal — stop on unmount.
  useEffect(() => () => audioRef.current?.pause(), []);

  const byCat = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (sounds ?? []).filter(
      (s) =>
        !q || s.label.toLowerCase().includes(q) || s.eventName.toLowerCase().includes(q),
    );
    const m = new Map<string, HeroSound[]>();
    for (const s of list) {
      const arr = m.get(s.category) ?? [];
      arr.push(s);
      m.set(s.category, arr);
    }
    return m;
  }, [sounds, query]);

  function toggleCat(key: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleRow(s: HeroSound) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(s.eventName)) {
        next.delete(s.eventName);
      } else {
        next.add(s.eventName);
        onOpen(s);
      }
      return next;
    });
  }

  async function preview(s: HeroSound) {
    if (!s.stockRef) return;
    try {
      const src = await onPreview(s.stockRef);
      const a = audioRef.current;
      if (!a) return;
      a.src = src;
      setPlaying(s.eventName);
      await a.play();
    } catch {
      setPlaying(null);
    }
  }

  const total = sounds?.length ?? 0;

  return (
    <div className="mt-7">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-300">More sounds</h3>
        {sounds && <span className="text-xs text-zinc-500">{total} events</span>}
        {total > 0 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sounds…"
            className="ml-auto w-52 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
        )}
      </div>

      {loading && !sounds && (
        <p className="py-6 text-sm text-zinc-500">Loading hero sounds…</p>
      )}
      {sounds && total === 0 && (
        <p className="py-6 text-sm text-zinc-500">This hero has no other sound events.</p>
      )}

      <div className="flex flex-col gap-2">
        {sounds &&
          GROUPS.map((g) => {
            const items = byCat.get(g.key) ?? [];
            if (items.length === 0) return null;
            const isOpen = openCats.has(g.key) || query.trim().length > 0;
            return (
              <div key={g.key} className="rounded-xl border border-zinc-800 bg-zinc-900/30">
                <button
                  onClick={() => toggleCat(g.key)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="text-sm">{g.icon}</span>
                  <span className="text-sm font-semibold text-zinc-200">{g.label}</span>
                  <span className="text-xs text-zinc-500">{items.length}</span>
                  <span className="ml-auto text-xs text-zinc-500">{isOpen ? "▾" : "▸"}</span>
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-1.5 border-t border-zinc-800 p-2">
                    {items.map((s) => {
                      const rowOpen = expanded.has(s.eventName);
                      const modded = hasContent?.(s.eventName) ?? false;
                      return (
                        <div
                          key={s.eventName}
                          className="rounded-lg border border-zinc-800 bg-zinc-900/50"
                          style={modded ? { borderColor: accent } : undefined}
                        >
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <button
                              onClick={() => void preview(s)}
                              disabled={!s.stockRef}
                              title={s.stockRef ? "Preview stock clip" : "No stock clip"}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-30"
                            >
                              {playing === s.eventName ? <PauseIcon /> : "▶"}
                            </button>
                            {modded && (
                              <span
                                title="Has your custom / imported audio"
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: accent }}
                              />
                            )}
                            <span
                              className="min-w-0 flex-1 truncate text-sm text-zinc-200"
                              title={s.eventName}
                            >
                              {s.label}
                            </span>
                            <button
                              onClick={() => toggleRow(s)}
                              style={rowOpen || modded ? { borderColor: accent, color: accent } : undefined}
                              className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                            >
                              {rowOpen ? "Close" : modded ? "Edit ✓" : "Replace"}
                            </button>
                          </div>
                          {rowOpen && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: "auto" }}
                              className="border-t border-zinc-800 p-3"
                            >
                              {renderSound({ eventName: s.eventName, label: s.label })}
                            </motion.div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
