// Shared KV3(vpcf) subset parser + value summarizers.
// ---------- KV3 subset parser (the shape VRF emits for vpcf) ----------------

export function parseKV3(text) {
  // Skip the <!-- kv3 ... --> header line.
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

  function parseString() {
    // assumes text[i] === '"'
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

  function parseValue() {
    ws();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "#" && text[i + 1] === "[") {
      // binary blob: #[ AA BB ... ]
      const end = text.indexOf("]", i);
      i = end + 1;
      return "<binary>";
    }
    // bare token: number, bool, null, or a prefixed string like resource:"..."
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

  function parseArray() {
    i++; // [
    const arr = [];
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

  function parseObject() {
    i++; // {
    const obj = {};
    for (;;) {
      ws();
      if (i >= n) break;
      if (text[i] === "}") {
        i++;
        break;
      }
      let key;
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

// ---------- compact value summaries -----------------------------------------

export function summarize(v) {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 70 ? v.slice(0, 67) + "..." : v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length <= 4 && v.every((x) => typeof x === "number"))
      return "[" + v.map((x) => +Number(x).toFixed(3)).join(", ") + "]";
    return `[${v.length} items]`;
  }
  // object: recognize the big per-particle float/vector input structs and
  // boil them down to the one thing that matters.
  const t = v.m_nType;
  if (typeof t === "string") {
    if (t === "PF_TYPE_LITERAL") return "literal " + summarize(v.m_flLiteralValue ?? 0);
    if (t === "PVEC_TYPE_LITERAL") return "literal " + summarize(v.m_vLiteralValue ?? []);
    if (t === "PF_TYPE_RANDOM_UNIFORM" || t === "PF_TYPE_RANDOM_BIASED")
      return `random ${summarize(v.m_flRandomMin ?? 0)}..${summarize(v.m_flRandomMax ?? 1)}`;
    if (t === "PF_TYPE_PARTICLE_AGE" || t === "PF_TYPE_PARTICLE_AGE_NORMALIZED") {
      const curved = v.m_Curve && Array.isArray(v.m_Curve.m_spline) && v.m_Curve.m_spline.length > 0;
      return t.replace("PF_TYPE_", "").toLowerCase() + (curved ? " (curve)" : "");
    }
    return t.replace(/^(PF_TYPE_|PVEC_TYPE_)/, "").toLowerCase();
  }
  if (typeof v._class === "string") return "{" + v._class + "}";
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  return "{" + keys.length + " fields}";
}

/** True when a value is just the fully-expanded default the decompiler emits. */
export function isDefaulty(summary) {
  return (
    summary === "literal 0" ||
    summary === "literal 1" ||
    summary === "literal []" ||
    summary === "[]" ||
    summary === "{}" ||
    summary === "null" ||
    summary === ""
  );
}

