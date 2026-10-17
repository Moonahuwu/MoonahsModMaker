import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  applyCursors,
  cursorStatus,
  exportCursorPack,
  importCursorPack,
  restoreCursors,
  type CursorPackVariant,
  type CursorSlotStatus,
  type CursorStatus,
} from "../lib/api";
import type { CursorEntry } from "../types";
import { useToast } from "./Toaster";

// The Cursors tab: replace the game's mouse cursors with your own images.
//
// Cursors are NOT pak content. Since the 2026-09-29 patch the game reads four
// loose BMP files straight off the disk (`game/citadel/resource/cursors`), so
// nothing here rides in the compiled vpk: "Apply to game" converts each image
// to the game's exact BMP layout and writes it into that folder, keeping what
// it replaces as a backup, and "Restore originals" puts the backups back. A
// game update or a Steam file verify resets the folder; the tab notices and
// asks to apply again. (Backend + the format notes: cursors.rs.)

interface SlotInfo {
  id: string;
  title: string;
  blurb: string;
  file: string;
  stock: { w: number; h: number };
  /** The game's own click point for this cursor, as a fraction of it. */
  stockHot: { x: number; y: number };
}

/** Mirrors `SLOTS` in cursors.rs (ids, files and stock sizes must match). */
const SLOTS: SlotInfo[] = [
  {
    id: "default",
    title: "Pointer",
    blurb: "The normal cursor, in menus and whenever the mouse is free",
    file: "cursor.bmp",
    stock: { w: 48, h: 58 },
    stockHot: { x: 0, y: 0 },
  },
  {
    id: "ping",
    title: "Ping pointer",
    blurb: "The pointer with the speech bubble, used for pings",
    file: "cursor_ping.bmp",
    stock: { w: 48, h: 58 },
    stockHot: { x: 0, y: 0 },
  },
  {
    id: "shop",
    title: "Shop hand",
    blurb: "The pointing hand from the shop",
    file: "cursor_shop.bmp",
    stock: { w: 60, h: 60 },
    stockHot: { x: 0, y: 0 },
  },
  {
    id: "commend",
    title: "Commend",
    blurb: "The thumbs-up for commending players after a match",
    file: "cursor_commend.bmp",
    stock: { w: 88, h: 88 },
    stockHot: { x: 22 / 87, y: 2 / 87 },
  },
];

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tga"];
const PACK_EXTENSIONS = ["zip", "rar", "7z"];
const MIN_PX = 8;
const MAX_PX = 256;
/** Preview boxes are this tall; cursors show at up to 2x inside them. */
const BOX = 150;

const selectCls =
  "rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-[11px] text-zinc-200";
const btnCls =
  "rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

/** Transparency checkerboard behind every preview. */
const checker: CSSProperties = {
  backgroundColor: "#3f3f46",
  backgroundImage:
    "linear-gradient(45deg, #52525b 25%, transparent 25%), linear-gradient(-45deg, #52525b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #52525b 75%), linear-gradient(-45deg, transparent 75%, #52525b 75%)",
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0",
};

function fileUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

/** Zoom for a cursor `h` pixels tall so it fits the preview box (2x at most). */
function zoomFor(h: number): number {
  return Math.min(2, (BOX - 16) / Math.max(1, h));
}

/** What "Apply" would write, as a string - compared with the last apply to
 *  tell "in the game" from "changed since". */
function signature(entries: CursorEntry[]): string {
  return JSON.stringify(
    entries
      .filter((e) => e.enabled !== false && e.sourceImage)
      .map((e) => [e.slot, e.sourceImage, e.height, e.hotX.toFixed(4), e.hotY.toFixed(4)])
      .sort(),
  );
}

const APPLIED_KEY = "eim.cursorsApplied";

function readApplied(dir: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "{}") as Record<string, string>;
    return all[dir] ?? null;
  } catch {
    return null;
  }
}

function writeApplied(dir: string, sig: string | null) {
  try {
    const all = JSON.parse(localStorage.getItem(APPLIED_KEY) ?? "{}") as Record<string, string>;
    if (sig === null) delete all[dir];
    else all[dir] = sig;
    localStorage.setItem(APPLIED_KEY, JSON.stringify(all));
  } catch {
    /* preview / private mode: the banner just stays conservative */
  }
}

export function CursorsTab({
  pakPath,
  ffmpegPath,
  cursors,
  onChange,
  accent,
}: {
  /** The game pak path from Settings - the game folder is derived from it. */
  pakPath: string;
  ffmpegPath?: string;
  cursors: CursorEntry[];
  onChange: (next: CursorEntry[]) => void;
  accent: string;
}) {
  const { push } = useToast();
  const [status, setStatus] = useState<CursorStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A pack with several looks, waiting for the user to pick one. */
  const [variants, setVariants] = useState<CursorPackVariant[] | null>(null);
  /** Natural size of each chosen image (drives the "yours" preview). */
  const [natural, setNatural] = useState<Record<string, { w: number; h: number }>>({});
  const [applied, setApplied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!pakPath) {
      setStatus(null);
      setStatusError("Set the game pak in Settings first - the cursor folder is found from it.");
      return;
    }
    try {
      const st = await cursorStatus(pakPath);
      setStatus(st);
      setStatusError(null);
      setApplied(readApplied(st.dir));
    } catch (e) {
      setStatus(null);
      setStatusError(String(e));
    }
  }, [pakPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entryOf = (slot: string) => cursors.find((c) => c.slot === slot);
  const active = useMemo(
    () => cursors.filter((c) => c.enabled !== false && !!c.sourceImage),
    [cursors],
  );
  const setEntry = (slot: SlotInfo, patch: Partial<CursorEntry>) => {
    const cur = entryOf(slot.id);
    onChange([
      ...cursors.filter((c) => c.slot !== slot.id),
      {
        slot: slot.id,
        sourceImage: "",
        height: slot.stock.h,
        hotX: slot.stockHot.x,
        hotY: slot.stockHot.y,
        enabled: true,
        ...(cur ?? {}),
        ...patch,
      },
    ]);
  };
  const removeEntry = (slot: SlotInfo) => onChange(cursors.filter((c) => c.slot !== slot.id));

  const pick = async (slot: SlotInfo) => {
    const sel = await openDialog({
      multiple: false,
      title: `Image for the ${slot.title.toLowerCase()} cursor`,
      filters: [{ name: "Image", extensions: IMAGE_EXTENSIONS }],
    });
    if (typeof sel === "string" && sel) setEntry(slot, { sourceImage: sel, enabled: true });
  };

  /** One image on every cursor (the usual "my cursor everywhere" setup). */
  const applyToAll = (from: CursorEntry) => {
    onChange(SLOTS.map((s) => ({ ...from, slot: s.id })));
    push("info", "Same image set on all four cursors");
  };

  const adopt = (v: CursorPackVariant) => {
    const next = cursors.filter((c) => !(c.slot in v.files));
    for (const s of SLOTS) {
      const src = v.files[s.id];
      if (!src) continue;
      // A pack's files are already cursor-sized: keep them pixel for pixel.
      next.push({
        slot: s.id,
        sourceImage: src,
        height: 0,
        hotX: s.stockHot.x,
        hotY: s.stockHot.y,
        enabled: true,
      });
    }
    onChange(next);
    setVariants(null);
    const n = Object.keys(v.files).length;
    push("success", `Pack loaded: ${n} cursor${n === 1 ? "" : "s"}. Click Apply to game to use them.`);
  };

  const importPack = async (folder: boolean) => {
    const sel = await openDialog(
      folder
        ? { directory: true, title: "Folder with the cursor pack" }
        : {
            multiple: false,
            title: "Cursor pack (.zip, .rar or .7z)",
            filters: [{ name: "Cursor pack", extensions: PACK_EXTENSIONS }],
          },
    );
    if (typeof sel !== "string" || !sel) return;
    setBusy("Opening the pack");
    try {
      const found = await importCursorPack(sel);
      if (found.length === 1) adopt(found[0]);
      else setVariants(found);
    } catch (e) {
      push("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy("Applying");
    try {
      const rep = await applyCursors(pakPath, ffmpegPath ?? "", cursors);
      writeApplied(rep.dir, active.length > 0 ? signature(cursors) : null);
      await refresh();
      if (rep.applied.length > 0) {
        const n = rep.applied.length;
        push(
          "success",
          `${n} cursor${n === 1 ? "" : "s"} written to the game. They show the next time Deadlock starts.`,
        );
      } else if (rep.restored.length > 0) {
        push("success", "The game's own cursors are back");
      } else {
        push("info", "Nothing to apply - choose an image for a cursor first");
      }
    } catch (e) {
      push("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("Restoring");
    try {
      const rep = await restoreCursors(pakPath);
      if (status) writeApplied(status.dir, null);
      await refresh();
      if (rep.noBackup.length > 0) {
        push(
          "error",
          `No backup for ${rep.noBackup.join(", ")}. Use Steam's "Verify integrity of game files" to get the game's originals.`,
        );
      } else if (rep.restored > 0) {
        push("success", "Original cursors are back. Your images stay here if you want them again.");
      } else {
        push("info", "Nothing to restore - the game folder has none of your cursors");
      }
    } catch (e) {
      push("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const savePack = async () => {
    const dir = await openDialog({ directory: true, title: "Save the cursor pack into which folder?" });
    if (typeof dir !== "string" || !dir) return;
    setBusy("Saving the pack");
    try {
      const sep = dir.includes("\\") ? "\\" : "/";
      const zip = await exportCursorPack(ffmpegPath ?? "", cursors, `${dir}${sep}my_cursors.zip`);
      push("success", "Cursor pack saved: my_cursors.zip", {
        label: "Show",
        onClick: () => void revealItemInDir(zip),
      });
    } catch (e) {
      push("error", String(e));
    } finally {
      setBusy(null);
    }
  };

  const statusOf = (slot: string): CursorSlotStatus | undefined =>
    status?.slots.find((s) => s.slot === slot);
  // Are the set cursors what the game folder holds right now?
  const inGame =
    active.length > 0 &&
    active.every((e) => statusOf(e.slot)?.state === "yours") &&
    applied === signature(cursors);
  const anyOurs = !!status?.slots.some((s) => s.state === "yours" || s.hasBackup);
  const wasReset = active.some((e) => statusOf(e.slot)?.state === "changed");
  const canWrite = !!status?.dirExists && !busy;

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-500">
        Give the game your own mouse cursors. Choose an image for any of the four cursors (or
        load a cursor pack someone made), set its size and where it clicks, then Apply to game.
        <span className="mt-1 block text-xs text-zinc-600">
          Cursors are loose files in the game folder, not part of your mod pak, so they are
          applied from here and not by Compile. The files they replace are backed up, and Restore
          originals puts them back. A game update or a Steam file verify resets the cursors: come
          back and Apply again.
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void apply()}
          disabled={!canWrite || (active.length === 0 && !anyOurs)}
          className="rounded-md px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: accent }}
        >
          Apply to game
        </button>
        <button onClick={() => void restore()} disabled={!canWrite || !anyOurs} className={btnCls}>
          Restore originals
        </button>
        <span className="mx-1 h-4 w-px bg-zinc-800" />
        <button onClick={() => void importPack(false)} disabled={!!busy} className={btnCls}>
          Load a cursor pack…
        </button>
        <button onClick={() => void importPack(true)} disabled={!!busy} className={btnCls}>
          From a folder…
        </button>
        <button
          onClick={() => void savePack()}
          disabled={!!busy || active.length === 0}
          className={btnCls}
          title="A zip of your cursors in the shape cursor mods are shared in"
        >
          Save as a pack…
        </button>
        {busy && <span className="text-[11px] text-zinc-400">{busy}…</span>}
      </div>

      {statusError && (
        <p className="max-w-3xl rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-200">
          {statusError}
        </p>
      )}
      {status && !status.dirExists && (
        <p className="max-w-3xl rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
          This Deadlock install has no cursor folder yet. Custom cursors need the 2026-09-29 game
          update or newer.
        </p>
      )}
      {status?.dirExists && active.length > 0 && (
        <p
          className={`max-w-3xl rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed ${
            inGame
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          {inGame
            ? "Your cursors are in the game."
            : wasReset
              ? "The game put its own cursors back (a game update or a file verify does that). Click Apply to game to use yours again."
              : "Your cursors are not in the game yet, or you changed them since. Click Apply to game."}
        </p>
      )}

      {variants && (
        <div className="max-w-3xl rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-200">
              This pack has {variants.length} looks - which one?
            </span>
            <div className="flex-1" />
            <button onClick={() => setVariants(null)} className={btnCls}>
              Cancel
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {variants.map((v) => (
              <button
                key={v.name}
                onClick={() => adopt(v)}
                className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left transition hover:border-zinc-500"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded" style={checker}>
                  {Object.values(v.files)[0] && (
                    <img
                      src={fileUrl(v.files.default ?? Object.values(v.files)[0])}
                      alt=""
                      draggable={false}
                      className="max-h-9 max-w-9"
                    />
                  )}
                </span>
                <span>
                  <span className="block text-[11px] font-medium text-zinc-200">{v.name}</span>
                  <span className="block text-[10px] text-zinc-500">
                    {Object.keys(v.files).length} cursor{Object.keys(v.files).length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {SLOTS.map((slot) => {
          const entry = entryOf(slot.id);
          const st = statusOf(slot.id);
          // The entry, once it has an image.
          const ent = entry && entry.sourceImage ? entry : undefined;
          const nat = natural[slot.id];
          // The size "yours" will be written at (mirrors target_size in cursors.rs).
          let outH = ent ? (ent.height === 0 ? (nat?.h ?? slot.stock.h) : ent.height) : 0;
          let outW = ent && nat ? (nat.w * outH) / Math.max(1, nat.h) : outH;
          if (ent) {
            if (ent.height !== 0) outH = Math.min(MAX_PX, Math.max(MIN_PX, outH));
            outW = nat ? (nat.w * outH) / Math.max(1, nat.h) : outH;
            const over = Math.max(outW / MAX_PX, outH / MAX_PX);
            if (over > 1) {
              outW /= over;
              outH /= over;
            }
          }
          const zoomYours = zoomFor(outH || slot.stock.h);
          const sizeChoices = Array.from(
            new Set([slot.stock.h, 32, 48, 64, 96, 128, ...(ent && ent.height > 0 ? [ent.height] : [])]),
          ).sort((a, b) => a - b);
          const chip =
            st?.state === "yours"
              ? { text: "yours", cls: "bg-emerald-500/15 text-emerald-300" }
              : st?.state === "changed"
                ? { text: "reset by the game", cls: "bg-amber-500/15 text-amber-300" }
                : st?.state === "missing"
                  ? { text: "missing", cls: "bg-red-500/15 text-red-300" }
                  : st
                    ? { text: "game default", cls: "bg-zinc-700/40 text-zinc-400" }
                    : null;
          return (
            <section key={slot.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-200">{slot.title}</h3>
                <span className="text-[10px] text-zinc-600">{slot.file}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-zinc-500">{slot.blurb}</p>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <div
                    className="flex items-center justify-center overflow-hidden rounded-md"
                    style={{ ...checker, height: BOX }}
                  >
                    {st?.preview ? (
                      <img
                        src={fileUrl(st.preview)}
                        alt={`${slot.title} in the game now`}
                        draggable={false}
                        style={{
                          height: st.height * zoomFor(st.height),
                          imageRendering: "pixelated",
                        }}
                      />
                    ) : (
                      <span className="text-[10px] text-zinc-400">no file</span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                    <span>In game now</span>
                    {chip && <span className={`rounded px-1 font-medium ${chip.cls}`}>{chip.text}</span>}
                    <div className="flex-1" />
                    {st?.exists && (
                      <span>
                        {st.width}x{st.height}
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <div
                    className="relative flex items-center justify-center overflow-hidden rounded-md"
                    style={{ ...checker, height: BOX }}
                  >
                    {ent ? (
                      <div
                        className="relative cursor-crosshair"
                        title="Click where this cursor should click"
                        onClick={(ev) => {
                          const r = ev.currentTarget.getBoundingClientRect();
                          setEntry(slot, {
                            hotX: Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width))),
                            hotY: Math.min(1, Math.max(0, (ev.clientY - r.top) / Math.max(1, r.height))),
                          });
                        }}
                      >
                        <img
                          src={fileUrl(ent.sourceImage)}
                          alt={`Your ${slot.title.toLowerCase()} cursor`}
                          draggable={false}
                          onLoad={(ev) => {
                            const im = ev.currentTarget;
                            setNatural((n) => ({
                              ...n,
                              [slot.id]: { w: im.naturalWidth, h: im.naturalHeight },
                            }));
                          }}
                          style={{
                            height: Math.max(8, outH * zoomYours),
                            width: nat ? Math.max(8, outW * zoomYours) : undefined,
                            display: "block",
                          }}
                        />
                        {/* The click point: a ring with a dot, readable on any art. */}
                        <span
                          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.9)]"
                          style={{ left: `${ent.hotX * 100}%`, top: `${ent.hotY * 100}%` }}
                        >
                          <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
                        </span>
                      </div>
                    ) : (
                      <button
                        onClick={() => void pick(slot)}
                        className="h-full w-full text-[11px] font-medium text-zinc-200 transition hover:bg-black/20"
                      >
                        ＋ choose an image
                      </button>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                    <span>Yours</span>
                    <div className="flex-1" />
                    {ent && nat && (
                      <span>
                        {Math.round(outW)}x{Math.round(outH)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {ent && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                    Size
                    <select
                      value={String(ent.height)}
                      onChange={(e) => setEntry(slot, { height: Number(e.target.value) })}
                      className={selectCls}
                    >
                      {sizeChoices.map((h) => (
                        <option key={h} value={h}>
                          {h === slot.stock.h ? `${h} px tall (game size)` : `${h} px tall`}
                        </option>
                      ))}
                      <option value="0">The image's own size</option>
                    </select>
                  </label>
                  <button
                    onClick={() => setEntry(slot, { hotX: slot.stockHot.x, hotY: slot.stockHot.y })}
                    className={btnCls}
                    title="Put the click point back where the game's own cursor has it"
                  >
                    Reset click point
                  </button>
                  <button onClick={() => void pick(slot)} className={btnCls}>
                    Change…
                  </button>
                  <button onClick={() => applyToAll(ent)} className={btnCls}>
                    Use for all
                  </button>
                  <button onClick={() => removeEntry(slot)} className={btnCls}>
                    ✕ Remove
                  </button>
                  <p className="basis-full text-[10px] text-zinc-600">
                    Click point: {Math.round(ent.hotX * 100)}% across, {Math.round(ent.hotY * 100)}%
                    down. Click the image to move it.
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {status?.dirExists && (
        <p className="text-[10px] text-zinc-600">
          Game cursor folder:{" "}
          <button
            onClick={() => void revealItemInDir(`${status.dir}${status.dir.includes("\\") ? "\\" : "/"}cursor.bmp`)}
            className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
          >
            {status.dir}
          </button>
        </p>
      )}
    </div>
  );
}
