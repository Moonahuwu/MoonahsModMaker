import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type ItemCard, type HeroAbilitySound } from "../lib/api";
import { cItemRoster } from "../lib/dataCache";

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

/** The W3C luma-preserving hue-rotate matrix — the SAME math as the CSS
 *  `hue-rotate()` preview and the compile's ffmpeg colorchannelmixer pass, so
 *  the slider's colors show what the icon will actually become (a plain
 *  rainbow gradient doesn't: rotation is relative to the original color and
 *  drifts on saturated colors). */
function hueRotateColor(hex: string, deg: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${cl(r * m[0] + g * m[1] + b * m[2])}, ${cl(r * m[3] + g * m[4] + b * m[5])}, ${cl(
    r * m[6] + g * m[7] + b * m[8],
  )})`;
}

/** Gradient stops for the hue slider: `base` rotated from -180° to +180°. */
function hueSliderStops(base: string): string {
  const stops: string[] = [];
  for (let deg = -180; deg <= 180; deg += 30) {
    stops.push(hueRotateColor(base, deg));
  }
  return stops.join(", ");
}

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
  iconEnabled,
  onToggleIconEnabled,
  customIcons,
  onHueChange,
  onPickIcon,
  onRemoveIcon,
  experimentalEffects,
  effects,
  onOpenEffectViewer,
  onRecolorEffect,
  modifiedFilter,
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
  /** Whether the selected item's custom icon is included in the compile. */
  iconEnabled: boolean;
  onToggleIconEnabled: () => void;
  /** Item-name → custom icon, for grid overlays (only enabled ones render). */
  customIcons: Record<string, { src: string; hue: number; enabled: boolean }>;
  onHueChange: (hue: number) => void;
  onPickIcon: () => void;
  onRemoveIcon: () => void;
  /** Experimental: gate the per-item particle-effect section (VFX recolor is WIP). */
  experimentalEffects: boolean;
  /** This item's particle effects (null = loading). */
  effects: string[] | null;
  /** Open one of the item's particles in the external viewer. */
  onOpenEffectViewer: (reference: string) => void;
  /** Jump to the Effects tab to recolor. */
  onRecolorEffect: () => void;
  /** "Modified only" filter: when set, show only items this returns true for. */
  modifiedFilter?: ((name: string) => boolean) | null;
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
      setItems(await cItemRoster(helperPath, pakPath, refresh));
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
              className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border-2"
              style={{ borderColor: cat?.color ?? "#52525b", background: "rgba(0,0,0,0.4)" }}
            >
              {/* Base icon stays visible; the custom one layers over it when enabled. */}
              <img
                src={convertFileSrc(selected.iconPath ?? "")}
                alt=""
                className="h-12 w-12 object-contain"
                style={customIconSource && iconEnabled ? { opacity: 0.25 } : undefined}
              />
              {customIconSource && iconEnabled && (
                <img
                  src={convertFileSrc(customIconSource)}
                  alt=""
                  className="absolute inset-2 h-12 w-12 object-contain"
                  // Live preview of the hue shift (matches the ffmpeg pass on compile).
                  style={{ filter: `hue-rotate(${customHue}deg)` }}
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 text-sm font-semibold text-zinc-200">
                Custom icon {customIconSource && <span className="text-emerald-400">· set</span>}
                {customIconSource && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-zinc-400">
                    <input
                      type="checkbox"
                      checked={iconEnabled}
                      onChange={onToggleIconEnabled}
                      className="accent-emerald-500"
                    />
                    include in compile
                  </label>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                Drag a PNG/JPG anywhere here, or click Choose - it’s auto-scaled to the
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
              <label className="shrink-0 text-xs font-medium text-zinc-400" title="0° (center) = original colors; the bar shows what this item's color actually becomes">
                Hue shift
              </label>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={customHue}
                onChange={(e) => onHueChange(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
                style={{
                  // Center notch (0° = unchanged) over a gradient of the item's
                  // own color hue-rotated with the SAME matrix the compile and
                  // the preview use — the bar matches what you'll actually get.
                  background: `linear-gradient(to right, transparent calc(50% - 1px), rgba(255,255,255,0.9) calc(50% - 1px), rgba(255,255,255,0.9) calc(50% + 1px), transparent calc(50% + 1px)), linear-gradient(to right, ${hueSliderStops(
                    cat?.color ?? "#f59e0b",
                  )})`,
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

        {/* Item effect (particles) — open in the real viewer or recolor.
            Experimental (VFX recolor is WIP), gated behind the settings toggle. */}
        {experimentalEffects && effects && effects.length > 0 && (
          <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-200">✦ Effect</span>
              <span className="text-xs text-zinc-500">{effects.length} particle{effects.length === 1 ? "" : "s"}</span>
              <button
                onClick={onRecolorEffect}
                className="ml-auto rounded-md border border-violet-500/50 px-2.5 py-1 text-xs text-violet-300 transition hover:bg-violet-500/10"
              >
                Recolor in Effects tab →
              </button>
            </div>
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {effects.map((ref) => (
                <div
                  key={ref}
                  className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={ref}>
                    {ref.replace("particles/", "").replace(".vpcf", "")}
                  </span>
                  <button
                    onClick={() => onOpenEffectViewer(ref)}
                    title="Open this particle in Source2Viewer"
                    className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                  >
                    Open in viewer
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

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
    // Skeleton shimmer in the shop's three-column shape while icons decode.
    return (
      <div>
        <p className="mb-3 text-center text-xs text-zinc-600">Loading the shop from the game…</p>
        <div className="grid grid-cols-3 gap-4">
          {CATS.map((c) => (
            <div key={c.key} className="flex flex-col gap-2">
              <div
                className="h-6 animate-pulse rounded"
                style={{ backgroundColor: `${c.color}33` }}
              />
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 16 }, (_, i) => (
                  <div
                    key={i}
                    className="aspect-square animate-pulse rounded-lg border border-zinc-800/60 bg-zinc-900"
                    style={{ animationDelay: `${(i % 4) * 0.12}s` }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const shownItems = modifiedFilter ? items.filter((i) => modifiedFilter(i.name)) : items;
  if (modifiedFilter && shownItems.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-zinc-500">
        No items with changes yet - turn off “Modified only” to browse the shop.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-xs text-zinc-500">
          {shownItems.length} item{shownItems.length === 1 ? "" : "s"}
        </span>
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
          const inCat = shownItems.filter((i) => i.category === cat.key);
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
                          {customIcons[it.name]?.enabled && (
                            <>
                              <img
                                src={convertFileSrc(customIcons[it.name].src)}
                                alt=""
                                loading="lazy"
                                className="absolute inset-0 z-10 h-full w-full object-contain p-1.5"
                                style={{ filter: `hue-rotate(${customIcons[it.name].hue}deg)` }}
                              />
                              <span className="absolute right-1 top-1 z-20 h-2 w-2 rounded-full bg-emerald-400" />
                            </>
                          )}
                          {it.iconPath ? (
                            <img
                              src={convertFileSrc(it.iconPath)}
                              alt={it.displayName}
                              loading="lazy"
                              className="h-full w-full object-contain p-1.5"
                              style={
                                customIcons[it.name]?.enabled ? { opacity: 0.2 } : undefined
                              }
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
