import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { propThumb } from "../lib/api";
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

/** convertFileSrc throws outside Tauri (browser preview) - degrade to none. */
function fileSrc(p: string): string {
  try {
    return convertFileSrc(p);
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
      // Sequential: each miss is a decompile, and a burst of them would
      // stall the UI thread's IPC queue for no visible gain.
      for (const t of OBJECT_TARGETS) {
        if (cancelled) return;
        if (asked.current.has(t.model)) continue;
        asked.current.add(t.model);
        try {
          const png = await propThumb(helperPath, pakPath, t.model);
          if (!cancelled) setThumbs((p) => ({ ...p, [t.model]: png }));
        } catch {
          if (!cancelled) setThumbs((p) => ({ ...p, [t.model]: "none" }));
        }
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
                    <img
                      src={fileSrc(thumb)}
                      alt=""
                      aria-hidden
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-45 transition duration-300 group-hover:scale-105 group-hover:opacity-60"
                    />
                  )}
                  {/* Scrim so the label stays readable over any texture. */}
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />
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
