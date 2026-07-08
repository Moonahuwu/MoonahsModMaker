/**
 * Panorama → HTML/CSS approximation for the UI Master preview.
 *
 * Panorama's XML layouts and CSS-like styles map surprisingly well onto real
 * HTML/CSS: this module parses both and computes per-node styles so a React
 * component can render a *rough* likeness — colors, sizes, positions, fonts,
 * flow. It is deliberately approximate: game-data panels have no content,
 * scripts don't run, and unknown properties are skipped. Good enough to see
 * a recolor/resize instantly; never a substitute for the real renderer.
 */

export interface PNode {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
  inline?: string;
  children: PNode[];
}

interface Simple {
  tag?: string;
  id?: string;
  classes: string[];
}

export interface PRule {
  /** One selector = compound chain (descendant combinator between entries). */
  selector: Simple[];
  specificity: number;
  order: number;
  decls: [string, string][];
}

// ---------------------------------------------------------------------------
// Layout XML
// ---------------------------------------------------------------------------

export function parseLayout(xml: string): PNode | null {
  // Strip the VRF banner comment + xml prolog quirks; DOMParser handles the rest.
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root) return null;
  // <root> wraps <styles>/<scripts>/<Panel...>; the visual tree is everything
  // that isn't styles/scripts. Usually a single root Panel.
  const visual: PNode[] = [];
  for (const el of Array.from(root.children)) {
    const name = el.tagName.toLowerCase();
    if (name === "styles" || name === "scripts") continue;
    visual.push(toPNode(el));
  }
  if (visual.length === 0) return null;
  if (visual.length === 1) return visual[0];
  return { tag: "Panel", classes: [], children: visual };
}

function toPNode(el: Element): PNode {
  return {
    tag: el.tagName,
    id: el.getAttribute("id") ?? undefined,
    classes: (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
    text: el.getAttribute("text") ?? undefined,
    inline: el.getAttribute("style") ?? undefined,
    children: Array.from(el.children).map(toPNode),
  };
}

/** Style-file includes referenced by a layout (compiled-rel form). */
export function layoutStyleIncludes(xml: string): string[] {
  const out: string[] = [];
  const re = /<include\s+src="(?:s2r|file):\/\/(\{resources\}\/)?([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let p = m[2];
    if (!p.startsWith("panorama/")) p = `panorama/${p}`;
    if (p.endsWith(".css")) p = p.replace(/\.css$/, ".vcss_c");
    if (p.endsWith(".vcss_c")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Style parsing
// ---------------------------------------------------------------------------

export function parseCss(text: string): PRule[] {
  const rules: PRule[] = [];
  // Strip comments.
  let s = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // @define table (panorama variables), applied textually into values.
  const defines = new Map<string, string>();
  s = s.replace(/@define\s+([\w-]+)\s*:\s*([^;]+);/g, (_all, name, value) => {
    defines.set(name, value.trim());
    return "";
  });
  // Drop @keyframes blocks (animation frames don't render statically).
  s = stripAtBlocks(s);

  let order = 0;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const selectorText = m[1].trim();
    const body = m[2];
    if (!selectorText || selectorText.startsWith("@")) continue;
    const decls: [string, string][] = [];
    for (const part of body.split(";")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      let value = part.slice(idx + 1).trim();
      if (!prop || !value) continue;
      value = substituteDefines(value, defines);
      decls.push([prop, value]);
    }
    if (decls.length === 0) continue;
    for (const one of selectorText.split(",")) {
      const sel = parseSelector(one.trim());
      if (!sel) continue; // pseudo-selectors (hover/active) skipped — static preview
      rules.push({ selector: sel.chain, specificity: sel.spec, order: order++, decls });
    }
  }
  return rules;
}

function stripAtBlocks(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf("@keyframes", i);
    if (at === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, at);
    const open = s.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      j++;
    }
    i = j;
  }
  return out;
}

function substituteDefines(value: string, defines: Map<string, string>): string {
  // `name&hh` = defined color with a hex alpha tacked on (panorama-ism).
  value = value.replace(/([\w-]+)&([0-9a-fA-F]{2})/g, (_a, name, alpha) => {
    const base = defines.get(name);
    if (base && /^#([0-9a-fA-F]{6})$/.test(base)) return `${base}${alpha}`;
    return _a;
  });
  return value.replace(/[\w-]+/g, (w) => defines.get(w) ?? w);
}

function parseSelector(sel: string): { chain: Simple[]; spec: number } | null {
  if (sel.includes(":")) return null; // :hover/:active/:enabled/:not — skip
  if (sel.includes(">")) sel = sel.replace(/>/g, " "); // treat child as descendant
  const chain: Simple[] = [];
  let spec = 0;
  for (const part of sel.split(/\s+/).filter(Boolean)) {
    const simple: Simple = { classes: [] };
    const re = /([#.]?)([\w-]+)/g;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(part))) {
      any = true;
      if (m[1] === "#") {
        simple.id = m[2];
        spec += 100;
      } else if (m[1] === ".") {
        simple.classes.push(m[2]);
        spec += 10;
      } else {
        simple.tag = m[2].toLowerCase();
        spec += 1;
      }
    }
    if (!any) return null;
    chain.push(simple);
  }
  return chain.length ? { chain, spec } : null;
}

// ---------------------------------------------------------------------------
// Matching + computing
// ---------------------------------------------------------------------------

function matchesSimple(node: PNode, s: Simple): boolean {
  if (s.tag && node.tag.toLowerCase() !== s.tag) return false;
  if (s.id && node.id !== s.id) return false;
  return s.classes.every((c) => node.classes.includes(c));
}

/** chain = [ancestor…, self]; selector matched right-to-left with gaps. */
function matches(chain: PNode[], selector: Simple[]): boolean {
  let si = selector.length - 1;
  if (!matchesSimple(chain[chain.length - 1], selector[si])) return false;
  si--;
  let ci = chain.length - 2;
  while (si >= 0) {
    while (ci >= 0 && !matchesSimple(chain[ci], selector[si])) ci--;
    if (ci < 0) return false;
    ci--;
    si--;
  }
  return true;
}

/** Merged panorama property map for one node (ancestors give context). */
export function computeProps(chain: PNode[], rules: PRule[]): Map<string, string> {
  const hits = rules
    .filter((r) => matches(chain, r.selector))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const props = new Map<string, string>();
  for (const r of hits) for (const [p, v] of r.decls) props.set(p, v);
  const self = chain[chain.length - 1];
  if (self.inline) {
    for (const part of self.inline.split(";")) {
      const idx = part.indexOf(":");
      if (idx > 0) props.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
    }
  }
  return props;
}

// ---------------------------------------------------------------------------
// Panorama props -> CSS
// ---------------------------------------------------------------------------

export type Flow = "none" | "down" | "right" | "down-wrap" | "right-wrap";

const FONT_MAP: Record<string, string> = {
  oracle: "Georgia, 'Times New Roman', serif",
  serif: "Georgia, serif",
  sans: "'Segoe UI', system-ui, sans-serif",
  block: "'Arial Black', 'Segoe UI', sans-serif",
  mono: "Consolas, monospace",
};

function translateGradient(v: string): string | null {
  // gradient( linear, x1 y1, x2 y2, from( c1 ), to( c2 ) )
  let m = v.match(
    /gradient\(\s*linear,\s*([\d.]+)%\s+([\d.]+)%\s*,\s*([\d.]+)%\s+([\d.]+)%\s*,\s*from\(\s*([^)]+)\)\s*,\s*to\(\s*([^)]+)\)\s*\)/,
  );
  if (m) {
    const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const angle = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
    return `linear-gradient(${angle.toFixed(0)}deg, ${m[5].trim()}, ${m[6].trim()})`;
  }
  m = v.match(/gradient\(\s*radial[^,]*(?:,[^,]+){3},\s*from\(\s*([^)]+)\)\s*,\s*to\(\s*([^)]+)\)\s*\)/);
  if (m) return `radial-gradient(circle, ${m[1].trim()}, ${m[2].trim()})`;
  return null;
}

/** Convert one node's panorama props into CSS given the parent's flow. */
export function toCss(
  props: Map<string, string>,
  parentFlow: Flow,
): { style: React.CSSProperties; flow: Flow; hidden: boolean } {
  const st: React.CSSProperties = {};
  const transforms: string[] = [];
  let flow: Flow = "none";
  let hidden = false;
  let hAlign = "";
  let vAlign = "";
  let ignoreFlow = false;

  for (const [p, vRaw] of props) {
    const v = vRaw.trim();
    switch (p) {
      case "width":
      case "height": {
        const dim = p as "width" | "height";
        if (v.startsWith("fill-parent-flow")) {
          st.flexGrow = Number(v.match(/\(([\d.]+)\)/)?.[1] ?? 1);
          st[dim] = "auto";
        } else if (v === "fit-children") st[dim] = "fit-content";
        else st[dim] = v;
        break;
      }
      case "max-width": case "max-height": case "min-width": case "min-height":
        if (!v.includes("fill-") && v !== "none") (st as Record<string, unknown>)[camel(p)] = v;
        break;
      case "flow-children":
        flow = (["down", "right", "down-wrap", "right-wrap"].includes(v) ? v : "none") as Flow;
        break;
      case "visibility":
        if (v === "collapse") hidden = true;
        break;
      case "background-color": {
        const g = translateGradient(v);
        st.background = g ?? v;
        break;
      }
      case "background-image":
        // Game textures aren't decoded in the preview — mark the box instead.
        if (v !== "none") st.outline = "1px dashed #ffffff22";
        break;
      case "color": st.color = v; break;
      case "font-size": st.fontSize = v; break;
      case "font-weight":
        st.fontWeight = v === "semi-bold" ? 600 : v === "thin" ? 300 : (v as never);
        break;
      case "font-family": {
        const key = v.replace(/["']/g, "").toLowerCase();
        st.fontFamily = FONT_MAP[key] ?? v;
        break;
      }
      case "font-style": st.fontStyle = v; break;
      case "text-transform": if (v !== "none") st.textTransform = v as never; break;
      case "text-align": st.textAlign = v as never; break;
      case "letter-spacing": if (v !== "none") st.letterSpacing = v; break;
      case "line-height": if (v !== "none") st.lineHeight = v; break;
      case "white-space": st.whiteSpace = v as never; break;
      case "margin": case "padding":
        (st as Record<string, unknown>)[p] = v;
        break;
      case "margin-left": case "margin-right": case "margin-top": case "margin-bottom":
      case "padding-left": case "padding-right": case "padding-top": case "padding-bottom":
        (st as Record<string, unknown>)[camel(p)] = v;
        break;
      case "border": if (!v.startsWith("none")) st.border = v; break;
      case "border-radius": st.borderRadius = v; break;
      case "box-shadow": {
        // panorama: `[inset] x y blur spread color` with float spread
        const bs = v.replace(/fill\s+/, "");
        st.boxShadow = bs;
        break;
      }
      case "opacity": st.opacity = Number(v); break;
      case "z-index": st.zIndex = Number(v); break;
      case "overflow":
        st.overflow = v.includes("noclip") ? "visible" : v.includes("squish") || v.includes("scroll") ? "hidden" : (v.split(" ")[0] as never);
        break;
      case "transform": {
        // rotateZ/translateX/translateY/scale are CSS-compatible
        if (v !== "none") transforms.push(v);
        break;
      }
      case "pre-transform-scale2d": transforms.push(`scale(${v})`); break;
      case "horizontal-align": hAlign = v; break;
      case "vertical-align": vAlign = v; break;
      case "ignore-parent-flow": ignoreFlow = v === "true"; break;
      case "blur":
        if (v.startsWith("gaussian")) {
          const r = Number(v.match(/\(\s*([\d.]+)/)?.[1] ?? 0);
          if (r > 0.2) st.filter = `blur(${Math.min(r, 20)}px)`;
        }
        break;
      case "wash-color":
        if (v !== "none") st.backgroundBlendMode = "multiply";
        break;
      case "x": st.left = v; break;
      case "y": st.top = v; break;
      default:
        break; // unknown / unsupported — skip silently
    }
  }

  // Positioning within the parent.
  const absolute = ignoreFlow || parentFlow === "none" || props.has("x") || props.has("y");
  if (absolute) {
    st.position = "absolute";
    if (hAlign === "center" || hAlign === "middle") {
      st.left = "50%";
      transforms.unshift("translateX(-50%)");
    } else if (hAlign === "right") st.right = st.right ?? 0;
    else st.left = st.left ?? 0;
    if (vAlign === "center" || vAlign === "middle") {
      st.top = "50%";
      transforms.unshift("translateY(-50%)");
    } else if (vAlign === "bottom") st.bottom = st.bottom ?? 0;
    else st.top = st.top ?? 0;
  } else {
    // Flex child: approximate align via alignSelf/auto margins.
    const row = parentFlow.startsWith("right");
    if (hAlign === "center" || hAlign === "middle") {
      if (row) { st.marginLeft = "auto"; st.marginRight = "auto"; }
      else st.alignSelf = "center";
    } else if (hAlign === "right") {
      if (row) st.marginLeft = "auto";
      else st.alignSelf = "flex-end";
    }
    if (vAlign === "center" || vAlign === "middle") {
      if (row) st.alignSelf = "center";
      else { st.marginTop = "auto"; st.marginBottom = "auto"; }
    } else if (vAlign === "bottom") {
      if (row) st.alignSelf = "flex-end";
      else st.marginTop = "auto";
    }
  }
  if (transforms.length) st.transform = transforms.join(" ");

  // This node's own children layout.
  if (flow !== "none") {
    st.display = "flex";
    st.flexDirection = flow.startsWith("down") ? "column" : "row";
    if (flow.endsWith("wrap")) st.flexWrap = "wrap";
  } else {
    st.position = st.position ?? "relative";
  }
  return { style: st, flow, hidden };
}

function camel(p: string): string {
  return p.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/** Display text for a Label: localization tokens shown as their tail. */
export function labelText(node: PNode): string {
  const t = node.text ?? "";
  if (t.startsWith("#")) {
    const tail = t.split("_").slice(-2).join(" ");
    return tail || t;
  }
  return t.replace(/\{[^}]+\}/g, "·");
}
