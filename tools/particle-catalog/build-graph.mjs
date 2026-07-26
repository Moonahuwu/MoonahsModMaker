// Build the particle parent/child graph + gameplay owners.
//
// Walks the decompiled vanilla corpus (VanillaFiles/particles_kv3) extracting
// m_ChildRef edges, and decompiles scripts/abilities.vdata_c from the live pak
// (via vpk-helper) to map ability/item internal names -> the particle files
// their vdata block references.
//
// Outputs:
//   app/src/data/particleGraph.json      compact, bundled by the app
//   VanillaFiles/particle_graph_full.json  same data + children map, dev use
//
// usage: node build-graph.mjs [corpusDir] [outAppJson] [outFullJson]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const corpusDir = process.argv[2] ?? "../../VanillaFiles/particles_kv3";
const outAppJson = process.argv[3] ?? "../../app/src/data/particleGraph.json";
const outFullJson = process.argv[4] ?? "../../VanillaFiles/particle_graph_full.json";

const PAK_PATH =
  process.env.EIM_PAK ??
  "D:\\SteamLibrary\\steamapps\\common\\Deadlock\\game\\citadel\\pak01_dir.vpk";
const HELPER_CANDIDATES = [
  "../vpk-helper/bin/Release/net10.0/vpk-helper.exe",
  "../vpk-helper/dist/vpk-helper.exe",
];

const APP_SIZE_BUDGET = 800 * 1024; // keep the bundled JSON under ~800 KB
const JUNK_OWNER_THRESHOLD = 40; // owners with more particles are catch-alls

// ---------- 1. walk the corpus ----------------------------------------------

const files = []; // full refs, "particles/upgrades/x.vpcf"
(function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, r);
    else if (name.endsWith(".vpcf")) files.push(r);
  }
})(corpusDir, "");

files.sort();
const paths = files.map((f) => f.replace(/^particles\//, ""));
const indexByRef = new Map(); // lowercased full ref -> index
files.forEach((f, i) => indexByRef.set(f.toLowerCase(), i));

// ---------- 2. child edges ---------------------------------------------------

const parents = paths.map(() => new Set());
const children = paths.map(() => new Set());
let missingChildRefs = 0;

const CHILD_RE = /m_ChildRef = resource:"([^"]+\.vpcf)"/g;
files.forEach((f, i) => {
  const text = readFileSync(join(corpusDir, f), "utf8");
  for (const m of text.matchAll(CHILD_RE)) {
    const ci = indexByRef.get(m[1].toLowerCase());
    if (ci === undefined) {
      missingChildRefs++;
      continue;
    }
    children[i].add(ci);
    parents[ci].add(i);
  }
});

const parentsArr = parents.map((s) => [...s].sort((a, b) => a - b));
const childrenArr = children.map((s) => [...s].sort((a, b) => a - b));
const edgeCount = childrenArr.reduce((n, c) => n + c.length, 0);

// ---------- 3. owners from abilities.vdata -----------------------------------

function decompileAbilities() {
  const helper = HELPER_CANDIDATES.find((p) => existsSync(p));
  if (!helper) throw new Error("vpk-helper.exe not found (build tools/vpk-helper first)");
  if (!existsSync(PAK_PATH)) throw new Error(`pak not found: ${PAK_PATH}`);
  const tmp = join(tmpdir(), `eim_abilities_${process.pid}.vdata`);
  execFileSync(helper, ["decompile", PAK_PATH, "scripts/abilities.vdata_c", tmp], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const text = readFileSync(tmp, "utf8");
  rmSync(tmp, { force: true });
  return text;
}

// String-aware scan over a KV3 text body. Returns top-level key -> body slice
// for every `key = { ... }` (or `key = [ ... ]`) entry of the root object.
function topLevelBlocks(text) {
  let i = 0;
  // Skip the <!-- kv3 ... --> header (it contains braces).
  const hdr = text.indexOf("-->");
  if (hdr >= 0) i = hdr + 3;
  i = text.indexOf("{", i);
  if (i < 0) throw new Error("no root object in vdata");
  i++;

  const n = text.length;

  const skipWs = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) {
        while (i < n && text[i] !== "\n") i++;
      } else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else return;
    }
  };

  const skipString = () => {
    // caller sits on the opening quote
    if (text.startsWith('"""', i)) {
      const e = text.indexOf('"""', i + 3);
      i = e < 0 ? n : e + 3;
      return;
    }
    i++;
    while (i < n) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') {
        i++;
        return;
      } else i++;
    }
  };

  const skipBalanced = (open, close) => {
    // caller sits on `open`; returns [bodyStart, bodyEnd] (exclusive of delims)
    const start = ++i;
    let depth = 1;
    while (i < n && depth > 0) {
      const c = text[i];
      if (c === '"') skipString();
      else if (text.startsWith("//", i)) {
        while (i < n && text[i] !== "\n") i++;
      } else if (text.startsWith("/*", i)) {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else {
        if (c === open) depth++;
        else if (c === close) depth--;
        i++;
      }
    }
    return [start, i - 1];
  };

  const blocks = [];
  for (;;) {
    skipWs();
    if (i >= n || text[i] === "}") break;
    // key: identifier or quoted string
    let key;
    if (text[i] === '"') {
      const s = i;
      skipString();
      key = text.slice(s + 1, i - 1);
    } else {
      const m = /^[A-Za-z0-9_.:-]+/.exec(text.slice(i, i + 200));
      if (!m) {
        i++; // unexpected char, resync
        continue;
      }
      key = m[0];
      i += m[0].length;
    }
    skipWs();
    if (text[i] !== "=") continue; // flags or stray token, resync
    i++;
    skipWs();
    const c = text[i];
    if (c === "{") {
      const [s, e] = skipBalanced("{", "}");
      blocks.push([key, text.slice(s, e)]);
    } else if (c === "[") {
      const [s, e] = skipBalanced("[", "]");
      blocks.push([key, text.slice(s, e)]);
    } else if (c === '"') {
      skipString();
    } else {
      // bare scalar (number, resource:"..." handled above via quote), read token
      while (i < n && !/\s/.test(text[i])) {
        if (text[i] === '"') skipString();
        else i++;
      }
    }
  }
  return blocks;
}

const REF_RE = /"(particles\/[^"]+\.vpcf)"/g;
const owners = {};
{
  const vdata = decompileAbilities();
  for (const [key, body] of topLevelBlocks(vdata)) {
    const idx = new Set();
    for (const m of body.matchAll(REF_RE)) {
      const pi = indexByRef.get(m[1].toLowerCase());
      if (pi !== undefined) idx.add(pi);
    }
    if (idx.size === 0) continue;
    const sorted = [...idx].sort((a, b) => a - b);
    if (owners[key]) {
      // duplicate top-level key (should not happen): union
      const u = new Set([...owners[key], ...sorted]);
      owners[key] = [...u].sort((a, b) => a - b);
    } else owners[key] = sorted;
  }
}

// ---------- 4. write outputs -------------------------------------------------

const full = { paths, parents: parentsArr, children: childrenArr, owners };
writeFileSync(outFullJson, JSON.stringify(full));

let appOwners = owners;
let droppedOwners = 0;
let app = { paths, parents: parentsArr, owners: appOwners };
let appStr = JSON.stringify(app);
if (Buffer.byteLength(appStr) > APP_SIZE_BUDGET) {
  appOwners = {};
  for (const [k, v] of Object.entries(owners)) {
    if (v.length > JUNK_OWNER_THRESHOLD) {
      droppedOwners++;
      continue;
    }
    appOwners[k] = v;
  }
  app = { paths, parents: parentsArr, owners: appOwners };
  appStr = JSON.stringify(app);
  if (Buffer.byteLength(appStr) > APP_SIZE_BUDGET) {
    console.warn(
      `note: app JSON still over the ${APP_SIZE_BUDGET / 1024} KB budget after dropping ` +
        `${droppedOwners} catch-all owners; the paths array dominates the size`,
    );
  }
}
writeFileSync(outAppJson, appStr);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
console.log(
  `graph: ${paths.length} paths, ${edgeCount} child edges (${missingChildRefs} refs outside corpus dropped)`,
);
console.log(
  `owners: ${Object.keys(owners).length} total` +
    (droppedOwners
      ? `, ${droppedOwners} catch-alls (>${JUNK_OWNER_THRESHOLD} particles) dropped from app JSON`
      : ""),
);
console.log(`wrote ${outFullJson} (${kb(JSON.stringify(full))} KB)`);
console.log(`wrote ${outAppJson} (${kb(appStr)} KB, ${Object.keys(appOwners).length} owners)`);
