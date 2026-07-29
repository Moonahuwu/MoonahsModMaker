import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { decodePakTexture, listVpkTextures, vaultFile } from "../lib/api";
import type { ModTextureOverride } from "../types";
import { useToast } from "./Toaster";

const IMAGE_FILTERS = [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }];

/** Swap textures inside one bundled mod vpk: pick any of its compiled
 *  textures, drop your art on it (or hue-shift the mod's own), and the
 *  combined build ships your version at the mod's exact internal path. */
export function ModRetexture({
  modVpk,
  modName,
  helperPath,
  overrides,
  onChange,
  onClose,
}: {
  modVpk: string;
  modName: string;
  helperPath: string;
  /** ALL mod texture overrides (every mod); this dialog edits its own mod's. */
  overrides: ModTextureOverride[];
  onChange: (next: ModTextureOverride[]) => void;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [textures, setTextures] = useState<string[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ png: string; w: number; h: number } | null>(null);

  const mine = useMemo(
    () => overrides.filter((o) => o.modVpk === modVpk),
    [overrides, modVpk],
  );
  const current = selected ? mine.find((o) => o.internalPath === selected) : undefined;

  useEffect(() => {
    let cancelled = false;
    listVpkTextures(helperPath, modVpk)
      .then((t) => {
        if (!cancelled) setTextures(t);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [helperPath, modVpk]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    decodePakTexture(helperPath, modVpk, selected)
      .then((d) => {
        if (!cancelled) setPreview({ png: d.png, w: d.width, h: d.height });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [helperPath, modVpk, selected]);

  const shown = useMemo(() => {
    if (!textures) return [];
    const q = query.trim().toLowerCase();
    const list = q ? textures.filter((t) => t.toLowerCase().includes(q)) : textures;
    return list.slice(0, 400);
  }, [textures, query]);

  function upsert(patch: Partial<ModTextureOverride>) {
    if (!selected) return;
    const existing = mine.find((o) => o.internalPath === selected);
    const rest = overrides.filter(
      (o) => !(o.modVpk === modVpk && o.internalPath === selected),
    );
    const base: ModTextureOverride = existing ?? {
      id: `modtex_${Math.abs([...`${modVpk}|${selected}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`,
      modVpk,
      internalPath: selected,
      label: selected.split("/").pop()?.replace(/\.vtex_c$/, "") ?? selected,
      sourceImage: null,
      hue: 0,
    };
    onChange([...rest, { ...base, ...patch, lastCompiledHash: null }]);
  }

  async function pickArt() {
    const sel = await openDialog({ multiple: false, filters: IMAGE_FILTERS, title: "Which image goes on this texture?" });
    if (typeof sel !== "string") return;
    try {
      const vaulted = await vaultFile(sel);
      upsert({ sourceImage: vaulted });
    } catch (e) {
      push("error", `Couldn't copy the image into the app: ${e}`);
    }
  }

  function removeOverride(internalPath: string) {
    onChange(overrides.filter((o) => !(o.modVpk === modVpk && o.internalPath === internalPath)));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[82vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">
              Retexture: {modName}
            </h2>
            <p className="text-[11px] text-zinc-500">
              Pick a texture inside this mod, then drop your image on it or hue-shift it. Your
              version ships in the combined build in place of the mod's.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </header>

        {mine.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-zinc-800/70 px-5 py-2">
            {mine.map((o) => (
              <button
                key={o.internalPath}
                onClick={() => setSelected(o.internalPath)}
                title={o.internalPath}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                  selected === o.internalPath
                    ? "border-teal-500/60 bg-teal-500/10 text-teal-200"
                    : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                }`}
              >
                {o.label}
                {o.sourceImage ? " · art" : ""}
                {Math.abs(o.hue) > 0.01 ? ` · hue ${o.hue > 0 ? "+" : ""}${Math.round(o.hue)}` : ""}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    removeOverride(o.internalPath);
                  }}
                  title="Remove this swap"
                  className="text-zinc-500 hover:text-red-300"
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex w-1/2 min-w-0 flex-col border-r border-zinc-800/70">
            <div className="p-3 pb-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter textures (e.g. color, body, skin)"
                spellCheck={false}
                className="w-full rounded-md border border-zinc-700/80 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-teal-500/70"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {textures === null && !loadErr && (
                <p className="px-1 py-2 text-xs text-zinc-500">Reading the mod's textures…</p>
              )}
              {loadErr && <p className="px-1 py-2 text-xs text-red-300">{loadErr}</p>}
              {textures !== null && textures.length === 0 && (
                <p className="px-1 py-2 text-xs text-zinc-500">
                  No textures in this mod (sound-only packs have none).
                </p>
              )}
              {shown.map((t) => {
                const has = mine.some((o) => o.internalPath === t);
                return (
                  <button
                    key={t}
                    onClick={() => setSelected(t)}
                    title={t}
                    className={`block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] transition ${
                      selected === t
                        ? "bg-teal-500/15 text-teal-200"
                        : has
                          ? "text-teal-300/80 hover:bg-zinc-800"
                          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    {has ? "● " : ""}
                    {t}
                  </button>
                );
              })}
              {textures !== null && shown.length === 400 && (
                <p className="px-1 py-2 text-[10px] text-zinc-600">
                  Showing the first 400 - narrow it down with the filter.
                </p>
              )}
            </div>
          </div>

          <div className="flex w-1/2 min-w-0 flex-col gap-3 p-4">
            {!selected ? (
              <p className="m-auto max-w-[26ch] text-center text-xs text-zinc-600">
                Select a texture on the left to preview and replace it.
              </p>
            ) : (
              <>
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-[conic-gradient(#27272a_90deg,#18181b_90deg_180deg,#27272a_180deg_270deg,#18181b_270deg)] bg-[length:16px_16px]">
                  {current?.sourceImage ? (
                    <img
                      src={convertFileSrc(current.sourceImage)}
                      className="max-h-full max-w-full object-contain"
                      alt=""
                    />
                  ) : preview ? (
                    <img
                      src={convertFileSrc(preview.png)}
                      className="max-h-full max-w-full object-contain"
                      style={
                        current && Math.abs(current.hue) > 0.01
                          ? { filter: `hue-rotate(${current.hue}deg)` }
                          : undefined
                      }
                      alt=""
                    />
                  ) : (
                    <span className="text-xs text-zinc-600">decoding…</span>
                  )}
                </div>
                <div className="text-[10px] text-zinc-600">
                  <span className="truncate font-mono">{selected}</span>
                  {preview && (
                    <span className="ml-2">
                      {preview.w}x{preview.h}
                    </span>
                  )}
                  {current?.sourceImage && (
                    <span className="ml-2 text-teal-300/80">showing your image</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void pickArt()}
                    className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-500/20"
                  >
                    {current?.sourceImage ? "Change image…" : "Use my image…"}
                  </button>
                  {current?.sourceImage && (
                    <button
                      onClick={() => upsert({ sourceImage: null })}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
                    >
                      Back to mod's art
                    </button>
                  )}
                </div>
                <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                  Hue
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={current?.hue ?? 0}
                    onChange={(e) => upsert({ hue: Number(e.target.value) })}
                    className="flex-1 accent-teal-500"
                  />
                  <span className="w-10 text-right tabular-nums text-zinc-300">
                    {Math.round(current?.hue ?? 0)}
                  </span>
                  {current && Math.abs(current.hue) > 0.01 && (
                    <button
                      onClick={() => upsert({ hue: 0 })}
                      className="text-zinc-500 hover:text-zinc-200"
                      title="Reset hue"
                    >
                      ↺
                    </button>
                  )}
                </label>
                <p className="text-[10px] text-zinc-600">
                  The hue preview is approximate - the compile applies it exactly. Your image is
                  stretched to the texture's size so the model's UVs line up.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
