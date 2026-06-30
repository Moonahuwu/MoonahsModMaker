import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
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
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${tone} ${
        included ? "" : "opacity-45"
      }`}
    >
      <span
        className={`flex items-center gap-2 truncate font-medium ${included ? "" : "line-through"}`}
      >
        {name}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide opacity-70">{tag}</span>
        <button
          onClick={onPreview}
          title="Preview the original in-game track"
          className="rounded p-0.5 text-current opacity-70 transition hover:opacity-100"
        >
          {previewState === "loading" ? "…" : previewState === "playing" ? "⏸" : "▶"}
        </button>
        <button
          onClick={onDownload}
          title="Download a copy to your Downloads folder"
          className="rounded p-0.5 text-current opacity-70 transition hover:opacity-100"
        >
          ⤓
        </button>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Convert to an editable track (trim/gain/fade)"
            className="rounded p-0.5 text-current opacity-70 transition hover:opacity-100"
          >
            ✎
          </button>
        )}
        <Toggle on={included} onClick={onToggle} />
        <button
          onClick={onRemove}
          aria-label="Remove from pool"
          title="Remove from pool"
          className="rounded p-0.5 text-current opacity-50 transition hover:bg-red-950/40 hover:text-red-300 hover:opacity-100"
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
}) {
  const [stockUrl, setStockUrl] = useState<string | null>(null);
  const [stockErr, setStockErr] = useState<string | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  // Quick audio preview of any existing in-game entry (stock/foreign).
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const [loadingRef, setLoadingRef] = useState<string | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

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

  async function loadStock(open: boolean) {
    if (!open || stockUrl || stockLoading) return;
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
  const total =
    (!stockRemoved && stockOn ? 1 : 0) + foreignOn + adoptedOn + ev.songs.length;
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
        </div>
      </header>

      {/* Stock — toggleable + removable */}
      {!stockRemoved && (
        <div className="mb-2">
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
          />
        </div>
      )}

      {/* Other mods — toggleable + removable, collapsed by default */}
      {foreign.length > 0 && (
        <details className="mb-3 rounded-lg border border-zinc-800 bg-zinc-800/20 px-3 py-2">
          <summary className="cursor-pointer text-xs text-zinc-500">
            {foreign.length} track{foreign.length === 1 ? "" : "s"} from other mods
            <span className="text-zinc-600"> — toggle or remove ({foreignOn} on)</span>
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {foreign.map((e) => (
              <EntryRow
                key={e}
                name={shortName(e)}
                tag="other mod"
                tone="border-zinc-700 bg-zinc-800/40 text-zinc-300"
                included={!excluded.has(e)}
                previewState={previewStateOf(e)}
                onPreview={() => void previewEntry(e)}
                onToggle={() => onToggleEntry(ev.id, e)}
                onRemove={() => onRemoveEntry(ev.id, e)}
                onDownload={() => onDownloadEntry(e)}
              />
            ))}
          </div>
        </details>
      )}

      {/* Adopted from other mods (part of your project) */}
      {adoptedShown.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-violet-300/80">
            Adopted from mods
          </div>
          <div className="flex flex-col gap-1.5">
            {adoptedShown.map((a) => (
              <EntryRow
                key={a.reference}
                name={a.label}
                tag="adopted"
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
        </div>
      )}

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
        className={`mt-3 rounded-xl border border-dashed py-6 text-center text-xs ${
          dropActive ? "text-emerald-300" : "text-zinc-600"
        }`}
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
