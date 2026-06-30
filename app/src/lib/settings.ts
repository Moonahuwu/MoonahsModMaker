import { useEffect, useRef, useState } from "react";
import type { CompileConfig, EffectCompile, EventCompile, GlobalCompile, IconCompile, SoundOverrideCompile, VdataCompile, WorldCompile } from "./api";
import { loadSettings, saveSettings } from "./api";
import type { EffectOverride, EventProject, SoundOverride } from "../types";
import { songHash, overrideHash, effectHash } from "./songHash";

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
  /** Path to VRF's Source2Viewer.exe — enables "Open in real viewer" for effects. */
  source2ViewerPath: string;
  /** Bake Custom Server gameplay edits (abilities.vdata) into the build. OFF by
   *  default — gameplay mods only work on private/dedicated servers, not public
   *  matchmaking, so they're excluded unless you opt in. */
  includeGameplay: boolean;
  /** Per-entity exclusions from the gameplay build: override keys (hero ability
   *  keys, item names, `file::entity` for world entities, or `__global__`) the
   *  user marked "not included". Edits stay saved but are filtered out at compile. */
  excludedConfigKeys: string[];
  /** What the Randomize button is allowed to touch. */
  randomizer: { skipMovement: boolean; skipCast: boolean; skipScale: boolean; includeGuns: boolean; noNegative: boolean; randomizeItemTiers: boolean; heroStats: boolean; heroInvestment: boolean; unsorted: boolean };
  /** Name of the currently-loaded profile (build config). Empty until the first
   *  profile is bootstrapped. The active profile owns `importedMods`. */
  activeProfile: string;
}

const REPO = "C:/Users/ethob/Desktop/DeadlockModding/EasyIntroModder";
const CSDK = "C:/Users/ethob/Desktop/DeadlockModding/Reduced_CSDK_12";

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
  addonsDir:
    "D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/addons",
  installAfterCompile: false,
  patchGameinfo: true,
  installSlot: null,
  firstRunDone: false,
  showExperimentalHeroes: false,
  compareByDefault: false,
  source2ViewerPath: "",
  includeGameplay: false,
  excludedConfigKeys: [],
  randomizer: { skipMovement: false, skipCast: false, skipScale: true, includeGuns: false, noNegative: true, randomizeItemTiers: false, heroStats: false, heroInvestment: false, unsorted: false },
  activeProfile: "",
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

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));

  return { settings, update, ready };
}

/** The compiled .vpk to install: the `combined/` variant when mods are imported
 *  (it contains yours + theirs), otherwise the `mine/` variant. */
export function installSrcVpk(s: Settings): string {
  const variant = s.importedMods.length > 0 ? "combined" : "mine";
  return `${s.outputDir}/${variant}/${s.vpkName}`;
}

/** Derive the full CompileConfig from settings + the project's events. */
export function buildCompileConfig(
  s: Settings,
  events: EventProject[],
  skipCompile = false,
  iconMods: { sourceImage: string; targetVtexc: string; width: number; height: number; hue?: number }[] = [],
  soundOverrides: SoundOverride[] = [],
  effectOverrides: EffectOverride[] = [],
  vdataOverrides: VdataCompile[] = [],
  globalOverrides: GlobalCompile[] = [],
  worldOverrides: WorldCompile[] = [],
): CompileConfig {
  const iconCompiles: IconCompile[] = iconMods.map((m) => ({
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
  const eventCompiles: EventCompile[] = events.map((ev) => ({
    eventName: ev.eventName,
    arrayKey: ev.arrayKey,
    stockEntry: ev.stockEntry,
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
    events: eventCompiles,
    iconMods: iconCompiles,
    soundOverrides: overrideCompiles,
    effectOverrides: effectCompiles,
    vdataOverrides,
    globalOverrides,
    worldOverrides,
  };
}
