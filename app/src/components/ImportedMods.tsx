import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  decompileVpkAll,
  gamebananaDownload,
  gamebananaFiles,
  gamebananaModInfo,
  gamebananaSearch,
  libraryAdd,
  packScan,
  type GbFile,
  type GbSearchItem,
  type PackScan,
  type UiModVpk,
} from "../lib/api";
import { cListUiMods } from "../lib/dataCache";
import { buildCreditsText, isMadeByMe, MADE_BY_ME, type Settings } from "../lib/settings";
import type { DigimodConfig, LibraryItem, ModTextureOverride } from "../types";
import { useEscape } from "../lib/useEscape";
import { useToast } from "./Toaster";
import { ModRetexture } from "./ModRetexture";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Session caches: pack scans are keyed by the bundle's signature (overlap
 *  detection is pairwise, so any list change needs a fresh full scan), and
 *  GameBanana update checks are per pack path. */
const scanCache = new Map<string, Record<string, PackScan>>();
const updateCache = new Map<string, boolean>();

const KIND_LABELS: Record<string, string> = {
  sound: "Sound",
  model: "Models",
  vfx: "VFX",
  ui: "UI",
  texture: "Textures",
  config: "Config",
  other: "Other",
};
const KIND_ORDER = ["sound", "model", "vfx", "ui", "texture", "config", "other"];

/** Deterministic tile colors for gallery cards without a thumbnail. */
function hashHue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const tileBg = (s: string) => `hsl(${hashHue(s)} 35% 16%)`;
const tileFg = (s: string) => `hsl(${hashHue(s)} 60% 68%)`;
function initials(s: string): string {
  const words = s.replace(/[_-]+/g, " ").trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** A pasted GameBanana ref -> (model, id). Accepts full page URLs
 *  (gamebanana.com/mods/12345, /sounds/678) and bare mod ids. */
function parseGbLink(input: string): { model: string; id: number } | null {
  const url = input.match(/gamebanana\.com\/(mods|sounds)\/(\d+)/i);
  if (url) {
    return { model: url[1].toLowerCase() === "sounds" ? "Sound" : "Mod", id: Number(url[2]) };
  }
  if (/^\d+$/.test(input.trim())) return { model: "Mod", id: Number(input.trim()) };
  return null;
}

/** Turn a bundled vpk's filename into a GameBanana search guess. Generic pak
 *  names (pak01_dir, 600744_pak04_dir) carry nothing to search for -> "". */
function searchGuess(path: string): string {
  const stem = baseName(path).replace(/\.vpk$/i, "");
  if (/^(\d+_)?pak\d+_dir$/i.test(stem)) return "";
  return stem
    .replace(/(^|_)pak\d+_dir$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+\d+$/, "")
    .trim();
}

/** Search GameBanana (mods + sounds) and pick the page a bundled vpk came
 *  from - the no-link path to attribution. Rendered through a portal: fixed
 *  overlays pin to any transformed/filtered ancestor otherwise. */
function GbLinkPicker({
  vpkPath,
  busy,
  auto,
  onPick,
  onPasteUrl,
  onMine,
  onCancel,
}: {
  vpkPath: string;
  /** True while the parent fetches the picked page's credits. */
  busy: boolean;
  /** True when the picker opened itself right after an import. */
  auto?: boolean;
  onPick: (item: GbSearchItem) => void;
  /** Link via a pasted page URL instead of a search result. */
  onPasteUrl: (url: string) => void;
  /** Mark the pack as the user's own work (no page to link). */
  onMine: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(() => searchGuess(vpkPath));
  const [pasteUrl, setPasteUrl] = useState("");
  const [items, setItems] = useState<GbSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const reqSeq = useRef(0);
  useEscape(onCancel);

  async function search(q: string) {
    if (!q) return;
    const req = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      // Both submission types: Deadlock sound mods live in their own section.
      const [m, s] = await Promise.all([
        gamebananaSearch(q, 1, undefined, "Mod"),
        gamebananaSearch(q, 1, undefined, "Sound"),
      ]);
      if (req !== reqSeq.current) return;
      const out: GbSearchItem[] = [];
      for (let i = 0; i < Math.max(m.items.length, s.items.length); i++) {
        if (m.items[i]) out.push(m.items[i]);
        if (s.items[i]) out.push(s.items[i]);
      }
      setItems(out);
      setSearched(true);
    } catch (e) {
      if (req === reqSeq.current) setError(String(e));
    } finally {
      if (req === reqSeq.current) setLoading(false);
    }
  }

  // A meaningful filename guess searches right away; a generic pak name
  // waits for the user to type what the mod was called.
  useEffect(() => {
    void search(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-zinc-800 p-4">
          <h3 className="text-sm font-bold text-zinc-100">
            {auto ? "Who made this mod?" : "Find this mod on GameBanana"}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-zinc-600" title={vpkPath}>
            {baseName(vpkPath)}
            {auto ? " - just bundled without credits. Link its page, or mark it as yours." : ""}
          </p>
          <div className="mt-2.5 flex gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void search(query.trim())}
              placeholder="Type the mod's name…"
              autoFocus
              spellCheck={false}
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-500/70"
            />
            <button
              onClick={() => void search(query.trim())}
              disabled={loading || !query.trim()}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-emerald-500/70 hover:text-white disabled:opacity-40"
            >
              {loading ? "Searching…" : "Search"}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error && <p className="p-2 text-xs text-red-400">{error}</p>}
          {!error && items.length === 0 && (
            <p className="p-2 text-xs text-zinc-500">
              {loading
                ? "Searching GameBanana…"
                : searched
                  ? "No matches - try fewer or different words."
                  : "Search for the mod's name to find its page."}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {items.map((it) => (
              <div
                key={`${it.model}:${it.modId}`}
                className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2"
              >
                {it.thumbUrl ? (
                  <img
                    src={it.thumbUrl}
                    alt=""
                    className="h-11 w-16 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-11 w-16 shrink-0 rounded bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1">
                  <button
                    onClick={() => void openUrl(it.pageUrl)}
                    title={`Open the page in your browser\n${it.pageUrl}`}
                    className="block max-w-full truncate text-xs font-medium text-zinc-200 hover:text-emerald-300 hover:underline"
                  >
                    {it.name}
                  </button>
                  <p className="truncate text-[11px] text-zinc-500">
                    by {it.author || "unknown"}
                    <span className="text-zinc-700"> · </span>
                    {it.model === "Sound" ? "Sound" : it.category || "Mod"}
                    {it.likes > 0 && (
                      <>
                        <span className="text-zinc-700"> · </span>
                        {it.likes} like{it.likes === 1 ? "" : "s"}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => onPick(it)}
                  disabled={busy}
                  className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  {busy ? "Linking…" : "This is it"}
                </button>
              </div>
            ))}
          </div>
        </div>
        <footer className="flex flex-col gap-2 border-t border-zinc-800 p-3">
          <div className="flex gap-1.5">
            <input
              value={pasteUrl}
              onChange={(e) => setPasteUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pasteUrl.trim() && onPasteUrl(pasteUrl.trim())}
              placeholder="…or paste the GameBanana page URL"
              spellCheck={false}
              className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-emerald-500/70"
            />
            <button
              onClick={() => pasteUrl.trim() && onPasteUrl(pasteUrl.trim())}
              disabled={busy || !pasteUrl.trim()}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-emerald-500/70 hover:text-white disabled:opacity-40"
            >
              Link
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onMine}
              title="It's your own work - shows a 'made by you' chip and stays out of credits.txt"
              className="rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-200 transition hover:border-sky-400 hover:text-white"
            >
              Made by me
            </button>
            <button
              onClick={onCancel}
              className="ml-auto rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              {auto ? "Later" : "Cancel"}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Mod combiner: one "Import a mod…" flow (scan → review what's inside → pick
 * the sound events to break out + bundle the rest), plus the list of bundled
 * mods that ride along on every compile.
 */
export function ImportedMods({
  settings,
  update,
  onImportPack,
  digimod,
  onDigimodChange,
  autoLinkFor,
  onAutoLinkDone,
  onBrowseGameBanana,
  modTextureOverrides,
  onModTexturesChange,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Scan pack(s) and open their import reviews (several queue one at a time). */
  onImportPack: (vpk: string | string[]) => void;
  /** Texture swaps inside bundled vpks (project-owned; edited per mod here). */
  modTextureOverrides: ModTextureOverride[];
  onModTexturesChange: (next: ModTextureOverride[]) => void;
  /** Jumpscares config — UI-mod merges live on it (they splice base_hud). */
  digimod: DigimodConfig | null;
  onDigimodChange: (next: DigimodConfig) => void;
  /** A pack that just got bundled without credits - auto-open the link picker
   *  for it. Call onAutoLinkDone when the picker closes (linked or not) so the
   *  parent can offer the next one. */
  autoLinkFor?: string | null;
  onAutoLinkDone?: () => void;
  /** Open the GameBanana browser screen (Back returns here). */
  onBrowseGameBanana?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [decompiling, setDecompiling] = useState(false);
  const { push } = useToast();
  const mods = settings.importedMods;
  // The bundled vpk whose retexture dialog is open, if any.
  const [retexFor, setRetexFor] = useState<string | null>(null);

  // GameBanana attribution: link a bundled vpk to its mod page so releases
  // can credit everyone (author + the page's credits list).
  const credits = settings.importedModCredits ?? {};
  const [gbBusy, setGbBusy] = useState<string | null>(null);
  // The bundled vpk the search picker is finding a page for.
  const [linkPicker, setLinkPicker] = useState<string | null>(null);
  // Gallery controls: with hundreds of bundled mods a flat list is unusable.
  const [modQuery, setModQuery] = useState("");
  const [modFilter, setModFilter] = useState<
    "all" | "unlinked" | "linked" | "mine" | "overlaps"
  >("all");
  const [modKind, setModKind] = useState<string | null>(null);
  const [modSort, setModSort] = useState<"recent" | "name" | "author">("recent");

  // Pack scans (kinds/mtimes/overlaps), one full-bundle pass per session.
  const bundleSig = useMemo(() => [...mods].sort().join("|"), [mods]);
  const [scanMap, setScanMap] = useState<Record<string, PackScan>>(
    () => scanCache.get([...settings.importedMods].sort().join("|")) ?? {},
  );
  useEffect(() => {
    const cached = scanCache.get(bundleSig);
    if (cached) {
      setScanMap(cached);
      return;
    }
    if (mods.length === 0 || !settings.vpkHelperPath) {
      setScanMap({});
      return;
    }
    let cancelled = false;
    packScan(settings.vpkHelperPath, mods)
      .then((res) => {
        scanCache.set(bundleSig, res);
        if (!cancelled) setScanMap(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleSig, settings.vpkHelperPath]);
  const kindsOf = (m: string) => scanMap[m]?.kinds ?? [];
  const overlapsOf = (m: string) => scanMap[m]?.overlaps ?? [];

  // "Update on page" check: newest GameBanana file vs the local pack's mtime.
  const [updates, setUpdates] = useState<Record<string, boolean>>({});
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  async function checkForUpdates() {
    const targets = mods.filter((m) => {
      const i = credits[m];
      return !!i && !isMadeByMe(i) && i.modId > 0;
    });
    if (targets.length === 0) {
      push("info", "No linked mods to check - link packs to their pages first");
      return;
    }
    setChecking({ done: 0, total: targets.length });
    const results: Record<string, boolean> = {};
    let done = 0;
    for (const m of targets) {
      if (updateCache.has(m)) {
        results[m] = updateCache.get(m)!;
      } else {
        try {
          const info = credits[m];
          const model = info.pageUrl.includes("/sounds/") ? "Sound" : "Mod";
          const files = await gamebananaFiles(info.modId, model);
          const newest = Math.max(0, ...files.map((f) => f.date));
          const localM = scanMap[m]?.mtime ?? 0;
          // An hour of slack absorbs timezone/fs weirdness.
          const stale = newest > 0 && localM > 0 && newest > localM + 3600;
          updateCache.set(m, stale);
          results[m] = stale;
        } catch {
          /* page gone or offline - skip quietly */
        }
      }
      done++;
      setChecking({ done, total: targets.length });
    }
    setUpdates((u) => ({ ...u, ...results }));
    setChecking(null);
    const n = Object.values(results).filter(Boolean).length;
    push(
      n > 0 ? "success" : "info",
      n > 0
        ? `${n} bundled mod(s) have newer files on GameBanana - re-import to update`
        : "All linked mods look current",
    );
  }

  // Bulk credits: feed every unlinked pack through the link picker in turn.
  // Linking or "Mine" advances; Cancel/Esc stops the run.
  const [bulkQueue, setBulkQueue] = useState<string[]>([]);
  function startBulkLink() {
    const unlinked = mods.filter((m) => !credits[m]);
    if (unlinked.length === 0) return;
    setBulkQueue(unlinked.slice(1));
    setLinkPicker(unlinked[0]);
  }

  // A fresh no-credits bundle: open the picker for it (auto mode).
  useEffect(() => {
    if (autoLinkFor) setLinkPicker(autoLinkFor);
  }, [autoLinkFor]);

  /** Close the picker; an auto-opened one reports back so the next
   *  credit-less pack (if any) can take its turn. `advance` (a successful
   *  link or "Mine") continues a bulk run; cancelling stops it. */
  function closePicker(advance = false) {
    const wasAuto = linkPicker !== null && linkPicker === autoLinkFor;
    if (advance && bulkQueue.length > 0) {
      const [next, ...rest] = bulkQueue;
      setBulkQueue(rest);
      setLinkPicker(next);
    } else {
      setBulkQueue([]);
      setLinkPicker(null);
    }
    if (wasAuto) onAutoLinkDone?.();
  }

  async function linkPage(m: string, url: string, thumbUrl?: string) {
    setGbBusy(m);
    try {
      const fetched = await gamebananaModInfo(url, m);
      const info = thumbUrl ? { ...fetched, thumbUrl } : fetched;
      update({ importedModCredits: { ...credits, [m]: info } });
      push(
        "success",
        `Linked "${info.name}"${info.author ? ` by ${info.author}` : ""}${info.md5Verified ? " - file verified" : ""}`,
      );
      closePicker(true);
    } catch (e) {
      push("error", `Couldn't fetch that page: ${e}`);
    } finally {
      setGbBusy(null);
    }
  }

  /** Mark a bundled pack as the user's own work - no page, no credits line. */
  function markMine(m: string) {
    update({ importedModCredits: { ...credits, [m]: MADE_BY_ME } });
    push("success", "Marked as your own mod - it stays out of credits.txt");
    closePicker(true);
  }

  // "Add from GameBanana": paste a page link -> download -> normal import
  // review, credits pre-attached. Multi-file pages get an inline file pick.
  const [gbLink, setGbLink] = useState("");
  const [gbGetting, setGbGetting] = useState(false);
  const [gbFilePick, setGbFilePick] = useState<{
    id: number;
    model: string;
    files: GbFile[];
  } | null>(null);

  async function getFromLink() {
    const ref = parseGbLink(gbLink.trim());
    if (!ref) {
      push("error", "That doesn't look like a GameBanana page link (gamebanana.com/mods/…)");
      return;
    }
    setGbGetting(true);
    setGbFilePick(null);
    try {
      const files = await gamebananaFiles(ref.id, ref.model);
      if (files.length === 0) {
        push("error", "That page has no downloadable files");
      } else if (files.length === 1) {
        await downloadGb(ref.id, ref.model, files[0]);
      } else {
        setGbFilePick({ id: ref.id, model: ref.model, files });
      }
    } catch (e) {
      push("error", `${e}`);
    } finally {
      setGbGetting(false);
    }
  }

  async function downloadGb(id: number, model: string, file: GbFile) {
    setGbGetting(true);
    setGbFilePick(null);
    push("info", "Downloading from GameBanana…");
    try {
      const res = await gamebananaDownload(id, file.downloadUrl, file.name, model);
      // Attribution attaches to every vpk BEFORE import - the whole point.
      if (res.vpks.length > 0) {
        const withCredits = { ...credits };
        for (const v of res.vpks) withCredits[v] = res.info;
        update({ importedModCredits: withCredits });
        onImportPack(res.vpks);
        setGbLink("");
        return;
      }
      // No pak, just loose audio (common for Sound submissions): shelve the
      // files in the Sound Library so they're durable and easy to reuse.
      const added: LibraryItem[] = [];
      for (const a of res.audios) {
        try {
          const copy = await libraryAdd(a);
          added.push({
            id: crypto.randomUUID(),
            name: copy.name,
            path: copy.path,
            source: res.info.name,
            addedAt: new Date().toISOString(),
          });
        } catch (e) {
          push("error", `${a.split(/[\\/]/).pop()}: ${e}`);
        }
      }
      if (added.length > 0) {
        update({ soundLibrary: [...(settings.soundLibrary ?? []), ...added] });
        push(
          "success",
          `"${res.info.name}" has no pak, just audio - added ${added.length} sound(s) to your Sound Library`,
        );
        setGbLink("");
      } else {
        push("error", "The download had no vpk and no audio files");
      }
    } catch (e) {
      push("error", `${e}`);
    } finally {
      setGbGetting(false);
    }
  }

  function unlinkCredits(m: string) {
    const next = { ...credits };
    delete next[m];
    update({ importedModCredits: next });
  }

  async function copyCredits() {
    try {
      await navigator.clipboard.writeText(buildCreditsText(settings));
      push("success", "Credits copied - paste them into your release description");
    } catch (e) {
      push("error", `Couldn't copy: ${e}`);
    }
  }

  // HUD (base_hud-overriding) mods can't be bundled like regular packs — two
  // base_huds can't coexist, so they get spliced instead (Jumpscares engine).
  const [uiMods, setUiMods] = useState<UiModVpk[]>([]);
  useEffect(() => {
    if (!settings.addonsDir) return;
    cListUiMods(settings.addonsDir)
      .then(setUiMods)
      .catch(() => {});
  }, [settings.addonsDir]);
  const mergeVpks = digimod?.mergeVpks ?? [];
  const toggleMerge = (path: string) => {
    const base = digimod ?? {
      rngInterval: 60,
      scareChance: 3,
      deathChance: 100,
      scares: [],
      deaths: [],
    };
    onDigimodChange({
      ...base,
      mergeVpks: mergeVpks.includes(path)
        ? mergeVpks.filter((p) => p !== path)
        : [...mergeVpks, path],
    });
  };
  async function browseMergeVpk() {
    const sel = await open({
      multiple: false,
      title: "Merge which UI mod (.vpk)?",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (typeof sel === "string" && !mergeVpks.includes(sel)) toggleMerge(sel);
  }
  const externalMerges = mergeVpks.filter((p) => !uiMods.some((m) => m.path === p));

  /** Utility: dump a whole vpk as decompiled sources (structure preserved). */
  async function decompileVpk() {
    const vpk = await open({
      multiple: false,
      title: "Decompile which .vpk?",
      filters: [{ name: "VPK", extensions: ["vpk"] }],
    });
    if (!vpk || Array.isArray(vpk)) return;
    const dest = await open({ directory: true, title: "Decompile into which folder?" });
    if (!dest || Array.isArray(dest)) return;
    setDecompiling(true);
    push("info", "Decompiling the pack… big vpks take a while");
    try {
      const summary = await decompileVpkAll(settings.vpkHelperPath, vpk, dest);
      push("success", `Done - ${summary}`);
      try {
        await revealItemInDir(dest);
      } catch {
        /* ignore */
      }
    } catch (e) {
      push("error", `Decompile failed: ${e}`);
    } finally {
      setDecompiling(false);
    }
  }

  function remove(p: string) {
    // Drop the pack from THIS profile's bundle list only. Its excludes and
    // GameBanana credits stay in the path-keyed registry: importedMods is
    // per-profile while those maps are settings-global, so deleting them here
    // would silently break any other profile still bundling the same pack -
    // and keeping them means a re-import remembers its link + deselections.
    update({ importedMods: mods.filter((m) => m !== p) });
  }

  const modStatus = (m: string): "unlinked" | "linked" | "mine" => {
    const i = credits[m];
    return isMadeByMe(i) ? "mine" : i ? "linked" : "unlinked";
  };

  const modCounts = useMemo(() => {
    const c = { all: mods.length, unlinked: 0, linked: 0, mine: 0 };
    for (const m of mods) c[modStatus(m)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, credits]);

  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of mods) for (const k of scanMap[m]?.kinds ?? []) c[k] = (c[k] ?? 0) + 1;
    return c;
  }, [mods, scanMap]);

  const overlapCount = useMemo(
    () => mods.filter((m) => (scanMap[m]?.overlaps ?? []).length > 0).length,
    [mods, scanMap],
  );

  /** The gallery's visible cards: filter + search + sort over the bundle. */
  const modView = useMemo(() => {
    const q = modQuery.trim().toLowerCase();
    const nameOf = (m: string) => credits[m]?.name || baseName(m);
    let list = mods.filter((m) => {
      if (modFilter === "overlaps") {
        if ((scanMap[m]?.overlaps ?? []).length === 0) return false;
      } else if (modFilter !== "all" && modStatus(m) !== modFilter) return false;
      if (modKind && !(scanMap[m]?.kinds ?? []).includes(modKind)) return false;
      if (!q) return true;
      return (
        baseName(m).toLowerCase().includes(q) ||
        (credits[m]?.name ?? "").toLowerCase().includes(q) ||
        (credits[m]?.author ?? "").toLowerCase().includes(q)
      );
    });
    if (modSort === "recent") list = [...list].reverse();
    else if (modSort === "name")
      list = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    else
      list = [...list].sort((a, b) =>
        (credits[a]?.author ?? "~").localeCompare(credits[b]?.author ?? "~"),
      );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mods, credits, modQuery, modFilter, modKind, modSort, scanMap]);

  function addPath() {
    const p = draft.trim().replace(/^"|"$/g, "");
    if (p) onImportPack(p);
    setDraft("");
  }

  async function browseImport() {
    const sel = await open({
      multiple: true,
      title: "Import mod(s) (.vpk, or a .zip/.rar/.7z with one inside)",
      filters: [{ name: "Mod pack", extensions: ["vpk", "zip", "rar", "7z"] }],
    });
    if (!sel || sel.length === 0) return;
    onImportPack(sel);
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-200">Import a mod</h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500">
        Pick one or several <span className="font-mono">.vpk</span>s, or a{" "}
        <span className="font-mono">.zip</span>/<span className="font-mono">.rar</span>/
        <span className="font-mono">.7z</span> with one inside (or{" "}
        <span className="text-zinc-400">drag them onto the window</span>). Each opens a
        review: choose which sounds become editable tracks in your tabs and what rides
        along in your build. Nothing of yours is ever removed.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void browseImport()}
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          Import a mod…
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addPath()}
          placeholder="…or paste a .vpk path and press Enter"
          spellCheck={false}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-emerald-500/70"
        />
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">
          Bundled on compile{mods.length > 0 ? ` (${mods.length})` : ""}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          These ride along in every <span className="font-mono">combined/</span> build.
          Remove one to stop bundling it (tracks you imported from it stay in your tabs).
          Link each mod's page, or mark it yours, so releases credit everyone.
        </p>
        {mods.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <input
              value={modQuery}
              onChange={(e) => setModQuery(e.target.value)}
              placeholder="Search name, author, file…"
              spellCheck={false}
              className="min-w-[11rem] flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/70"
            />
            {(
              [
                ["all", "All"],
                ["unlinked", "Needs credits"],
                ["linked", "Linked"],
                ["mine", "Yours"],
                ["overlaps", "Overlaps"],
              ] as const
            ).map(([f, label]) => {
              const n = f === "overlaps" ? overlapCount : modCounts[f];
              if (f !== "all" && n === 0) return null;
              return (
                <button
                  key={f}
                  onClick={() => setModFilter(f)}
                  title={
                    f === "overlaps"
                      ? "Packs shipping the same file as another bundled pack - the one staged later wins, so one of them is being silently overridden"
                      : undefined
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                    modFilter === f
                      ? f === "unlinked"
                        ? "border-amber-400 bg-amber-400/90 font-semibold text-zinc-900"
                        : f === "overlaps"
                          ? "border-rose-400 bg-rose-400/90 font-semibold text-zinc-900"
                          : "border-zinc-300 bg-zinc-200 font-semibold text-zinc-900"
                      : f === "unlinked"
                        ? "border-amber-500/50 text-amber-300 hover:border-amber-400"
                        : f === "overlaps"
                          ? "border-rose-500/50 text-rose-300 hover:border-rose-400"
                          : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {label} {n}
                </button>
              );
            })}
            {modCounts.unlinked > 1 && (
              <button
                onClick={startBulkLink}
                title="Walk every pack that needs credits through the link picker, one after another"
                className="rounded-md border border-violet-500/50 bg-violet-500/10 px-2.5 py-0.5 text-[11px] text-violet-200 transition hover:border-violet-400 hover:text-white"
              >
                Link all unlinked…
              </button>
            )}
            {modCounts.linked > 0 && (
              <button
                onClick={() => void checkForUpdates()}
                disabled={checking !== null}
                title="Compare each linked pack's newest GameBanana file against your local copy"
                className="rounded-md border border-zinc-700 px-2.5 py-0.5 text-[11px] text-zinc-300 transition hover:border-emerald-500/70 hover:text-white disabled:opacity-50"
              >
                {checking ? `Checking ${checking.done}/${checking.total}…` : "Check GB updates"}
              </button>
            )}
            <select
              value={modSort}
              onChange={(e) => setModSort(e.target.value as typeof modSort)}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-400 outline-none focus:border-zinc-500"
              title="Sort the gallery"
            >
              <option value="recent">Newest first</option>
              <option value="name">By name</option>
              <option value="author">By author</option>
            </select>
            <span className="h-4 w-px bg-zinc-800" />
            {KIND_ORDER.filter((k) => (kindCounts[k] ?? 0) > 0).map((k) => (
              <button
                key={k}
                onClick={() => setModKind(modKind === k ? null : k)}
                title={`Only packs that carry ${KIND_LABELS[k].toLowerCase()} content`}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                  modKind === k
                    ? "border-emerald-400 bg-emerald-400/90 font-semibold text-emerald-950"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {KIND_LABELS[k]} {kindCounts[k]}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 grid max-h-[30rem] gap-2 overflow-y-auto pr-1 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]">
          {mods.length === 0 && (
            <span className="text-xs text-zinc-600">Nothing bundled yet.</span>
          )}
          {modView.map((m) => {
            const info = credits[m];
            const mine = isMadeByMe(info);
            const linked = !!info && !mine;
            const display = linked ? info.name : baseName(m).replace(/\.vpk$/i, "");
            return (
              <div
                key={m}
                className={`group flex flex-col overflow-hidden rounded-lg border bg-zinc-950/60 transition-colors ${
                  linked || mine
                    ? "border-zinc-800 hover:border-zinc-600"
                    : "border-amber-500/30 hover:border-amber-400/60"
                }`}
              >
                <div
                  className="relative aspect-video w-full overflow-hidden"
                  style={{ background: tileBg(display) }}
                  title={m}
                >
                  {linked && info.thumbUrl ? (
                    <img src={info.thumbUrl} className="h-full w-full object-cover" loading="lazy" alt="" />
                  ) : (
                    <span
                      className="flex h-full w-full items-center justify-center text-2xl font-bold"
                      style={{ color: tileFg(display) }}
                    >
                      {initials(display)}
                    </span>
                  )}
                  {linked && info.md5Verified && (
                    <span
                      title="This file's checksum matches the GameBanana page's download"
                      className="absolute left-1.5 top-1.5 rounded bg-emerald-500/85 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-950"
                    >
                      verified
                    </span>
                  )}
                  {mine && (
                    <span
                      title="Your own work - left out of credits.txt"
                      className="absolute left-1.5 top-1.5 rounded bg-sky-500/85 px-1.5 py-0.5 text-[10px] font-semibold text-sky-950"
                    >
                      yours
                    </span>
                  )}
                  {kindsOf(m).length > 0 && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-300">
                      {kindsOf(m).map((k) => KIND_LABELS[k] ?? k).join(" · ")}
                    </span>
                  )}
                  <button
                    onClick={() => remove(m)}
                    title="Stop bundling this mod (tracks you imported from it stay)"
                    className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-2 py-0.5 text-xs text-red-300 opacity-0 transition-opacity hover:bg-red-500/20 group-hover:opacity-100"
                  >
                    ✕ remove
                  </button>
                  <button
                    onClick={() => onImportPack(m)}
                    title="Re-open the import review for this pack"
                    className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-2 py-0.5 text-xs text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-700 group-hover:opacity-100"
                  >
                    review
                  </button>
                  <button
                    onClick={() => setRetexFor(m)}
                    title="Swap textures inside this mod (its model skins, art, etc.)"
                    className={`absolute bottom-1.5 left-[4.2rem] rounded bg-black/70 px-2 py-0.5 text-xs transition-opacity hover:bg-teal-500/20 group-hover:opacity-100 ${
                      modTextureOverrides.some((o) => o.modVpk === m)
                        ? "text-teal-300 opacity-100"
                        : "text-zinc-300 opacity-0"
                    }`}
                  >
                    retex
                    {modTextureOverrides.filter((o) => o.modVpk === m).length > 0 &&
                      ` ${modTextureOverrides.filter((o) => o.modVpk === m).length}`}
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
                  {linked ? (
                    <button
                      onClick={() => void openUrl(info.pageUrl)}
                      title={`Open the page in your browser\n${info.pageUrl}`}
                      className="truncate text-left text-xs font-semibold text-zinc-200 hover:text-emerald-300 hover:underline"
                    >
                      {display}
                    </button>
                  ) : (
                    <span className="truncate text-xs font-semibold text-zinc-200">{display}</span>
                  )}
                  {(overlapsOf(m).length > 0 || updates[m]) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                      {overlapsOf(m).length > 0 && (
                        <span
                          className="text-rose-300/90"
                          title={
                            "Ships the same file(s) as: " +
                            overlapsOf(m)
                              .slice(0, 4)
                              .map(
                                (o) =>
                                  `${credits[o.other]?.name || baseName(o.other)} (${o.count})`,
                              )
                              .join(", ") +
                            (overlapsOf(m).length > 4
                              ? ` and ${overlapsOf(m).length - 4} more`
                              : "") +
                            ". The pack lower in the bundle order wins - one of these is being overridden."
                          }
                        >
                          ⚠ overlaps {overlapsOf(m).length}
                        </span>
                      )}
                      {updates[m] && (
                        <span
                          className="text-amber-300/90"
                          title="The GameBanana page has a newer file than your local copy - re-import to update"
                        >
                          ⬆ update on page
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-500">
                    {linked ? (
                      <>
                        <span className="truncate">by {info.author || "unknown"}</span>
                        {info.credits.length > 0 && (
                          <span
                            className="shrink-0"
                            title={info.credits
                              .map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)
                              .join(", ")}
                          >
                            +{info.credits.length}
                          </span>
                        )}
                        <button
                          onClick={() => unlinkCredits(m)}
                          className="ml-auto shrink-0 text-zinc-600 transition hover:text-zinc-300"
                        >
                          unlink
                        </button>
                      </>
                    ) : mine ? (
                      <>
                        <span className="truncate">made by you</span>
                        <button
                          onClick={() => unlinkCredits(m)}
                          className="ml-auto shrink-0 text-zinc-600 transition hover:text-zinc-300"
                        >
                          unlink
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setLinkPicker(m)}
                          title="Search GameBanana for this mod's page, or paste its URL there"
                          className="rounded border border-violet-500/50 bg-violet-500/10 px-1.5 py-0.5 text-violet-200 transition hover:border-violet-400 hover:text-white"
                        >
                          Find creator
                        </button>
                        <button
                          onClick={() => markMine(m)}
                          title="It's your own work - stays out of credits.txt"
                          className="rounded border border-sky-500/50 bg-sky-500/10 px-1.5 py-0.5 text-sky-200 transition hover:border-sky-400 hover:text-white"
                        >
                          Mine
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {modView.length === 0 && mods.length > 0 && (
          <p className="mt-2 text-center text-xs text-zinc-600">
            No bundled mods match the search/filter.
          </p>
        )}
        {mods.length > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={settings.writeCreditsFile}
                onChange={(e) => update({ writeCreditsFile: e.target.checked })}
                className="accent-emerald-500"
              />
              Write a credits.txt next to the combined build
            </label>
            <button
              onClick={() => void copyCredits()}
              title="Copy the attribution list for your release description"
              className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              Copy credits
            </button>
          </div>
        )}
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            Merge UI mods{mergeVpks.length > 0 ? ` (${mergeVpks.length})` : ""}
          </h3>
          <button
            onClick={() => void browseMergeVpk()}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white"
          >
            Browse for a vpk…
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          HUD mods (anything overriding the in-game HUD layout) can't be bundled like the
          packs above - two HUDs can't coexist. Merging splices them together instead:
          their HUD edits + your Jumpscares ship as one. Installed HUD mods show up
          here automatically.
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {uiMods.length === 0 && externalMerges.length === 0 && (
            <span className="text-xs text-zinc-600">No HUD mods found in your addons.</span>
          )}
          {uiMods.map((m) =>
            m.hasDigi ? (
              <div
                key={m.path}
                className="flex items-center gap-2 rounded-md border border-zinc-800/60 px-3 py-1.5 text-xs text-zinc-600"
                title={m.path}
              >
                <span className="truncate">{m.fileName}</span>
                <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">
                  MoonahMasterUI pak - import it in the Jumpscares tab instead
                </span>
              </div>
            ) : (
              <label
                key={m.path}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
                title={m.path}
              >
                <input
                  type="checkbox"
                  checked={mergeVpks.includes(m.path)}
                  onChange={() => toggleMerge(m.path)}
                  className="accent-emerald-500"
                />
                <span className="truncate">{m.fileName}</span>
                {mergeVpks.includes(m.path) && (
                  <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                    merges on compile - disable the original pak after installing
                  </span>
                )}
              </label>
            ),
          )}
          {externalMerges.map((p) => (
            <label
              key={p}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
              title={p}
            >
              <input
                type="checkbox"
                checked
                onChange={() => toggleMerge(p)}
                className="accent-emerald-500"
              />
              <span className="truncate">{baseName(p)}</span>
              <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
                merges on compile
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">Add from GameBanana</h3>
          {onBrowseGameBanana && (
            <button
              onClick={onBrowseGameBanana}
              className="ml-auto rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-200 transition hover:border-yellow-400 hover:text-white"
            >
              Browse GameBanana…
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Pull a mod straight off its GameBanana page: paste the page link (or browse) and
          the download lands in the normal import review, with the author + credits
          attached automatically.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={gbLink}
            onChange={(e) => setGbLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void getFromLink()}
            placeholder="https://gamebanana.com/mods/…"
            spellCheck={false}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-yellow-500/70"
          />
          <button
            onClick={() => void getFromLink()}
            disabled={gbGetting || !gbLink.trim()}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {gbGetting ? "Getting…" : "Get"}
          </button>
        </div>
        {gbFilePick && (
          <div className="mt-2 flex flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
            <span className="px-1 text-[11px] text-zinc-500">
              That page ships {gbFilePick.files.length} files - pick one:
            </span>
            {gbFilePick.files.map((f) => (
              <div
                key={f.downloadUrl}
                className="flex items-center gap-2 rounded border border-zinc-800/60 px-2 py-1 text-[11px]"
              >
                <span className="truncate font-mono text-zinc-300" title={f.description || f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 text-zinc-600">
                  {(f.size / 1024 / 1024).toFixed(1)} MB · {f.downloadCount} downloads
                </span>
                <button
                  onClick={() => void downloadGb(gbFilePick.id, gbFilePick.model, f)}
                  disabled={gbGetting}
                  className="ml-auto shrink-0 rounded bg-emerald-600 px-2.5 py-0.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  Get
                </button>
              </div>
            ))}
            <button
              onClick={() => setGbFilePick(null)}
              className="self-end px-1 text-[11px] text-zinc-600 transition hover:text-zinc-300"
            >
              cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-200">Decompile a .vpk</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Utility: dump any vpk as its decompiled sources, keeping the folder structure -
          sounds become mp3/wav, textures become png, soundevents and configs become
          readable text. Handy for digging through someone else's mod.
        </p>
        <button
          onClick={() => void decompileVpk()}
          disabled={decompiling}
          className="mt-2 rounded-md border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-50"
        >
          {decompiling ? "Decompiling…" : "Decompile a .vpk…"}
        </button>
      </div>

      {linkPicker && (
        <GbLinkPicker
          vpkPath={linkPicker}
          busy={gbBusy === linkPicker}
          auto={linkPicker === autoLinkFor}
          onPick={(it) => void linkPage(linkPicker, it.pageUrl, it.thumbUrl || undefined)}
          onPasteUrl={(url) => void linkPage(linkPicker, url)}
          onMine={() => markMine(linkPicker)}
          onCancel={() => closePicker(false)}
        />
      )}

      {retexFor && (
        <ModRetexture
          modVpk={retexFor}
          modName={credits[retexFor]?.name || baseName(retexFor).replace(/\.vpk$/i, "")}
          helperPath={settings.vpkHelperPath}
          overrides={modTextureOverrides}
          onChange={onModTexturesChange}
          onClose={() => setRetexFor(null)}
        />
      )}
    </section>
  );
}
