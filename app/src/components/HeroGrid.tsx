import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { heroRoster, type HeroPortrait } from "../lib/api";

/**
 * In-game-style hero selection grid. Pulls each hero's card portrait from the
 * game pak (decoded to PNG + cached by the backend) and lays them out as a grid
 * of cards. Clicking a card selects that hero (drill-in to its abilities/sounds
 * is wired by the parent).
 */
export function HeroGrid({
  helperPath,
  pakPath,
  showExperimental,
  selected,
  onSelect,
}: {
  helperPath: string;
  pakPath: string;
  showExperimental: boolean;
  selected: string | null;
  onSelect: (hero: HeroPortrait) => void;
}) {
  const [heroes, setHeroes] = useState<HeroPortrait[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(refresh = false) {
    if (!helperPath || !pakPath) {
      setError("Set the VPK helper and game pak in Setup to load hero portraits.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setHeroes(await heroRoster(helperPath, pakPath, refresh));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helperPath, pakPath]);

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

  if (loading || !heroes) {
    return (
      <div className="p-10 text-center text-sm text-zinc-500">
        Decoding hero portraits from the game… (first time only)
      </div>
    );
  }

  const shown = showExperimental ? heroes : heroes.filter((h) => !h.experimental);
  const hiddenExp = heroes.length - heroes.filter((h) => !h.experimental).length;

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-xs text-zinc-500">{shown.length} heroes</span>
        {!showExperimental && hiddenExp > 0 && (
          <span className="text-[11px] text-zinc-600">
            +{hiddenExp} experimental hidden (enable in Setup)
          </span>
        )}
        <button
          onClick={() => void load(true)}
          disabled={loading}
          title="Re-decode the portraits + hero data from the current game files"
          className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-50"
        >
          ⟳ Re-pull from game
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
        {shown.map((h) => {
          const active = selected === h.codename;
          return (
            <motion.button
              key={h.codename}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => onSelect(h)}
              title={h.displayName}
              className={`group relative aspect-[3/4] overflow-hidden rounded-lg border bg-gradient-to-b from-zinc-700/40 to-zinc-950 transition ${
                active
                  ? "border-emerald-400 ring-2 ring-emerald-400/50"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              <img
                src={convertFileSrc(h.portraitPath)}
                alt={h.displayName}
                loading="lazy"
                className={`h-full w-full object-cover object-top transition-opacity duration-200 ${
                  h.experimental ? "opacity-70 saturate-50" : ""
                } ${h.gloatPath ? "group-hover:opacity-0" : ""}`}
              />
              {h.gloatPath && (
                <img
                  src={convertFileSrc(h.gloatPath)}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  className={`absolute inset-0 h-full w-full object-cover object-top opacity-0 transition-opacity duration-200 group-hover:opacity-100 ${
                    h.experimental ? "saturate-50" : ""
                  }`}
                />
              )}
              {h.experimental && (
                <span className="pointer-events-none absolute left-1 top-1 rounded bg-amber-500/80 px-1 text-[8px] font-bold uppercase tracking-wide text-black">
                  exp
                </span>
              )}
              <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-5 text-[10px] font-medium text-zinc-100 opacity-0 transition group-hover:opacity-100">
                {h.displayName}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
