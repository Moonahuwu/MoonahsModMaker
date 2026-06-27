// Typed wrappers around the Tauri backend commands.
import { invoke } from "@tauri-apps/api/core";
import type { AudioInfo, DerivedPaths, EventView, Project } from "../types";

export function probeAudio(
  path: string,
  ffmpegPath?: string,
): Promise<AudioInfo> {
  return invoke("probe_audio", { path, ffmpegPath });
}

export interface ProcessReq {
  sourcePath: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  ffmpegPath?: string;
}

// (looping is carried on Song/SongCompile, not preview ProcessReq)

/** Render the processed (trimmed + gained) preview; resolves to its WAV path. */
export function processAudio(req: ProcessReq): Promise<string> {
  return invoke("process_audio", { req });
}

export function readEventPool(
  eventsPath: string,
  eventName: string,
): Promise<EventView> {
  return invoke("read_event_pool", { eventsPath, eventName });
}

export interface SlotRef {
  eventsPath: string;
  eventName: string;
  arrayKey: string;
}

/** Reads each slot from its own events file; returns one entry per slot (null if
 *  that slot's event/array wasn't found), in order. */
export function readEventPools(
  slots: SlotRef[],
): Promise<(EventView | null)[]> {
  return invoke("read_event_pools", { slots });
}

export function derivePaths(
  gameContentRoot: string,
  soundFolder: string,
  soundName: string,
): Promise<DerivedPaths> {
  return invoke("derive_paths", { gameContentRoot, soundFolder, soundName });
}

export function sanitizeName(input: string): Promise<string> {
  return invoke("sanitize_name", { input });
}

export interface SongCompile {
  soundName: string;
  sourceAudio: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
  /** Fingerprint of the current params; matches the skip check in the backend. */
  currentHash: string;
  /** Hash recorded after the last successful compile (null = never compiled). */
  lastCompiledHash: string | null;
}

export interface EventCompile {
  eventName: string;
  arrayKey: string;
  stockEntry: string;
  durationMode: string;
  durationManual: number | null;
  previousOwned: string[];
  excluded: string[];
  eventsRelpath: string;
  adopted: { reference: string; sourceVpk: string }[];
  songs: SongCompile[];
}

export interface CompileConfig {
  contentRoot: string;
  compiledRoot: string;
  gameInfoDir: string;
  soundFolder: string;
  resourceCompiler: string;
  ffmpegPath?: string;
  vpkHelperPath?: string;
  vanillaRoot: string;
  outputDir: string;
  outputMode: string;
  vpkName: string;
  writeEncodingTxt: boolean;
  skipCompile: boolean;
  importedMods: string[];
  events: EventCompile[];
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CompileReport {
  ok: boolean;
  steps: StepResult[];
  outputPath?: string;
}

export function compileProject(config: CompileConfig): Promise<CompileReport> {
  return invoke("compile_project", { config });
}

export function newProject(): Promise<Project> {
  return invoke("new_project");
}

/** Check existence of each path; returns a bool per path, in order. */
export function checkPaths(paths: string[]): Promise<boolean[]> {
  return invoke("check_paths", { paths });
}

/** Decode a stock track's .vsnd_c from the game pak; returns the audio path. */
export function decodeStock(
  helperPath: string,
  pakPath: string,
  stockRef: string,
): Promise<string> {
  return invoke("decode_stock", { helperPath, pakPath, stockRef });
}

/** Decode a compiled entry from a vpk and save a copy into Downloads. */
export function downloadEntry(
  helperPath: string,
  vpk: string,
  reference: string,
): Promise<string> {
  return invoke("download_entry", { helperPath, vpk, reference });
}

/** Copy an existing audio file (e.g. a source mp3) into Downloads. */
export function copyToDownloads(srcPath: string): Promise<string> {
  return invoke("copy_to_downloads", { srcPath });
}

export interface ArrayInfo {
  eventName: string;
  arrayKey: string;
  entries: string[];
}

/** Read every vsnd_files* array a mod's soundevents define (for adopting). */
export function readModArrays(
  helperPath: string,
  vpk: string,
): Promise<ArrayInfo[]> {
  return invoke("read_mod_arrays", { helperPath, vpk });
}

export interface RefreshResult {
  vanillaRoot: string;
  refreshed: string[];
  failed: string[];
}

/** Decompile the current game's events files from its pak into an app-managed
 *  vanilla dir, so compile merges into live game data (fixes drifted refs). */
export function refreshVanilla(
  helperPath: string,
  pakPath: string,
  relpaths: string[],
): Promise<RefreshResult> {
  return invoke("refresh_vanilla", { helperPath, pakPath, relpaths });
}

export interface DetectedPaths {
  csdkRoot: string | null;
  resourceCompiler: string | null;
  deadlockPak: string | null;
  addonsDir: string | null;
  ffmpeg: string | null;
  vpkHelper: string | null;
}

/** Best-effort auto-detection of tool/game paths (Steam, CSDK, ffmpeg, helper). */
export function autodetectPaths(): Promise<DetectedPaths> {
  return invoke("autodetect_paths");
}

export interface SlotScan {
  /** Slot numbers (1..99) currently occupied by some file in the addons folder. */
  used: number[];
  /** Lowest free slot, or null if all are taken. */
  nextFree: number | null;
  maxSlot: number;
}

/** Scan the Deadlock addons folder for used pakNN slots + the next free one. */
export function scanAddonSlots(addonsDir: string): Promise<SlotScan> {
  return invoke("scan_addon_slots", { addonsDir });
}

export interface InstallResult {
  slot: number;
  target: string;
  replaced: boolean;
  backup: string | null;
  gameinfoPatched: boolean;
  gameinfoNote: string;
}

/** Install a compiled .vpk into Deadlock's addons folder. `slot = null` auto-picks
 *  the next free slot; a number overwrites that slot (backing up any occupant). */
export function installToGame(
  srcVpk: string,
  addonsDir: string,
  slot: number | null,
  patchGameinfo: boolean,
): Promise<InstallResult> {
  return invoke("install_to_game", { srcVpk, addonsDir, slot, patchGameinfo });
}

export function loadProject(path: string): Promise<Project> {
  return invoke("load_project", { path });
}

/** Autosave the project to the app-data dir (no compile). */
export function saveState(project: Project): Promise<void> {
  return invoke("save_state", { project });
}

/** Load the autosaved project, or null if none yet. */
export function loadState(): Promise<Project | null> {
  return invoke("load_state");
}

export function saveProject(path: string, project: Project): Promise<void> {
  return invoke("save_project", { path, project });
}
