import { useEffect, useMemo, useState } from "react";
import catalogJson from "../data/particleCatalog.json";

/** Shipped by tools/particle-catalog/build-app-data.mjs: every particle
 *  function class the game uses, mined from all vanilla effects, with curated
 *  descriptions and the values Valve actually ships. */
type CatalogField = {
  key: string;
  label: string | null;
  desc: string | null;
  values: [string, number][];
};
type CatalogClass = {
  cls: string;
  name: string;
  kind: string;
  files: number;
  /** File count in the previously shipped data; null = first seen this patch. */
  prev?: number | null;
  desc: string | null;
  seenIn: string[];
  fields: CatalogField[];
  untouched: string[];
};
type Catalog = {
  totalEffects: number;
  attrs: [string, string, string][];
  inputTypes: [string, string][];
  classes: CatalogClass[];
};

const CATALOG = catalogJson as unknown as Catalog;

/** Stage metadata: pipeline order, chip label, tint. */
const KINDS: Record<string, { label: string; color: string }> = {
  base: { label: "Base", color: "#c9c9d4" },
  "pre-emission": { label: "Pre-Emission", color: "#b39ddb" },
  emitter: { label: "Emitter", color: "#e8b64e" },
  initializer: { label: "Initializer", color: "#6fc3f7" },
  operator: { label: "Operator", color: "#7ff0d3" },
  force: { label: "Force", color: "#f08d7a" },
  constraint: { label: "Constraint", color: "#e77fa4" },
  renderer: { label: "Renderer", color: "#f0975e" },
};
const KIND_ORDER = Object.keys(KINDS);

const PIPELINE_HINT =
  "Every effect runs the same pipeline: Pre-Emission sets up control points (the numbered anchor slots effects attach to), Emitters decide when particles spawn, Initializers set their starting attributes, Operators change attributes every frame, Forces push velocity, Constraints hard-limit positions, and Renderers draw the result. Children are whole other effects playing along - big effects are trees of small ones.";

/** One expandable class entry. */
function ClassCard({
  entry,
  total,
  open,
  onToggle,
}: {
  entry: CatalogClass;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = KINDS[entry.kind] ?? KINDS.operator;
  const pct = Math.max(1, Math.round((100 * entry.files) / total));
  const [copied, setCopied] = useState(false);

  return (
    <div id={`pg-${entry.cls}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span
          className="w-24 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: kind.color, background: `${kind.color}1f` }}
        >
          {kind.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 truncate text-sm font-semibold text-zinc-100">
            {entry.name}
            {entry.prev === null && (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
                new
              </span>
            )}
          </span>
          <span className="block truncate font-mono text-[11px] text-zinc-600">{entry.cls}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="hidden h-1 w-20 overflow-hidden rounded bg-zinc-800 sm:block">
            <span className="block h-full rounded" style={{ width: `${pct}%`, background: kind.color }} />
          </span>
          <span
            className="w-14 text-right text-xs tabular-nums text-zinc-500"
            title={`used in ${entry.files.toLocaleString()} of ${total.toLocaleString()} vanilla effects`}
          >
            {entry.files.toLocaleString()}
          </span>
          <span className="text-xs text-zinc-600">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 px-4 py-3">
          {entry.desc && <p className="mb-2 max-w-[70ch] text-sm text-zinc-300">{entry.desc}</p>}
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(entry.cls);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            >
              {copied ? "copied" : "⧉ copy class"}
            </button>
            {entry.seenIn.length > 0 && (
              <span className="truncate">
                Seen in: <span className="font-mono text-zinc-600">{entry.seenIn.join("  ")}</span>
              </span>
            )}
          </div>

          {entry.fields.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-zinc-600">
                    <th className="pb-1.5 pr-3 font-semibold">Property</th>
                    <th className="pb-1.5 font-semibold">Values Valve actually uses</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.fields.map((f) => (
                    <tr key={f.key} className="border-t border-zinc-800/70 align-top">
                      <td className="w-2/5 py-1.5 pr-3">
                        <span className="font-mono text-xs text-zinc-200">{f.key}</span>
                        {f.label && <span className="block text-[11px] text-emerald-400/80">{f.label}</span>}
                        {f.desc && <span className="block max-w-[48ch] text-[11px] text-zinc-500">{f.desc}</span>}
                      </td>
                      <td className="py-1.5">
                        <span className="flex flex-wrap gap-1">
                          {f.values.map(([val, count]) => (
                            <span
                              key={val}
                              className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
                              title={`${count} vanilla use(s)`}
                            >
                              {val}
                              <span className="ml-1 text-[10px] text-zinc-600">x{count}</span>
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {entry.untouched.length > 0 && (
            <p className="mt-2.5 text-[11px] leading-relaxed text-zinc-600">
              <span className="font-semibold">Always default in vanilla (safe to ignore):</span>{" "}
              <span className="font-mono">{entry.untouched.join("  ")}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The Particle Guide tab: a searchable reference of every particle function
 *  in the game - the docs the particle editor never had. */
export function ParticleReference({
  accent,
  focusClass,
  onFocusHandled,
  onOpenInspector,
}: {
  accent: string;
  /** Class to scroll to + expand (deep link from the Inspector). */
  focusClass?: string | null;
  onFocusHandled?: () => void;
  /** Open the effect Inspector modal (search any effect, see its functions). */
  onOpenInspector?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState<"pipeline" | "reading" | null>(null);

  const hasNew = useMemo(() => CATALOG.classes.some((c) => c.prev === null), []);

  // Deep link: clear filters, expand the card, scroll it into view.
  useEffect(() => {
    if (!focusClass) return;
    setQuery("");
    setKind(null);
    setNewOnly(false);
    setOpenCards((prev) => new Set(prev).add(focusClass));
    const t = setTimeout(() => {
      document
        .getElementById(`pg-${focusClass}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      onFocusHandled?.();
    }, 60);
    return () => clearTimeout(t);
  }, [focusClass, onFocusHandled]);

  const searchable = useMemo(
    () =>
      CATALOG.classes.map((c) => ({
        c,
        hay: [c.cls, c.name, c.desc ?? "", ...c.fields.map((f) => f.key + " " + (f.label ?? ""))]
          .join(" ")
          .toLowerCase(),
      })),
    [],
  );

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return searchable
      .filter(
        ({ c, hay }) =>
          (!kind || c.kind === kind) &&
          (!newOnly || c.prev === null) &&
          words.every((w) => hay.includes(w)),
      )
      .map(({ c }) => c);
  }, [searchable, query, kind, newOnly]);

  const toggleCard = (cls: string) =>
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      {/* Search + stage filter, sticky so the list stays navigable. */}
      <div className="sticky top-0 z-10 -mx-1 rounded-xl bg-zinc-950/90 px-1 pb-2 pt-1 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search: color, radius, emit, m_flEmitRate, C_OP_..."
            spellCheck={false}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-zinc-600"
            style={{ caretColor: accent }}
          />
          <span className="shrink-0 text-xs tabular-nums text-zinc-500">
            {shown.length} / {CATALOG.classes.length}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setKind(null)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
              kind === null
                ? "border-zinc-300 bg-zinc-200 font-semibold text-zinc-900"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            All
          </button>
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setKind(kind === k ? null : k)}
              className="rounded-full border px-2.5 py-0.5 text-[11px] transition"
              style={
                kind === k
                  ? { borderColor: KINDS[k].color, background: KINDS[k].color, color: "#101014", fontWeight: 600 }
                  : { borderColor: "#3f3f46", color: KINDS[k].color }
              }
            >
              {KINDS[k].label}
            </button>
          ))}
          {hasNew && (
            <button
              onClick={() => setNewOnly(!newOnly)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
                newOnly
                  ? "border-amber-400 bg-amber-400 text-zinc-900"
                  : "border-amber-500/50 text-amber-300 hover:border-amber-400"
              }`}
              title="Functions that first appeared in the latest game patch"
            >
              New
            </button>
          )}
          <span className="mx-1 h-4 w-px bg-zinc-800" />
          {onOpenInspector && (
            <button
              onClick={onOpenInspector}
              style={{ borderColor: `${accent}66`, color: accent }}
              className="rounded-full border px-2.5 py-0.5 text-[11px] transition hover:brightness-125"
              title="Pick any game effect and see which functions it uses"
            >
              Inspect an effect...
            </button>
          )}
          <button
            onClick={() => setShowHelp(showHelp === "pipeline" ? null : "pipeline")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
              showHelp === "pipeline"
                ? "border-zinc-500 text-zinc-200"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            How effects work
          </button>
          <button
            onClick={() => setShowHelp(showHelp === "reading" ? null : "reading")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
              showHelp === "reading"
                ? "border-zinc-500 text-zinc-200"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Inputs + attributes
          </button>
        </div>
      </div>

      {showHelp === "pipeline" && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {KIND_ORDER.filter((k) => k !== "base").map((k) => (
              <span
                key={k}
                className="rounded border border-zinc-800 px-2 py-0.5 text-[11px]"
                style={{ color: KINDS[k].color }}
              >
                {KINDS[k].label}
              </span>
            ))}
          </div>
          <p className="max-w-[80ch] text-xs leading-relaxed text-zinc-400">{PIPELINE_HINT}</p>
        </div>
      )}

      {showHelp === "reading" && (
        <div className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-zinc-200">
              Inputs - the dropdown most number fields have
            </h4>
            <ul className="flex flex-col gap-1 text-[11px] leading-relaxed text-zinc-400">
              {CATALOG.inputTypes.map(([n, d]) => (
                <li key={n}>
                  <span className="font-semibold text-zinc-300">{n}:</span> {d}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-zinc-200">
              Attribute numbers (Output Field / m_nFieldOutput)
            </h4>
            <div className="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
              {CATALOG.attrs.map(([n, name, d]) => (
                <div key={n} className="contents">
                  <span className="font-mono tabular-nums" style={{ color: accent }}>
                    {n}
                  </span>
                  <span className="font-semibold text-zinc-300">{name}</span>
                  <span className="truncate" title={d}>
                    {d}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {shown.map((c) => (
          <ClassCard
            key={c.cls}
            entry={c}
            total={CATALOG.totalEffects}
            open={openCards.has(c.cls)}
            onToggle={() => toggleCard(c.cls)}
          />
        ))}
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-zinc-600">
            No functions match - try fewer or different words.
          </p>
        )}
      </div>

      <p className="pb-2 text-[11px] text-zinc-600">
        Mined from {CATALOG.totalEffects.toLocaleString()} vanilla effects. Usage counts show how
        many effects Valve ships with each function; "always default" lists properties vanilla
        never changes.
      </p>
    </div>
  );
}
