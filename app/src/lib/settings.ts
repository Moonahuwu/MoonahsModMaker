import { useEffect, useRef, useState } from "react";
import type { CompileConfig, EffectCompile, EventCompile, GbModInfo, GlobalCompile, IconCompile, PosterCompile, ProfileCompilePrefs, SoundOverrideCompile, VdataCompile, WorldCompile } from "./api";
import { loadSettings, saveSettings } from "./api";
import type { DigimodConfig, EffectOverride, EventProject, LibraryItem, PosterOverride, SoundOverride, UiFileOverride } from "../types";
import { songHash, overrideHash, effectHash, posterHash } from "./songHash";

// User-facing settings. We derive the verbose CompileConfig paths from a CSDK
// root + addon name so the user only manages a few friendly fields.
export interface Settings {
  csdkRoot: string;
  addonName: string;
  vpkHelperPath: string;
  deadlockPak: string;
  ffmpegPath: string;
  soundFolder: string;
  /** Dir containing the live vanilla/community `soundevents/` tree to merge into. */
  vanillaRoot: string;
  outputDir: string;
  outputMode: "folder" | "vpk";
  vpkName: string;
  /** Other mods' pak01_dir.vpk paths to combine in on compile. */
  importedMods: string[];
  /** Per-mod files DESELECTED in the import review (mod vpk path → raw internal
   *  paths like `sounds/x.vsnd_c`): dropped from the combined stage on compile. */
  importedModExcludes: Record<string, string[]>;
  /** GameBanana attribution per bundled mod (vpk path → fetched page info).
   *  Keyed by path like importedModExcludes: it's a property of the file, so
   *  it survives profile switches. */
  importedModCredits: Record<string, GbModInfo>;
  /** Write a credits.txt next to the combined build - attribution for the
   *  bundled mods, ready to paste into a release description. */
  writeCreditsFile: boolean;
  /** Remembered import-review choices - the review opens pre-set to however
   *  you imported last time, so a preference sticks without re-clicking. */
  importMode: "linked" | "absorb";
  importZeroGain: boolean;
  importBundle: boolean;
  /** pak01_dir.vpk's identity (`len|mtime`) as of the last patch-fix (or first
   *  seen). A mismatch on boot = the game updated - surfaces "Fix for new
   *  patch" in the compile bar. "" = not seeded yet. */
  lastPakStamp: string;
  /** The sound library: audio files copied into app-data `library/` for easy
   *  reuse across slots (drop them in, copy out via the sound clipboard). */
  soundLibrary: LibraryItem[];
  /** Deadlock's `game/citadel/addons` folder — where installs are copied. */
  addonsDir: string;
  /** After a successful compile, also install the .vpk into the game. */
  installAfterCompile: boolean;
  /** Patch gameinfo.gi's addons search path on install if it's missing. */
  patchGameinfo: boolean;
  /** Install slot: null = auto-pick the next free slot; a number = overwrite that
   *  pakNN_dir.vpk. Set to the resolved slot after an auto install so repeated
   *  compile+installs reuse the same slot instead of filling new ones. */
  installSlot: number | null;
  /** Set once the first-run setup wizard has been completed or skipped. */
  firstRunDone: boolean;
  /** Show disabled / in-development ("experimental") heroes in the Heroes grid. */
  showExperimentalHeroes: boolean;
  /** Open the per-track "Compare to original" panel by default on each song. */
  compareByDefault: boolean;
  /** Experimental: reveal the VFX/particle recolor feature — the Effects tab and
   *  the per-item effect section. Off by default (very WIP). */
  experimentalEffects: boolean;
  /** Experimental: reveal the Custom Server tab (config editor / randomizer /
   *  hosting). Off by default; the tab stays visible while a project already
   *  carries gameplay edits so they can't get stranded. */
  experimentalServer: boolean;
  /** Experimental: reveal the UI Master tab (edit the game's panorama
   *  layouts/styles directly). Very experimental — a bad edit can break the
   *  in-game UI until the mod is removed. */
  experimentalUiMaster: boolean;
  /** Experimental: reveal the Easy Compile tab (compile any source file to
   *  its _c form into a folder of your choice - UI vtex etc.). */
  experimentalEasyCompile: boolean;
  /** Experimental: reveal the Mod combiner tab (bundle other mods' vpks into
   *  the compiled pack). Off by default; the tab stays visible while mods are
   *  already bundled so nothing ships invisibly or gets stranded. */
  experimentalModCombiner: boolean;
  /** Reveal the Jumpscares/Deaths (MoonahMasterUI) tab even when the mod
   *  isn't detected in the addons: start from a blank template and generate
   *  the whole mod from scratch. The tab also self-shows on detection or when
   *  the project already configures it, independent of this toggle. */
  enableJumpscares: boolean;
  /** Easy Compile: where compiled files land (persisted between runs). */
  easyCompileOutDir: string;
  /** Include UI-tab sound changes in the compiled build. Off by default — UI
   *  soundevent edits make broad menu changes that can break things. */
  includeUiSounds: boolean;
  /** Path to VRF's Source2Viewer.exe — enables "Open in real viewer" for effects. */
  source2ViewerPath: string;
  /** Bake Custom Server gameplay edits (abilities.vdata) into the build. OFF by
   *  default — gameplay mods only work on private/dedicated servers, not public
   *  matchmaking, so they're excluded unless you opt in. */
  includeGameplay: boolean;
  /** Per-entity exclusions from the gameplay build: override keys (hero ability
   *  keys, item names, `file::entity` for world entities, or `__cat:<section>`
   *  for whole categories) the user marked "not included". Edits stay saved but
   *  are filtered out at compile. */
  excludedConfigKeys: string[];
  /** What the Randomize button is allowed to touch. */
  randomizer: { skipMovement: boolean; skipCast: boolean; skipScale: boolean; includeGuns: boolean; noNegative: boolean; randomizeItemTiers: boolean; heroStats: boolean; heroInvestment: boolean; unsorted: boolean };
  /** After launching a host: auto-enable sv_cheats and restart the map once
   *  the server is up (joining the launch-state map loads a broken world;
   *  a fresh restart is the reliable join state). Default on. */
  hostAutoPrep: boolean;
  /** Name of the currently-loaded profile (build config). Empty until the first
   *  profile is bootstrapped. The active profile owns `importedMods`. */
  activeProfile: string;
  /** Baseline of known game sound events (`relpath::eventName`), seeded on the
   *  first "Fix for new patch". Future fixes diff the live game against this so
   *  only events a NEW patch added surface in the "New / Unsorted" tab. */
  knownSoundEvents: string[];
  /** Soundevents files the sweep has already tracked. Empty = the full-pak
   *  sweep hasn't run yet (its first run seeds unknown files silently); after
   *  that, a file not in this list means a PATCH added it, so its events
   *  surface instead of being silently baselined. */
  knownSweepFiles: string[];
  /** One-time migration marker: UI-tab edits used to always compile; on first
   *  load after the includeUiSounds gate shipped, projects that already carry
   *  UI content get the gate enabled so existing mods keep building. */
  uiSoundsMigrated: boolean;
  /** Posters tab: user corrections to manifest region rects (keyed
   *  `sheetId::posterId`). Applied over posterManifest.json everywhere a rect
   *  is used, and copied into existing overrides when edited. */
  posterRectEdits: Record<string, { x: number; y: number; w: number; h: number }>;
  /** Posters tab: regions the user marked "unused" (atlas junk not visible in
   *  the map). Invisible unless `showUnusedPosters` is on. */
  posterHidden: string[];
  /** Posters tab: whole sheets marked "unused" (e.g. Neon Prime-era leftovers
   *  never placed in the map). Invisible unless `showUnusedPosters` is on. */
  posterHiddenSheets: string[];
  /** Experimental: reveal unused-marked poster sheets/regions for auditing. */
  showUnusedPosters: boolean;
  /** Posters tab: user-drawn extra regions per sheet (for art the generated
   *  manifest doesn't split out). Behave exactly like manifest regions. */
  posterCustomRegions: Record<
    string,
    { id: string; x: number; y: number; w: number; h: number }[]
  >;
}

/** Release gate: the Deaths half of the Jumpscares feature is held back from
 *  the public for now (the death-detection poller is patch-fragile). DEV-only
 *  on purpose: the dev app (npm run tauri dev) shows and compiles Deaths for
 *  local testing, while every release build hides them - it can't ship by
 *  accident. Saved death entries ride along untouched either way. Replace
 *  with `true` to release Deaths to everyone. */
export const DEATHS_RELEASED = import.meta.env.DEV;

const REPO = "C:/Users/ethob/Desktop/DeadlockModding/EasyIntroModder";
const CSDK = "C:/Users/ethob/Desktop/DeadlockModding/Reduced_CSDK_12";

/** Where the one-click setup downloads the prebuilt tools bundle (trimmed CSDK
 *  compiler + static ffmpeg, built by `EIM_Tools_v2.zip` at the repo root's
 *  sibling folder). v2 adds `game/citadel/shaders_{vulkan,pc}_*.vpk` (~51MB)
 *  and `content/core/materials/default/*.tga|png|txt` (~4MB) — REQUIRED for
 *  Wall Art material compiles (v1 fails with "No valid vcs file found for
 *  shader citadel_overlay.vfx", then missing default texture sources).
 *  Upload the zip as a GitHub release asset under this tag before shipping. */
export const TOOLS_BUNDLE_URL =
  "https://github.com/Moonahuwu/MoonahsModMaker/releases/download/tools-v2/EIM_Tools_v2.zip";

export const DEFAULT_SETTINGS: Settings = {
  csdkRoot: CSDK,
  addonName: "eim_intro_music",
  vpkHelperPath: `${REPO}/tools/vpk-helper/dist/vpk-helper.exe`,
  deadlockPak:
    "D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk",
  ffmpegPath: "",
  soundFolder: "sounds/music/match_intro",
  vanillaRoot: `${REPO}/ModFiles`,
  outputDir: `${REPO}/output`,
  outputMode: "vpk",
  vpkName: "pak01_dir.vpk",
  importedMods: [],
  importedModExcludes: {},
  importedModCredits: {},
  writeCreditsFile: true,
  importMode: "linked",
  importZeroGain: false,
  importBundle: true,
  lastPakStamp: "",
  soundLibrary: [],
  addonsDir:
    "D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/addons",
  installAfterCompile: false,
  patchGameinfo: true,
  installSlot: null,
  firstRunDone: false,
  showExperimentalHeroes: false,
  compareByDefault: false,
  experimentalEffects: false,
  experimentalServer: false,
  experimentalUiMaster: false,
  experimentalEasyCompile: false,
  experimentalModCombiner: false,
  enableJumpscares: false,
  easyCompileOutDir: "",
  includeUiSounds: false,
  source2ViewerPath: "",
  includeGameplay: false,
  excludedConfigKeys: [],
  randomizer: { skipMovement: false, skipCast: false, skipScale: true, includeGuns: false, noNegative: true, randomizeItemTiers: false, heroStats: false, heroInvestment: false, unsorted: false },
  hostAutoPrep: true,
  activeProfile: "",
  knownSoundEvents: [],
  knownSweepFiles: [],
  uiSoundsMigrated: false,
  posterRectEdits: {},
  posterHidden: [],
  posterHiddenSheets: [],
  showUnusedPosters: false,
  posterCustomRegions: {},
};

const STORAGE_KEY = "eim.settings.v1";

export function useSettings() {
  // Render immediately from the localStorage cache (sync), then reconcile with the
  // durable backend copy once it loads.
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  // Gate backend writes until the initial backend load has merged, so we never
  // clobber the persisted file with defaults on a fresh webview. `ready` is the
  // observable form, so consumers (profile bootstrap) can wait for it.
  const loaded = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const remote = await loadSettings<Partial<Settings>>();
        if (remote) setSettings((s) => ({ ...DEFAULT_SETTINGS, ...s, ...remote }));
      } catch {
        /* backend settings optional */
      } finally {
        loaded.current = true;
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    if (!loaded.current) return;
    const id = setTimeout(() => void saveSettings(settings), 400);
    return () => clearTimeout(id);
  }, [settings]);

  // Accepts a plain patch or a function of the previous settings - use the
  // functional form when the patch is computed from current values (e.g.
  // toggling entries in a list), so rapid updates can't clobber each other.
  const update = (patch: Partial<Settings> | ((prev: Settings) => Partial<Settings>)) =>
    setSettings((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));

  return { settings, update, ready };
}

/** The compile/install preferences a profile carries (mirrored into every
 *  profile save). Settings stays the live copy the UI edits; these travel
 *  with the profile so switching restores them - each profile keeps
 *  replacing its own game slot. Machine paths stay global. */
export function compilePrefsOf(s: Settings): ProfileCompilePrefs {
  return {
    installSlot: s.installSlot,
    installAfterCompile: s.installAfterCompile,
    outputMode: s.outputMode,
    vpkName: s.vpkName,
  };
}

/** Category of a world-entity override. The SINGLE source of truth for both
 *  the config editor's per-category chips and the compile gate - if these two
 *  ever classified differently, a chip could silently stop excluding. */
export function worldOverrideCategory(
  file: string,
  entity: string,
): "minions" | "boxes" | "powerups" | "other" {
  if (file.includes("npc_units")) return "minions";
  if (file.includes("misc")) {
    if (entity.includes("breakable")) return "boxes";
    if (entity.includes("powerup") || entity.includes("pickup")) return "powerups";
  }
  return "other";
}

/** How many gameplay edits will actually ship, given the master gate and the
 *  exclusion keys. Mirrors the compile-time filtering exactly (same helpers),
 *  so the editor's "will ship X of Y" summary can't lie. */
export function gameplayShipCounts(
  includeGameplay: boolean,
  excludedKeys: string[],
  vdata: { abilityKey: string }[],
  globalsCount: number,
  world: { file: string; entity: string }[],
  itemNames: Set<string>,
): { total: number; shipped: number } {
  const ex = new Set(excludedKeys);
  const total = vdata.length + globalsCount + world.length;
  if (!includeGameplay) return { total, shipped: 0 };
  let shipped = 0;
  for (const o of vdata) {
    if (ex.has(o.abilityKey)) continue;
    const isItem = itemNames.has(o.abilityKey);
    if (isItem && ex.has("__cat:items")) continue;
    if (!isItem && ex.has("__cat:heroes")) continue;
    shipped++;
  }
  if (!ex.has("__cat:global")) shipped += globalsCount;
  for (const o of world) {
    if (ex.has(`${o.file}::${o.entity}`)) continue;
    const cat = worldOverrideCategory(o.file, o.entity);
    if (cat !== "other" && ex.has(`__cat:${cat}`)) continue;
    shipped++;
  }
  return { total, shipped };
}

/** Where a slot's tracks compile to (and what their `.vsnd` refs start with):
 *  the directory of the event's stock sound — its "respective" home — so urn
 *  music lands under `sounds/music/…`, hero ability sounds under
 *  `sounds/abilities/<hero>/…`, etc. Events with no stock ref get a namespaced
 *  per-tab folder; the global setting stays the fallback for match intro. */
export function slotSoundFolder(
  ev: { group: string; stockEntry: string },
  globalFolder: string,
): string {
  const i = ev.stockEntry.lastIndexOf("/");
  if (i > 0) return ev.stockEntry.slice(0, i);
  return ev.group === "intro" ? globalFolder : `sounds/eim/${ev.group}`;
}

/** Human-readable attribution for the bundled mods: GameBanana page info when
 *  one is linked, the bare file name otherwise. Feeds combined/credits.txt and
 *  the "Copy credits" button. Empty string when nothing is bundled. */
/** Sentinel credits entry marking a bundled vpk as the user's OWN work - it
 *  renders a "made by you" chip and is left out of credits.txt (the release
 *  itself speaks for the releaser). Lives in importedModCredits so it rides
 *  every existing migration (pack-cache re-keying etc.) for free. */
export const MADE_BY_ME: GbModInfo = {
  modId: -1,
  pageUrl: "",
  name: "",
  author: "",
  authorUrl: "",
  credits: [],
  md5Verified: false,
};

export function isMadeByMe(info: GbModInfo | undefined): boolean {
  return !!info && info.modId === -1;
}

export function buildCreditsText(s: Settings): string {
  // Packs marked as the user's own need no attribution line.
  const others = s.importedMods.filter((m) => !isMadeByMe(s.importedModCredits?.[m]));
  if (others.length === 0) return "";
  const blocks = others.map((m) => {
    const info = s.importedModCredits?.[m];
    if (!info) {
      const base = m.split(/[\\/]/).pop() ?? m;
      return `- ${base} (no GameBanana page linked)`;
    }
    const lines = [
      `- ${info.name}${info.author ? ` by ${info.author}` : ""}`,
      `  ${info.pageUrl}`,
    ];
    for (const c of info.credits) {
      lines.push(
        `  credit: ${c.name}${c.role ? ` (${c.role})` : ""}${c.url ? ` - ${c.url}` : ""}`,
      );
    }
    return lines.join("\n");
  });
  return [
    "This pack bundles the following mods. All credit to their authors.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** The compiled .vpk to install: the `combined/` variant when mods are imported
 *  (it contains yours + theirs), otherwise the `mine/` variant. */
export function installSrcVpk(s: Settings): string {
  const variant = s.importedMods.length > 0 ? "combined" : "mine";
  return `${s.outputDir}/${variant}/${s.vpkName}`;
}

/** Direct replace: the slot swaps its only sound (one track, the original
 *  entry disabled, nothing else touched), so there's no need to edit the
 *  shared events file at all - the user's audio compiles AT the original
 *  path and the untouched event plays it by its original name. Returns the
 *  `.vsnd` ref to shadow, or null when the slot needs a real merge.
 *  Duration: a merge only ever EXTENDS vsnd_duration for longer clips, so a
 *  clip that fits inside the event's existing duration behaves identically
 *  either way - only longer clips keep merging. Slots without a stockEntry
 *  (hero abilities, items) qualify when the pool holds exactly the one entry
 *  the user disabled. */
export function directReplaceTarget(
  ev: EventProject,
  explicitOverrideRefs: Set<string>,
  pools: Record<string, { vsndDuration: number | null; entries?: string[] } | undefined>,
): string | null {
  const pool = pools[ev.id];
  if (!pool) return null;
  if (ev.songs.length !== 1 || ev.adopted.length !== 0 || ev.vsndDurationMode !== "auto")
    return null;
  const clipLen = Math.max(0, ev.songs[0].trimEnd - ev.songs[0].trimStart);
  if (pool.vsndDuration !== null && clipLen > pool.vsndDuration) return null;
  const disabled = new Set([...ev.excludedEntries, ...ev.removedEntries]);
  if (disabled.size !== 1) return null;
  const target = [...disabled][0];
  // Placeholder refs are shared across events - never shadow those.
  if (!target || target.endsWith("null.vsnd")) return null;
  if (ev.stockEntry) {
    if (target !== ev.stockEntry) return null;
  } else {
    // No stock ref recorded (hero/item slots): the pool must hold exactly
    // the one original the user disabled, so the swap can't touch anything
    // that wasn't already this event's only sound.
    if (!pool.entries || pool.entries.length !== 1 || pool.entries[0] !== target) return null;
  }
  if (explicitOverrideRefs.has(target)) return null;
  return target;
}

/** Derive the full CompileConfig from settings + the project's events.
 *  `pools` (slot id → live event view) unlocks the direct-replace shortcut:
 *  a slot that just swaps its ONLY sound compiles at the stock path instead
 *  of editing the shared events file. */
export function buildCompileConfig(
  s: Settings,
  events: EventProject[],
  skipCompile = false,
  iconMods: { sourceImage: string; targetVtexc: string; width: number; height: number; hue?: number; enabled?: boolean }[] = [],
  soundOverrides: SoundOverride[] = [],
  effectOverrides: EffectOverride[] = [],
  vdataOverrides: VdataCompile[] = [],
  globalOverrides: GlobalCompile[] = [],
  worldOverrides: WorldCompile[] = [],
  posterOverrides: PosterOverride[] = [],
  digimod: DigimodConfig | null = null,
  uiOverrides: UiFileOverride[] = [],
  pools: Record<string, { vsndDuration: number | null; entries?: string[] } | undefined> = {},
): CompileConfig {
  const explicitOverrideRefs = new Set(soundOverrides.map((o) => o.targetRef));
  const directTargets = new Map<string, string>();
  for (const ev of events) {
    const t = directReplaceTarget(ev, explicitOverrideRefs, pools);
    if (t) directTargets.set(ev.id, t);
  }
  const directSlots = events.filter((ev) => directTargets.has(ev.id));
  // A slot with no changes leaves its events file alone - and an events file
  // nobody touches stays OUT of the build entirely (a replace-two-sounds
  // profile must not ship every soundevents file it never edited).
  const mergeSlots = events.filter(
    (ev) =>
      !directTargets.has(ev.id) &&
      (ev.songs.length > 0 ||
        ev.adopted.length > 0 ||
        ev.excludedEntries.length > 0 ||
        ev.removedEntries.length > 0 ||
        ev.previousOwnedNames.length > 0),
  );
  const directCompiles: SoundOverrideCompile[] = directSlots.map((ev) => {
    const song = ev.songs[0];
    return {
      targetRef: directTargets.get(ev.id)!,
      sourceAudio: song.sourceMp3,
      trimStart: song.trimStart,
      trimEnd: song.trimEnd,
      gainDb: song.gainDb,
      fadeIn: song.fadeIn,
      fadeOut: song.fadeOut,
      looping: song.looping,
      layers: (song.layers ?? [])
        .filter((l) => l.sourceAudio)
        .map((l) => ({
          sourceAudio: l.sourceAudio,
          gainDb: l.gainDb,
          offset: l.offset ?? 0,
          trimStart: l.trimStart ?? 0,
          trimEnd: l.trimEnd ?? 0,
        })),
      // The app stamps songs with songHash after a good compile, so the
      // up-to-date check must speak the same fingerprint.
      currentHash: songHash(song),
      lastCompiledHash: song.lastCompiledHash,
      // Where this song's render landed when the slot still merged - lets an
      // unchanged track move to the stock path without its source audio.
      reuseFrom: `${slotSoundFolder(ev, s.soundFolder)}/${song.soundName}.vsnd_c`,
    };
  });
  const posterCompiles: PosterCompile[] = posterOverrides.map((p) => ({
    sheetId: p.sheetId,
    materials: p.materials,
    label: p.label,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    alphaCoverage: p.alphaCoverage,
    sourceImage: p.sourceImage,
    fit: p.fit,
    rotation: p.rotation ?? 0,
    erase: p.erase ?? false,
    currentHash: posterHash(p, sheetSiblingsKey(posterOverrides, p.sheetId)),
    lastCompiledHash: p.lastCompiledHash ?? null,
  }));
  const iconCompiles: IconCompile[] = iconMods
    .filter((m) => m.enabled !== false)
    .map((m) => ({
      sourceImage: m.sourceImage,
      targetVtexc: m.targetVtexc,
      width: m.width,
      height: m.height,
      hue: m.hue ?? 0,
    }));
  const effectCompiles: EffectCompile[] = effectOverrides.map((e) => ({
    targetRef: e.targetRef,
    hue: e.hue,
    saturation: e.saturation,
    mode: e.mode,
    currentHash: effectHash(e),
    lastCompiledHash: e.lastCompiledHash ?? null,
  }));
  const overrideCompiles: SoundOverrideCompile[] = soundOverrides.map((o) => ({
    targetRef: o.targetRef,
    sourceAudio: o.sourceAudio,
    trimStart: o.trimStart,
    trimEnd: o.trimEnd,
    gainDb: o.gainDb,
    fadeIn: o.fadeIn,
    fadeOut: o.fadeOut,
    looping: o.looping,
    currentHash: overrideHash(o),
    lastCompiledHash: o.lastCompiledHash ?? null,
  }));
  const eventCompiles: EventCompile[] = mergeSlots.map((ev) => ({
    eventName: ev.eventName,
    arrayKey: ev.arrayKey,
    stockEntry: ev.stockEntry,
    soundFolder: slotSoundFolder(ev, s.soundFolder),
    durationMode: ev.vsndDurationMode,
    durationManual: ev.vsndDurationManual,
    previousOwned: ev.previousOwnedNames,
    // Both disabled (toggled-off) and removed entries are dropped from the array.
    excluded: [...ev.excludedEntries, ...ev.removedEntries],
    eventsRelpath: ev.eventsRelpath,
    // Adopted-from-mod entries (removed ones dropped entirely).
    adopted: ev.adopted
      .filter((a) => !ev.removedEntries.includes(a.reference))
      .map((a) => ({ reference: a.reference, sourceVpk: a.sourceVpk })),
    songs: ev.songs.map((song) => ({
      soundName: song.soundName,
      sourceAudio: song.sourceMp3,
      trimStart: song.trimStart,
      trimEnd: song.trimEnd,
      gainDb: song.gainDb,
      fadeIn: song.fadeIn,
      fadeOut: song.fadeOut,
      looping: song.looping,
      layers: (song.layers ?? [])
        .filter((l) => l.sourceAudio)
        .map((l) => ({
          sourceAudio: l.sourceAudio,
          gainDb: l.gainDb,
          offset: l.offset ?? 0,
          trimStart: l.trimStart ?? 0,
          trimEnd: l.trimEnd ?? 0,
        })),
      currentHash: songHash(song),
      lastCompiledHash: song.lastCompiledHash,
    })),
  }));

  return {
    contentRoot: `${s.csdkRoot}/content/citadel_addons/${s.addonName}`,
    compiledRoot: `${s.csdkRoot}/game/citadel_addons/${s.addonName}`,
    gameInfoDir: `${s.csdkRoot}/game/citadel`,
    soundFolder: s.soundFolder,
    resourceCompiler: `${s.csdkRoot}/game/bin_tools/win64/resourcecompiler.exe`,
    ffmpegPath: s.ffmpegPath || undefined,
    vpkHelperPath: s.vpkHelperPath || undefined,
    vanillaRoot: s.vanillaRoot,
    pakPath: s.deadlockPak || undefined,
    outputDir: s.outputDir,
    outputMode: s.outputMode,
    vpkName: s.vpkName,
    writeEncodingTxt: true,
    skipCompile,
    importedMods: s.importedMods,
    importedModExcludes: s.importedModExcludes ?? {},
    creditsText: s.writeCreditsFile ? buildCreditsText(s) || undefined : undefined,
    events: eventCompiles,
    iconMods: iconCompiles,
    soundOverrides: [...overrideCompiles, ...directCompiles],
    effectOverrides: effectCompiles,
    vdataOverrides,
    globalOverrides,
    worldOverrides,
    posterOverrides: posterCompiles,
    // Entries without media can't compile — drop them rather than failing.
    // Sounds/soundIds map to the shared library shape the backend expects.
    digimod: digimod
      ? (() => {
          const sounds = (digimod.sounds ?? []).filter((s) => s.sourceAudio);
          const entry = (e: (typeof digimod.scares)[number]) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            sourceMedia: e.sourceMedia,
            show: e.show,
            preset: e.preset,
            soundId:
              e.soundId && sounds.some((s) => s.id === e.soundId) ? e.soundId : null,
          });
          return {
            rngInterval: digimod.rngInterval,
            scareChance: digimod.scareChance,
            deathChance: digimod.deathChance,
            scares: digimod.scares.filter((e) => e.sourceMedia).map(entry),
            // Deaths are held back from the build while unreleased - the
            // entries stay saved in the project, they just don't compile.
            deaths: DEATHS_RELEASED
              ? digimod.deaths.filter((e) => e.sourceMedia).map(entry)
              : [],
            sounds: sounds.map((s) => ({
              id: s.id,
              sourceAudio: s.sourceAudio,
              volume: s.volume,
              trimStart: s.trimStart ?? 0,
              trimEnd: s.trimEnd ?? 0,
              gainDb: s.gainDb ?? 0,
              fadeIn: s.fadeIn ?? 0,
              fadeOut: s.fadeOut ?? 0,
            })),
            mergeVpks: digimod.mergeVpks ?? [],
          };
        })()
      : null,
    // Whole-file text overrides — only real edits ship.
    uiOverrides: uiOverrides
      .filter((u) => u.text.trim().length > 0)
      .map((u) => ({ targetRel: u.targetRel, text: u.text })),
  };
}

/** Sorted fingerprint of all overrides on a sheet (see posterHash). */
export function sheetSiblingsKey(all: PosterOverride[], sheetId: string): string {
  return all
    .filter((p) => p.sheetId === sheetId)
    .map((p) => `${p.id}=${p.sourceImage}`)
    .sort()
    .join(",");
}
