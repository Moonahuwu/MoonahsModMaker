/**
 * Animated background layer behind the main content area (the opaque left
 * sidebar paints over it, so it only shows through the content pane).
 *
 * The sigil: the user's recreation of the game's pattern, shipped as TWO
 * white-on-transparent SVGs in `app/public/backdrop/` sharing one square
 * canvas + center point:
 *   - outer.svg  — big triangle + circle + node dots (spins one way, drifts)
 *   - inner.svg  — inscribed triangle (counter-rotates, slower)
 * Both render as CSS masks painted with the active tab's accent, so every
 * category tints the pattern its own color. Missing files are harmless (the
 * mask is empty → just the dark base + glows show).
 */
export function Backdrop({ accent = "#34d399" }: { accent?: string }) {
  const layer = (file: string): React.CSSProperties => ({
    WebkitMaskImage: `url(/backdrop/${file})`,
    maskImage: `url(/backdrop/${file})`,
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    backgroundColor: accent,
    // The tint fades between tabs instead of snapping.
    transition: "background-color 1.2s ease",
  });
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ background: "#09090b" }}
    >
      <div className="eim-bg-glow eim-bg-glow-a" />
      <div className="eim-bg-glow eim-bg-glow-b" />
      {/* Sigil layers: oversized square centered in the pane so the spin
          never reveals edges; opacity keeps it behind text. */}
      <div className="eim-bg-vignette" />
      {/* Sigil above the vignette so its lines aren't dimmed. */}
      <div className="eim-sigil eim-sigil-outer" style={layer("outer.svg")} />
      <div className="eim-sigil eim-sigil-inner" style={layer("inner.svg")} />
    </div>
  );
}
