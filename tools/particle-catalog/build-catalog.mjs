// Build a searchable catalog of every particle operator/initializer/emitter/
// renderer class Deadlock actually uses, mined from the decompiled vanilla
// corpus (VanillaFiles/particles_kv3) plus the editor's display-name strings
// extracted from the CSDK's particles.dll.
//
// usage: node build-catalog.mjs <corpusDir> <dllStringsFile> <outJson>

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [corpusDir, dllStringsFile, outJson] = process.argv.slice(2);
if (!outJson) {
  console.error("usage: node build-catalog.mjs <corpusDir> <dllStringsFile> <outJson>");
  process.exit(2);
}

import { parseKV3, summarize, isDefaulty } from "./kv3.mjs";

// ---------- DLL display names ------------------------------------------------

const classFriendly = {};
const fieldFriendly = {};
if (dllStringsFile && dllStringsFile !== "-") {
  const lines = readFileSync(dllStringsFile, "utf8").split(/\r?\n/);
  const isClass = (s) => /^C_(OP|INIT)_\w+$/.test(s) || /^C_PARTICLE\w+$/.test(s);
  const isLabel = (s) =>
    /^[a-z0-9][a-z0-9 %()\/+.'-]*$/i.test(s) &&
    !s.startsWith("m_") &&
    !s.includes("@") &&
    !s.includes("::") &&
    s.length >= 3 &&
    s.length <= 60 &&
    s.includes(" ") === true || /^[a-z]+$/.test(s);
  // class -> the very next plausible display-name line
  for (let k = 0; k < lines.length - 1; k++) {
    const s = lines[k];
    if (isClass(s)) {
      const next = lines[k + 1];
      if (next && !isClass(next) && !next.startsWith("m_") && !next.startsWith(".?") && isLabel(next)) {
        if (!classFriendly[s]) classFriendly[s] = next;
      }
    }
  }
  // field label <-> m_ name by normalized match (global; exact matches only)
  const norm = (s) =>
    s
      .replace(/^m_(fl|n|b|vec|v|str|h|arr|it)?/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const labelByNorm = new Map();
  for (const s of lines) {
    if (!s.startsWith("m_") && /^[a-z][a-z0-9 %()\/'-]{3,50}$/.test(s) && s.includes(" ")) {
      const key = norm(s);
      if (!labelByNorm.has(key)) labelByNorm.set(key, s);
    }
  }
  for (const s of lines) {
    if (/^m_\w+$/.test(s)) {
      const label = labelByNorm.get(norm(s));
      if (label && !fieldFriendly[s]) fieldFriendly[s] = label;
    }
  }
}

// ---------- walk + aggregate -------------------------------------------------

const KIND_ARRAYS = {
  m_PreEmissionOperators: "pre-emission",
  m_Emitters: "emitter",
  m_Initializers: "initializer",
  m_Operators: "operator",
  m_ForceGenerators: "force",
  m_Constraints: "constraint",
  m_Renderers: "renderer",
};

const classes = new Map(); // class -> record
let filesParsed = 0;
let parseErrors = 0;

function record(cls, kind, fields, file) {
  let rec = classes.get(cls);
  if (!rec) {
    rec = { kinds: {}, uses: 0, files: new Set(), sampleFiles: [], fields: new Map() };
    classes.set(cls, rec);
  }
  rec.kinds[kind] = (rec.kinds[kind] ?? 0) + 1;
  rec.uses++;
  rec.files.add(file);
  if (rec.sampleFiles.length < 6 && !rec.sampleFiles.includes(file)) rec.sampleFiles.push(file);
  for (const [k, v] of Object.entries(fields)) {
    if (k === "_class") continue;
    let f = rec.fields.get(k);
    if (!f) {
      f = { count: 0, values: new Map(), interesting: 0 };
      rec.fields.set(k, f);
    }
    f.count++;
    const s = summarize(v);
    if (!isDefaulty(s)) f.interesting++;
    if (f.values.size < 40 || f.values.has(s)) f.values.set(s, (f.values.get(s) ?? 0) + 1);
  }
}

function* vpcfFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* vpcfFiles(p);
    else if (name.endsWith(".vpcf")) yield p;
  }
}

for (const p of vpcfFiles(corpusDir)) {
  const rel = relative(corpusDir, p).replaceAll("\\", "/");
  let root;
  try {
    root = parseKV3(readFileSync(p, "utf8"));
  } catch {
    parseErrors++;
    continue;
  }
  filesParsed++;
  // The system definition's own scalar fields are the editor's "Base Properties".
  const baseFields = {};
  for (const [k, v] of Object.entries(root)) {
    if (KIND_ARRAYS[k] || k === "m_Children" || k === "m_controlPointConfigurations" || k === "_class")
      continue;
    baseFields[k] = v;
  }
  record("CParticleSystemDefinition", "base", baseFields, rel);
  for (const [arrKey, kind] of Object.entries(KIND_ARRAYS)) {
    const arr = root[arrKey];
    if (!Array.isArray(arr)) continue;
    for (const op of arr) {
      if (op && typeof op === "object" && typeof op._class === "string") {
        record(op._class, kind, op, rel);
      }
    }
  }
}

// ---------- emit -------------------------------------------------------------

const out = {
  generated: "from " + filesParsed + " vanilla .vpcf files",
  filesParsed,
  parseErrors,
  classes: {},
};
for (const [cls, rec] of [...classes.entries()].sort((a, b) => b[1].files.size - a[1].files.size)) {
  const fields = {};
  for (const [k, f] of [...rec.fields.entries()].sort((a, b) => b[1].interesting - a[1].interesting)) {
    const values = [...f.values.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([val, count]) => ({ val, count }));
    fields[k] = {
      label: fieldFriendly[k] ?? null,
      count: f.count,
      interesting: f.interesting,
      values,
    };
  }
  out.classes[cls] = {
    friendly: classFriendly[cls] ?? null,
    kinds: rec.kinds,
    uses: rec.uses,
    fileCount: rec.files.size,
    sampleFiles: rec.sampleFiles,
    fields,
  };
}

writeFileSync(outJson, JSON.stringify(out));
console.log(
  `parsed ${filesParsed} files (${parseErrors} errors), ${classes.size} classes -> ${outJson}`,
);
