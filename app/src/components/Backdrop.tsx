import { useEffect, useState } from "react";

/**
 * Animated background layer behind the main content area (the opaque left
 * sidebar paints over it, so it only shows through the content pane).
 *
 * The sigil: the user's recreation of the game's pattern, two SVGs in
 * `app/public/backdrop/` sharing one square canvas + center point:
 *   - outer.svg — big triangle + circle + node dots (spins one way, drifts)
 *   - inner.svg — inscribed triangle (counter-rotates, slower)
 * They're fetched and INLINED (not CSS masks — masks fail silently) with
 * their white fills/strokes rewritten to currentColor, so the active tab's
 * accent tints them and crossfades between tabs. Missing files = layer
 * simply absent.
 */

/** Fetch + prep one sigil svg: white → currentColor, fills the layer box. */
function useSigilSvg(file: string): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/backdrop/${file}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (!live) return;
        const prepped = text
          .replace(/#fff\b|#ffffff\b|white\b/gi, "currentColor")
          .replace("<svg ", '<svg width="100%" height="100%" ');
        setSvg(prepped);
      })
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [file]);
  return svg;
}

export function Backdrop({ accent = "#34d399" }: { accent?: string }) {
  const outer = useSigilSvg("outer.svg");
  const inner = useSigilSvg("inner.svg");
  const layerStyle: React.CSSProperties = {
    color: accent,
    transition: "color 1.2s ease", // tint crossfades between tabs
  };
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ background: "#09090b" }}
    >
      <div className="eim-bg-glow eim-bg-glow-a" />
      <div className="eim-bg-glow eim-bg-glow-b" />
      <div className="eim-bg-vignette" />
      {/* Sigil above the vignette so its lines aren't dimmed. */}
      {outer && (
        <div
          className="eim-sigil eim-sigil-outer"
          style={layerStyle}
          dangerouslySetInnerHTML={{ __html: outer }}
        />
      )}
      {inner && (
        <div
          className="eim-sigil eim-sigil-inner"
          style={layerStyle}
          dangerouslySetInnerHTML={{ __html: inner }}
        />
      )}
    </div>
  );
}
