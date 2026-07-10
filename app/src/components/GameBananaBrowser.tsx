import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { StockWaveform } from "./StockWaveform";
import {
  gamebananaDownload,
  gamebananaFiles,
  gamebananaSearch,
  type GbFile,
  type GbSearchItem,
} from "../lib/api";
import type { Settings } from "../lib/settings";
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
  settings,
  update,
  onImportPack,
  onBundleMany,
  seed,
  onSeedConsumed,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Open the import review for a downloaded vpk. */
  onImportPack: (vpk: string) => void;
  /** A download held several vpks: add them all to the bundle list. */
  onBundleMany: (vpks: string[]) => void;
  /** A slot's "Find on GameBanana" jump: search this immediately on open.
   *  `sounds` locks the browser to the Sound submission type. */
  seed?: { query: string; sounds: boolean } | null;
  onSeedConsumed?: () => void;
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

  async function load(q: string, p: number, append: boolean, s = sort, m = model) {
    setLoading(true);
    setError(null);
    try {
      const res = await gamebananaSearch(q, p, s, m);
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      setComplete(res.isComplete);
      setPage(p);
      setActiveQuery(q);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
      // Credits attach to every vpk from this page - the whole point.
      const credits = { ...(settings.importedModCredits ?? {}) };
      for (const v of res.vpks) credits[v] = res.info;
      update({ importedModCredits: credits });
      if (res.vpks.length === 1) {
        onImportPack(res.vpks[0]);
      } else {
        onBundleMany(res.vpks);
        push(
          "success",
          `Added ${res.vpks.length} vpks from "${item.name}" - review them in the Mod combiner`,
        );
      }
    } catch (e) {
      push("error", `${e}`);
    } finally {
      setBusy((b) => (b === item.modId ? null : b));
    }
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
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-200">Browse GameBanana</h3>
        <span className="text-[11px] text-zinc-600">
          downloads count on the author's page
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Search Deadlock mods and pull one straight into your build - the vpk opens in the
        normal import review, and the page's author + credits attach automatically for
        your credits list.
      </p>

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

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <AnimatePresence initial={false}>
          {visible.map((item) => (
            <motion.div
              key={`${item.model}-${item.modId}-${activeQuery}`}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/40 transition hover:border-zinc-600"
            >
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
      {!complete && !loading && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => void load(activeQuery, page + 1, true)}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Load more
          </button>
        </div>
      )}
    </section>
  );
}
