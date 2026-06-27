import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  autodetectPaths,
  copyToDownloads,
  decodeStock as decodeStockApi,
  downloadEntry,
  loadState,
  newProject,
  probeAudio,
  readEventPools,
  readModArrays,
  refreshVanilla as refreshVanillaApi,
  sanitizeName,
  saveState,
} from "./lib/api";
import { SidePanel } from "./components/SidePanel";
import { SetupSection } from "./components/SetupSection";
import { FirstRunWizard } from "./components/FirstRunWizard";
import { ImportedMods } from "./components/ImportedMods";
import { CompileBar } from "./components/CompileBar";
import { useToast } from "./components/Toaster";
import { useSettings } from "./lib/settings";
import { songHash } from "./lib/songHash";
import type { EventProject, EventView, Project, Song } from "./types";
import "./index.css";

const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const DEFAULT_GAIN_DB = 6;

const MOD_COMBINER = "modcombiner";

const TAB_LABELS: Record<string, string> = {
  intro: "Deadlock Intro",
  urn: "Urn Music",
  heroes: "Heroes",
  [MOD_COMBINER]: "Mod combiner",
};

function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, "");
}

function accentFor(ev: { group: string; side: string }): string {
  if (ev.group === "intro") return ev.side === "Mother" ? "#3974ae" : "#ffac10";
  if (ev.group === "urn") return "#a855f7";
  return "#e0564f"; // heroes
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [pools, setPools] = useState<Record<string, EventView>>({});
  // Per-song expand state, kept here (not in the card) so it survives tab
  // switches. Default = collapsed; a song is expanded when freshly dropped/
  // created, or once the user opens it — and stays that way on return.
  const [expandedSongs, setExpandedSongs] = useState<Record<string, boolean>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("intro");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, update: updateSettings } = useSettings();
  const { push } = useToast();

  const panelEls = useRef<Record<string, HTMLElement | null>>({});
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Slot-group tabs (in slot order) plus the special Mod Combiner tab.
  const tabs = useMemo(() => {
    const seen: string[] = [];
    for (const e of project?.events ?? []) {
      if (!seen.includes(e.group)) seen.push(e.group);
    }
    seen.push(MOD_COMBINER);
    return seen;
  }, [project]);

  const hydrated = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const saved = await loadState();
        const p = saved ?? (await newProject());
        setProject(p);
        hydrated.current = true;
        void load(p);
      } catch (e) {
        push("error", String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave of the project state (no compile) on any change.
  useEffect(() => {
    if (!project || !hydrated.current) return;
    const id = setTimeout(() => void saveState(project), 600);
    return () => clearTimeout(id);
  }, [project]);

  function pickSide(x: number, y: number): { side: string | null; how: string } {
    const dpr = window.devicePixelRatio || 1;
    const panels = Object.entries(panelEls.current).filter(([, el]) => !!el) as [
      string,
      HTMLElement,
    ][];
    if (panels.length === 0) return { side: null, how: "no-panels" };
    const candidates: [number, number, string][] = [
      [x, y, "raw"],
      [x / dpr, y / dpr, "dpr"],
    ];
    for (const [cx, cy, tag] of candidates) {
      for (const [id, el] of panels) {
        const r = el.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          return { side: id, how: `hit:${tag}` };
        }
      }
    }
    let best = panels[0][0];
    let bestD = Infinity;
    for (const [id, el] of panels) {
      const r = el.getBoundingClientRect();
      const dx = x / dpr - (r.left + r.right) / 2;
      const dy = y / dpr - (r.top + r.bottom) / 2;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return { side: best, how: "closest" };
  }

  useEffect(() => {
    const unlistenP = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        const { side } = pickSide(p.position.x, p.position.y);
        setDropTarget(side);
      } else if (p.type === "leave") {
        setDropTarget(null);
      } else if (p.type === "drop") {
        const { side } = pickSide(p.position.x, p.position.y);
        setDropTarget(null);
        const vpks = p.paths.filter((pp) => /\.vpk$/i.test(pp));
        const audio = p.paths.filter((pp) => AUDIO_EXT.test(pp));

        // Dropped mod .vpk(s) → add to the Mod combiner list.
        if (vpks.length > 0) {
          const cur = settingsRef.current.importedMods;
          const next = [...cur];
          for (const v of vpks) if (!next.includes(v)) next.push(v);
          const addedN = next.length - cur.length;
          if (addedN > 0) {
            updateSettings({ importedMods: next });
            setActiveTab(MOD_COMBINER);
            push("success", `Added ${addedN} mod${addedN === 1 ? "" : "s"} to combine`);
          } else {
            push("info", "Those mod(s) are already in the combine list");
          }
        }

        // Dropped audio → add to the slot under the cursor.
        if (audio.length > 0) {
          if (side) {
            for (const path of audio) void addSong(side, path);
          } else {
            push("error", "Drop the .mp3 onto a track slot");
          }
        }

        if (vpks.length === 0 && audio.length === 0) {
          push("error", "Drop an .mp3 (onto a slot) or a mod .vpk");
        }
      }
    });
    return () => {
      void unlistenP.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(proj?: Project) {
    const p = proj ?? projectRef.current;
    if (!p) return;
    try {
      const root = settingsRef.current.vanillaRoot.replace(/[/\\]+$/, "");
      const slots = p.events.map((e) => ({
        eventsPath: `${root}/${e.eventsRelpath}`,
        eventName: e.eventName,
        arrayKey: e.arrayKey,
      }));
      const views = await readEventPools(slots);
      const map: Record<string, EventView> = {};
      p.events.forEach((e, i) => {
        const v = views[i];
        if (v) map[e.id] = v;
      });
      setPools(map);
    } catch (e) {
      push("error", `Couldn't read events file: ${e}`);
    }
  }

  function toggleSongExpanded(id: string) {
    setExpandedSongs((m) => ({ ...m, [id]: !m[id] }));
  }

  function uniqueSoundName(base: string, proj: Project, exceptId?: string): string {
    const taken = new Set(
      proj.events.flatMap((e) =>
        e.songs.filter((s) => s.id !== exceptId).map((s) => s.soundName),
      ),
    );
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  async function addSong(slotId: string, path: string) {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const ffmpegPath = settingsRef.current.ffmpegPath || undefined;
      const info = await probeAudio(path, ffmpegPath);
      const sanitized = await sanitizeName(baseName(path));
      const soundName = uniqueSoundName(sanitized, proj);
      const slot = proj.events.find((e) => e.id === slotId);
      const order = slot ? slot.songs.length : 0;
      const song: Song = {
        id: crypto.randomUUID(),
        label: baseName(path),
        sourceMp3: path,
        soundName,
        trimStart: 0,
        trimEnd: info.duration,
        gainDb: DEFAULT_GAIN_DB,
        fadeIn: 0,
        fadeOut: 0,
        looping: slot?.eventName.endsWith(".Lp") ?? false,
        order,
        lastCompiledHash: null,
      };
      setProject((prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) =>
                e.id === slotId ? { ...e, songs: [...e.songs, song] } : e,
              ),
            }
          : prev,
      );
      setExpandedSongs((m) => ({ ...m, [song.id]: true })); // open the new drop
      push("success", `Added "${baseName(path)}" to ${slot?.side ?? "slot"}`);
    } catch (e) {
      push("error", `Could not add ${baseName(path)}: ${e}`);
    }
  }

  function updateSong(songId: string, patch: Partial<Song>) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.map((s) => (s.id === songId ? { ...s, ...patch } : s)),
            })),
          }
        : prev,
    );
  }

  async function renameSong(songId: string, raw: string) {
    const clean = (await sanitizeName(raw)) || "track";
    setProject((prev) => {
      if (!prev) return prev;
      const name = uniqueSoundName(clean, prev, songId);
      return {
        ...prev,
        events: prev.events.map((e) => ({
          ...e,
          songs: e.songs.map((s) => (s.id === songId ? { ...s, soundName: name } : s)),
        })),
      };
    });
  }

  // Persist a new drag order: each song's `order` becomes its index in the list.
  function reorderSongs(slotId: string, orderedIds: string[]) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) =>
              e.id === slotId
                ? {
                    ...e,
                    songs: e.songs.map((s) => {
                      const idx = orderedIds.indexOf(s.id);
                      return idx === -1 ? s : { ...s, order: idx };
                    }),
                  }
                : e,
            ),
          }
        : prev,
    );
  }

  function removeSong(songId: string) {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.filter((s) => s.id !== songId),
            })),
          }
        : prev,
    );
  }

  // Decode a compiled entry to a playable URL. `vpk` defaults to the game pak
  // (stock tracks); pass a mod vpk for adopted entries.
  async function decodeStock(ref: string, vpk?: string): Promise<string> {
    const s = settingsRef.current;
    const path = await decodeStockApi(s.vpkHelperPath, vpk ?? s.deadlockPak, ref);
    return convertFileSrc(path);
  }

  function shortRef(ref: string): string {
    return (ref.split("/").pop() ?? ref).replace(/\.vsnd$/, "");
  }

  // Download a copy of an existing entry (decoded from its vpk) into Downloads.
  async function downloadEntryTo(ref: string, vpk?: string) {
    const s = settingsRef.current;
    try {
      const dest = await downloadEntry(s.vpkHelperPath, vpk ?? s.deadlockPak, ref);
      push("success", `Saved to ${dest}`);
    } catch (e) {
      push("error", `Download failed: ${e}`);
    }
  }

  // Copy one of your source mp3s into Downloads.
  async function downloadSong(sourceMp3: string) {
    try {
      const dest = await copyToDownloads(sourceMp3);
      push("success", `Saved to ${dest}`);
    } catch (e) {
      push("error", `Download failed: ${e}`);
    }
  }

  // "Merge into project": adopt a mod's added entries into matching slots.
  async function mergeModIntoProject(vpk: string) {
    const proj = projectRef.current;
    if (!proj) return;
    try {
      const arrays = await readModArrays(settingsRef.current.vpkHelperPath, vpk);
      const byKey = new Map(arrays.map((a) => [`${a.eventName}::${a.arrayKey}`, a]));
      let adoptedCount = 0;
      let slotsTouched = 0;
      setProject((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          events: prev.events.map((ev) => {
            const a = byKey.get(`${ev.eventName}::${ev.arrayKey}`);
            if (!a) return ev;
            const ourRefs = ev.songs.map(
              (s) => `${prev.soundFolder}/${s.soundName}.vsnd`,
            );
            const existing = new Set([
              ev.stockEntry,
              ...(pools[ev.id]?.entries ?? []),
              ...ourRefs,
              ...ev.adopted.map((x) => x.reference),
            ]);
            const fresh = a.entries.filter((r) => !existing.has(r));
            if (fresh.length === 0) return ev;
            slotsTouched++;
            adoptedCount += fresh.length;
            return {
              ...ev,
              adopted: [
                ...ev.adopted,
                ...fresh.map((r) => ({ reference: r, sourceVpk: vpk, label: shortRef(r) })),
              ],
            };
          }),
        };
      });
      if (adoptedCount > 0) {
        push("success", `Adopted ${adoptedCount} track(s) into ${slotsTouched} slot(s)`);
      } else {
        push("info", "Nothing new to adopt from that mod for your slots");
      }
    } catch (e) {
      push("error", `Merge into project failed: ${e}`);
    }
  }

  // Convert an adopted entry into an editable mp3 song card.
  async function editAdopted(slotId: string, ref: string, vpk: string, label: string) {
    const s = settingsRef.current;
    try {
      const mp3 = await decodeStockApi(s.vpkHelperPath, vpk, ref);
      const info = await probeAudio(mp3, s.ffmpegPath || undefined);
      const sanitized = await sanitizeName(label);
      const newId = crypto.randomUUID();
      setProject((prev) => {
        if (!prev) return prev;
        const soundName = uniqueSoundName(sanitized, prev);
        const slot = prev.events.find((e) => e.id === slotId);
        const order = slot ? slot.songs.length : 0;
        const song: Song = {
          id: newId,
          label,
          sourceMp3: mp3,
          soundName,
          trimStart: 0,
          trimEnd: info.duration,
          gainDb: DEFAULT_GAIN_DB,
          fadeIn: 0,
          fadeOut: 0,
          looping: slot?.eventName.endsWith(".Lp") ?? false,
          order,
          lastCompiledHash: null,
        };
        return {
          ...prev,
          events: prev.events.map((e) =>
            e.id === slotId
              ? {
                  ...e,
                  songs: [...e.songs, song],
                  adopted: e.adopted.filter((x) => x.reference !== ref),
                }
              : e,
          ),
        };
      });
      setExpandedSongs((m) => ({ ...m, [newId]: true })); // open it for editing
      push("success", `Now editing "${label}"`);
    } catch (e) {
      push("error", `Couldn't edit ${label}: ${e}`);
    }
  }

  // After a successful compile, stamp each song with its current hash so the
  // next compile can skip unchanged tracks (and the badge reads "Compiled").
  function markAllCompiled() {
    setProject((prev) =>
      prev
        ? {
            ...prev,
            events: prev.events.map((e) => ({
              ...e,
              songs: e.songs.map((s) => ({ ...s, lastCompiledHash: songHash(s) })),
            })),
          }
        : prev,
    );
  }

  // Slot-targeted toggles (slots can share an event name, so key by slot id).
  function patchSlot(slotId: string, fn: (e: EventProject) => EventProject) {
    setProject((prev) =>
      prev
        ? { ...prev, events: prev.events.map((e) => (e.id === slotId ? fn(e) : e)) }
        : prev,
    );
  }

  function toggleEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) => ({
      ...e,
      excludedEntries: e.excludedEntries.includes(ref)
        ? e.excludedEntries.filter((r) => r !== ref)
        : [...e.excludedEntries, ref],
    }));
  }

  function removeEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) =>
      e.removedEntries.includes(ref)
        ? e
        : { ...e, removedEntries: [...e.removedEntries, ref] },
    );
  }

  function restoreEntry(slotId: string, ref: string) {
    patchSlot(slotId, (e) => ({
      ...e,
      removedEntries: e.removedEntries.filter((r) => r !== ref),
      excludedEntries: e.excludedEntries.filter((r) => r !== ref),
    }));
  }

  // Refresh the merge base from the live game pak: decompile its events files,
  // repoint vanillaRoot at the fresh copy, re-read pools, and correct each slot's
  // stockEntry to the live first entry (kills drifted stock refs).
  async function refreshVanilla(opts?: { helper?: string; pak?: string }) {
    const proj = projectRef.current;
    const s = settingsRef.current;
    if (!proj) return;
    // Allow freshly-detected values to be passed in directly (first-run setup
    // runs detect then refresh in one tick, before settingsRef has updated).
    const helper = opts?.helper ?? s.vpkHelperPath;
    const pak = opts?.pak ?? s.deadlockPak;
    try {
      const relpaths = Array.from(new Set(proj.events.map((e) => e.eventsRelpath)));
      const res = await refreshVanillaApi(helper, pak, relpaths);
      updateSettings({ vanillaRoot: res.vanillaRoot });

      const root = res.vanillaRoot.replace(/[/\\]+$/, "");
      const slots = proj.events.map((e) => ({
        eventsPath: `${root}/${e.eventsRelpath}`,
        eventName: e.eventName,
        arrayKey: e.arrayKey,
      }));
      const views = await readEventPools(slots);
      const map: Record<string, EventView> = {};
      proj.events.forEach((e, i) => {
        const v = views[i];
        if (v) map[e.id] = v;
      });
      setPools(map);

      // Pin each slot's stock to the current game's first array entry.
      let corrected = 0;
      setProject((prev) =>
        prev
          ? {
              ...prev,
              events: prev.events.map((e) => {
                const first = map[e.id]?.entries?.[0];
                if (first && first !== e.stockEntry) {
                  corrected++;
                  return { ...e, stockEntry: first };
                }
                return e;
              }),
            }
          : prev,
      );

      const failNote = res.failed.length ? ` (${res.failed.length} missing)` : "";
      push(
        "success",
        `Refreshed ${res.refreshed.length} file(s) from the game; fixed ${corrected} stock ref(s)${failNote}`,
      );
    } catch (e) {
      push("error", `Refresh failed: ${e}`);
    }
  }

  // Best-effort auto-detect of tool/game paths; fills in what it finds.
  async function autodetect() {
    try {
      const d = await autodetectPaths();
      const patch: Partial<typeof settings> = {};
      if (d.csdkRoot) patch.csdkRoot = d.csdkRoot;
      if (d.deadlockPak) patch.deadlockPak = d.deadlockPak;
      if (d.addonsDir) patch.addonsDir = d.addonsDir;
      if (d.vpkHelper) patch.vpkHelperPath = d.vpkHelper;
      if (d.ffmpeg && d.ffmpeg !== "ffmpeg") patch.ffmpegPath = d.ffmpeg;
      const found = Object.keys(patch).length;
      if (found > 0) {
        updateSettings(patch);
        push("success", `Auto-detected ${found} path(s)`);
      } else {
        push("info", "Couldn't auto-detect any paths — set them manually");
      }
    } catch (e) {
      push("error", `Auto-detect failed: ${e}`);
    }
  }

  // First-run / one-click setup: detect tool+game paths, then pull the current
  // game's music data in as the merge base — so a new user is ready to compile
  // without typing any paths or supplying a ModFiles snapshot.
  async function runFirstSetup() {
    let helper = settingsRef.current.vpkHelperPath;
    let pak = settingsRef.current.deadlockPak;
    try {
      const d = await autodetectPaths();
      const patch: Partial<typeof settings> = {};
      if (d.csdkRoot) patch.csdkRoot = d.csdkRoot;
      if (d.deadlockPak) (patch.deadlockPak = d.deadlockPak), (pak = d.deadlockPak);
      if (d.addonsDir) patch.addonsDir = d.addonsDir;
      if (d.vpkHelper) (patch.vpkHelperPath = d.vpkHelper), (helper = d.vpkHelper);
      if (d.ffmpeg && d.ffmpeg !== "ffmpeg") patch.ffmpegPath = d.ffmpeg;
      if (Object.keys(patch).length) updateSettings(patch);
    } catch (e) {
      push("error", `Auto-detect failed: ${e}`);
    }
    // Pull live game music data in as the merge base (fixes the need for a local
    // ModFiles snapshot + drifted stock refs). Uses the just-detected paths.
    await refreshVanilla({ helper, pak });
  }

  const visibleSlots = (project?.events ?? []).filter((e) => e.group === activeTab);
  const songCount = (project?.events ?? []).reduce((n, e) => n + e.songs.length, 0);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar: brand + tabs — fixed, never scrolls */}
      <aside className="flex h-screen w-52 shrink-0 flex-col gap-1 border-r border-zinc-800 bg-zinc-950/60 p-4">
        <div className="mb-4">
          <h1 className="text-sm font-bold uppercase tracking-wider text-zinc-300">
            Deadlock
          </h1>
          <p className="text-[11px] text-zinc-600">Music Modder</p>
        </div>
        {tabs.map((g) => {
          const count =
            g === MOD_COMBINER
              ? settings.importedMods.length
              : (project?.events ?? [])
                  .filter((e) => e.group === g)
                  .reduce((n, e) => n + e.songs.length, 0);
          const active = g === activeTab;
          return (
            <button
              key={g}
              onClick={() => setActiveTab(g)}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <span>{TAB_LABELS[g] ?? g}</span>
              {count > 0 && (
                <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                  {count}
                </span>
              )}
            </button>
          );
        })}
        <div className="mt-auto flex items-center justify-between pt-2">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Setup"
            title="Setup"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
          >
            <span className="text-base">⚙</span>
            <span>Setup</span>
          </button>
          <span className="text-[10px] text-zinc-700">
            {songCount} track{songCount === 1 ? "" : "s"}
          </span>
        </div>
      </aside>

      {/* Main content — the only scrollable pane */}
      <main className="flex h-screen flex-1 flex-col gap-5 overflow-y-auto p-6 pb-4">
        <header>
          <h2 className="bg-gradient-to-r from-zinc-50 to-zinc-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
            {TAB_LABELS[activeTab] ?? activeTab}
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            {activeTab === MOD_COMBINER
              ? "Merge other mods' sounds into your compile — nothing of yours is removed."
              : "Your entries merge in — every other mod stays untouched."}
          </p>
        </header>

        {activeTab === MOD_COMBINER ? (
          <ImportedMods
            settings={settings}
            update={updateSettings}
            onMerge={mergeModIntoProject}
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {visibleSlots.map((ev) => (
              <SidePanel
                key={ev.id}
                ev={ev}
                view={pools[ev.id]}
                soundFolder={project!.soundFolder}
                ffmpegPath={settings.ffmpegPath || undefined}
                accent={accentFor(ev)}
                dropActive={dropTarget === ev.id}
                expandedSongs={expandedSongs}
                onToggleSongExpanded={toggleSongExpanded}
                panelRef={(el) => (panelEls.current[ev.id] = el)}
                onSongChange={updateSong}
                onSongRename={renameSong}
                onSongRemove={removeSong}
                onReorderSongs={reorderSongs}
                onToggleEntry={toggleEntry}
                onRemoveEntry={removeEntry}
                onRestoreEntry={restoreEntry}
                onDecodeStock={decodeStock}
                onEditAdopted={editAdopted}
                onDownloadEntry={downloadEntryTo}
                onDownloadSong={downloadSong}
              />
            ))}
          </div>
        )}

        <div className="flex-1" />

        {project && (
          <CompileBar
            settings={settings}
            update={updateSettings}
            events={project.events}
            onCompiled={markAllCompiled}
          />
        )}
      </main>

      {project && !settings.firstRunDone && (
        <FirstRunWizard
          settings={settings}
          onRunSetup={runFirstSetup}
          onDone={() => updateSettings({ firstRunDone: true })}
        />
      )}

      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSettingsOpen(false)}
          >
            <motion.div
              className="w-full max-w-2xl"
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.97, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
            >
              <SetupSection
                settings={settings}
                update={updateSettings}
                onClose={() => setSettingsOpen(false)}
                onRefreshVanilla={refreshVanilla}
                onAutodetect={autodetect}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
