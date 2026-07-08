import { useMemo, useState } from "react";
import { motion } from "motion/react";
import type { PackContents } from "../lib/api";

/** One importable sound event, already routed to its destination tab. */
export interface ReviewEvent {
  /** Stable key: `${relpath}::${eventName}::${arrayKey}`. */
  key: string;
  eventName: string;
  /** Friendly display label. */
  label: string;
  /** Number of the pack's own tracks inside this event. */
  trackCount: number;
  /** True when it folds into a slot you already have (instead of a new one). */
  foldsIntoExisting: boolean;
  /** True when this comes from a stock-path replacement file: instead of
   *  overwriting the original, the audio is converted into YOUR track and
   *  appended to the event's array (the original stays toggleable). */
  overwrite?: boolean;
}

export interface ReviewGroup {
  group: string;
  /** Tab display name (e.g. "Match Music", "Heroes"). */
  label: string;
  accent: string;
  events: ReviewEvent[];
}

export interface PackReview {
  vpk: string;
  name: string;
  groups: ReviewGroup[];
  contents: PackContents;
  /** Files deselected in a previous review of this pack (re-review keeps them off). */
  priorExcludes: string[];
}

/** `sounds/music/x.vsnd_c` → `x` (display name). */
function fileStem(path: string): string {
  const f = path.split("/").pop() ?? path;
  return f.replace(/(\.vsnd_c|\.vsnd|_c)$/i, "").replace(/\.[a-z0-9]+$/i, (m) => m);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The bundled-file categories, in display order. */
function fileSections(c: PackContents) {
  return [
    {
      key: "overwrites",
      title: "Replaces original game sounds",
      color: "#f59e0b",
      files: c.overwrites,
      note: "Named exactly like the game's own files - they override the originals just by being bundled. Uncheck any you don't want replaced.",
    },
    {
      key: "ownSounds",
      title: "The pack's own sound files",
      color: "#38bdf8",
      files: c.ownSounds,
      note: "New audio the pack ships under its own paths. The sound events above play these - unchecking one silences whatever uses it.",
    },
    { key: "models", title: "Models", color: "#a78bfa", files: c.models, note: "Model/skin replacements." },
    { key: "particles", title: "Particles (VFX)", color: "#f472b6", files: c.particles, note: "Particle-effect replacements." },
    { key: "materials", title: "Materials & textures", color: "#fb7185", files: c.materials, note: "Texture/material replacements." },
    { key: "panorama", title: "UI / Panorama", color: "#facc15", files: c.panorama, note: "Menu and HUD file replacements." },
    { key: "other", title: "Other files", color: "#71717a", files: c.other, note: "Everything else the pack bundles." },
  ].filter((s) => s.files.length > 0);
}

const FILES_PER_FOLDER_CAP = 300;

/** One bundled-file category: folder-grouped checkbox tree. (Also reused by
 *  the pre-compile Build Preview.) */
export function FileSection({
  title,
  color,
  files,
  note,
  selected,
  onSet,
}: {
  title: string;
  color: string;
  files: string[];
  note: string;
  selected: Set<string>;
  onSet: (paths: string[], on: boolean) => void;
}) {
  const folders = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const f of files) {
      const d = dirname(f);
      const list = by.get(d) ?? [];
      list.push(f);
      by.set(d, list);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const on = files.filter((f) => selected.has(f)).length;
  const allOn = on === files.length;

  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={allOn}
          ref={(el) => {
            if (el) el.indeterminate = on > 0 && !allOn;
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSet(files, e.target.checked)}
          className="accent-emerald-500"
        />
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="font-medium text-zinc-200">{title}</span>
        <span className="text-zinc-600">
          {on}/{files.length} included
        </span>
      </summary>
      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{note}</p>
      <div className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {folders.map(([dir, fs]) => {
          const dirOn = fs.filter((f) => selected.has(f)).length;
          const dirAll = dirOn === fs.length;
          return (
            <details key={dir || "(root)"} className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-1">
              <summary className="flex cursor-pointer items-center gap-2 text-[11px]">
                <input
                  type="checkbox"
                  checked={dirAll}
                  ref={(el) => {
                    if (el) el.indeterminate = dirOn > 0 && !dirAll;
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onSet(fs, e.target.checked)}
                  className="accent-emerald-500"
                />
                <span className="truncate font-mono text-zinc-400" title={dir}>
                  {dir || "(root)"}
                </span>
                <span className="ml-auto shrink-0 text-zinc-600">
                  {dirOn}/{fs.length}
                </span>
              </summary>
              <div className="mt-1 flex flex-col">
                {fs.slice(0, FILES_PER_FOLDER_CAP).map((f) => (
                  <label key={f} className="flex cursor-pointer items-center gap-2 py-px pl-5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={selected.has(f)}
                      onChange={(e) => onSet([f], e.target.checked)}
                      className="accent-emerald-500"
                    />
                    <span
                      className={`truncate font-mono ${selected.has(f) ? "text-zinc-300" : "text-zinc-600 line-through"}`}
                      title={f}
                    >
                      {fileStem(f)}
                    </span>
                  </label>
                ))}
                {fs.length > FILES_PER_FOLDER_CAP && (
                  <span className="pl-5 text-[10px] text-zinc-600">
                    …and {fs.length - FILES_PER_FOLDER_CAP} more (use the folder checkbox to toggle all)
                  </span>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}

/**
 * Import review: shows everything a mod pack contains before anything touches
 * the project — a composition bar, per-tab groups of checkable sound events,
 * and a folder-grouped browser of every bundled file (originals it replaces,
 * models, VFX, …) where anything can be deselected.
 */
export function ImportReview({
  review,
  onCancel,
  onConfirm,
}: {
  review: PackReview;
  onCancel: () => void;
  /** `selected` = event keys to break out; `excludedFiles` = bundled files to
   *  drop; `mode` = keep entries linked to the pack vs. convert them into the
   *  user's own editable tracks; `zeroGain` = converted tracks keep the mod's
   *  original loudness (0 dB) instead of the default +6 dB boost. */
  onConfirm: (
    selected: Set<string>,
    bundle: boolean,
    excludedFiles: string[],
    mode: "linked" | "absorb",
    zeroGain: boolean,
  ) => void;
}) {
  const allEventKeys = useMemo(
    () => review.groups.flatMap((g) => g.events.map((e) => e.key)),
    [review],
  );
  const sections = useMemo(() => fileSections(review.contents), [review]);
  const allFiles = useMemo(() => sections.flatMap((s) => s.files), [sections]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(allEventKeys));
  const [fileSel, setFileSel] = useState<Set<string>>(() => {
    const prior = new Set(review.priorExcludes);
    return new Set(allFiles.filter((f) => !prior.has(f)));
  });
  const [bundle, setBundle] = useState(true);
  const [mode, setMode] = useState<"linked" | "absorb">("linked");
  const [zeroGain, setZeroGain] = useState(false);

  const segs = useMemo(
    () =>
      [
        { label: "Sound events", n: allEventKeys.length, color: "#34d399" },
        ...sections.map((s) => ({ label: s.title, n: s.files.length, color: s.color })),
      ].filter((s) => s.n > 0),
    [allEventKeys, sections],
  );
  const segTotal = segs.reduce((n, s) => n + s.n, 0);

  const toggleEvent = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleGroup = (g: ReviewGroup) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = g.events.every((e) => next.has(e.key));
      for (const e of g.events) {
        if (allOn) next.delete(e.key);
        else next.add(e.key);
      }
      return next;
    });

  const setFiles = (paths: string[], on: boolean) =>
    setFileSel((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const excludedCount = allFiles.length - fileSel.size;
  const totalEvents = allEventKeys.length;

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
          <h3 className="text-base font-bold text-zinc-100">Import “{review.name}”</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Pick what to bring in - nothing is added until you confirm.
          </p>

          {/* Composition bar: what the pack is made of. */}
          {segTotal > 0 && (
            <>
              <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-900">
                {segs.map((s) => (
                  <div
                    key={s.label}
                    title={`${s.label}: ${s.n}`}
                    style={{ width: `${(s.n / segTotal) * 100}%`, backgroundColor: s.color }}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {segs.map((s) => (
                  <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.label} <span className="text-zinc-600">{s.n}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* Editable sound events, grouped by destination tab. */}
          {review.groups.length > 0 ? (
            <div className="flex flex-col gap-4">
              {review.groups.map((g) => {
                const on = g.events.filter((e) => selected.has(e.key)).length;
                return (
                  <div key={g.group}>
                    <button
                      onClick={() => toggleGroup(g)}
                      className="mb-1.5 flex w-full items-center gap-2 text-left"
                      title="Toggle the whole group"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.accent }} />
                      <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                        {g.label}
                      </span>
                      <span className="text-[11px] text-zinc-600">
                        {on}/{g.events.length} selected
                      </span>
                    </button>
                    <div className="flex flex-col gap-1">
                      {g.events.map((e) => (
                        <label
                          key={e.key}
                          className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-1.5 text-xs transition ${
                            selected.has(e.key)
                              ? "border-zinc-700 bg-zinc-900/70 text-zinc-200"
                              : "border-zinc-800/60 bg-zinc-900/20 text-zinc-500"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selected.has(e.key)}
                              onChange={() => toggleEvent(e.key)}
                              className="accent-emerald-500"
                            />
                            <span className="truncate font-medium">{e.label}</span>
                            <span className="truncate text-[10px] text-zinc-600">{e.eventName}</span>
                          </span>
                          <span className="ml-2 flex shrink-0 items-center gap-2">
                            {e.overwrite && (
                              <span
                                title="This pack replaces the original file by name. Importing converts its audio into your own track and adds it to the event's array - the original stays and can be toggled."
                                className="rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-300"
                              >
                                replaces original
                              </span>
                            )}
                            {e.foldsIntoExisting && (
                              <span className="rounded bg-violet-500/15 px-1.5 text-[10px] text-violet-300">
                                folds into yours
                              </span>
                            )}
                            <span className="rounded bg-emerald-500/10 px-1.5 text-[10px] text-emerald-300">
                              {e.trackCount} track{e.trackCount === 1 ? "" : "s"}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">
              No editable sound events found - this pack works by replacing files directly (see below).
            </p>
          )}

          {/* Everything the bundle ships, browsable + deselectable per file. */}
          {sections.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                  Bundled files
                </span>
                <span className="text-[11px] text-zinc-600">
                  {fileSel.size}/{allFiles.length} included
                  {excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {sections.map((s) => (
                  <FileSection
                    key={s.key}
                    title={s.title}
                    color={s.color}
                    files={s.files}
                    note={s.note}
                    selected={fileSel}
                    onSet={setFiles}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="border-t border-zinc-800 p-5 pt-4">
          {/* How the selected sound events come in. */}
          {allEventKeys.length > 0 && (
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === "linked"}
                  onChange={() => setMode("linked")}
                  className="mt-0.5 accent-violet-500"
                />
                <span className="text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">Keep linked to the pack</span>
                  <span className="text-zinc-600">
                    {" "}
                    - tracks show a “{review.name.replace(/\.vpk$/i, "")}” tag so you always know
                    where they came from; audio comes from the pack. (“replaces original” tracks
                    are always converted into your own - they have no event entry to link.)
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === "absorb"}
                  onChange={() => setMode("absorb")}
                  className="mt-0.5 accent-violet-500"
                />
                <span className="text-xs text-zinc-400">
                  <span className="font-medium text-zinc-300">Make them my tracks</span>
                  <span className="text-zinc-600">
                    {" "}
                    - every selected sound is converted into your own editable track
                    (trim/gain/rename, compiled by you), as if you'd added the audio yourself.
                  </span>
                </span>
              </label>
            </div>
          )}
          {allEventKeys.length > 0 && (
            <label className="mb-1.5 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={zeroGain}
                onChange={(e) => setZeroGain(e.target.checked)}
                className="mt-0.5 accent-emerald-500"
              />
              <span className="text-xs text-zinc-400">
                Keep the mod's original volume (0 dB gain)
                <span className="text-zinc-600">
                  {" "}
                  - converted tracks come in as-is; unchecked adds the usual +6 dB boost new
                  tracks get.
                </span>
              </span>
            </label>
          )}
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={bundle}
              onChange={(e) => setBundle(e.target.checked)}
              className="mt-0.5 accent-emerald-500"
            />
            <span className="text-xs text-zinc-400">
              Bundle the included files on compile
              <span className="text-zinc-600">
                {" "}
                - they ride along in your <span className="font-mono">combined/</span> build.
                Unchecked files above are left out.
                {mode === "absorb" ? " Sounds you absorb are dropped from the bundle automatically." : ""}
              </span>
            </span>
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                onConfirm(selected, bundle, allFiles.filter((f) => !fileSel.has(f)), mode, zeroGain)
              }
              disabled={selected.size === 0 && !bundle}
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              Import {selected.size > 0 ? `${selected.size} of ${totalEvents} event${totalEvents === 1 ? "" : "s"}` : "bundle only"}
              {excludedCount > 0 ? ` (−${excludedCount} files)` : ""}
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}
