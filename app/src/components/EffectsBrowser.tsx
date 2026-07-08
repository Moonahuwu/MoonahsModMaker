import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { effectPreview, type EffectPreview as EffectPreviewData, type ParticleBrowse, type RgbaColor } from "../lib/api";
import { cBrowseParticles } from "../lib/dataCache";
import type { EffectOverride } from "../types";
import { EffectPreview } from "./EffectPreview";

/**
 * Particle (VFX) recolor browser. Mirrors the sound browser: curated top
 * categories (path prefixes into `particles/`) → drill folders → particle files.
 * Selecting a particle adds a recolor override and opens an inline editor with a
 * live approximate preview (real sprites) + hue/saturation sliders.
 */
export interface ParticleCategory {
  key: string;
  label: string;
  prefix: string;
  hint?: string;
}

/** Pick the most vivid (saturated) color as the effect's representative tint. */
function dominantColor(colors: RgbaColor[]): RgbaColor | null {
  let best: RgbaColor | null = null;
  let bestScore = -1;
  for (const c of colors) {
    const mx = Math.max(c.r, c.g, c.b);
    const mn = Math.min(c.r, c.g, c.b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const score = sat * mx;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function EffectsBrowser({
  helperPath,
  pakPath,
  categories,
  overrides,
  accent,
  onAdd,
  onUpdate,
  onRemove,
  onOpenViewer,
}: {
  helperPath: string;
  pakPath: string;
  categories: ParticleCategory[];
  overrides: EffectOverride[];
  accent: string;
  onAdd: (reference: string, label: string) => void;
  onUpdate: (reference: string, patch: Partial<EffectOverride>) => void;
  onRemove: (reference: string) => void;
  onOpenViewer: (reference: string) => void;
}) {
  const [cat, setCat] = useState<ParticleCategory | null>(null);
  const [prefix, setPrefix] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<ParticleBrowse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Decoded preview data per particle ref (sprites + colors), fetched lazily.
  const [previews, setPreviews] = useState<Record<string, EffectPreviewData | "loading" | "error">>({});

  const overrideByRef = useMemo(() => new Map(overrides.map((o) => [o.targetRef, o])), [overrides]);

  useEffect(() => {
    if (cat === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      cBrowseParticles(helperPath, pakPath, prefix, query)
        .then((d) => !cancelled && setData(d))
        .catch((e) => !cancelled && setError(String(e)))
        .finally(() => !cancelled && setLoading(false));
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cat, prefix, query, helperPath, pakPath]);

  function loadPreview(reference: string) {
    if (previews[reference]) return;
    setPreviews((p) => ({ ...p, [reference]: "loading" }));
    effectPreview(helperPath, pakPath, reference)
      .then((d) => setPreviews((p) => ({ ...p, [reference]: d })))
      .catch(() => setPreviews((p) => ({ ...p, [reference]: "error" })));
  }

  function openRecolor(reference: string, label: string) {
    if (!overrideByRef.has(reference)) onAdd(reference, label);
    setOpenRow(reference);
    loadPreview(reference);
  }

  function enterCategory(c: ParticleCategory) {
    setCat(c);
    setPrefix(c.prefix);
    setQuery("");
    setData(null);
    setOpenRow(null);
  }

  const crumbs = useMemo(() => {
    if (!cat) return [];
    const rest = prefix.slice(cat.prefix.length).split("/").filter(Boolean);
    const segs: { label: string; prefix: string }[] = [];
    let acc = cat.prefix;
    for (const r of rest) {
      acc = `${acc}/${r}`;
      segs.push({ label: r, prefix: acc });
    }
    return segs;
  }, [cat, prefix]);

  // ---- Category grid -------------------------------------------------------
  if (!cat) {
    return (
      <div>
        <p className="mb-4 text-sm text-zinc-500">
          Recolor any in-game particle effect — hero abilities, item effects (Curse =
          "aoe_silence"), and more. Pick a category, find the effect, then tune its hue.
          {overrides.length > 0 && (
            <span className="ml-1 text-emerald-400">
              {overrides.length} recolor{overrides.length === 1 ? "" : "s"} queued.
            </span>
          )}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((c) => {
            const n = overrides.filter((o) => o.targetRef.startsWith(`${c.prefix}/`)).length;
            return (
              <button
                key={c.key}
                onClick={() => enterCategory(c)}
                className="group relative flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-left transition hover:border-zinc-600 hover:bg-zinc-900"
              >
                <span className="text-sm font-semibold text-zinc-100">{c.label}</span>
                {c.hint && <span className="mt-1 text-[11px] text-zinc-500">{c.hint}</span>}
                {n > 0 && (
                  <span className="absolute right-2 top-2 rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Folder / file view --------------------------------------------------
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setCat(null);
            setData(null);
            setQuery("");
          }}
          className="rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
        >
          ← Categories
        </button>
        <button
          onClick={() => {
            setPrefix(cat.prefix);
            setQuery("");
          }}
          className="text-xs font-semibold text-zinc-200 hover:text-white"
        >
          {cat.label}
        </button>
        {crumbs.map((c) => (
          <span key={c.prefix} className="flex items-center gap-2 text-xs text-zinc-500">
            <span>/</span>
            <button
              onClick={() => {
                setPrefix(c.prefix);
                setQuery("");
              }}
              className="text-zinc-300 hover:text-white"
            >
              {c.label}
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search in ${cat.label}…`}
          className="ml-auto w-60 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">{error}</div>
      )}
      {loading && !data && <p className="py-8 text-center text-sm text-zinc-500">Loading effects…</p>}

      {data && (
        <>
          {!query && data.folders.length > 0 && (
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {data.folders.map((f) => (
                <button
                  key={f.prefix}
                  onClick={() => setPrefix(f.prefix)}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900"
                >
                  <span className="truncate">▸ {f.name}</span>
                  <span className="ml-2 shrink-0 text-[10px] text-zinc-500">{f.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {data.files.map((file) => {
              const ov = overrideByRef.get(file.reference);
              const isOpen = openRow === file.reference;
              const prev = previews[file.reference];
              return (
                <div
                  key={file.reference}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/40"
                  style={ov ? { borderColor: `${accent}66` } : undefined}
                >
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <span className="text-sm">✦</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" title={file.reference}>
                      {file.label}
                    </span>
                    {ov && (
                      <span
                        className="rounded px-1.5 text-[10px] font-semibold"
                        style={{ backgroundColor: `${accent}22`, color: accent }}
                      >
                        {ov.mode === "rainbow"
                          ? "rainbow"
                          : ov.mode === "pulse"
                            ? "pulse"
                            : `${ov.hue > 0 ? "+" : ""}${Math.round(ov.hue)}°`}
                      </span>
                    )}
                    <button
                      onClick={() => (isOpen ? setOpenRow(null) : openRecolor(file.reference, file.label))}
                      style={isOpen ? { borderColor: accent, color: accent } : undefined}
                      className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                    >
                      {isOpen ? "Close" : ov ? "Edit" : "Recolor"}
                    </button>
                    {ov && (
                      <button
                        onClick={() => {
                          onRemove(file.reference);
                          if (isOpen) setOpenRow(null);
                        }}
                        title="Remove recolor"
                        className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 transition hover:border-red-600/60 hover:text-red-300"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {isOpen && ov && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="border-t border-zinc-800 p-3"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row">
                        <div className="shrink-0">
                          {prev === "loading" || prev === undefined ? (
                            <div className="flex h-[200px] w-[320px] items-center justify-center rounded-lg border border-zinc-800 bg-black text-xs text-zinc-500">
                              Decoding sprites…
                            </div>
                          ) : prev === "error" ? (
                            <div className="flex h-[200px] w-[320px] items-center justify-center rounded-lg border border-zinc-800 bg-black text-center text-xs text-zinc-500">
                              No preview (couldn't decode this effect's sprites).
                              <br />
                              Recolor still applies on compile.
                            </div>
                          ) : (
                            <EffectPreview
                              sprites={prev.sprites}
                              baseColor={dominantColor(prev.colors)}
                              hue={ov.hue}
                              saturation={ov.saturation}
                              mode={ov.mode}
                              height={200}
                            />
                          )}
                          <p className="mt-1 max-w-[320px] text-[10px] leading-tight text-zinc-600">
                            Approximate preview (real sprites, faked motion). Use the real
                            viewer for exact fidelity.
                          </p>
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col gap-3">
                          {/* Color mode */}
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <span className="w-20 shrink-0">Mode</span>
                            <div className="flex gap-1">
                              {(
                                [
                                  ["static", "Static"],
                                  ["rainbow", "Rainbow"],
                                  ["pulse", "Pulse"],
                                ] as const
                              ).map(([m, label]) => (
                                <button
                                  key={m}
                                  onClick={() => onUpdate(file.reference, { mode: m })}
                                  style={ov.mode === m ? { borderColor: accent, color: accent } : undefined}
                                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <label className="flex items-center gap-2 text-xs text-zinc-400">
                            <span className="w-20 shrink-0">
                              {ov.mode === "rainbow" ? "Phase" : ov.mode === "pulse" ? "Color" : "Hue"}
                            </span>
                            <input
                              type="range"
                              min={-180}
                              max={180}
                              step={1}
                              value={ov.hue}
                              onChange={(e) => onUpdate(file.reference, { hue: Number(e.target.value) })}
                              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
                              style={{
                                background:
                                  "linear-gradient(to right,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)",
                              }}
                            />
                            <span className="w-12 shrink-0 text-right tabular-nums text-zinc-300">
                              {ov.hue > 0 ? "+" : ""}
                              {Math.round(ov.hue)}°
                            </span>
                          </label>

                          <label className="flex items-center gap-2 text-xs text-zinc-400">
                            <span className="w-20 shrink-0">Saturation</span>
                            <input
                              type="range"
                              min={0}
                              max={2}
                              step={0.05}
                              value={ov.saturation}
                              onChange={(e) => onUpdate(file.reference, { saturation: Number(e.target.value) })}
                              className="h-1.5 flex-1 cursor-pointer"
                            />
                            <span className="w-12 shrink-0 text-right tabular-nums text-zinc-300">
                              {Math.round(ov.saturation * 100)}%
                            </span>
                          </label>

                          <div className="mt-1 flex flex-wrap gap-2">
                            <button
                              onClick={() => onUpdate(file.reference, { hue: 0, saturation: 1, mode: "static" })}
                              disabled={ov.hue === 0 && ov.saturation === 1 && ov.mode === "static"}
                              className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200 disabled:opacity-30"
                            >
                              Reset
                            </button>
                            <button
                              onClick={() => onOpenViewer(file.reference)}
                              className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                            >
                              Open in real viewer
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-600">
                            Recolor compiles into your mod and shadows the game's particle.
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              );
            })}
            {data.files.length === 0 && data.folders.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500">
                {query ? "No effects match your search." : "No effects here."}
              </p>
            )}
          </div>

          {data.truncated && (
            <p className="mt-3 text-center text-xs text-zinc-500">
              Showing the first {data.files.length}. Narrow it with search.
            </p>
          )}
        </>
      )}
    </div>
  );
}
