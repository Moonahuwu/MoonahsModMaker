import { useEffect, useState } from "react";
import type { CompileConfig, EventCompile } from "./api";
import type { EventProject } from "../types";

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
}

const REPO = "C:/Users/ethob/Desktop/DeadlockModding/EasyIntroModder";
const CSDK = "C:/Users/ethob/Desktop/DeadlockModding/Reduced_CSDK_12";

export const DEFAULT_SETTINGS: Settings = {
  csdkRoot: CSDK,
  addonName: "eim_intro_music",
  vpkHelperPath: `${REPO}/tools/vpk-helper/bin/Release/net10.0/vpk-helper.dll`,
  deadlockPak:
    "D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/pak01_dir.vpk",
  ffmpegPath: "",
  soundFolder: "sounds/music/match_intro",
  vanillaRoot: `${REPO}/ModFiles`,
  outputDir: `${REPO}/output`,
  outputMode: "vpk",
  vpkName: "pak01_dir.vpk",
  importedMods: [],
};

const STORAGE_KEY = "eim.settings.v1";

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => ({ ...s, ...patch }));

  return { settings, update };
}

/** Derive the full CompileConfig from settings + the project's events. */
export function buildCompileConfig(
  s: Settings,
  events: EventProject[],
  skipCompile = false,
): CompileConfig {
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
    outputDir: s.outputDir,
    outputMode: s.outputMode,
    vpkName: s.vpkName,
    writeEncodingTxt: true,
    skipCompile,
    importedMods: s.importedMods,
    events: eventCompiles,
  };
}
