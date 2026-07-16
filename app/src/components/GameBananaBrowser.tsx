import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { StockWaveform } from "./StockWaveform";
import {
  gamebananaDownload,
  gamebananaFiles,
  gamebananaSearch,
  libraryAdd,
  type GbFile,
  type GbSearchItem,
} from "../lib/api";
import type { Settings } from "../lib/settings";
import type { LibraryItem } from "../types";
import { useToast } from "./Toaster";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * Browse Deadlock mods on GameBanana and pull one straight into the build:
 * the download goes through GameBanana's own URL (so the author gets the
 * download count), the vpk inside lands in the normal import review, and the
 * page's credits attach automatically.
 */
const SORTS: { key: string; label: string }[] = [
  { key: "relevance", label: "Featured" },
  { key: "downloads", label: "Most downloaded" },
  { key: "likes", label: "Most liked" },
  { key: "new", label: "Newest" },
];

export function GameBananaBrowser({
  update,
  onImportPack,
  seed,
  onSeedConsumed,
  onAddToSlot,
  onBack,
}: {
  update: (patch: Partial<Settings> | ((prev: Settings) => Partial<Settings>)) => void;
  /** Open the import review for downloaded vpk(s) - several queue up and
   *  review one at a time. */
  onImportPack: (vpk: string | string[]) => void;
  /** A slot's "Find on GameBanana" jump: search this immediately on open.
   *  `sounds` locks the browser to the Sound submission type; `slotId` puts
   *  the browser in slot mode - Get extracts the pack's audio straight into
   *  that slot instead of bundling the vpk. */
  seed?: { query: string; sounds: boolean; slotId?: string; slotLabel?: string } | null;
  onSeedConsumed?: () => void;
  /** Slot mode: extract these downloaded vpks' sounds into the slot; loose
   *  audio files (Sound submissions) add straight in as tracks. */
  onAddToSlot?: (slotId: string, vpks: string[], modName: string, audios: string[]) => void;
  /** Return to the slot this screen was opened from (no sidebar tab). */
  onBack?: () => void;
}) {
  const { push } = useToast();
  const [query, setQuery] = useState("");
  // The query the current results belong to (typing doesn't re-search).
  const [activeQuery, setActiveQuery] = useState("");
  const [sort, setSort] = useState("relevance");
  // GameBanana submission type: sound mods are their own section on the site.
  const [model, setModel] = useState<"Mod" | "Sound">("Mod");
  const [items, setItems] = useState<GbSearchItem[]>([]);
  const [page, setPage] = useState(1);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMature, setShowMature] = useState(false);
  // Per-mod expanded file list (multi-file pages) + busy state.
  const [filesFor, setFilesFor] = useState<{ modId: number; files: GbFile[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // One open audio preview at a time (sound submissions host a preview MP3).
  const [previewFor, setPreviewFor] = useState<number | null>(null);
  // Slot mode: Get extracts the pack's sounds into this slot (no bundling).
  const [targetSlot, setTargetSlot] = useState<{ id: string; label: string } | null>(null);

  // A newer request always wins: without this, a slow earlier search can
  // resolve late and stomp the results the user is actually looking at.
  const reqSeq = useRef(0);

  // Infinite scroll: a sentinel under the grid loads the next page as it
  // nears the viewport (600px ahead, so the seam is rarely visible). The
  // callback rides a ref so the one observer always sees fresh state.
  const moreRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (!complete && !loading) void load(activeQuery, page + 1, true);
  };
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  async function load(q: string, p: number, append: boolean, s = sort, m = model) {
    const req = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await gamebananaSearch(q, p, s, m);
      if (req !== reqSeq.current) return;
      setItems((prev) => {
        if (!append) return res.items;
        // The site's ranking can shift between pages - drop repeats.
        const seen = new Set(prev.map((i) => `${i.model}:${i.modId}`));
        return [...prev, ...res.items.filter((i) => !seen.has(`${i.model}:${i.modId}`))];
      });
      setComplete(res.isComplete);
      setPage(p);
      setActiveQuery(q);
      if (!append) setPreviewFor(null);
    } catch (e) {
      if (req === reqSeq.current) setError(String(e));
    } finally {
      if (req === reqSeq.current) setLoading(false);
    }
  }

  // First open with nothing pending: show the game's feed. (A pending seed is
  // handled by the effect below, which also runs on mount.)
  useEffect(() => {
    if (!seed) void load("", 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A slot's "Find on GameBanana" jump - on mount, or while already open.
  // Sound slots search the Sound section only ("just sounds, nothing else").
  useEffect(() => {
    if (!seed) return;
    const m = seed.sounds ? "Sound" : "Mod";
    setModel(m);
    setQuery(seed.query);
    setTargetSlot(seed.slotId ? { id: seed.slotId, label: seed.slotLabel ?? "the slot" } : null);
    void load(seed.query, 1, false, sort, m);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  async function getMod(item: GbSearchItem) {
    setBusy(item.modId);
    setFilesFor(null);
    try {
      const files = await gamebananaFiles(item.modId, item.model);
      if (files.length === 0) {
        push("error", "That page has no downloadable files");
        return;
      }
      if (files.length === 1) {
        await download(item, files[0]);
      } else {
        setFilesFor({ modId: item.modId, files });
      }
    } catch (e) {
      push("error", `${e}`);
    } finally {
      setBusy((b) => (b === item.modId ? null : b));
    }
  }

  async function download(item: GbSearchItem, file: GbFile) {
    setBusy(item.modId);
    setFilesFor(null);
    push("info", `Downloading "${item.name}"…`);
    try {
      const res = await gamebananaDownload(item.modId, file.downloadUrl, file.name, item.model);
      // Credits attach to every vpk from this page - the whole point. Slot
      // mode keeps them too: if the picker's "Install the whole mod" bundles
      // the vpk later, the attribution must already be there.
      update((prev) => {
        const credits = { ...(prev.importedModCredits ?? {}) };
        for (const v of res.vpks) credits[v] = res.info;
        return { importedModCredits: credits };
      });
      // Slot mode: the user wants the mp3s, not the pack - the sounds inside
      // extract straight into the slot they came from (packs that change more
      // than that slot open a picker on the other side).
      if (targetSlot && onAddToSlot) {
        onAddToSlot(targetSlot.id, res.vpks, item.name, res.audios);
        return;
      }
      // A Sound submission with no pak, just audio (bare mp3/wav or a zip of
      // them): copy the files into the Sound Library so they're durable, then
      // point the user there.
      if (res.vpks.length === 0) {
        const added: LibraryItem[] = [];
        for (const a of res.audios) {
          try {
            const copy = await libraryAdd(a);
            added.push({
              id: crypto.randomUUID(),
              name: copy.name,
              path: copy.path,
              source: item.name,
              addedAt: new Date().toISOString(),
            });
          } catch (e) {
            push("error", `${a.split(/[\\/]/).pop()}: ${e}`);
          }
        }
        if (added.length > 0) {
          update((prev) => ({ soundLibrary: [...(prev.soundLibrary ?? []), ...added] }));
          push(
            "success",
            `Added ${added.length} sound${added.length > 1 ? "s" : ""} from "${item.name}" to your Sound Library - Copy one there and paste it into a slot`,
          );
        }
        return;
      }
      // One vpk or several - the review queue handles both.
      onImportPack(res.vpks.length === 1 ? res.vpks[0] : res.vpks);
    } catch (e) {
      push("error", `${e}`);
    } finally {
      setBusy((b) => (b === item.modId ? null : b));
    }
  }

  // Multi-select (bundle mode only): check several mods, then one "Get all"
  // downloads them in turn and their import reviews queue one after another.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const selKey = (i: GbSearchItem) => `${i.model}:${i.modId}`;
  const toggleSel = (i: GbSearchItem) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(selKey(i))) next.delete(selKey(i));
      else next.add(selKey(i));
      return next;
    });

  async function getSelected() {
    const picked = items.filter((i) => sel.has(selKey(i)));
    if (picked.length === 0) return;
    setBulkBusy(true);
    const vpks: string[] = [];
    const shelved: LibraryItem[] = [];
    let failed = 0;
    for (const [n, item] of picked.entries()) {
      push("info", `Downloading "${item.name}" (${n + 1}/${picked.length})…`);
      try {
        const files = await gamebananaFiles(item.modId, item.model);
        if (files.length === 0) {
          push("error", `"${item.name}" has no downloadable files`);
          failed++;
          continue;
        }
        // Multi-file pages: take the most-downloaded file (the page's main
        // release in practice) - Get a page individually to pick another.
        const file = [...files].sort((a, b) => b.downloadCount - a.downloadCount)[0];
        const res = await gamebananaDownload(item.modId, file.downloadUrl, file.name, item.model);
        update((prev) => {
          const credits = { ...(prev.importedModCredits ?? {}) };
          for (const v of res.vpks) credits[v] = res.info;
          return { importedModCredits: credits };
        });
        vpks.push(...res.vpks);
        if (res.vpks.length === 0) {
          for (const a of res.audios) {
            try {
              const copy = await libraryAdd(a);
              shelved.push({
                id: crypto.randomUUID(),
                name: copy.name,
                path: copy.path,
                source: item.name,
                addedAt: new Date().toISOString(),
              });
            } catch (e) {
              push("error", `${a.split(/[\\/]/).pop()}: ${e}`);
            }
          }
        }
      } catch (e) {
        push("error", `"${item.name}": ${e}`);
        failed++;
      }
    }
    if (shelved.length > 0) {
      update((prev) => ({ soundLibrary: [...(prev.soundLibrary ?? []), ...shelved] }));
      push("success", `${shelved.length} loose sound(s) went to your Sound Library`);
    }
    setSel(new Set());
    setBulkBusy(false);
    if (vpks.length > 0) onImportPack(vpks);
    else if (failed === picked.length) push("error", "Nothing downloaded - see the errors above");
  }

  // While searching, "Most liked" re-sorts the loaded results exactly (the
  // endpoint only offers a popularity order); browse feeds come pre-sorted.
  const visible = (() => {
    const v = items.filter((i) => showMature || !i.nsfw);
    return activeQuery && sort === "likes" ? [...v].sort((a, b) => b.likes - a.likes) : v;
  })();
  const hiddenCount = items.filter((i) => !showMature && i.nsfw).length;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            ← Back
          </button>
        )}
        <h3 className="text-sm font-semibold text-zinc-200">Browse GameBanana</h3>
        <span className="ml-auto text-[11px] text-zinc-600">
          downloads count on the author's page
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Search Deadlock mods and pull one straight into your build - the vpk opens in the
        normal import review, and the page's author + credits attach automatically for
        your credits list.
      </p>
      {targetSlot && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-300">
          <span>
            Get extracts a pack's sounds straight into <b>{targetSlot.label}</b> as tracks
            - mods that change more than this slot open a picker first.
          </span>
          <button
            onClick={() => setTargetSlot(null)}
            title="Switch to normal mode (bundle the whole vpk instead)"
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-emerald-400/70 transition hover:bg-emerald-500/15 hover:text-emerald-200"
          >
            ✕
          </button>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load(query, 1, false)}
          placeholder="Search mods: music, urn, jumpscare, a hero's name…"
          spellCheck={false}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-yellow-500/70"
        />
        <button
          onClick={() => void load(query, 1, false)}
          disabled={loading}
          className="rounded-md bg-yellow-600/90 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-yellow-500 disabled:opacity-50"
        >
          Search
        </button>
        {activeQuery && (
          <button
            onClick={() => {
              setQuery("");
              void load("", 1, false);
            }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-white"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-500">
        <div className="flex items-center overflow-hidden rounded-md border border-zinc-700">
          {(["Mod", "Sound"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                if (m === model) return;
                setModel(m);
                void load(activeQuery, 1, false, sort, m);
              }}
              title={
                m === "Sound"
                  ? "GameBanana's dedicated sound-mod section"
                  : "Everything: skins, HUDs, sounds…"
              }
              className={`px-2.5 py-0.5 transition ${
                model === m
                  ? "bg-yellow-500/15 font-medium text-yellow-300"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {m === "Mod" ? "Mods" : "Sounds"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" title="Order the results">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                setSort(s.key);
                void load(activeQuery, 1, false, s.key);
              }}
              title={
                activeQuery && s.key === "downloads"
                  ? "While searching, the site offers popularity order (closest to downloads)"
                  : undefined
              }
              className={`rounded px-2 py-0.5 transition ${
                sort === s.key
                  ? "bg-yellow-500/15 text-yellow-300"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showMature}
            onChange={(e) => setShowMature(e.target.checked)}
            className="accent-yellow-500"
          />
          Show mature-rated mods
        </label>
        {hiddenCount > 0 && !showMature && <span>({hiddenCount} hidden)</span>}
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-400">
          Couldn't reach GameBanana: {error}
        </p>
      )}

      {sel.size > 0 && (
        <div className="sticky top-2 z-10 mt-3 flex items-center gap-3 rounded-lg border border-yellow-500/40 bg-zinc-950/95 px-3 py-2 text-xs shadow-lg">
          <span className="font-medium text-yellow-200">
            {sel.size} mod{sel.size === 1 ? "" : "s"} selected
          </span>
          <span className="hidden text-zinc-600 sm:inline">
            downloads run in turn, then the reviews open one at a time
          </span>
          <button
            onClick={() => setSel(new Set())}
            disabled={bulkBusy}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-zinc-400 transition hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            Clear
          </button>
          <button
            onClick={() => void getSelected()}
            disabled={bulkBusy}
            className="rounded-md bg-emerald-600 px-4 py-1 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {bulkBusy ? "Downloading…" : `Get all ${sel.size}`}
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <AnimatePresence initial={false}>
          {visible.map((item) => (
            <motion.div
              key={`${item.model}-${item.modId}-${activeQuery}`}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className={`relative flex flex-col overflow-hidden rounded-lg border bg-zinc-950/40 transition ${
                sel.has(selKey(item))
                  ? "border-yellow-500/60"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              {!targetSlot && (
                <label
                  title="Select for a bulk Get"
                  className="absolute left-1.5 top-1.5 z-10 flex cursor-pointer items-center rounded bg-zinc-950/80 p-1 backdrop-blur-sm"
                >
                  <input
                    type="checkbox"
                    checked={sel.has(selKey(item))}
                    onChange={() => toggleSel(item)}
                    className="accent-yellow-500"
                  />
                </label>
              )}
              <button
                onClick={() => void openUrl(item.pageUrl)}
                title={`Open the GameBanana page\n${item.pageUrl}`}
                className="block aspect-[16/9] w-full overflow-hidden bg-zinc-900"
              >
                {item.thumbUrl ? (
                  <img
                    src={item.thumbUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                ) : (
                  <span className="flex h-full items-center justify-center text-[10px] text-zinc-700">
                    no preview
                  </span>
                )}
              </button>
              <div className="flex min-h-0 flex-1 flex-col gap-1 p-2.5">
                <span className="truncate text-xs font-medium text-zinc-200" title={item.name}>
                  {item.name}
                </span>
                <span className="truncate text-[11px] text-zinc-500">
                  by {item.author || "unknown"}
                </span>
                <div className="mt-auto flex items-center gap-2 pt-1.5">
                  {item.category && (
                    <span
                      className="truncate rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400"
                      title={item.category}
                    >
                      {item.category}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-600">
                    ♥ {fmtCount(item.likes)}
                  </span>
                  {item.audioUrl && (
                    <button
                      onClick={() =>
                        setPreviewFor((p) => (p === item.modId ? null : item.modId))
                      }
                      title="Listen before you install"
                      className={`shrink-0 rounded border px-2 py-1 text-[11px] transition ${
                        previewFor === item.modId
                          ? "border-yellow-500/60 text-yellow-300"
                          : "border-zinc-700 text-zinc-300 hover:border-yellow-500/60 hover:text-yellow-300"
                      }`}
                    >
                      {previewFor === item.modId ? "✕" : "▶"}
                    </button>
                  )}
                  <button
                    onClick={() => void getMod(item)}
                    disabled={busy === item.modId}
                    className="shrink-0 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {busy === item.modId ? "…" : "Get"}
                  </button>
                </div>
                {previewFor === item.modId && item.audioUrl && (
                  <div className="mt-1.5 border-t border-zinc-800 pt-1.5">
                    <StockWaveform url={item.audioUrl} accent="#eab308" autoplay />
                  </div>
                )}
                {filesFor?.modId === item.modId && (
                  <div className="mt-1.5 flex flex-col gap-1 border-t border-zinc-800 pt-1.5">
                    <span className="text-[10px] text-zinc-500">Which file?</span>
                    {filesFor.files.map((f) => (
                      <button
                        key={f.downloadUrl}
                        onClick={() => void download(item, f)}
                        title={f.description || f.name}
                        className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-left text-[11px] text-zinc-300 transition hover:border-emerald-500/60"
                      >
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 tabular-nums text-zinc-600">
                          {fmtSize(f.size)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {loading && (
        <p className="mt-4 text-center text-xs text-zinc-500">Loading…</p>
      )}
      {!loading && visible.length === 0 && !error && (
        <p className="mt-4 text-center text-xs text-zinc-600">
          Nothing found{activeQuery ? ` for "${activeQuery}"` : ""}.
        </p>
      )}
      {/* Infinite scroll: the sentinel sits under the grid and pulls the next
          page as it approaches the viewport. The button stays as a fallback
          (and for keyboard users). */}
      <div ref={moreRef} className="mt-4 flex justify-center">
        {!complete && loading && items.length > 0 && (
          <span className="text-xs text-zinc-500">Loading more…</span>
        )}
        {!complete && !loading && (
          <button
            onClick={() => void load(activeQuery, page + 1, true)}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Load more
          </button>
        )}
      </div>
    </section>
  );
}
