import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { checkPaths } from "../lib/api";
import type { Settings } from "../lib/settings";

/**
 * First-launch setup. One button runs auto-detect (Steam/Deadlock, CSDK, ffmpeg,
 * the bundled vpk-helper) then imports the current game's music data as the merge
 * base — so a fresh user can compile + install without typing any paths.
 */
export function FirstRunWizard({
  settings,
  onRunSetup,
  onDownloadTools,
  onDone,
}: {
  settings: Settings;
  onRunSetup: () => Promise<void>;
  /** Download the prebuilt compile-tools bundle (trimmed CSDK + ffmpeg) into
   *  app-data and point settings at it — for users without the CSDK. */
  onDownloadTools: () => Promise<void>;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<"intro" | "running" | "done">("intro");
  const [downloading, setDownloading] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean | null>>({});

  const probe = [
    ["Compiler", `${settings.csdkRoot}/game/bin_tools/win64/resourcecompiler.exe`],
    ["VPK helper", settings.vpkHelperPath],
    ["Game pak", settings.deadlockPak],
    ["Addons folder", settings.addonsDir],
    ["Game data", `${settings.vanillaRoot}/soundevents/music.vsndevts`],
  ] as const;

  // Re-check the resulting paths whenever they change (i.e. after setup runs).
  useEffect(() => {
    let cancelled = false;
    checkPaths(probe.map(([, p]) => p))
      .then((res) => {
        if (cancelled) return;
        const m: Record<string, boolean | null> = {};
        probe.forEach(([label], i) => (m[label] = res[i] ?? null));
        setChecks(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.csdkRoot,
    settings.vpkHelperPath,
    settings.deadlockPak,
    settings.addonsDir,
    settings.vanillaRoot,
  ]);

  async function run() {
    setPhase("running");
    try {
      await onRunSetup();
    } finally {
      setPhase("done");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-zinc-100">
          Welcome to Moonah's Mod Maker
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Let's get set up. This finds your Deadlock install and the bundled VPK
          helper, downloads the compile tools if you don't have them (~430 MB,
          includes ffmpeg - they're required, nothing compiles without them),
          then imports the game's current music data so your tracks merge
          cleanly. You can change anything later in Setup.
        </p>

        <div className="mt-4 flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          {probe.map(([label]) => {
            const ok = checks[label] ?? null;
            return (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span
                  className={
                    ok === null
                      ? "text-zinc-600"
                      : ok
                        ? "text-emerald-400"
                        : "text-red-400"
                  }
                >
                  {ok === null ? "•" : ok ? "✓" : "✗"}
                </span>
                <span className="text-zinc-300">{label}</span>
              </div>
            );
          })}
        </div>

        {phase === "running" && (
          <p className="mt-2 text-[11px] text-zinc-500">
            If the compile tools need downloading this takes a few minutes -
            leave the window open.
          </p>
        )}

        {/* Compiler still missing after setup ran → offer a manual retry of
            the download (setup normally grabs it automatically). */}
        {checks["Compiler"] === false && phase === "done" && (
          <button
            onClick={() => {
              setDownloading(true);
              void onDownloadTools().finally(() => setDownloading(false));
            }}
            disabled={downloading}
            className="mt-3 w-full rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:opacity-50"
          >
            {downloading
              ? "Downloading compile tools… (~430 MB, a few minutes)"
              : "⬇ Retry the compile tools download (~430 MB)"}
          </button>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onDone}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
          >
            {phase === "done" ? "Close" : "Skip - I'll set up manually"}
          </button>
          {phase !== "done" ? (
            <button
              onClick={() => void run()}
              disabled={phase === "running"}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {phase === "running" ? "Setting up…" : "✨ Set up automatically"}
            </button>
          ) : (
            <button
              onClick={onDone}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500"
            >
              Get started
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
