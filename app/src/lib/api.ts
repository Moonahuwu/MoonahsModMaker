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
  /** Extra tracks mixed under the clip - preview matches the compile exactly. */
  layers?: LayerCompile[];
  ffmpegPath?: string;
}

/** A layer as the renderer sees it (see SongLayer for the editable form). */
export interface LayerCompile {
  sourceAudio: string;
  gainDb: number;
  /** Seconds into the bite where the layer starts. */
  offset: number;
  /** Clip window within the source; end <= start = to the file's end. */
  trimStart: number;
  trimEnd: number;
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
  /** Extra tracks mixed under this one at render (events never see layers). */
  layers?: LayerCompile[];
  /** Fingerprint of the current params; matches the skip check in the backend. */
  currentHash: string;
  /** Hash recorded after the last successful compile (null = never compiled). */
  lastCompiledHash: string | null;
}

export interface EventCompile {
  eventName: string;
  arrayKey: string;
  stockEntry: string;
  /** This event's "respective" content folder (from its stock sound's dir);
   *  omitted/empty = the global soundFolder. */
  soundFolder?: string;
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
  importedModExcludes?: Record<string, string[]>;
  /** Attribution for bundled mods - written as combined/credits.txt when set. */
  creditsText?: string;
  /** One-off subset export into a user-chosen folder: skips build stamps and
   *  the "no imports -> delete stale combined/" cleanup (that folder may hold
   *  a real combined build). */
  exportOnly?: boolean;
  events: EventCompile[];
  iconMods?: IconCompile[];
  soundOverrides?: SoundOverrideCompile[];
  effectOverrides?: EffectCompile[];
  vdataOverrides?: VdataCompile[];
  globalOverrides?: GlobalCompile[];
  worldOverrides?: WorldCompile[];
  posterOverrides?: PosterCompile[];
  digimod?: DigimodCompile | null;
  uiOverrides?: UiFileCompile[];
}

export interface UiFileCompile {
  targetRel: string;
  text: string;
}

export interface DigimodCompile {
  rngInterval: number;
  scareChance: number;
  deathChance: number;
  scares: DigiEntryCompile[];
  deaths: DigiEntryCompile[];
  sounds?: DigiSoundCompile[];
  mergeVpks?: string[];
}

export interface DigiSoundCompile {
  id: string;
  sourceAudio: string;
  volume: number;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
}

export interface DigiEntryCompile {
  id: string;
  name: string;
  kind: string;
  sourceMedia: string;
  show: number;
  preset: string;
  soundId?: string | null;
}

/** True when an installed addon pak ships the MoonahMasterUI jumpscare engine (legacy DigiMaster paks count too). */
export function digimodDetected(addonsDir: string): Promise<boolean> {
  return invoke("digimod_detected", { addonsDir });
}

/** An installed pak overriding base_hud (a panorama UI mod) — a candidate
 *  for the Jumpscares tab's merge. `hasDigi` = it IS the MoonahMasterUI engine (current or legacy). */
export interface UiModVpk {
  path: string;
  fileName: string;
  hasDigi: boolean;
}

/** Scan the addons dir for base_hud-overriding paks (merge candidates). */
export function listUiMods(addonsDir: string): Promise<UiModVpk[]> {
  return invoke("list_ui_mods", { addonsDir });
}

/** An existing MoonahMasterUI/DigiMaster pak parsed back into an editable config: media is
 *  extracted to real files in app-data, sounds decoded to playable audio. */
export interface DigimodImport {
  rngInterval: number;
  scareChance: number;
  deathChance: number;
  scares: DigiEntryImported[];
  deaths: DigiEntryImported[];
  /** Deduped: one per engine sound event, shared by entries exactly like the pak. */
  sounds: DigiSoundImported[];
  warnings: string[];
}

export interface DigiEntryImported {
  id: string;
  name: string;
  kind: string;
  sourceMedia: string;
  show: number;
  preset: string;
  soundId?: string | null;
}

export interface DigiSoundImported {
  id: string;
  name: string;
  sourceAudio: string;
  volume: number;
}

/** Adopt an installed MoonahMasterUI (or legacy DigiMaster) pak into the Jumpscares tab. */
export function importDigimod(helperPath: string, vpk: string): Promise<DigimodImport> {
  return invoke("import_digimod", { helperPath, vpk });
}

/** UI Master: list the game's panorama layout/style files (editable set). */
export function listUiFiles(helperPath: string, pakPath: string): Promise<string[]> {
  return invoke("list_ui_files", { helperPath, pakPath });
}

/** UI Master: decompile one panorama layout/style to editable source text. */
export function readUiFile(
  helperPath: string,
  pakPath: string,
  internalPath: string,
): Promise<string> {
  return invoke("read_ui_file", { helperPath, pakPath, internalPath });
}

/** UI Master spike: compile UI edits and place them LOOSE in the game's
 *  grimoire dir (top-priority search path) — no vpk, no install. */
export function pushUiFiles(config: CompileConfig, citadelDir: string): Promise<string[]> {
  return invoke("push_ui_files", { config, citadelDir });
}

/** Undo push_ui_files (manifest-driven). Returns removed-file count. */
export function clearPushedUi(citadelDir: string): Promise<number> {
  return invoke("clear_pushed_ui", { citadelDir });
}

/** Extract a video's audio track to an mp3 (app-data cached); null when the
 *  video has no usable audio. Auto-pairs jumpscare videos with their sound. */
export function extractVideoAudio(
  mediaPath: string,
  ffmpegPath?: string,
): Promise<string | null> {
  return invoke("extract_video_audio", { mediaPath, ffmpegPath: ffmpegPath || null });
}

export interface PosterCompile {
  sheetId: string;
  materials: string[];
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  alphaCoverage: number;
  sourceImage: string;
  fit: string;
  rotation: number;
  erase: boolean;
  currentHash: string;
  lastCompiledHash?: string | null;
}

export interface VdataCompile {
  abilityKey: string;
  propKey: string;
  value: string;
}

export interface GlobalCompile {
  key: string;
  value: string;
}

export interface WorldCompile {
  file: string;
  entity: string;
  field: string;
  value: string;
}

export interface IconCompile {
  sourceImage: string;
  targetVtexc: string;
  width: number;
  height: number;
  hue: number;
}

export interface EffectCompile {
  targetRef: string;
  hue: number;
  saturation: number;
  mode: string;
  currentHash: string;
  lastCompiledHash?: string | null;
}

export interface SoundOverrideCompile {
  targetRef: string;
  sourceAudio: string;
  /** Extra tracks mixed under this one (the direct-replace path carries a
   *  slot track's layers through; Replace-tab overrides leave it empty). */
  layers?: LayerCompile[];
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
  currentHash: string;
  lastCompiledHash: string | null;
  /** Content-relative .vsnd_c of a previous identical render at another path
   *  (a slot's merge-path output from before it qualified for direct replace).
   *  When params are unchanged but the stock path was never compiled, the
   *  backend copies this instead of re-rendering, so the source audio file
   *  is not needed. */
  reuseFrom?: string;
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

/** A stale decoded-audio source path + the .vsnd ref that produced it (when known). */
export interface HealItem {
  path: string;
  importedRef?: string;
}

export interface HealedSource {
  path: string;
  healed: string;
}

/** Repair song/layer sources whose decoded audio was cleaned out of the old
 *  %TEMP% cache: relink to the durable copy or re-decode from a cached pack /
 *  the game pak. Only healed items come back; existing files are skipped. */
export function healMissingSources(
  helperPath: string,
  pakPath: string,
  items: HealItem[],
): Promise<HealedSource[]> {
  return invoke("heal_missing_sources", { helperPath, pakPath, items });
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

/** A moddable sound event found in the refreshed vanilla tree (primary
 *  `vsnd_files` only). Used to auto-discover events a new patch added. */
export interface DiscoveredEvent {
  eventsRelpath: string;
  eventName: string;
  arrayKey: string;
  stockEntry: string;
}

/** Enumerate every primary-`vsnd_files` event across `relpaths` under the
 *  refreshed `vanillaRoot` (files must already be decompiled there). */
export function listEditableEvents(
  vanillaRoot: string,
  relpaths: string[],
): Promise<DiscoveredEvent[]> {
  return invoke("list_editable_events", { vanillaRoot, relpaths });
}

/** Enumerate every `.vsndevts` file in the game pak (relpaths, `_c` stripped),
 *  so the patch sweep accounts for every sound-event file. */
export function listSoundeventFiles(
  helperPath: string,
  pakPath: string,
): Promise<string[]> {
  return invoke("list_soundevent_files", { helperPath, pakPath });
}

/** Download + unpack the prebuilt tools bundle (trimmed CSDK compiler + static
 *  ffmpeg) into app-data `tools/`; resolves to the paths to point settings at. */
export function downloadTools(
  url: string,
): Promise<{ csdkRoot: string; ffmpegPath: string }> {
  return invoke("download_tools", { url });
}

/** One event's adoptable entries when importing a mod pack (the entries whose
 *  audio ships inside the pack). */
export interface ImportEvent {
  eventsRelpath: string;
  eventName: string;
  arrayKey: string;
  refs: string[];
}

/** Scan a mod pack vpk for the author's own sound entries to adopt, per event.
 *  `excludePrefixes` drops references under those internal paths; pack files at
 *  stock game paths (vanilla copies / rename-replacements) are never adoptable. */
export function importPackEvents(
  helperPath: string,
  pakPath: string,
  packVpk: string,
  excludePrefixes: string[],
): Promise<ImportEvent[]> {
  return invoke("import_pack_events", { helperPath, pakPath, packVpk, excludePrefixes });
}

/** What's inside a mod pack, classified for the import review UI. Every list
 *  holds the pack's raw internal paths (compiled `_c` names), usable verbatim
 *  as staging exclusions. */
export interface PackContents {
  /** Pack sounds that shadow REAL stock game sounds by identical path (the
   *  "rename to the original's name" replacement trick). */
  overwrites: string[];
  /** The author's own (new-path) sound files, referenced by its sound events. */
  ownSounds: string[];
  models: string[];
  particles: string[];
  materials: string[];
  panorama: string[];
  other: string[];
}

/** Decompile a whole vpk into source form at destDir (structure preserved):
 *  sounds → audio, textures → png, other resources → text, the rest raw. */
export function decompileVpkAll(
  helperPath: string,
  vpk: string,
  destDir: string,
): Promise<string> {
  return invoke("decompile_vpk_all", { helperPath, vpk, destDir });
}

/** Extract a pack ONCE into the app-managed cache; returns the cache dir. All
 *  later compiles/previews read from it — the original .vpk isn't needed again. */
export function cachePack(helperPath: string, packVpk: string): Promise<string> {
  return invoke("cache_pack", { helperPath, packVpk });
}

/** The cache dir a vpk maps to, if it already exists (no extraction). Lets a
 *  re-review by original .vpk path find settings keyed under the cache dir. */
export function packCacheLookup(packVpk: string): Promise<string | null> {
  return invoke("pack_cache_lookup", { packVpk });
}

/** Which of a pack's files are byte-identical to the game's originals at the
 *  same path (bundled-but-unchanged vanilla copies). */
export function packUnchangedFiles(
  helperPath: string,
  pakPath: string,
  source: string,
): Promise<string[]> {
  return invoke("pack_unchanged_files", { helperPath, pakPath, source });
}

/** One (file, event, array) that references a given `.vsnd`. */
export interface RefEventHit {
  reference: string;
  eventsRelpath: string;
  eventName: string;
  arrayKey: string;
}

/** Which events in the local vanilla merge base reference each of `refs`
 *  (best-effort — scans the already-decompiled soundevents files). */
export function eventsForRefs(vanillaRoot: string, refs: string[]): Promise<RefEventHit[]> {
  return invoke("events_for_refs", { vanillaRoot, refs });
}

/** Classify a pack's contents against the live game (overwrites + counts). */
export function scanPackContents(
  helperPath: string,
  pakPath: string,
  packVpk: string,
): Promise<PackContents> {
  return invoke("scan_pack_contents", { helperPath, pakPath, packVpk });
}

/** One shop item's reference to a sound event (from abilities.vdata). */
export interface ItemSoundRef {
  itemName: string;
  eventName: string;
  label: string;
}

/** Index of every enabled shop item's sound events — lets the importer route a
 *  `mods/*` sound event to the item(s) that use it. */
export function itemSoundIndex(
  helperPath: string,
  pakPath: string,
): Promise<ItemSoundRef[]> {
  return invoke("item_sound_index", { helperPath, pakPath });
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
  /** Compiled .vtex_c the game references — IconMod target for a custom icon. */
  iconTarget?: string | null;
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

/** One editable numeric property of an ability (Custom Server config editor). */
export interface AbilityProp {
  key: string;
  label: string;
  value: string;
  number: number;
  unit: string;
}

/** A hero signature ability + its editable properties. */
export interface AbilityConfig {
  key: string;
  slot: number;
  name: string;
  iconPath: string;
  props: AbilityProp[];
}

/** A hero's signature abilities and their editable gameplay values. */
export function heroConfig(
  helperPath: string,
  pakPath: string,
  codename: string,
): Promise<AbilityConfig[]> {
  return invoke("hero_config", { helperPath, pakPath, codename });
}

/** One item's editable properties (same shape as an ability's props). */
export function itemConfig(
  helperPath: string,
  pakPath: string,
  itemName: string,
): Promise<AbilityProp[]> {
  return invoke("item_config", { helperPath, pakPath, itemName });
}

/** A curated global match value from generic_data.vdata. */
export interface GlobalStat {
  key: string;
  label: string;
  group: string;
  value: string;
  number: number;
  unit: string;
}

/** Curated match-wide values (gold, bonus health, durations). */
export function globalConfig(helperPath: string, pakPath: string): Promise<GlobalStat[]> {
  return invoke("global_config", { helperPath, pakPath });
}

/** Readiness of the install to host a custom dedicated game. */
export interface HostStatus {
  deadlockRoot: string;
  exeFound: boolean;
  gameinfoFound: boolean;
  p2pPatched: boolean;
  dedicatedPatched: boolean;
  ready: boolean;
}

export function hostStatus(deadlockRoot: string): Promise<HostStatus> {
  return invoke("host_status", { deadlockRoot });
}
/** Apply the gameinfo.gi edits that enable dedicated hosting (backed up). */
export function setupHosting(deadlockRoot: string): Promise<HostStatus> {
  return invoke("setup_hosting", { deadlockRoot });
}
export function revertHosting(deadlockRoot: string): Promise<HostStatus> {
  return invoke("revert_hosting", { deadlockRoot });
}
/** PID + the RCON password a freshly launched host was started with. */
export interface LaunchInfo {
  pid: number;
  rconPassword: string;
}
/** Launch the client as a dedicated host on `map`. Returns PID + RCON password.
 * `maxPlayers` opens extra server slots (for many bots) — experimental above 12. */
export function launchHost(
  deadlockRoot: string,
  map: string,
  maxPlayers?: number,
  autoPrep?: boolean,
): Promise<LaunchInfo> {
  return invoke("launch_host", { deadlockRoot, map, maxPlayers, autoPrep });
}
/** Launch Deadlock (normal client, via Steam) to test an installed mod in a real
 * match. `deadlockRoot` is only an exe fallback if Steam can't start. */
export function launchGame(deadlockRoot?: string): Promise<void> {
  return invoke("launch_game", { deadlockRoot });
}
/** Send one RCON command to the server launched from this app; returns output.
 * The password is held in the backend (set by launchHost), so any window can call this. */
export function rconExec(command: string): Promise<string> {
  return invoke("rcon_exec", { command });
}
/** Whether the app-launched server is reachable right now (launched AND
 *  something accepts TCP on the RCON port - not just "a password exists"). */
export function rconReady(): Promise<boolean> {
  return invoke("rcon_ready");
}

/** One-call snapshot of the app-launched server for panels/overlay. */
export interface HostInfo {
  /** A host was launched from this app session (RCON password stored). */
  launched: boolean;
  /** Something is accepting TCP on the RCON/game port right now. */
  listening: boolean;
  /** The map the server was launched on. */
  map: string | null;
  /** P2P connect id from console.log, once the server logged it. */
  connectId: string | null;
  /** Auto-prep progress: "waiting" | "done" | "failed" (null = prep off). */
  prep: string | null;
}
export function hostInfo(): Promise<HostInfo> {
  return invoke("host_info");
}

/** Enable/disable the global F8 overlay hotkey (on only while the Custom
 *  Server tab is enabled, so the overlay can't surprise anyone). */
export function setOverlayHotkey(enabled: boolean): Promise<void> {
  return invoke("set_overlay_hotkey", { enabled });
}
/** Tail the dedicated server's console.log (the in-app server console). */
export function readServerLog(deadlockRoot: string, maxBytes?: number): Promise<string> {
  return invoke("read_server_log", { deadlockRoot, maxBytes });
}
/** The server's P2P connect id ([A:1:…]) from console.log, or null until up. */
export function hostConnectId(deadlockRoot: string): Promise<string | null> {
  return invoke("host_connect_id", { deadlockRoot });
}

/** A flat-scalar world entity (minion / box / powerup) and its editable fields. */
export interface EntityConfig {
  key: string;
  name: string;
  file: string;
  fields: AbilityProp[];
}

/** World entities for a kind: "minions" | "boxes" | "powerups". */
export function worldConfig(
  helperPath: string,
  pakPath: string,
  kind: "minions" | "boxes" | "powerups",
): Promise<EntityConfig[]> {
  return invoke("world_config", { helperPath, pakPath, kind });
}

/** A full randomized override set (every positive gameplay number). */
export interface RandomConfig {
  vdata: { abilityKey: string; propKey: string; value: string }[];
  global: { key: string; value: string }[];
  world: { file: string; entity: string; field: string; value: string }[];
}

/** Options controlling what randomize touches. */
export interface RandomizerOpts {
  /** Leave jump / stamina / dash / sprint / move-speed stats alone. */
  skipMovement: boolean;
  /** Leave cast / channel / wind-up times alone. */
  skipCast: boolean;
  /** Leave world-entity model scale (minions/turrets) alone. */
  skipScale: boolean;
  /** Also randomize hero gun stats (bullet damage, clip, fire rate…). Off by default. */
  includeGuns: boolean;
  /** Don't randomize originally-negative values (keeps results ≥ 0). */
  noNegative: boolean;
  /** "Gamemode": give each shop item a random tier (1–4) and scale its stats to
   *  match (cost is tier-derived, so it re-prices too). Off by default. */
  randomizeItemTiers: boolean;
  /** Also randomize hero base stats (health, move speed, melee, stamina…). Off by default. */
  heroStats: boolean;
  /** Also randomize hero per-level scaling / "investment" (health/damage/tech-power per level). Off by default. */
  heroInvestment: boolean;
  /** Catch-all: also randomize every other uncategorized numeric value across the
   *  global + world-tree data files (minions, boxes, hero leftovers…). Off by default. */
  unsorted: boolean;
}

/** temperature: 0 = tame (±10%), 1 = insane (×0.03–30). */
export function randomizeConfig(
  helperPath: string,
  pakPath: string,
  temperature = 0.5,
  opts?: Partial<RandomizerOpts>,
): Promise<RandomConfig> {
  return invoke("randomize_config", {
    helperPath,
    pakPath,
    temperature,
    skipMovement: opts?.skipMovement ?? false,
    skipCast: opts?.skipCast ?? false,
    skipScale: opts?.skipScale ?? true,
    includeGuns: opts?.includeGuns ?? false,
    noNegative: opts?.noNegative ?? true,
    randomizeItemTiers: opts?.randomizeItemTiers ?? false,
    heroStats: opts?.heroStats ?? false,
    heroInvestment: opts?.heroInvestment ?? false,
    unsorted: opts?.unsorted ?? false,
  });
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

// ---- Effects (particle VFX) ----

export interface ParticleFolder {
  name: string;
  prefix: string;
  count: number;
}
export interface ParticleFile {
  /** The `.vpcf` reference (override target), e.g. `particles/abilities/x.vpcf`. */
  reference: string;
  label: string;
}
export interface ParticleBrowse {
  folders: ParticleFolder[];
  files: ParticleFile[];
  truncated: boolean;
  total: number;
}

/** Browse the game's particle tree (lazy folders, or recursive search). */
export function browseParticles(
  helperPath: string,
  pakPath: string,
  prefix: string,
  query?: string,
  refresh = false,
): Promise<ParticleBrowse> {
  return invoke("browse_particles", { helperPath, pakPath, prefix, query, refresh });
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface EffectPreview {
  particlePath: string;
  /** Absolute paths to decoded sprite PNGs the particle uses. */
  sprites: string[];
  /** Distinct colors found (for the base tint / dominant color). */
  colors: RgbaColor[];
}

/** Decompile a particle + decode its sprites for an approximate recolor preview. */
export function effectPreview(
  helperPath: string,
  pakPath: string,
  particlePath: string,
  refresh = false,
): Promise<EffectPreview> {
  return invoke("effect_preview", { helperPath, pakPath, particlePath, refresh });
}

export interface PackIcon {
  /** The pack-internal .vtex_c path (the override target). */
  targetVtexc: string;
  /** Decoded PNG in the app-data cache (usable as an IconMod source). */
  pngPath: string;
  width: number;
  height: number;
}

/** Decode every panorama image (item icons etc.) a mod pack ships, so an
 *  import can adopt them as editable Icon Mods. */
export function packIcons(helperPath: string, source: string): Promise<PackIcon[]> {
  return invoke("pack_icons", { helperPath, source });
}

/** Which of `names` (exe names) are currently running (lock-risk warning). */
export function runningProcesses(names: string[]): Promise<string[]> {
  return invoke("running_processes", { names });
}

/** Cheap file identity (`len|mtime`), "" if unreadable - game-update detection. */
export function fileStamp(path: string): Promise<string> {
  return invoke("file_stamp", { path });
}

export interface AppUpdate {
  current: string;
  latest: string;
  url: string;
  /** Direct installer download when the release ships one (one-click path). */
  setupAsset?: string | null;
}

/** Newer GitHub release, or null when up to date / offline. */
export function checkAppUpdate(): Promise<AppUpdate | null> {
  return invoke("check_app_update");
}

/** One-click update: downloads the installer, launches it, exits the app. */
export function installAppUpdate(setupUrl: string): Promise<void> {
  return invoke("install_app_update", { setupUrl });
}

export interface GbCredit {
  name: string;
  /** Their contribution; may be empty. */
  role: string;
  /** GameBanana profile or external URL; may be empty. */
  url: string;
}

/** A GameBanana mod page's attribution info (Mod Combiner credits). */
export interface GbModInfo {
  modId: number;
  pageUrl: string;
  name: string;
  author: string;
  authorUrl: string;
  credits: GbCredit[];
  /** The local vpk's MD5 matched one of the page's release files. Best
   *  effort: downloads are often zips, so false proves nothing. */
  md5Verified: boolean;
}

/** Fetch a GameBanana mod page's name/author/credits for attribution.
 *  `vpkPath`, when given, is hashed against the page's release files. */
export function gamebananaModInfo(pageUrl: string, vpkPath?: string): Promise<GbModInfo> {
  return invoke("gamebanana_mod_info", { pageUrl, vpkPath: vpkPath ?? null });
}

export interface GbSearchItem {
  modId: number;
  /** Submission type ("Mod" | "Sound") - pass back to files/download calls. */
  model: string;
  name: string;
  author: string;
  category: string;
  pageUrl: string;
  /** 220px preview on GameBanana's CDN; "" when the mod has none. */
  thumbUrl: string;
  likes: number;
  views: number;
  /** Page carries content ratings (mature) - hidden unless opted in. */
  nsfw: boolean;
  /** Sound submissions: preview MP3 on GameBanana's CDN ("" = none). */
  audioUrl: string;
}

export interface GbSearchPage {
  items: GbSearchItem[];
  /** False while more pages exist (drives "Load more"). */
  isComplete: boolean;
}

/** Browse Deadlock mods on GameBanana: the submission feed when `query` is
 *  empty, the site search scoped to Deadlock otherwise. `sort` reorders the
 *  browse feed ("downloads" | "likes" | "new"); searches are relevance-ranked.
 *  `model` picks the submission type: "Mod" (default) or "Sound". */
export function gamebananaSearch(
  query: string,
  page: number,
  sort?: string,
  model?: string,
): Promise<GbSearchPage> {
  return invoke("gamebanana_search", {
    query,
    page,
    sort: sort ?? null,
    model: model ?? null,
  });
}

export interface GbFile {
  name: string;
  size: number;
  downloadUrl: string;
  downloadCount: number;
  description: string;
}

/** The downloadable files on a mod page (a page can ship several variants). */
export function gamebananaFiles(modId: number, model?: string): Promise<GbFile[]> {
  return invoke("gamebanana_files", { modId, model: model ?? null });
}

export interface GbDownloadResult {
  /** Mountable `_dir.vpk`s found inside the download. */
  vpks: string[];
  /** Loose audio files inside the download - Sound submissions often ship a
   *  bare mp3/wav (or a zip of them) instead of a pak. */
  audios: string[];
  /** Page attribution; md5Verified is true on a clean download. */
  info: GbModInfo;
}

/** Download through GameBanana's own URL (counts on the author's stats),
 *  unpack, and return the vpk(s) and/or audio files inside. */
export function gamebananaDownload(
  modId: number,
  downloadUrl: string,
  fileName: string,
  model?: string,
): Promise<GbDownloadResult> {
  return invoke("gamebanana_download", {
    modId,
    downloadUrl,
    fileName,
    model: model ?? null,
  });
}

/** Copy an audio file into the app-data sound library; returns the copy. */
export function libraryAdd(sourcePath: string): Promise<{ path: string; name: string }> {
  return invoke("library_add", { sourcePath });
}

/** Delete a sound's library copy (refuses paths outside the library dir). */
export function libraryRemove(path: string): Promise<void> {
  return invoke("library_remove", { path });
}

export interface ExtractedAudio {
  path: string;
  /** The vpk-internal ref it came from (sounds/x.vsnd_c). */
  sourceRef: string;
}

/** Decode a mod vpk's sounds to playable audio files (capped at 64). */
export function vpkExtractAudio(helperPath: string, vpk: string): Promise<ExtractedAudio[]> {
  return invoke("vpk_extract_audio", { helperPath, vpk });
}

export interface EasyCompileReq {
  contentRoot: string;
  compiledRoot: string;
  gameInfoDir: string;
  resourceCompiler: string;
  ffmpegPath?: string;
  files: string[];
  outDir: string;
}

export interface EasyCompiled {
  input: string;
  /** Where the compiled file landed in the output folder (null on failure). */
  output: string | null;
  error: string | null;
}

/** Easy Compile (experimental): auto-detect each file and compile it to its
 *  `_c` form into `outDir` (images ride the panorama_image_list vtex trick). */
export function easyCompile(req: EasyCompileReq): Promise<EasyCompiled[]> {
  return invoke("easy_compile", { req });
}

export interface HeroImage {
  /** card | card_critical | card_gloat | vertical | sm | mm | background | logo */
  kind: string;
  /** Compiled path the game references (IconMod override target). */
  target: string;
  /** Decoded preview in the app-data cache (PNG; SVG for the logo). */
  preview: string;
  width: number;
  height: number;
  /** SVG assets (the name logo) are display-only for now. */
  svg: boolean;
}

/** Decode a hero's replaceable panorama images (cards, icons, minimap,
 *  background, logo) into the app-data cache. */
export function heroImages(
  helperPath: string,
  pakPath: string,
  codename: string,
  displayStem: string,
): Promise<HeroImage[]> {
  return invoke("hero_images", { helperPath, pakPath, codename, displayStem });
}

export interface PosterSheet {
  /** Absolute path of the decoded sheet color texture (PNG). */
  colorPng: string;
  width: number;
  height: number;
}

/** Decompile a poster atlas material (cached) and return its color PNG for display. */
export function posterSheet(
  helperPath: string,
  pakPath: string,
  material: string,
  refresh = false,
): Promise<PosterSheet> {
  return invoke("poster_sheet", { helperPath, pakPath, material, refresh });
}

/** Open a particle in an external viewer (VRF's Source2Viewer). */
export function openInViewer(
  viewerPath: string,
  helperPath: string,
  pakPath: string,
  particlePath: string,
): Promise<void> {
  return invoke("open_in_viewer", { viewerPath, helperPath, pakPath, particlePath });
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

/** Which of `refs` do NOT exist as real sound files in the pak (placeholder /
 *  legacy refs whose preview would play a wrong or beep sound). */
export function checkSoundRefs(
  helperPath: string,
  pakPath: string,
  refs: string[],
): Promise<string[]> {
  return invoke("check_sound_refs", { helperPath, pakPath, refs });
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

/** The particle effects belonging to an item (by name convention). */
export function itemParticles(
  helperPath: string,
  pakPath: string,
  itemName: string,
): Promise<string[]> {
  return invoke("item_particles", { helperPath, pakPath, itemName });
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
