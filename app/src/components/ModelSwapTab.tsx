import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  heroModelTarget,
  modelBuild,
  modelPreflight,
  modelWorkspace,
  type HeroPortrait,
  type ModelPreflight,
  type ModelWorkspace,
} from "../lib/api";
import { cHeroRoster } from "../lib/dataCache";
import type { ModelOverride } from "../types";
import type { Settings } from "../lib/settings";
import { useToast } from "./Toaster";

const MESH_FILTERS = [{ name: "Model (Blender export)", extensions: ["fbx", "dmx"] }];

/** The community checklist, shown next to the Blender kit. */
const KIT_RULES = [
  "Import the kit's DMX meshes with SourceIO, or model over them",
  "Rig your mesh to the hero's armature bones (names must match)",
  "Vertex groups not named after a bone must be deleted",
  "No names ending in .001 and no spaces in material names",
  "Select all, then Object > Apply > All Transforms before export",
  "Export as FBX (or DMX Binary 9 / Model22 via Blender Source 2 Tools)",
];

/** Model Replacement: put a custom Blender model on a hero. The heavy build
 *  runs here (CS2 Workshop Tools compile, cached artifact); the normal
 *  Compile ships the artifact at the hero's vanilla model path. */
export function ModelSwapTab({
  settings,
  overrides,
  onChange,
  onAutodetect,
}: {
  settings: Settings;
  overrides: ModelOverride[];
  onChange: (next: ModelOverride[]) => void;
  onAutodetect: () => Promise<unknown>;
}) {
  const { push } = useToast();
  const [heroes, setHeroes] = useState<HeroPortrait[]>([]);
  const [hero, setHero] = useState<string>("");
  const [ws, setWs] = useState<ModelWorkspace | null>(null);
  const [wsTarget, setWsTarget] = useState<string>("");
  const [wsBusy, setWsBusy] = useState(false);
  const [meshFile, setMeshFile] = useState<string>("");
  const [preflight, setPreflight] = useState<ModelPreflight | null>(null);
  const [material, setMaterial] = useState<string>("");
  const [building, setBuilding] = useState(false);
  const [buildSteps, setBuildSteps] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  const cs2Ok = useMemo(() => settings.cs2Root.trim().length > 0, [settings.cs2Root]);

  useEffect(() => {
    if (!settings.vpkHelperPath || !settings.deadlockPak) return;
    let cancelled = false;
    cHeroRoster(settings.vpkHelperPath, settings.deadlockPak)
      .then((r) => {
        if (cancelled) return;
        const list = r.filter((h) => settings.showExperimentalHeroes || !h.experimental);
        list.sort((a, b) => a.displayName.localeCompare(b.displayName));
        setHeroes(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings.vpkHelperPath, settings.deadlockPak, settings.showExperimentalHeroes]);

  async function prepareKit(codename: string) {
    setHero(codename);
    setWs(null);
    setPreflight(null);
    setMeshFile("");
    setMaterial("");
    if (!codename) return;
    setWsBusy(true);
    try {
      const target = await heroModelTarget(
        settings.vpkHelperPath,
        settings.deadlockPak,
        codename,
      );
      setWsTarget(target);
      const w = await modelWorkspace(settings.vpkHelperPath, settings.deadlockPak, target);
      setWs(w);
    } catch (e) {
      push("error", `Couldn't prepare the hero kit: ${e}`);
    } finally {
      setWsBusy(false);
    }
  }

  async function pickMesh() {
    if (!ws) return;
    const sel = await openDialog({
      multiple: false,
      filters: MESH_FILTERS,
      title: "Your exported model (FBX or DMX)",
    });
    if (typeof sel !== "string") return;
    setMeshFile(sel);
    setPreflight(null);
    if (sel.toLowerCase().endsWith(".fbx")) {
      try {
        setPreflight(await modelPreflight(sel, ws.bones));
      } catch (e) {
        push("error", `Preflight failed: ${e}`);
      }
    } else {
      setPreflight({
        errors: [],
        warnings: [],
        info: ["DMX file: preflight checks are FBX-only, compiling directly"],
      });
    }
  }

  async function build() {
    if (!ws || !meshFile || !hero) return;
    setBuilding(true);
    setBuildSteps([]);
    try {
      const cacheDir = await join(await appDataDir(), "model_cache");
      const artifactOut = await join(cacheDir, `${hero}.vmdl_c`);
      const rep = await modelBuild({
        cs2Root: settings.cs2Root,
        workspaceDir: ws.dir,
        vmdlInternal: wsTarget,
        meshFile,
        materialOverride: material || null,
        artifactOut,
      });
      setBuildSteps(rep.steps);
      if (rep.ok && rep.artifact) {
        const label = heroes.find((h) => h.codename === hero)?.displayName ?? hero;
        const next: ModelOverride = {
          id: `model_${hero}`,
          hero,
          label: `${label} model`,
          targetPath: `${wsTarget}_c`,
          artifact: rep.artifact,
          meshFile,
          materialOverride: material || null,
          enabled: true,
        };
        onChange([...overrides.filter((o) => o.id !== next.id), next]);
        push("success", `${label} model built - Compile & Install ships it`);
      } else {
        push("error", "Model build failed - see the steps below");
      }
    } catch (e) {
      push("error", `Model build failed: ${e}`);
    } finally {
      setBuilding(false);
    }
  }

  const errorCount = preflight?.errors.length ?? 0;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {!cs2Ok && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            CS2 Workshop Tools needed
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            Custom hero models need the modern Source 2 compiler, which only ships with
            Counter-Strike 2's Workshop Tools (free). In Steam: install CS2, then in its
            Installation options tick "Counter-Strike 2 Workshop Tools". Then hit detect.
          </p>
          <button
            onClick={() => {
              setDetecting(true);
              void onAutodetect().finally(() => setDetecting(false));
            }}
            disabled={detecting}
            className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
          >
            {detecting ? "Detecting…" : "Detect CS2 tools"}
          </button>
        </div>
      )}

      {overrides.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
            Your model swaps
          </h3>
          <div className="mt-2 flex flex-col gap-1">
            {overrides.map((o) => (
              <div key={o.id} className="flex items-center gap-2 text-xs">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={o.enabled !== false}
                    onChange={(e) =>
                      onChange(
                        overrides.map((x) =>
                          x.id === o.id ? { ...x, enabled: e.target.checked } : x,
                        ),
                      )
                    }
                    className="accent-rose-400"
                  />
                  <span className="truncate text-zinc-200">{o.label}</span>
                  <span className="shrink-0 truncate text-[10px] text-zinc-600" title={o.meshFile}>
                    {o.meshFile.split(/[\\/]/).pop()}
                  </span>
                </label>
                <button
                  onClick={() => void prepareKit(o.hero)}
                  className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                >
                  Rebuild…
                </button>
                <button
                  onClick={() => onChange(overrides.filter((x) => x.id !== o.id))}
                  title="Remove this model swap (the hero returns to vanilla on next compile)"
                  className="shrink-0 rounded px-1.5 text-zinc-600 transition hover:bg-zinc-800 hover:text-red-300"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
          1 - Pick a hero, get the Blender kit
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={hero}
            onChange={(e) => void prepareKit(e.target.value)}
            className="w-56 rounded-md border border-zinc-700/80 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-rose-400/70"
          >
            <option value="">Choose a hero…</option>
            {heroes.map((h) => (
              <option key={h.codename} value={h.codename}>
                {h.displayName}
              </option>
            ))}
          </select>
          {wsBusy && <span className="text-xs text-zinc-500">Decompiling the hero…</span>}
          {ws && (
            <>
              <span className="text-xs text-zinc-500">
                {ws.files} files, {ws.bones.length} bones
              </span>
              <button
                onClick={() => void revealItemInDir(ws.vmdl)}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
              >
                Open kit folder
              </button>
            </>
          )}
        </div>
        {ws && (
          <ul className="mt-3 flex list-disc flex-col gap-0.5 pl-5 text-[11px] text-zinc-500">
            {KIT_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      {ws && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
            2 - Your exported model
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void pickMesh()}
              className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-400/20"
            >
              {meshFile ? "Change file…" : "Pick your FBX / DMX…"}
            </button>
            {meshFile && (
              <span className="truncate text-xs text-zinc-400" title={meshFile}>
                {meshFile.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
          {preflight && (
            <div className="mt-2 flex flex-col gap-1 text-[11px]">
              {preflight.errors.map((e) => (
                <p key={e} className="text-red-300">
                  ✕ {e}
                </p>
              ))}
              {preflight.warnings.map((w) => (
                <p key={w} className="text-amber-300/90">
                  ⚠ {w}
                </p>
              ))}
              {preflight.info.map((i) => (
                <p key={i} className="text-zinc-500">
                  {i}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      {ws && meshFile && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-400">
            3 - Material and build
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              title="One game material applied to the whole model, or keep the material names from Blender (checkerboards unless they match real game materials)"
              className="w-72 rounded-md border border-zinc-700/80 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-rose-400/70"
            >
              <option value="">Keep my Blender material names</option>
              {ws.materials.map((m) => (
                <option key={m} value={m}>
                  {m.split("/").pop()} ({m})
                </option>
              ))}
            </select>
            <button
              onClick={() => void build()}
              disabled={building || !cs2Ok || errorCount > 0}
              title={
                errorCount > 0
                  ? "Fix the preflight errors first"
                  : !cs2Ok
                    ? "CS2 Workshop Tools required"
                    : "Compile the model via CS2 Workshop Tools"
              }
              className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
            >
              {building ? "Building…" : "Build the model"}
            </button>
            {errorCount > 0 && (
              <span className="text-[11px] text-red-300">fix the {errorCount} error(s) above first</span>
            )}
          </div>
          {buildSteps.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5 font-mono text-[10px] text-zinc-500">
              {buildSteps.map((s, i) => (
                <p key={i} className={s.startsWith("FAILED") ? "text-red-300" : ""}>
                  {s}
                </p>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] text-zinc-600">
            After a successful build, the swap appears above and ships with your normal Compile &
            Install. Rebuild after game patches if the hero's animations change.
          </p>
        </section>
      )}
    </div>
  );
}
