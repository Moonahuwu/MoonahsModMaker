import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HeroAbility, HeroSound } from "../lib/api";
import { HeroSoundsSection } from "./HeroSoundsSection";

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
        {/* The portrait itself, uncropped: full banner height on the right,
            fading into the banner so it never looks cut off. */}
        {backgroundSrc && (
          <img
            src={convertFileSrc(backgroundSrc)}
            alt=""
            aria-hidden
            className="absolute bottom-0 right-0 h-full w-auto max-w-[45%] object-contain object-bottom"
            style={{
              maskImage: "linear-gradient(to left, black 60%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to left, black 60%, transparent 100%)",
              filter: `drop-shadow(0 0 18px ${accent}44)`,
            }}
          />
        )}

        <div className="relative flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              ← All heroes
            </button>
            <h2 className="text-2xl font-bold tracking-tight text-white drop-shadow">
              {heroName}
            </h2>
            <button
              onClick={onShowVoicelines}
              style={{ borderColor: `${accent}99` }}
              className="ml-auto rounded-md border bg-zinc-900/60 px-3 py-1 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
            >
              🎙 Voicelines
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
