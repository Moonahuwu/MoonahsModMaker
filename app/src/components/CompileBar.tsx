import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  compileProject,
  installToGame,
  scanAddonSlots,
  type CompileReport,
  type SlotScan,
} from "../lib/api";
import { buildCompileConfig, installSrcVpk, type Settings } from "../lib/settings";
import { useToast } from "./Toaster";
import type { EffectOverride, EventProject, IconMod, SoundOverride } from "../types";

const pakName = (n: number) => `pak${String(n).padStart(2, "0")}_dir.vpk`;

export function CompileBar({
  settings,
  update,
  events,
  iconMods,
  soundOverrides,
  effectOverrides,
  onCompiled,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  events: EventProject[];
  iconMods: IconMod[];
  soundOverrides: SoundOverride[];
  effectOverrides: EffectOverride[];
  /** Called after a successful compile so the project can record compiled hashes. */
  onCompiled: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [report, setReport] = useState<CompileReport | null>(null);
  const [slots, setSlots] = useState<SlotScan | null>(null);
  const { push } = useToast();

  const songCount = events.reduce((n, e) => n + e.songs.length, 0);
  const modCount = settings.importedMods.length;
  const canCompile =
    songCount > 0 ||
    modCount > 0 ||
    iconMods.length > 0 ||
    soundOverrides.length > 0 ||
    effectOverrides.length > 0;

  // Refresh the addon-slot picture (for the "next free" hint + conflict warning).
  const rescanSlots = useCallback(() => {
    if (!settings.addonsDir) return setSlots(null);
    scanAddonSlots(settings.addonsDir).then(setSlots).catch(() => setSlots(null));
  }, [settings.addonsDir]);

  useEffect(() => {
    rescanSlots();
  }, [rescanSlots]);

  /** Copy the freshly-compiled .vpk into the game's addons folder. */
  async function install(): Promise<boolean> {
    if (!settings.addonsDir) {
      push("error", "Set the Deadlock addons folder in Setup first");
      return false;
    }
    if (settings.outputMode !== "vpk") {
      push("error", "Switch output to 'Pack .vpk' to install into the game");
      return false;
    }
    setInstalling(true);
    try {
      const res = await installToGame(
        installSrcVpk(settings),
        settings.addonsDir,
        settings.installSlot,
        settings.patchGameinfo,
      );
      // "Add" mode (null) pins the resolved slot so repeated installs reuse it
      // instead of filling new slots; switch back to Auto to grab a new one.
      if (settings.installSlot === null) update({ installSlot: res.slot });
      const extras = [
        res.replaced ? "replaced existing" : null,
        res.gameinfoPatched ? "gameinfo patched" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      push("success", `Installed → ${pakName(res.slot)}${extras ? ` (${extras})` : ""}`);
      rescanSlots();
      return true;
    } catch (e) {
      push("error", `Install failed: ${e}`);
      return false;
    } finally {
      setInstalling(false);
    }
  }

  async function compile() {
    setRunning(true);
    setReport(null);
    try {
      const config = buildCompileConfig(settings, events, false, iconMods, soundOverrides, effectOverrides);
      const r = await compileProject(config);
      setReport(r);
      if (r.ok) {
        onCompiled();
        push("success", `Compiled → ${r.outputPath ?? "done"}`);
        if (settings.installAfterCompile) await install();
      } else push("error", "Compile failed — see the step report");
    } catch (e) {
      setReport({ ok: false, steps: [{ name: "invoke", ok: false, detail: String(e) }] });
      push("error", String(e));
    } finally {
      setRunning(false);
    }
  }

  async function openOutput() {
    if (report?.outputPath) {
      try {
        await revealItemInDir(report.outputPath);
      } catch {
        /* ignore */
      }
    }
  }

  const auto = settings.installSlot === null;
  const fixedTaken =
    !auto && slots?.used.includes(settings.installSlot as number) === true;
  const busy = running || installing;

  return (
    <div className="sticky bottom-0 z-30 -mx-6 mt-2 border-t border-zinc-800 bg-zinc-950/85 px-6 py-3 backdrop-blur">
      {/* Report (appears above the control row) */}
      <AnimatePresence>
        {report && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={`text-sm font-semibold ${report.ok ? "text-emerald-400" : "text-red-400"}`}
                >
                  {report.ok ? "✓ Compile succeeded" : "✗ Compile failed"}
                </span>
                {report.outputPath && (
                  <button
                    onClick={openOutput}
                    className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                  >
                    Open output folder
                  </button>
                )}
                <button
                  onClick={() => setReport(null)}
                  className="rounded p-1 text-xs text-zinc-500 hover:text-zinc-300"
                  aria-label="Dismiss report"
                >
                  ✕
                </button>
              </div>
              <ol className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {report.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span className={s.ok ? "text-emerald-500" : "text-red-500"}>
                      {s.ok ? "✓" : "✗"}
                    </span>
                    <span className="shrink-0 text-zinc-300">{s.name}</span>
                    {s.detail && (
                      <span className="truncate text-zinc-600" title={s.detail}>
                        {s.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Install row */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-zinc-400">Install:</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">
          <button
            onClick={() => update({ installSlot: null })}
            className={`px-3 py-1 font-medium transition ${
              auto ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Pick the lowest free slot, then reuse it for later installs"
          >
            Add (next free)
          </button>
          <button
            onClick={() =>
              update({ installSlot: settings.installSlot ?? slots?.nextFree ?? 1 })
            }
            className={`px-3 py-1 font-medium transition ${
              !auto ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
            }`}
            title="Always install into a specific pakNN_dir.vpk slot"
          >
            Replace slot
          </button>
        </div>

        {!auto && (
          <label className="inline-flex items-center gap-1.5 text-zinc-400">
            #
            <input
              type="number"
              min={1}
              max={slots?.maxSlot ?? 99}
              value={settings.installSlot ?? 1}
              onChange={(e) => {
                const n = Math.min(
                  slots?.maxSlot ?? 99,
                  Math.max(1, Number(e.target.value) || 1),
                );
                update({ installSlot: n });
              }}
              className="w-16 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200 outline-none focus:border-violet-500/70"
            />
            {fixedTaken && (
              <span className="text-amber-400" title="A file already occupies this slot — it will be backed up and overwritten">
                ⚠ in use
              </span>
            )}
          </label>
        )}

        {auto && (
          <span className="text-zinc-500">
            {slots?.nextFree
              ? `→ ${pakName(slots.nextFree)} (${slots.used.length}/${slots.maxSlot} slots used)`
              : slots
                ? "no free slots — all 99 in use"
                : "set addons folder in Setup"}
          </span>
        )}

        <label className="inline-flex items-center gap-1.5 text-zinc-400">
          <input
            type="checkbox"
            checked={settings.installAfterCompile}
            onChange={(e) => update({ installAfterCompile: e.target.checked })}
            className="accent-emerald-500"
          />
          install after compile
        </label>
        <label className="inline-flex items-center gap-1.5 text-zinc-400" title="Add the citadel/addons search path to gameinfo.gi if it's missing">
          <input
            type="checkbox"
            checked={settings.patchGameinfo}
            onChange={(e) => update({ patchGameinfo: e.target.checked })}
            className="accent-emerald-500"
          />
          patch gameinfo
        </label>

        <button
          onClick={() => void install()}
          disabled={busy || !settings.addonsDir}
          className="ml-auto rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:opacity-40"
          title="Install the last compiled .vpk into the game now"
        >
          {installing ? "Installing…" : "Install to game"}
        </button>
      </div>

      {/* Control row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">
          {(["folder", "vpk"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => update({ outputMode: mode })}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                settings.outputMode === mode
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {mode === "folder" ? "Folder only" : "Pack .vpk"}
            </button>
          ))}
        </div>

        {settings.outputMode === "vpk" && (
          <input
            value={settings.vpkName}
            onChange={(e) => update({ vpkName: e.target.value })}
            spellCheck={false}
            className="w-36 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-violet-500/70"
          />
        )}

        <span className="truncate text-xs text-zinc-500">
          {songCount} song{songCount === 1 ? "" : "s"}
          {modCount > 0 ? ` · ${modCount} mod${modCount === 1 ? "" : "s"}` : ""} →{" "}
          {settings.outputDir}
        </span>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => void compile()}
          disabled={busy || !canCompile}
          className="ml-auto rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 disabled:opacity-40 disabled:shadow-none"
        >
          {running
            ? "Compiling…"
            : settings.installAfterCompile
              ? "Compile & Install"
              : "Compile"}
        </motion.button>
      </div>
    </div>
  );
}
