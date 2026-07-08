import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkPaths } from "../lib/api";
import type { Settings } from "../lib/settings";

/** Fill in when the GameBanana page goes up — the credits chip activates. */
const GAMEBANANA_URL = "";

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

/** One settings card: uppercase mini-title + optional badge, content below. */
function Section({
  title,
  badge,
  hint,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400">
        {title}
        {badge}
      </h3>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Checkbox row with an aligned title + description. */
function Toggle({
  checked,
  onChange,
  title,
  desc,
  accent = "accent-emerald-500",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
  accent?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-zinc-900/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={`mt-0.5 ${accent}`}
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-zinc-300">{title}</span>
        <span className="block text-[10px] leading-4 text-zinc-600">{desc}</span>
      </span>
    </label>
  );
}

/** Discord mark (outline-style, currentColor). */
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
    </svg>
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
    <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800 px-6 py-4">
        <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        <Section title="Preferences">
          <div className="flex flex-col gap-1">
            <Toggle
              checked={settings.compareByDefault}
              onChange={(v) => update({ compareByDefault: v })}
              title="Compare to original by default"
              desc="Open the per-track original-vs-yours waveform panel automatically on each song."
            />
          </div>
        </Section>

        <Section
          title="Experimental"
          badge={
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-300">
              WIP
            </span>
          }
          hint="Unfinished features, off by default. Expect rough edges."
        >
          <div className="flex flex-col gap-1">
            <Toggle
              checked={settings.experimentalEffects}
              onChange={(v) => update({ experimentalEffects: v })}
              title="Effects (VFX / particle recolor)"
              desc="Show the Effects tab and per-item effect recoloring. Very work-in-progress."
              accent="accent-amber-500"
            />
            <Toggle
              checked={settings.experimentalServer}
              onChange={(v) => update({ experimentalServer: v })}
              title="Custom Server (config editor / randomizer / hosting)"
              desc="Show the Custom Server tab: gameplay config edits, the randomizer, one-click hosting and the F8 in-game menu."
              accent="accent-amber-500"
            />
            <Toggle
              checked={settings.experimentalUiMaster}
              onChange={(v) => update({ experimentalUiMaster: v })}
              title="UI Master (edit the game's UI files)"
              desc="Browse and edit the game's panorama layouts/styles directly. VERY experimental - a bad edit can break the in-game UI until the mod is removed."
              accent="accent-amber-500"
            />
            <Toggle
              checked={settings.showExperimentalHeroes}
              onChange={(v) => update({ showExperimentalHeroes: v })}
              title="Show experimental heroes"
              desc="Reveal disabled / in-development heroes (unreleased, may lack data) in the Heroes tab."
              accent="accent-amber-500"
            />
            <Toggle
              checked={settings.showUnusedPosters}
              onChange={(v) => update({ showUnusedPosters: v })}
              title="Show unused poster assets"
              desc="Reveal poster sheets/regions marked unused (cut content like Neon Prime leftovers) in the Wall Art tab."
              accent="accent-amber-500"
            />
          </div>
        </Section>

        <Section title="Paths & Tools" hint="Green chips = the file/folder exists where you pointed.">
          <div className="flex flex-wrap items-center gap-1.5">
            {probe.map(([label]) => (
              <Chip key={label} label={label} ok={checks[label] ?? null} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => void run("detect", onAutodetect)}
              disabled={busy !== null}
              className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-50"
            >
              {busy === "detect" ? "Detecting…" : "✦ Auto-detect paths"}
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
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
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
              hint="Deadlock install - used to decode stock tracks for comparison"
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
              hint="VRF's Source2Viewer.exe - enables 'Open in real viewer' for effects"
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
              hint="game/citadel/addons - where 'Install to game' copies the .vpk"
            />
          </div>
        </Section>
      </div>

      {/* Credits */}
      <footer className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-6 py-3">
        <span className="text-[11px] text-zinc-500">
          Made by <span className="font-semibold text-zinc-300">Moonah</span>
        </span>
        <span
          title="Discord"
          className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300"
        >
          <DiscordIcon className="h-3.5 w-3.5" />
          moonah
        </span>
        {GAMEBANANA_URL ? (
          <button
            onClick={() => void openUrl(GAMEBANANA_URL)}
            className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1 text-[11px] font-medium text-yellow-300 transition hover:bg-yellow-500/20"
          >
            GameBanana
          </button>
        ) : (
          <span
            title="GameBanana page coming soon"
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-600"
          >
            GameBanana - soon
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-700">Moonah's Mod Maker</span>
      </footer>
    </div>
  );
}
