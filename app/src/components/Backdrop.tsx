/**
 * Animated background layer behind the main content area (the opaque left
 * sidebar paints over it, so it only shows through the content pane).
 *
 * The current look is a PLACEHOLDER: two ultra-slow drifting glows over the
 * app's dark base + a soft vignette, subtle enough to sit behind text. To
 * swap in the game-style animation, replace the inner markup with the asset
 * (a looping <video muted autoPlay loop>, an <img> of an animated texture, or
 * more CSS layers) — keep `pointer-events-none` and the root classes so it
 * never intercepts clicks or scrolls. Styles live in App.css ("eim-bg-*").
 */
export function Backdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ background: "#09090b" }}
    >
      <div className="eim-bg-glow eim-bg-glow-a" />
      <div className="eim-bg-glow eim-bg-glow-b" />
      <div className="eim-bg-vignette" />
    </div>
  );
}
