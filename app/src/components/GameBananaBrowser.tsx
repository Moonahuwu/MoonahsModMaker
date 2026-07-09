import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";
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
export function GameBananaBrowser({
  settings,
  update,
  onImportPack,
  onBundleMany,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Open the import review for a downloaded vpk. */
  onImportPack: (vpk: string) => void;
  /** A download held several vpks: add them all to the bundle list. */
  onBundleMany: (vpks: string[]) => void;
}) {
  const { push } = useToast();
  const [query, setQuery] = useState("");
  // The query the current results belong to (typing doesn't re-search).
  const [activeQuery, setActiveQuery] = useState("");
  const [items, setItems] = useState<GbSearchItem[]>([]);
  const [page, setPage] = useState(1);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMature, setShowMature] = useState(false);
  // Per-mod expanded file list (multi-file pages) + busy state.
  const [filesFor, setFilesFor] = useState<{ modId: number; files: GbFile[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function load(q: string, p: number, append: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await gamebananaSearch(q, p);
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

  // First open: show the game's feed.
  useEffect(() => {
    void load("", 1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getMod(item: GbSearchItem) {
    setBusy(item.modId);
    setFilesFor(null);
    try {
      const files = await gamebananaFiles(item.modId);
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
      const res = await gamebananaDownload(item.modId, file.downloadUrl, file.name);
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

  const visible = items.filter((i) => showMature || !i.nsfw);
  const hiddenCount = items.length - visible.length;

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

      <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-500">
        <label className="flex cursor-pointer items-center gap-1.5">
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
              key={`${item.modId}-${activeQuery}`}
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
                  <button
                    onClick={() => void getMod(item)}
                    disabled={busy === item.modId}
                    className="shrink-0 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {busy === item.modId ? "…" : "Get"}
                  </button>
                </div>
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
