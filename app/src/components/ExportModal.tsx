import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useEscape } from "../lib/useEscape";

/** One exportable slot (an event carrying your content). */
export interface ExportSlot {
  id: string;
  label: string;
  groupLabel: string;
  /** Track count (your songs + adopted). */
  tracks: number;
}

/** One exportable non-slot item (loose override / icon / effect). */
export interface ExportExtra {
  id: string;
  label: string;
  section: string;
}

/**
 * Export picker: choose a subset of your mod (slots, replacements, icons,
 * effects) to compile into its own standalone .vpk — for sharing one piece of
 * a big pack without shipping everything.
 */
export function ExportModal({
  slots,
  extras,
  busy,
  onCancel,
  onExport,
}: {
  slots: ExportSlot[];
  extras: ExportExtra[];
  busy: boolean;
  onCancel: () => void;
  onExport: (slotIds: Set<string>, extraIds: Set<string>) => void;
}) {
  useEscape(onCancel, !busy);
  const [selSlots, setSelSlots] = useState<Set<string>>(new Set());
  const [selExtras, setSelExtras] = useState<Set<string>>(new Set());

  const slotGroups = useMemo(() => {
    const by = new Map<string, ExportSlot[]>();
    for (const s of slots) {
      const list = by.get(s.groupLabel) ?? [];
      list.push(s);
      by.set(s.groupLabel, list);
    }
    return [...by.entries()];
  }, [slots]);

  const extraSections = useMemo(() => {
    const by = new Map<string, ExportExtra[]>();
    for (const e of extras) {
      const list = by.get(e.section) ?? [];
      list.push(e);
      by.set(e.section, list);
    }
    return [...by.entries()];
  }, [extras]);

  const toggleIn = (set: Set<string>, setter: (s: Set<string>) => void, ids: string[], on?: boolean) => {
    const next = new Set(set);
    const turnOn = on ?? !ids.every((i) => next.has(i));
    for (const i of ids) {
      if (turnOn) next.add(i);
      else next.delete(i);
    }
    setter(next);
  };

  const total = selSlots.size + selExtras.size;

  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        initial={{ scale: 0.97, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 8 }}
        transition={{ type: "spring", stiffness: 400, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-800 p-5 pb-4">
          <h3 className="text-base font-bold text-zinc-100">Export part of your pack</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Pick what to include - it compiles into its own standalone{" "}
            <span className="font-mono">pak01_dir.vpk</span> in a folder you choose, ready to
            share. Your project isn't changed.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {slots.length === 0 && extras.length === 0 && (
            <p className="text-xs text-zinc-600">Nothing to export yet - add some tracks first.</p>
          )}
          <div className="flex flex-col gap-4">
            {slotGroups.map(([group, list]) => (
              <div key={group}>
                <button
                  onClick={() => toggleIn(selSlots, setSelSlots, list.map((s) => s.id))}
                  className="mb-1.5 flex w-full items-center gap-2 text-left"
                  title="Toggle the whole group"
                >
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">{group}</span>
                  <span className="text-[11px] text-zinc-600">
                    {list.filter((s) => selSlots.has(s.id)).length}/{list.length} selected
                  </span>
                </button>
                <div className="flex flex-col gap-1">
                  {list.map((s) => (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-1.5 text-xs transition ${
                        selSlots.has(s.id)
                          ? "border-zinc-700 bg-zinc-900/70 text-zinc-200"
                          : "border-zinc-800/60 bg-zinc-900/20 text-zinc-500"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selSlots.has(s.id)}
                          onChange={() => toggleIn(selSlots, setSelSlots, [s.id])}
                          className="accent-emerald-500"
                        />
                        <span className="truncate font-medium">{s.label}</span>
                      </span>
                      <span className="ml-2 shrink-0 rounded bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                        {s.tracks} track{s.tracks === 1 ? "" : "s"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {extraSections.map(([section, list]) => (
              <div key={section}>
                <button
                  onClick={() => toggleIn(selExtras, setSelExtras, list.map((e) => e.id))}
                  className="mb-1.5 flex w-full items-center gap-2 text-left"
                  title="Toggle the whole section"
                >
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">{section}</span>
                  <span className="text-[11px] text-zinc-600">
                    {list.filter((e) => selExtras.has(e.id)).length}/{list.length} selected
                  </span>
                </button>
                <div className="flex flex-col gap-1">
                  {list.map((e) => (
                    <label
                      key={e.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                        selExtras.has(e.id)
                          ? "border-zinc-700 bg-zinc-900/70 text-zinc-200"
                          : "border-zinc-800/60 bg-zinc-900/20 text-zinc-500"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selExtras.has(e.id)}
                        onChange={() => toggleIn(selExtras, setSelExtras, [e.id])}
                        className="accent-emerald-500"
                      />
                      <span className="truncate font-medium">{e.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 p-5 pt-4">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onExport(selSlots, selExtras)}
            disabled={total === 0 || busy}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? "Exporting…" : `Choose folder & export (${total})`}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
