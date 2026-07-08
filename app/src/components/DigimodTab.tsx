import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { importDigimod, listUiMods, type UiModVpk } from "../lib/api";
import { useToast } from "./Toaster";
import type { DigiEntry, DigimodConfig, DigiSound } from "../types";

/**
 * Jumpscares/Deaths tab — configures the DigiMaster HUD mod, which compiles
 * from embedded templates: drop in videos (any format — converted to VP9 webm
 * at compile) or PNGs, optional sounds, set the chances, done. Existing
 * DigiMaster paks can be imported wholesale: config, webms, images, and
 * sounds all come back out as editable entries.
 */
const VIDEO_FILTERS = [
  { name: "Video", extensions: ["webm", "mp4", "mov", "mkv", "avi", "gif"] },
];
const IMAGE_FILTERS = [{ name: "Image (PNG)", extensions: ["png"] }];
const AUDIO_FILTERS = [
  { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
];

export const DEFAULT_DIGIMOD: DigimodConfig = {
  rngInterval: 60,
  scareChance: 3,
  deathChance: 100,
  scares: [],
  deaths: [],
  sounds: [],
};

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function makeSoundId(path: string, existing: DigiSound[]): string {
  let base = baseName(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
  if (!base) base = "sound";
  let id = base;
  let n = 2;
  while (existing.some((s) => s.id === id)) id = `${base}_${n++}`;
  return id;
}

function makeId(path: string, existing: DigiEntry[]): string {
  let base = baseName(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
  if (!base) base = "entry";
  let id = base;
  let n = 2;
  while (existing.some((e) => e.id === id)) id = `${base}_${n++}`;
  return id;
}

/** Slider + number pair for the settings row. */
function SettingSlider({
  label,
  suffix,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex min-w-[13rem] flex-1 flex-col gap-1">
      <span className="flex items-baseline justify-between text-[11px] text-zinc-400">
        {label}
        <span className="font-semibold text-zinc-200">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-red-500"
      />
    </label>
  );
}

export function DigimodTab({
  config,
  addonsDir,
  helperPath,
  onChange,
}: {
  config: DigimodConfig;
  addonsDir: string;
  helperPath: string;
  onChange: (next: DigimodConfig) => void;
}) {
  const { push } = useToast();
  const patch = (p: Partial<DigimodConfig>) => onChange({ ...config, ...p });
  const sounds = config.sounds ?? [];

  // One-time migration from the pre-library shape: entries that carried
  // their own sourceAudio get it lifted into a shared sound.
  useEffect(() => {
    const legacy = [...config.scares, ...config.deaths].filter(
      (e) => e.sourceAudio && !e.soundId,
    );
    if (legacy.length === 0) return;
    const lib: DigiSound[] = [...(config.sounds ?? [])];
    const soundFor = (e: DigiEntry): string => {
      const existing = lib.find((s) => s.sourceAudio === e.sourceAudio);
      if (existing) return existing.id;
      let id = makeSoundId(e.sourceAudio ?? "sound", lib);
      lib.push({
        id,
        name: baseName(e.sourceAudio ?? "sound").replace(/\.[^.]+$/, ""),
        sourceAudio: e.sourceAudio ?? "",
        volume: e.volume ?? 3,
      });
      return id;
    };
    const lift = (list: DigiEntry[]) =>
      list.map((e) =>
        e.sourceAudio && !e.soundId
          ? { ...e, soundId: soundFor(e), sourceAudio: null }
          : e,
      );
    onChange({ ...config, scares: lift(config.scares), deaths: lift(config.deaths), sounds: lib });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  function updateSound(id: string, p: Partial<DigiSound>) {
    patch({ sounds: sounds.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  }

  function removeSound(id: string) {
    const strip = (list: DigiEntry[]) =>
      list.map((e) => (e.soundId === id ? { ...e, soundId: null } : e));
    onChange({
      ...config,
      sounds: sounds.filter((s) => s.id !== id),
      scares: strip(config.scares),
      deaths: strip(config.deaths),
    });
  }

  /** File-pick sounds and build library rows (no state change — callers
   *  fold the result into ONE onChange so nothing races). */
  async function pickSoundFiles(): Promise<DigiSound[]> {
    const picked = await openDialog({ multiple: true, filters: AUDIO_FILTERS });
    const paths = typeof picked === "string" ? [picked] : (picked ?? []);
    const out: DigiSound[] = [];
    for (const p of paths) {
      const id = makeSoundId(p, [...sounds, ...out]);
      out.push({ id, name: baseName(p).replace(/\.[^.]+$/, ""), sourceAudio: p, volume: 3 });
    }
    return out;
  }

  async function addSoundsToLibrary() {
    const ns = await pickSoundFiles();
    if (ns.length > 0) patch({ sounds: [...sounds, ...ns] });
  }

  /** Entry dropdown picked "add new": add to library + assign, atomically. */
  async function addSoundForEntry(list: "scares" | "deaths", entryId: string) {
    const ns = await pickSoundFiles();
    if (ns.length === 0) return;
    const assigned = ns[ns.length - 1].id;
    onChange({
      ...config,
      sounds: [...sounds, ...ns],
      [list]: config[list].map((e) => (e.id === entryId ? { ...e, soundId: assigned } : e)),
    });
  }

  // Installed DigiMaster paks — offered for one-click import.
  const [digiPaks, setDigiPaks] = useState<UiModVpk[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  useEffect(() => {
    if (!addonsDir) return;
    listUiMods(addonsDir)
      .then((mods) => setDigiPaks(mods.filter((m) => m.hasDigi)))
      .catch(() => {});
  }, [addonsDir]);

  async function runImport(vpk: string) {
    if (!helperPath) {
      push("error", "vpk helper not configured (Setup)");
      return;
    }
    setImporting(vpk);
    try {
      const imp = await importDigimod(helperPath, vpk);
      const have = new Set([...config.scares, ...config.deaths].map((e) => e.id));
      // Library first: imported sounds slot in unless the id is taken.
      const haveSounds = new Set(sounds.map((s) => s.id));
      const newSounds: DigiSound[] = imp.sounds
        .filter((s) => !haveSounds.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, sourceAudio: s.sourceAudio, volume: s.volume }));
      const soundKnown = new Set([...haveSounds, ...newSounds.map((s) => s.id)]);
      const adopt = (list: typeof imp.scares): DigiEntry[] =>
        list
          .filter((e) => !have.has(e.id))
          .map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind === "image" ? "image" : "video",
            sourceMedia: e.sourceMedia,
            show: e.show,
            preset: e.preset === "banner" ? "banner" : "fullscreen",
            soundId: e.soundId && soundKnown.has(e.soundId) ? e.soundId : null,
          }));
      const scares = adopt(imp.scares);
      const deaths = adopt(imp.deaths);
      onChange({
        ...config,
        rngInterval: imp.rngInterval,
        scareChance: imp.scareChance,
        deathChance: imp.deathChance,
        scares: [...config.scares, ...scares],
        deaths: [...config.deaths, ...deaths],
        sounds: [...sounds, ...newSounds],
      });
      const skipped = imp.scares.length + imp.deaths.length - scares.length - deaths.length;
      push(
        "success",
        `Imported ${scares.length} scare(s) + ${deaths.length} death(s)` +
          (skipped > 0 ? ` (${skipped} already here)` : ""),
      );
      for (const w of imp.warnings) push("error", w);
    } catch (e) {
      push("error", `Import failed: ${e}`);
    } finally {
      setImporting(null);
    }
  }

  async function addEntry(list: "scares" | "deaths", kind: "video" | "image") {
    const picked = await openDialog({
      multiple: true,
      filters: kind === "video" ? VIDEO_FILTERS : IMAGE_FILTERS,
    });
    const paths = typeof picked === "string" ? [picked] : (picked ?? []);
    if (paths.length === 0) return;
    const next = [...config[list]];
    const all = [...config.scares, ...config.deaths];
    for (const p of paths) {
      const entry: DigiEntry = {
        id: makeId(p, [...all, ...next]),
        name: baseName(p).replace(/\.[^.]+$/, ""),
        kind,
        sourceMedia: p,
        show: list === "scares" ? 0.8 : 5.0,
        preset: list === "scares" ? "fullscreen" : "banner",
        soundId: null,
      };
      next.push(entry);
    }
    patch({ [list]: next } as Partial<DigimodConfig>);
  }

  function updateEntry(list: "scares" | "deaths", id: string, p: Partial<DigiEntry>) {
    patch({
      [list]: config[list].map((e) => (e.id === id ? { ...e, ...p } : e)),
    } as Partial<DigimodConfig>);
  }

  function removeEntry(list: "scares" | "deaths", id: string) {
    patch({ [list]: config[list].filter((e) => e.id !== id) } as Partial<DigimodConfig>);
  }

  const empty = config.scares.length === 0 && config.deaths.length === 0;

  const renderList = (list: "scares" | "deaths", title: string, hint: string) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300">
          {config[list].length}
        </span>
        <span className="text-[11px] text-zinc-500">{hint}</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void addEntry(list, "video")}
            className="rounded-lg bg-red-500/90 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-red-500"
          >
            ＋ Video
          </button>
          <button
            onClick={() => void addEntry(list, "image")}
            className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-700"
          >
            ＋ PNG
          </button>
        </div>
      </div>
      {config[list].length === 0 ? (
        <p className="py-6 text-center text-xs text-zinc-600">
          Nothing yet — add a video (any format, it converts to webm) or a PNG.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2 2xl:grid-cols-3">
          {config[list].map((e) => (
            <div
              key={e.id}
              className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60 transition-colors hover:border-red-500/40"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
                {e.kind === "video" ? (
                  <video
                    src={convertFileSrc(e.sourceMedia)}
                    muted
                    loop
                    autoPlay
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <img
                    src={convertFileSrc(e.sourceMedia)}
                    className="h-full w-full object-contain"
                    alt=""
                  />
                )}
                <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
                  {e.kind === "video" ? "webm" : "png"}
                </span>
                {!e.sourceMedia.toLowerCase().endsWith(".webm") && e.kind === "video" && (
                  <span className="absolute right-1.5 top-1.5 rounded bg-sky-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    converts on compile
                  </span>
                )}
                <button
                  onClick={() => removeEntry(list, e.id)}
                  className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-2 py-0.5 text-xs text-red-300 opacity-0 transition-opacity hover:bg-red-500/20 group-hover:opacity-100"
                >
                  ✕ remove
                </button>
              </div>
              <div className="flex flex-col gap-1.5 p-2.5">
                <input
                  value={e.name}
                  onChange={(ev) => updateEntry(list, e.id, { name: ev.target.value })}
                  className="w-full rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-zinc-200 hover:border-zinc-700 focus:border-zinc-500 focus:outline-none"
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                  <label className="flex items-center gap-1">
                    show
                    <input
                      type="number"
                      step={0.1}
                      min={0.1}
                      value={e.show}
                      onChange={(ev) =>
                        updateEntry(list, e.id, { show: Number(ev.target.value) || 0.5 })
                      }
                      className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 text-zinc-200"
                    />
                    s
                  </label>
                  <span className="flex gap-1">
                    {(["fullscreen", "banner"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => updateEntry(list, e.id, { preset: p })}
                        className={`rounded px-1.5 py-0.5 ${
                          e.preset === p
                            ? "bg-red-500/90 font-semibold text-white"
                            : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                        }`}
                      >
                        {p === "fullscreen" ? "fullscreen" : "side banner"}
                      </button>
                    ))}
                  </span>
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                  🔊
                  <select
                    value={e.soundId ?? ""}
                    onChange={(ev) => {
                      const v = ev.target.value;
                      if (v === "__new__") void addSoundForEntry(list, e.id);
                      else updateEntry(list, e.id, { soundId: v || null });
                    }}
                    className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-300 focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="">— no sound —</option>
                    {sounds.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    <option value="__new__">＋ add a new sound…</option>
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Header: identity + the three knobs. */}
      <div className="rounded-xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-zinc-900/40 to-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-[10rem]">
            <h2 className="text-base font-bold text-zinc-100">DigiMaster</h2>
            <p className="text-[11px] leading-4 text-zinc-500">
              random jumpscares + death videos,
              <br />
              rebuilt into your mod on compile
            </p>
          </div>
          <SettingSlider
            label="Scare roll every"
            suffix="s"
            min={5}
            max={300}
            value={config.rngInterval}
            onChange={(v) => patch({ rngInterval: v })}
          />
          <SettingSlider
            label="Scare chance per roll"
            suffix="%"
            min={1}
            max={100}
            value={config.scareChance}
            onChange={(v) => patch({ scareChance: v })}
          />
          <SettingSlider
            label="Death video chance"
            suffix="%"
            min={0}
            max={100}
            value={config.deathChance}
            onChange={(v) => patch({ deathChance: v })}
          />
        </div>
        <p className="mt-2 text-[10px] text-zinc-600">
          These compile in as the defaults — the in-game F8 menu ("DigiMaster") can still
          tweak them per session.
        </p>
      </div>

      {/* One-click adoption of an already-installed DigiMaster pak. */}
      {digiPaks.length > 0 && (
        <div
          className={`rounded-xl border p-4 ${
            empty
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-zinc-800 bg-zinc-900/40"
          }`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[14rem] flex-1">
              <h3 className="text-sm font-semibold text-zinc-100">
                {empty ? "Your installed mod was detected" : "Import from an installed pak"}
              </h3>
              <p className="text-[11px] text-zinc-500">
                Pulls the videos, images, sounds, and settings out of the pak so you can
                edit them here. {empty ? "Start with everything you already have:" : "Entries you already have are skipped."}
              </p>
            </div>
            {digiPaks.map((m) => (
              <button
                key={m.path}
                onClick={() => void runImport(m.path)}
                disabled={importing !== null}
                title={m.path}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  empty
                    ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                    : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                } disabled:opacity-50`}
              >
                {importing === m.path ? "Importing…" : `Import ${m.fileName}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {renderList("scares", "Jumpscares", "random RNG rolls while you play")}
      {renderList("deaths", "Deaths", "plays when your respawn timer appears")}

      {/* Shared sound library: each row compiles to its own Digi.* event. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-zinc-100">Sounds</h3>
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300">
            {sounds.length}
          </span>
          <span className="text-[11px] text-zinc-500">
            each becomes its own sound event — assign to any number of videos above
          </span>
          <button
            onClick={() => void addSoundsToLibrary()}
            className="ml-auto rounded-lg bg-red-500/90 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-red-500"
          >
            ＋ Add sounds
          </button>
        </div>
        {sounds.length === 0 ? (
          <p className="py-5 text-center text-xs text-zinc-600">
            No sounds yet — add mp3/wav/ogg files here (or straight from a video's dropdown)
            and pick them per video.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 p-3 md:grid-cols-2">
            {sounds.map((s) => {
              const uses = [...config.scares, ...config.deaths].filter(
                (e) => e.soundId === s.id,
              ).length;
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <input
                      value={s.name}
                      onChange={(ev) => updateSound(s.id, { name: ev.target.value })}
                      className="w-full rounded border border-transparent bg-transparent px-1 text-xs font-semibold text-zinc-200 hover:border-zinc-700 focus:border-zinc-500 focus:outline-none"
                    />
                    <div
                      className="truncate px-1 text-[10px] text-zinc-600"
                      title={s.sourceAudio}
                    >
                      {baseName(s.sourceAudio)}
                      {uses > 0 && (
                        <span className="ml-2 text-emerald-400/80">
                          used by {uses} video{uses === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  </div>
                  <audio
                    src={convertFileSrc(s.sourceAudio)}
                    controls
                    preload="none"
                    className="h-7 w-36 shrink-0"
                  />
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500">
                    vol
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      max={10}
                      value={s.volume}
                      onChange={(ev) =>
                        updateSound(s.id, { volume: Number(ev.target.value) || 3 })
                      }
                      className="w-12 rounded border border-zinc-700 bg-zinc-950 px-1 text-zinc-200"
                    />
                  </label>
                  <button
                    onClick={() => removeSound(s.id)}
                    title={uses > 0 ? `Unassigns ${uses} video(s)` : "Remove sound"}
                    className="shrink-0 rounded px-1.5 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-300"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-600">
        Compile bakes this into your mod: videos become VP9 webm (panorama's requirement),
        PNGs compile to textures, sounds get their own Digi.* sound events. This overrides
        the game's base HUD layout — merge other HUD mods in the Mod Combiner tab, and
        remove your old DigiMaster pak from addons once this one is installed.
      </p>
    </div>
  );
}
