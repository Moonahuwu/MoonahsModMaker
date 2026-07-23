import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  decompileVpkAll,
  gamebananaDownload,
  gamebananaFiles,
  gamebananaModInfo,
  gamebananaSearch,
  libraryAdd,
  type GbFile,
  type GbSearchItem,
  type UiModVpk,
} from "../lib/api";
import { cListUiMods } from "../lib/dataCache";
import { buildCreditsText, isMadeByMe, MADE_BY_ME, type Settings } from "../lib/settings";
import type { DigimodConfig, LibraryItem } from "../types";
import { useEscape } from "../lib/useEscape";
import { useToast } from "./Toaster";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
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
  onMine,
  onCancel,
}: {
  vpkPath: string;
  /** True while the parent fetches the picked page's credits. */
  busy: boolean;
  /** True when the picker opened itself right after an import. */
  auto?: boolean;
  onPick: (item: GbSearchItem) => void;
  /** Mark the pack as the user's own work (no page to link). */
  onMine: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState(() => searchGuess(vpkPath));
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
        <footer className="flex items-center gap-2 border-t border-zinc-800 p-3">
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
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Scan pack(s) and open their import reviews (several queue one at a time). */
  onImportPack: (vpk: string | string[]) => void;
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

  // GameBanana attribution: link a bundled vpk to its mod page so releases
  // can credit everyone (author + the page's credits list).
  const credits = settings.importedModCredits ?? {};
  const [gbInput, setGbInput] = useState<Record<string, string>>({});
  const [gbBusy, setGbBusy] = useState<string | null>(null);
  // The bundled vpk the search picker is finding a page for.
  const [linkPicker, setLinkPicker] = useState<string | null>(null);

  // A fresh no-credits bundle: open the picker for it (auto mode).
  useEffect(() => {
    if (autoLinkFor) setLinkPicker(autoLinkFor);
  }, [autoLinkFor]);

  /** Close the picker; an auto-opened one reports back so the next
   *  credit-less pack (if any) can take its turn. */
  function closePicker() {
    const wasAuto = linkPicker !== null && linkPicker === autoLinkFor;
    setLinkPicker(null);
    if (wasAuto) onAutoLinkDone?.();
  }

  async function linkPage(m: string, url: string) {
    setGbBusy(m);
    try {
      const info = await gamebananaModInfo(url, m);
      update({ importedModCredits: { ...credits, [m]: info } });
      push(
        "success",
        `Linked "${info.name}"${info.author ? ` by ${info.author}` : ""}${info.md5Verified ? " - file verified" : ""}`,
      );
      closePicker();
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
    closePicker();
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

  async function fetchCredits(m: string) {
    const url = (gbInput[m] ?? "").trim();
    if (!url) return;
    await linkPage(m, url);
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
        <div className="mt-3 flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
          {mods.length === 0 && (
            <span className="text-xs text-zinc-600">Nothing bundled yet.</span>
          )}
          <AnimatePresence initial={false}>
            {mods.map((m) => {
              const info = credits[m];
              const mine = isMadeByMe(info);
              const linked = !!info && !mine;
              return (
                <motion.div
                  key={m}
                  layout
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                  className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    {linked ? (
                      <button
                        onClick={() => void openUrl(info.pageUrl)}
                        title={`${info.pageUrl}\n${m}`}
                        className="min-w-0 truncate text-left font-medium text-emerald-400/90 hover:underline"
                      >
                        {info.name}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-medium text-zinc-300" title={m}>
                        {baseName(m)}
                      </span>
                    )}
                    {linked && (
                      <span className="shrink-0 text-zinc-500">by {info.author || "unknown"}</span>
                    )}
                    {mine && (
                      <span
                        title="Your own work - left out of credits.txt"
                        className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300"
                      >
                        made by you
                      </span>
                    )}
                    {linked && info.md5Verified && (
                      <span
                        title="This file's checksum matches the GameBanana page's download"
                        className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300"
                      >
                        verified
                      </span>
                    )}
                    {linked && info.credits.length > 0 && (
                      <span
                        className="shrink-0 text-[11px] text-zinc-500"
                        title={info.credits
                          .map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)
                          .join(", ")}
                      >
                        +{info.credits.length} credited
                      </span>
                    )}
                    {(linked || mine) && (
                      <button
                        onClick={() => unlinkCredits(m)}
                        className="shrink-0 text-[11px] text-zinc-600 transition hover:text-zinc-300"
                      >
                        unlink
                      </button>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => onImportPack(m)}
                        title="Re-open the import review for this pack"
                        className="rounded px-1.5 py-0.5 text-zinc-500 transition hover:bg-zinc-700/60 hover:text-zinc-200"
                      >
                        review
                      </button>
                      <button
                        onClick={() => remove(m)}
                        className="rounded p-0.5 text-zinc-500 transition hover:bg-red-950/40 hover:text-red-300"
                        aria-label="Remove bundled mod"
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  {!info && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <button
                        onClick={() => setLinkPicker(m)}
                        title="Search GameBanana for this mod's page - no link needed"
                        className="rounded border border-violet-500/50 bg-violet-500/10 px-2.5 py-1 text-[11px] text-violet-200 transition hover:border-violet-400 hover:text-white"
                      >
                        Find the creator…
                      </button>
                      <button
                        onClick={() => markMine(m)}
                        title="It's your own work - shows a 'made by you' chip and stays out of credits.txt"
                        className="rounded border border-sky-500/50 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200 transition hover:border-sky-400 hover:text-white"
                      >
                        Mine
                      </button>
                      <input
                        value={gbInput[m] ?? ""}
                        onChange={(e) => setGbInput((g) => ({ ...g, [m]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && void fetchCredits(m)}
                        placeholder="…or paste the GameBanana page URL"
                        spellCheck={false}
                        className="flex-1 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600 focus:border-emerald-500/70"
                      />
                      <button
                        onClick={() => void fetchCredits(m)}
                        disabled={gbBusy === m || !(gbInput[m] ?? "").trim()}
                        className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-emerald-500/70 hover:text-white disabled:opacity-40"
                      >
                        {gbBusy === m ? "Fetching…" : "Link"}
                      </button>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
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
          onPick={(it) => void linkPage(linkPicker, it.pageUrl)}
          onMine={() => markMine(linkPicker)}
          onCancel={closePicker}
        />
      )}
    </section>
  );
}
