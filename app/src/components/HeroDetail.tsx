import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HeroAbility, HeroAbilitySound } from "../lib/api";

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
  renderSound: (sound: HeroAbilitySound) => React.ReactNode;
}) {
  const active = abilities?.find((a) => a.ability === selectedAbility) ?? null;

  return (
    <div>
      {/* Background banner + ability bar */}
      <div
        className="relative overflow-hidden rounded-2xl border bg-zinc-900"
        style={{ borderColor: `${accent}66`, boxShadow: `0 0 24px ${accent}22` }}
      >
        {backgroundSrc && (
          <img
            src={convertFileSrc(backgroundSrc)}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover object-top opacity-30 blur-[1px]"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-zinc-950/30" />
        {/* hero-color wash (primary → secondary, like the in-game card) */}
        <div
          className="absolute inset-0 opacity-40"
          style={{ background: `linear-gradient(120deg, ${accent}55, ${accent2}22 55%, transparent 75%)` }}
        />

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
            {active.sounds.length === 0 ? (
              <p className="text-sm text-zinc-500">
                This ability has no editable sound events.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                {active.sounds.map((s) => (
                  <div key={s.eventName}>{renderSound(s)}</div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
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
