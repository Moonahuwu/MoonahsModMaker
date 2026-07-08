import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  computeProps,
  labelText,
  parseCss,
  parseLayout,
  toCss,
  type Flow,
  type PNode,
  type PRule,
} from "../lib/panorama";

/**
 * Approximate live render of a panorama layout + styles (UI Master preview).
 * 1920×1080 design space scaled to fit; hover any element to see its
 * identity. Deliberately rough: no game data, no scripts, no textures.
 */
export function PanoramaPreview({ xml, cssSources }: { xml: string; cssSources: string[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.4);
  const [hover, setHover] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.max(0.05, el.clientWidth / 1920));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tree = useMemo(() => parseLayout(xml), [xml]);
  const rules = useMemo<PRule[]>(() => cssSources.flatMap((s) => parseCss(s)), [cssSources]);

  function renderNode(node: PNode, chain: PNode[], parentFlow: Flow, path: string): React.ReactNode {
    const fullChain = [...chain, node];
    const props = computeProps(fullChain, rules);
    const { style, flow, hidden } = toCss(props, parentFlow);
    if (hidden) return null;
    const label = node.tag.toLowerCase() === "label";
    const ident = `${node.tag}${node.id ? `#${node.id}` : ""}${node.classes.length ? "." + node.classes.join(".") : ""}`;
    return (
      <div
        key={path}
        style={style}
        onMouseEnter={(e) => {
          e.stopPropagation();
          setHover(ident);
        }}
        onMouseLeave={(e) => {
          e.stopPropagation();
          setHover(null);
        }}
        className="pano-node"
        data-ident={ident}
      >
        {label
          ? labelText(node)
          : node.children.map((c, i) => renderNode(c, fullChain, flow, `${path}/${i}`))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[10px] text-zinc-600">
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-semibold text-amber-300/80">
          approximate
        </span>
        <span>
          no game data / scripts / textures - colors, layout & fonts only. Hover to inspect.
        </span>
        <span className="ml-auto truncate font-mono text-amber-200/80">{hover ?? ""}</span>
      </div>
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-[#0b0d0c]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 30% 30%, #17201d 0%, #0b0d0c 70%)",
        }}
      >
        <div
          style={{
            width: 1920,
            height: 1080,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            position: "relative",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            color: "#ddd",
          }}
        >
          {tree ? (
            renderNode(tree, [], "none", "r")
          ) : (
            <div style={{ padding: 40, fontSize: 28, color: "#f87171" }}>
              Layout didn't parse - check the XML for errors.
            </div>
          )}
        </div>
        {/* hover outline via CSS (keeps renderNode simple) */}
        <style>{`.pano-node:hover { outline: 1px solid rgba(245, 158, 11, 0.9); outline-offset: -1px; }`}</style>
      </div>
    </div>
  );
}
