import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useEscape } from "../lib/useEscape";

/** One of your own build files, tagged vs. the last compile. */
export interface YoursFile {
  path: string;
  status: "new" | "changed" | "unchanged";
}

/** One bundled mod's stageable contents for the preview. */
export interface PreviewMod {
  /** The importedMods entry (vpk path or cache dir) — the excludes key. */
  source: string;
  name: string;
  files: string[];
  initialExcluded: string[];
  /** Files the compile never bundles anyway (junk soundevents working
   *  copies). Since the stage-everything change all listed categories ship,
   *  so this is normally 0. */
  skipped: number;
  /** Files byte-identical to the game's originals at the same path — hidden
   *  by the "New & changed" filter (they're bundled vanilla copies). */
  unchanged: string[];
}

type Status = YoursFile["status"];

const STATUS_DOT: Record<Status, { color: string; label: string }> = {
  new: { color: "#34d399", label: "new - first compile" },
  changed: { color: "#f59e0b", label: "changed since the last compile" },
  unchanged: { color: "#3f3f46", label: "unchanged" },
};

// ---- File tree -----------------------------------------------------------

interface TreeFile {
  path: string;
  name: string;
  status?: Status;
}

interface TreeDir {
  /** Display segment; single-child chains are compressed ("sounds/music"). */
  name: string;
  dirs: TreeDir[];
  files: TreeFile[];
  total: number;
  newN: number;
  changedN: number;
}

function buildTree(entries: { path: string; status?: Status }[]): TreeDir {
  interface B {
    name: string;
    dirs: Map<string, B>;
    files: TreeFile[];
  }
  const root: B = { name: "", dirs: new Map(), files: [] };
  for (const e of entries) {
    const segs = e.path.split("/");
    const file = segs.pop()!;
    let cur = root;
    for (const s of segs) {
      let next = cur.dirs.get(s);
      if (!next) {
        next = { name: s, dirs: new Map(), files: [] };
        cur.dirs.set(s, next);
      }
      cur = next;
    }
    cur.files.push({ path: e.path, name: file, status: e.status });
  }
  const finish = (b: B, isRoot: boolean): TreeDir => {
    // Compress "a/b/c" chains (dirs with a single subdir and no files) so
    // deep game paths read as one row instead of three nested ones.
    let name = b.name;
    let cur = b;
    while (!isRoot && cur.dirs.size === 1 && cur.files.length === 0) {
      const only = [...cur.dirs.values()][0];
      name = `${name}/${only.name}`;
      cur = only;
    }
    const dirs = [...cur.dirs.values()]
      .map((d) => finish(d, false))
      .sort((a, b2) => a.name.localeCompare(b2.name));
    const files = [...cur.files].sort((a, b2) => a.name.localeCompare(b2.name));
    const total = files.length + dirs.reduce((n, d) => n + d.total, 0);
    const newN =
      files.filter((f) => f.status === "new").length + dirs.reduce((n, d) => n + d.newN, 0);
    const changedN =
      files.filter((f) => f.status === "changed").length +
      dirs.reduce((n, d) => n + d.changedN, 0);
    return { name, dirs, files, total, newN, changedN };
  };
  return finish(root, true);
}

function collectPaths(d: TreeDir): string[] {
  return [...d.files.map((f) => f.path), ...d.dirs.flatMap(collectPaths)];
}

function FileRow({
  file,
  selected,
  onToggle,
}: {
  file: TreeFile;
  selected?: Set<string>;
  onToggle?: (path: string, on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 py-px pl-5 text-[11px]">
      {selected && onToggle ? (
        <input
          type="checkbox"
          checked={selected.has(file.path)}
          onChange={(e) => onToggle(file.path, e.target.checked)}
          className="accent-emerald-500"
        />
      ) : (
        file.status && (
          <span
            title={STATUS_DOT[file.status].label}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: STATUS_DOT[file.status].color }}
          />
        )
      )}
      <span
        className={`truncate font-mono ${
          file.status === "unchanged" ? "text-zinc-500" : "text-zinc-300"
        }`}
        title={file.path}
      >
        {file.name}
      </span>
    </div>
  );
}

function DirNode({
  dir,
  depth,
  selected,
  onSet,
}: {
  dir: TreeDir;
  depth: number;
  selected?: Set<string>;
  onSet?: (paths: string[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const paths = useMemo(() => collectPaths(dir), [dir]);
  const on = selected ? paths.filter((p) => selected.has(p)).length : 0;
  const allOn = selected ? on === paths.length : false;
  return (
    <div className={depth > 0 ? "pl-4" : undefined}>
      <div className="flex items-center gap-1.5 py-px text-[11px]">
        {selected && onSet && (
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && !allOn;
            }}
            onChange={(e) => onSet(paths, e.target.checked)}
            className="accent-emerald-500"
          />
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 rounded text-left transition hover:text-zinc-100"
        >
          <span className="w-3 shrink-0 text-center text-zinc-600">{open ? "▾" : "▸"}</span>
          <span className="truncate font-mono font-medium text-zinc-300">{dir.name}</span>
        </button>
        {dir.newN > 0 && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[10px] tabular-nums text-emerald-300" title={`${dir.newN} new file(s) inside`}>
            +{dir.newN}
          </span>
        )}
        {dir.changedN > 0 && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] tabular-nums text-amber-300" title={`${dir.changedN} changed file(s) inside`}>
            ~{dir.changedN}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-zinc-600">
          {selected ? `${on}/${paths.length}` : paths.length}
        </span>
      </div>
      {open && (
        <div className="border-l border-zinc-800/60 ml-1.5">
          {dir.dirs.map((d) => (
            <DirNode key={d.name} dir={d} depth={depth + 1} selected={selected} onSet={onSet} />
          ))}
          <div className={dir.dirs.length > 0 || depth > 0 ? "pl-4" : undefined}>
            {dir.files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                selected={selected}
                onToggle={onSet ? (p, o) => onSet([p], o) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Folder tree over a flat path list. With `selected`/`onSet` it's a
 *  checkbox tree (folders tri-state); without, files show status dots. */
function FileTree({
  files,
  selected,
  onSet,
}: {
  files: { path: string; status?: Status }[];
  selected?: Set<string>;
  onSet?: (paths: string[], on: boolean) => void;
}) {
  const root = useMemo(() => buildTree(files), [files]);
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5">
      {root.dirs.map((d) => (
        <DirNode key={d.name} dir={d} depth={0} selected={selected} onSet={onSet} />
      ))}
      {root.files.map((f) => (
        <FileRow
          key={f.path}
          file={f}
          selected={selected}
          onToggle={onSet ? (p, o) => onSet([p], o) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * Pre-compile build preview: everything that will land in the output .vpk —
 * your own files (read-only; they ARE the mod) plus each bundled pack's files
 * with checkboxes. Deselections persist as per-mod excludes, so the compile
 * drops them from the combined build.
 */
export function BuildPreview({
  yours,
  mods,
  onCancel,
  onSave,
}: {
  yours: YoursFile[];
  mods: PreviewMod[];
  onCancel: () => void;
  /** source → excluded file paths (empty array = no exclusions). */
  onSave: (excludes: Record<string, string[]>) => void;
}) {
  useEscape(onCancel);
  // "changed" filter: only what you added or edited since the last compile
  // (bundled mods hidden — they don't change between compiles).
  const [filter, setFilter] = useState<"all" | "changed">("all");
  const shownYours = filter === "all" ? yours : yours.filter((f) => f.status !== "unchanged");
  const [sel, setSel] = useState<Map<string, Set<string>>>(
    () =>
      new Map(
        mods.map((m) => {
          const ex = new Set(m.initialExcluded);
          return [m.source, new Set(m.files.filter((f) => !ex.has(f)))];
        }),
      ),
  );

  const setFiles = (source: string) => (paths: string[], on: boolean) =>
    setSel((prev) => {
      const next = new Map(prev);
      const cur = new Set(next.get(source) ?? []);
      for (const p of paths) {
        if (on) cur.add(p);
        else cur.delete(p);
      }
      next.set(source, cur);
      return next;
    });

  const totalBundled = mods.reduce((n, m) => n + (sel.get(m.source)?.size ?? 0), 0);
  const totalExcluded = mods.reduce(
    (n, m) => n + (m.files.length - (sel.get(m.source)?.size ?? 0)),
    0,
  );

  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onCancel}
    >
      <motion.div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        initial={{ scale: 0.97, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 8 }}
        transition={{ type: "spring", stiffness: 400, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-800 p-5 pb-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-zinc-100">Build preview</h3>
            <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700 text-xs">
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1 font-medium transition ${
                  filter === "all" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                All files
              </button>
              <button
                onClick={() => setFilter("changed")}
                title="Only what you added or edited since the last compile"
                className={`px-3 py-1 font-medium transition ${
                  filter === "changed" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                New & changed
              </button>
            </div>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {filter === "all" ? (
              <>
                Everything the next compile puts in the .vpk - {yours.length} of your files
                {mods.length > 0
                  ? ` + ${totalBundled} bundled from ${mods.length} mod${mods.length === 1 ? "" : "s"}${
                      totalExcluded > 0 ? ` (${totalExcluded} excluded)` : ""
                    }`
                  : ""}
                . Uncheck anything you don't want shipped.
              </>
            ) : (
              <>
                Only what actually changes the game: your new/edited files ({shownYours.length})
                and each pack's genuinely modified files - bundled vanilla copies and
                already-compiled unchanged files are hidden.
              </>
            )}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-1.5 flex items-baseline gap-2 text-xs">
            <span className="font-bold uppercase tracking-wider text-zinc-300">Your files</span>
            <span className="text-zinc-600">- always included (they are the mod)</span>
            <span className="ml-auto flex items-center gap-2.5 text-[10px] text-zinc-500">
              {(Object.keys(STATUS_DOT) as Status[]).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: STATUS_DOT[s].color }}
                  />
                  {s}
                </span>
              ))}
            </span>
          </div>
          {shownYours.length === 0 ? (
            <p className="text-xs text-zinc-600">
              Nothing here - everything is already compiled (or add tracks first).
            </p>
          ) : (
            <FileTree files={shownYours} />
          )}

          {mods.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-zinc-300">
                Bundled mods
              </div>
              <div className="flex flex-col gap-3">
                {mods.map((m) => {
                  const unchangedSet = new Set(m.unchanged);
                  const shown =
                    filter === "all" ? m.files : m.files.filter((f) => !unchangedSet.has(f));
                  const hidden = m.files.length - shown.length;
                  const cur = sel.get(m.source) ?? new Set<string>();
                  const on = shown.filter((f) => cur.has(f)).length;
                  if (shown.length === 0) {
                    return (
                      <p key={m.source} className="text-[11px] text-zinc-600">
                        {m.name}: all {m.files.length} bundled files are identical to the game's
                        originals - nothing it actually changes.
                      </p>
                    );
                  }
                  return (
                    <div key={m.source}>
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={on === shown.length}
                          ref={(el) => {
                            if (el) el.indeterminate = on > 0 && on < shown.length;
                          }}
                          onChange={(e) => setFiles(m.source)(shown, e.target.checked)}
                          className="accent-emerald-500"
                        />
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: "#38bdf8" }} />
                        <span className="font-semibold text-zinc-200">{m.name}</span>
                        <span className="ml-auto text-zinc-600">
                          {on}/{shown.length}
                        </span>
                      </div>
                      <p className="mb-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
                        Files this pack ships into your combined build. Uncheck to leave them out.
                        {filter === "changed" && hidden > 0
                          ? ` ${hidden} file${hidden === 1 ? "" : "s"} identical to the game's originals hidden by the filter.`
                          : ""}
                        {m.skipped > 0
                          ? ` (${m.skipped} junk/non-asset file${m.skipped === 1 ? "" : "s"} - e.g. working folders like NewSoundevents - are never bundled.)`
                          : ""}
                      </p>
                      <FileTree
                        files={shown.map((f) => ({ path: f }))}
                        selected={cur}
                        onSet={setFiles(m.source)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-800 p-5 pt-4">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const excludes: Record<string, string[]> = {};
              for (const m of mods) {
                const on = sel.get(m.source) ?? new Set();
                excludes[m.source] = m.files.filter((f) => !on.has(f));
              }
              onSave(excludes);
            }}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
          >
            Save selection{totalExcluded > 0 ? ` (−${totalExcluded} files)` : ""}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
