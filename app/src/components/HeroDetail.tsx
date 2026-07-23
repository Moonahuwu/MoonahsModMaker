import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { HeroAbility, HeroImage, HeroMaterialInfo, HeroSound } from "../lib/api";
import type { HeroTextureOverride } from "../types";
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
  ability1: "Ability 1 icon",
  ability2: "Ability 2 icon",
  ability3: "Ability 3 icon",
  ability4: "Ability 4 icon",
};

/** Ability-icon art is an alpha shape (often black fill) — render it the way
 *  the game does: as a mask washed with a solid color. */
function WashedIcon({ src, className, color = "#e4e4e7" }: { src: string; className?: string; color?: string }) {
  const mask = `url("${src}")`;
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        backgroundColor: color,
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

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
  materials,
  materialsLoading,
  textures,
  onPickTexture,
  onRemoveTexture,
  onTextureHue,
  onTextureHueAll,
  onShowTemplate,
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
  /** The hero's swappable skin textures (model material color maps);
   *  null = loading not started/finished yet. */
  materials: HeroMaterialInfo[] | null;
  materialsLoading: boolean;
  /** material name → your override for it. */
  textures: Record<string, HeroTextureOverride>;
  onPickTexture: (mat: HeroMaterialInfo) => void;
  onRemoveTexture: (mat: HeroMaterialInfo) => void;
  onTextureHue: (mat: HeroMaterialInfo, hue: number) => void;
  /** Master hue: apply one rotation to every material at once. */
  onTextureHueAll: (hue: number) => void;
  /** Show the vanilla color map (the UV template) in Explorer. */
  onShowTemplate: (mat: HeroMaterialInfo) => void;
}) {
  const active = abilities?.find((a) => a.ability === selectedAbility) ?? null;
  const contentOf = (name: string) => (hasContent ? hasContent(name) : false);
  // Per-material base color for the hue-slider gradients: the average color of
  // the shown art (custom art when set, else the vanilla map), normalized so
  // the strip stays readable. Falls back to the hero accent when a thumbnail
  // can't be sampled (e.g. canvas taint).
  const fallbackBase = useMemo(() => normalizeBase(hexToRgb(accent) ?? [224, 86, 79]), [accent]);
  const [hueBases, setHueBases] = useState<Record<string, [number, number, number]>>({});
  const sampledKeys = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const mat of materials ?? []) {
        const src = textures[mat.name]?.sourceImage || mat.colorPng;
        const key = `${mat.name}|${src}`;
        if (sampledKeys.current.has(key)) continue;
        sampledKeys.current.add(key);
        const avg = await avgColorOf(convertFileSrc(src));
        if (cancelled) return;
        if (avg) setHueBases((b) => ({ ...b, [mat.name]: normalizeBase(avg) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [materials, textures]);
  // The master slider mirrors the cards: a uniform hue shows as itself,
  // per-card differences show as "mix" until the master is dragged.
  const matHues = (materials ?? []).map((m) => textures[m.name]?.hue ?? 0);
  const hueUniform = matHues.length > 0 && matHues.every((h) => h === matHues[0]);
  const masterHue = hueUniform ? matHues[0] : 0;
  const masterBase = useMemo(() => {
    const list = (materials ?? [])
      .map((m) => hueBases[m.name])
      .filter(Boolean) as [number, number, number][];
    if (!list.length) return fallbackBase;
    const sum = list.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]] as [number, number, number]);
    return normalizeBase([sum[0] / list.length, sum[1] / list.length, sum[2] / list.length]);
  }, [materials, hueBases, fallbackBase]);
  // The images grid also offers the 4 ability icons (same IconMod pipeline);
  // width 0 = "use the pick handler's default size".
  const allImages: HeroImage[] = [
    ...(images ?? []),
    ...(abilities ?? [])
      .filter((a) => a.iconTarget && a.iconPath)
      .map((a) => ({
        kind: `ability${a.slot}`,
        target: a.iconTarget!,
        preview: a.iconPath!,
        width: 0,
        height: 0,
        svg: false,
      })),
  ];
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
        {/* The portrait: full banner height on the right (art keeps its own
            aspect, like before) ending in a hard slanted cutoff instead of a
            soft fade - the clip rides the image box itself so it scales with
            whatever size the art renders at. */}
        {backgroundSrc && (
          <img
            src={convertFileSrc(backgroundSrc)}
            alt=""
            aria-hidden
            className="absolute bottom-0 right-0 h-full w-auto max-w-[45%] object-contain"
            style={{
              objectPosition: "right bottom",
              clipPath: "polygon(16% 0, 100% 0, 100% 100%, 0 100%)",
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
                      <WashedIcon src={convertFileSrc(a.iconPath)} className="h-11 w-11" />
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
          logo, and the 4 ability icons. Each vtex slot works exactly like a
          custom item icon. */}
      {allImages.length > 0 && (
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
            {allImages.map((img) => {
              const custom = customImages[img.kind];
              return (
                <div
                  key={img.kind}
                  className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2"
                  style={custom ? { borderColor: "#34d39966" } : undefined}
                >
                  <div className="relative h-24 overflow-hidden rounded bg-zinc-900">
                    {img.kind.startsWith("ability") ? (
                      <WashedIcon
                        src={convertFileSrc(img.preview)}
                        className="absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)]"
                      />
                    ) : (
                      <img
                        src={convertFileSrc(img.preview)}
                        className="absolute inset-0 h-full w-full object-contain p-1"
                        style={custom?.enabled ? { opacity: 0.25 } : undefined}
                        alt=""
                      />
                    )}
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
                    {custom ? (
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

      {/* Hero skin textures: each card is one model material's color map (the
          UV-unwrapped skin). Replace it with art painted over the exported
          template, or hue-shift the vanilla art - the model itself is never
          touched, so everything stays vanilla-shaped. */}
      {(materialsLoading || (materials?.length ?? 0) > 0) && (
        <details className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-zinc-200">
            ▩ Hero textures
            <span className="ml-2 text-xs font-normal text-zinc-500">
              skin color maps: swap the art or hue shift
            </span>
            {Object.keys(textures).length > 0 && (
              <span className="ml-2 rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">
                {Object.keys(textures).length} edited
              </span>
            )}
          </summary>
          {materialsLoading && !materials ? (
            <p className="mt-3 text-sm text-zinc-500">Loading textures… (first open decodes them, give it a moment)</p>
          ) : (
            <>
              <p className="mt-2 text-[11px] text-zinc-500">
                Template opens the vanilla map in Explorer - paint over a copy (keep the
                layout, it must line up with the model's UVs), then Replace. Hue tints
                the whole map, custom art included.
              </p>
              {/* Master hue: one drag recolors every material below. */}
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                <span className="shrink-0 text-[11px] font-semibold text-zinc-300">Whole character</span>
                <HueSlider base={masterBase} value={masterHue} onChange={onTextureHueAll} className="flex-1" />
                <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-zinc-400">
                  {hueUniform ? (masterHue > 0 ? `+${masterHue}` : masterHue) : "mix"}
                </span>
                <button
                  onClick={() => onTextureHueAll(0)}
                  title="Reset every material's hue to 0 (custom art stays)"
                  className="shrink-0 rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                >
                  Reset
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(materials ?? []).map((mat) => {
                  const ov = textures[mat.name];
                  const hue = ov?.hue ?? 0;
                  const shown = ov?.sourceImage ? ov.sourceImage : mat.colorPng;
                  return (
                    <div
                      key={mat.name}
                      className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2"
                      style={ov ? { borderColor: "#34d39966" } : undefined}
                    >
                      <div className="relative h-28 overflow-hidden rounded bg-zinc-900">
                        <img
                          src={convertFileSrc(shown)}
                          className="absolute inset-0 h-full w-full object-contain p-1"
                          style={hue ? { filter: `hue-rotate(${hue}deg)` } : undefined}
                          alt=""
                        />
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-[11px] text-zinc-300" title={mat.vmat}>
                          {prettyMaterialName(mat.name, heroName)}
                          <span className="ml-1 text-[9px] text-zinc-600">
                            {mat.width}×{mat.height}
                          </span>
                        </span>
                        <span className="flex shrink-0 gap-1">
                          <button
                            onClick={() => onShowTemplate(mat)}
                            title="Show the vanilla color map in Explorer (your painting template)"
                            className="rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                          >
                            ⧉ Template
                          </button>
                          <button
                            onClick={() => onPickTexture(mat)}
                            className="rounded border border-zinc-700 px-1.5 text-[10px] text-zinc-300 hover:border-zinc-500"
                          >
                            {ov?.sourceImage ? "Swap" : "Replace…"}
                          </button>
                          {ov && (
                            <button
                              onClick={() => onRemoveTexture(mat)}
                              title="Back to vanilla"
                              className="rounded px-1 text-[10px] text-red-400/80 hover:text-red-300"
                            >
                              ✕
                            </button>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-zinc-500">Hue</span>
                        <HueSlider
                          base={hueBases[mat.name] ?? fallbackBase}
                          value={hue}
                          onChange={(v) => onTextureHue(mat, v)}
                          className="w-full"
                        />
                        <span className="w-8 shrink-0 text-right text-[9px] tabular-nums text-zinc-400">
                          {hue > 0 ? `+${hue}` : hue}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
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
              {prettyAbility(active.ability, heroName)} - sounds
            </h3>
            {activeSounds.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {modifiedOnly && active.sounds.length > 0
                  ? "No modified sounds on this ability - turn off “Modified only” to see all of them."
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

/** A hue-rotation slider whose track previews the actual resulting colors:
 *  each stop is the material's base color run through the same hue-rotate
 *  matrix the compile's ffmpeg pass applies, and the thumb fills with the
 *  currently chosen color (via the eim-hue-slider CSS var). */
function HueSlider({
  base,
  value,
  onChange,
  className,
}: {
  base: [number, number, number];
  value: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  const stops = [-180, -135, -90, -45, 0, 45, 90, 135, 180]
    .map((d) => cssRgb(hueRotateRgb(base, d)))
    .join(",");
  return (
    <input
      type="range"
      min={-180}
      max={180}
      step={5}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`eim-hue-slider h-2 cursor-pointer appearance-none rounded-full ${className ?? ""}`}
      style={
        {
          background: `linear-gradient(to right, ${stops})`,
          "--eim-hue-thumb": cssRgb(hueRotateRgb(base, value)),
        } as React.CSSProperties
      }
    />
  );
}

/** The CSS `hue-rotate(deg)` color matrix (the same linear approximation the
 *  compile's ffmpeg pass uses), applied to one RGB triple. */
function hueRotateRgb([r, g, b]: [number, number, number], deg: number): [number, number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const cl = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return [
    cl(m[0] * r + m[1] * g + m[2] * b),
    cl(m[3] * r + m[4] * g + m[5] * b),
    cl(m[6] * r + m[7] * g + m[8] * b),
  ];
}

const cssRgb = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Keep gradient strips readable: pin the sampled color's saturation and
 *  lightness into a colorful band. Very dark/gray maps would otherwise render
 *  a near-black track (hue rotation genuinely can't recolor those, but the
 *  slider should still look like a control). */
function normalizeBase([r, g, b]: [number, number, number]): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h, Math.max(s, 0.6), Math.min(Math.max(l, 0.42), 0.58));
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Average color of an image (alpha-weighted, downsampled via canvas).
 *  Returns null if the image can't be sampled (load error, canvas taint). */
async function avgColorOf(url: string): Promise<[number, number, number] | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("load"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      r += d[i] * a;
      g += d[i + 1] * a;
      b += d[i + 2] * a;
      w += a;
    }
    if (w < 1) return null;
    return [r / w, g / w, b / w];
  } catch {
    return null;
  }
}

/** "abrams_upper_body" -> "Upper Body" (drop the hero-name prefix when the
 *  material stem carries one; hazev2_head style prefixes stay as-is). */
function prettyMaterialName(name: string, heroName: string): string {
  let s = name;
  const heroKey = heroName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (s.startsWith(heroKey + "_")) s = s.slice(heroKey.length + 1);
  return s.replace(/_/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
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
