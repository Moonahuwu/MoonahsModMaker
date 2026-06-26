import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../lib/settings";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Manage the list of other-mod vpks to combine on compile (their sounds +
 *  soundevents are unioned in; nothing of yours is removed). */
export function ImportedMods({
  settings,
  update,
  onMerge,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  onMerge: (vpk: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const mods = settings.importedMods;

  function add() {
    const p = draft.trim().replace(/^"|"$/g, "");
    if (p && !mods.includes(p)) update({ importedMods: [...mods, p] });
    setDraft("");
  }
  function remove(p: string) {
    update({ importedMods: mods.filter((m) => m !== p) });
  }

  async function browse() {
    const sel = await open({
      multiple: true,
      title: "Select other mods' pak01_dir.vpk",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    const next = [...mods];
    for (const p of paths) if (!next.includes(p)) next.push(p);
    update({ importedMods: next });
  }

  async function browseMerge() {
    const sel = await open({
      multiple: true,
      title: "Merge mod(s) into your project",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (!sel) return;
    for (const p of Array.isArray(sel) ? sel : [sel]) onMerge(p);
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-200">
        Mods to combine{mods.length > 0 ? ` (${mods.length})` : ""}
      </h3>

      <p className="mt-2 text-xs text-zinc-500">
        Point at other mods' <span className="font-mono">pak01_dir.vpk</span> files —
        browse, paste a path, or <span className="text-zinc-400">drag a .vpk onto the
        window</span>. On compile, their sounds + soundevent entries are merged into
        yours (in the <span className="font-mono">combined/</span> output) — your
        tracks are always kept.
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        <AnimatePresence initial={false}>
          {mods.map((m) => (
            <motion.div
              key={m}
              layout
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              className="flex items-center justify-between rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs"
            >
              <span className="truncate text-zinc-300" title={m}>
                {baseName(m)}
                <span className="ml-2 text-zinc-600">{m}</span>
              </span>
              <button
                onClick={() => remove(m)}
                className="ml-2 shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
                aria-label="Remove imported mod"
              >
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void browse()}
          className="rounded-md bg-zinc-100 px-4 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white"
        >
          Browse for .vpk…
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="…or paste a path"
          spellCheck={false}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-violet-500/70"
        />
        <button
          onClick={add}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          Add
        </button>
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">Merge a mod into your project</h3>
        <p className="mt-2 text-xs text-zinc-500">
          One-time import: pulls a mod's tracks into your matching slots (Intro / Urn
          / Heroes) so they show up there — toggle, remove, or hit <span className="text-zinc-400">Edit</span> on
          one to turn it into your own trimmable track. Different from the list above,
          which just bundles a whole mod on compile.
        </p>
        <button
          onClick={() => void browseMerge()}
          className="mt-3 rounded-md bg-violet-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-violet-500"
        >
          Merge a mod into project…
        </button>
      </div>
    </section>
  );
}
