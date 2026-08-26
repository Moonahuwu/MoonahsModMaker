import { useEffect, useMemo, useRef, useState } from "react";
import { PauseIcon } from "./PauseIcon";
import { arrayLabel, fileLabel, isPreviewableRef } from "../lib/soundInventory";

/** One searchable sound: an inventory entry or an existing slot, with the tab
 *  it lives in (or would land in). */
export interface FinderRow {
  key: string;
  group: string;
  label: string;
  eventName: string;
  eventsRelpath: string;
  arrayKey: string;
  stockEntry: string;
  /** The slot's own label when one exists (curated names are searchable too). */
  slotLabel?: string;
  /** Has your custom / imported audio. */
  modded: boolean;
}

const MAX_RESULTS = 80;

/**
 * "Find a sound": one search box over every sound event the app knows
 * (every tab's inventory plus every existing slot), results grouped by tab
 * with a jump. Lives on the Misc tab so there's one obvious place to type
 * "crate" or "gold" when you don't know which tab a sound is filed under.
 */
export function SoundFinder({
  rows,
  loading,
  onJump,
  onPreview,
  tabLabels,
  tabOrder,
}: {
  rows: FinderRow[];
  loading: boolean;
  onJump: (row: FinderRow) => void;
  onPreview: (ref: string) => Promise<string>;
  tabLabels: Record<string, string>;
  tabOrder: string[];
}) {
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(() => {
    if (!tokens.length) return [] as FinderRow[];
    const hay = (r: FinderRow) =>
      [
        r.label,
        r.slotLabel ?? "",
        r.eventName,
        fileLabel(r.eventsRelpath),
        r.stockEntry.split("/").pop() ?? "",
        arrayLabel(r.arrayKey),
      ]
        .join(" ")
        .toLowerCase();
    const out: FinderRow[] = [];
    for (const r of rows) {
      const h = hay(r);
      if (tokens.every((t) => h.includes(t))) out.push(r);
    }
    return out;
  }, [rows, tokens.join(" ")]);

  const grouped = useMemo(() => {
    const m = new Map<string, FinderRow[]>();
    for (const r of results.slice(0, MAX_RESULTS)) {
      const arr = m.get(r.group) ?? [];
      arr.push(r);
      m.set(r.group, arr);
    }
    const rank = (g: string) => {
      const i = tabOrder.indexOf(g);
      return i < 0 ? tabOrder.length : i;
    };
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [results, tabOrder]);

  async function preview(r: FinderRow) {
    const a = audioRef.current;
    if (!a || !isPreviewableRef(r.stockEntry)) return;
    if (playing === r.key) {
      a.pause();
      setPlaying(null);
      return;
    }
    try {
      const src = await onPreview(r.stockEntry);
      a.src = src;
      setPlaying(r.key);
      await a.play();
    } catch {
      setPlaying(null);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} className="hidden" />
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-200">Find a sound</h3>
        <span className="text-xs text-zinc-500">
          {loading ? "reading the game's sound events…" : `${rows.length} sound events across every tab`}
        </span>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a sound: event, file, or word (e.g. crate, gold, stun)"
          className="w-full rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500 md:ml-auto md:w-96"
        />
      </div>
      {tokens.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {results.length === 0 && (
            <p className="text-sm text-zinc-500">No sound events match. Try a shorter word.</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group} className="rounded-lg border border-zinc-800 bg-zinc-950/40">
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-xs font-semibold text-zinc-300">{tabLabels[group] ?? group}</span>
                <span className="text-[11px] text-zinc-600">{items.length}</span>
              </div>
              <div className="flex flex-col border-t border-zinc-800">
                {items.map((r) => {
                  const layer = arrayLabel(r.arrayKey);
                  return (
                    <div key={r.key} className="flex items-center gap-2 px-3 py-1.5">
                      <button
                        onClick={() => void preview(r)}
                        disabled={!isPreviewableRef(r.stockEntry)}
                        title="Preview the game's clip"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-300 transition hover:border-zinc-400 disabled:opacity-30"
                      >
                        {playing === r.key ? <PauseIcon /> : "▶"}
                      </button>
                      {r.modded && (
                        <span title="Has your audio" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                      )}
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-sm text-zinc-200">{r.slotLabel || r.label}</span>
                        {layer && (
                          <span className="shrink-0 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">{layer}</span>
                        )}
                        <span className="hidden truncate text-[11px] text-zinc-600 md:inline">{r.eventName}</span>
                        <span className="hidden shrink-0 text-[10px] text-zinc-700 lg:inline">{fileLabel(r.eventsRelpath)}</span>
                      </span>
                      <button
                        onClick={() => onJump(r)}
                        className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                      >
                        Go to tab ›
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {results.length > MAX_RESULTS && (
            <p className="text-xs text-zinc-500">
              Showing {MAX_RESULTS} of {results.length} - refine your search to see more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
