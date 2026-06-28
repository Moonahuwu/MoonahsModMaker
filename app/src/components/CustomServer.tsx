import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { heroConfig, type AbilityConfig, type HeroPortrait } from "../lib/api";
import type { VdataOverride } from "../types";
import { HeroGrid } from "./HeroGrid";

/**
 * Custom Server tab — hub for dedicated-server hosting + the gameplay config
 * editor that edits `scripts/abilities.vdata` (hero ability values) and compiles
 * them into a server-ready config mod.
 */
const HOSTING_URL = "https://deadlockmodding.pages.dev/dedicated-server-hosting";

export function CustomServer({
  helperPath,
  pakPath,
  showExperimental,
  overrides,
  onSet,
  onClear,
}: {
  helperPath: string;
  pakPath: string;
  showExperimental: boolean;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
}) {
  const [hero, setHero] = useState<HeroPortrait | null>(null);
  const [abilities, setAbilities] = useState<AbilityConfig[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hero) {
      setAbilities(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    heroConfig(helperPath, pakPath, hero.codename)
      .then((a) => {
        if (!cancelled) setAbilities(a);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hero, helperPath, pakPath]);

  const editCount = overrides.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Dedicated server hosting */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl">🖥️</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-zinc-100">Dedicated Server Hosting</h3>
            <p className="mt-1 text-sm text-zinc-400">
              Run your own Deadlock dedicated server to play custom configs and gamemodes
              with friends. The config you build below compiles to a <code className="text-zinc-300">.vpk</code>{" "}
              you drop into your server's <code className="text-zinc-300">addons</code> folder — gameplay
              changes only take effect server-side.
            </p>
            <button
              onClick={() => void openUrl(HOSTING_URL)}
              className="mt-3 inline-flex items-center gap-2 rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-300 transition hover:bg-sky-500/20"
            >
              Open hosting guide ↗
            </button>
          </div>
        </div>
      </section>

      {/* Gameplay config editor */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚙️</span>
            <h3 className="text-lg font-bold text-zinc-100">Gameplay Config Editor</h3>
          </div>
          {editCount > 0 && (
            <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300">
              {editCount} value{editCount === 1 ? "" : "s"} changed
            </span>
          )}
        </div>

        {!hero ? (
          <>
            <p className="mb-3 text-sm text-zinc-400">
              Pick a hero to tune their ability values (cooldown, range, damage, duration…).
              Edited values compile into a single <code className="text-zinc-300">abilities.vdata</code> override.
            </p>
            <HeroGrid
              helperPath={helperPath}
              pakPath={pakPath}
              showExperimental={showExperimental}
              selected={null}
              onSelect={setHero}
            />
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <button
                onClick={() => setHero(null)}
                className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
              >
                ← All heroes
              </button>
              {hero.portraitPath && (
                <img
                  src={convertFileSrc(hero.portraitPath)}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover ring-2 ring-zinc-700"
                />
              )}
              <h4 className="text-base font-bold text-zinc-100">{hero.displayName}</h4>
            </div>

            {loading && <p className="text-sm text-zinc-500">Loading abilities…</p>}
            {error && <p className="text-sm text-red-400">Couldn't load abilities: {error}</p>}
            {abilities && abilities.length === 0 && !loading && (
              <p className="text-sm text-zinc-500">No editable abilities found for this hero.</p>
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {abilities?.map((ab) => (
                <AbilityCard
                  key={ab.key}
                  ability={ab}
                  accent={hero.color ?? "#38bdf8"}
                  overrides={overrides}
                  onSet={onSet}
                  onClear={onClear}
                />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AbilityCard({
  ability,
  accent,
  overrides,
  onSet,
  onClear,
}: {
  ability: AbilityConfig;
  accent: string;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
}) {
  const ovFor = (propKey: string) =>
    overrides.find((o) => o.abilityKey === ability.key && o.propKey === propKey);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="mb-3 flex items-center gap-3">
        {ability.iconPath ? (
          <img
            src={convertFileSrc(ability.iconPath)}
            alt=""
            className="h-10 w-10 rounded-lg bg-zinc-900 object-contain p-1"
            style={{ boxShadow: `0 0 0 1px ${accent}55` }}
          />
        ) : (
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-zinc-900 text-xs text-zinc-600">
            {ability.slot}
          </div>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{ability.name}</div>
          <div className="text-[11px] text-zinc-600">Slot {ability.slot}</div>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-zinc-800/70">
        {ability.props.map((p) => {
          const ov = ovFor(p.key);
          const modified = ov !== undefined;
          const shownNumber = modified ? parseFloat(ov!.value) || 0 : p.number;
          return (
            <div key={p.key} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-400" title={p.key}>
                {p.label}
                {modified && <span className="ml-1.5 text-[10px] font-semibold text-sky-400">edited</span>}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="any"
                  value={Number.isFinite(shownNumber) ? shownNumber : 0}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") return;
                    const next = `${raw}${p.unit}`;
                    // Revert to vanilla (clear override) when it matches the stock value.
                    if (next === p.value) onClear(ability.key, p.key);
                    else onSet(ability.key, p.key, next);
                  }}
                  className={`w-20 rounded-md border bg-zinc-900 px-2 py-1 text-right text-xs tabular-nums outline-none transition ${
                    modified
                      ? "border-sky-500/60 text-sky-200"
                      : "border-zinc-700 text-zinc-200 focus:border-zinc-500"
                  }`}
                />
                {p.unit && <span className="w-4 text-[11px] text-zinc-500">{p.unit}</span>}
                {modified && (
                  <button
                    onClick={() => onClear(ability.key, p.key)}
                    title={`Reset to ${p.value}`}
                    className="rounded p-0.5 text-zinc-500 transition hover:text-zinc-200"
                  >
                    ↺
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
