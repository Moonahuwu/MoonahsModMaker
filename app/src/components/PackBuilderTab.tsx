import { useMemo, useState } from "react";
import type { PackModule } from "../types";

/** One piece of pack content, flattened by App.tsx from every subsystem into a
 *  stable key + display info. The tab itself is schema-blind: it only moves
 *  keys between modules. */
export interface PackItem {
  key: string;
  /** Content kind, e.g. "Sound slot", "Image", "Wall art", "Bundled mod". */
  kind: string;
  label: string;
  /** Secondary context, e.g. the slot's tab name. */
  detail?: string;
}

/** Display order for kinds inside a module card (and for auto-sort buckets). */
const KIND_ORDER = [
  "Sound slot",
  "Sound replace",
  "Image",
  "Wall art",
  "Hero skin",
  "Effect",
  "UI file",
  "Jumpscares",
  "Gameplay",
  "Bundled mod",
];

/** Auto-sort buckets: content kind -> module name seeded by "Sort by type". */
const AUTO_BUCKETS: Record<string, string> = {
  "Sound slot": "Sounds",
  "Sound replace": "Sounds",
  Image: "Images & Menu Art",
  "Wall art": "Wall Art",
  "Hero skin": "Hero Skins",
  Effect: "Effects",
  "UI file": "UI Edits",
  Jumpscares: "Jumpscares",
  Gameplay: "Gameplay",
  "Bundled mod": "Bundled Mods",
};

const KIND_TINT: Record<string, string> = {
  "Sound slot": "#38bdf8",
  "Sound replace": "#60a5fa",
  Image: "#67e8f9",
  "Wall art": "#8b5cf6",
  "Hero skin": "#a7fff1",
  Effect: "#c084fc",
  "UI file": "#f59e0b",
  Jumpscares: "#ef4444",
  Gameplay: "#f87171",
  "Bundled mod": "#eab308",
};

function newModuleId(): string {
  return `pmod_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function sortItems(items: PackItem[]): PackItem[] {
  return [...items].sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return k !== 0 ? k : a.label.localeCompare(b.label);
  });
}

function ItemRow({
  item,
  moduleId,
  modules,
  onAssign,
}: {
  item: PackItem;
  /** "" = Core. */
  moduleId: string;
  modules: PackModule[];
  onAssign: (key: string, moduleId: string) => void;
}) {
  const tint = KIND_TINT[item.kind] ?? "#a1a1aa";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-zinc-900/70">
      <span
        style={{ borderColor: `${tint}55`, color: tint, backgroundColor: `${tint}14` }}
        className="w-24 shrink-0 truncate rounded border px-1.5 py-0.5 text-center text-[10px] font-medium"
        title={item.kind}
      >
        {item.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-zinc-200" title={item.label}>
        {item.label}
      </span>
      {item.detail && (
        <span className="hidden shrink-0 text-[10px] text-zinc-600 sm:block" title={item.detail}>
          {item.detail}
        </span>
      )}
      <select
        value={moduleId}
        onChange={(e) => onAssign(item.key, e.target.value)}
        className="w-32 shrink-0 rounded-md border border-zinc-700/80 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-300 outline-none transition focus:border-teal-500/70"
        title="Which module this belongs to"
      >
        <option value="">Core</option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModuleCard({
  title,
  count,
  onRename,
  onDelete,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[9px] text-zinc-600 transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
          aria-label={open ? "Collapse" : "Expand"}
        >
          ▶
        </button>
        {editing && onRename ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              const v = draft.trim();
              if (v && v !== title) onRename(v);
              else setDraft(title);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft(title);
                setEditing(false);
              }
            }}
            className="rounded-md border border-teal-500/50 bg-zinc-950 px-2 py-0.5 text-xs font-bold uppercase tracking-widest text-zinc-100 outline-none"
          />
        ) : (
          <button
            onClick={() => onRename && (setDraft(title), setEditing(true))}
            title={onRename ? "Click to rename" : undefined}
            className={`text-[11px] font-bold uppercase tracking-widest text-zinc-300 ${onRename ? "hover:text-teal-300" : "cursor-default"}`}
          >
            {title}
          </button>
        )}
        <span className="rounded bg-teal-500/10 px-1.5 text-[10px] font-semibold text-teal-300">
          {count}
        </span>
        <span className="flex-1" />
        {onDelete && (
          <button
            onClick={onDelete}
            title="Delete this module (its content returns to Core)"
            className="rounded px-1.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-red-300"
          >
            ✕
          </button>
        )}
      </div>
      {open && <div className="flex flex-col gap-0.5 border-t border-zinc-800/70 p-2">{children}</div>}
    </section>
  );
}

/** Pack Builder: organize every piece of the pack into named modules so a big
 *  shared pack can later be split into standalone releases. Assignment only -
 *  compiling still builds everything together. */
export function PackBuilderTab({
  items,
  modules,
  onChange,
}: {
  items: PackItem[];
  modules: PackModule[];
  onChange: (modules: PackModule[]) => void;
}) {
  const [newName, setNewName] = useState("");

  // key -> owning module id (stale keys in modules are ignored via the items
  // list; they stay stored so content that comes back is still assigned).
  const ownerOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of modules) for (const k of m.items) map.set(k, m.id);
    return map;
  }, [modules]);

  const liveKeys = useMemo(() => new Set(items.map((i) => i.key)), [items]);
  const coreItems = sortItems(items.filter((i) => !ownerOf.has(i.key)));
  const unassignedCount = coreItems.length;

  function assign(key: string, moduleId: string) {
    const stripped = modules.map((m) => ({ ...m, items: m.items.filter((k) => k !== key) }));
    onChange(
      moduleId
        ? stripped.map((m) => (m.id === moduleId ? { ...m, items: [...m.items, key] } : m))
        : stripped,
    );
  }

  function addModule() {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    onChange([...modules, { id: newModuleId(), name, items: [] }]);
  }

  /** Seed by content type: move every CORE (unassigned) item into a module
   *  named for its kind, creating modules as needed. Existing assignments are
   *  never touched, so this is safe to press at any time. */
  function autoSort() {
    if (coreItems.length === 0) return;
    const next = modules.map((m) => ({ ...m, items: [...m.items] }));
    for (const item of coreItems) {
      const bucket = AUTO_BUCKETS[item.kind] ?? "Misc";
      let mod = next.find((m) => m.name.toLowerCase() === bucket.toLowerCase());
      if (!mod) {
        mod = { id: newModuleId(), name: bucket, items: [] };
        next.push(mod);
      }
      mod.items.push(item.key);
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModule()}
          placeholder="New module name (e.g. Hero Music)"
          className="w-64 rounded-md border border-zinc-700/80 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-teal-500/70"
        />
        <button
          onClick={addModule}
          disabled={!newName.trim()}
          className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-500/20 disabled:opacity-50"
        >
          + Add module
        </button>
        <button
          onClick={autoSort}
          disabled={unassignedCount === 0}
          title="Move everything still in Core into modules named by content type (Sounds, Wall Art, ...). Never touches what you already assigned."
          className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          Sort Core by content type
        </button>
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-6 text-center text-sm text-zinc-500">
          Nothing to organize yet - add sounds, images, or other content first and it appears here.
        </p>
      ) : (
        <>
          <ModuleCard title="Core" count={unassignedCount} defaultOpen={true}>
            {coreItems.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-zinc-600">
                Everything is assigned to a module. New content lands here first.
              </p>
            ) : (
              coreItems.map((i) => (
                <ItemRow key={i.key} item={i} moduleId="" modules={modules} onAssign={assign} />
              ))
            )}
          </ModuleCard>

          {modules.map((m) => {
            const mine = sortItems(items.filter((i) => ownerOf.get(i.key) === m.id));
            const stale = m.items.filter((k) => !liveKeys.has(k)).length;
            return (
              <ModuleCard
                key={m.id}
                title={m.name}
                count={mine.length}
                onRename={(name) =>
                  onChange(modules.map((x) => (x.id === m.id ? { ...x, name } : x)))
                }
                onDelete={() => onChange(modules.filter((x) => x.id !== m.id))}
              >
                {mine.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] text-zinc-600">
                    Empty - assign content from Core or another module using the dropdowns.
                  </p>
                ) : (
                  mine.map((i) => (
                    <ItemRow key={i.key} item={i} moduleId={m.id} modules={modules} onAssign={assign} />
                  ))
                )}
                {stale > 0 && (
                  <p className="px-2 py-1 text-[10px] text-zinc-700">
                    +{stale} assigned item(s) whose content was removed from the pack - they rejoin if it comes back.
                  </p>
                )}
              </ModuleCard>
            );
          })}
        </>
      )}
    </div>
  );
}
