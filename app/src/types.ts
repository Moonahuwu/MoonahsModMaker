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
}

export interface DerivedPaths {
  referenceString: string; // soundFolder/soundName.vsnd
  compiledOutputPath: string; // gameContentRoot/soundFolder/soundName.vsnd_c
  vpkInternalPath: string; // soundFolder/soundName.vsnd_c
}

export type OutputMode = "folder" | "vpk";
export type DurationMode = "auto" | "manual";

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
  vsndDurationMode: DurationMode;
  vsndDurationManual: number | null;
  songs: Song[];
  previousOwnedNames: string[];
  excludedEntries: string[];
  removedEntries: string[];
  adopted: AdoptedEntry[];
  eventsRelpath: string;
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
  lastCompiledHash?: string | null;
}

/// Classification of one array entry relative to a side's project state.
export type EntryKind = "stock" | "owned" | "foreign";
