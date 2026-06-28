import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { itemRoster, type ItemCard, type HeroAbilitySound } from "../lib/api";

/**
 * Items tab — a Deadlock-style shop. Items are grouped into three category
 * columns (Weapon / Vitality / Spirit), each split by tier, with the in-game
 * soul costs as tier headers. Clicking an item drills into its sound events,
 * which are editable exactly like the Heroes tab (slots rendered by the parent).
 */

const CATS = [
  { key: "weapon", label: "Weapon", color: "#d9813f", glow: "rgba(217,129,63,0.35)" },
  { key: "vitality", label: "Vitality", color: "#6cae4f", glow: "rgba(108,174,79,0.35)" },
  { key: "spirit", label: "Spirit", color: "#9a77e6", glow: "rgba(154,119,230,0.35)" },
] as const;

// In-game soul cost per tier (T5 best-effort).
const TIER_SOULS: Record<number, number> = { 1: 500, 2: 1250, 3: 3000, 4: 6200, 5: 9700 };

export function ItemsTab({
  helperPath,
  pakPath,
  selected,
  onSelect,
  onBack,
  sounds,
  loading,
  renderSound,
  customIconSource,
  customHue,
  onHueChange,
  onPickIcon,
  onRemoveIcon,
}: {
  helperPath: string;
  pakPath: string;
  selected: ItemCard | null;
  onSelect: (item: ItemCard) => void;
  onBack: () => void;
  sounds: HeroAbilitySound[] | null;
  loading: boolean;
  renderSound: (s: HeroAbilitySound) => React.ReactNode;
  customIconSource: string | null;
  customHue: number;
  onHueChange: (hue: number) => void;
  onPickIcon: () => void;
  onRemoveIcon: () => void;
}) {
  const [items, setItems] = useState<ItemCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(refresh = false) {
    if (!helperPath || !pakPath) {
      setError("Set the VPK helper and game pak in Setup to load items.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setItems(await itemRoster(helperPath, pakPath, refresh));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helperPath, pakPath]);

  // ---- Item drill-in (sounds) ----
  if (selected) {
    const cat = CATS.find((c) => c.key === selected.category);
    return (
      <div>
        <div
          className="relative overflow-hidden rounded-2xl border border-zinc-800 p-5"
          style={{ background: `linear-gradient(135deg, ${cat?.glow ?? "rgba(0,0,0,0)"}, rgba(9,9,11,0.9))` }}
        >
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              ← All items
            </button>
            {selected.iconPath && (
              <span
                className="flex h-14 w-14 items-center justify-center rounded-lg border-2"
                style={{ borderColor: cat?.color ?? "#52525b", background: "rgba(0,0,0,0.4)" }}
              >
                <img src={convertFileSrc(selected.iconPath)} alt="" className="h-10 w-10 object-contain" />
              </span>
            )}
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-white">{selected.displayName}</h2>
              <span className="text-xs font-medium uppercase tracking-wide" style={{ color: cat?.color }}>
                {cat?.label ?? selected.category} · Tier {selected.tier || "?"}
              </span>
            </div>
          </div>
        </div>

        {/* Custom icon override */}
        <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-center gap-4">
            <span
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border-2"
              style={{ borderColor: cat?.color ?? "#52525b", background: "rgba(0,0,0,0.4)" }}
            >
              <img
                src={convertFileSrc(customIconSource ?? selected.iconPath ?? "")}
                alt=""
                className="h-12 w-12 object-contain"
                // Live preview of the hue shift (matches the ffmpeg pass on compile).
                style={customIconSource ? { filter: `hue-rotate(${customHue}deg)` } : undefined}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-zinc-200">
                Custom icon {customIconSource && <span className="text-emerald-400">· set</span>}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                Drag a PNG/JPG anywhere here, or click Choose — it’s auto-scaled to the
                icon size and compiled into your mod.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={onPickIcon}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500"
              >
                Choose image…
              </button>
              {customIconSource && (
                <button
                  onClick={onRemoveIcon}
                  className="rounded-md px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/10"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Hue adjustment — only meaningful once a custom image is set. */}
          {customIconSource && (
            <div className="mt-4 flex items-center gap-3 border-t border-zinc-800 pt-3">
              <label className="shrink-0 text-xs font-medium text-zinc-400">Hue</label>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={customHue}
                onChange={(e) => onHueChange(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
                style={{
                  background:
                    "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
                }}
              />
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-300">
                {customHue > 0 ? "+" : ""}
                {customHue}°
              </span>
              <button
                onClick={() => onHueChange(0)}
                disabled={customHue === 0}
                className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-30"
              >
                Reset
              </button>
            </div>
          )}
        </div>

        <div className="mt-5">
          {loading && !sounds ? (
            <p className="py-6 text-sm text-zinc-400">Loading item sounds…</p>
          ) : !sounds || sounds.length === 0 ? (
            <p className="py-6 text-sm text-zinc-500">This item has no editable sound events.</p>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {sounds.map((s) => (
                <div key={s.eventName}>{renderSound(s)}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Shop grid ----
  if (error) {
    return (
      <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-300">
        {error}
        <button onClick={() => void load(false)} className="ml-2 underline hover:text-red-200">
          retry
        </button>
      </div>
    );
  }
  if (busy || !items) {
    return <div className="p-10 text-center text-sm text-zinc-500">Loading the shop from the game…</div>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-xs text-zinc-500">{items.length} items</span>
        <button
          onClick={() => void load(true)}
          disabled={busy}
          title="Re-decode items + icons from the current game files"
          className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-50"
        >
          ⟳ Re-pull from game
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {CATS.map((cat) => {
          const inCat = items.filter((i) => i.category === cat.key);
          const tiers = Array.from(new Set(inCat.map((i) => i.tier))).sort((a, b) => a - b);
          return (
            <section
              key={cat.key}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3"
              style={{ boxShadow: `inset 0 2px 0 0 ${cat.color}` }}
            >
              <h3 className="mb-3 px-1 text-sm font-bold uppercase tracking-widest" style={{ color: cat.color }}>
                {cat.label}
              </h3>
              {tiers.map((tier) => {
                const tierItems = inCat.filter((i) => i.tier === tier);
                return (
                  <div key={tier} className="mb-4">
                    <div className="mb-1.5 flex items-center gap-2 px-1">
                      <span className="text-[11px] font-semibold text-zinc-400">Tier {tier || "?"}</span>
                      {TIER_SOULS[tier] && (
                        <span className="flex items-center gap-0.5 text-[11px] text-amber-300/80">
                          ◈ {TIER_SOULS[tier].toLocaleString()}
                        </span>
                      )}
                      <span className="ml-auto text-[10px] text-zinc-600">{tierItems.length}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-5">
                      {tierItems.map((it) => (
                        <motion.button
                          key={it.name}
                          whileHover={{ scale: 1.08, zIndex: 1 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={() => onSelect(it)}
                          title={it.displayName}
                          className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60 transition hover:border-zinc-500"
                          style={{ outlineColor: cat.color }}
                        >
                          {it.iconPath ? (
                            <img
                              src={convertFileSrc(it.iconPath)}
                              alt={it.displayName}
                              loading="lazy"
                              className="h-full w-full object-contain p-1.5"
                            />
                          ) : (
                            <span className="flex h-full items-center justify-center text-[9px] text-zinc-600">
                              {it.displayName}
                            </span>
                          )}
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1 pb-0.5 pt-3 text-[8px] font-medium text-zinc-100 opacity-0 transition group-hover:opacity-100">
                            {it.displayName}
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  </div>
                );
              })}
              {inCat.length === 0 && <p className="px-1 text-xs text-zinc-600">No items.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
