import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  compileProject,
  fileStamp,
  runningProcesses,
  installToGame,
  launchGame,
  packUnchangedFiles,
  scanAddonSlots,
  scanPackContents,
  type CompileReport,
  type SlotScan,
} from "../lib/api";
import { cItemRoster } from "../lib/dataCache";
import { BuildPreview, type PreviewMod, type YoursFile } from "./BuildPreview";
import { ExportModal, type ExportExtra, type ExportSlot } from "./ExportModal";
import { buildCompileConfig, directReplaceTarget, installSrcVpk, sheetSiblingsKey, slotSoundFolder, worldOverrideCategory, type Settings } from "../lib/settings";
import { songStatus, overrideHash, effectHash, posterHash } from "../lib/songHash";
import { useToast } from "./Toaster";
import type { DigimodConfig, EffectOverride, EventProject, GlobalOverride, IconMod, PosterOverride, SoundOverride, UiFileOverride, VdataOverride, WorldOverride } from "../types";

const pakName = (n: number) => `pak${String(n).padStart(2, "0")}_dir.vpk`;

export function CompileBar({
  settings,
  update,
  events,
  iconMods,
  soundOverrides,
  effectOverrides,
  vdataOverrides,
  globalOverrides,
  worldOverrides,
  posterOverrides,
  digimod,
  uiOverrides,
  pools,
  onCompiled,
  onFixForNewPatch,
  onBulkGain,
  tabLabels,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  events: EventProject[];
  iconMods: IconMod[];
  soundOverrides: SoundOverride[];
  effectOverrides: EffectOverride[];
  vdataOverrides: VdataOverride[];
  globalOverrides: GlobalOverride[];
  worldOverrides: WorldOverride[];
  posterOverrides: PosterOverride[];
  digimod: DigimodConfig | null;
  uiOverrides: UiFileOverride[];
  /** Live event views by slot id - unlocks the direct-replace shortcut (a
   *  slot swapping its only sound skips the events file entirely). */
  pools: Record<string, { vsndDuration: number | null; entries?: string[] } | undefined>;
  /** Called after a successful compile so the project can record compiled hashes. */
  onCompiled: () => void;
  /** Nudge every track's + replacement's gain by `delta` dB (loudness leveling). */
  onBulkGain: (delta: number) => void;
  /** Re-pull the live game's soundevents (pak01) into the merge base and fix
   *  drifted stock refs; resolves to the corrected events + the refreshed
   *  vanillaRoot (or null on failure). */
  onFixForNewPatch: () => Promise<{ events: EventProject[]; vanillaRoot: string } | null>;
  /** Tab display names (for grouping in the export picker). */
  tabLabels: Record<string, string>;
}) {
  const [running, setRunning] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [report, setReport] = useState<CompileReport | null>(null);
  const [slots, setSlots] = useState<SlotScan | null>(null);
  const { push } = useToast();

  // Live compile feed: the backend emits every pipeline step as it happens.
  const [feed, setFeed] = useState<{ name: string; ok: boolean; detail: string }[]>([]);
  // Pipeline progress 0–100 for the bar along the footer's bottom edge
  // (backend steps carry a pct from the step-budget forecast; 100 is set
  // locally when the run finishes). null = no run / indeterminate.
  const [pct, setPct] = useState<number | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const un = listen<{ name: string; ok: boolean; detail: string; pct?: number }>(
      "compile://progress",
      (e) => {
        setFeed((prev) => [...prev.slice(-199), e.payload]);
        if (typeof e.payload.pct === "number")
          setPct((prev) => Math.max(prev ?? 0, e.payload.pct!));
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, []);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [feed]);

  const songCount = events.reduce((n, e) => n + e.songs.length, 0);
  const modCount = settings.importedMods.length;
  // "Compiled and installed just now" — drives the success banner.
  const [success, setSuccess] = useState<{ path?: string; secs?: number } | null>(null);

  // Lock-risk warning: Deadlock or Source 2 Viewer holding the pak/addons
  // open makes compiles + installs fail in confusing ways. Polled while the
  // bar is visible; also refreshed right before a compile starts.
  const [lockRisks, setLockRisks] = useState<string[]>([]);
  const pollLocks = useCallback(async () => {
    try {
      setLockRisks(
        await runningProcesses(["deadlock.exe", "citadel.exe", "Source2Viewer.exe", "VRF.exe"]),
      );
    } catch {
      /* warning is best-effort */
    }
  }, []);
  useEffect(() => {
    void pollLocks();
    const t = setInterval(() => void pollLocks(), 15000);
    return () => clearInterval(t);
  }, [pollLocks]);
  const lockWarning =
    lockRisks.length === 0
      ? null
      : lockRisks.some((p) => p.startsWith("deadlock") || p.startsWith("citadel"))
        ? "Deadlock is running - close it (or at least stay in the menu) or installs can fail on locked files"
        : "Source 2 Viewer is open - if it has the game pak loaded, compiles that read it can fail";

  // Game-update detection: pak01's identity vs. the stamp saved at the last
  // patch-fix. A mismatch surfaces the big "Fix for new patch" button; the
  // rest of the time it stays out of the way (a copy lives under Options).
  // First run just seeds the baseline - the wizard imported from this pak.
  const [patchDetected, setPatchDetected] = useState(false);
  const pakStampRef = useRef("");
  useEffect(() => {
    if (!settings.deadlockPak) return;
    let cancelled = false;
    void fileStamp(settings.deadlockPak).then((stamp) => {
      if (cancelled || !stamp) return;
      pakStampRef.current = stamp;
      if (!settings.lastPakStamp) update({ lastPakStamp: stamp });
      else setPatchDetected(stamp !== settings.lastPakStamp);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.deadlockPak]);

  // How many items changed since their last successful compile — the pulse +
  // chip on the Compile button, so a needed recompile is never a guess.
  const changedN = useMemo(() => {
    let n = 0;
    for (const e of events) for (const s of e.songs) if (songStatus(s) !== "compiled") n++;
    for (const o of soundOverrides)
      if (!o.lastCompiledHash || overrideHash(o) !== o.lastCompiledHash) n++;
    for (const e of effectOverrides)
      if (!e.lastCompiledHash || effectHash(e) !== e.lastCompiledHash) n++;
    for (const p of posterOverrides)
      if (
        !p.lastCompiledHash ||
        posterHash(p, sheetSiblingsKey(posterOverrides, p.sheetId)) !== p.lastCompiledHash
      )
        n++;
    return n;
  }, [events, soundOverrides, effectOverrides, posterOverrides]);

  /** Launch Deadlock (used by the one-shot button and the success banner). */
  async function launchOnly() {
    setLaunching(true);
    try {
      const root = settings.deadlockPak
        ? settings.deadlockPak.replace(/[\\/]/g, "/").split("/").slice(0, -3).join("/")
        : undefined;
      await launchGame(root);
      push("success", "Launching Deadlock…");
    } catch (e) {
      push("error", `Launch failed: ${e}`);
    } finally {
      setLaunching(false);
    }
  }
  const canCompile =
    songCount > 0 ||
    modCount > 0 ||
    iconMods.length > 0 ||
    soundOverrides.length > 0 ||
    effectOverrides.length > 0 ||
    posterOverrides.length > 0 ||
    (digimod != null &&
      (digimod.scares.length > 0 ||
        digimod.deaths.length > 0 ||
        (digimod.mergeVpks?.length ?? 0) > 0)) ||
    uiOverrides.length > 0 ||
    (settings.includeGameplay &&
      (vdataOverrides.length > 0 || globalOverrides.length > 0 || worldOverrides.length > 0));

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

  async function compile(
    eventsArg: EventProject[] = events,
    // fixForNewPatch passes the refreshed settings explicitly — the `settings`
    // prop in this closure predates the refresh (stale vanillaRoot).
    settingsArg: Settings = settings,
  ): Promise<boolean> {
    const s = settingsArg;
    setRunning(true);
    setReport(null);
    setFeed([]);
    setPct(0);
    setSuccess(null);
    void pollLocks();
    const startedAt = Date.now();
    try {
      // UI soundevent changes make broad, breakage-prone menu edits — excluded
      // from the build unless explicitly enabled (toggle on the UI tab).
      const evts = s.includeUiSounds
        ? eventsArg
        : eventsArg.filter((e) => e.group !== "ui");
      // Gameplay (vdata + global + world) edits are server-only — excluded unless opted in.
      // Drop per-entity exclusions and whole-category exclusions (`__cat:*`).
      const ex = new Set(s.excludedConfigKeys);
      // Heroes & items share the vdata override type — classify by the item roster.
      let itemNames = new Set<string>();
      if (s.includeGameplay && (ex.has("__cat:heroes") || ex.has("__cat:items"))) {
        try {
          itemNames = new Set((await cItemRoster(s.vpkHelperPath, s.deadlockPak)).map((i) => i.name));
        } catch {
          /* if the roster can't load, fall back to keeping everything */
        }
      }
      const gameplay = s.includeGameplay
        ? vdataOverrides.filter((o) => {
            if (ex.has(o.abilityKey)) return false;
            const isItem = itemNames.has(o.abilityKey);
            if (isItem && ex.has("__cat:items")) return false;
            if (!isItem && ex.has("__cat:heroes")) return false;
            return true;
          })
        : [];
      const global = s.includeGameplay && !ex.has("__cat:global") ? globalOverrides : [];
      const world = s.includeGameplay
        ? worldOverrides.filter((o) => {
            if (ex.has(`${o.file}::${o.entity}`)) return false;
            // Shared classifier (settings.ts) - the editor's chips use the
            // same one, so a chip can't silently stop matching the gate.
            const cat = worldOverrideCategory(o.file, o.entity);
            return cat === "other" || !ex.has(`__cat:${cat}`);
          })
        : [];
      const config = buildCompileConfig(s, evts, false, iconMods, soundOverrides, effectOverrides, gameplay, global, world, posterOverrides, digimod, uiOverrides, pools);
      const r = await compileProject(config);
      setReport(r);
      if (r.ok) {
        onCompiled();
        push("success", `Compiled → ${r.outputPath ?? "done"}`);
        if (s.installAfterCompile) await install();
        setSuccess({
          path: r.outputPath ?? undefined,
          secs: Math.round((Date.now() - startedAt) / 1000),
        });
        return true;
      }
      // Partial success: soft failures didn't stop the build — an artifact
      // exists, the broken items are listed in red (and rolled up at the end).
      const failedN = r.steps.filter((st) => !st.ok && !st.name.startsWith("⚠")).length;
      if (r.outputPath) {
        push(
          "info",
          `Compiled with ${failedN} failed item(s) - everything else built. See the red steps; failed items retry next compile.`,
        );
        return false;
      }
      push("error", "Compile failed - see the step report");
      return false;
    } catch (e) {
      setReport({ ok: false, steps: [{ name: "invoke", ok: false, detail: String(e) }] });
      push("error", String(e));
      return false;
    } finally {
      setRunning(false);
      // Land the bar on 100 briefly, then clear it.
      setPct(100);
      setTimeout(() => setPct(null), 1500);
    }
  }

  /** Full one-shot: compile → install → launch Deadlock to test the mod. */
  async function compileAndLaunch() {
    if (!(await compile())) return;
    // compile() already installs when "install after compile" is on; otherwise
    // install now so the launched game picks up the new build.
    if (!settings.installAfterCompile && !(await install())) return;
    await launchOnly();
  }

  /** One-stop patch fix: re-pull the live game's soundevents (pak01) into the
   *  merge base, repair every drifted stock ref, then recompile against the
   *  fresh data so the output .vpk is ready for the new patch. */
  async function fixForNewPatch() {
    setFixing(true);
    try {
      const fixed = await onFixForNewPatch();
      if (fixed === null) return; // refresh failed - toast already shown
      // Recompile with the freshly-corrected events AND the refreshed
      // vanillaRoot (avoids racing React state/settings — the props in this
      // closure predate the refresh). Nothing to build? The refresh +
      // stock-ref repair already happened.
      if (canCompile)
        await compile(fixed.events, { ...settings, vanillaRoot: fixed.vanillaRoot });
      // The mods now match this pak - remember it so the "game updated"
      // prompt stands down until the next real patch.
      const stamp = pakStampRef.current || (await fileStamp(settings.deadlockPak));
      if (stamp) update({ lastPakStamp: stamp });
      setPatchDetected(false);
    } finally {
      setFixing(false);
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
  const busy = running || installing || launching || fixing;

  // ---- Build preview: what the next compile puts in the .vpk -------------
  const [preview, setPreview] = useState<{ yours: YoursFile[]; mods: PreviewMod[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  /** Your own files, mirrored from the compile's staging rules, each tagged
   *  with whether it's new / changed / unchanged since the last compile
   *  (drives the preview's "New & changed" filter). */
  function yoursManifest(): { path: string; status: "new" | "changed" | "unchanged" }[] {
    const s = settings;
    const evts = s.includeUiSounds ? events : events.filter((e) => e.group !== "ui");
    const out = new Map<string, "new" | "changed" | "unchanged">();
    const add = (path: string, status: "new" | "changed" | "unchanged") => {
      const cur = out.get(path);
      // new > changed > unchanged when the same path appears twice.
      if (cur === "new" || (cur === "changed" && status === "unchanged")) return;
      out.set(path, status);
    };
    const ofSong = (st: string) => (st === "new" ? "new" : st === "stale" ? "changed" : "unchanged") as
      | "new"
      | "changed"
      | "unchanged";
    const overrideRefs = new Set(soundOverrides.map((o) => o.targetRef));
    for (const ev of evts) {
      // Direct replace ships ONE file at the original path - no events file.
      const direct = directReplaceTarget(ev, overrideRefs, pools);
      if (direct) {
        add(direct.replace(/\.vsnd$/, ".vsnd_c"), ofSong(songStatus(ev.songs[0])));
        continue;
      }
      const folder = slotSoundFolder(ev, s.soundFolder).replace(/\/+$/, "");
      let evDirty: "new" | "changed" | "unchanged" = "unchanged";
      for (const song of ev.songs) {
        const st = ofSong(songStatus(song));
        if (st !== "unchanged") evDirty = "changed";
        add(`${folder}/${song.soundName}.vsnd_c`, st);
      }
      for (const a of ev.adopted) {
        if (ev.excludedEntries.includes(a.reference) || ev.removedEntries.includes(a.reference))
          continue;
        add(a.reference.replace(/\.vsnd$/, ".vsnd_c"), "unchanged");
      }
      if (ev.songs.length || ev.adopted.length || ev.excludedEntries.length || ev.removedEntries.length)
        add(`${ev.eventsRelpath}_c`, evDirty);
    }
    for (const o of soundOverrides)
      add(
        o.targetRef.replace(/\.vsnd$/, ".vsnd_c"),
        !o.lastCompiledHash ? "new" : overrideHash(o) === o.lastCompiledHash ? "unchanged" : "changed",
      );
    for (const i of iconMods) add(i.targetVtexc, "unchanged");
    for (const e of effectOverrides)
      add(
        `${e.targetRef}_c`,
        !e.lastCompiledHash ? "new" : effectHash(e) === e.lastCompiledHash ? "unchanged" : "changed",
      );
    if (s.includeGameplay) {
      if (vdataOverrides.length) add("scripts/abilities.vdata_c", "unchanged");
      if (globalOverrides.length) add("scripts/generic_data.vdata_c", "unchanged");
      if (worldOverrides.length) add("scripts/npc_units.vdata_c", "unchanged");
    }
    return [...out.entries()].map(([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
  }

  function previewModName(source: string): string {
    const parts = source.replace(/\\/g, "/").split("/");
    const file = parts.pop() ?? source;
    const stem = file.replace(/\.vpk$/i, "").replace(/_[0-9a-f]{8}$/i, "");
    return /^pak\d+_dir$/i.test(stem) ? (parts.pop() ?? stem) : stem;
  }

  async function openPreview() {
    setPreviewLoading(true);
    try {
      const mods: PreviewMod[] = [];
      for (const m of settings.importedMods) {
        const c = await scanPackContents(settings.vpkHelperPath, settings.deadlockPak, m);
        // Bundled files byte-identical to the game's originals (best-effort —
        // an empty list just means the changed-filter hides nothing extra).
        let unchanged: string[] = [];
        try {
          unchanged = await packUnchangedFiles(settings.vpkHelperPath, settings.deadlockPak, m);
        } catch {
          /* best effort */
        }
        mods.push({
          source: m,
          name: previewModName(m),
          // Every category ships since the stage-everything change -
          // "other" (scripts/cfg/resource/...) included. Leaving a category
          // out of this list is destructive: Save replaces the mod's whole
          // exclude entry from it, wiping Import Review deselections.
          files: [
            ...c.overwrites,
            ...c.ownSounds,
            ...c.models,
            ...c.particles,
            ...c.materials,
            ...c.panorama,
            ...c.other,
          ].sort(),
          initialExcluded: settings.importedModExcludes?.[m] ?? [],
          skipped: 0,
          unchanged,
        });
      }
      setPreview({ yours: yoursManifest(), mods });
    } catch (e) {
      push("error", `Build preview failed: ${e}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  // ---- Partial export: compile a chosen subset into its own .vpk ---------
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportSlots: ExportSlot[] = events
    .filter((e) => e.songs.length > 0 || e.adopted.length > 0)
    .map((e) => ({
      id: e.id,
      label: e.side || e.eventName,
      groupLabel: tabLabels[e.group] ?? e.group,
      tracks: e.songs.length + e.adopted.length,
    }));
  const exportExtras: ExportExtra[] = [
    ...soundOverrides.map((o) => ({
      id: `ov:${o.id}`,
      label: o.targetRef.split("/").pop()?.replace(/\.vsnd$/, "") ?? o.targetRef,
      section: "Replaced sounds",
    })),
    ...iconMods.map((m) => ({ id: `ic:${m.id}`, label: m.name, section: "Custom icons" })),
    ...effectOverrides.map((e) => ({
      id: `fx:${e.id}`,
      label: e.targetRef.split("/").pop() ?? e.targetRef,
      section: "VFX recolors",
    })),
  ];

  async function runExport(slotIds: Set<string>, extraIds: Set<string>) {
    const dir = await openDialog({ directory: true, title: "Export the .vpk into which folder?" });
    if (!dir || Array.isArray(dir)) return;
    setExporting(true);
    setFeed([]);
    try {
      const evts = events.filter((e) => slotIds.has(e.id));
      const ovs = soundOverrides.filter((o) => extraIds.has(`ov:${o.id}`));
      const icons = iconMods.filter((m) => extraIds.has(`ic:${m.id}`));
      const fx = effectOverrides.filter((e) => extraIds.has(`fx:${e.id}`));
      // Same pipeline as a normal compile, but only the selection, no bundled
      // mods, and output into the chosen folder (the vpk lands in `mine/`).
      const s2: Settings = {
        ...settings,
        outputDir: dir,
        outputMode: "vpk",
        importedMods: [],
        importedModExcludes: {},
      };
      const config = { ...buildCompileConfig(s2, evts, false, icons, ovs, fx, [], [], [], [], null, [], pools), exportOnly: true };
      const r = await compileProject(config);
      if (r.ok) {
        push("success", `Exported → ${r.outputPath ?? dir}`);
        if (r.outputPath) {
          try {
            await revealItemInDir(r.outputPath);
          } catch {
            /* ignore */
          }
        }
        setExportOpen(false);
      } else {
        setReport(r);
        push("error", "Export failed - see the step report");
      }
    } catch (e) {
      push("error", `Export failed: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  function savePreview(excludes: Record<string, string[]>) {
    const merged = { ...(settings.importedModExcludes ?? {}) };
    let dropped = 0;
    for (const [src, list] of Object.entries(excludes)) {
      dropped += list.length;
      if (list.length > 0) merged[src] = list;
      else delete merged[src];
    }
    update({ importedModExcludes: merged });
    setPreview(null);
    push(
      "success",
      dropped > 0
        ? `Build selection saved - ${dropped} file(s) stay out of the combined build`
        : "Build selection saved",
    );
  }

  return (
    // -mx-6/-mb-4 cancel <main>'s padding so the bar runs edge-to-edge with no
    // see-through gap beneath it when scrolled to the bottom.
    <div className="relative z-30 shrink-0 border-t border-zinc-800 bg-zinc-950/85 px-6 py-3 backdrop-blur">
      {/* The compile crew: rem leads, chudlings follow, hopping in a wave.
          They stroll on top of the bar while a compile runs. */}
      {running && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-9 right-10 flex items-end gap-2.5 opacity-90"
        >
          <span className="eim-crew-walk">
            <img src="/loading/rem.svg" alt="" className="h-9 w-auto" />
          </span>
          {[0, 1, 2].map((i) => (
            <span key={i} className="eim-crew-jump" style={{ animationDelay: `${1.2 + i * 0.3}s` }}>
              <span className="eim-crew-walk" style={{ animationDelay: `${0.15 + i * 0.2}s` }}>
                <img src="/loading/chudling.svg" alt="" className="h-5 w-auto" />
              </span>
            </span>
          ))}
        </div>
      )}
      {/* Compile progress: a slim bar along the footer's bottom edge. */}
      {pct !== null && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden">
          <div
            className={`h-full transition-[width] duration-300 ease-out ${
              pct >= 100
                ? "bg-emerald-400"
                : "bg-gradient-to-r from-emerald-600 via-emerald-400 to-emerald-300"
            }`}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
      )}
      {/* Partial export picker + build preview: portaled to <body>. This
          bar's backdrop-blur makes it the containing block for fixed
          descendants, which would pin the "fullscreen" modals inside the
          bottom bar (they rendered off screen). */}
      {createPortal(
        <AnimatePresence>
          {exportOpen && (
            <ExportModal
              slots={exportSlots}
              extras={exportExtras}
              busy={exporting}
              onCancel={() => !exporting && setExportOpen(false)}
              onExport={(s, x) => void runExport(s, x)}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}

      {createPortal(
        <AnimatePresence>
          {preview && (
            <BuildPreview
              yours={preview.yours}
              mods={preview.mods}
              onCancel={() => setPreview(null)}
              onSave={savePreview}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* Live compile feed — each pipeline step streams in as it runs. */}
      <AnimatePresence>
        {running && feed.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mb-3 rounded-lg border border-zinc-800 bg-black/50 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
                Compiling… <span className="text-zinc-600">{feed.length} step{feed.length === 1 ? "" : "s"}</span>
              </div>
              <div ref={feedRef} className="max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {feed.map((s, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className={s.ok ? "text-emerald-500" : "text-red-500"}>{s.ok ? "✓" : "✗"}</span>
                    <span className={`shrink-0 ${s.ok ? "text-zinc-400" : "text-red-300"}`}>{s.name}</span>
                    {s.detail && <span className="truncate text-zinc-600">{s.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
                <button
                  onClick={() => {
                    const text = report.steps
                      .map((s) => `${s.ok ? "OK " : "FAIL"} ${s.name}${s.detail ? ` - ${s.detail}` : ""}`)
                      .join("\n");
                    void navigator.clipboard
                      .writeText(`Compile ${report.ok ? "succeeded" : "failed"}\n${text}`)
                      .then(() => push("success", "Report copied - paste it anywhere"));
                  }}
                  title="Copy every step of this report as text (for bug reports and troubleshooting)"
                  className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                >
                  ⧉ Copy report
                </button>
                {report.outputPath && (
                  <button
                    onClick={openOutput}
                    className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
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

      {/* Install & output options — set once, rarely touched, so tucked away.
          The big buttons cover the common path. */}
      <AnimatePresence>
        {showOptions && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            {/* Pack summary: everything this profile ships, at a glance. */}
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-xs text-zinc-400">
              <span className="font-semibold text-zinc-300">Your pack:</span>
              <span>{songCount} track{songCount === 1 ? "" : "s"}</span>
              {soundOverrides.length > 0 && <span>{soundOverrides.length} sound repl.</span>}
              {posterOverrides.filter((p) => !p.erase).length > 0 && (
                <span>{posterOverrides.filter((p) => !p.erase).length} wall art</span>
              )}
              {posterOverrides.filter((p) => p.erase).length > 0 && (
                <span>{posterOverrides.filter((p) => p.erase).length} hidden decal(s)</span>
              )}
              {iconMods.length > 0 && <span>{iconMods.length} image(s)</span>}
              {effectOverrides.length > 0 && <span>{effectOverrides.length} effect(s)</span>}
              {modCount > 0 && <span>{modCount} merged mod(s)</span>}
              <span className="ml-auto flex items-center gap-1.5 text-zinc-500">
                Bulk gain
                <button
                  onClick={() => onBulkGain(-1)}
                  title="Lower every track's and replacement's gain by 1 dB"
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:border-zinc-500"
                >
                  −1 dB
                </button>
                <button
                  onClick={() => onBulkGain(1)}
                  title="Raise every track's and replacement's gain by 1 dB"
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:border-zinc-500"
                >
                  +1 dB
                </button>
              </span>
            </div>
            {/* Where the mod lands in the game. The slot decides the in-game
                pakNN name - shown in both modes so that's never a mystery. */}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 font-medium text-zinc-400">Game slot</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">
                <button
                  onClick={() => update({ installSlot: null })}
                  className={`px-3 py-1 font-medium transition ${
                    auto ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                  title="Install into the lowest free addon slot"
                >
                  Auto (next free)
                </button>
                <button
                  onClick={() =>
                    update({ installSlot: settings.installSlot ?? slots?.nextFree ?? 1 })
                  }
                  className={`px-3 py-1 font-medium transition ${
                    !auto ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                  title="Always install into this exact slot, replacing whatever is there (it gets backed up)"
                >
                  Always slot
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
                    <span className="text-amber-400" title="A file already occupies this slot - it will be backed up and overwritten">
                      ⚠ in use
                    </span>
                  )}
                </label>
              )}

              <span className="text-zinc-500">
                {auto
                  ? slots?.nextFree
                    ? `installs as ${pakName(slots.nextFree)} (${slots.used.length}/${slots.maxSlot} slots used)`
                    : slots
                      ? "no free slots - all 99 in use"
                      : "set addons folder in Setup"
                  : `installs as ${pakName(settings.installSlot ?? 1)}`}
              </span>

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
                onClick={() => setExportOpen(true)}
                disabled={busy || exporting}
                className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
                title="Compile a chosen subset of your pack into its own standalone .vpk"
              >
                ▤ Export…
              </button>
              <button
                onClick={() => void openPreview()}
                disabled={busy || previewLoading}
                className="rounded-md border border-zinc-700 px-3 py-1.5 font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
                title="See every file the next compile will put in the .vpk - and deselect bundled files you don't want"
              >
                {previewLoading ? "Scanning…" : "◎ Preview build"}
              </button>
              <button
                onClick={() => void install()}
                disabled={busy || !settings.addonsDir}
                className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:opacity-40"
                title="Install the last compiled .vpk into the game now"
              >
                {installing ? "Installing…" : "Install to game"}
              </button>
            </div>

            {/* The build folder on disk - separate from the game slot above.
                Rarely touched, so it reads quieter. */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="w-16 font-medium text-zinc-400">Build file</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">
                {(["vpk", "folder"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => update({ outputMode: mode })}
                    title={
                      mode === "vpk"
                        ? "Pack the build into a .vpk (what installing needs)"
                        : "Leave the build as loose files - for inspecting or packing yourself"
                    }
                    className={`px-3 py-1 font-medium transition ${
                      settings.outputMode === mode
                        ? "bg-zinc-100 text-zinc-900"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {mode === "folder" ? "Loose folder" : "Pack .vpk"}
                  </button>
                ))}
              </div>
              {settings.outputMode === "vpk" && (
                <input
                  value={settings.vpkName}
                  onChange={(e) => update({ vpkName: e.target.value })}
                  spellCheck={false}
                  title="The file name in your output folder only - in the game it's renamed to the slot's pakNN name above"
                  className="w-36 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200 outline-none focus:border-violet-500/70"
                />
              )}
              <span className="truncate text-zinc-600">→ {settings.outputDir}</span>
              <button
                onClick={() => void fixForNewPatch()}
                disabled={busy || !settings.deadlockPak}
                title="Re-pull the live game's sound data, repair drifted stock tracks, recompile. The big amber button offers this by itself when a game update is detected - this is the run-it-anyway trigger."
                className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 font-medium text-zinc-400 transition hover:border-amber-500/60 hover:text-amber-200 disabled:opacity-40"
              >
                {fixing ? "Fixing…" : "⚙ Fix for new patch"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Danger stripe: something is holding game files open. */}
      {lockWarning && (
        <div className="eim-danger-stripe mb-2 flex items-center gap-2 rounded-lg border border-amber-500/50 px-3 py-1.5 text-xs font-medium text-amber-200">
          ⚠ {lockWarning}
        </div>
      )}

      {/* Post-compile success moment: close the loop right here. */}
      <AnimatePresence>
        {success && !running && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2"
          >
            <span className="text-sm font-semibold text-emerald-300">
              ✓ Compiled{success.secs !== undefined ? ` in ${success.secs}s` : ""}
            </span>
            {success.path && (
              <span className="min-w-0 truncate text-xs text-zinc-500" title={success.path}>
                {success.path}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              {!settings.installAfterCompile && (
                <button
                  onClick={() => void install()}
                  disabled={installing}
                  className="rounded-md border border-emerald-500/50 px-3 py-1 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/15 disabled:opacity-50"
                >
                  {installing ? "Installing…" : "Install"}
                </button>
              )}
              <button
                onClick={() => void launchOnly()}
                disabled={launching}
                className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {launching ? "Launching…" : "▶ Launch game"}
              </button>
              <button
                onClick={() => setSuccess(null)}
                className="rounded-md px-1.5 text-xs text-zinc-500 hover:text-zinc-300"
              >
                ✕
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Control row — the only row visible by default. "Fix for new patch"
          appears only when pak01 actually changed since the last fix (a copy
          always lives under Options for manual runs). */}
      <div className="flex flex-wrap items-center gap-3">
        {(patchDetected || fixing) && (
          <motion.button
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => void fixForNewPatch()}
            disabled={busy || !settings.deadlockPak}
            title="Deadlock updated since your last fix. One click: re-pull the live game's sound data, repair every drifted stock track, then recompile your mods against the new patch."
            className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40"
          >
            {fixing ? "Fixing…" : "⚙ Game updated - fix my mods"}
          </motion.button>
        )}

        <button
          onClick={() => setShowOptions((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${
            showOptions
              ? "border-zinc-500 text-zinc-200"
              : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          }`}
          title="Game slot, build output, export / preview, patch fix"
        >
          Options {showOptions ? "▴" : "▾"}
        </button>

        <span className="truncate text-xs text-zinc-500">
          {songCount} song{songCount === 1 ? "" : "s"}
          {modCount > 0 ? ` · ${modCount} mod${modCount === 1 ? "" : "s"}` : ""}
          {auto && slots?.nextFree
            ? ` · installs to ${pakName(slots.nextFree)}`
            : !auto
              ? ` · installs to ${pakName(settings.installSlot ?? 1)}`
              : ""}
        </span>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => void compile()}
            disabled={busy || !canCompile}
            className={`rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 disabled:opacity-40 disabled:shadow-none${
              changedN > 0 && !busy ? " eim-pulse" : ""
            }`}
            title={changedN > 0 ? `${changedN} item(s) changed since the last compile` : undefined}
          >
            {running
              ? `Compiling… ${pct !== null ? `${Math.min(pct, 99)}%` : ""}`
              : settings.installAfterCompile
                ? "Compile & Install"
                : "Compile"}
            {changedN > 0 && !running && (
              <span className="ml-2 rounded bg-white/20 px-1.5 text-[11px] tabular-nums">
                {changedN}
              </span>
            )}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => void compileAndLaunch()}
            disabled={busy || !canCompile}
            title="Compile, install into the game, then launch Deadlock to test it"
            className="rounded-lg border border-violet-500/50 bg-violet-600/90 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 transition hover:bg-violet-500 disabled:opacity-40 disabled:shadow-none"
          >
            {launching
              ? "Launching…"
              : running
                ? "Compiling…"
                : installing
                  ? "Installing…"
                  : "Compile, Install & Launch"}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
