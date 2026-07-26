import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readParticleText, openInParticleEditor, openInS2v } from "../lib/api";
import { cBrowseParticles } from "../lib/dataCache";
import { buildOutline, type Outline } from "../lib/kv3";
import { useEscape } from "../lib/useEscape";
import { useToast } from "./Toaster";
import graphJson from "../data/particleGraph.json";

/** Parent/child graph + gameplay owners, mined from all vanilla effects by
 *  tools/particle-catalog/build-graph.mjs. Paths are stored WITHOUT the
 *  leading `particles/`. */
type ParticleGraph = {
  paths: string[];
  parents: number[][];
  owners: Record<string, number[]>;
};
const GRAPH = graphJson as unknown as ParticleGraph;

const pathIndex = new Map<string, number>();
GRAPH.paths.forEach((p, i) => pathIndex.set(p, i));

/** Owners inverted to per-file lookup, built once on first use. */
let ownersByFile: Map<number, string[]> | null = null;
function ownersOf(idx: number): string[] {
  if (!ownersByFile) {
    ownersByFile = new Map();
    for (const [name, files] of Object.entries(GRAPH.owners)) {
      for (const f of files) {
        const list = ownersByFile.get(f) ?? [];
        list.push(name);
        ownersByFile.set(f, list);
      }
    }
  }
  return ownersByFile.get(idx) ?? [];
}

const stripRef = (ref: string) => ref.replace(/^particles\//, "");

/** Walk up the parent graph to the root system(s) that game code spawns. */
function rootsOf(ref: string): string[] {
  const start = pathIndex.get(stripRef(ref));
  if (start === undefined) return [];
  const seen = new Set<number>([start]);
  const queue = [start];
  const roots: number[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    const parents = GRAPH.parents[cur] ?? [];
    if (parents.length === 0) {
      if (cur !== start) roots.push(cur);
      continue;
    }
    for (const p of parents) {
      if (!seen.has(p) && seen.size < 200) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return roots.map((i) => `particles/${GRAPH.paths[i]}`);
}

/** Gameplay owners (abilities/items whose vdata references this file or any
 *  of its ancestors). */
function ownersOfTree(ref: string): string[] {
  const start = pathIndex.get(stripRef(ref));
  if (start === undefined) return [];
  const seen = new Set<number>([start]);
  const queue = [start];
  const names = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const o of ownersOf(cur)) names.add(o);
    for (const p of GRAPH.parents[cur] ?? []) {
      if (!seen.has(p) && seen.size < 200) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return [...names];
}

/** upgrade_counterspell -> "Counterspell (upgrade_counterspell)". */
function prettyOwner(name: string): string {
  const bare = name.replace(/^(citadel_)?(upgrade_|ability_)/, "");
  const label = bare
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return label;
}

/**
 * The effect Inspector: pick any game particle, see its structure (functions
 * per stage with tuned properties), jump to the Particle Guide docs for any
 * function, drill into children, climb to the root system, and open it in the
 * CSDK particle editor.
 */
export function ParticleOutline({
  initialRef,
  helperPath,
  pakPath,
  csdkRoot,
  viewerPath,
  accent,
  onClose,
  onOpenGuide,
}: {
  /** Effect to open with, or null to start on the picker. */
  initialRef: string | null;
  helperPath: string;
  pakPath: string;
  csdkRoot: string;
  /** Source2Viewer path (Setup) - empty disables the S2V button. */
  viewerPath: string;
  accent: string;
  onClose: () => void;
  /** Jump to a function's entry in the Particle Guide tab. */
  onOpenGuide: (cls: string) => void;
}) {
  const { push } = useToast();
  useEscape(onClose);

  // Navigation stack: drilling into a child pushes; breadcrumbs pop back.
  const [stack, setStack] = useState<string[]>(initialRef ? [initialRef] : []);
  const current = stack.length > 0 ? stack[stack.length - 1] : null;

  const [outline, setOutline] = useState<Outline | "loading" | "error" | null>(null);
  const [errText, setErrText] = useState("");
  const [launching, setLaunching] = useState(false);
  const cache = useRef<Map<string, Outline>>(new Map());

  // Picker state (shown when the stack is empty).
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ reference: string; label: string }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!current) return;
    const cached = cache.current.get(current);
    if (cached) {
      setOutline(cached);
      return;
    }
    let cancelled = false;
    setOutline("loading");
    readParticleText(helperPath, pakPath, current)
      .then((text) => {
        if (cancelled) return;
        const o = buildOutline(text);
        cache.current.set(current, o);
        setOutline(o);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrText(String(e));
        setOutline("error");
      });
    return () => {
      cancelled = true;
    };
  }, [current, helperPath, pakPath]);

  useEffect(() => {
    if (current || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      cBrowseParticles(helperPath, pakPath, "particles", query.trim())
        .then((d) => {
          if (!cancelled) setResults(d.files.slice(0, 40));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, current, helperPath, pakPath]);

  const roots = useMemo(() => (current ? rootsOf(current) : []), [current]);
  const owners = useMemo(() => (current ? ownersOfTree(current) : []), [current]);
  const stem = (r: string) => r.split("/").pop()?.replace(/\.vpcf$/, "") ?? r;

  async function launchEditor() {
    if (!current) return;
    setLaunching(true);
    try {
      const msg = await openInParticleEditor(csdkRoot, helperPath, pakPath, current);
      push("success", msg);
    } catch (e) {
      push("error", `Couldn't open the editor: ${e}`);
    } finally {
      setLaunching(false);
    }
  }

  const [s2vBusy, setS2vBusy] = useState(false);
  async function launchS2v() {
    if (!current) return;
    setS2vBusy(true);
    try {
      const msg = await openInS2v(viewerPath, helperPath, pakPath, current);
      push("success", msg);
    } catch (e) {
      push("error", `Couldn't open the viewer: ${e}`);
    } finally {
      setS2vBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-zinc-800 p-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-zinc-100">
              {current ? "Effect Inspector" : "Inspect an effect"}
            </h3>
            {current ? (
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                {stack.map((ref, i) => (
                  <span key={`${ref}-${i}`} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-700">/</span>}
                    {i < stack.length - 1 ? (
                      <button
                        onClick={() => setStack(stack.slice(0, i + 1))}
                        className="font-mono hover:text-zinc-200"
                      >
                        {stem(ref)}
                      </button>
                    ) : (
                      <span className="font-mono text-zinc-300">{stem(ref)}</span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-0.5 text-[11px] text-zinc-600">
                Search any game particle, then explore what it's made of.
              </p>
            )}
          </div>
          {current && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(current);
                push("success", "Path copied");
              }}
              className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              ⧉ path
            </button>
          )}
          {current && (
            <button
              onClick={() => void launchS2v()}
              disabled={s2vBusy || !viewerPath}
              title={
                viewerPath
                  ? "Render this effect in Source 2 Viewer (its children get staged alongside so the whole tree plays)"
                  : "Set the Source2Viewer path in Setup first"
              }
              className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
            >
              {s2vBusy ? "Opening..." : "S2V"}
            </button>
          )}
          {current && (
            <button
              onClick={() => void launchEditor()}
              disabled={launching || !csdkRoot}
              title={
                csdkRoot
                  ? "Stage this effect + its children as sources into the CSDK (eim_inspect addon) and launch the tools on it"
                  : "Set the CSDK root in Settings first"
              }
              style={{ borderColor: `${accent}66`, color: accent }}
              className="shrink-0 rounded-md border px-2.5 py-1 text-xs transition hover:brightness-125 disabled:opacity-40"
            >
              {launching ? "Opening..." : "Open in CSDK editor"}
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-zinc-500 transition hover:text-zinc-200"
            aria-label="Close inspector"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* Picker */}
          {!current && (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search effects: counterspell, bookworm ultimate, tier2_boss_beam..."
                autoFocus
                spellCheck={false}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <div className="mt-2 flex flex-col gap-1">
                {searching && <p className="px-1 py-2 text-xs text-zinc-600">Searching...</p>}
                {!searching && query.trim().length >= 2 && results.length === 0 && (
                  <p className="px-1 py-2 text-xs text-zinc-600">No effects match.</p>
                )}
                {results.map((f) => (
                  <button
                    key={f.reference}
                    onClick={() => setStack([f.reference])}
                    className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-left text-sm text-zinc-300 transition hover:border-zinc-600"
                  >
                    <span className="truncate">{f.label}</span>
                    <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-zinc-600">
                      {f.reference}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Outline */}
          {current && outline === "loading" && (
            <p className="py-8 text-center text-sm text-zinc-500">Decompiling the effect...</p>
          )}
          {current && outline === "error" && (
            <p className="py-8 text-center text-sm text-red-400">{errText}</p>
          )}
          {current && outline && typeof outline === "object" && (
            <div className="flex flex-col gap-3">
              {/* Lineage: root system + the gameplay things that spawn it. */}
              {(roots.length > 0 || owners.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {roots.slice(0, 3).map((r) => (
                    <button
                      key={r}
                      onClick={() => setStack([r])}
                      title={`Root system: ${r} - the file game code spawns; everything else hangs off it`}
                      className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-zinc-300 transition hover:border-zinc-500"
                    >
                      ▲ root: <span className="font-mono">{stem(r)}</span>
                    </button>
                  ))}
                  {roots.length === 0 && (
                    <span
                      className="rounded-full px-2.5 py-0.5 font-semibold"
                      style={{ background: `${accent}22`, color: accent }}
                    >
                      ▲ this IS the root system
                    </span>
                  )}
                  {owners.slice(0, 4).map((o) => (
                    <span
                      key={o}
                      title={`Referenced by ${o} in the game's ability data`}
                      className="rounded-full bg-zinc-800/80 px-2.5 py-0.5 text-zinc-400"
                    >
                      {prettyOwner(o)}
                    </span>
                  ))}
                </div>
              )}

              {outline.base.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                    Base properties
                  </span>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    {outline.base.map((b) => (
                      <span key={b.key} className="font-mono text-[11px] text-zinc-400">
                        {b.key} = <span className="text-zinc-200">{b.value}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {outline.stages.map((st) => (
                <div key={st.stage} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                    {st.stage}
                  </span>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {st.fns.map((fn, i) => (
                      <div key={`${fn.cls}-${i}`} className={fn.disabled ? "opacity-40" : ""}>
                        <button
                          onClick={() => onOpenGuide(fn.cls)}
                          title="Open this function in the Particle Guide"
                          style={{ color: accent }}
                          className="font-mono text-xs hover:underline"
                        >
                          {fn.cls}
                        </button>
                        {fn.disabled && (
                          <span className="ml-2 text-[10px] uppercase text-zinc-600">disabled</span>
                        )}
                        {fn.fields.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-3">
                            {fn.fields.slice(0, 8).map((f) => (
                              <span key={f.key} className="font-mono text-[11px] text-zinc-500">
                                {f.key} = <span className="text-zinc-300">{f.value}</span>
                              </span>
                            ))}
                            {fn.fields.length > 8 && (
                              <span className="text-[11px] text-zinc-600">
                                +{fn.fields.length - 8} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {outline.children.length > 0 && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                    Children ({outline.children.length})
                  </span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {outline.children.map((c) => (
                      <button
                        key={c}
                        onClick={() => setStack([...stack, c])}
                        className="rounded-md border border-zinc-700 px-2 py-0.5 font-mono text-[11px] text-zinc-300 transition hover:border-zinc-500 hover:text-white"
                      >
                        {stem(c)} ▸
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
