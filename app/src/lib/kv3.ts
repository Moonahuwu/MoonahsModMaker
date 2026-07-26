/** Minimal KV3 parser for decompiled particle files (.vpcf text), plus the
 *  outline model the Inspector renders. TS port of tools/particle-catalog's
 *  kv3.mjs - handles exactly the subset VRF/resourcecompiler emit. */

export type Kv3Value = null | boolean | number | string | Kv3Value[] | Kv3Object;
export interface Kv3Object {
  [key: string]: Kv3Value;
}

export function parseKV3(text: string): Kv3Object {
  let i = text.indexOf("-->");
  i = i === -1 ? 0 : i + 3;
  const n = text.length;

  function ws() {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") i++;
      else if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
      } else break;
    }
  }

  function parseString(): string {
    i++;
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        out += text[i + 1];
        i += 2;
      } else if (c === '"') {
        i++;
        return out;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  function parseValue(): Kv3Value {
    ws();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "#" && text[i + 1] === "[") {
      const end = text.indexOf("]", i);
      i = end + 1;
      return "<binary>";
    }
    let j = i;
    while (j < n && !/[\s,\]}]/.test(text[j])) {
      if (text[j] === ":" && text[j + 1] === '"') {
        const prefix = text.slice(i, j);
        i = j + 1;
        const s = parseString();
        return `${prefix}:${s}`;
      }
      j++;
    }
    const tok = text.slice(i, j);
    i = j;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    const num = Number(tok);
    return Number.isNaN(num) ? tok : num;
  }

  function parseArray(): Kv3Value[] {
    i++;
    const arr: Kv3Value[] = [];
    for (;;) {
      ws();
      if (i >= n) break;
      if (text[i] === "]") {
        i++;
        break;
      }
      arr.push(parseValue());
    }
    return arr;
  }

  function parseObject(): Kv3Object {
    i++;
    const obj: Kv3Object = {};
    for (;;) {
      ws();
      if (i >= n) break;
      if (text[i] === "}") {
        i++;
        break;
      }
      let key: string;
      if (text[i] === '"') key = parseString();
      else {
        let j = i;
        while (j < n && /[\w.]/.test(text[j])) j++;
        key = text.slice(i, j);
        i = j;
      }
      ws();
      if (text[i] === "=") i++;
      obj[key] = parseValue();
    }
    return obj;
  }

  ws();
  return parseObject();
}

/** Boil a field value down to one readable line (mirrors the catalog miner:
 *  the giant per-particle input structs collapse to the knob that matters). */
export function summarize(v: Kv3Value): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 70 ? v.slice(0, 67) + "..." : v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length <= 4 && v.every((x) => typeof x === "number"))
      return "[" + v.map((x) => +Number(x).toFixed(3)).join(", ") + "]";
    return `[${v.length} items]`;
  }
  const t = v.m_nType;
  if (typeof t === "string") {
    if (t === "PF_TYPE_LITERAL") return "literal " + summarize(v.m_flLiteralValue ?? 0);
    if (t === "PVEC_TYPE_LITERAL") return "literal " + summarize(v.m_vLiteralValue ?? []);
    if (t === "PVEC_TYPE_LITERAL_COLOR") return "color " + summarize(v.m_LiteralColor ?? []);
    if (t === "PF_TYPE_RANDOM_UNIFORM" || t === "PF_TYPE_RANDOM_BIASED")
      return `random ${summarize(v.m_flRandomMin ?? 0)}..${summarize(v.m_flRandomMax ?? 1)}`;
    if (t === "PF_TYPE_PARTICLE_AGE" || t === "PF_TYPE_PARTICLE_AGE_NORMALIZED") {
      const curve = v.m_Curve;
      const curved =
        curve !== null &&
        typeof curve === "object" &&
        !Array.isArray(curve) &&
        Array.isArray(curve.m_spline) &&
        curve.m_spline.length > 0;
      return t.replace("PF_TYPE_", "").toLowerCase() + (curved ? " (curve)" : "");
    }
    if (t === "PVEC_TYPE_FLOAT_INTERP_GRADIENT") return "gradient input";
    return t.replace(/^(PF_TYPE_|PVEC_TYPE_)/, "").toLowerCase();
  }
  if (typeof v._class === "string") return "{" + v._class + "}";
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  return "{" + keys.length + " fields}";
}

/** True when a summarized value is just the expanded default the decompiler
 *  writes - hidden from outlines so only the tuned knobs show. */
export function isDefaulty(s: string): boolean {
  return (
    s === "literal 0" ||
    s === "literal 1" ||
    s === "literal []" ||
    s === "[]" ||
    s === "{}" ||
    s === "null" ||
    s === "false" ||
    s === ""
  );
}

const STAGE_ARRAYS: [string, string][] = [
  ["m_PreEmissionOperators", "Pre-Emission"],
  ["m_Emitters", "Emitters"],
  ["m_Initializers", "Initializers"],
  ["m_Operators", "Operators"],
  ["m_ForceGenerators", "Forces"],
  ["m_Constraints", "Constraints"],
  ["m_Renderers", "Renderers"],
];

export interface OutlineFn {
  cls: string;
  disabled: boolean;
  /** Tuned (non-default) fields, summarized. */
  fields: { key: string; value: string }[];
}
export interface Outline {
  /** Non-default base (system definition) properties. */
  base: { key: string; value: string }[];
  stages: { stage: string; fns: OutlineFn[] }[];
  /** Child effect refs (`particles/...vpcf`). */
  children: string[];
}

/** Parse a decompiled .vpcf into the Inspector's outline model. */
export function buildOutline(text: string): Outline {
  const root = parseKV3(text);
  const base: Outline["base"] = [];
  for (const [k, v] of Object.entries(root)) {
    if (
      STAGE_ARRAYS.some(([a]) => a === k) ||
      k === "m_Children" ||
      k === "m_controlPointConfigurations" ||
      k === "_class"
    )
      continue;
    const s = summarize(v);
    if (!isDefaulty(s)) base.push({ key: k, value: s });
  }
  const stages: Outline["stages"] = [];
  for (const [arrKey, stage] of STAGE_ARRAYS) {
    const arr = root[arrKey];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const fns: OutlineFn[] = [];
    for (const fn of arr) {
      if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
      const cls = fn._class;
      if (typeof cls !== "string") continue;
      const fields: OutlineFn["fields"] = [];
      for (const [k, v] of Object.entries(fn)) {
        if (k === "_class" || k === "m_bDisableOperator") continue;
        const s = summarize(v);
        if (!isDefaulty(s)) fields.push({ key: k, value: s });
      }
      fns.push({ cls, disabled: fn.m_bDisableOperator === true, fields });
    }
    stages.push({ stage, fns });
  }
  const children: string[] = [];
  for (const m of text.matchAll(/m_ChildRef = resource:"([^"]+\.vpcf)"/g)) {
    if (!children.includes(m[1])) children.push(m[1]);
  }
  return { base, stages, children };
}
