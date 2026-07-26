// Merge the mined catalog with the curated annotations into the compact JSON
// the app's Particle Guide tab ships (app/src/data/particleCatalog.json).
// Rerun after refresh_corpus + build-catalog to pick up a new game patch.
//
// usage: node build-app-data.mjs [catalogJson] [outJson]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { C, F, ATTRS, PF_TYPES } from "./annotations.mjs";

const catalogPath = process.argv[2] ?? "../../VanillaFiles/particle_catalog.json";
const outPath = process.argv[3] ?? "../../app/src/data/particleCatalog.json";
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

// "New this patch" baseline: the previously shipped data's per-class file
// counts. A class absent from the old data gets prev = null (i.e. NEW).
const prevMap = {};
if (existsSync(outPath)) {
  try {
    for (const c of JSON.parse(readFileSync(outPath, "utf8")).classes ?? []) {
      prevMap[c.cls] = c.files;
    }
  } catch {
    // unreadable previous output: treat everything as new
  }
}

function humanize(cls) {
  return cls
    .replace(/^C_(OP|INIT)_/, "")
    .replace(/^CParticle/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}
function tokens(s) {
  return new Set(
    s.toLowerCase().replace(/^c_(op|init)_/, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  );
}
function displayName(cls, mined) {
  if (C[cls]) return C[cls][0];
  if (mined) {
    const a = tokens(humanize(cls)), b = tokens(mined);
    for (const w of b) if (a.has(w)) return mined;
  }
  return humanize(cls);
}

const classes = [];
for (const [cls, rec] of Object.entries(catalog.classes)) {
  const kind = Object.entries(rec.kinds).sort((a, b) => b[1] - a[1])[0][0];
  const fields = [];
  const untouched = [];
  for (const [fk, fv] of Object.entries(rec.fields)) {
    if (fv.interesting === 0) {
      untouched.push(fk);
      continue;
    }
    fields.push({
      key: fk,
      label: fv.label && fv.label.toLowerCase() !== fk.toLowerCase() ? fv.label : null,
      desc: F[fk] ?? null,
      values: fv.values.slice(0, 6).map((v) => [v.val, v.count]),
    });
  }
  classes.push({
    cls,
    name: displayName(cls, rec.friendly),
    kind,
    files: rec.fileCount,
    prev: prevMap[cls] ?? null,
    desc: C[cls]?.[1] ?? null,
    seenIn: rec.sampleFiles.slice(0, 3).map((s) => s.replace(/^particles\//, "")),
    fields,
    untouched,
  });
}
classes.sort((a, b) => b.files - a.files);

const out = {
  totalEffects: catalog.filesParsed,
  attrs: ATTRS,
  inputTypes: PF_TYPES,
  classes,
};
writeFileSync(outPath, JSON.stringify(out));
console.log(
  `wrote ${outPath} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB, ${classes.length} classes)`,
);
