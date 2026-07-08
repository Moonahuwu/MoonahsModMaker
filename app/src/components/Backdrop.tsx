import { useEffect, useRef, useState } from "react";

/**
 * Animated background layer behind the main content area (the opaque left
 * sidebar paints over it, so it only shows through the content pane).
 *
 * The sigil: the user's recreation of the game's pattern, two SVGs in
 * `app/public/backdrop/` sharing one square canvas + center point:
 *   - outer.svg — big triangle + circle + node dots
 *   - inner.svg — inscribed triangle
 * They're fetched and INLINED (not CSS masks — masks fail silently) with
 * white rewritten to currentColor so the active tab's accent tints them.
 *
 * Motion is a JS driver (not CSS keyframes) because switching category
 * gives the spin a kick that eases back to cruise speed — velocity-based
 * animation isn't expressible in keyframes. Outer turns counter-clockwise
 * with a slow horizontal drift; the inner triangle counter-rotates slower.
 * Sits right-of-center like the in-game loading screen.
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

/** Cruise speed: one outer revolution every ~3 minutes. */
const BASE_DEG_PER_SEC = 360 / 180;
/** Category-switch kick: spin speeds up by this factor, then eases back. */
const KICK = 7;

export function Backdrop({ accent = "#34d399" }: { accent?: string }) {
  const outer = useSigilSvg("outer.svg");
  const inner = useSigilSvg("inner.svg");
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef(KICK); // boots with a kick too — settles on its own

  // Every category switch nudges the spin, which then fades back to cruise.
  useEffect(() => {
    speedRef.current = Math.min(speedRef.current + KICK, KICK * 1.5);
  }, [accent]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let angle = 0; // outer rotation, degrees (applied negative = ccw)
    const tick = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.1);
      last = t;
      // Exponential ease back toward cruise speed (~2.5s to settle).
      speedRef.current += (1 - speedRef.current) * Math.min(1, dt * 1.2);
      angle += BASE_DEG_PER_SEC * speedRef.current * dt;
      // Slow horizontal sway tied to the rotation phase.
      const drift = Math.sin((angle * Math.PI) / 360) * -4;
      if (outerRef.current) {
        outerRef.current.style.transform = `translate(-50%, -50%) translateX(${drift.toFixed(3)}vmin) rotate(${(-angle).toFixed(3)}deg)`;
      }
      if (innerRef.current) {
        innerRef.current.style.transform = `translate(-50%, -50%) rotate(${(angle * 0.7).toFixed(3)}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
          ref={outerRef}
          className="eim-sigil"
          style={layerStyle}
          dangerouslySetInnerHTML={{ __html: outer }}
        />
      )}
      {inner && (
        <div
          ref={innerRef}
          className="eim-sigil"
          style={layerStyle}
          dangerouslySetInnerHTML={{ __html: inner }}
        />
      )}
    </div>
  );
}
