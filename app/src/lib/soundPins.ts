import baselineJson from "../data/soundBaseline.json";
import type { Settings, SoundPin } from "./settings";
import { parseSoundKey, soundRowLabel } from "./soundInventory";

/**
 * "Most used" pins. The shipped baseline (app/src/data/soundBaseline.json,
 * authored in-app by the maintainer) is everyone's starting set; personal
 * pins in settings add to it, re-home/relabel entries, or (`null`) hide one.
 */

export interface SoundBaselineEntry {
  /** `relpath::eventName::arrayKey` */
  key: string;
  group: string;
  label?: string;
}

export interface SoundBaseline {
  version: number;
  entries: SoundBaselineEntry[];
}

export const SOUND_BASELINE = baselineJson as SoundBaseline;
export const SOUND_BASELINE_KEYS: Set<string> = new Set(SOUND_BASELINE.entries.map((e) => e.key));

/** The baseline with the user's pins applied: key -> where/what it shows as. */
export function effectivePins(local: Settings["soundPins"] | undefined): Map<string, SoundPin> {
  const out = new Map<string, SoundPin>();
  for (const e of SOUND_BASELINE.entries) {
    out.set(e.key, e.label ? { group: e.group, label: e.label } : { group: e.group });
  }
  for (const [key, pin] of Object.entries(local ?? {})) {
    if (pin === null) out.delete(key);
    else out.set(key, pin);
  }
  return out;
}

/** Settings patch that toggles one pin. Pinning records the tab + label; a
 *  baseline entry unpinned becomes an explicit `null` (hidden), a local-only
 *  pin unpinned is simply dropped. */
export function togglePinPatch(
  local: Settings["soundPins"] | undefined,
  key: string,
  group: string,
  label: string,
): Pick<Settings, "soundPins"> {
  const cur = { ...(local ?? {}) };
  const pinned = effectivePins(cur).has(key);
  if (pinned) {
    if (SOUND_BASELINE_KEYS.has(key)) cur[key] = null;
    else delete cur[key];
  } else {
    cur[key] = { group, label };
  }
  return { soundPins: cur };
}

/** Re-home a pinned sound (its slot moved to another tab). No-op when not pinned. */
export function movePinPatch(
  local: Settings["soundPins"] | undefined,
  key: string,
  group: string,
): Pick<Settings, "soundPins"> | null {
  const pin = effectivePins(local).get(key);
  if (!pin) return null;
  return { soundPins: { ...(local ?? {}), [key]: { ...pin, group } } };
}

/** The shipped-baseline document for the current effective pin set: sorted by
 *  tab order then key; a label equal to the event's auto label is dropped so
 *  hand-written names are the only ones that ship. */
export function baselineDocument(pins: Map<string, SoundPin>, tabOrder: string[]): SoundBaseline {
  const rank = (g: string) => {
    const i = tabOrder.indexOf(g);
    return i < 0 ? tabOrder.length : i;
  };
  const entries: SoundBaselineEntry[] = [...pins.entries()]
    .map(([key, pin]) => {
      const parsed = parseSoundKey(key);
      const auto = parsed ? soundRowLabel(parsed.eventName, parsed.arrayKey) : "";
      const e: SoundBaselineEntry = { key, group: pin.group };
      if (pin.label && pin.label !== auto) e.label = pin.label;
      return e;
    })
    .sort((a, b) => rank(a.group) - rank(b.group) || a.key.localeCompare(b.key));
  return { version: SOUND_BASELINE.version || 1, entries };
}
