import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HeroAbility, HeroImage, HeroSound } from "../lib/api";
import { HeroSoundsSection } from "./HeroSoundsSection";

const IMAGE_KIND_LABELS: Record<string, string> = {
  card: "Portrait card",
  card_critical: "Card (low health)",
  card_gloat: "Card (gloat)",
  vertical: "Vertical portrait",
  sm: "Small icon",
  mm: "Minimap icon",
  background: "Menu background",
  logo: "Name logo",
};

/**
 * Per-hero menu: a background banner (the hero's card art) with the hero name,
 * the 4 signature abilities as numbered icon buttons, and — when an ability is
 * selected — its sound events listed inline below (each an addable slot rendered
 * by the parent via `renderSound`).
 */
export function HeroDetail({
  heroName,
  backgroundSrc,
  accent,
  accent2,
  abilities,
  loading,
  selectedAbility,
  onSelectAbility,
  onShowVoicelines,
  onBack,
  renderSound,
  sounds,
  soundsLoading,
  onPreviewSound,
  onOpenSound,
  hasContent,
  modifiedOnly,
  images,
  customImages,
  onPickImage,
  onRemoveImage,
}: {
  heroName: string;
  backgroundSrc: string | null;
  accent: string;
  accent2: string;
  abilities: HeroAbility[] | null;
  loading: boolean;
  selectedAbility: string | null;
  onSelectAbility: (ability: string | null) => void;
  onShowVoicelines: () => void;
  onBack: () => void;
  renderSound: (sound: { eventName: string; label: string }) => React.ReactNode;
  /** The hero's non-VO sound events (gunfire/abilities/movement). */
  sounds: HeroSound[] | null;
  soundsLoading: boolean;
  onPreviewSound: (ref: string) => Promise<string>;
  onOpenSound: (s: HeroSound) => void;
  /** True if the event already has your custom/imported audio (row marker). */
  hasContent?: (eventName: string) => boolean;
  /** "Modified only": filter every sound list down to events with your content. */
  modifiedOnly?: boolean;
  /** The hero's replaceable panorama images (null = loading). */
  images: HeroImage[] | null;
  /** kind → your replacement (from icon mods). */
  customImages: Record<string, { src: string; enabled: boolean }>;
  onPickImage: (img: HeroImage) => void;
  onRemoveImage: (img: HeroImage) => void;
}) {
  const active = abilities?.find((a) => a.ability === selectedAbility) ?? null;
  const contentOf = (name: string) => (hasContent ? hasContent(name) : false);
  const activeSounds = active
    ? modifiedOnly
      ? active.sounds.filter((s) => contentOf(s.eventName))
      : active.sounds
    : [];

  return (
    <div>
      {/* Background banner + ability bar */}
      <div
        className="relative min-h-[190px] overflow-hidden rounded-2xl border bg-zinc-900"
        style={{ borderColor: `${accent}66`, boxShadow: `0 0 24px ${accent}22` }}
      >
        {/* Soft ambient wash of the portrait behind everything */}
        {backgroundSrc && (
          <img
            src={convertFileSrc(backgroundSrc)}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover object-top opacity-20 blur-[2px]"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-zinc-950/30" />
        {/* hero-color wash (primary → secondary, like the in-game card) */}
        <div
          className="absolute inset-0 opacity-40"
          style={{ background: `linear-gradient(120deg, ${accent}55, ${accent2}22 55%, transparent 75%)` }}
        />
        {/* The portrait, full banner height on the right with a hard slanted
            cutoff (Deadlock's angular card language) instead of a soft fade. */}
        {backgroundSrc && (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 w-[42%]"
            style={{ clipPath: "polygon(14% 0, 100% 0, 100% 100%, 0 100%)" }}
          >
            <img
              src={convertFileSrc(backgroundSrc)}
              alt=""
              className="h-full w-full object-cover object-top"
            />
            {/* Accent-tinted slant edge: a skewed strip hugging the diagonal. */}
            <div
              className="absolute inset-y-0 left-0 w-[14%]"
              style={{
                background: `linear-gradient(to right, ${accent}66, transparent)`,
                clipPath: "polygon(100% 0, 100% 4%, 4% 100%, 0 100%)",
              }}
            />
          </div>
        )}

        <div className="relative flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              ← All heroes
            </button>
            {/* The in-game name logo when we have it, else the plain name. */}
            {(() => {
              const logo = images?.find((i) => i.kind === "logo");
              return logo ? (
                <img
                  src={convertFileSrc(logo.preview)}
                  alt={heroName}
                  title={heroName}
                  className="h-9 max-w-[16rem] object-contain drop-shadow"
                  style={{ filter: "drop-shadow(0 1px 6px rgba(0,0,0,0.7))" }}
                />
              ) : (
                <h2 className="text-2xl font-bold tracking-tight text-white drop-shadow">
                  {heroName}
                </h2>
              );
            })()}
            <button
              onClick={onShowVoicelines}
              style={{ borderColor: `${accent}99` }}
              className="ml-auto rounded-md border bg-zinc-900/60 px-3 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
            >
              ❝ Voicelines
            </button>
          </div>

          {/* Ability bar (1–4) */}
          <div className="flex flex-wrap items-end gap-3">
            {loading && !abilities && (
              <span className="py-4 text-sm text-zinc-400">Loading abilities…</span>
            )}
            {abilities?.map((a) => {
              const isActive = a.ability === selectedAbility;
              return (
                <button
                  key={a.ability}
                  onClick={() => onSelectAbility(isActive ? null : a.ability)}
                  title={`${a.sounds.length} sound${a.sounds.length === 1 ? "" : "s"}`}
                  className="group flex flex-col items-center gap-1"
                >
                  <span
                    style={
                      isActive
                        ? { borderColor: accent, boxShadow: `0 0 0 2px ${accent}55` }
                        : undefined
                    }
                    className={`relative flex h-16 w-16 items-center justify-center rounded-full border-2 bg-zinc-900/80 transition ${
                      isActive ? "" : "border-zinc-600 group-hover:border-zinc-300"
                    }`}
                  >
                    {a.iconPath ? (
                      <img
                        src={convertFileSrc(a.iconPath)}
                        alt={a.ability}
                        className="h-11 w-11 object-contain"
                      />
                    ) : (
                      <span className="text-lg font-bold text-zinc-400">{a.slot}</span>
                    )}
                    <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-[10px] font-bold text-zinc-200">
                      {a.slot}
                    </span>
                  </span>
                  <span className="max-w-[5rem] truncate text-[10px] text-zinc-400">
                    {a.sounds.length} snd
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Replaceable hero images: portrait cards, icons, minimap, background,
          logo. Each vtex slot works exactly like a custom item icon. */}
      {images && images.length > 0 && (
        <details className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-200">
            ▦ Hero images
            <span className="ml-2 text-xs font-normal text-zinc-500">
              portraits, icons, minimap, menu background
            </span>
            {Object.values(customImages).length > 0 && (
              <span className="ml-2 rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                {Object.values(customImages).length} replaced
              </span>
            )}
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((img) => {
              const custom = customImages[img.kind];
              return (
                <div
                  key={img.kind}
                  className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2"
                  style={custom ? { borderColor: "#34d39966" } : undefined}
                >
                  <div className="relative h-24 overflow-hidden rounded bg-zinc-900">
                    <img
                      src={convertFileSrc(img.preview)}
                      className="absolute inset-0 h-full w-full object-contain p-1"
                      style={custom?.enabled ? { opacity: 0.25 } : undefined}
                      alt=""
                    />
                    {custom?.enabled && (
                      <img
                        src={convertFileSrc(custom.src)}
                        className="absolute inset-0 h-full w-full object-contain p-1"
                        alt=""
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[11px] text-zinc-300">
                      {IMAGE_KIND_LABELS[img.kind] ?? img.kind}
                      {img.width > 0 && (
                        <span className="ml-1 text-[9px] text-zinc-600">
                          {img.width}×{img.height}
                        </span>
                      )}
                    </span>
                    {img.svg ? (
                      <span
                        className="shrink-0 text-[9px] text-zinc-600"
                        title="The name logo is an SVG — replacement coming later"
                      >
                        svg
                      </span>
                    ) : custom ? (
                      <span className="flex shrink-0 gap-1">
                        <button
                          onClick={() => onPickImage(img)}
                          className="rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                        >
                          Swap
                        </button>
                        <button
                          onClick={() => onRemoveImage(img)}
                          className="rounded px-1 text-[10px] text-red-400/80 hover:text-red-300"
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => onPickImage(img)}
                        className="shrink-0 rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                      >
                        Replace…
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Selected ability's sounds (inline) */}
      <AnimatePresence mode="wait">
        {active && (
          <motion.div
            key={active.ability}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="mt-5"
          >
            <h3 className="mb-3 text-sm font-semibold text-zinc-300">
              {prettyAbility(active.ability, heroName)} — sounds
            </h3>
            {activeSounds.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {modifiedOnly && active.sounds.length > 0
                  ? "No modified sounds on this ability — turn off “Modified only” to see all of them."
                  : "This ability has no editable sound events."}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                {activeSounds.map((s) => (
                  <div key={s.eventName}>{renderSound(s)}</div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full hero sound set (gunfire / abilities / movement), auto-grouped.
          Events already shown on an ability card are left out. */}
      <HeroSoundsSection
        accent={accent}
        sounds={
          sounds
            ? sounds.filter(
                (s) =>
                  !(abilities ?? []).some((a) => a.sounds.some((x) => x.eventName === s.eventName)) &&
                  (!modifiedOnly || contentOf(s.eventName)),
              )
            : sounds
        }
        loading={soundsLoading}
        onPreview={onPreviewSound}
        onOpen={onOpenSound}
        renderSound={renderSound}
        hasContent={hasContent}
      />
    </div>
  );
}

/** "ability_doorman_luggage_cart" -> "Luggage Cart" (drop the hero prefix). */
function prettyAbility(ability: string, heroName: string): string {
  let s = ability.replace(/^ability_/, "");
  const heroKey = heroName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (s.startsWith(heroKey + "_")) s = s.slice(heroKey.length + 1);
  // also drop a leading single-word hero codename if present
  s = s.replace(/_/g, " ").trim();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
