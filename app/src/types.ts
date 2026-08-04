// TypeScript mirror of the Rust types crossing the Tauri boundary.
// Backend serializes with camelCase (serde rename_all = "camelCase").

export interface AudioInfo {
  duration: number;
}

export interface EventView {
  eventName: string;
  arrayKey: string;
  entries: string[]; // full ".vsnd" reference strings, in array order
  vsndDuration: number | null;
  /** Event-level modifiers the game applies to every file the event plays
   *  (ours included). Only simple numeric forms; randomized ones are null. */
  volume: number | null;
  pitch: number | null;
}

export interface DerivedPaths {
  referenceString: string; // soundFolder/soundName.vsnd
  compiledOutputPath: string; // gameContentRoot/soundFolder/soundName.vsnd_c
  vpkInternalPath: string; // soundFolder/soundName.vsnd_c
}

export type OutputMode = "folder" | "vpk";
export type DurationMode = "auto" | "manual";

/** One sound in the app-wide library: a file copied into app-data so it
 *  survives the original moving. Reused across slots via the sound clipboard. */
export interface LibraryItem {
  id: string;
  /** Display name (defaults to the file stem; editable). */
  name: string;
  /** The library copy's absolute path (inside app-data `library/`). */
  path: string;
  /** Where it came from, for the row's subtitle ("dropped in", a mod name…). */
  source: string;
  /** ISO date the sound was added. */
  addedAt: string;
}

/** One extra track mixed under a song at render time, timeline-style: its
 *  own clip window within the source, placed `offset` seconds into the bite,
 *  at its own volume - cut to the bite's length. The sound event and its
 *  pool are untouched - layers are baked into the one rendered audio file. */
export interface SongLayer {
  id: string;
  sourceAudio: string;
  gainDb: number;
  /** Seconds into the bite where this layer starts playing (default 0). */
  offset?: number;
  /** Clip window within the source; end <= start means "to the file's end". */
  trimStart?: number;
  trimEnd?: number;
}

export interface Song {
  id: string;
  label: string;
  sourceMp3: string;
  soundName: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
  /** Extra tracks mixed into this one (absent/empty = plain single track). */
  layers?: SongLayer[];
  order: number;
  lastCompiledHash: string | null;
  /** When converted from a mod pack (absorb / edit-adopted): the original
   *  `.vsnd` reference, so re-importing the same pack won't double the track. */
  importedRef?: string | null;
}

export interface EventProject {
  id: string;
  group: string;
  side: string; // display label for the slot
  eventName: string;
  arrayKey: string;
  stockEntry: string;
  /** Direct-replace slot: the event has no vsnd refs to merge (soundstack
   *  driven), so the track compiles AT stockEntry's path instead (loose-file
   *  override). Merge machinery skips these. */
  directOnly?: boolean;
  vsndDurationMode: DurationMode;
  vsndDurationManual: number | null;
  songs: Song[];
  previousOwnedNames: string[];
  excludedEntries: string[];
  removedEntries: string[];
  adopted: AdoptedEntry[];
  eventsRelpath: string;
  /** Scalar sound-event attributes the user overrides (volume, pitch,
   *  volumeOffsetTeam-style keys, custom). Spliced into the event on compile;
   *  absent/empty = leave the event untouched. */
  attributeOverrides?: AttributeOverride[];
}

/** One overridden scalar attribute on a slot's sound event. */
export interface AttributeOverride {
  key: string;
  value: number | boolean | string;
}

export interface AdoptedEntry {
  reference: string;
  sourceVpk: string;
  label: string;
}

export interface EventsFile {
  sourceVsndevtsPath: string | null;
  fromPakPath: string | null;
  internalEventsPath: string | null;
}

export interface Tools {
  ffmpegPath: string;
  resourceCompilerPath: string | null;
  vpkHelperPath: string | null;
}

export interface Output {
  mode: OutputMode;
  vpkName: string;
  outputDir: string;
}

export interface IconMod {
  id: string;
  name: string;
  /** Compiled vtex_c path the game references (override target in the VPK). */
  targetVtexc: string;
  /** Absolute path to the user's source PNG/JPG. */
  sourceImage: string;
  width: number;
  height: number;
  /** Hue rotation in degrees (-180..180) applied on compile. 0 = unchanged. */
  hue?: number;
  /** Unchecked = kept in the project but excluded from the compile (default on). */
  enabled?: boolean;
}

/** A loose-file sound override: user audio compiled + staged at a vanilla path. */
export interface SoundOverride {
  id: string;
  /** The `.vsnd` reference to shadow, e.g. `sounds/vo/atlas/x.vsnd`. */
  targetRef: string;
  label: string;
  sourceAudio: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
  lastCompiledHash?: string | null;
}

/** A VFX recolor override: a game particle re-tinted and staged at its path. */
export interface EffectOverride {
  id: string;
  /** The `.vpcf` reference to shadow, e.g. `particles/abilities/x.vpcf`. */
  targetRef: string;
  label: string;
  /** Hue rotation in degrees (-180..180). Phase/base hue for animated modes. */
  hue: number;
  /** Saturation multiplier (1 = unchanged). */
  saturation: number;
  /** Color mode: static recolor, or animated over particle lifetime. */
  mode: "static" | "rainbow" | "pulse";
  /** What samples the gradient for animated modes: particle lifetime ("age",
   *  default), animated noise, particle index, position along a rope, or a
   *  looping wall-clock cycle. */
  driver?: "age" | "noise" | "index" | "rope" | "time" | null;
  /** Custom gradient stops (pos 0..1 + rgb). Null = the built-in rainbow
   *  wheel (rainbow mode) or bright/dim pulse (pulse mode). */
  gradientStops?: { pos: number; color: [number, number, number] }[] | null;
  /** Loop period in seconds for the "time" driver (default 3). */
  cycleSecs?: number | null;
  lastCompiledHash?: string | null;
}

/** One gameplay-config edit: a changed ability/item property in abilities.vdata. */
export interface VdataOverride {
  abilityKey: string;
  propKey: string;
  value: string;
}

/** One global match-wide edit: a changed field in generic_data.vdata. */
export interface GlobalOverride {
  key: string;
  value: string;
}

/** One world-entity edit (minion/box/powerup): a field in npc_units/misc.vdata. */
export interface WorldOverride {
  file: string;
  entity: string;
  field: string;
  value: string;
}

export interface Project {
  version: number;
  gameContentRoot: string;
  soundFolder: string;
  eventsFile: EventsFile;
  tools: Tools;
  output: Output;
  events: EventProject[];
  iconMods?: IconMod[];
  soundOverrides?: SoundOverride[];
  effectOverrides?: EffectOverride[];
  vdataOverrides?: VdataOverride[];
  globalOverrides?: GlobalOverride[];
  worldOverrides?: WorldOverride[];
  posterOverrides?: PosterOverride[];
  heroTextures?: HeroTextureOverride[];
  digimod?: DigimodConfig | null;
  uiOverrides?: UiFileOverride[];
  /** Texture swaps inside bundled mod vpks (combined builds only). */
  modTextureOverrides?: ModTextureOverride[];
  /** Custom hero models (pre-built artifacts, Model Replacement tab). */
  modelOverrides?: ModelOverride[];
  /** Pack Builder: named modules the pack's content is organized into, so a
   *  big shared pack can later split into standalone releases. Items are
   *  stable content keys (`slot:<id>`, `icon:<id>`, `sound:<id>`,
   *  `effect:<id>`, `poster:<id>`, `herotex:<id>`, `ui:<targetRel>`,
   *  `mod:<vpk basename>`, or the units `digimod` / `gameplay`) - machine
   *  independent on purpose so modules survive Shared Pack sync. Content not
   *  claimed by any module belongs to the implicit Core module. */
  modules?: PackModule[];
}

/** One Pack Builder module (see `Project.modules`). */
export interface PackModule {
  id: string;
  name: string;
  items: string[];
}

/** One custom hero model: the ARTIFACT is already compiled (via CS2 Workshop
 *  Tools in the Model Replacement tab); the app's compile just ships it at
 *  the hero's vanilla model path. */
export interface ModelOverride {
  id: string;
  /** Hero codename (e.g. `haze`). */
  hero: string;
  label: string;
  /** Vanilla compiled path, e.g. `models/heroes_staging/haze/haze.vmdl_c`. */
  targetPath: string;
  /** Absolute path of the cached compiled artifact (.vmdl_c). */
  artifact: string;
  /** The user's mesh file the build used (for rebuilds). */
  meshFile: string;
  /** Game material applied to the whole model, or null = Blender names. */
  materialOverride?: string | null;
  /** Compiled custom-material files shipped with the model (targetRel = VPK
   *  path, artifact = cached file). Present when built in My Textures mode. */
  materials?: { targetRel: string; artifact: string }[];
  /** The texture sets / game-vmat mappings the build used (for rebuilds),
   *  keyed by FBX material. */
  materialSpecs?: {
    name: string;
    color: string | null;
    normal: string | null;
    roughness: string | null;
    metalness: string | null;
    gameVmat?: string | null;
  }[];
  /** Camera values the build spliced over the hero's stock ones. */
  cameraOverrides?: { key: string; value: number }[];
  enabled?: boolean;
}

/** One texture swap inside a bundled mod vpk: user art (or a hue-rotated copy
 *  of the mod's own texture) recompiled as a fresh .vtex_c at the mod's exact
 *  internal path, overriding the mod's copy in the combined build. Texture
 *  level on purpose - no material recompile, so custom shaders in other
 *  people's mods can't break the build. */
export interface ModTextureOverride {
  id: string;
  /** The bundled vpk this texture lives in (an importedMods entry). */
  modVpk: string;
  /** Compiled path inside the vpk, e.g. `models/x/materials/x_color_1234.vtex_c`. */
  internalPath: string;
  label: string;
  /** Absolute path to the user's art; null = mod's art (hue-only recolor). */
  sourceImage?: string | null;
  /** Hue rotation in degrees (-180..180, 0 = none). */
  hue: number;
  lastCompiledHash?: string | null;
}

/** UI Master: one edited panorama layout/style, staged over the game's own
 *  file on compile (whole-file override). Experimental. */
export interface UiFileOverride {
  /** Compiled path in the pak, e.g. `panorama/styles/hud_paused.vcss_c`. */
  targetRel: string;
  /** Edited source text (XML for layouts, CSS for styles). */
  text: string;
  /** The vanilla source at first edit (for revert + local diffing). */
  vanillaText?: string;
}

/** One jumpscare/death media entry (MoonahMasterUI HUD mod). */
export interface DigiEntry {
  id: string;
  name: string;
  kind: "video" | "image";
  /** Source file: any video format (converted to VP9 webm) or a PNG. */
  sourceMedia: string;
  /** Seconds on screen. */
  show: number;
  preset: "fullscreen" | "banner";
  /** Sound-library id played alongside (see DigimodConfig.sounds). */
  soundId?: string | null;
  /** @deprecated pre-library shape — migrated into `sounds` on load. */
  sourceAudio?: string | null;
  /** @deprecated pre-library shape — migrated into `sounds` on load. */
  volume?: number;
}

/** One shared sound: compiles to a `Moonah.<id>` event any entry can play. */
export interface DigiSound {
  id: string;
  name: string;
  /** Source audio file (any format — rendered to wav on compile). */
  sourceAudio: string;
  /** Soundevent volume (Base.UI scale; the original mod used 0.1–5). */
  volume: number;
  /** Clip start (seconds trimmed off the front). */
  trimStart?: number;
  /** Clip end in source seconds; 0 / <= start means "to the end". */
  trimEnd?: number;
  /** Render gain in dB (separate from the soundevent volume). */
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Jumpscares/Deaths tab config — generates the whole HUD mod on compile. */
export interface DigimodConfig {
  rngInterval: number;
  scareChance: number;
  deathChance: number;
  scares: DigiEntry[];
  deaths: DigiEntry[];
  /** Shared sound library (each entry picks one by id via dropdown). */
  sounds?: DigiSound[];
  /** Other base_hud-overriding UI mod vpks merged into this build (two HUD
   *  mods can't coexist as separate paks — merging ships both in one). */
  mergeVpks?: string[];
}

/** A replaced in-world poster: user art composited into a pixel rect of a
 * materials/overlays atlas sheet; the recompiled material shadows vanilla. */
export interface PosterOverride {
  /** `${sheetId}::${posterId}` */
  id: string;
  sheetId: string;
  /** Every .vmat sampling this sheet (from posterManifest.json). */
  materials: string[];
  posterId: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Opaque fraction of the vanilla trans mask inside the rect (manifest). */
  alphaCoverage: number;
  /** Absolute path to the user's source image. */
  sourceImage: string;
  fit: "cover" | "contain" | "stretch";
  /** Clockwise rotation applied to the art before fitting (some atlas posters
   *  are stored sideways). 0 | 90 | 180 | 270. */
  rotation?: number;
  /** Erase mode: no art — the region's trans mask is blanked so the decal is
   *  invisible in-game (hides vanilla tags overlapping your own art). */
  erase?: boolean;
  lastCompiledHash?: string | null;
}

/** One hero skin-texture override: the color map of one hero material swapped
 *  for user art (painted over the exported UV template) and/or hue-rotated.
 *  Compiles like a poster: recompiled material staged at the vanilla path. */
export interface HeroTextureOverride {
  /** `herotex_${codename}_${material stem}` */
  id: string;
  /** Hero codename (no `hero_` prefix). */
  hero: string;
  label: string;
  /** Vanilla material path (no `_c`). */
  vmat: string;
  /** Absolute path to the user's art; null/absent = vanilla art (hue only). */
  sourceImage?: string | null;
  /** Hue rotation in degrees (-180..180, 0 = none). */
  hue: number;
  lastCompiledHash?: string | null;
}

/// Classification of one array entry relative to a side's project state.
export type EntryKind = "stock" | "owned" | "foreign";
