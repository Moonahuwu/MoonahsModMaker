// deadlock-particles MCP server.
//
// Exposes Deadlock particle modding as tools: search/read the decompiled
// vanilla corpus, look up operator docs from the mined catalog, stage + edit
// sources into a CSDK addon, compile with resourcecompiler, pack a vpk, and
// screenshot the particle editor window for a visual feedback loop.
//
// Paths self-resolve from the repo layout and the Mod Maker's settings.json;
// env overrides: DEADLOCK_CSDK_ROOT, DEADLOCK_PAK, DEADLOCK_VPK_HELPER,
// DEADLOCK_PARTICLES_ADDON (addon name, default "claude_particles").

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseKV3, summarize, isDefaulty } from "../particle-catalog/kv3.mjs";
import { C, F, ATTRS, PF_TYPES } from "../particle-catalog/annotations.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

// ---- configuration ---------------------------------------------------------

function appSettings() {
  try {
    const p = join(process.env.APPDATA ?? "", "com.digiphoenix.deadlock-intro-tool", "settings.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
const S = appSettings();
const CSDK = process.env.DEADLOCK_CSDK_ROOT || S.csdkRoot || "";
const PAK = process.env.DEADLOCK_PAK || S.deadlockPak || "";
const HELPER =
  process.env.DEADLOCK_VPK_HELPER || S.vpkHelperPath || join(REPO, "tools", "vpk-helper", "dist", "vpk-helper.exe");
const ADDON = process.env.DEADLOCK_PARTICLES_ADDON || "claude_particles";

const CORPUS = join(REPO, "VanillaFiles", "particles_kv3");
const CATALOG = join(REPO, "VanillaFiles", "particle_catalog.json");
const DLL_STRINGS = join(REPO, "VanillaFiles", "particles_dll_strings.txt");
const CONTENT = () => join(CSDK, "content", "citadel_addons", ADDON);
const COMPILED = () => join(CSDK, "game", "citadel_addons", ADDON);
const RC = () => join(CSDK, "game", "bin", "win64", "resourcecompiler.exe");
const GAMEINFO_DIR = () => join(CSDK, "game", "citadel");

// ---- helpers ---------------------------------------------------------------

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

let pathIndex = null;
function index() {
  if (pathIndex) return pathIndex;
  if (!existsSync(CORPUS)) return (pathIndex = []);
  const out = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, rel + name + "/");
      else if (name.endsWith(".vpcf")) out.push(rel + name);
    }
  })(CORPUS, "");
  return (pathIndex = out);
}

/** Normalize any user-ish path into the canonical corpus rel, or null. */
function canon(input) {
  let p = String(input).replaceAll("\\", "/").replace(/^\/+/, "").trim();
  p = p.replace(/\.vpcf(_c)?$/, "") + ".vpcf";
  if (!p.startsWith("particles/")) p = "particles/" + p;
  return p;
}
function inCorpus(rel) {
  return existsSync(join(CORPUS, rel));
}
function stagedPath(rel) {
  return join(CONTENT(), rel);
}
function humanize(cls) {
  return cls
    .replace(/^C_(OP|INIT)_/, "")
    .replace(/^CParticle/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
function className(cls) {
  return C[cls]?.[0] ?? humanize(cls);
}

const KIND_ARRAYS = {
  m_PreEmissionOperators: "Pre-Emission",
  m_Emitters: "Emitters",
  m_Initializers: "Initializers",
  m_Operators: "Operators",
  m_ForceGenerators: "Forces",
  m_Constraints: "Constraints",
  m_Renderers: "Renderers",
};

let catalogCache = null;
function catalog() {
  if (!catalogCache) catalogCache = JSON.parse(readFileSync(CATALOG, "utf8"));
  return catalogCache;
}

function listStagedFiles() {
  const root = CONTENT();
  if (!existsSync(root)) return [];
  const out = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, rel + name + "/");
      else if (name.endsWith(".vpcf")) out.push(rel + name);
    }
  })(root, "");
  return out;
}

// ---- server ----------------------------------------------------------------

const server = new McpServer(
  { name: "deadlock-particles", version: "1.0.0" },
  {
    instructions:
      "Tools for modding Deadlock particle effects (.vpcf). Typical flow: search_particles to find an effect, particle_outline to see its structure (check m_Children - visuals usually live in child systems), catalog_lookup for what an operator/property does, stage_particle + edit_particle to modify, compile_particles, pack_addon, then screenshot_window to see the result in the particle editor. Paths are like particles/upgrades/aoe_root_explosion.vpcf.",
  },
);

server.tool(
  "search_particles",
  "Search the 15k+ vanilla particle effect paths. All words must match somewhere in the path. Returns canonical .vpcf paths for the other tools.",
  { query: z.string().describe("space-separated words, e.g. 'seven ult lightning'"), limit: z.number().optional() },
  async ({ query, limit }) => {
    const idx = index();
    if (idx.length === 0) return fail(`corpus missing at ${CORPUS} - run refresh_corpus first`);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = idx.filter((p) => words.every((w) => p.toLowerCase().includes(w)));
    hits.sort((a, b) => a.length - b.length);
    const n = limit ?? 30;
    return text(
      `${hits.length} match(es)${hits.length > n ? `, showing ${n}` : ""}:\n` + hits.slice(0, n).join("\n"),
    );
  },
);

server.tool(
  "particle_outline",
  "Structural summary of one effect: every function per stage with its non-default properties, plus child system refs. Reads the staged copy if one exists, else vanilla.",
  { path: z.string() },
  async ({ path }) => {
    const rel = canon(path);
    const staged = stagedPath(rel);
    const src = existsSync(staged) ? staged : join(CORPUS, rel);
    if (!existsSync(src)) return fail(`not found: ${rel} (try search_particles)`);
    let root;
    try {
      root = parseKV3(readFileSync(src, "utf8"));
    } catch (e) {
      return fail(`parse failed for ${rel}: ${e.message}`);
    }
    const lines = [`${rel}  (${src === staged ? "STAGED - your edited copy" : "vanilla"})`];
    const base = [];
    for (const [k, v] of Object.entries(root)) {
      if (KIND_ARRAYS[k] || k === "m_Children" || k === "m_controlPointConfigurations" || k === "_class") continue;
      const s = summarize(v);
      if (!isDefaulty(s) && s !== "false") base.push(`${k}=${s}`);
    }
    if (base.length) lines.push(`Base: ${base.join(", ")}`);
    for (const [arrKey, label] of Object.entries(KIND_ARRAYS)) {
      const arr = root[arrKey];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      lines.push(`${label}:`);
      for (const fn of arr) {
        if (!fn || typeof fn !== "object" || !fn._class) continue;
        const tuned = [];
        for (const [k, v] of Object.entries(fn)) {
          if (k === "_class") continue;
          const s = summarize(v);
          if (!isDefaulty(s) && s !== "false") tuned.push(`${k}=${s}`);
        }
        const shown = tuned.slice(0, 10).join(", ") + (tuned.length > 10 ? `, +${tuned.length - 10} more` : "");
        lines.push(`  - ${fn._class} "${className(fn._class)}"${fn.m_bDisableOperator === true ? " [DISABLED]" : ""}${shown ? ": " + shown : ""}`);
      }
    }
    const children = [...readFileSync(src, "utf8").matchAll(/m_ChildRef = resource:"([^"]+)"/g)].map((m) => m[1]);
    if (children.length) lines.push(`Children (${children.length}):`, ...children.map((c) => `  ${c}`));
    return text(lines.join("\n"));
  },
);

server.tool(
  "read_particle",
  "Full decompiled KV3 source of an effect. source: auto = staged copy if present else vanilla.",
  { path: z.string(), source: z.enum(["auto", "vanilla", "staged"]).optional() },
  async ({ path, source }) => {
    const rel = canon(path);
    const mode = source ?? "auto";
    const staged = stagedPath(rel);
    let file;
    if (mode === "vanilla") file = join(CORPUS, rel);
    else if (mode === "staged") file = staged;
    else file = existsSync(staged) ? staged : join(CORPUS, rel);
    if (!existsSync(file)) return fail(`not found: ${rel} (${mode})`);
    const body = readFileSync(file, "utf8");
    return text(`// ${rel} (${file === staged ? "staged" : "vanilla"}, ${body.length} chars)\n` + body);
  },
);

server.tool(
  "catalog_lookup",
  "Operator/property documentation mined from all vanilla effects. Pass an exact class (C_OP_ColorInterpolate), a search term ('color', 'emit'), or the special queries 'attributes' (particle attribute index table) / 'inputs' (the input-type dropdown explained).",
  { query: z.string() },
  async ({ query }) => {
    const q = query.trim();
    if (/^attributes?$/i.test(q))
      return text("Particle attribute indices (m_nFieldOutput / m_nFieldInput):\n" + ATTRS.map(([n, nm, d]) => `${n.padStart(2)}  ${nm} - ${d}`).join("\n"));
    if (/^inputs?( types?)?$/i.test(q))
      return text("Input types (the per-field dropdown in the editor):\n" + PF_TYPES.map(([n, d]) => `- ${n}: ${d}`).join("\n"));
    const cat = catalog();
    const exact = Object.keys(cat.classes).find((k) => k.toLowerCase() === q.toLowerCase());
    if (exact) {
      const rec = cat.classes[exact];
      const lines = [
        `${exact}  "${className(exact)}"`,
        `kind: ${Object.keys(rec.kinds).join(", ")} | used in ${rec.fileCount} of ${cat.filesParsed} vanilla effects (${rec.uses} instances)`,
      ];
      if (C[exact]?.[1]) lines.push(C[exact][1]);
      lines.push(`seen in: ${rec.sampleFiles.slice(0, 4).join(", ")}`, "", "Properties (tuned in vanilla first):");
      const untouched = [];
      for (const [fk, fv] of Object.entries(rec.fields)) {
        if (fv.interesting === 0) {
          untouched.push(fk);
          continue;
        }
        const label = fv.label && fv.label.toLowerCase() !== fk.toLowerCase() ? ` ("${fv.label}")` : "";
        const desc = F[fk] ? ` - ${F[fk]}` : "";
        const vals = fv.values.slice(0, 6).map((v) => `${v.val} x${v.count}`).join(" | ");
        lines.push(`  ${fk}${label}${desc}\n      vanilla values: ${vals}`);
      }
      if (untouched.length) lines.push("", `Always default in vanilla (ignore until needed): ${untouched.join(", ")}`);
      return text(lines.join("\n"));
    }
    // fuzzy search over classes
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const [cls, rec] of Object.entries(cat.classes)) {
      const hay = [cls, className(cls), C[cls]?.[1] ?? "", ...Object.keys(rec.fields)].join(" ").toLowerCase();
      if (words.every((w) => hay.includes(w))) scored.push([cls, rec.fileCount]);
    }
    if (scored.length === 0) return text(`no classes match "${q}"`);
    scored.sort((a, b) => b[1] - a[1]);
    return text(
      `${scored.length} class(es) match "${q}" (by vanilla usage):\n` +
        scored
          .slice(0, 15)
          .map(([cls, n]) => `- ${cls}  "${className(cls)}"  [${n} files]${C[cls]?.[1] ? " - " + C[cls][1].split(" - ")[0].split(". ")[0] : ""}`)
          .join("\n") +
        `\n\nPass an exact class name for full property docs.`,
    );
  },
);

server.tool(
  "stage_particle",
  "Copy an effect's vanilla source into the working addon so it can be edited and compiled. No-op if already staged (force overwrites, discarding edits).",
  { path: z.string(), force: z.boolean().optional() },
  async ({ path, force }) => {
    const rel = canon(path);
    if (!inCorpus(rel)) return fail(`not in corpus: ${rel} (try search_particles)`);
    const dest = stagedPath(rel);
    if (existsSync(dest) && !force) return text(`already staged: ${dest} (pass force:true to reset to vanilla)`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(CORPUS, rel), dest);
    return text(`staged ${rel} -> ${dest}`);
  },
);

server.tool(
  "edit_particle",
  "Exact-string edit on a staged effect source (auto-stages from vanilla first if needed). old_string must match exactly; if it matches more than once, pass replace_all or make it more specific.",
  { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
  async ({ path, old_string, new_string, replace_all }) => {
    const rel = canon(path);
    const dest = stagedPath(rel);
    if (!existsSync(dest)) {
      if (!inCorpus(rel)) return fail(`not found: ${rel}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(CORPUS, rel), dest);
    }
    const body = readFileSync(dest, "utf8");
    const count = body.split(old_string).length - 1;
    if (count === 0) return fail(`old_string not found in ${rel}`);
    if (count > 1 && !replace_all) return fail(`old_string matches ${count} times in ${rel} - pass replace_all:true or add surrounding context`);
    writeFileSync(dest, body.replaceAll(old_string, new_string));
    return text(`edited ${rel}: ${count} replacement(s). Run compile_particles to build.`);
  },
);

server.tool(
  "write_particle",
  "Write a complete .vpcf source into the working addon (overwrites any staged copy; the path may be new for a custom effect).",
  { path: z.string(), content: z.string() },
  async ({ path, content }) => {
    const rel = canon(path);
    const dest = stagedPath(rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    return text(`wrote ${rel} (${content.length} chars) -> ${dest}`);
  },
);

server.tool(
  "list_staged",
  "List staged effect sources in the working addon and whether each has an up-to-date compile.",
  {},
  async () => {
    const rels = listStagedFiles();
    if (rels.length === 0) return text(`nothing staged in ${CONTENT()}`);
    const lines = rels.map((rel) => {
      const src = statSync(stagedPath(rel)).mtimeMs;
      const cPath = join(COMPILED(), rel + "_c");
      const state = !existsSync(cPath) ? "NOT COMPILED" : statSync(cPath).mtimeMs >= src ? "compiled" : "STALE (recompile)";
      return `${rel}  [${state}]`;
    });
    return text(`addon "${ADDON}":\n` + lines.join("\n"));
  },
);

server.tool(
  "compile_particles",
  "Compile staged sources to .vpcf_c with the CSDK resourcecompiler (all staged files by default, or just the listed paths).",
  { paths: z.array(z.string()).optional() },
  async ({ paths }) => {
    if (!existsSync(RC())) return fail(`resourcecompiler not found at ${RC()} (csdkRoot: "${CSDK}")`);
    const rels = (paths && paths.length ? paths.map(canon) : listStagedFiles()).filter((r, i, a) => a.indexOf(r) === i);
    if (rels.length === 0) return fail("nothing staged to compile");
    const missing = rels.filter((r) => !existsSync(stagedPath(r)));
    if (missing.length) return fail(`not staged: ${missing.join(", ")}`);
    const args = [];
    for (const r of rels) args.push("-i", stagedPath(r));
    args.push("-game", GAMEINFO_DIR(), "-f", "-danger_mode_ignore_schema_mismatches");
    const started = Date.now();
    let out;
    try {
      out = await run(RC(), args, { cwd: dirname(RC()), maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
    } catch (e) {
      return fail(`resourcecompiler failed: ${(e.stderr || e.stdout || e.message).slice(-2000)}`);
    }
    const results = rels.map((r) => {
      const c = join(COMPILED(), r + "_c");
      const ok = existsSync(c) && statSync(c).mtimeMs >= started - 1000;
      return `${ok ? "OK " : "FAIL"} ${r}`;
    });
    const tail = out.stdout.trim().split(/\r?\n/).slice(-3).join("\n");
    return text(results.join("\n") + "\n\n" + tail);
  },
);

server.tool(
  "pack_addon",
  "Pack all compiled files of the working addon into an installable pak vpk (default: <repo>/output/<addon>/pak01_dir.vpk). Install it as a free pakNN_dir.vpk slot in the game's addons folder.",
  { out_vpk: z.string().optional() },
  async ({ out_vpk }) => {
    if (!existsSync(COMPILED())) return fail(`nothing compiled yet at ${COMPILED()}`);
    const dest = out_vpk || join(REPO, "output", ADDON, "pak01_dir.vpk");
    mkdirSync(dirname(dest), { recursive: true });
    try {
      const out = await run(HELPER, ["pack", COMPILED(), dest], { maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
      const mb = (statSync(dest).size / 1024 / 1024).toFixed(2);
      return text(`${out.stdout.trim()}\n${dest} (${mb} MB)\nInstall: copy into the game's citadel/addons as a free pakNN_dir.vpk slot.`);
    } catch (e) {
      return fail(`pack failed: ${(e.stderr || e.message).slice(-1000)}`);
    }
  },
);

server.tool(
  "screenshot_window",
  "Screenshot a native window by title regex (default matches the particle editor's open .vpcf title) and return the image. Brings the window to the foreground first unless focus:false.",
  { title_pattern: z.string().optional(), focus: z.boolean().optional() },
  async ({ title_pattern, focus }) => {
    const png = join(tmpdir(), `pmcp_shot_${Date.now()}.png`);
    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "screenshot.ps1"),
      "-Pattern", title_pattern ?? "\\.vpcf", "-OutPath", png,
    ];
    if (focus === false) args.push("-NoFocus");
    try {
      const out = await run("powershell.exe", args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      const info = out.stdout.trim();
      const data = readFileSync(png).toString("base64");
      rmSync(png, { force: true });
      return {
        content: [
          { type: "text", text: info },
          { type: "image", data, mimeType: "image/png" },
        ],
      };
    } catch (e) {
      rmSync(png, { force: true });
      return fail(`screenshot failed: ${(e.stderr || e.message).slice(-500)} (is the window open and not minimized?)`);
    }
  },
);

server.tool(
  "refresh_corpus",
  "After a game patch: re-decompile all vanilla particles from the live pak and rebuild the operator catalog. Takes a few minutes.",
  {},
  async () => {
    if (!existsSync(PAK)) return fail(`game pak not found: "${PAK}"`);
    if (!existsSync(HELPER)) return fail(`vpk-helper not found: "${HELPER}"`);
    const t0 = Date.now();
    let out;
    try {
      out = await run(HELPER, ["decompileall", PAK, CORPUS, "particles/"], { maxBuffer: 64 * 1024 * 1024, timeout: 900000 });
    } catch (e) {
      return fail(`decompile failed: ${(e.stderr || e.message).slice(-1000)}`);
    }
    pathIndex = null;
    let cat = "catalog rebuild skipped (dll strings dump missing)";
    if (existsSync(DLL_STRINGS)) {
      try {
        const r = await run(
          process.execPath,
          [join(REPO, "tools", "particle-catalog", "build-catalog.mjs"), CORPUS, DLL_STRINGS, CATALOG],
          { maxBuffer: 16 * 1024 * 1024, timeout: 600000 },
        );
        catalogCache = null;
        cat = r.stdout.trim();
      } catch (e) {
        cat = `catalog rebuild failed: ${(e.stderr || e.message).slice(-500)}`;
      }
    }
    return text(`${out.stdout.trim()}\n${cat}\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  },
);

await server.connect(new StdioServerTransport());
console.error(`deadlock-particles MCP up (corpus: ${index().length} effects, addon: ${ADDON})`);
