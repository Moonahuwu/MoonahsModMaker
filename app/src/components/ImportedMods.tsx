import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { decompileVpkAll } from "../lib/api";
import type { Settings } from "../lib/settings";
import { useToast } from "./Toaster";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Mod combiner: one "Import a mod…" flow (scan → review what's inside → pick
 * the sound events to break out + bundle the rest), plus the list of bundled
 * mods that ride along on every compile.
 */
export function ImportedMods({
  settings,
  update,
  onImportPack,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Scan a pack and open the import review for it. */
  onImportPack: (vpk: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [decompiling, setDecompiling] = useState(false);
  const { push } = useToast();
  const mods = settings.importedMods;

  /** Utility: dump a whole vpk as decompiled sources (structure preserved). */
  async function decompileVpk() {
    const vpk = await open({
      multiple: false,
      title: "Decompile which .vpk?",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (!vpk || Array.isArray(vpk)) return;
    const dest = await open({ directory: true, title: "Decompile into which folder?" });
    if (!dest || Array.isArray(dest)) return;
    setDecompiling(true);
    push("info", "Decompiling the pack… big vpks take a while");
    try {
      const summary = await decompileVpkAll(settings.vpkHelperPath, vpk, dest);
      push("success", `Done — ${summary}`);
      try {
        await revealItemInDir(dest);
      } catch {
        /* ignore */
      }
    } catch (e) {
      push("error", `Decompile failed: ${e}`);
    } finally {
      setDecompiling(false);
    }
  }

  function remove(p: string) {
    // Drop the pack AND its remembered file deselections.
    const excludes = { ...(settings.importedModExcludes ?? {}) };
    delete excludes[p];
    update({ importedMods: mods.filter((m) => m !== p), importedModExcludes: excludes });
  }

  function addPath() {
    const p = draft.trim().replace(/^"|"$/g, "");
    if (p) onImportPack(p);
    setDraft("");
  }

  async function browseImport() {
    const sel = await open({
      multiple: false,
      title: "Import a mod (pak_dir.vpk)",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (!sel) return;
    onImportPack(Array.isArray(sel) ? sel[0] : sel);
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-200">Import a mod</h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Point at another mod's <span className="font-mono">pak01_dir.vpk</span> (or{" "}
        <span className="text-zinc-400">drag a .vpk onto the window</span>). You'll get a
        review of everything inside — pick which sound events become editable tracks in
        your tabs, see which original sounds it replaces, and choose whether to bundle
        the rest (models, effects, UI) into your build. Nothing of yours is ever removed.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void browseImport()}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          Import a mod…
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addPath()}
          placeholder="…or paste a .vpk path and press Enter"
          spellCheck={false}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-500/70"
        />
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">
          Bundled on compile{mods.length > 0 ? ` (${mods.length})` : ""}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          These packs' files ride along in every <span className="font-mono">combined/</span>{" "}
          build — including sounds that replace originals by filename. Remove one to stop
          bundling it (any tracks you imported from it stay in your tabs).
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {mods.length === 0 && (
            <span className="text-xs text-zinc-600">Nothing bundled yet.</span>
          )}
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
                <span className="ml-2 flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => onImportPack(m)}
                    title="Re-open the import review for this pack"
                    className="rounded px-1.5 py-0.5 text-zinc-500 transition hover:bg-zinc-700/60 hover:text-zinc-200"
                  >
                    review
                  </button>
                  <button
                    onClick={() => remove(m)}
                    className="rounded p-0.5 text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
                    aria-label="Remove bundled mod"
                  >
                    ✕
                  </button>
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">Decompile a .vpk</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Utility: dump any vpk as its decompiled sources, keeping the folder structure —
          sounds become mp3/wav, textures become png, soundevents and configs become
          readable text. Handy for digging through someone else's mod.
        </p>
        <button
          onClick={() => void decompileVpk()}
          disabled={decompiling}
          className="mt-2 rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-50"
        >
          {decompiling ? "Decompiling…" : "Decompile a .vpk…"}
        </button>
      </div>
    </section>
  );
}
