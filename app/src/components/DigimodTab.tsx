import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listUiMods, type UiModVpk } from "../lib/api";
import type { DigiEntry, DigimodConfig } from "../types";

/**
 * Jumpscares/Deaths tab — configures the DigiMaster HUD mod, which compiles
 * from embedded templates: drop in videos (any format — converted to VP9 webm
 * at compile) or PNGs, optional sounds, set the chances, done. The tab only
 * appears when the engine is detected in the user's installed mods (or the
 * project already carries a config).
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
};

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
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

export function DigimodTab({
  config,
  accent,
  addonsDir,
  onChange,
}: {
  config: DigimodConfig;
  accent: string;
  addonsDir: string;
  onChange: (next: DigimodConfig) => void;
}) {
  const patch = (p: Partial<DigimodConfig>) => onChange({ ...config, ...p });

  // Installed base_hud-overriding paks — candidates for the merge section.
  const [uiMods, setUiMods] = useState<UiModVpk[]>([]);
  useEffect(() => {
    if (!addonsDir) return;
    listUiMods(addonsDir)
      .then(setUiMods)
      .catch(() => {});
  }, [addonsDir]);

  const mergeVpks = config.mergeVpks ?? [];
  const toggleMerge = (path: string) =>
    patch({
      mergeVpks: mergeVpks.includes(path)
        ? mergeVpks.filter((p) => p !== path)
        : [...mergeVpks, path],
    });

  async function browseMergeVpk() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Mod pack", extensions: ["vpk"] }],
    });
    if (typeof picked === "string" && !mergeVpks.includes(picked)) {
      patch({ mergeVpks: [...mergeVpks, picked] });
    }
  }

  // Browse-picked vpks that aren't in the addons scan still need a row.
  const externalMerges = mergeVpks.filter((p) => !uiMods.some((m) => m.path === p));

  async function addEntry(list: "scares" | "deaths", kind: "video" | "image") {
    const picked = await openDialog({
      multiple: false,
      filters: kind === "video" ? VIDEO_FILTERS : IMAGE_FILTERS,
    });
    if (typeof picked !== "string") return;
    const all = [...config.scares, ...config.deaths];
    const entry: DigiEntry = {
      id: makeId(picked, all),
      name: baseName(picked).replace(/\.[^.]+$/, ""),
      kind,
      sourceMedia: picked,
      show: list === "scares" ? 0.8 : 5.0,
      preset: list === "scares" ? "fullscreen" : "banner",
      sourceAudio: null,
      volume: 3,
    };
    patch({ [list]: [...config[list], entry] } as Partial<DigimodConfig>);
  }

  function updateEntry(list: "scares" | "deaths", id: string, p: Partial<DigiEntry>) {
    patch({
      [list]: config[list].map((e) => (e.id === id ? { ...e, ...p } : e)),
    } as Partial<DigimodConfig>);
  }

  function removeEntry(list: "scares" | "deaths", id: string) {
    patch({ [list]: config[list].filter((e) => e.id !== id) } as Partial<DigimodConfig>);
  }

  async function pickSound(list: "scares" | "deaths", id: string) {
    const picked = await openDialog({ multiple: false, filters: AUDIO_FILTERS });
    if (typeof picked === "string") updateEntry(list, id, { sourceAudio: picked });
  }

  const renderList = (list: "scares" | "deaths", title: string, hint: string) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-1 flex items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <span className="text-[11px] text-zinc-500">{hint}</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void addEntry(list, "video")}
            className="rounded-lg px-2.5 py-1 text-xs font-semibold text-zinc-900"
            style={{ background: accent }}
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
        <p className="py-4 text-center text-xs text-zinc-600">
          Nothing yet — add a video (any format, it converts to webm) or a PNG.
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {config[list].map((e) => (
            <div key={e.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="flex items-start gap-3">
                <div className="h-20 w-32 shrink-0 overflow-hidden rounded bg-zinc-900">
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
                      className="h-full w-full object-cover"
                      alt=""
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={e.name}
                      onChange={(ev) => updateEntry(list, e.id, { name: ev.target.value })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-zinc-200 hover:border-zinc-700 focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      onClick={() => removeEntry(list, e.id)}
                      className="shrink-0 rounded px-1.5 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
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
                              ? "bg-zinc-100 font-semibold text-zinc-900"
                              : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {p === "fullscreen" ? "fullscreen" : "side banner"}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    {e.sourceAudio ? (
                      <>
                        <span className="max-w-[12rem] truncate text-zinc-400" title={e.sourceAudio}>
                          🔊 {baseName(e.sourceAudio)}
                        </span>
                        <label className="flex items-center gap-1 text-zinc-500">
                          vol
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={10}
                            value={e.volume}
                            onChange={(ev) =>
                              updateEntry(list, e.id, { volume: Number(ev.target.value) || 3 })
                            }
                            className="w-12 rounded border border-zinc-700 bg-zinc-950 px-1 text-zinc-200"
                          />
                        </label>
                        <button
                          onClick={() => updateEntry(list, e.id, { sourceAudio: null })}
                          className="text-zinc-500 hover:text-red-300"
                        >
                          remove sound
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => void pickSound(list, e.id)}
                        className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      >
                        ＋ sound
                      </button>
                    )}
                    {!e.sourceMedia.toLowerCase().endsWith(".webm") && e.kind === "video" && (
                      <span className="rounded bg-sky-500/15 px-1.5 text-[10px] text-sky-300">
                        converts to webm on compile
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-200">Settings</h3>
          <span className="text-[11px] text-zinc-500">
            baked into the mod as defaults — the in-game F-menu ("DigiMaster") can still tweak
            them per session
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-300">
          <label className="flex items-center gap-2">
            Scare roll every
            <input
              type="number"
              min={5}
              max={600}
              value={config.rngInterval}
              onChange={(e) => patch({ rngInterval: Number(e.target.value) || 60 })}
              className="w-16 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-zinc-200"
            />
            s
          </label>
          <label className="flex items-center gap-2">
            Scare chance
            <input
              type="number"
              min={1}
              max={100}
              value={config.scareChance}
              onChange={(e) => patch({ scareChance: Number(e.target.value) || 1 })}
              className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-zinc-200"
            />
            %
          </label>
          <label className="flex items-center gap-2">
            Death video chance
            <input
              type="number"
              min={0}
              max={100}
              value={config.deathChance}
              onChange={(e) => patch({ deathChance: Number(e.target.value) || 0 })}
              className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-zinc-200"
            />
            %
          </label>
        </div>
      </div>

      {renderList("scares", "Jumpscares", "random RNG rolls while you play")}
      {renderList("deaths", "Deaths", "plays when your respawn timer appears")}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-1 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">Merge UI mods</h3>
          <span className="text-[11px] text-zinc-500">
            two HUD mods can't coexist — merging ships theirs + jumpscares in one pak
          </span>
          <button
            onClick={() => void browseMergeVpk()}
            className="ml-auto rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-700"
          >
            Browse for a vpk…
          </button>
        </div>
        {uiMods.length === 0 && externalMerges.length === 0 ? (
          <p className="py-3 text-center text-xs text-zinc-600">
            No other UI mods found in your addons folder. If you install one (anything that
            changes the in-game HUD), it shows up here for merging.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {uiMods.map((m) =>
              m.hasDigi ? (
                <div
                  key={m.path}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800/60 px-3 py-2 text-xs text-zinc-600"
                  title={m.path}
                >
                  <span className="truncate">{m.fileName}</span>
                  <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">
                    old DigiMaster pak — this tab replaces it, remove it after installing
                  </span>
                </div>
              ) : (
                <label
                  key={m.path}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-600"
                  title={m.path}
                >
                  <input
                    type="checkbox"
                    checked={mergeVpks.includes(m.path)}
                    onChange={() => toggleMerge(m.path)}
                    className="accent-red-500"
                  />
                  <span className="truncate">{m.fileName}</span>
                  {mergeVpks.includes(m.path) && (
                    <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                      merges on compile — disable the original pak after installing
                    </span>
                  )}
                </label>
              ),
            )}
            {externalMerges.map((p) => (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-600"
                title={p}
              >
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggleMerge(p)}
                  className="accent-red-500"
                />
                <span className="truncate">{p.replace(/\\/g, "/").split("/").pop()}</span>
                <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  merges on compile
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-600">
        Compile bakes this into your mod: videos become VP9 webm (panorama's requirement),
        PNGs compile to textures, sounds get their own Digi.* sound events. Heads-up: this
        overrides the game's base HUD layout — two HUD mods can't be active at once, which
        is what "Merge UI mods" above solves.
      </p>
    </div>
  );
}
