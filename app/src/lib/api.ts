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
  fadeOut: number;
  ffmpegPath?: string;
}

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
  fadeOut: number;
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

export function loadProject(path: string): Promise<Project> {
  return invoke("load_project", { path });
}

export function saveProject(path: string, project: Project): Promise<void> {
  return invoke("save_project", { path, project });
}
