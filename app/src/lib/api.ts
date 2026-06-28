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
  /** Live game pak — lets compile auto-fetch a missing vanilla events file. */
  pakPath?: string;
  outputDir: string;
  outputMode: string;
  vpkName: string;
  writeEncodingTxt: boolean;
  skipCompile: boolean;
  importedMods: string[];
  events: EventCompile[];
  iconMods?: IconCompile[];
  soundOverrides?: SoundOverrideCompile[];
}

export interface IconCompile {
  sourceImage: string;
  targetVtexc: string;
  width: number;
  height: number;
  hue: number;
}

export interface SoundOverrideCompile {
  targetRef: string;
  sourceAudio: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
  currentHash: string;
  lastCompiledHash: string | null;
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

export interface HeroPortrait {
  codename: string;
  displayName: string;
  portraitPath: string;
  /** "Gloat" card shown on hover, if the game has one. */
  gloatPath: string | null;
  /** Disabled / in-development per the game data (hidden unless opted in). */
  experimental: boolean;
  /** In-game UI theme colors (#RRGGBB from m_colorUI), if any. */
  color: string | null;
  colorSecondary: string | null;
}

/** Decode (cached) + list the hero roster with card-portrait PNG paths. Pass
 *  refresh=true to re-decode from the game pak (e.g. after a game update). */
export function heroRoster(
  helperPath: string,
  pakPath: string,
  refresh = false,
): Promise<HeroPortrait[]> {
  return invoke("hero_roster", { helperPath, pakPath, refresh });
}

export interface HeroAbilitySound {
  eventName: string;
  arrayKey: string;
  eventsRelpath: string;
  label: string;
}

export interface HeroAbility {
  slot: number;
  ability: string;
  iconPath: string | null;
  sounds: HeroAbilitySound[];
}

/** A hero's 4 signature abilities with icon + the sound events each triggers. */
export function heroDetail(
  helperPath: string,
  pakPath: string,
  codename: string,
  refresh = false,
): Promise<HeroAbility[]> {
  return invoke("hero_detail", { helperPath, pakPath, codename, refresh });
}

/** One of a hero's voicelines (single-clip soundevent). */
export interface VoiceLine {
  eventName: string;
  arrayKey: string;
  eventsRelpath: string;
  label: string;
  /** First stock clip reference, for preview. */
  stockRef: string | null;
}

/** All of a hero's voicelines (often 1000+). Cached per hero; refresh re-pulls. */
export function heroVoicelines(
  helperPath: string,
  pakPath: string,
  codename: string,
  refresh = false,
): Promise<VoiceLine[]> {
  return invoke("hero_voicelines", { helperPath, pakPath, codename, refresh });
}

/** Coarse bucket for a hero sound event. */
export type HeroSoundCategory = "gunfire" | "abilities" | "movement" | "other";

/**
 * One of a hero's non-VO sound events (gunfire, abilities, movement…). Same
 * shape as {@link VoiceLine} plus a `category`, so it reuses the voiceline
 * lazy-materialization path.
 */
export interface HeroSound {
  eventName: string;
  arrayKey: string;
  eventsRelpath: string;
  label: string;
  stockRef: string | null;
  category: HeroSoundCategory;
}

/** A hero's gunfire/ability/movement sound events. Cached per hero. */
export function heroSounds(
  helperPath: string,
  pakPath: string,
  codename: string,
  refresh = false,
): Promise<HeroSound[]> {
  return invoke("hero_sounds", { helperPath, pakPath, codename, refresh });
}

/** One sub-folder in the game's sound tree (lazy browse). */
export interface SoundFolder {
  name: string;
  prefix: string;
  count: number;
}

/** One game sound file (override target). */
export interface SoundFile {
  /** The `.vsnd` reference to override, e.g. `sounds/vo/atlas/x.vsnd`. */
  reference: string;
  label: string;
}

export interface SoundBrowse {
  folders: SoundFolder[];
  files: SoundFile[];
  truncated: boolean;
  total: number;
}

/** Browse the game's sound tree under `prefix` (lazy). With `query`, returns a
 *  flat recursive search; without, immediate subfolders + files at that level. */
export function browseGameSounds(
  helperPath: string,
  pakPath: string,
  prefix: string,
  query = "",
  refresh = false,
): Promise<SoundBrowse> {
  return invoke("browse_game_sounds", { helperPath, pakPath, prefix, query, refresh });
}

/** A shop item card (icon + category + tier) for the Items tab. */
export interface ItemCard {
  name: string;
  displayName: string;
  /** "weapon" | "vitality" | "spirit" | "other" */
  category: string;
  /** 1..5 (0 = unknown) */
  tier: number;
  iconPath: string | null;
  /** Compiled vtex_c path the game references (override target for a custom icon). */
  iconInternal: string | null;
}

export function itemRoster(
  helperPath: string,
  pakPath: string,
  refresh = false,
): Promise<ItemCard[]> {
  return invoke("item_roster", { helperPath, pakPath, refresh });
}

/** An item's editable sound events (same shape as hero ability sounds). */
export function itemDetail(
  helperPath: string,
  pakPath: string,
  itemName: string,
  refresh = false,
): Promise<HeroAbilitySound[]> {
  return invoke("item_detail", { helperPath, pakPath, itemName, refresh });
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

/** Persist the settings blob to the app-data dir (durable, machine-scoped). */
export function saveSettings(settings: unknown): Promise<void> {
  return invoke("save_settings", { settings });
}

/** Load persisted settings, or null if none saved yet. */
export function loadSettings<T = unknown>(): Promise<T | null> {
  return invoke("load_settings");
}

/** A named build config: the project plus its imported mods. Machine paths are
 *  global (in settings), not part of a profile. */
export interface ProfileBlob {
  project: Project;
  importedMods: string[];
}

export function listProfiles(): Promise<string[]> {
  return invoke("list_profiles");
}

export function saveProfile(name: string, data: ProfileBlob): Promise<void> {
  return invoke("save_profile", { name, data });
}

export function loadProfile(name: string): Promise<ProfileBlob | null> {
  return invoke("load_profile", { name });
}

export function deleteProfile(name: string): Promise<void> {
  return invoke("delete_profile", { name });
}

export function renameProfile(from: string, to: string): Promise<void> {
  return invoke("rename_profile", { from, to });
}
