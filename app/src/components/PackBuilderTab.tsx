import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { scanPackContents, type PackContents } from "../lib/api";
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
  /** Bundled mods only: the vpk's full path (drives the contents viewer). */
  path?: string;
}

/** Two+ modules shipping the same output file: installed as separate addon
 *  paks, the lower slot silently wins and the other module's edit vanishes.
 *  Computed by App.tsx mirroring real compile rules; display-only here. */
export interface ModuleConflict {
  file: string;
  kind: string;
  modules: string[];
}

export interface ExportModuleResult {
  ok: boolean;
  outputPath: string | null;
  failed: number;
  error?: string;
  /** Release zip (vpk + README), when "Package for release" was on and the build was clean. */
  zipPath?: string | null;
  /** Paste-ready GameBanana description generated for this module. */
  description?: string;
}

/** Display order for kinds inside a module card (and for auto-sort buckets). */
const KIND_ORDER = [
  "Sound slot",
  "Sound replace",
  "Image",
  "Wall art",
  "Hero skin",
  "Hero model",
  "Mod texture",
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
  "Hero model": "Hero Models",
  "Mod texture": "Bundled Mods",
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
  "Hero model": "#fda4af",
  "Mod texture": "#eab308",
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

/** Kinds a row can remove directly. Jumpscares/Gameplay are aggregates with
 *  whole tabs behind them - they only link, never delete from here. */
function removeHint(item: PackItem): string | null {
  const kind = item.key.split(":")[0];
  switch (kind) {
    case "slot":
      return "Clear this slot's songs and edits (the slot itself stays in its tab)";
    case "mod":
      return "Remove this bundled mod from the pack (the vpk file on disk stays)";
    case "digimod":
    case "gameplay":
      return null;
    default:
      return "Remove this from the pack";
  }
}

/** Scan results survive collapse/expand and re-renders; a vpk's contents
 *  don't change while the app runs. */
const packScanCache = new Map<string, PackContents>();

const CONTENT_CATEGORIES: { key: keyof PackContents; label: string }[] = [
  { key: "models", label: "Models" },
  { key: "particles", label: "Particles" },
  { key: "overwrites", label: "Replaces game sounds" },
  { key: "ownSounds", label: "Own sounds" },
  { key: "materials", label: "Materials" },
  { key: "panorama", label: "UI / menu files" },
  { key: "other", label: "Other files" },
];

/** What's INSIDE a bundled mod's vpk, by category, with per-file and
 *  per-category exclusion. Writes the same importedModExcludes list the
 *  Preview build manages, so compiles and module exports honor it as-is. */
function BundledContents({
  path,
  helperPath,
  pakPath,
  excluded,
  onChange,
}: {
  path: string;
  helperPath: string;
  pakPath: string;
  excluded: string[];
  onChange: (excluded: string[]) => void;
}) {
  const [scan, setScan] = useState<PackContents | null>(packScanCache.get(path) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  useEffect(() => {
    if (scan) return;
    let live = true;
    scanPackContents(helperPath, pakPath, path)
      .then((c) => {
        packScanCache.set(path, c);
        if (live) setScan(c);
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  if (err)
    return <p className="px-2 pb-1 text-[10px] text-red-300">couldn't read the vpk: {err}</p>;
  if (!scan) return <p className="px-2 pb-1 text-[10px] text-zinc-600">reading the vpk…</p>;
  const ex = new Set(excluded);
  return (
    <div className="mx-2 mb-1 rounded-md border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
      {CONTENT_CATEGORIES.filter((c) => scan[c.key].length > 0).map((c) => {
        const files = scan[c.key];
        const exN = files.filter((f) => ex.has(f)).length;
        const open = openCat === c.key;
        return (
          <div key={c.key} className="py-0.5">
            <div className="flex items-center gap-2 text-[11px]">
              <button
                onClick={() => setOpenCat(open ? null : c.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-zinc-300 transition hover:text-zinc-100"
              >
                <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
                <span>{c.label}</span>
                <span className="text-zinc-600">{files.length}</span>
                {exN > 0 && (
                  <span className="rounded bg-red-500/10 px-1 text-[10px] text-red-300">
                    {exN} excluded
                  </span>
                )}
              </button>
              {exN < files.length ? (
                <button
                  onClick={() => onChange([...new Set([...excluded, ...files])])}
                  title="Leave every file in this category out of your compiled pack (the mod's vpk on disk is untouched)"
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300"
                >
                  exclude all
                </button>
              ) : (
                <button
                  onClick={() => onChange(excluded.filter((f) => !files.includes(f)))}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-emerald-400/80 transition hover:bg-emerald-500/10"
                >
                  restore all
                </button>
              )}
            </div>
            {open && (
              <div className="mt-0.5 max-h-40 overflow-y-auto pl-5">
                {files.map((f) => {
                  const isEx = ex.has(f);
                  return (
                    <div key={f} className="flex items-center gap-2 py-px text-[10px]">
                      <span
                        className={`min-w-0 flex-1 truncate font-mono ${
                          isEx ? "text-zinc-700 line-through" : "text-zinc-400"
                        }`}
                        title={f}
                      >
                        {f}
                      </span>
                      <button
                        onClick={() =>
                          onChange(
                            isEx ? excluded.filter((x) => x !== f) : [...excluded, f],
                          )
                        }
                        className={`shrink-0 rounded px-1 text-[10px] transition ${
                          isEx
                            ? "text-emerald-400/80 hover:bg-emerald-500/10"
                            : "text-zinc-600 hover:bg-red-500/10 hover:text-red-300"
                        }`}
                      >
                        {isEx ? "restore" : "exclude"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <p className="mt-1 text-[10px] text-zinc-700">
        Excluded files stay out of every compile and module export - the mod's vpk on disk is
        never changed.
      </p>
    </div>
  );
}

function ItemRow({
  item,
  moduleId,
  modules,
  onAssign,
  onRemove,
  helperPath,
  pakPath,
  modExcludes,
  onModExcludes,
}: {
  item: PackItem;
  /** "" = Core. */
  moduleId: string;
  modules: PackModule[];
  onAssign: (key: string, moduleId: string) => void;
  onRemove: (item: PackItem) => void;
  helperPath: string;
  pakPath: string;
  modExcludes: Record<string, string[]>;
  onModExcludes: (vpk: string, excluded: string[]) => void;
}) {
  const [showContents, setShowContents] = useState(false);
  const tint = KIND_TINT[item.kind] ?? "#a1a1aa";
  // Two-step remove: first click arms, second click (within 4s) deletes.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  const hint = removeHint(item);
  return (
    <div>
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
      {item.path && (
        <button
          onClick={() => setShowContents((v) => !v)}
          title="See what's inside this vpk - models, particles, sounds - and exclude the parts you don't want shipped"
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] transition ${
            showContents
              ? "bg-zinc-800 text-zinc-200"
              : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          }`}
        >
          {showContents ? "▾ contents" : "▸ contents"}
        </button>
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
      {hint ? (
        armed ? (
          <button
            onClick={() => {
              setArmed(false);
              onRemove(item);
            }}
            title={hint}
            className="shrink-0 rounded border border-red-500/60 bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300 transition hover:bg-red-500/25"
          >
            sure?
          </button>
        ) : (
          <button
            onClick={() => setArmed(true)}
            title={hint}
            className="shrink-0 rounded px-1.5 py-0.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-300"
          >
            ✕
          </button>
        )
      ) : (
        <span
          className="shrink-0 px-1.5 py-0.5 text-[10px] text-zinc-700"
          title="Managed in its own tab (Jumpscares / Custom Server) - clear it there"
        >
          tab
        </span>
      )}
    </div>
    {showContents && item.path && (
      <BundledContents
        path={item.path}
        helperPath={helperPath}
        pakPath={pakPath}
        excluded={modExcludes[item.path] ?? []}
        onChange={(next) => onModExcludes(item.path!, next)}
      />
    )}
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
  conflicts,
  onChange,
  onRemoveItem,
  onExportModule,
  helperPath,
  pakPath,
  modExcludes,
  onModExcludes,
}: {
  items: PackItem[];
  modules: PackModule[];
  conflicts: ModuleConflict[];
  onChange: (modules: PackModule[]) => void;
  onRemoveItem: (item: PackItem) => void;
  onExportModule: (
    mod: PackModule,
    baseDir: string,
    packRelease: boolean,
  ) => Promise<ExportModuleResult>;
  helperPath: string;
  pakPath: string;
  /** Per-mod excluded internal paths (settings.importedModExcludes). */
  modExcludes: Record<string, string[]>;
  onModExcludes: (vpk: string, excluded: string[]) => void;
}) {
  const [newName, setNewName] = useState("");
  // null = "every exportable module" (the default until the user picks).
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [packRelease, setPackRelease] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    Record<
      string,
      {
        state: "run" | "ok" | "fail";
        path?: string | null;
        failed?: number;
        error?: string;
        zipPath?: string | null;
        description?: string;
      }
    >
  >({});

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

  // Export: only named modules that own at least one live item.
  const exportable = modules.filter((m) => items.some((i) => ownerOf.get(i.key) === m.id));
  const selected = sel ?? new Set(exportable.map((m) => m.id));
  const hasBundled = modules.some((m) => m.items.some((k) => k.startsWith("mod:")));

  function toggleSel(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  }

  async function runExport() {
    const picks = exportable.filter((m) => selected.has(m.id));
    if (picks.length === 0) return;
    const dir = await openDialog({
      directory: true,
      title: "Export module vpks into which folder?",
    });
    if (typeof dir !== "string") return;
    setExporting(true);
    setStatus({});
    try {
      for (const m of picks) {
        setStatus((s) => ({ ...s, [m.id]: { state: "run" } }));
        const r = await onExportModule(m, dir, packRelease);
        setStatus((s) => ({
          ...s,
          [m.id]: r.ok
            ? {
                state: "ok",
                path: r.outputPath,
                failed: r.failed,
                zipPath: r.zipPath,
                description: r.description,
              }
            : {
                state: "fail",
                path: r.outputPath,
                failed: r.failed,
                error: r.error,
                description: r.description,
              },
        }));
      }
    } finally {
      setExporting(false);
    }
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

      {conflicts.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            Module conflicts
          </p>
          <p className="mt-1 text-[11px] text-amber-200/70">
            These modules ship the same game file. Installed together as separate mods, the lower
            addon slot silently wins and the other module's edit goes missing. Move the colliding
            content into one module (or ship them as one release). Exporting is still allowed.
          </p>
          <div className="mt-2 flex flex-col gap-1">
            {conflicts.slice(0, 8).map((c) => (
              <div key={`${c.kind}:${c.file}`} className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                  {c.kind}
                </span>
                <span className="truncate font-mono text-amber-100/90" title={c.file}>
                  {c.file}
                </span>
                <span className="text-amber-200/60">{c.modules.join(" + ")}</span>
              </div>
            ))}
            {conflicts.length > 8 && (
              <p className="text-[10px] text-amber-200/50">...and {conflicts.length - 8} more</p>
            )}
          </div>
        </div>
      )}

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
                <ItemRow key={i.key} item={i} moduleId="" modules={modules} onAssign={assign} onRemove={onRemoveItem} helperPath={helperPath} pakPath={pakPath} modExcludes={modExcludes} onModExcludes={onModExcludes} />
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
                    <ItemRow key={i.key} item={i} moduleId={m.id} modules={modules} onAssign={assign} onRemove={onRemoveItem} helperPath={helperPath} pakPath={pakPath} modExcludes={modExcludes} onModExcludes={onModExcludes} />
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

          {exportable.length > 0 && (
            <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
                Export modules
              </h3>
              <p className="mt-0.5 text-[10px] text-zinc-600">
                Compile each selected module into its own standalone pak01_dir.vpk (in a folder
                named after the module), ready to release on its own. The normal compile and
                install are not affected.
              </p>
              <div className="mt-3 flex flex-col gap-1">
                {exportable.map((m) => {
                  const st = status[m.id];
                  const count = items.filter((i) => ownerOf.get(i.key) === m.id).length;
                  return (
                    <div key={m.id} className="flex items-center gap-2 text-xs">
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          onChange={() => toggleSel(m.id)}
                          disabled={exporting}
                          className="accent-teal-500"
                        />
                        <span className="truncate text-zinc-200">{m.name}</span>
                        <span className="shrink-0 text-[10px] text-zinc-600">{count} item(s)</span>
                      </label>
                      {st?.state === "run" && <span className="shrink-0 text-zinc-400">building…</span>}
                      {st?.state === "ok" && (
                        <span className="shrink-0 text-emerald-300">
                          ✓ done{st.failed ? ` (${st.failed} item(s) failed)` : ""}
                        </span>
                      )}
                      {st?.state === "fail" && (
                        <span className="shrink-0 text-red-300" title={st.error}>
                          ✕ failed
                        </span>
                      )}
                      {(st?.zipPath || st?.path) && (
                        <button
                          onClick={() => void revealItemInDir((st.zipPath ?? st.path)!)}
                          title={st.zipPath ? "Open the release zip's folder" : "Open the vpk's folder"}
                          className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          Show
                        </button>
                      )}
                      {st?.description && (
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(st.description!);
                            setCopiedId(m.id);
                            setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1500);
                          }}
                          title="Copy the generated release description (also saved as description.txt next to the zip)"
                          className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          {copiedId === m.id ? "Copied ✓" : "Copy text"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={packRelease}
                  onChange={(e) => setPackRelease(e.target.checked)}
                  disabled={exporting}
                  className="accent-teal-500"
                />
                Package for release: also zip each vpk (with a README) and write a paste-ready
                GameBanana description next to it
              </label>
              {hasBundled && (
                <p className="mt-2 text-[10px] text-zinc-600">
                  Note: bundled mod vpks aren't inspected, so two modules bundling mods that touch
                  the same files can still collide without a warning above.
                </p>
              )}
              <button
                onClick={() => void runExport()}
                disabled={exporting || exportable.every((m) => !selected.has(m.id))}
                className="mt-3 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-500/20 disabled:opacity-50"
              >
                {exporting
                  ? "Exporting…"
                  : `Export ${exportable.filter((m) => selected.has(m.id)).length} module(s) as standalone vpks`}
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
