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

/** Fetch + prep one sigil svg: white → currentColor, fills the layer box.
 *  Editor exports carry `<style>` blocks with generic class names (.cls-1…)
 *  — inlined SVG styles are DOCUMENT-global, so two files' identical class
 *  names clobber each other (that ate the inner triangle's vertex dots).
 *  Namespacing the classes per file keeps each sheet to itself. */
function useSigilSvg(file: string): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const ns = file.replace(/\W/g, "");
    fetch(`/backdrop/${file}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (!live) return;
        const prepped = text
          .replace(/#fff\b|#ffffff\b|white\b/gi, "currentColor")
          .replace(/cls-/g, `${ns}-cls-`)
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
/** While a compile runs the spin cruises at this multiple (with a soft glow),
 *  easing back to 1 when the run ends. */
const BUSY_CRUISE = 3;

export function Backdrop({ accent = "#34d399", busy = false }: { accent?: string; busy?: boolean }) {
  const outer = useSigilSvg("outer.svg");
  const inner = useSigilSvg("inner.svg");
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef(KICK); // boots with a kick too - settles on its own
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
      // Exponential ease toward cruise speed (~2.5s to settle) - a compile
      // in flight cruises faster until it's done.
      const target = busyRef.current ? BUSY_CRUISE : 1;
      speedRef.current += (target - speedRef.current) * Math.min(1, dt * 1.2);
      angle += BASE_DEG_PER_SEC * speedRef.current * dt;
      // Slow horizontal sway tied to the rotation phase — applied to BOTH
      // layers so the triangle never slides out of its circle (only the
      // rotations differ between them).
      const drift = Math.sin((angle * Math.PI) / 360) * -3;
      const sway = `translateX(${drift.toFixed(3)}vh)`;
      if (outerRef.current) {
        outerRef.current.style.transform = `${sway} rotate(${(-angle).toFixed(3)}deg)`;
      }
      if (innerRef.current) {
        innerRef.current.style.transform = `${sway} rotate(${(angle * 0.7).toFixed(3)}deg)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const layerStyle: React.CSSProperties = {
    color: accent,
    // Tint crossfades between tabs; the compile glow fades in and out.
    transition: "color 1.2s ease, filter 1.2s ease",
    filter: busy ? "drop-shadow(0 0 16px currentColor)" : "drop-shadow(0 0 0px transparent)",
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
      {/* Sigil above the vignette so its lines aren't dimmed: ONE positioned
          wrapper (geometry in .eim-sigil), two spinning layers inside. */}
      <div className="eim-sigil" style={layerStyle}>
        {outer && (
          <div
            ref={outerRef}
            className="eim-sigil-layer"
            dangerouslySetInnerHTML={{ __html: outer }}
          />
        )}
        {inner && (
          <div
            ref={innerRef}
            className="eim-sigil-layer"
            dangerouslySetInnerHTML={{ __html: inner }}
          />
        )}
      </div>
    </div>
  );
}
