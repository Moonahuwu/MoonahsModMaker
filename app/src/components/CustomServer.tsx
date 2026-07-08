import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import {
  hostConnectId,
  hostStatus,
  launchHost,
  rconExec,
  revertHosting,
  setupHosting,
  type AbilityConfig,
  type AbilityProp,
  type EntityConfig,
  type GlobalStat,
  type HostStatus,
  type HeroPortrait,
  type ItemCard,
} from "../lib/api";
import { cGlobalConfig, cHeroConfig, cItemConfig, cItemRoster, cWorldConfig } from "../lib/dataCache";
import type { GlobalOverride, VdataOverride, WorldOverride } from "../types";
import { quickActions } from "../lib/rconActions";
import { HeroGrid } from "./HeroGrid";
import { ServerLogPanel } from "./ServerLogPanel";
import { useToast } from "./Toaster";

/**
 * Custom Server tab — dedicated-server hosting + a gameplay config editor.
 * Edits compile into `abilities.vdata` (heroes/items) and `generic_data.vdata`
 * (global stats) overrides. Gameplay edits are server-only, so they're gated
 * behind an explicit "include in build" toggle (you can't queue public with them).
 */
const HOSTING_URL = "https://deadlockmodding.pages.dev/dedicated-server-hosting";

const ITEM_CATEGORY = {
  weapon: { label: "Weapon", color: "#d9813f" },
  vitality: { label: "Vitality", color: "#6cae4f" },
  spirit: { label: "Spirit", color: "#9a77e6" },
  other: { label: "Other", color: "#71717a" },
} as const;

type Section = "heroes" | "items" | "global" | "minions" | "boxes" | "powerups";
type WorldKind = "minions" | "boxes" | "powerups";

export function CustomServer({
  helperPath,
  pakPath,
  deadlockRoot,
  showExperimental,
  includeGameplay,
  onToggleGameplay,
  excludedKeys,
  onSetExcluded,
  overrides,
  onSet,
  onClear,
  globalOverrides,
  onSetGlobal,
  onClearGlobal,
  worldOverrides,
  onSetWorld,
  onClearWorld,
  onRandomize,
  onReset,
  randomizing,
  randomizerOpts,
  onSetRandomizerOpts,
}: {
  helperPath: string;
  pakPath: string;
  deadlockRoot: string;
  showExperimental: boolean;
  includeGameplay: boolean;
  onToggleGameplay: (on: boolean) => void;
  excludedKeys: string[];
  onSetExcluded: (keys: string[], excluded: boolean) => void;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
  globalOverrides: GlobalOverride[];
  onSetGlobal: (key: string, value: string) => void;
  onClearGlobal: (key: string) => void;
  worldOverrides: WorldOverride[];
  onSetWorld: (file: string, entity: string, field: string, value: string) => void;
  onClearWorld: (file: string, entity: string, field: string) => void;
  onRandomize: (temperature: number) => void;
  onReset: () => void;
  randomizing: boolean;
  randomizerOpts: { skipMovement: boolean; skipCast: boolean; skipScale: boolean; includeGuns: boolean; noNegative: boolean; randomizeItemTiers: boolean; heroStats: boolean; heroInvestment: boolean; unsorted: boolean };
  onSetRandomizerOpts: (patch: Partial<{ skipMovement: boolean; skipCast: boolean; skipScale: boolean; includeGuns: boolean; noNegative: boolean; randomizeItemTiers: boolean; heroStats: boolean; heroInvestment: boolean; unsorted: boolean }>) => void;
}) {
  const [view, setView] = useState<"server" | "configs">("server");
  const [section, setSection] = useState<Section>("heroes");
  const [confirmReset, setConfirmReset] = useState(false);
  const [showRandomOpts, setShowRandomOpts] = useState(false);
  const [temp, setTemp] = useState(0.4);
  const editCount = overrides.length + globalOverrides.length + worldOverrides.length;

  // Flavor label + peak multiplier for the current temperature.
  const tempLabel =
    temp < 0.15 ? "Tame" : temp < 0.4 ? "Spicy" : temp < 0.65 ? "Wild" : temp < 0.85 ? "Crazy" : temp < 0.97 ? "INSANE" : "APOCALYPSE";
  const peakMult = Math.exp(0.1 + temp * 3.4 + temp ** 5 * 4.0); // matches backend k
  const peakLabel = peakMult < 10 ? peakMult.toFixed(1) : Math.round(peakMult).toLocaleString();

  return (
    <div className="flex flex-col gap-5">
      {/* Top-level split: Server (host + admin + log) vs Configs (gameplay editor) */}
      <div className="flex items-center gap-1.5">
        {([
          ["server", "▣ Server"],
          ["configs", "⚙ Configs"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
              view === key
                ? "bg-zinc-100 text-zinc-900"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
        {editCount > 0 && (
          <span className="ml-2 rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300">
            {editCount} config edit{editCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {view === "server" && (
        <>
          <HostPanel deadlockRoot={deadlockRoot} />
          <ServerLogPanel deadlockRoot={deadlockRoot} />
        </>
      )}

      {view === "configs" && (
      /* Gameplay config editor */
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl text-zinc-400">⚙</span>
            <h3 className="text-lg font-bold text-zinc-100">Gameplay Config Editor</h3>
            {editCount > 0 && (
              <span className="rounded-full bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300">
                {editCount} changed
              </span>
            )}
          </div>
          {/* Include-in-build toggle (server-only safety gate) */}
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-1.5">
            <input
              type="checkbox"
              checked={includeGameplay}
              onChange={(e) => onToggleGameplay(e.target.checked)}
              className="h-4 w-4 accent-amber-500"
            />
            <span className="text-xs font-medium text-zinc-300">Include in build</span>
            <span className="text-[10px] text-amber-400/80">(server-only)</span>
          </label>
        </div>

        {!includeGameplay && editCount > 0 && (
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Gameplay edits are saved but <b>excluded from the build</b> — enable "Include in
            build" to bake them in. Don't use them in public matchmaking.
          </p>
        )}

        {/* Section nav + randomize/reset */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {([
            ["heroes", "Heroes"],
            ["items", "Items"],
            ["global", "Global"],
            ["minions", "Minions"],
            ["boxes", "Boxes"],
            ["powerups", "Powerups"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                section === key
                  ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2.5">
            {/* Temperature slider: tame → insane */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Tame</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(temp * 100)}
                onChange={(e) => setTemp(Number(e.target.value) / 100)}
                className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-600 accent-zinc-100"
                title={`Randomness: up to ×${peakLabel}`}
              />
              <span className="text-xs font-semibold text-rose-400">Insane</span>
              <span className="w-14 text-[11px] tabular-nums text-zinc-400">
                {tempLabel}
              </span>
            </div>
            <div className="relative flex items-center">
              <button
                onClick={() => onRandomize(temp)}
                disabled={randomizing}
                title={`Roll every gameplay number — up to ×${peakLabel}`}
                className="rounded-l-lg border border-fuchsia-500/50 bg-fuchsia-500/10 px-3 py-1.5 text-sm font-medium text-fuchsia-300 transition hover:bg-fuchsia-500/20 disabled:opacity-50"
              >
                {randomizing ? "Rolling…" : "Randomize"}
              </button>
              <button
                onClick={() => setShowRandomOpts((v) => !v)}
                title="Randomizer options"
                className={`rounded-r-lg border border-l-0 border-fuchsia-500/50 px-2 py-1.5 text-sm transition ${
                  showRandomOpts ? "bg-fuchsia-500/25 text-fuchsia-200" : "bg-fuchsia-500/10 text-fuchsia-300 hover:bg-fuchsia-500/20"
                }`}
              >
                ⚙
              </button>
              {showRandomOpts && (
                <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
                  <div className="mb-2 text-xs font-semibold text-zinc-300">Randomizer — leave alone:</div>
                  {([
                    ["skipMovement", "Movement (jump, stamina, dash, speed)"],
                    ["skipCast", "Cast / channel / wind-up times"],
                    ["skipScale", "Model scale (minions, turrets)"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="mb-1.5 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={randomizerOpts[key]}
                        onChange={(e) => onSetRandomizerOpts({ [key]: e.target.checked })}
                        className="h-3.5 w-3.5 accent-fuchsia-500"
                      />
                      {label}
                    </label>
                  ))}
                  <div className="my-2 border-t border-zinc-800" />
                  <div className="mb-1 text-xs font-semibold text-zinc-300">Also randomize:</div>
                  <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.includeGuns}
                      onChange={(e) => onSetRandomizerOpts({ includeGuns: e.target.checked })}
                      className="h-3.5 w-3.5 accent-fuchsia-500"
                    />
                    Hero guns (bullet dmg, clip, fire rate…)
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.randomizeItemTiers}
                      onChange={(e) => onSetRandomizerOpts({ randomizeItemTiers: e.target.checked })}
                      className="mt-0.5 h-3.5 w-3.5 accent-fuchsia-500"
                    />
                    <span>
                      Item tiers — give every shop item a random tier &amp; scale its
                      stats to match (re-prices too)
                    </span>
                  </label>
                  <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.heroStats}
                      onChange={(e) => onSetRandomizerOpts({ heroStats: e.target.checked })}
                      className="mt-0.5 h-3.5 w-3.5 accent-fuchsia-500"
                    />
                    <span>Hero base stats (health, move speed, melee, stamina, dash…)</span>
                  </label>
                  <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.heroInvestment}
                      onChange={(e) => onSetRandomizerOpts({ heroInvestment: e.target.checked })}
                      className="mt-0.5 h-3.5 w-3.5 accent-fuchsia-500"
                    />
                    <span>Hero investment — per-level scaling (health/damage/tech-power per level)</span>
                  </label>
                  <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.unsorted}
                      onChange={(e) => onSetRandomizerOpts({ unsorted: e.target.checked })}
                      className="mt-0.5 h-3.5 w-3.5 accent-amber-500"
                    />
                    <span>
                      Everything else (unsorted) — sweep every other uncategorized
                      value across global + world data. Chaotic.
                    </span>
                  </label>
                  <div className="my-2 border-t border-zinc-800" />
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={randomizerOpts.noNegative}
                      onChange={(e) => onSetRandomizerOpts({ noNegative: e.target.checked })}
                      className="h-3.5 w-3.5 accent-emerald-500"
                    />
                    Never go negative
                  </label>
                  <p className="mt-2 text-[10px] leading-snug text-zinc-500">
                    Skipped stats keep their vanilla values when you roll.
                  </p>
                </div>
              )}
            </div>
            {confirmReset ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    onReset();
                    setConfirmReset(false);
                  }}
                  className="rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-1.5 text-sm font-medium text-red-300 transition hover:bg-red-500/25"
                >
                  Reset everything?
                </button>
                <button
                  onClick={() => setConfirmReset(false)}
                  className="rounded-lg px-2 py-1.5 text-sm text-zinc-400 hover:text-zinc-200"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmReset(true)}
                disabled={editCount === 0}
                title="Clear all gameplay edits (back to vanilla)"
                className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
              >
                ↺ Reset to default
              </button>
            )}
          </div>
        </div>

        {/* Per-category include toggles — exclude a whole category from the build */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <span className="mr-1 text-[11px] font-medium text-zinc-500">Include in build:</span>
          {([
            ["heroes", "Heroes"],
            ["items", "Items"],
            ["global", "Global"],
            ["minions", "Minions"],
            ["boxes", "Boxes"],
            ["powerups", "Powerups"],
          ] as const).map(([key, label]) => {
            const catKey = `__cat:${key}`;
            const included = !excludedKeys.includes(catKey);
            return (
              <button
                key={key}
                onClick={() => onSetExcluded([catKey], included)}
                title={included ? "Included — click to exclude this whole category" : "Excluded — click to include"}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                  included
                    ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-700 bg-zinc-800/50 text-zinc-500 line-through"
                }`}
              >
                <span>{included ? "✓" : "✕"}</span>
                {label}
              </button>
            );
          })}
        </div>

        {section === "heroes" && (
          <HeroesSection
            helperPath={helperPath}
            pakPath={pakPath}
            showExperimental={showExperimental}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
            excludedKeys={excludedKeys}
            onSetExcluded={onSetExcluded}
          />
        )}
        {section === "items" && (
          <ItemsSection
            helperPath={helperPath}
            pakPath={pakPath}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
            excludedKeys={excludedKeys}
            onSetExcluded={onSetExcluded}
          />
        )}
        {section === "global" && (
          <GlobalSection
            helperPath={helperPath}
            pakPath={pakPath}
            overrides={globalOverrides}
            onSet={onSetGlobal}
            onClear={onClearGlobal}
            excluded={excludedKeys.includes("__cat:global")}
            onSetExcluded={onSetExcluded}
          />
        )}
        {(section === "minions" || section === "boxes" || section === "powerups") && (
          <EntitySection
            key={section}
            kind={section}
            helperPath={helperPath}
            pakPath={pakPath}
            overrides={worldOverrides}
            onSet={onSetWorld}
            onClear={onClearWorld}
            excludedKeys={excludedKeys}
            onSetExcluded={onSetExcluded}
          />
        )}
      </section>
      )}
    </div>
  );
}

/** A single editable numeric value: number input + unit + edited/reset state. */
function StatRow({
  label,
  title,
  vanillaValue,
  vanillaNumber,
  unit,
  current,
  onSet,
  onClear,
}: {
  label: string;
  title?: string;
  vanillaValue: string;
  vanillaNumber: number;
  unit: string;
  current: string | undefined;
  onSet: (value: string) => void;
  onClear: () => void;
}) {
  const modified = current !== undefined;
  const shown = modified ? parseFloat(current!) || 0 : vanillaNumber;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-400" title={title ?? label}>
        {label}
        {modified && <span className="ml-1.5 text-[10px] font-semibold text-sky-400">edited</span>}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step="any"
          value={Number.isFinite(shown) ? shown : 0}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const next = `${raw}${unit}`;
            if (next === vanillaValue) onClear();
            else onSet(next);
          }}
          className={`w-20 rounded-md border bg-zinc-900 px-2 py-1 text-right text-xs tabular-nums outline-none transition ${
            modified ? "border-sky-500/60 text-sky-200" : "border-zinc-700 text-zinc-200 focus:border-zinc-500"
          }`}
        />
        {unit && <span className="w-4 text-[11px] text-zinc-500">{unit}</span>}
        {modified ? (
          <button
            onClick={onClear}
            title={`Reset to ${vanillaValue}`}
            className="rounded p-0.5 text-zinc-500 transition hover:text-zinc-200"
          >
            ↺
          </button>
        ) : (
          <span className="w-4" />
        )}
      </div>
    </div>
  );
}

/** Checkbox controlling whether an entity's edits are baked into the build.
 *  Default included; unchecking keeps edits saved but leaves it untouched. */
function IncludeToggle({
  included,
  onChange,
  label = "Included in build",
}: {
  included: boolean;
  onChange: (included: boolean) => void;
  label?: string;
}) {
  return (
    <label
      title="Uncheck to keep these edits saved but leave this untouched in the compiled build"
      className={`flex cursor-pointer select-none items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition ${
        included
          ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-300"
          : "border-amber-600/40 bg-amber-500/10 text-amber-300"
      }`}
    >
      <input
        type="checkbox"
        checked={included}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-emerald-500"
      />
      {included ? label : "Excluded"}
    </label>
  );
}

// --------------------------------------------------------------------------- Heroes

function HeroesSection({
  helperPath,
  pakPath,
  showExperimental,
  overrides,
  onSet,
  onClear,
  excludedKeys,
  onSetExcluded,
}: {
  helperPath: string;
  pakPath: string;
  showExperimental: boolean;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
  excludedKeys: string[];
  onSetExcluded: (keys: string[], excluded: boolean) => void;
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
    cHeroConfig(helperPath, pakPath, hero.codename)
      .then((a) => !cancelled && setAbilities(a))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hero, helperPath, pakPath]);

  if (!hero) {
    return (
      <>
        <p className="mb-3 text-sm text-zinc-400">
          Pick a hero to tune their ability values (cooldown, range, damage, duration…).
        </p>
        <HeroGrid
          helperPath={helperPath}
          pakPath={pakPath}
          showExperimental={showExperimental}
          selected={null}
          onSelect={setHero}
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => setHero(null)}
          className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
        >
          ← All heroes
        </button>
        {hero.portraitPath && (
          <img src={convertFileSrc(hero.portraitPath)} alt="" className="h-9 w-9 rounded-full object-cover ring-2 ring-zinc-700" />
        )}
        <h4 className="text-base font-bold text-zinc-100">{hero.displayName}</h4>
        {abilities && abilities.length > 0 && (
          <div className="ml-auto">
            <IncludeToggle
              included={!abilities.every((a) => excludedKeys.includes(a.key))}
              onChange={(inc) => onSetExcluded(abilities.map((a) => a.key), !inc)}
              label="Hero included"
            />
          </div>
        )}
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading abilities…</p>}
      {error && <p className="text-sm text-red-400">Couldn't load abilities: {error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {abilities?.map((ab) => (
          <PropCard
            key={ab.key}
            title={ab.name}
            subtitle={`Slot ${ab.slot}`}
            iconPath={ab.iconPath}
            accent={hero.color ?? "#38bdf8"}
            props={ab.props}
            overrideKey={ab.key}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
          />
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------------------- Items

function ItemsSection({
  helperPath,
  pakPath,
  overrides,
  onSet,
  onClear,
  excludedKeys,
  onSetExcluded,
}: {
  helperPath: string;
  pakPath: string;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
  excludedKeys: string[];
  onSetExcluded: (keys: string[], excluded: boolean) => void;
}) {
  const [items, setItems] = useState<ItemCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [item, setItem] = useState<ItemCard | null>(null);
  const [props, setProps] = useState<AbilityProp[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    cItemRoster(helperPath, pakPath).then(setItems).catch((e) => setError(String(e)));
  }, [helperPath, pakPath]);

  useEffect(() => {
    if (!item) {
      setProps(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    cItemConfig(helperPath, pakPath, item.name)
      .then((p) => !cancelled && setProps(p))
      .catch(() => !cancelled && setProps([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [item, helperPath, pakPath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (cat === "all" || i.category === cat) &&
        (q === "" || i.displayName.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)),
    );
  }, [items, query, cat]);

  if (item) {
    const accent = ITEM_CATEGORY[(item.category as keyof typeof ITEM_CATEGORY) ?? "other"]?.color ?? "#71717a";
    return (
      <>
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={() => setItem(null)}
            className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
          >
            ← All items
          </button>
          {item.iconPath && (
            <img src={convertFileSrc(item.iconPath)} alt="" className="h-9 w-9 rounded-lg object-contain" style={{ background: `${accent}22` }} />
          )}
          <h4 className="text-base font-bold text-zinc-100">{item.displayName}</h4>
          <div className="ml-auto">
            <IncludeToggle
              included={!excludedKeys.includes(item.name)}
              onChange={(inc) => onSetExcluded([item.name], !inc)}
              label="Item included"
            />
          </div>
        </div>
        {loading && <p className="text-sm text-zinc-500">Loading values…</p>}
        {props && props.length === 0 && !loading && (
          <p className="text-sm text-zinc-500">This item has no editable numeric values.</p>
        )}
        {props && props.length > 0 && (
          <PropCard
            title={item.displayName}
            subtitle={ITEM_CATEGORY[(item.category as keyof typeof ITEM_CATEGORY) ?? "other"]?.label}
            iconPath={item.iconPath ?? ""}
            accent={accent}
            props={props}
            overrideKey={item.name}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
          />
        )}
      </>
    );
  }

  return (
    <>
      {error && <p className="text-sm text-red-400">Couldn't load items: {error}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items…"
          className="w-48 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
        />
        {(["all", "weapon", "vitality", "spirit"] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
              cat === c ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60"
            }`}
            style={cat === c && c !== "all" ? { color: ITEM_CATEGORY[c].color } : undefined}
          >
            {c}
          </button>
        ))}
      </div>
      {!items && <p className="text-sm text-zinc-500">Loading items…</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((i) => {
          const accent = ITEM_CATEGORY[(i.category as keyof typeof ITEM_CATEGORY) ?? "other"]?.color ?? "#71717a";
          const edits = overrides.filter((o) => o.abilityKey === i.name).length;
          return (
            <button
              key={i.name}
              onClick={() => setItem(i)}
              className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-left transition hover:border-zinc-600 hover:bg-zinc-900"
            >
              {i.iconPath ? (
                <img src={convertFileSrc(i.iconPath)} alt="" className="h-8 w-8 shrink-0 rounded object-contain" style={{ background: `${accent}22` }} />
              ) : (
                <div className="h-8 w-8 shrink-0 rounded" style={{ background: `${accent}22` }} />
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{i.displayName}</span>
              {edits > 0 && <span className="shrink-0 rounded-full bg-sky-500/20 px-1.5 text-[10px] font-semibold text-sky-300">{edits}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

// --------------------------------------------------------------------------- Global

function GlobalSection({
  helperPath,
  pakPath,
  overrides,
  onSet,
  onClear,
  excluded,
  onSetExcluded,
}: {
  helperPath: string;
  pakPath: string;
  overrides: GlobalOverride[];
  onSet: (key: string, value: string) => void;
  onClear: (key: string) => void;
  excluded: boolean;
  onSetExcluded: (keys: string[], excluded: boolean) => void;
}) {
  const [stats, setStats] = useState<GlobalStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cGlobalConfig(helperPath, pakPath).then(setStats).catch((e) => setError(String(e)));
  }, [helperPath, pakPath]);

  const groups = useMemo(() => {
    const m = new Map<string, GlobalStat[]>();
    for (const s of stats ?? []) {
      if (!m.has(s.group)) m.set(s.group, []);
      m.get(s.group)!.push(s);
    }
    return [...m.entries()];
  }, [stats]);

  const currentOf = (key: string) => overrides.find((o) => o.key === key)?.value;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-400">
          Match-wide values from <code className="text-zinc-300">generic_data.vdata</code> — gold
          rewards, comeback health, timers.
        </p>
        <IncludeToggle
          included={!excluded}
          onChange={(inc) => onSetExcluded(["__cat:global"], !inc)}
          label="Global included"
        />
      </div>
      {error && <p className="text-sm text-red-400">Couldn't load global stats: {error}</p>}
      {!stats && !error && <p className="text-sm text-zinc-500">Loading global stats…</p>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {groups.map(([group, list]) => (
          <div key={group} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
            <h5 className="mb-2 text-sm font-semibold text-zinc-200">{group}</h5>
            <div className="flex flex-col divide-y divide-zinc-800/70">
              {list.map((s) => (
                <StatRow
                  key={s.key}
                  label={s.label}
                  title={s.key}
                  vanillaValue={s.value}
                  vanillaNumber={s.number}
                  unit={s.unit}
                  current={currentOf(s.key)}
                  onSet={(v) => onSet(s.key, v)}
                  onClear={() => onClear(s.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------------------- Minions/Boxes/Powerups

const WORLD_BLURB: Record<WorldKind, string> = {
  minions: "Troopers, neutrals, guardians and bosses — health, speed, damage…",
  boxes: "Breakable crates / containers — what they drop and how tough they are.",
  powerups: "Pickups (gun/spirit/movement) and gold drops — their bonus values.",
};

function EntitySection({
  kind,
  helperPath,
  pakPath,
  overrides,
  onSet,
  onClear,
  excludedKeys,
  onSetExcluded,
}: {
  kind: WorldKind;
  helperPath: string;
  pakPath: string;
  overrides: WorldOverride[];
  onSet: (file: string, entity: string, field: string, value: string) => void;
  onClear: (file: string, entity: string, field: string) => void;
  excludedKeys: string[];
  onSetExcluded: (keys: string[], excluded: boolean) => void;
}) {
  const [entities, setEntities] = useState<EntityConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<EntityConfig | null>(null);

  useEffect(() => {
    setEntities(null);
    setPicked(null);
    setError(null);
    cWorldConfig(helperPath, pakPath, kind).then(setEntities).catch((e) => setError(String(e)));
  }, [kind, helperPath, pakPath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entities ?? []).filter((e) => q === "" || e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q));
  }, [entities, query]);

  if (picked) {
    const currentOf = (field: string) =>
      overrides.find((o) => o.file === picked.file && o.entity === picked.key && o.field === field)?.value;
    return (
      <>
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={() => setPicked(null)}
            className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800"
          >
            ← Back
          </button>
          <h4 className="text-base font-bold text-zinc-100">{picked.name}</h4>
          <code className="text-[11px] text-zinc-600">{picked.key}</code>
          <div className="ml-auto">
            <IncludeToggle
              included={!excludedKeys.includes(`${picked.file}::${picked.key}`)}
              onChange={(inc) => onSetExcluded([`${picked.file}::${picked.key}`], !inc)}
            />
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="flex flex-col divide-y divide-zinc-800/70">
            {picked.fields.map((f) => (
              <StatRow
                key={f.key}
                label={f.label}
                title={f.key}
                vanillaValue={f.value}
                vanillaNumber={f.number}
                unit={f.unit}
                current={currentOf(f.key)}
                onSet={(v) => onSet(picked.file, picked.key, f.key, v)}
                onClear={() => onClear(picked.file, picked.key, f.key)}
              />
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-zinc-400">{WORLD_BLURB[kind]}</p>
      {error && <p className="text-sm text-red-400">Couldn't load: {error}</p>}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        className="mb-3 w-48 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
      />
      {!entities && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {filtered.map((e) => {
          const edits = overrides.filter((o) => o.file === e.file && o.entity === e.key).length;
          return (
            <button
              key={e.key}
              onClick={() => setPicked(e)}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5 text-left transition hover:border-zinc-600 hover:bg-zinc-900"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{e.name}</span>
              {edits > 0 ? (
                <span className="shrink-0 rounded-full bg-sky-500/20 px-1.5 text-[10px] font-semibold text-sky-300">{edits}</span>
              ) : (
                <span className="shrink-0 text-[10px] text-zinc-600">{e.fields.length}</span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

// --------------------------------------------------------------------------- shared card

/** A titled card listing editable props for one ability/item. */
function PropCard({
  title,
  subtitle,
  iconPath,
  accent,
  props,
  overrideKey,
  overrides,
  onSet,
  onClear,
}: {
  title: string;
  subtitle?: string;
  iconPath: string;
  accent: string;
  props: AbilityProp[];
  overrideKey: string;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
}) {
  const currentOf = (propKey: string) =>
    overrides.find((o) => o.abilityKey === overrideKey && o.propKey === propKey)?.value;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="mb-3 flex items-center gap-3">
        {iconPath ? (
          <img
            src={convertFileSrc(iconPath)}
            alt=""
            className="h-10 w-10 rounded-lg bg-zinc-900 object-contain p-1"
            style={{ boxShadow: `0 0 0 1px ${accent}55` }}
          />
        ) : (
          <div className="h-10 w-10 rounded-lg" style={{ background: `${accent}22` }} />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
          {subtitle && <div className="text-[11px] text-zinc-600">{subtitle}</div>}
        </div>
      </div>
      <div className="flex flex-col divide-y divide-zinc-800/70">
        {props.map((p) => (
          <StatRow
            key={p.key}
            label={p.label}
            title={p.key}
            vanillaValue={p.value}
            vanillaNumber={p.number}
            unit={p.unit}
            current={currentOf(p.key)}
            onSet={(v) => onSet(overrideKey, p.key, v)}
            onClear={() => onClear(overrideKey, p.key)}
          />
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- Host a game

function HostPanel({ deadlockRoot }: { deadlockRoot: string }) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [map, setMap] = useState("dl_midtown");
  const [maxPlayers, setMaxPlayers] = useState(12);
  const [busy, setBusy] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  // RCON admin: the password the running server was launched with (this session
  // only), plus a little command console.
  const [rconPassword, setRconPassword] = useState<string | null>(null);
  const [cmdInput, setCmdInput] = useState("");
  const [rconLog, setRconLog] = useState<{ cmd: string; out: string; err?: boolean }[]>([]);
  const [rconBusy, setRconBusy] = useState(false);
  const { push } = useToast();

  // Run one command, or a short sequence (e.g. set convars then changelevel to
  // apply them), logging each line's output.
  async function runRcon(commands: string | string[]) {
    const list = (Array.isArray(commands) ? commands : [commands]).map((c) => c.trim()).filter(Boolean);
    if (!rconPassword || list.length === 0) return;
    setRconBusy(true);
    try {
      for (const cmd of list) {
        try {
          const out = await rconExec(cmd);
          setRconLog((l) => [...l, { cmd, out: out.trim() || "(ok)" }].slice(-40));
        } catch (e) {
          setRconLog((l) => [...l, { cmd, out: String(e), err: true }].slice(-40));
        }
      }
    } finally {
      setRconBusy(false);
    }
  }

  useEffect(() => {
    if (!deadlockRoot) return;
    hostStatus(deadlockRoot).then(setStatus).catch(() => setStatus(null));
    hostConnectId(deadlockRoot).then(setConnectId).catch(() => {});
  }, [deadlockRoot]);

  // After launching, the server logs its connect id a second or two later — poll
  // the log briefly until it appears.
  function pollConnectId() {
    let tries = 0;
    const tick = () => {
      hostConnectId(deadlockRoot)
        .then((id) => {
          if (id) setConnectId(id);
          else if (tries++ < 12) setTimeout(tick, 1500);
        })
        .catch(() => {});
    };
    tick();
  }

  async function doSetup() {
    setBusy(true);
    try {
      setStatus(await setupHosting(deadlockRoot));
      push("success", "Hosting enabled — gameinfo.gi patched (backed up)");
    } catch (e) {
      push("error", `Setup failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }
  async function doRevert() {
    setBusy(true);
    try {
      setStatus(await revertHosting(deadlockRoot));
      push("info", "Hosting edits removed");
    } catch (e) {
      push("error", `Revert failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }
  async function doLaunch() {
    setBusy(true);
    try {
      const info = await launchHost(deadlockRoot, map, maxPlayers);
      push("success", `Server starting on ${map} in a new console window — it runs headless (pid ${info.pid})`);
      setConnectId(null);
      setRconPassword(info.rconPassword);
      setRconLog([]);
      pollConnectId();
    } catch (e) {
      push("error", `Launch failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const Check = ({ ok, label }: { ok: boolean; label: string }) => (
    <li className="flex items-center gap-2 text-sm">
      <span className={ok ? "text-emerald-400" : "text-zinc-600"}>{ok ? "✓" : "○"}</span>
      <span className={ok ? "text-zinc-300" : "text-zinc-500"}>{label}</span>
    </li>
  );

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start gap-4">
        <span className="text-3xl text-zinc-400">▣</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-zinc-100">Host a Custom Game</h3>
            {status?.ready && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                READY
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            Runs your installed Deadlock as a <b className="text-zinc-300">headless</b> dedicated
            host (no separate download). It launches in its own console window — that console{" "}
            <b className="text-zinc-300">is</b> the running server; there's no game window on this
            PC. To play, join from a Deadlock client's dev console (Deadlock uses Steam P2P).
          </p>

          {!deadlockRoot ? (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              Set your Deadlock game pak in Setup first so I can find the install.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1">
                <Check ok={!!status?.exeFound} label="Deadlock client found" />
                <Check ok={!!status?.p2pPatched} label="P2P listen socket enabled" />
                <Check ok={!!status?.dedicatedPatched} label="Dedicated listen convar set" />
              </ul>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {!status?.ready ? (
                  <button
                    onClick={doSetup}
                    disabled={busy}
                    className="rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-sm font-medium text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-50"
                  >
                    1 · Enable hosting (patch gameinfo)
                  </button>
                ) : (
                  <button
                    onClick={doRevert}
                    disabled={busy}
                    className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Revert hosting edits
                  </button>
                )}
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-zinc-500">Map</label>
                  <input
                    value={map}
                    onChange={(e) => setMap(e.target.value)}
                    className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-zinc-500" title="Server slots. 12 = 6v6. Higher fits more bots but is experimental — Deadlock is built for 12.">
                    Max players
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(Math.max(1, Math.min(64, Number(e.target.value) || 12)))}
                    className="w-16 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-zinc-500"
                  />
                </div>
                <button
                  onClick={doLaunch}
                  disabled={busy || !status?.exeFound}
                  className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-sm font-bold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  ▶ Host game now
                </button>
                <button
                  onClick={() => void openUrl(HOSTING_URL)}
                  className="rounded-md px-2 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
                >
                  Hosting guide ↗
                </button>
              </div>
              {connectId && (
                <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="text-xs font-semibold text-emerald-300">Server is up — share this to join:</div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="select-all rounded bg-zinc-950 px-2 py-1 text-sm text-emerald-200">
                      connect {connectId}
                    </code>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(`connect ${connectId}`);
                        push("info", "Copied connect command");
                      }}
                      className="rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-zinc-500">
                    <b className="text-zinc-400">Friends</b> paste that into Deadlock's dev console (~).{" "}
                    <b className="text-zinc-400">You</b> (same PC) should instead use{" "}
                    <code className="text-emerald-300">connect 127.0.0.1:27015</code> — the relay ID
                    loops you out and back and tends to stall. Enable the console via the{" "}
                    <code>-console</code> launch option first.
                  </p>
                </div>
              )}

              {rconPassword && (
                <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-violet-300">◈</span>
                    <h4 className="text-sm font-bold text-violet-200">Server Admin (RCON)</h4>
                    <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">
                      LIVE
                    </span>
                    <button
                      onClick={() => {
                        void Window.getByLabel("overlay").then((w) => w?.show().then(() => w.setFocus()));
                      }}
                      className="ml-auto rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-200 transition hover:bg-violet-500/20"
                    >
                      Pop out overlay (F8)
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Send commands straight to the running server — no need to alt-tab to its console.
                    Press <kbd className="rounded bg-zinc-800 px-1">F8</kbd> anytime (even in-game, if
                    Deadlock is in borderless-windowed) to toggle the floating mod menu.
                  </p>

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {quickActions(map).map((b) => (
                      <button
                        key={b.label}
                        onClick={() => void runRcon(b.cmds)}
                        disabled={rconBusy}
                        title={b.cmds.join("  ·  ")}
                        className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-50"
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-zinc-500">
                    "Bot match 6v6" sets up a solo bot match (so bots actually play) + the match
                    intro, then restarts the map. <b>Connect after</b> — the match runs its pregame
                    → intro → play once you're in. Bots stay idle until the match actually starts.
                  </p>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const c = cmdInput;
                      setCmdInput("");
                      void runRcon(c);
                    }}
                    className="mt-2.5 flex items-center gap-1.5"
                  >
                    <span className="text-violet-400">›</span>
                    <input
                      value={cmdInput}
                      onChange={(e) => setCmdInput(e.target.value)}
                      placeholder="type any console command…"
                      spellCheck={false}
                      className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-violet-500"
                    />
                    <button
                      type="submit"
                      disabled={rconBusy || !cmdInput.trim()}
                      className="rounded-md border border-violet-500/50 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 transition hover:bg-violet-500/25 disabled:opacity-50"
                    >
                      {rconBusy ? "…" : "Send"}
                    </button>
                  </form>

                  {rconLog.length > 0 && (
                    <div className="mt-2.5 max-h-48 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed">
                      {rconLog.map((entry, i) => (
                        <div key={i} className="mb-1.5">
                          <div className="text-violet-300">› {entry.cmd}</div>
                          <pre className={`whitespace-pre-wrap ${entry.err ? "text-rose-400" : "text-zinc-400"}`}>
                            {entry.out}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <p className="mt-2 text-[11px] text-zinc-600">
                Tip: build &amp; install your mod first — the server loads it from{" "}
                <code>citadel/addons</code>. The connect ID is read from the server log
                automatically (or type <code>status</code> in the server console to see it).
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
