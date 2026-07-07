import {
  browseGameSounds,
  browseParticles,
  globalConfig,
  heroConfig,
  heroDetail,
  heroRoster,
  heroSounds,
  heroVoicelines,
  itemConfig,
  itemRoster,
  itemSoundIndex,
  worldConfig,
  type AbilityConfig,
  type AbilityProp,
  type EntityConfig,
  type GlobalStat,
  type HeroAbility,
  type HeroPortrait,
  type HeroSound,
  type ItemCard,
  type ItemSoundRef,
  type ParticleBrowse,
  type SoundBrowse,
  type VoiceLine,
} from "./api";

/**
 * Session-wide cache over the game-data reads (rosters, per-hero details, the
 * sound/particle browse tree, gameplay configs). Every read here is pure game
 * data — user edits live in the project, never in these results — so caching
 * is safe and makes revisiting a tab instant instead of re-invoking the
 * backend (and its vpk-helper subprocesses) on every mount.
 *
 * The cache stores the in-flight promise (not the value), so concurrent
 * callers of the same key share one backend call. Failed calls are evicted so
 * a retry actually retries. `refresh=true` bypasses AND replaces the entry.
 */
const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, fn: () => Promise<T>, refresh = false): Promise<T> {
  if (refresh || !cache.has(key)) {
    const p = fn();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
  }
  return cache.get(key) as Promise<T>;
}

/** Wipe everything (e.g. after "Fix for new patch" re-pulls the game data). */
export function clearDataCache() {
  cache.clear();
}

// ---- Cached mirrors of the api reads (same signatures) ----------------------

export function cHeroRoster(helper: string, pak: string, refresh = false): Promise<HeroPortrait[]> {
  return cached(`heroRoster|${helper}|${pak}`, () => heroRoster(helper, pak, refresh), refresh);
}

export function cItemRoster(helper: string, pak: string, refresh = false): Promise<ItemCard[]> {
  return cached(`itemRoster|${helper}|${pak}`, () => itemRoster(helper, pak, refresh), refresh);
}

export function cHeroDetail(helper: string, pak: string, codename: string, refresh = false): Promise<HeroAbility[]> {
  return cached(`heroDetail|${helper}|${pak}|${codename}`, () => heroDetail(helper, pak, codename, refresh), refresh);
}

export function cHeroSounds(helper: string, pak: string, codename: string, refresh = false): Promise<HeroSound[]> {
  return cached(`heroSounds|${helper}|${pak}|${codename}`, () => heroSounds(helper, pak, codename, refresh), refresh);
}

export function cHeroVoicelines(helper: string, pak: string, codename: string, refresh = false): Promise<VoiceLine[]> {
  return cached(`voicelines|${helper}|${pak}|${codename}`, () => heroVoicelines(helper, pak, codename, refresh), refresh);
}

export function cItemSoundIndex(helper: string, pak: string): Promise<ItemSoundRef[]> {
  return cached(`itemSoundIndex|${helper}|${pak}`, () => itemSoundIndex(helper, pak));
}

export function cBrowseGameSounds(helper: string, pak: string, prefix: string, query = ""): Promise<SoundBrowse> {
  return cached(`sounds|${helper}|${pak}|${prefix}|${query}`, () => browseGameSounds(helper, pak, prefix, query));
}

export function cBrowseParticles(helper: string, pak: string, prefix: string, query?: string): Promise<ParticleBrowse> {
  return cached(`particles|${helper}|${pak}|${prefix}|${query ?? ""}`, () => browseParticles(helper, pak, prefix, query));
}

export function cHeroConfig(helper: string, pak: string, codename: string): Promise<AbilityConfig[]> {
  return cached(`heroConfig|${helper}|${pak}|${codename}`, () => heroConfig(helper, pak, codename));
}

export function cItemConfig(helper: string, pak: string, itemName: string): Promise<AbilityProp[]> {
  return cached(`itemConfig|${helper}|${pak}|${itemName}`, () => itemConfig(helper, pak, itemName));
}

export function cGlobalConfig(helper: string, pak: string): Promise<GlobalStat[]> {
  return cached(`globalConfig|${helper}|${pak}`, () => globalConfig(helper, pak));
}

export function cWorldConfig(
  helper: string,
  pak: string,
  kind: "minions" | "boxes" | "powerups",
): Promise<EntityConfig[]> {
  return cached(`worldConfig|${helper}|${pak}|${kind}`, () => worldConfig(helper, pak, kind));
}

// ---- Startup preload ---------------------------------------------------------

export interface PreloadStep {
  key: string;
  label: string;
  status: "pending" | "loading" | "done" | "error";
}

export interface PreloadProgress {
  steps: PreloadStep[];
  /** Background warm-up (per-hero details), running after the core steps. */
  bgDone: number;
  bgTotal: number;
  coreDone: boolean;
}

/**
 * Warm the caches so every tab (and hero drill-in) opens instantly.
 *
 * Core steps (reported to the loading screen): the hero + item rosters, the
 * sound-browser index + each top category, and the item→event routing index.
 * Then a low-priority background pass prefetches every hero's ability detail
 * and sound list with limited concurrency (each is a backend call that may
 * spawn vpk-helper, so we deliberately don't fire 70 at once).
 */
export async function preloadGameData(
  helper: string,
  pak: string,
  soundPrefixes: string[],
  onProgress: (p: PreloadProgress) => void,
): Promise<void> {
  const steps: PreloadStep[] = [
    { key: "heroes", label: "Hero portraits & roster", status: "pending" },
    { key: "items", label: "Item shop & icons", status: "pending" },
    { key: "sounds", label: "Game sound index", status: "pending" },
    { key: "routing", label: "Item sound routing", status: "pending" },
  ];
  const state: PreloadProgress = { steps, bgDone: 0, bgTotal: 0, coreDone: false };
  const report = () => onProgress({ ...state, steps: steps.map((s) => ({ ...s })) });

  const setStatus = (key: string, status: PreloadStep["status"]) => {
    const s = steps.find((x) => x.key === key);
    if (s) s.status = status;
    report();
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setStatus(key, "loading");
    try {
      await fn();
      setStatus(key, "done");
    } catch {
      // Non-fatal: the owning tab shows its own error + retry on open.
      setStatus(key, "error");
    }
  };

  report();
  let roster: HeroPortrait[] = [];
  await Promise.all([
    run("heroes", async () => {
      roster = await cHeroRoster(helper, pak);
    }),
    run("items", () => cItemRoster(helper, pak)),
    run("sounds", async () => {
      // Only the curated category roots — not the full 79k "Everything" tree.
      // (The backend still builds its one-time path index on the first call,
      // but that's a single cached listing, not a per-file decode.)
      await Promise.all(soundPrefixes.map((p) => cBrowseGameSounds(helper, pak, p)));
    }),
    run("routing", () => cItemSoundIndex(helper, pak)),
  ]);
  state.coreDone = true;
  report();

  // Background warm-up: every hero's abilities + sound list, 3 at a time.
  const jobs = roster.flatMap((h) => [
    () => cHeroDetail(helper, pak, h.codename),
    () => cHeroSounds(helper, pak, h.codename),
  ]);
  state.bgTotal = jobs.length;
  report();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await job();
      } catch {
        /* per-hero warm-up is best-effort */
      }
      state.bgDone++;
      report();
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}
