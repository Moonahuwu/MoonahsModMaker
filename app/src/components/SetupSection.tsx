import { useEffect, useState } from "react";
import { checkPaths } from "../lib/api";
import type { Settings } from "../lib/settings";

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full rounded-md border border-zinc-700/80 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-violet-500/70"
      />
      {hint && <span className="text-[10px] text-zinc-600">{hint}</span>}
    </label>
  );
}

function Chip({ label, ok }: { label: string; ok: boolean | null }) {
  const cls =
    ok === null
      ? "border-zinc-700 text-zinc-500"
      : ok
        ? "border-emerald-600/40 bg-emerald-500/5 text-emerald-300"
        : "border-red-700/50 bg-red-500/5 text-red-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`}
    >
      <span>{ok === null ? "•" : ok ? "✓" : "✗"}</span>
      {label}
    </span>
  );
}

/** Setup panel content (rendered inside the settings modal). */
export function SetupSection({
  settings,
  update,
  onClose,
  onRefreshVanilla,
  onAutodetect,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onRefreshVanilla: () => Promise<void>;
  onAutodetect: () => Promise<void>;
}) {
  const [checks, setChecks] = useState<Record<string, boolean | null>>({});
  const [busy, setBusy] = useState<null | "detect" | "refresh">(null);

  async function run(which: "detect" | "refresh", fn: () => Promise<void>) {
    setBusy(which);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const compiler = `${settings.csdkRoot}/game/bin_tools/win64/resourcecompiler.exe`;
  const gameinfo = `${settings.csdkRoot}/game/citadel/gameinfo.gi`;
  const musicEvents = `${settings.vanillaRoot}/soundevents/music.vsndevts`;
  const probe = [
    ["Compiler", compiler],
    ["Game", gameinfo],
    ["VPK helper", settings.vpkHelperPath],
    ["Events", musicEvents],
    ["Game pak", settings.deadlockPak],
    ["Addons", settings.addonsDir],
  ] as const;

  useEffect(() => {
    let cancelled = false;
    checkPaths(probe.map(([, p]) => p))
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, boolean | null> = {};
        probe.forEach(([label], i) => (map[label] = res[i] ?? null));
        setChecks(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiler, gameinfo, settings.vpkHelperPath, musicEvents, settings.deadlockPak, settings.addonsDir]);

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Setup</h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {probe.map(([label]) => (
              <Chip key={label} label={label} ok={checks[label] ?? null} />
            ))}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      {/* One-click helpers */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => void run("detect", onAutodetect)}
          disabled={busy !== null}
          className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-50"
        >
          {busy === "detect" ? "Detecting…" : "✨ Auto-detect paths"}
        </button>
        <button
          onClick={() => void run("refresh", onRefreshVanilla)}
          disabled={busy !== null}
          title="Decompile the current game's soundevents so compile uses live data (fixes outdated stock tracks)"
          className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          {busy === "refresh" ? "Refreshing…" : "⟳ Refresh game data"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field
          label="CSDK root"
          value={settings.csdkRoot}
          onChange={(v) => update({ csdkRoot: v })}
          hint="Reduced_CSDK_12 folder"
        />
        <Field
          label="Addon name"
          value={settings.addonName}
          onChange={(v) => update({ addonName: v })}
          hint="content/game citadel_addons/<addon>"
        />
        <Field
          label="VPK helper (.dll/.exe)"
          value={settings.vpkHelperPath}
          onChange={(v) => update({ vpkHelperPath: v })}
        />
        <Field
          label="Game pak (pak01_dir.vpk)"
          value={settings.deadlockPak}
          onChange={(v) => update({ deadlockPak: v })}
          hint="Deadlock install — used to decode stock tracks for comparison"
        />
        <Field
          label="ffmpeg path (blank = PATH)"
          value={settings.ffmpegPath}
          onChange={(v) => update({ ffmpegPath: v })}
        />
        <Field
          label="Sound folder (content-relative)"
          value={settings.soundFolder}
          onChange={(v) => update({ soundFolder: v })}
        />
        <Field
          label="Vanilla soundevents root"
          value={settings.vanillaRoot}
          onChange={(v) => update({ vanillaRoot: v })}
          hint="dir with soundevents/ (your community files with other mods' entries)"
        />
        <Field
          label="Output dir"
          value={settings.outputDir}
          onChange={(v) => update({ outputDir: v })}
        />
        <Field
          label="Deadlock addons folder"
          value={settings.addonsDir}
          onChange={(v) => update({ addonsDir: v })}
          hint="game/citadel/addons — where 'Install to game' copies the .vpk"
        />
      </div>
    </div>
  );
}
