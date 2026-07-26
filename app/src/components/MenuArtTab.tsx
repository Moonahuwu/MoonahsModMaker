import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { decodePakTexture } from "../lib/api";
import type { IconMod } from "../types";
import { useToast } from "./Toaster";

/**
 * Menu Art: replace the game's screen art (play-mode cards, portraits, menu
 * rows - any panorama image) with your own PNGs. Entries ride the existing
 * icon_mods pipeline: PNG -> compiled vtex_c staged at the vanilla path, so
 * there is no new compile machinery behind this tab.
 */
interface MenuSlot {
  slug: string;
  label: string;
  hint?: string;
  /** Internal texture path (without the panorama/images prefix). */
  path: string;
  w: number;
  h: number;
}
interface MenuGroup {
  label: string;
  hint: string;
  slots: MenuSlot[];
}

/** Curated slots, dims measured from the live pak (2026-07-26 patch). */
const GROUPS: MenuGroup[] = [
  {
    label: "Play page cards",
    hint: "The big mode cards on the Play screen",
    slots: [
      { slug: "card_play", label: "Main mode card", path: "main_menu/play/card_play_psd", w: 1546, h: 2113 },
      { slug: "card_play_subject", label: "Main mode portrait", hint: "the Geist art on the card", path: "main_menu/play/card_play_subject_psd", w: 1546, h: 2113 },
      { slug: "card_brawl", label: "Street Brawl card", path: "main_menu/play/card_brawl_psd", w: 1298, h: 2113 },
      { slug: "card_brawl_subject", label: "Street Brawl portrait", hint: "the Lash art on the card", path: "main_menu/play/card_brawl_subject_psd", w: 1546, h: 2113 },
      { slug: "card_bots_subject", label: "Bots portrait", path: "main_menu/play/card_bots_subject_sm_psd", w: 1112, h: 1100 },
      { slug: "card_custom", label: "Custom match card", path: "main_menu/play/card_custom_psd", w: 610, h: 852 },
      { slug: "card_custom_subject", label: "Custom match portrait", path: "main_menu/play/card_custom_subject_psd", w: 610, h: 852 },
      { slug: "card_map", label: "Explore map card", path: "main_menu/play/card_map_psd", w: 612, h: 862 },
      { slug: "card_map_subject", label: "Explore map portrait", path: "main_menu/play/card_map_subject_psd", w: 612, h: 862 },
      { slug: "card_sandbox", label: "Sandbox card", path: "main_menu/play/card_sandbox_psd", w: 616, h: 892 },
      { slug: "card_sandbox_subject", label: "Sandbox portrait", path: "main_menu/play/card_sandbox_subject_psd", w: 616, h: 892 },
      { slug: "card_tutorial", label: "Tutorial card", path: "main_menu/play/card_tutorial_psd", w: 1916, h: 855 },
      { slug: "select_play_mode", label: "\"Select play mode\" banner", path: "main_menu/temp/select_play_mode_psd", w: 2000, h: 300 },
    ],
  },
  {
    label: "Play menu rows",
    hint: "The compact list version of the play menu",
    slots: [
      { slug: "menu_deadlock", label: "Deadlock (main mode)", path: "main_menu/menu_images/menu_play_deadlock_psd", w: 513, h: 663 },
      { slug: "menu_playersbots", label: "Players vs bots", path: "main_menu/menu_images/menu_play_playersbots_psd", w: 513, h: 663 },
      { slug: "menu_custom", label: "Custom match", path: "main_menu/menu_images/menu_play_custom_match_horizontal_psd", w: 495, h: 329 },
      { slug: "menu_exploremap", label: "Explore map", path: "main_menu/menu_images/menu_play_exploremap_psd", w: 495, h: 329 },
      { slug: "menu_privatebots", label: "Private bots", path: "main_menu/menu_images/menu_play_privatebots_horizontal_psd", w: 495, h: 329 },
      { slug: "menu_sandbox", label: "Sandbox", path: "main_menu/menu_images/menu_play_sandbox_horizontal_psd", w: 495, h: 329 },
    ],
  },
];

const IMAGE_FILTERS = [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }];

const targetOf = (path: string) => `panorama/images/${path}.vtex_c`;
const idOf = (slug: string) => `menuart_${slug}`;

/** convertFileSrc throws outside Tauri (browser preview) - degrade to none. */
function fileSrc(p: string): string {
  try {
    return convertFileSrc(p);
  } catch {
    return "";
  }
}

export function MenuArtTab({
  helperPath,
  pakPath,
  iconMods,
  accent,
  onChange,
}: {
  helperPath: string;
  pakPath: string;
  iconMods: IconMod[];
  accent: string;
  onChange: (next: IconMod[]) => void;
}) {
  const { push } = useToast();
  // Vanilla previews, decoded lazily from the pak and cached in app-data.
  const [previews, setPreviews] = useState<Record<string, string | "loading" | "error">>({});

  useEffect(() => {
    if (!helperPath || !pakPath) return;
    let cancelled = false;
    (async () => {
      for (const g of GROUPS) {
        for (const s of g.slots) {
          if (cancelled) return;
          setPreviews((p) => (p[s.path] ? p : { ...p, [s.path]: "loading" }));
          try {
            const d = await decodePakTexture(helperPath, pakPath, targetOf(s.path));
            if (!cancelled) setPreviews((p) => ({ ...p, [s.path]: d.png }));
          } catch {
            if (!cancelled) setPreviews((p) => ({ ...p, [s.path]: "error" }));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helperPath, pakPath]);

  const modFor = (slot: MenuSlot) =>
    iconMods.find((m) => m.id === idOf(slot.slug) || m.targetVtexc === targetOf(slot.path));

  async function replaceSlot(slot: MenuSlot) {
    const picked = await openDialog({ multiple: false, filters: IMAGE_FILTERS });
    if (typeof picked !== "string") return;
    const next = iconMods.filter(
      (m) => m.id !== idOf(slot.slug) && m.targetVtexc !== targetOf(slot.path),
    );
    next.push({
      id: idOf(slot.slug),
      name: `Menu art: ${slot.label}`,
      targetVtexc: targetOf(slot.path),
      sourceImage: picked,
      width: slot.w,
      height: slot.h,
      hue: 0,
      enabled: true,
    });
    onChange(next);
    push("success", `${slot.label} will compile with your image`);
  }

  function clearSlot(slot: MenuSlot) {
    onChange(
      iconMods.filter((m) => m.id !== idOf(slot.slug) && m.targetVtexc !== targetOf(slot.path)),
    );
  }

  // Power-user row: replace ANY panorama image by its internal path.
  const [customPath, setCustomPath] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const customMods = iconMods.filter(
    (m) =>
      m.id.startsWith("menuart_custom_") ||
      (m.id.startsWith("menuart_") &&
        !GROUPS.some((g) => g.slots.some((s) => m.id === idOf(s.slug)))),
  );

  async function addCustom() {
    let p = customPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p) return;
    if (!p.startsWith("panorama/")) p = `panorama/images/${p}`;
    p = p.replace(/\.vtex(_c)?$/, "");
    const target = `${p}.vtex_c`;
    setCustomBusy(true);
    try {
      // Validate against the pak and grab the vanilla dimensions in one go.
      const d = await decodePakTexture(helperPath, pakPath, target);
      const picked = await openDialog({ multiple: false, filters: IMAGE_FILTERS });
      if (typeof picked !== "string") return;
      const slug = `custom_${p.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      const next = iconMods.filter((m) => m.id !== idOf(slug) && m.targetVtexc !== target);
      next.push({
        id: idOf(slug),
        name: `Menu art: ${p.split("/").pop()}`,
        targetVtexc: target,
        sourceImage: picked,
        width: d.width,
        height: d.height,
        hue: 0,
        enabled: true,
      });
      onChange(next);
      setCustomPath("");
      push("success", `${target} will compile with your image (${d.width}x${d.height})`);
    } catch (e) {
      push("error", `Couldn't find that texture in the game files: ${e}`);
    } finally {
      setCustomBusy(false);
    }
  }

  const slotCard = (slot: MenuSlot) => {
    const mod = modFor(slot);
    const prev = previews[slot.path];
    const shown =
      (mod ? fileSrc(mod.sourceImage) : typeof prev === "string" ? fileSrc(prev) : null) || null;
    return (
      <div
        key={slot.slug}
        className="group flex flex-col overflow-hidden rounded-lg border bg-zinc-950/60 transition-colors"
        style={{ borderColor: mod ? `${accent}66` : "#27272a" }}
      >
        <div
          className="relative w-full overflow-hidden bg-zinc-900"
          style={{ aspectRatio: `${slot.w} / ${slot.h}`, maxHeight: "14rem" }}
          title={`${targetOf(slot.path)} (${slot.w}x${slot.h})`}
        >
          {shown ? (
            <img src={shown} className="h-full w-full object-contain" alt="" loading="lazy" />
          ) : prev === "error" ? (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-600">
              no preview
            </div>
          ) : (
            <div className="h-full w-full animate-pulse bg-zinc-900" />
          )}
          {mod && (
            <span
              className="absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{ background: accent, color: "#0c1a18" }}
            >
              replaced
            </span>
          )}
          <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => void replaceSlot(slot)}
              className="rounded bg-black/70 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700"
            >
              {mod ? "swap" : "replace…"}
            </button>
            {mod && (
              <button
                onClick={() => clearSlot(slot)}
                title="Back to the vanilla image"
                className="rounded bg-black/70 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/20"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div className="p-2">
          <span className="block truncate text-xs font-semibold text-zinc-200">{slot.label}</span>
          <span className="block truncate text-[10px] text-zinc-600">
            {slot.hint ?? `${slot.w}x${slot.h}`}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map((g) => (
        <div key={g.label} className="rounded-xl border border-zinc-800 bg-zinc-900/40">
          <div className="flex items-center gap-3 border-b border-zinc-800/70 px-4 py-2.5">
            <h3 className="text-sm font-semibold text-zinc-100">{g.label}</h3>
            <span className="text-[11px] text-zinc-500">{g.hint}</span>
          </div>
          <div className="grid gap-3 p-3 [grid-template-columns:repeat(auto-fill,minmax(10rem,1fr))]">
            {g.slots.map(slotCard)}
          </div>
        </div>
      ))}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-semibold text-zinc-100">Any other menu image</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Every screen in the game is built from images under{" "}
          <span className="font-mono">panorama/images/</span> - paste any texture path (find them
          with Source 2 Viewer or the Decompile tool) and drop your art on it. Dimensions come
          from the vanilla file automatically.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addCustom()}
            placeholder="main_menu/play/card_play_psd  (or a full panorama/images/... path)"
            spellCheck={false}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
          />
          <button
            onClick={() => void addCustom()}
            disabled={customBusy || !customPath.trim()}
            style={{ borderColor: `${accent}66`, color: accent }}
            className="rounded-md border px-3 py-1.5 text-xs transition hover:brightness-125 disabled:opacity-40"
          >
            {customBusy ? "Checking…" : "Pick image…"}
          </button>
        </div>
        {customMods.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {customMods.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-300" title={m.targetVtexc}>
                  {m.targetVtexc}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
                  {m.width}x{m.height}
                </span>
                <button
                  onClick={() => onChange(iconMods.filter((x) => x.id !== m.id))}
                  className="shrink-0 rounded px-1.5 text-red-400/80 transition hover:bg-red-500/10 hover:text-red-300"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-600">
        Replacements compile into your mod like any icon: your image is fitted to the vanilla
        texture's size and staged at the game's own path. Portrait "subject" slots are alpha
        cutouts - art with transparency keeps the card's silhouette look.
      </p>
    </div>
  );
}
