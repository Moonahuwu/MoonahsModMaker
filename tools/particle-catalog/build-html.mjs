// Generate the searchable particle-reference page from particle_catalog.json.
// usage: node build-html.mjs <catalogJson> <outHtml>

import { readFileSync, writeFileSync } from "node:fs";

const [catalogPath, outPath] = process.argv.slice(2);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

// ---------------------------------------------------------------------------
// Curated layer: real editor names + what each class actually does.
// Mined DLL names are only trusted when they share a word with the class name.
// ---------------------------------------------------------------------------

import { C, F, ATTRS, PF_TYPES } from "./annotations.mjs";

// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND_META = {
  base: ["Base", "b"],
  emitter: ["Emitter", "e"],
  initializer: ["Initializer", "i"],
  operator: ["Operator", "o"],
  renderer: ["Renderer", "r"],
  force: ["Force", "f"],
  constraint: ["Constraint", "c"],
  "pre-emission": ["Pre-Emission", "p"],
};

function humanize(cls) {
  return cls
    .replace(/^C_(OP|INIT)_/, "")
    .replace(/^CParticle/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function tokens(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/^c_(op|init)_/, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function displayName(cls, mined) {
  if (C[cls]) return C[cls][0];
  if (mined) {
    const a = tokens(humanize(cls)), b = tokens(mined);
    for (const w of b) if (a.has(w)) return mined; // plausible pairing
  }
  return humanize(cls);
}

const total = catalog.filesParsed;
let cards = "";
const classEntries = Object.entries(catalog.classes);
for (const [cls, rec] of classEntries) {
  const kind = Object.entries(rec.kinds).sort((a, b) => b[1] - a[1])[0][0];
  const [kindLabel, kindKey] = KIND_META[kind] ?? [kind, "o"];
  const name = displayName(cls, rec.friendly);
  const desc = C[cls]?.[1] ?? "";
  const pct = Math.max(0.5, (100 * rec.fileCount) / total);

  const tuned = [];
  const untouched = [];
  for (const [fk, fv] of Object.entries(rec.fields)) {
    if (fv.interesting > 0) tuned.push([fk, fv]);
    else untouched.push(fk);
  }
  const rows = tuned
    .map(([fk, fv]) => {
      const vals = fv.values
        .slice(0, 8)
        .map((v) => `<span class="val">${esc(v.val)}<i>&times;${v.count}</i></span>`)
        .join("");
      const fdesc = F[fk] ? `<div class="fdesc">${esc(F[fk])}</div>` : "";
      const label = fv.label && fv.label.toLowerCase() !== fk.toLowerCase() ? `<div class="flabel">${esc(fv.label)}</div>` : "";
      return `<tr><td class="fname"><code>${esc(fk)}</code>${label}${fdesc}</td><td class="fvals">${vals}</td></tr>`;
    })
    .join("");
  const untouchedLine =
    untouched.length > 0
      ? `<p class="untouched"><b>Always default in vanilla:</b> ${untouched.map((u) => `<code>${esc(u)}</code>`).join(" ")}</p>`
      : "";
  const samples = rec.sampleFiles
    .slice(0, 4)
    .map((s) => `<code>${esc(s.replace(/^particles\//, ""))}</code>`)
    .join(" ");
  const search = [cls, name, rec.friendly ?? "", desc, ...Object.keys(rec.fields)].join(" ").toLowerCase();

  cards += `<details class="card" data-kind="${kindKey}" data-files="${rec.fileCount}" data-search="${esc(search)}">
<summary>
  <span class="chip chip-${kindKey}">${kindLabel}</span>
  <span class="names"><span class="friendly">${esc(name)}</span><code class="cls">${esc(cls)}</code></span>
  <span class="usage" title="used in ${rec.fileCount} of ${total} vanilla effects"><span class="bar"><span style="width:${pct.toFixed(1)}%"></span></span><span class="n">${rec.fileCount.toLocaleString("en-US")}</span></span>
</summary>
<div class="body">
  ${desc ? `<p class="desc">${esc(desc)}</p>` : ""}
  <p class="samples"><b>Seen in:</b> ${samples}</p>
  ${rows ? `<div class="tablewrap"><table><thead><tr><th>Property</th><th>Values Valve actually uses</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
  ${untouchedLine}
</div>
</details>\n`;
}

const attrRows = ATTRS.map(([n, nm, d]) => `<tr><td class="num">${n}</td><td><b>${esc(nm)}</b></td><td>${esc(d)}</td></tr>`).join("");
const pfRows = PF_TYPES.map(([n, d]) => `<tr><td><b>${esc(n)}</b></td><td>${esc(d)}</td></tr>`).join("");

const html = `<title>Deadlock Particle Reference</title>
<style>
:root {
  --ground:#101014; --panel:#17171c; --panel2:#1d1d24; --line:#2a2a33;
  --text:#e4e4ea; --muted:#8b8b96; --faint:#5b5b66;
  --accent:#7ff0d3; --accent-dim:#7ff0d322;
  --e:#e8b64e; --i:#6fc3f7; --o:#7ff0d3; --r:#f0975e; --f:#f08d7a; --c:#e77fa4; --p:#b39ddb; --b:#c9c9d4;
  --mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
}
@media (prefers-color-scheme: light) {
  :root { --ground:#f2f5f4; --panel:#ffffff; --panel2:#e9eeec; --line:#d4dcd9;
    --text:#1c2320; --muted:#5d6a65; --faint:#93a09b; --accent:#0d8a6a; --accent-dim:#0d8a6a1a;
    --e:#a3690a; --i:#1668a8; --o:#0d8a6a; --r:#b35a17; --f:#bc4a33; --c:#b13d6d; --p:#6d4fa8; --b:#4d4d58; }
}
:root[data-theme="dark"] { --ground:#101014; --panel:#17171c; --panel2:#1d1d24; --line:#2a2a33;
  --text:#e4e4ea; --muted:#8b8b96; --faint:#5b5b66; --accent:#7ff0d3; --accent-dim:#7ff0d322;
  --e:#e8b64e; --i:#6fc3f7; --o:#7ff0d3; --r:#f0975e; --f:#f08d7a; --c:#e77fa4; --p:#b39ddb; --b:#c9c9d4; }
:root[data-theme="light"] { --ground:#f2f5f4; --panel:#ffffff; --panel2:#e9eeec; --line:#d4dcd9;
  --text:#1c2320; --muted:#5d6a65; --faint:#93a09b; --accent:#0d8a6a; --accent-dim:#0d8a6a1a;
  --e:#a3690a; --i:#1668a8; --o:#0d8a6a; --r:#b35a17; --f:#bc4a33; --c:#b13d6d; --p:#6d4fa8; --b:#4d4d58; }

* { box-sizing:border-box }
body { background:var(--ground); color:var(--text); font-family:var(--sans); margin:0; line-height:1.5; }
.wrap { max-width:980px; margin:0 auto; padding:28px 20px 80px; }

header.top { margin-bottom:18px }
.eyebrow { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); font-weight:600 }
h1 { font-size:26px; margin:4px 0 2px; letter-spacing:-.01em; text-wrap:balance }
.sub { color:var(--muted); font-size:13px; margin:0 }
.sub b { color:var(--text); font-variant-numeric:tabular-nums }

.explain { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:18px 0 }
@media (max-width:760px) { .explain { grid-template-columns:1fr } }
.explain details { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:0 }
.explain summary { cursor:pointer; padding:10px 14px; font-weight:600; font-size:13px; color:var(--text) }
.explain summary::marker { color:var(--accent) }
.explain .ebody { padding:2px 14px 12px; font-size:12.5px; color:var(--muted) }
.explain .ebody b { color:var(--text) }
.explain .ebody code { color:var(--accent); font-family:var(--mono); font-size:11.5px }
.pipe { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 }
.pipe span { border:1px solid var(--line); border-radius:4px; padding:2px 8px; font-size:11.5px; color:var(--text); background:var(--panel2) }
.explain table { border-collapse:collapse; width:100%; font-size:12px; margin-top:6px }
.explain td, .explain th { padding:3px 8px 3px 0; vertical-align:top; text-align:left }
.explain td.num { font-family:var(--mono); color:var(--accent); font-variant-numeric:tabular-nums }

.controls { position:sticky; top:0; z-index:5; background:var(--ground); padding:10px 0 8px; border-bottom:1px solid var(--line); margin-bottom:14px }
.controls .row1 { display:flex; gap:8px; align-items:center }
#q { flex:1; background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:6px;
  padding:8px 12px; font-size:14px; font-family:var(--sans); outline:none }
#q:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim) }
#count { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px }
.chips button { background:var(--panel); border:1px solid var(--line); color:var(--muted); border-radius:99px;
  padding:3px 11px; font-size:12px; cursor:pointer; font-family:var(--sans) }
.chips button:focus-visible { outline:2px solid var(--accent); outline-offset:1px }
.chips button.on { color:var(--ground); font-weight:600 }
.chips button[data-k=""].on { background:var(--text); border-color:var(--text) }
${Object.values(KIND_META).map(([, k]) => `.chips button[data-k="${k}"].on { background:var(--${k}); border-color:var(--${k}) }`).join("\n")}

.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-bottom:8px }
.card[hidden] { display:none }
.card summary { display:flex; align-items:center; gap:12px; padding:10px 14px; cursor:pointer; list-style:none }
.card summary::-webkit-details-marker { display:none }
.card summary:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; border-radius:8px }
.card[open] summary { border-bottom:1px solid var(--line) }
.chip { flex:none; width:86px; text-align:center; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
  border-radius:4px; padding:2px 0; font-weight:600 }
${Object.values(KIND_META).map(([, k]) => `.chip-${k} { color:var(--${k}); background:color-mix(in srgb, var(--${k}) 12%, transparent) }`).join("\n")}
.names { flex:1; min-width:0; display:flex; flex-direction:column }
.friendly { font-weight:600; font-size:14px }
code.cls { font-family:var(--mono); font-size:11px; color:var(--faint) }
.usage { flex:none; display:flex; align-items:center; gap:8px }
.usage .bar { width:90px; height:4px; border-radius:2px; background:var(--panel2); overflow:hidden; display:block }
.usage .bar span { display:block; height:100%; background:var(--accent); border-radius:2px }
.usage .n { font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; min-width:44px; text-align:right }
.body { padding:12px 14px }
.desc { margin:0 0 8px; font-size:13.5px; max-width:70ch }
.samples { font-size:11.5px; color:var(--muted); margin:0 0 10px; overflow-wrap:anywhere }
.samples code { font-family:var(--mono); font-size:10.5px; color:var(--faint) }
.tablewrap { overflow-x:auto }
table { border-collapse:collapse; width:100% }
th { text-align:left; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint);
  padding:0 10px 6px 0; font-weight:600 }
td { border-top:1px solid var(--line); padding:7px 10px 7px 0; vertical-align:top; font-size:12.5px }
.fname { width:38% }
.fname code { font-family:var(--mono); font-size:12px; color:var(--text) }
.flabel { font-size:11px; color:var(--accent) }
.fdesc { font-size:11.5px; color:var(--muted); max-width:48ch }
.fvals { display:flex; flex-wrap:wrap; gap:4px }
td.fvals { display:table-cell }
.val { display:inline-block; background:var(--panel2); border-radius:4px; padding:1px 7px; margin:1px 3px 1px 0;
  font-family:var(--mono); font-size:11px; white-space:nowrap }
.val i { font-style:normal; color:var(--faint); margin-left:5px; font-size:10px }
.untouched { font-size:11px; color:var(--faint); margin:10px 0 0; max-width:100%; overflow-wrap:anywhere }
.untouched code { font-family:var(--mono); font-size:10.5px }
footer { margin-top:26px; font-size:11.5px; color:var(--faint) }
@media (prefers-reduced-motion: no-preference) { .card { transition: border-color .15s } .card:hover { border-color:var(--faint) } }
</style>

<div class="wrap">
<header class="top">
  <div class="eyebrow">Moonahs Mod Maker &middot; particle reference</div>
  <h1>Every tool in the Deadlock particle editor</h1>
  <p class="sub">All <b>228</b> function classes Valve uses, mined from <b>${total.toLocaleString("en-US")}</b> vanilla effects, with the values they actually ship. Numbers next to each value = how many times vanilla uses it.</p>
</header>

<div class="explain">
<details open>
<summary>How an effect is built</summary>
<div class="ebody">
Every .vpcf runs the same pipeline, and the editor's left panel groups functions by stage:
<div class="pipe"><span>Pre-Emission</span><span>Emitters</span><span>Initializers</span><span>Operators</span><span>Forces</span><span>Constraints</span><span>Renderers</span><span>Children</span></div>
<b>Pre-emission</b> sets up control points (CPs - the numbered anchor slots effects attach to). <b>Emitters</b> decide when particles spawn, <b>initializers</b> set their starting attributes, <b>operators</b> change attributes every frame, <b>forces</b> push velocity, <b>constraints</b> hard-limit positions after everything else, and <b>renderers</b> draw the result. <b>Children</b> are whole other .vpcf files playing along with this one - big effects are trees of small ones.
</div>
</details>
<details>
<summary>Reading properties: inputs and attributes</summary>
<div class="ebody">
Most number fields are <b>inputs</b> - the dropdown in the editor picks where the value comes from:
<table><tbody>${pfRows}</tbody></table>
Fields called <code>Output Field</code> / <code>m_nFieldOutput</code> pick which per-particle <b>attribute</b> to write:
<table><tbody>${attrRows}</tbody></table>
Every function also has shared knobs: <b>operator fade in/out</b> (ramp its effect over each particle's life), <b>operator strength</b>, and an <b>endcap</b> mode (what happens while the effect winds down after being stopped).
</div>
</details>
</div>

<div class="controls">
  <div class="row1">
    <input id="q" type="search" placeholder="Search: rainbow, color, radius, m_flEmitRate, C_OP_..." aria-label="Search functions">
    <span id="count"></span>
  </div>
  <div class="chips" role="group" aria-label="Filter by stage">
    <button data-k="" class="on">All</button>
    ${Object.entries(KIND_META).map(([kind, [label, k]]) => `<button data-k="${k}">${label}</button>`).join("\n    ")}
  </div>
</div>

<main id="list">
${cards}
</main>

<footer>Generated from the decompiled vanilla particle corpus (Reduced CSDK 12 era). "Always default in vanilla" lists properties Valve never changes from their defaults - safe to ignore until you know you need them.</footer>
</div>

<script>
const q = document.getElementById("q");
const count = document.getElementById("count");
const cards = [...document.querySelectorAll(".card")];
const chips = [...document.querySelectorAll(".chips button")];
let kind = "";
function apply() {
  const words = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  let shown = 0;
  for (const c of cards) {
    const okKind = !kind || c.dataset.kind === kind;
    const hay = c.dataset.search;
    const okText = words.every((w) => hay.includes(w));
    const ok = okKind && okText;
    c.hidden = !ok;
    if (ok) shown++;
  }
  count.textContent = shown + " / " + cards.length;
}
q.addEventListener("input", apply);
chips.forEach((b) =>
  b.addEventListener("click", () => {
    kind = b.dataset.k;
    chips.forEach((x) => x.classList.toggle("on", x === b));
    apply();
  }),
);
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});
apply();
</script>
`;

writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB, ${classEntries.length} classes)`);
