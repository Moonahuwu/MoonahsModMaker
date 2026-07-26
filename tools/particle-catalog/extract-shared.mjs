// One-time refactor: pull the KV3 parser out of build-catalog.mjs into
// kv3.mjs, and the curated annotation maps out of build-html.mjs into
// annotations.mjs, so the MCP server can import both. Deterministic slicing
// on stable anchors; reruns are no-ops once the imports are in place.
import { readFileSync, writeFileSync } from "node:fs";

// ---- kv3.mjs out of build-catalog.mjs ----
let cat = readFileSync("build-catalog.mjs", "utf8");
if (!cat.includes('from "./kv3.mjs"')) {
  const start = cat.indexOf("// ---------- KV3 subset parser");
  const end = cat.indexOf("// ---------- DLL display names");
  if (start === -1 || end === -1) throw new Error("kv3 anchors not found");
  const block = cat.slice(start, end);
  const kv3 = block
    .replace(/\nfunction parseKV3/, "\nexport function parseKV3")
    .replace(/\nfunction summarize/, "\nexport function summarize")
    .replace(/\nfunction isDefaulty/, "\nexport function isDefaulty");
  writeFileSync("kv3.mjs", "// Shared KV3(vpcf) subset parser + value summarizers.\n" + kv3);
  cat = cat.slice(0, start) + 'import { parseKV3, summarize, isDefaulty } from "./kv3.mjs";\n\n' + cat.slice(end);
  writeFileSync("build-catalog.mjs", cat);
  console.log("kv3.mjs extracted");
} else console.log("kv3.mjs already extracted");

// ---- annotations.mjs out of build-html.mjs ----
let html = readFileSync("build-html.mjs", "utf8");
if (!html.includes('from "./annotations.mjs"')) {
  const start = html.indexOf("const C = {");
  const pf = html.indexOf("const PF_TYPES");
  if (start === -1 || pf === -1) throw new Error("annotation anchors not found");
  const end = html.indexOf("];", pf) + 2;
  const block = html.slice(start, end);
  const ann = block
    .replace(/^const /, "export const ")
    .replaceAll("\nconst ", "\nexport const ");
  writeFileSync(
    "annotations.mjs",
    "// Curated layer: editor names + descriptions for particle classes (C),\n// common fields (F), attribute indices (ATTRS), input types (PF_TYPES).\n" + ann + "\n",
  );
  html = html.slice(0, start) + 'import { C, F, ATTRS, PF_TYPES } from "./annotations.mjs";' + html.slice(end);
  writeFileSync("build-html.mjs", html);
  console.log("annotations.mjs extracted");
} else console.log("annotations.mjs already extracted");
