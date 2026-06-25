import { AnimatePresence, motion } from "motion/react";
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

export function SetupSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean | null>>({});

  // Validate the critical derived/explicit paths whenever they change.
  const compiler = `${settings.csdkRoot}/game/bin_tools/win64/resourcecompiler.exe`;
  const gameinfo = `${settings.csdkRoot}/game/citadel/gameinfo.gi`;
  const musicEvents = `${settings.vanillaRoot}/soundevents/music.vsndevts`;
  const probe = [
    ["Compiler", compiler],
    ["Game", gameinfo],
    ["VPK helper", settings.vpkHelperPath],
    ["Events", musicEvents],
    ["Game pak", settings.deadlockPak],
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
  }, [
    compiler,
    gameinfo,
    settings.vpkHelperPath,
    musicEvents,
    settings.deadlockPak,
  ]);

  const allValid = probe.every(([label]) => checks[label]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm font-medium text-zinc-300">Setup</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {probe.map(([label]) => (
            <Chip key={label} label={label} ok={checks[label] ?? null} />
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          {allValid ? "all good" : "needs attention"}
          <motion.span animate={{ rotate: open ? 90 : 0 }}>›</motion.span>
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 gap-3 border-t border-zinc-800 p-4 md:grid-cols-2">
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
