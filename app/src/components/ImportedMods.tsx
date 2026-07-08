import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { decompileVpkAll, listUiMods, type UiModVpk } from "../lib/api";
import type { Settings } from "../lib/settings";
import type { DigimodConfig } from "../types";
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
  digimod,
  onDigimodChange,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Scan a pack and open the import review for it. */
  onImportPack: (vpk: string) => void;
  /** Jumpscares config — UI-mod merges live on it (they splice base_hud). */
  digimod: DigimodConfig | null;
  onDigimodChange: (next: DigimodConfig) => void;
}) {
  const [draft, setDraft] = useState("");
  const [decompiling, setDecompiling] = useState(false);
  const { push } = useToast();
  const mods = settings.importedMods;

  // HUD (base_hud-overriding) mods can't be bundled like regular packs — two
  // base_huds can't coexist, so they get spliced instead (Jumpscares engine).
  const [uiMods, setUiMods] = useState<UiModVpk[]>([]);
  useEffect(() => {
    if (!settings.addonsDir) return;
    listUiMods(settings.addonsDir)
      .then(setUiMods)
      .catch(() => {});
  }, [settings.addonsDir]);
  const mergeVpks = digimod?.mergeVpks ?? [];
  const toggleMerge = (path: string) => {
    const base = digimod ?? {
      rngInterval: 60,
      scareChance: 3,
      deathChance: 100,
      scares: [],
      deaths: [],
    };
    onDigimodChange({
      ...base,
      mergeVpks: mergeVpks.includes(path)
        ? mergeVpks.filter((p) => p !== path)
        : [...mergeVpks, path],
    });
  };
  async function browseMergeVpk() {
    const sel = await open({
      multiple: false,
      title: "Merge which UI mod (.vpk)?",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (typeof sel === "string" && !mergeVpks.includes(sel)) toggleMerge(sel);
  }
  const externalMerges = mergeVpks.filter((p) => !uiMods.some((m) => m.path === p));

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
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            Merge UI mods{mergeVpks.length > 0 ? ` (${mergeVpks.length})` : ""}
          </h3>
          <button
            onClick={() => void browseMergeVpk()}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Browse for a vpk…
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          HUD mods (anything overriding the in-game HUD layout) can't be bundled like the
          packs above — two HUDs can't coexist. Merging splices them together instead:
          their HUD edits + your Jumpscares/Deaths ship as one. Installed HUD mods show up
          here automatically.
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {uiMods.length === 0 && externalMerges.length === 0 && (
            <span className="text-xs text-zinc-600">No HUD mods found in your addons.</span>
          )}
          {uiMods.map((m) =>
            m.hasDigi ? (
              <div
                key={m.path}
                className="flex items-center gap-2 rounded-md border border-zinc-800/60 px-3 py-1.5 text-xs text-zinc-600"
                title={m.path}
              >
                <span className="truncate">{m.fileName}</span>
                <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">
                  DigiMaster pak — import it in the Jumpscares tab instead
                </span>
              </div>
            ) : (
              <label
                key={m.path}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
                title={m.path}
              >
                <input
                  type="checkbox"
                  checked={mergeVpks.includes(m.path)}
                  onChange={() => toggleMerge(m.path)}
                  className="accent-emerald-500"
                />
                <span className="truncate">{m.fileName}</span>
                {mergeVpks.includes(m.path) && (
                  <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                    merges on compile — disable the original pak after installing
                  </span>
                )}
              </label>
            ),
          )}
          {externalMerges.map((p) => (
            <label
              key={p}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
              title={p}
            >
              <input
                type="checkbox"
                checked
                onChange={() => toggleMerge(p)}
                className="accent-emerald-500"
              />
              <span className="truncate">{baseName(p)}</span>
              <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                merges on compile
              </span>
            </label>
          ))}
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
