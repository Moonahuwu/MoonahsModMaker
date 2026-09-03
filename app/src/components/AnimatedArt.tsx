import { useEffect, useRef, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { videoThumb } from "../lib/videoThumbs";
import type { DynpaintEntry } from "../types";
import {
  DYNPAINT_TARGETS,
  type DynpaintPanelInfo,
  type DynpaintTargetInfo,
} from "../data/dynpaintTargets";

// Wall Art's Animated tab: every surface that can play a GIF/video (or hold a
// still), as aspect-true tiles grouped by host. The picked media renders
// INSIDE its tile with the chosen fit and position applied, so the crop
// controls are a live preview of what ships. Any number of surfaces per
// host: the compile rebuilds the host model with one quad + material per
// active surface (see dynpaint.rs). To keep a fully filled wall readable,
// settings live in ONE panel for the tile you click, not a row per surface.
//
// Technique + surface registry by goldenboy44 (leonyarov), used with
// permission: https://gamebanana.com/tools/23828

const MEDIA_EXTENSIONS = [
  "gif", "apng", "webm", "mp4", "mkv", "mov", "avi", "m4v",
  "png", "jpg", "jpeg", "webp", "bmp",
];
const VIDEO_RE = /\.(webm|mp4|mkv|mov|avi|m4v)$/i;

const DWELLS: [string, string][] = [
  ["0", "Auto (source speed)"],
  ["0.0167", "60 fps"],
  ["0.033", "30 fps"],
  ["0.04", "25 fps"],
  ["0.067", "15 fps"],
  ["0.1", "10 fps"],
  ["0.5", "2 fps"],
  ["1", "1 frame per second"],
  ["5", "Slideshow, 5s per frame"],
  ["60", "Slideshow, 1 min per frame"],
];

const selectCls =
  "rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-[11px] text-zinc-200";

/** Hover-play video that releases its decoder on unmount: without the
 *  src-reset + load(), Chromium keeps each unmounted <video>'s buffers
 *  alive until GC, and a browsing session accumulates them. */
function HoverVideo({
  src,
  poster,
  style,
  onLeave,
}: {
  src: string;
  poster?: string;
  style: CSSProperties;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    return () => {
      const v = ref.current;
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, []);
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      autoPlay
      playsInline
      onMouseLeave={onLeave}
      className="h-full w-full"
      style={style}
    />
  );
}

function fitStyle(entry: DynpaintEntry): CSSProperties {
  const fit = entry.fit ?? "cover";
  return {
    objectFit: fit === "stretch" ? "fill" : fit,
    objectPosition: `${(entry.cropX ?? 0.5) * 100}% ${(entry.cropY ?? 0.5) * 100}%`,
  };
}

/** The picked media inside a tile: images and GIFs render (and animate)
 *  natively; videos show a disk-cached thumbnail and play on hover. */
function MediaPreview({
  path,
  entry,
  ffmpegPath,
}: {
  path: string;
  entry: DynpaintEntry;
  ffmpegPath?: string;
}) {
  const isVideo = VIDEO_RE.test(path);
  const [thumb, setThumb] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!isVideo) return;
    let live = true;
    videoThumb(path, ffmpegPath).then((t) => {
      if (live) setThumb(t);
    });
    return () => {
      live = false;
    };
  }, [path, isVideo, ffmpegPath]);
  const style = fitStyle(entry);
  if (isVideo && hover) {
    return (
      <HoverVideo
        src={convertFileSrc(path)}
        poster={thumb ?? undefined}
        style={style}
        onLeave={() => setHover(false)}
      />
    );
  }
  const src = isVideo ? thumb : convertFileSrc(path);
  return (
    <div className="h-full w-full" onMouseEnter={() => isVideo && setHover(true)}>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full"
          style={style}
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-600">
          …
        </div>
      )}
      {isVideo && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] text-zinc-300">
          ▶ hover to play
        </span>
      )}
    </div>
  );
}

/** One surface as an aspect-true tile. */
function SurfaceTile({
  target,
  panel,
  entry,
  selected,
  roomLightOn,
  onPick,
  ffmpegPath,
}: {
  target: DynpaintTargetInfo;
  panel: DynpaintPanelInfo;
  /** This surface's entry, when set. */
  entry: DynpaintEntry | undefined;
  /** This tile's settings panel is open. */
  selected: boolean;
  roomLightOn: boolean;
  onPick: () => void;
  ffmpegPath?: string;
}) {
  const h = 150;
  const w = Math.round(Math.min(300, Math.max(64, (h * panel.cell.w) / panel.cell.h)));
  const active = !!entry?.sourceMedia;
  return (
    <div className="flex flex-col items-center gap-1" style={{ width: w }}>
      <button
        onClick={onPick}
        title={
          active
            ? `${panel.title} - ${panel.blurb}. Click to edit its settings.`
            : `${panel.title} - ${panel.blurb}. Click to pick an image, GIF or video.`
        }
        className={`relative overflow-hidden rounded-md border transition ${
          selected
            ? "border-violet-300 shadow-[0_0_16px_rgba(167,139,250,0.45)]"
            : active
              ? "border-violet-400/70 shadow-[0_0_12px_rgba(139,92,246,0.25)]"
              : "border-dashed border-zinc-700 hover:border-violet-400/50"
        } bg-black`}
        style={{ width: w, height: h }}
      >
        {active && entry ? (
          <>
            <MediaPreview path={entry.sourceMedia} entry={entry} ffmpegPath={ffmpegPath} />
            {target.roomLight && roomLightOn && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ backgroundColor: target.roomLight.css, mixBlendMode: "multiply" }}
              />
            )}
          </>
        ) : (
          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="text-[11px] font-medium text-zinc-400">{panel.title}</span>
            <span className="text-[9px] leading-tight text-zinc-600">{panel.blurb}</span>
            <span className="mt-1 text-[10px] text-violet-300/80">＋ animate</span>
          </span>
        )}
      </button>
      <span
        className={`max-w-full truncate text-[10px] ${selected ? "text-violet-300" : "text-zinc-500"}`}
        title={panel.blurb}
      >
        {panel.title}
      </span>
    </div>
  );
}

export function AnimatedArt({
  dynpaints,
  onDynpaintsChange,
  ffmpegPath,
}: {
  dynpaints: DynpaintEntry[];
  onDynpaintsChange: (list: DynpaintEntry[]) => void;
  ffmpegPath?: string;
}) {
  // Room-light preview defaults ON so what you see is close to the game.
  const [roomLight, setRoomLight] = useState(true);
  // The tile whose settings panel is open (one panel app-wide keeps a fully
  // filled wall readable). Click a filled tile to open it; click again to close.
  const [selected, setSelected] = useState<{ t: string; p: string } | null>(null);

  const entryOf = (targetId: string, panelId: string) =>
    dynpaints.find((d) => d.id === targetId && (d.panel ?? "card1") === panelId);
  const setEntry = (t: DynpaintTargetInfo, panelId: string, patch: Partial<DynpaintEntry>) => {
    const cur = entryOf(t.id, panelId);
    const rest = dynpaints.filter((d) => !(d.id === t.id && (d.panel ?? "card1") === panelId));
    onDynpaintsChange([
      ...rest,
      {
        id: t.id,
        panel: panelId,
        sourceMedia: "",
        dwell: 0,
        maxFrames: 240,
        enabled: true,
        fit: "cover",
        cropX: 0.5,
        cropY: 0.5,
        ...(cur ?? {}),
        ...patch,
      } as DynpaintEntry,
    ]);
  };
  const removeEntry = (t: DynpaintTargetInfo, panelId: string) => {
    onDynpaintsChange(
      dynpaints.filter((d) => !(d.id === t.id && (d.panel ?? "card1") === panelId)),
    );
    setSelected((s) => (s && s.t === t.id && s.p === panelId ? null : s));
  };
  const pick = async (t: DynpaintTargetInfo, panelId: string) => {
    const panel = t.panels.find((p) => p.id === panelId);
    const sel = await openDialog({
      multiple: false,
      title: `Art for ${panel?.title ?? t.name} (image, GIF or video)`,
      filters: [{ name: "Image or animation", extensions: MEDIA_EXTENSIONS }],
    });
    if (typeof sel === "string" && sel) {
      setEntry(t, panelId, { sourceMedia: sel, enabled: true });
      setSelected({ t: t.id, p: panelId });
    }
  };
  /** Copy the selected surface's look (fit/crop/speed/frames) onto every
   *  other filled surface of the same host - fill 11 signs, tune one. */
  const applyToHost = (t: DynpaintTargetInfo, from: DynpaintEntry) => {
    onDynpaintsChange(
      dynpaints.map((d) =>
        d.id === t.id && d.sourceMedia
          ? {
              ...d,
              fit: from.fit,
              cropX: from.cropX,
              cropY: from.cropY,
              dwell: from.dwell,
              maxFrames: from.maxFrames,
            }
          : d,
      ),
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-500">
        Play a GIF or video - or show a still image - on these in-world surfaces. Each tile
        has its surface's real shape, and shows your art exactly as it will be cropped in
        game. Fill as many surfaces as you like, then click a filled tile to tune its fit,
        speed and length. Everything compiles into your pack like the rest of Wall Art.
        <span className="mt-1 block text-xs text-zinc-600">
          Technique and surface data by goldenboy44 (leonyarov), used with permission -
          the original Dynamic Paintings web tool lives on GameBanana (tools/23828).
        </span>
      </p>

      {DYNPAINT_TARGETS.map((t) => {
        const activeCount = t.panels.filter((p) => entryOf(t.id, p.id)?.sourceMedia).length;
        const sel = selected && selected.t === t.id ? entryOf(t.id, selected.p) : undefined;
        const selPanel =
          sel && selected ? t.panels.find((p) => p.id === selected.p) : undefined;
        const fit = sel?.fit ?? "cover";
        return (
          <section key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-200">{t.name}</h3>
              <span className="text-[11px] text-zinc-600">{t.where}</span>
              {t.beta && (
                <span
                  className="rounded bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-300"
                  title="Newer surfaces, still being checked in game"
                >
                  beta
                </span>
              )}
              {activeCount > 0 && (
                <span className="rounded bg-violet-500/15 px-1.5 text-[10px] font-semibold text-violet-300">
                  {activeCount} animated
                </span>
              )}
              <div className="flex-1" />
              {t.roomLight && (
                <label
                  className="flex items-center gap-1 text-[11px] text-zinc-400"
                  title={t.roomLight.help}
                >
                  <input
                    type="checkbox"
                    checked={roomLight}
                    onChange={(e) => setRoomLight(e.target.checked)}
                    className="accent-violet-500"
                  />
                  Preview room light
                </label>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-start gap-3">
              {t.panels.map((p) => {
                const entry = entryOf(t.id, p.id);
                const isSel = !!selected && selected.t === t.id && selected.p === p.id;
                return (
                  <SurfaceTile
                    key={p.id}
                    target={t}
                    panel={p}
                    entry={entry}
                    selected={isSel}
                    roomLightOn={roomLight}
                    onPick={() => {
                      if (!entry?.sourceMedia) void pick(t, p.id);
                      else setSelected(isSel ? null : { t: t.id, p: p.id });
                    }}
                    ffmpegPath={ffmpegPath}
                  />
                );
              })}
            </div>
            {activeCount > 2 && (
              <p className="mt-2 text-[10px] text-amber-300/80">
                Many animated surfaces here: per-surface texture size steps down (3-4
                surfaces: 4096px, 5 or more: 2048px) - shorter loops and slightly softer
                frames, so all of them together stay easy on video memory.
              </p>
            )}

            {sel && selected && selPanel && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-zinc-950/60 p-2">
                <span className="text-[11px] font-semibold text-violet-200">
                  {selPanel.title}
                </span>
                <span
                  className="max-w-[12rem] truncate text-xs text-zinc-400"
                  title={sel.sourceMedia}
                >
                  {sel.sourceMedia.split(/[\\/]/).pop()}
                </span>
                <button
                  onClick={() => void pick(t, selected.p)}
                  className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-200 transition hover:bg-violet-500/20"
                >
                  Change…
                </button>
                <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                  Fit
                  <select
                    value={fit}
                    onChange={(e) =>
                      setEntry(t, selected.p, { fit: e.target.value as DynpaintEntry["fit"] })
                    }
                    className={selectCls}
                  >
                    <option value="cover">Fill (crop the overflow)</option>
                    <option value="contain">Fit (letterbox)</option>
                    <option value="stretch">Stretch</option>
                  </select>
                </label>
                {fit !== "stretch" && (
                  <>
                    <select
                      value={String(sel.cropX ?? 0.5)}
                      onChange={(e) => setEntry(t, selected.p, { cropX: Number(e.target.value) })}
                      title={
                        fit === "cover"
                          ? "Which part survives when the sides overflow"
                          : "Where the image sits in the letterbox"
                      }
                      className={selectCls}
                    >
                      <option value="0">Left</option>
                      <option value="0.5">Center</option>
                      <option value="1">Right</option>
                    </select>
                    <select
                      value={String(sel.cropY ?? 0.5)}
                      onChange={(e) => setEntry(t, selected.p, { cropY: Number(e.target.value) })}
                      title={
                        fit === "cover"
                          ? "Which part survives when the top or bottom overflow"
                          : "Where the image sits in the letterbox"
                      }
                      className={selectCls}
                    >
                      <option value="0">Top</option>
                      <option value="0.5">Middle</option>
                      <option value="1">Bottom</option>
                    </select>
                  </>
                )}
                <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                  Speed
                  <select
                    value={String(sel.dwell ?? 0)}
                    onChange={(e) => setEntry(t, selected.p, { dwell: Number(e.target.value) })}
                    className={selectCls}
                  >
                    {DWELLS.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className="flex items-center gap-1 text-[11px] text-zinc-400"
                  title="More frames = a longer loop but a heavier texture"
                >
                  Max frames
                  <select
                    value={String(sel.maxFrames ?? 240)}
                    onChange={(e) =>
                      setEntry(t, selected.p, { maxFrames: Number(e.target.value) })
                    }
                    className={selectCls}
                  >
                    {["60", "120", "240", "480", "900"].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                {activeCount > 1 && (
                  <button
                    onClick={() => applyToHost(t, sel)}
                    title="Copy this tile's fit, position, speed and max frames onto every other filled surface here (the files stay)"
                    className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-violet-400/50 hover:text-violet-200"
                  >
                    ⧉ Apply look to all
                  </button>
                )}
                <button
                  onClick={() => removeEntry(t, selected.p)}
                  title="Back to the stock surface"
                  className="rounded px-1.5 text-xs text-red-400/80 hover:text-red-300"
                >
                  ✕ remove
                </button>
                <button
                  onClick={() => setSelected(null)}
                  title="Close these settings"
                  className="ml-auto rounded px-1.5 text-xs text-zinc-500 hover:text-zinc-300"
                >
                  ✕
                </button>
              </div>
            )}
            {activeCount > 0 && !sel && (
              <p className="mt-2 text-[10px] text-zinc-600">
                Click a filled tile to change its file, fit, speed or length.
              </p>
            )}
            {t.note && activeCount > 0 && (
              <p className="mt-1.5 text-[10px] text-zinc-600">{t.note}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
