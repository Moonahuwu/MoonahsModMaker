import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { modelGltf, propThumb, savePropRender } from "../lib/api";
import catalog from "../data/objectCatalog.json";

export interface ObjectTarget {
  id: string;
  label: string;
  hint?: string;
  /** Internal vmdl path, no `_c`. */
  model: string;
  /** The group it came from (shown on the card once picked). */
  group: string;
}

interface CatalogItem {
  id: string;
  label: string;
  hint?: string;
  model: string;
}
interface CatalogGroup {
  id: string;
  label: string;
  hint: string;
  items: CatalogItem[];
}

const GROUPS = (catalog as { groups: CatalogGroup[] }).groups;

export const OBJECT_TARGETS: ObjectTarget[] = GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.label })),
);

/** Find a catalog entry by its model path (for rebuilds of saved overrides). */
export function objectByModel(model: string): ObjectTarget | undefined {
  const m = model.replace(/_c$/, "");
  return OBJECT_TARGETS.find((t) => t.model === m);
}

/** convertFileSrc throws outside Tauri (browser preview) - degrade to none.
 *  Any `?v=` cache-buster is split off first: it belongs on the URL, not on
 *  the file path being converted. */
function fileSrc(p: string): string {
  const [path, query] = p.split("?");
  try {
    return convertFileSrc(path) + (query ? `?${query}` : "");
  } catch {
    return "";
  }
}

/**
 * The non-hero half of Model Replacement: a browsable grid of the game's
 * objects (urn, crates, soul container, map fixtures). Card art is each
 * model's own color texture, pulled from the game files on demand - so the
 * grid never goes stale after a patch and needs no shipped images.
 */
export function ObjectPicker({
  helperPath,
  pakPath,
  selected,
  replaced,
  onPick,
}: {
  helperPath: string;
  pakPath: string;
  /** Model path of the current selection, if any. */
  selected: string;
  /** Model paths that already have a swap (badge on the card). */
  replaced: Set<string>;
  onPick: (target: ObjectTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, string | "none">>({});
  const [rendering, setRendering] = useState(false);
  // One in-flight fetch per model, ever - the backend caches on disk too.
  const asked = useRef<Set<string>>(new Set());

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          i.model.toLowerCase().includes(q) ||
          (i.hint ?? "").toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  useEffect(() => {
    if (!helperPath || !pakPath) return;
    let cancelled = false;
    (async () => {
      // Two passes, both sequential (a burst of decompiles would stall the
      // IPC queue for no visible gain):
      //  1. whatever art is already cached - instant, fills the grid
      //  2. a real 3D render per model, which replaces it and is cached
      //     from then on
      const cached: Record<string, string> = {};
      for (const t of OBJECT_TARGETS) {
        if (cancelled) return;
        if (asked.current.has(t.model)) continue;
        asked.current.add(t.model);
        try {
          const png = await propThumb(helperPath, pakPath, t.model);
          cached[t.model] = png;
          if (!cancelled) setThumbs((p) => ({ ...p, [t.model]: png }));
        } catch {
          if (!cancelled) setThumbs((p) => ({ ...p, [t.model]: "none" }));
        }
      }
      if (cancelled) return;
      // A cached render is already named render.png - don't redo those.
      const todo = OBJECT_TARGETS.filter(
        (t) => !(cached[t.model] ?? "").endsWith("render.png"),
      );
      if (todo.length === 0) return;
      setRendering(true);
      // three.js only loads here, and only the first time the grid is opened
      // with un-rendered models.
      const { renderModelThumb, disposeThumbRenderer } = await import("../lib/thumbRender");
      try {
        for (const t of todo) {
          if (cancelled) return;
          try {
            const glb = await modelGltf(helperPath, pakPath, t.model);
            const dataUrl = await renderModelThumb(glb);
            const saved = await savePropRender(t.model, dataUrl);
            if (!cancelled) {
              // Cache-bust: the path is stable but the picture changed.
              setThumbs((p) => ({ ...p, [t.model]: `${saved}?v=${Date.now()}` }));
            }
          } catch {
            /* keep whatever art this card already had */
          }
        }
      } finally {
        disposeThumbRenderer();
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [helperPath, pakPath]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search objects…"
          className="w-56 rounded-md border border-zinc-700 bg-zinc-900/70 px-2.5 py-1 text-sm text-zinc-200 placeholder-zinc-600 outline-none transition focus:border-rose-400/70"
        />
        <span className="text-[11px] text-zinc-600">
          objects compile with the normal mod tools - no CS2 needed
        </span>
        {rendering && (
          <span className="text-[11px] text-zinc-500">drawing previews…</span>
        )}
      </div>

      {groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
              {g.label}
            </h4>
            <span className="text-[10px] text-zinc-600">{g.hint}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {g.items.map((it) => {
              const thumb = thumbs[it.model];
              const isSel = selected === it.model;
              const has = replaced.has(it.model);
              return (
                <button
                  key={it.id}
                  onClick={() => onPick({ ...it, group: g.label })}
                  title={it.model}
                  className={`group relative flex h-28 flex-col justify-end overflow-hidden rounded-lg border p-2 text-left transition ${
                    isSel
                      ? "border-rose-400/70 bg-rose-400/10"
                      : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"
                  }`}
                >
                  {thumb && thumb !== "none" && (
                    // A 3D render is the model on transparency - show it whole
                    // and bright. A texture swatch is wallpaper - crop and dim
                    // it so the label stays readable.
                    <img
                      src={fileSrc(thumb)}
                      alt=""
                      aria-hidden
                      className={
                        thumb.includes("render.png")
                          ? "pointer-events-none absolute inset-x-0 top-0 mx-auto h-[78%] w-full object-contain opacity-95 transition duration-300 group-hover:scale-105"
                          : "pointer-events-none absolute inset-0 h-full w-full object-cover opacity-45 transition duration-300 group-hover:scale-105 group-hover:opacity-60"
                      }
                    />
                  )}
                  <div
                    className={`pointer-events-none absolute inset-0 ${
                      thumb && thumb.includes("render.png")
                        ? "bg-gradient-to-t from-zinc-950 via-zinc-950/30 to-transparent"
                        : "bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent"
                    }`}
                  />
                  {has && (
                    <span className="absolute left-2 top-2 rounded bg-rose-400/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-950">
                      replaced
                    </span>
                  )}
                  <div className="relative">
                    <p className="truncate text-xs font-medium text-zinc-100">{it.label}</p>
                    {it.hint && (
                      <p className="truncate text-[10px] text-zinc-400">{it.hint}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {groups.length === 0 && (
        <p className="py-6 text-center text-sm text-zinc-500">
          Nothing matches "{query}".
        </p>
      )}
    </div>
  );
}
