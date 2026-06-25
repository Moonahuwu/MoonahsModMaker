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
  fadeOut: number;
  order: number;
  lastCompiledHash: string | null;
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
  eventsRelpath: string;
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

export interface Project {
  version: number;
  gameContentRoot: string;
  soundFolder: string;
  eventsFile: EventsFile;
  tools: Tools;
  output: Output;
  events: EventProject[];
}

/// Classification of one array entry relative to a side's project state.
export type EntryKind = "stock" | "owned" | "foreign";
