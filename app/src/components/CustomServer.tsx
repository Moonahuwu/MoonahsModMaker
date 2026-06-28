import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  globalConfig,
  heroConfig,
  itemConfig,
  itemRoster,
  type AbilityConfig,
  type AbilityProp,
  type GlobalStat,
  type HeroPortrait,
  type ItemCard,
} from "../lib/api";
import type { GlobalOverride, VdataOverride } from "../types";
import { HeroGrid } from "./HeroGrid";

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

type Section = "heroes" | "items" | "global";

export function CustomServer({
  helperPath,
  pakPath,
  showExperimental,
  includeGameplay,
  onToggleGameplay,
  overrides,
  onSet,
  onClear,
  globalOverrides,
  onSetGlobal,
  onClearGlobal,
}: {
  helperPath: string;
  pakPath: string;
  showExperimental: boolean;
  includeGameplay: boolean;
  onToggleGameplay: (on: boolean) => void;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
  globalOverrides: GlobalOverride[];
  onSetGlobal: (key: string, value: string) => void;
  onClearGlobal: (key: string) => void;
}) {
  const [section, setSection] = useState<Section>("heroes");
  const editCount = overrides.length + globalOverrides.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Dedicated server hosting */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-start gap-4">
          <span className="text-3xl">🖥️</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-zinc-100">Dedicated Server Hosting</h3>
            <p className="mt-1 text-sm text-zinc-400">
              The config you build below compiles into your mod VPK. Gameplay changes only
              take effect <b className="text-zinc-300">server-side</b>, so drop the VPK into
              your dedicated server's <code className="text-zinc-300">addons</code> folder.
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚙️</span>
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

        {/* Section nav */}
        <div className="mb-4 flex gap-1.5">
          {([
            ["heroes", "🦸 Heroes"],
            ["items", "🛒 Items & stats"],
            ["global", "🌐 Global stats"],
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
        </div>

        {section === "heroes" && (
          <HeroesSection
            helperPath={helperPath}
            pakPath={pakPath}
            showExperimental={showExperimental}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
          />
        )}
        {section === "items" && (
          <ItemsSection
            helperPath={helperPath}
            pakPath={pakPath}
            overrides={overrides}
            onSet={onSet}
            onClear={onClear}
          />
        )}
        {section === "global" && (
          <GlobalSection
            helperPath={helperPath}
            pakPath={pakPath}
            overrides={globalOverrides}
            onSet={onSetGlobal}
            onClear={onClearGlobal}
          />
        )}
      </section>
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

// --------------------------------------------------------------------------- Heroes

function HeroesSection({
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
}: {
  helperPath: string;
  pakPath: string;
  overrides: VdataOverride[];
  onSet: (abilityKey: string, propKey: string, value: string) => void;
  onClear: (abilityKey: string, propKey: string) => void;
}) {
  const [items, setItems] = useState<ItemCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [item, setItem] = useState<ItemCard | null>(null);
  const [props, setProps] = useState<AbilityProp[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    itemRoster(helperPath, pakPath).then(setItems).catch((e) => setError(String(e)));
  }, [helperPath, pakPath]);

  useEffect(() => {
    if (!item) {
      setProps(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    itemConfig(helperPath, pakPath, item.name)
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
}: {
  helperPath: string;
  pakPath: string;
  overrides: GlobalOverride[];
  onSet: (key: string, value: string) => void;
  onClear: (key: string) => void;
}) {
  const [stats, setStats] = useState<GlobalStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    globalConfig(helperPath, pakPath).then(setStats).catch((e) => setError(String(e)));
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
      <p className="mb-3 text-sm text-zinc-400">
        Match-wide values from <code className="text-zinc-300">generic_data.vdata</code> — gold
        rewards, comeback health, timers.
      </p>
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
