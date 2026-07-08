import { useEffect, useMemo, useRef, useState } from "react";
import { clearPushedUi, listUiFiles, pushUiFiles, readUiFile } from "../lib/api";
import { buildCompileConfig, type Settings } from "../lib/settings";
import { launchGame } from "../lib/api";
import { layoutStyleIncludes } from "../lib/panorama";
import { PanoramaPreview } from "./PanoramaPreview";
import { useToast } from "./Toaster";
import type { UiFileOverride } from "../types";

/**
 * UI Master (experimental, phase 1): browse every panorama layout/style in
 * the game pak, decompile one to readable source with a click, edit it in
 * the app, and it compiles + stages over the game's own file on the next
 * compile. No preview yet — the game is the renderer (phase 2 is a fast
 * test-in-game loop).
 */

/** Session cache of decompiled vanilla sources (pure game data). */
const vanillaCache = new Map<string, Promise<string>>();
function cachedVanilla(helper: string, pak: string, rel: string): Promise<string> {
  const key = `${pak}|${rel}`;
  let p = vanillaCache.get(key);
  if (!p) {
    p = readUiFile(helper, pak, rel);
    p.catch(() => vanillaCache.delete(key));
    vanillaCache.set(key, p);
  }
  return p;
}

function fileName(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

/** panorama/styles/x.vcss_c -> "styles"; deeper folders keep their tail. */
function folderOf(rel: string): string {
  const parts = rel.split("/");
  return parts.slice(1, -1).join("/") || "panorama";
}

export function UiMasterTab({
  settings,
  overrides,
  onChange,
}: {
  settings: Settings;
  overrides: UiFileOverride[];
  onChange: (next: UiFileOverride[]) => void;
}) {
  const helperPath = settings.vpkHelperPath;
  const pakPath = settings.deadlockPak;
  // …/game/citadel/pak01_dir.vpk -> …/game/citadel
  const citadelDir = pakPath ? pakPath.replace(/[\\/][^\\/]*$/, "") : "";
  const { push } = useToast();
  const [pushing, setPushing] = useState(false);
  const [pushedN, setPushedN] = useState<number | null>(null);

  /** Compile the edits + drop them loose into grimoire (no vpk, no install). */
  async function pushToGame() {
    setPushing(true);
    try {
      const config = buildCompileConfig(
        settings, [], false, [], [], [], [], [], [], [], null, overrides,
      );
      const rels = await pushUiFiles(config, citadelDir);
      setPushedN(rels.length);
      push("success", `${rels.length} UI file(s) pushed to grimoire`);
    } catch (e) {
      push("error", `Push failed: ${e}`);
    } finally {
      setPushing(false);
    }
  }

  async function clearPushed() {
    try {
      const n = await clearPushedUi(citadelDir);
      setPushedN(null);
      push("success", `${n} pushed file(s) removed — game is back to normal`);
    } catch (e) {
      push("error", `Cleanup failed: ${e}`);
    }
  }
  const [files, setFiles] = useState<string[]>([]);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openRel, setOpenRel] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [vanilla, setVanilla] = useState<string | null>(null);
  const [showVanilla, setShowVanilla] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);

  // Live preview: an approximate HTML render of the layout + its styles,
  // re-fed (debounced) as you type. Styles preview against the layout with
  // the same file stem (hud_paused.vcss_c ↔ hud_paused.vxml_c).
  const [view, setView] = useState<"code" | "split" | "preview">("code");
  const [debouncedText, setDebouncedText] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(text), 400);
    return () => clearTimeout(t);
  }, [text]);
  const [preview, setPreview] = useState<{ xml: string; css: string[] } | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  useEffect(() => {
    if (!openRel || view === "code" || loading) return;
    let live = true;
    (async () => {
      try {
        const isXml = openRel.endsWith(".vxml_c");
        let layoutXml = debouncedText;
        if (!isXml) {
          const stem = fileName(openRel).replace(/\.vcss_c$/, "");
          const match = files.find((f) => f.endsWith(`/${stem}.vxml_c`) || fileName(f) === `${stem}.vxml_c`);
          if (!match) {
            if (live) {
              setPreview(null);
              setPreviewNote(
                `No layout named ${stem}.vxml_c found to preview this style against — open a layout (.vxml_c) for a live preview.`,
              );
            }
            return;
          }
          layoutXml =
            overrides.find((o) => o.targetRel === match)?.text ??
            (await cachedVanilla(helperPath, pakPath, match));
        }
        const rels = layoutStyleIncludes(layoutXml);
        const css: string[] = [];
        for (const rel of rels) {
          if (!isXml && rel === openRel) {
            css.push(debouncedText);
            continue;
          }
          const ov = overrides.find((o) => o.targetRel === rel);
          if (ov) {
            css.push(ov.text);
            continue;
          }
          if (files.includes(rel)) {
            try {
              css.push(await cachedVanilla(helperPath, pakPath, rel));
            } catch {
              /* skip unreadable includes */
            }
          }
        }
        // Editing a style the layout doesn't include (yet)? Apply it anyway.
        if (!isXml && !rels.includes(openRel)) css.push(debouncedText);
        if (live) {
          setPreview({ xml: layoutXml, css });
          setPreviewNote(null);
        }
      } catch (e) {
        if (live) {
          setPreview(null);
          setPreviewNote(String(e));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [openRel, debouncedText, view, files, overrides, helperPath, pakPath, loading]);

  useEffect(() => {
    if (!helperPath || !pakPath) return;
    listUiFiles(helperPath, pakPath)
      .then(setFiles)
      .catch((e) => setFilesErr(String(e)));
  }, [helperPath, pakPath]);

  const overrideFor = (rel: string) => overrides.find((o) => o.targetRel === rel);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = files.filter((f) => !q || f.toLowerCase().includes(q));
    const map = new Map<string, string[]>();
    for (const f of hits) {
      const g = folderOf(f);
      map.set(g, [...(map.get(g) ?? []), f]);
    }
    // Edited files first, then layout + styles roots, then the rest.
    const order = (g: string) => (g === "layout" ? 1 : g === "styles" ? 2 : 3);
    return [...map.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  }, [files, query]);

  async function openFile(rel: string) {
    setOpenRel(rel);
    setShowVanilla(false);
    setLoading(true);
    const seq = ++loadSeq.current;
    try {
      const van = await cachedVanilla(helperPath, pakPath, rel);
      if (seq !== loadSeq.current) return;
      setVanilla(van);
      setText(overrideFor(rel)?.text ?? van);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setVanilla(null);
      setText("");
      push("error", `Couldn't decompile ${fileName(rel)}: ${e}`);
      setOpenRel(null);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  function saveEdit() {
    if (!openRel) return;
    if (vanilla !== null && text === vanilla) {
      // Saving unchanged text = removing the override.
      onChange(overrides.filter((o) => o.targetRel !== openRel));
      push("info", `${fileName(openRel)} matches vanilla — override removed`);
      return;
    }
    const next = overrides.filter((o) => o.targetRel !== openRel);
    next.push({ targetRel: openRel, text, vanillaText: vanilla ?? undefined });
    onChange(next);
    push("success", `${fileName(openRel)} saved — ships on next compile`);
  }

  function revert() {
    if (!openRel) return;
    onChange(overrides.filter((o) => o.targetRel !== openRel));
    if (vanilla !== null) setText(vanilla);
    push("info", `${fileName(openRel)} reverted to vanilla`);
  }

  const open = openRel ? overrideFor(openRel) : undefined;
  const dirty = openRel !== null && vanilla !== null && text !== (open?.text ?? vanilla);
  const edited = openRel !== null && (open !== undefined || (vanilla !== null && text !== vanilla));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Phase-2 spike: fast test-in-game loop via the grimoire dir (the
          top-priority loose search path — outranks addons AND pak01). */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-2.5">
        <div className="min-w-[16rem] flex-1">
          <span className="text-sm font-semibold text-amber-200">⚡ Test in game</span>
          <p className="text-[11px] leading-4 text-zinc-500">
            Pushes your edits loose into <span className="font-mono">citadel/eim_dev/</span>{" "}
            (mounted top-priority in gameinfo) — no vpk, no install. Restart the game (or
            rejoin the map) to see them; sandbox is the fastest way to check HUD changes.
          </p>
        </div>
        {pushedN !== null && (
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
            {pushedN} file(s) live
          </span>
        )}
        <button
          onClick={() => void pushToGame()}
          disabled={pushing || overrides.length === 0}
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-400 disabled:opacity-40"
        >
          {pushing ? "Pushing…" : `Push ${overrides.length} edit(s)`}
        </button>
        <button
          onClick={() => {
            const root = citadelDir.replace(/[\\/]game[\\/]citadel$/i, "");
            launchGame(root || undefined)
              .then(() => push("success", "Launching Deadlock…"))
              .catch((e) => push("error", `Launch failed: ${e}`));
          }}
          className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/10"
        >
          ▶ Launch game
        </button>
        <button
          onClick={() => void clearPushed()}
          title="Remove everything pushed to grimoire (game back to stock)"
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-400/60 hover:text-red-300"
        >
          🧹 Remove pushed
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
      {/* File browser */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search UI files… (hud, menu, shop)"
          spellCheck={false}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-500/70"
        />
        {overrides.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-widest text-amber-300/90">
              Edited ({overrides.length})
            </div>
            {overrides.map((o) => (
              <button
                key={o.targetRel}
                onClick={() => void openFile(o.targetRel)}
                title={o.targetRel}
                className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs ${
                  openRel === o.targetRel
                    ? "bg-amber-500/15 text-amber-200"
                    : "text-zinc-300 hover:bg-zinc-900"
                }`}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span className="truncate">{fileName(o.targetRel)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          {filesErr ? (
            <p className="p-2 text-xs text-red-300">{filesErr}</p>
          ) : files.length === 0 ? (
            <p className="p-2 text-xs text-zinc-600">Reading the pak's UI files…</p>
          ) : (
            groups.map(([group, members]) => (
              <div key={group} className="mb-2">
                <div className="px-1 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-600">
                  {group} ({members.length})
                </div>
                {members.map((f) => (
                  <button
                    key={f}
                    onClick={() => void openFile(f)}
                    title={f}
                    className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-xs ${
                      openRel === f
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {overrideFor(f) && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    )}
                    <span className="truncate">{fileName(f)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {openRel === null ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40">
            <div className="max-w-md p-6 text-center text-sm text-zinc-500">
              <p className="mb-2 text-2xl">🎛</p>
              <p>
                Pick a layout (<span className="font-mono text-xs">.vxml_c</span>) or style
                (<span className="font-mono text-xs">.vcss_c</span>) on the left — it
                decompiles to editable source. Save your edit and it ships inside your mod
                on the next compile, overriding the game's file.
              </p>
              <p className="mt-3 text-[11px] text-zinc-600">
                Tip: styles are the safe playground (colors, sizes, positions). Layout
                edits can break panels — keep the structure, tweak attributes.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs text-zinc-400" title={openRel}>
                {openRel}
              </span>
              {edited && (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  edited
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className="flex overflow-hidden rounded-lg border border-zinc-700">
                  {(["code", "split", "preview"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`px-2.5 py-1 text-xs capitalize ${
                        view === v
                          ? "bg-amber-500/20 font-semibold text-amber-200"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </span>
                <button
                  onClick={() => setShowVanilla((v) => !v)}
                  className={`rounded-lg border px-2.5 py-1 text-xs ${
                    showVanilla
                      ? "border-zinc-500 bg-zinc-800 text-zinc-200"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  {showVanilla ? "Hide vanilla" : "Compare vanilla"}
                </button>
                <button
                  onClick={revert}
                  disabled={!edited && !dirty}
                  className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-red-400/60 hover:text-red-300 disabled:opacity-40"
                >
                  Revert to vanilla
                </button>
                <button
                  onClick={saveEdit}
                  disabled={!dirty}
                  className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-400 disabled:opacity-40"
                >
                  Save edit
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 gap-2">
              {view !== "preview" && (
                <textarea
                  value={loading ? "decompiling…" : text}
                  onChange={(e) => setText(e.target.value)}
                  readOnly={loading}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 font-mono text-[12px] leading-5 text-zinc-200 outline-none focus:border-amber-500/50"
                />
              )}
              {view === "code" && showVanilla && (
                <textarea
                  value={vanilla ?? ""}
                  readOnly
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-[12px] leading-5 text-zinc-500 outline-none"
                />
              )}
              {view !== "code" &&
                (previewNote ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-xs text-zinc-500">
                    {previewNote}
                  </div>
                ) : preview ? (
                  <PanoramaPreview xml={preview.xml} cssSources={preview.css} />
                ) : (
                  <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-600">
                    building preview…
                  </div>
                ))}
            </div>
            <p className="text-[10px] text-zinc-600">
              Whole-file override: your version replaces the game's on compile. "Fix for
              new patch" won't rebase these — re-check edited files after big game updates.
            </p>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
