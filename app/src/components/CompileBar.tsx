import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { compileProject, type CompileReport } from "../lib/api";
import { buildCompileConfig, type Settings } from "../lib/settings";
import { useToast } from "./Toaster";
import type { EventProject } from "../types";

export function CompileBar({
  settings,
  update,
  events,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  events: EventProject[];
}) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CompileReport | null>(null);
  const { push } = useToast();

  const songCount = events.reduce((n, e) => n + e.songs.length, 0);

  async function compile() {
    setRunning(true);
    setReport(null);
    try {
      const config = buildCompileConfig(settings, events);
      const r = await compileProject(config);
      setReport(r);
      if (r.ok) push("success", `Compiled → ${r.outputPath ?? "done"}`);
      else push("error", "Compile failed — see the step report");
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
          {songCount} song{songCount === 1 ? "" : "s"} → {settings.outputDir}
        </span>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => void compile()}
          disabled={running || songCount === 0}
          className="ml-auto rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 disabled:opacity-40 disabled:shadow-none"
        >
          {running ? "Compiling…" : "Compile"}
        </motion.button>
      </div>
    </div>
  );
}
