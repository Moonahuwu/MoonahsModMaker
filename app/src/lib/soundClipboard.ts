import { useSyncExternalStore } from "react";

/**
 * App-wide "sound clipboard": copy a configured track once, paste it into any
 * other slot — file + trims + gain + fades + loop all come along, no re-drag.
 * Plain module store (session-lived) so any component can copy/paste without
 * prop-threading through the whole tree.
 */
export interface CopiedSound {
  label: string;
  sourceMp3: string;
  trimStart: number;
  trimEnd: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  looping: boolean;
}

let current: CopiedSound | null = null;
const subs = new Set<() => void>();

export function copySound(c: CopiedSound) {
  current = c;
  subs.forEach((f) => f());
}

/** Clear the clipboard (hides every paste chip). */
export function clearCopiedSound() {
  current = null;
  subs.forEach((f) => f());
}

export function getCopiedSound(): CopiedSound | null {
  return current;
}

/** Reactive read — re-renders when something is copied. */
export function useCopiedSound(): CopiedSound | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}
