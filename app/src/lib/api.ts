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
  events: EventCompile[];
  iconMods?: IconCompile[];
  soundOverrides?: SoundOverrideCompile[];
  effectOverrides?: EffectCompile[];
  vdataOverrides?: VdataCompile[];
  globalOverrides?: GlobalCompile[];
  worldOverrides?: WorldCompile[];
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
export function launchHost(deadlockRoot: string, map: string, maxPlayers?: number): Promise<LaunchInfo> {
  return invoke("launch_host", { deadlockRoot, map, maxPlayers });
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
/** Whether a host has been launched from this app (so we can drive it over RCON). */
export function rconReady(): Promise<boolean> {
  return invoke("rcon_ready");
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
