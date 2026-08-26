import { useEffect, useRef, useState } from "react";
import { listSoundEvents, listSoundeventFiles, type SoundInventoryEvent } from "./api";

/**
 * The game's sound-event inventory for the "All" lists and Find-a-sound: every
 * (event, array) pair in every non-hero, non-voiceline soundevents file. Pure
 * helpers + one hook; the tab routing (which tab an event belongs to) stays in
 * App.tsx's `routeGroupFor`.
 */

/** The three files every sweep always covers (they hold the curated slots). */
export const MAIN_SOUNDEVENT_FILES = [
  "soundevents/music.vsndevts",
  "soundevents/world.vsndevts",
  "soundevents/ui.vsndevts",
];

/** The sound-event files worth sweeping, from a full pak listing: every
 *  `.vsndevts` except hero files (the Heroes tab browses those live),
 *  voiceline files (the Voicelines panel's domain), `base/*` inheritance
 *  templates (editing them cascades into everything derived) and the dev-only
 *  from_tools/voip files. Falls back to the main three when the listing is
 *  empty. Shared by "Fix for new patch" and the inventory so both see the
 *  same world. */
export function sweepableSoundeventFiles(all: string[]): string[] {
  const swept = all.filter(
    (f) =>
      !f.startsWith("soundevents/hero/") &&
      !f.startsWith("soundevents/vo/") &&
      !f.startsWith("soundevents/base/") &&
      !f.includes("soundevents_from_tools") &&
      !f.includes("generated_vo") &&
      !f.includes("new_player_vo") &&
      !f.includes("voip"),
  );
  return Array.from(new Set([...MAIN_SOUNDEVENT_FILES, ...swept]));
}

/** `soundevents/mods/*` are shop-item sounds: the Items tab lists them per
 *  owning item, so the tab lists and the finder leave them out. */
export function isItemSoundFile(relpath: string): boolean {
  return relpath.startsWith("soundevents/mods/");
}

/** Stable key for one sound array: `relpath::eventName::arrayKey`. */
export function soundKey(relpath: string, eventName: string, arrayKey: string): string {
  return `${relpath}::${eventName}::${arrayKey}`;
}

export function slotKey(e: { eventsRelpath: string; eventName: string; arrayKey: string }): string {
  return soundKey(e.eventsRelpath, e.eventName, e.arrayKey || "vsnd_files");
}

export function parseSoundKey(
  key: string,
): { eventsRelpath: string; eventName: string; arrayKey: string } | null {
  const parts = key.split("::");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  return { eventsRelpath: parts[0], eventName: parts[1], arrayKey: parts[2] };
}

/** Human label for a discovered event: the last 2-3 dotted segments, spaced. */
export function eventLabel(eventName: string): string {
  return eventName.split(".").slice(-3).join(" ").replace(/_/g, " ");
}

/** Short name of a non-primary array: `vsnd_files_close` -> "close",
 *  `track_2.track_vsnd_files` -> "track 2", `vsnd_files` -> "". */
export function arrayLabel(arrayKey: string): string {
  if (!arrayKey || arrayKey === "vsnd_files") return "";
  const track = arrayKey.match(/^track_(\d+)\.track_vsnd_files/);
  if (track) return `track ${track[1]}`;
  if (arrayKey === "track_vsnd_files") return "track";
  return arrayKey.replace(/^vsnd_files_?/, "").replace(/_/g, " ");
}

/** Row / slot label for an inventory entry: the event label, plus the array
 *  name when it isn't the primary one ("Fireplace (close)"). */
export function soundRowLabel(eventName: string, arrayKey: string): string {
  const a = arrayLabel(arrayKey);
  const base = eventLabel(eventName);
  return a ? `${base} (${a})` : base;
}

/** `soundevents/ambience/lanes.vsndevts` -> "ambience / lanes". */
export function fileLabel(relpath: string): string {
  return relpath
    .replace(/^soundevents\//, "")
    .replace(/\.vsndevts$/, "")
    .split("/")
    .join(" / ");
}

/** Whether a stock ref is a real, previewable clip (placeholders aren't). */
export function isPreviewableRef(ref: string): boolean {
  if (!ref) return false;
  const r = ref.toLowerCase();
  return !r.endsWith("null.vsnd") && !r.includes("placeholder") && !r.includes("util/silence");
}

export interface UseSoundInventoryArgs {
  /** Off until the app is set up (paths known, first-run done) and a sound
   *  tab is open - nothing loads before it's needed. Once loaded it stays. */
  enabled: boolean;
  helperPath: string;
  pakPath: string;
  vanillaRoot: string;
  /** Files the patch sweep already tracks (saves a pak listing). */
  knownSweepFiles: string[];
  /** Bump to re-list (after "Fix for new patch" refreshed the vanilla tree). */
  refreshTick: number;
  /** Decompile the given files into the vanilla tree; resolves to the root. */
  ensureFiles: (relpaths: string[]) => Promise<string>;
}

/** Loads the inventory once per `refreshTick` (and once `enabled` flips on):
 *  lists the sweepable files, asks the backend for every sound array, and
 *  decompiles + re-lists any files the vanilla tree doesn't hold yet. */
export function useSoundInventory(args: UseSoundInventoryArgs): {
  events: SoundInventoryEvent[] | null;
  loading: boolean;
  error: string | null;
} {
  const { enabled, helperPath, pakPath, vanillaRoot, knownSweepFiles, refreshTick, ensureFiles } =
    args;
  const [events, setEvents] = useState<SoundInventoryEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which tick the current/last load was for: a re-render with the same
  // inputs must not re-run the sweep.
  const loadedTick = useRef<number | null>(null);
  const ensureRef = useRef(ensureFiles);
  ensureRef.current = ensureFiles;

  useEffect(() => {
    if (!enabled || !helperPath || !pakPath) return;
    if (loadedTick.current === refreshTick) return;
    loadedTick.current = refreshTick;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let files = knownSweepFiles.length ? knownSweepFiles : [];
        if (!files.length) {
          try {
            files = sweepableSoundeventFiles(await listSoundeventFiles(helperPath, pakPath));
          } catch {
            files = MAIN_SOUNDEVENT_FILES;
          }
        }
        let root = vanillaRoot.replace(/[/\\]+$/, "");
        let res = await listSoundEvents(root, files);
        if (res.missing.length) {
          // Decompile what the vanilla tree lacks (a tree from before the
          // full-pak sweep only holds the main files), then list again.
          root = (await ensureRef.current(res.missing)).replace(/[/\\]+$/, "");
          res = await listSoundEvents(root, files);
        }
        if (cancelled) return;
        setEvents(res.events);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // knownSweepFiles/vanillaRoot are read at load time on purpose: a
    // refresh that changes them also bumps refreshTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, helperPath, pakPath, refreshTick]);

  return { events, loading, error };
}
