import { useState } from "react";
import { copyToDownloads } from "../lib/api";
import { useToast } from "./Toaster";

/** Saves a decoded game image (an app-data cache PNG) into Downloads under a
 *  readable name, for people who just want the original art as a reference.
 *  `overlay` = a small corner button that shows on hover of a `group` parent. */
export function SaveImageButton({
  path,
  name,
  folder,
  overlay,
  className,
}: {
  path: string | null | undefined;
  name: string;
  folder?: string;
  overlay?: boolean;
  className?: string;
}) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  if (!path) return null;
  async function save(e: React.MouseEvent) {
    // Tiles are often buttons themselves (open / select) - don't trigger them.
    e.stopPropagation();
    e.preventDefault();
    setBusy(true);
    try {
      const dest = await copyToDownloads(path!, name, folder);
      push("success", `Saved to ${dest}`);
    } catch (err) {
      push("error", `Download failed: ${err}`);
    } finally {
      setBusy(false);
    }
  }
  // `className` sizes the inline variant (replaces the small default, so
  // padding/text/radius classes never fight).
  const cls = overlay
    ? "absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-950/85 text-[12px] text-zinc-300 opacity-0 transition group-hover:opacity-100 hover:border-zinc-400 hover:text-white focus:opacity-100"
    : `shrink-0 border border-zinc-700 text-zinc-300 transition hover:border-zinc-500 ${className ?? "rounded px-1.5 text-[10px]"}`;
  return (
    <button
      type="button"
      onClick={save}
      disabled={busy}
      title="Save the original image to Downloads"
      className={`${cls} ${busy ? "opacity-60" : ""}`}
    >
      {overlay ? "⤓" : "⤓ Save"}
    </button>
  );
}

/** Save several images into one Downloads subfolder (one toast at the end). */
export async function saveImagesToFolder(
  items: { path: string; name: string }[],
  folder: string,
  push: (kind: "info" | "success" | "error", text: string) => void,
) {
  let ok = 0;
  let last = "";
  for (const it of items) {
    try {
      last = await copyToDownloads(it.path, it.name, folder);
      ok++;
    } catch {
      /* counted below */
    }
  }
  const dir = last.replace(/[\\/][^\\/]*$/, "");
  const fail = items.length - ok;
  push(
    ok > 0 ? "success" : "error",
    `Saved ${ok} image${ok === 1 ? "" : "s"}${fail > 0 ? `, ${fail} failed` : ""}${dir ? ` to ${dir}` : ""}`,
  );
}
