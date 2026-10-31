// WebKitGTK (Tauri on Linux) can't stream media from the asset:// scheme:
// `audio.play()` resolves but stays silent (or fires `error`). Images work
// because they're fetched whole, so for audio we fetch the bytes the same way
// and hand the element an in-memory blob: URL. Other platforms pass through.

const isLinux = typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent);

/** A URL a media element can actually play, from an already-converted
 *  `convertFileSrc(...)` URL. Callers that replace the URL later should
 *  `releaseMediaUrl` the old one. */
export async function playableSrc(assetUrl: string): Promise<string> {
  if (!isLinux || assetUrl.startsWith("blob:")) return assetUrl;
  try {
    const res = await fetch(assetUrl);
    if (!res.ok) return assetUrl;
    return URL.createObjectURL(await res.blob());
  } catch {
    return assetUrl;
  }
}

/** Free a blob: URL made by `playableSrc` (no-op for anything else). */
export function releaseMediaUrl(url: string | undefined | null): void {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}
