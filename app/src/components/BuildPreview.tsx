import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { FileSection } from "./ImportReview";

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
  /** Files the compile never bundles anyway (junk / non-asset dirs). */
  skipped: number;
  /** Files byte-identical to the game's originals at the same path — hidden
   *  by the "New & changed" filter (they're bundled vanilla copies). */
  unchanged: string[];
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "(root)" : path.slice(0, i);
}

const STATUS_DOT: Record<YoursFile["status"], { color: string; label: string }> = {
  new: { color: "#34d399", label: "new - first compile" },
  changed: { color: "#f59e0b", label: "changed since the last compile" },
  unchanged: { color: "#3f3f46", label: "unchanged" },
};

/** Read-only folder-grouped listing (your own build files) with status dots. */
function YoursList({ files }: { files: YoursFile[] }) {
  const folders = useMemo(() => {
    const by = new Map<string, YoursFile[]>();
    for (const f of files) {
      const d = dirname(f.path);
      const list = by.get(d) ?? [];
      list.push(f);
      by.set(d, list);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);
  if (files.length === 0)
    return <p className="text-xs text-zinc-600">Nothing here - everything is already compiled (or add tracks first).</p>;
  return (
    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {folders.map(([dir, fs]) => (
        <details key={dir} className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-1">
          <summary className="flex cursor-pointer items-center gap-2 text-[11px]">
            <span className="truncate font-mono text-zinc-400" title={dir}>
              {dir}
            </span>
            <span className="ml-auto shrink-0 text-zinc-600">{fs.length}</span>
          </summary>
          <div className="mt-1 flex flex-col gap-0.5 pl-3">
            {fs.map((f) => (
              <span key={f.path} className="flex items-center gap-1.5 truncate font-mono text-[11px] text-zinc-400" title={`${f.path} - ${STATUS_DOT[f.status].label}`}>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: STATUS_DOT[f.status].color }}
                />
                {f.path.split("/").pop()}
              </span>
            ))}
          </div>
        </details>
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
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
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
          <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-zinc-300">
            Your files <span className="font-normal normal-case text-zinc-600">- always included (they are the mod)</span>
          </div>
          <YoursList files={shownYours} />

          {mods.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-zinc-300">
                Bundled mods
              </div>
              <div className="flex flex-col gap-2">
                {mods.map((m) => {
                  const unchangedSet = new Set(m.unchanged);
                  const shown =
                    filter === "all" ? m.files : m.files.filter((f) => !unchangedSet.has(f));
                  const hidden = m.files.length - shown.length;
                  if (shown.length === 0) {
                    return (
                      <p key={m.source} className="text-[11px] text-zinc-600">
                        {m.name}: all {m.files.length} bundled files are identical to the game's
                        originals - nothing it actually changes.
                      </p>
                    );
                  }
                  return (
                    <FileSection
                      key={m.source}
                      title={m.name}
                      color="#38bdf8"
                      files={shown}
                      note={
                        `Files this pack ships into your combined build. Uncheck to leave them out.` +
                        (filter === "changed" && hidden > 0
                          ? ` ${hidden} file${hidden === 1 ? "" : "s"} identical to the game's originals hidden by the filter.`
                          : "") +
                        (m.skipped > 0
                          ? ` (${m.skipped} junk/non-asset file${m.skipped === 1 ? "" : "s"} - e.g. working folders like NewSoundevents - are never bundled.)`
                          : "")
                      }
                      selected={sel.get(m.source) ?? new Set()}
                      onSet={setFiles(m.source)}
                    />
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
