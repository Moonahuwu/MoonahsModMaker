import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EventProject, EventView, Song } from "../types";
import { SongCard } from "./SongCard";

/** One reorderable song row: drags only via the handle passed to its children. */
function DraggableSong({
  song,
  children,
}: {
  song: Song;
  children: (handle: ReactNode) => ReactNode;
}) {
  const controls = useDragControls();
  const handle = (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        controls.start(e);
      }}
      aria-label="Drag to reorder"
      title="Drag to reorder"
      className="shrink-0 cursor-grab touch-none rounded p-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-zinc-300 active:cursor-grabbing"
    >
      ⠿
    </button>
  );
  return (
    <Reorder.Item
      value={song}
      dragListener={false}
      dragControls={controls}
      layout
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, height: 0, marginTop: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
    >
      {children(handle)}
    </Reorder.Item>
  );
}

function ownedRefsFor(ev: EventProject, soundFolder: string): Set<string> {
  const set = new Set<string>(ev.previousOwnedNames);
  for (const s of ev.songs) set.add(`${soundFolder}/${s.soundName}.vsnd`);
  return set;
}

function shortName(ref: string): string {
  const file = ref.split("/").pop() ?? ref;
  return file.replace(/\.vsnd$/, "");
}

function StatBadge({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {n} {label}
    </span>
  );
}

/** Friendly source-mod name for an adopted entry's tag: the vpk's file stem
 *  (or its parent folder for a generic pakNN_dir.vpk), with an app cache dir's
 *  `_hash` suffix stripped. */
function modName(vpk: string): string {
  const parts = vpk.replace(/\\/g, "/").split("/");
  const file = parts.pop() ?? vpk;
  const stem = file.replace(/\.vpk$/i, "").replace(/_[0-9a-f]{8}$/i, "");
  return /^pak\d+_dir$/i.test(stem) ? (parts.pop() ?? stem) : stem;
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onClick}
      title={on ? "Enabled — click to disable" : "Disabled — click to enable"}
      className={`relative h-4 w-7 shrink-0 rounded-full transition ${
        on ? "bg-emerald-500/70" : "bg-zinc-700"
      }`}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        className="absolute top-0.5 h-3 w-3 rounded-full bg-white"
        style={{ left: on ? 14 : 2 }}
      />
    </button>
  );
}

function EntryRow({
  name,
  tag,
  tone,
  included,
  previewState,
  onPreview,
  onToggle,
  onRemove,
  onEdit,
  onDownload,
  unplayable,
}: {
  name: string;
  tag: string;
  tone: string;
  included: boolean;
  previewState: "idle" | "loading" | "playing";
  onPreview: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onEdit?: () => void;
  onDownload: () => void;
  /** The ref is a placeholder (null.vsnd) or a file the game doesn't ship —
   *  previewing would play a beep/wrong clip, so offer no preview at all. */
  unplayable?: boolean;
}) {
  return (
    <div
      className={`group flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm transition ${tone} ${
        included ? "" : "opacity-45"
      }`}
    >
      <span
        className={`flex items-center gap-2 truncate font-medium ${included ? "" : "line-through"}`}
      >
        {name}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide opacity-60">{tag}</span>
        {unplayable ? (
          <span
            title="This event has no real stock audio (a placeholder or missing file) — nothing to preview. Your own tracks still work."
            className="rounded bg-zinc-800/70 px-1.5 text-[10px] uppercase tracking-wide text-zinc-500"
          >
            no sound
          </span>
        ) : (
          <>
            <button
              onClick={onPreview}
              title="Preview the original in-game track"
              className="rounded p-0.5 text-current opacity-70 transition hover:opacity-100"
            >
              {previewState === "loading" ? "…" : previewState === "playing" ? "⏸" : "▶"}
            </button>
            {/* Secondary actions surface on hover to keep rows calm. */}
            <button
              onClick={onDownload}
              title="Download a copy to your Downloads folder"
              className="rounded p-0.5 text-current opacity-0 transition group-hover:opacity-70 hover:!opacity-100 focus:opacity-100"
            >
              ⤓
            </button>
          </>
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            title="Convert to an editable track (trim/gain/fade)"
            className="rounded p-0.5 text-current opacity-0 transition group-hover:opacity-70 hover:!opacity-100 focus:opacity-100"
          >
            ✎
          </button>
        )}
        <Toggle on={included} onClick={onToggle} />
        <button
          onClick={onRemove}
          aria-label="Remove from pool"
          title="Remove from pool"
          className="rounded p-0.5 text-current opacity-0 transition group-hover:opacity-50 hover:!opacity-100 hover:bg-red-950/40 hover:text-red-300 focus:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function SidePanel({
  ev,
  view,
  soundFolder,
  ffmpegPath,
  accent,
  compareByDefault,
  dropActive,
  panelRef,
  expandedSongs,
  onToggleSongExpanded,
  onSongChange,
  onSongRename,
  onSongRemove,
  onReorderSongs,
  onToggleEntry,
  onRemoveEntry,
  onRestoreEntry,
  onDecodeStock,
  onEditAdopted,
  onDownloadEntry,
  onDownloadSong,
  moveTargets,
  onMoveToTab,
  missingRefs,
}: {
  ev: EventProject;
  view: EventView | undefined;
  soundFolder: string;
  ffmpegPath?: string;
  accent: string;
  compareByDefault: boolean;
  dropActive: boolean;
  panelRef: (el: HTMLElement | null) => void;
  expandedSongs: Record<string, boolean>;
  onToggleSongExpanded: (songId: string) => void;
  onSongChange: (songId: string, patch: Partial<Song>) => void;
  onSongRename: (songId: string, raw: string) => void;
  onSongRemove: (songId: string) => void;
  onReorderSongs: (slotId: string, orderedIds: string[]) => void;
  onToggleEntry: (eventName: string, ref: string) => void;
  onRemoveEntry: (eventName: string, ref: string) => void;
  onRestoreEntry: (eventName: string, ref: string) => void;
  onDecodeStock: (ref: string, vpk?: string) => Promise<string>;
  onEditAdopted: (slotId: string, ref: string, vpk: string, label: string) => void;
  onDownloadEntry: (ref: string, vpk?: string) => void;
  onDownloadSong: (sourceMp3: string) => void;
  /** When set, a "move to tab" selector shows in the header (auto/import slots). */
  moveTargets?: { value: string; label: string }[];
  onMoveToTab?: (slotId: string, group: string) => void;
  /** Refs known to NOT exist as real files in the game pak (checked upstream). */
  missingRefs?: Set<string>;
}) {
  const [stockUrl, setStockUrl] = useState<string | null>(null);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  // Quick audio preview of any existing in-game entry (stock/foreign).
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const [loadingRef, setLoadingRef] = useState<string | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  // Detached Audio objects outlive the component — stop them on unmount
  // (tab switch, hero/item drill-out, slot removal).
  useEffect(() => () => previewAudio.current?.pause(), []);

  async function previewEntry(ref: string, vpk?: string) {
    if (previewRef === ref) {
      previewAudio.current?.pause();
      setPreviewRef(null);
      return;
    }
    previewAudio.current?.pause();
    setLoadingRef(ref);
    try {
      const url = await onDecodeStock(ref, vpk);
      const audio = new Audio(url);
      previewAudio.current = audio;
      audio.onended = () => setPreviewRef(null);
      audio.onerror = () => setPreviewRef(null);
      await audio.play();
      setPreviewRef(ref);
    } catch {
      /* decode/playback failed — ignore */
    } finally {
      setLoadingRef(null);
    }
  }

  const previewStateOf = (ref: string): "idle" | "loading" | "playing" =>
    loadingRef === ref ? "loading" : previewRef === ref ? "playing" : "idle";

  // Placeholder audio (null.vsnd / silence) or a ref the game doesn't ship —
  // decoding these "works" but plays a beep or a wrong clip, so treat them as
  // having no stock sound at all.
  const unplayableRef = (ref: string) =>
    !ref || /common\/null\.vsnd$|placeholder|util\/silence/i.test(ref) || !!missingRefs?.has(ref);

  async function loadStock(open: boolean) {
    if (!open || stockUrl || stockLoading) return;
    if (unplayableRef(ev.stockEntry)) {
      setStockErr("This event has no real stock sound (placeholder) — nothing to compare against.");
      return;
    }
    setStockLoading(true);
    setStockErr(null);
    try {
      setStockUrl(await onDecodeStock(ev.stockEntry));
    } catch (e) {
      setStockErr(String(e));
    } finally {
      setStockLoading(false);
    }
  }

  const owned = useMemo(() => ownedRefsFor(ev, soundFolder), [ev, soundFolder]);
  const excluded = useMemo(() => new Set(ev.excludedEntries), [ev.excludedEntries]);
  const removed = useMemo(() => new Set(ev.removedEntries), [ev.removedEntries]);

  const poolEntries = view?.entries ?? [];
  const foreignAll = poolEntries.filter((e) => e !== ev.stockEntry && !owned.has(e));
  const foreign = foreignAll.filter((e) => !removed.has(e));
  const stockRemoved = removed.has(ev.stockEntry);
  const adoptedShown = ev.adopted.filter((a) => !removed.has(a.reference));
  const adoptedOn = adoptedShown.filter((a) => !excluded.has(a.reference)).length;
  const removedList = [
    ...(stockRemoved ? [ev.stockEntry] : []),
    ...foreignAll.filter((e) => removed.has(e)),
    ...ev.adopted.filter((a) => removed.has(a.reference)).map((a) => a.reference),
  ];

  const stockOn = !excluded.has(ev.stockEntry);
  const foreignOn = foreign.filter((e) => !excluded.has(e)).length;
  // Every original entry currently in play (drives the "replace" checkbox).
  const originalRefs = [
    ...(ev.stockEntry && !stockRemoved ? [ev.stockEntry] : []),
    ...foreign,
  ];
  const total =
    (!!ev.stockEntry && !stockRemoved && stockOn ? 1 : 0) + foreignOn + adoptedOn + ev.songs.length;
  const sortedSongs = [...ev.songs].sort((a, b) => a.order - b.order);

  return (
    <motion.section
      ref={panelRef}
      animate={{ borderColor: dropActive ? "rgb(16 185 129)" : "rgb(39 39 42)" }}
      style={{
        background: `radial-gradient(120% 70% at 50% 0%, ${accent}26 0%, ${accent}0d 22%, rgba(0,0,0,0) 48%), rgba(24,24,27,0.45)`,
      }}
      className="flex-1 overflow-hidden rounded-2xl border p-5"
    >
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold" style={{ color: accent }}>
            {ev.side}
          </h2>
          <StatBadge n={total} label="in pool" tone="bg-zinc-800/80 text-zinc-400" />
        </div>
        <div className="flex items-center gap-1.5">
          {originalRefs.length > 0 && (
            <label
              title="Replace the original — mute the stock sound(s) so only your tracks play"
              className="mr-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500"
            >
              <span>replace</span>
              <Toggle
                on={originalRefs.every((r) => excluded.has(r))}
                onClick={() => {
                  const on = !originalRefs.every((r) => excluded.has(r));
                  for (const r of originalRefs) {
                    if (excluded.has(r) !== on) onToggleEntry(ev.id, r);
                  }
                }}
              />
            </label>
          )}
          {ev.songs.length > 0 && (
            <StatBadge
              n={ev.songs.length}
              label="yours"
              tone="bg-emerald-500/10 text-emerald-300"
            />
          )}
          {view?.vsndDuration != null && (
            <span className="text-[11px] text-zinc-500">
              {view.vsndDuration.toFixed(1)}s
            </span>
          )}
          {moveTargets && onMoveToTab && (
            <select
              value={ev.group}
              onChange={(e) => onMoveToTab(ev.id, e.target.value)}
              title="Move this event to another tab"
              className="rounded-md border border-zinc-700/70 bg-zinc-900/80 px-1.5 py-0.5 text-[11px] text-zinc-400 outline-none transition hover:border-zinc-500 hover:text-zinc-200"
            >
              {!moveTargets.some((t) => t.value === ev.group) && (
                <option value={ev.group}>{ev.group}</option>
              )}
              {moveTargets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {/* Every existing entry in ONE list: the game's originals (amber),
          other mods' additions (zinc) and adopted tracks (violet, tagged with
          their source mod). Secondary controls appear on hover. */}
      {(!!ev.stockEntry && !stockRemoved) || foreign.length > 0 || adoptedShown.length > 0 ? (
        <div className="mb-3 flex flex-col gap-1.5">
          {!!ev.stockEntry && !stockRemoved && (
            <EntryRow
              name={`★ ${shortName(ev.stockEntry)}`}
              tag="Valve original"
              tone="border-amber-500/30 bg-amber-500/[0.04] text-amber-200"
              included={stockOn}
              previewState={previewStateOf(ev.stockEntry)}
              onPreview={() => void previewEntry(ev.stockEntry)}
              onToggle={() => onToggleEntry(ev.id, ev.stockEntry)}
              onRemove={() => onRemoveEntry(ev.id, ev.stockEntry)}
              onDownload={() => onDownloadEntry(ev.stockEntry)}
              unplayable={unplayableRef(ev.stockEntry)}
            />
          )}
          {foreign.map((e) => {
            // In the game pak = an original unmodded track; otherwise it's an
            // entry some other mod spliced into the shared events file.
            const vanilla = !missingRefs?.has(e);
            return (
              <EntryRow
                key={e}
                name={vanilla ? `★ ${shortName(e)}` : shortName(e)}
                tag={vanilla ? "Valve original" : "other mod"}
                tone={
                  vanilla
                    ? "border-amber-500/30 bg-amber-500/[0.04] text-amber-200"
                    : "border-zinc-700 bg-zinc-800/40 text-zinc-300"
                }
                included={!excluded.has(e)}
                previewState={previewStateOf(e)}
                onPreview={() => void previewEntry(e)}
                onToggle={() => onToggleEntry(ev.id, e)}
                onRemove={() => onRemoveEntry(ev.id, e)}
                onDownload={() => onDownloadEntry(e)}
                unplayable={unplayableRef(e)}
              />
            );
          })}
          {adoptedShown.map((a) => (
            <EntryRow
              key={a.reference}
              name={a.label}
              tag={modName(a.sourceVpk)}
              tone="border-violet-500/40 bg-violet-500/[0.06] text-violet-200"
              included={!excluded.has(a.reference)}
              previewState={previewStateOf(a.reference)}
              onPreview={() => void previewEntry(a.reference, a.sourceVpk)}
              onToggle={() => onToggleEntry(ev.id, a.reference)}
              onRemove={() => onRemoveEntry(ev.id, a.reference)}
              onEdit={() => onEditAdopted(ev.id, a.reference, a.sourceVpk, a.label)}
              onDownload={() => onDownloadEntry(a.reference, a.sourceVpk)}
            />
          ))}
        </div>
      ) : null}

      {/* Removed entries — restore */}
      {removedList.length > 0 && (
        <details className="mb-3 rounded-lg border border-dashed border-zinc-800 px-3 py-2">
          <summary className="cursor-pointer text-xs text-zinc-600">
            {removedList.length} removed — click to restore
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {removedList.map((e) => (
              <button
                key={e}
                onClick={() => onRestoreEntry(ev.id, e)}
                className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 transition hover:text-zinc-300"
              >
                <span className="truncate line-through">{shortName(e)}</span>
                <span className="shrink-0 text-emerald-400">+ restore</span>
              </button>
            ))}
          </div>
        </details>
      )}

      {/* Your tracks — drag the handle to reorder */}
      <Reorder.Group
        axis="y"
        values={sortedSongs}
        onReorder={(next) => onReorderSongs(ev.id, next.map((s) => s.id))}
        className="flex flex-col gap-3"
      >
        <AnimatePresence initial={false}>
          {sortedSongs.map((s) => (
            <DraggableSong key={s.id} song={s}>
              {(handle) => (
                <SongCard
                  song={s}
                  soundFolder={soundFolder}
                  ffmpegPath={ffmpegPath}
                  handle={handle}
                  expanded={!!expandedSongs[s.id]}
                  onToggleExpanded={() => onToggleSongExpanded(s.id)}
                  onChange={(patch) => onSongChange(s.id, patch)}
                  onRename={(raw) => onSongRename(s.id, raw)}
                  onRemove={() => onSongRemove(s.id)}
                  onDownload={() => onDownloadSong(s.sourceMp3)}
                  accent={accent}
                  stockName={shortName(ev.stockEntry)}
                  stockUrl={stockUrl}
                  stockLoading={stockLoading}
                  stockErr={stockErr}
                  onLoadStock={() => void loadStock(true)}
                  compareDefault={compareByDefault}
                />
              )}
            </DraggableSong>
          ))}
        </AnimatePresence>
      </Reorder.Group>

      {/* Drop zone / empty state */}
      <motion.div
        animate={{
          borderColor: dropActive ? "rgb(16 185 129)" : "rgb(63 63 70)",
          backgroundColor: dropActive ? "rgba(16,185,129,0.06)" : "rgba(0,0,0,0)",
        }}
        className={`mt-3 rounded-xl border border-dashed text-center text-xs ${
          ev.songs.length === 0 ? "py-6" : "py-2.5"
        } ${dropActive ? "text-emerald-300" : "text-zinc-600"}`}
      >
        {ev.songs.length === 0 ? (
          <span>
            <span className="block text-sm text-zinc-400">No tracks yet</span>
            Drop an .mp3 here to add it to {ev.side}
          </span>
        ) : (
          <span>Drop another .mp3 to add to {ev.side}</span>
        )}
      </motion.div>
    </motion.section>
  );
}
