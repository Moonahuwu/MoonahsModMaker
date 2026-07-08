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
  onRefreshVanilla: () => Promise<unknown>;
  onAutodetect: () => Promise<unknown>;
}) {
  const [checks, setChecks] = useState<Record<string, boolean | null>>({});
  const [busy, setBusy] = useState<null | "detect" | "refresh">(null);

  async function run(which: "detect" | "refresh", fn: () => Promise<unknown>) {
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
        <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      {/* Preferences */}
      <div className="mb-5 flex flex-col gap-2">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.compareByDefault}
            onChange={(e) => update({ compareByDefault: e.target.checked })}
            className="accent-emerald-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            Compare to original by default
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Open the per-track original-vs-yours waveform panel automatically on each
          song.
        </p>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.showExperimentalHeroes}
            onChange={(e) => update({ showExperimentalHeroes: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            Show experimental heroes
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Reveal disabled / in-development heroes (unreleased, may lack data) in the
          Heroes tab.
        </p>
      </div>

      {/* Experimental — opt-in, work-in-progress features */}
      <div className="mb-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">
          Experimental
          <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 align-middle">
            WIP
          </span>
        </h3>
        <p className="mt-1 mb-2 text-[10px] text-zinc-600">
          Unfinished features, off by default. Expect rough edges.
        </p>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.experimentalEffects}
            onChange={(e) => update({ experimentalEffects: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            Effects (VFX / particle recolor)
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Show the Effects tab and per-item effect recoloring. Very work-in-progress.
        </p>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.experimentalServer}
            onChange={(e) => update({ experimentalServer: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            Custom Server (config editor / randomizer / hosting)
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Show the Custom Server tab: gameplay config edits, the randomizer, one-click
          hosting and the F8 in-game menu.
        </p>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.experimentalUiMaster}
            onChange={(e) => update({ experimentalUiMaster: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            UI Master (edit the game's UI files)
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Browse and edit the game's panorama layouts/styles directly. VERY experimental —
          a bad edit can break the in-game UI until the mod is removed.
        </p>
        <label className="mt-2 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={settings.showUnusedPosters}
            onChange={(e) => update({ showUnusedPosters: e.target.checked })}
            className="accent-amber-500"
          />
          <span className="text-xs font-medium text-zinc-300">
            Show unused poster assets
          </span>
        </label>
        <p className="-mt-1 pl-6 text-[10px] text-zinc-600">
          Reveal poster sheets/regions marked "unused" (cut content like Neon Prime
          leftovers) in the Posters tab so they can be edited or unmarked.
        </p>
      </div>

      {/* Setup — tool & game paths */}
      <div className="mb-3 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">Setup</h3>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {probe.map(([label]) => (
            <Chip key={label} label={label} ok={checks[label] ?? null} />
          ))}
        </div>
      </div>

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
          label="Source2Viewer path (optional)"
          value={settings.source2ViewerPath}
          onChange={(v) => update({ source2ViewerPath: v })}
          hint="VRF's Source2Viewer.exe — enables 'Open in real viewer' for effects"
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
