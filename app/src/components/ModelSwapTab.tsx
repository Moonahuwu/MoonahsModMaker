import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  heroModelTarget,
  fbxAutoTextures,
  matchMaterialTextures,
  modelBuild,
  modelGltf,
  modelOpenModeldoc,
  modelPreflight,
  modelWorkspace,
  type HeroPortrait,
  type MatchedMaterial,
  type ModelPreflight,
  type ModelWorkspace,
} from "../lib/api";
import { cHeroRoster } from "../lib/dataCache";
import type { ModelOverride } from "../types";
import type { Settings } from "../lib/settings";
import { useToast } from "./Toaster";
import { ObjectPicker, objectByModel, type ObjectTarget } from "./ObjectPicker";
// three.js is ~600KB - only pull it in when someone actually opens this tab.
const ModelPreview3D = lazy(() =>
  import("./ModelPreview3D").then((m) => ({ default: m.ModelPreview3D })),
);

const MESH_FILTERS = [{ name: "Model (Blender export)", extensions: ["fbx", "dmx"] }];
const IMAGE_FILTERS = [{ name: "Texture image", extensions: ["png", "jpg", "jpeg", "tga"] }];

/** The community checklist, shown next to the Blender kit. */
const KIT_RULES = [
  "Import the kit's DMX meshes with SourceIO, or model over them",
  "Rig your mesh to the hero's armature bones (names must match)",
  "Vertex groups not named after a bone must be deleted",
  "Avoid .001-style name suffixes and spaces in material names",
  "Select all, then Object > Apply > All Transforms before export",
  "Export as FBX (or DMX Binary 9 / Model22 via Blender Source 2 Tools)",
  "Textures: keep files named like the material (Body_Base_color.png, Body_Normal.png)",
];

/** Objects have no armature, so the rules are much shorter. */
const OBJECT_RULES = [
  "No rigging needed - objects are just a mesh",
  "Model it roughly the size of the original so it fits the world",
  "Select all, then Object > Apply > All Transforms before export",
  "Export as FBX (or DMX), then give each material a texture below",
  "The original's physics and drop behaviour are kept automatically",
];

type MatMode = "textures" | "game";
/** Which half of the tab: hero replacement (CS2) or objects (CSDK). */
type SwapMode = "hero" | "object";

/** Friendly labels for the CitadelCameraSettings_t scalars. */
const CAMERA_LABELS: Record<string, string> = {
  m_flCameraSideOffset: "Side offset",
  m_flCameraBackOffset: "Distance behind",
  m_flCameraBackOffsetAiming: "Distance when aiming",
  m_flCameraHeightStanding: "Height (standing)",
  m_flCameraHeightCrouching: "Height (crouching)",
  m_flCameraSideOffsetZiplining: "Side offset (zipline)",
  m_flCameraHeightOffsetZiplining: "Height offset (zipline)",
};

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
  const [mode, setMode] = useState<SwapMode>("hero");
  // The picked object (object mode); heroes use `hero` below.
  const [obj, setObj] = useState<ObjectTarget | null>(null);
  const [heroes, setHeroes] = useState<HeroPortrait[]>([]);
  const [hero, setHero] = useState<string>("");
  const [ws, setWs] = useState<ModelWorkspace | null>(null);
  const [wsTarget, setWsTarget] = useState<string>("");
  const [wsBusy, setWsBusy] = useState(false);
  const [meshFile, setMeshFile] = useState<string>("");
  const [preflight, setPreflight] = useState<ModelPreflight | null>(null);
  const [material, setMaterial] = useState<string>("");
  const [importScale, setImportScale] = useState<string>("1");
  const [matMode, setMatMode] = useState<MatMode>("textures");
  const [texSpecs, setTexSpecs] = useState<MatchedMaterial[]>([]);
  const [matching, setMatching] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildSteps, setBuildSteps] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  // Camera edits, keyed by CitadelCameraSettings_t field; raw input strings,
  // only values that parse AND differ from stock become overrides.
  const [camEdit, setCamEdit] = useState<Record<string, string>>({});
  const [showCam, setShowCam] = useState(false);
  const [openingDoc, setOpeningDoc] = useState(false);
  // The vanilla model as glTF: shown in the 3D preview, and the same export
  // users download to start from in Blender.
  const [previewGlb, setPreviewGlb] = useState("");
  // Preview shows the vanilla model until a mesh is picked, then yours.
  const [previewMine, setPreviewMine] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const cs2Ok = useMemo(() => settings.cs2Root.trim().length > 0, [settings.cs2Root]);
  const toolsOk = useMemo(() => settings.csdkRoot.trim().length > 0, [settings.csdkRoot]);

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

  /** Reset every per-target editing state (both modes share the steps). */
  function clearTarget() {
    setPreviewGlb("");
    setWs(null);
    setPreflight(null);
    setMeshFile("");
    setMaterial("");
    setTexSpecs([]);
    setCamEdit({});
    setShowCam(false);
  }

  async function prepareKit(codename: string): Promise<ModelWorkspace | null> {
    setHero(codename);
    setObj(null);
    clearTarget();
    if (!codename) return null;
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
      void loadPreview(target);
      // A real game material by default: Blender material names that don't
      // exist as game vmats render NOTHING (red bounds box in game).
      setMaterial(w.materials[0] ?? "");
      return w;
    } catch (e) {
      push("error", `Couldn't prepare the hero kit: ${e}`);
      return null;
    } finally {
      setWsBusy(false);
    }
  }

  /** Same as prepareKit but for a catalog object (no hero roster lookup -
   *  the model path IS the target). */
  async function prepareObject(target: ObjectTarget): Promise<ModelWorkspace | null> {
    setHero("");
    setObj(target);
    clearTarget();
    setWsTarget(target.model);
    setWsBusy(true);
    try {
      const w = await modelWorkspace(
        settings.vpkHelperPath,
        settings.deadlockPak,
        `${target.model}_c`,
      );
      setWs(w);
      void loadPreview(target.model);
      setMaterial(w.materials[0] ?? "");
      return w;
    } catch (e) {
      push("error", `Couldn't prepare ${target.label}: ${e}`);
      return null;
    } finally {
      setWsBusy(false);
    }
  }

  /** Export the vanilla model as glTF for the 3D preview (cached backend
   *  side, so revisiting a target is instant). */
  async function loadPreview(modelInternal: string) {
    try {
      const glb = await modelGltf(
        settings.vpkHelperPath,
        settings.deadlockPak,
        modelInternal,
      );
      setPreviewGlb(glb);
    } catch {
      setPreviewGlb(""); // preview is a bonus - never block the build on it
    }
  }

  /** Save the vanilla model (+ its textures) somewhere the user picks, as a
   *  Blender starting point. */
  async function downloadForBlender() {
    if (!wsTarget || !target) return;
    const dest = await openDialog({
      directory: true,
      title: "Where should the model go?",
    });
    if (typeof dest !== "string") return;
    setDownloading(true);
    try {
      const glb = await modelGltf(
        settings.vpkHelperPath,
        settings.deadlockPak,
        wsTarget,
        dest,
      );
      push("success", `${target.label} exported - import the .glb in Blender (File > Import > glTF)`);
      void revealItemInDir(glb);
    } catch (e) {
      push("error", `Export failed: ${e}`);
    } finally {
      setDownloading(false);
    }
  }

  /** Preflight + per-material texture rows for a chosen mesh file. */
  async function analyzeMesh(sel: string, w: ModelWorkspace, keepSpecs?: MatchedMaterial[]) {
    setMeshFile(sel);
    setPreviewMine(true);
    setPreflight(null);
    setTexSpecs([]);
    // Blender's default FBX export is in centimeters: everything imports x100
    // without this. DMX via Blender Source 2 Tools follows the 39.37 flow = 1:1.
    setImportScale(sel.toLowerCase().endsWith(".fbx") ? "0.01" : "1");
    if (sel.toLowerCase().endsWith(".fbx")) {
      try {
        // Objects aren't skinned - an unrigged mesh is correct for them.
        const pf = await modelPreflight(sel, w.bones, mode === "hero");
        setPreflight(pf);
        // Kit meshes kept from the decompile carry materials named after the
        // hero's real vmats (SourceIO does that) - map those back to the
        // game paths automatically so only the user's own materials need
        // texture files.
        const gameByStem = new Map(
          w.materials.map((p) => [
            (p.split("/").pop() ?? p).replace(/\.vmat$/i, "").toLowerCase(),
            p,
          ]),
        );
        // Textures the FBX itself links (Blender writes their names into the
        // export) - resolved next to the file, so a normal export needs no
        // folder picking at all.
        let linked: MatchedMaterial[] = [];
        try {
          linked = await fbxAutoTextures(sel, pf.materials);
        } catch {
          /* auto-detect is a convenience - never block on it */
        }
        setTexSpecs(
          pf.materials.map((name) => {
            const kept = keepSpecs?.find((s) => s.name === name);
            if (kept) return kept;
            const auto = linked.find((l) => l.name === name);
            if (auto?.color) return { ...auto, gameVmat: null };
            const game = gameByStem.get(name.toLowerCase()) ?? null;
            return {
              name,
              color: null,
              normal: null,
              roughness: null,
              metalness: null,
              gameVmat: game,
            };
          }),
        );
        const found = linked.filter((l) => l.color).length;
        if (found > 0) {
          push("success", `${found} texture(s) picked up from the model file`);
        }
        if (pf.materials.length === 0) setMatMode("game");
      } catch (e) {
        push("error", `Preflight failed: ${e}`);
      }
    } else {
      setPreflight({
        errors: [],
        warnings: [],
        info: ["DMX file: preflight checks are FBX-only, compiling directly"],
        materials: [],
      });
      setMatMode("game");
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
    await analyzeMesh(sel, ws);
  }

  /** Rebuild: re-open the kit and prefill the mesh + texture sets from the
   *  saved override so one click lands back at the Build button. */
  async function startRebuild(o: ModelOverride) {
    // Objects carry their catalog entry via the target path; heroes go
    // through the roster.
    const asObject = objectByModel(o.targetPath);
    let w: ModelWorkspace | null;
    if (asObject) {
      setMode("object");
      w = await prepareObject(asObject);
    } else {
      setMode("hero");
      w = await prepareKit(o.hero);
    }
    if (!w) return;
    if (o.materialSpecs && o.materialSpecs.length > 0) {
      setMatMode("textures");
      await analyzeMesh(o.meshFile, w, o.materialSpecs);
    } else {
      setMatMode("game");
      await analyzeMesh(o.meshFile, w);
      setMaterial(o.materialOverride ?? "");
    }
    if (o.cameraOverrides && o.cameraOverrides.length > 0) {
      setCamEdit(Object.fromEntries(o.cameraOverrides.map((c) => [c.key, String(c.value)])));
      setShowCam(true);
    }
  }

  /** What's being replaced right now, in whichever mode - the build, the
   *  override record and the ModelDoc launch all key off this. */
  const target = useMemo(() => {
    if (mode === "object") {
      if (!obj) return null;
      return {
        kind: "prop" as const,
        key: `obj_${obj.id}`,
        hero: obj.id,
        label: obj.label,
      };
    }
    if (!hero) return null;
    return {
      kind: "hero" as const,
      key: hero,
      hero,
      label: heroes.find((h) => h.codename === hero)?.displayName ?? hero,
    };
  }, [mode, obj, hero, heroes]);

  /** Camera overrides = fields the user changed away from stock. */
  function cameraOverrides(): { key: string; value: number }[] {
    if (!ws) return [];
    const out: { key: string; value: number }[] = [];
    for (const c of ws.camera) {
      const raw = camEdit[c.key];
      if (raw === undefined || raw.trim() === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v === c.value) continue;
      out.push({ key: c.key, value: v });
    }
    return out;
  }

  /** Point at a folder; texture files auto-match material names by prefix. */
  async function pickTextureFolder() {
    if (!preflight || preflight.materials.length === 0) return;
    const sel = await openDialog({ directory: true, title: "Your textures folder" });
    if (typeof sel !== "string") return;
    setMatching(true);
    try {
      const matched = await matchMaterialTextures(sel, preflight.materials);
      // Folder matches fill gaps; hand-picked textures and game-material
      // mappings stay put (a texture match beats an auto game mapping).
      setTexSpecs((prev) =>
        matched.map((m) => {
          const cur = prev.find((p) => p.name === m.name);
          return {
            name: m.name,
            color: cur?.color ?? m.color,
            normal: cur?.normal ?? m.normal,
            roughness: cur?.roughness ?? m.roughness,
            metalness: cur?.metalness ?? m.metalness,
            gameVmat: (cur?.color ?? m.color) ? null : (cur?.gameVmat ?? null),
          };
        }),
      );
      const found = matched.filter((m) => m.color).length;
      push(
        found > 0 ? "success" : "info",
        `${found} of ${matched.length} materials matched a color texture`,
      );
    } catch (e) {
      push("error", `Texture matching failed: ${e}`);
    } finally {
      setMatching(false);
    }
  }

  async function pickColorFor(name: string) {
    const sel = await openDialog({
      multiple: false,
      filters: IMAGE_FILTERS,
      title: `Color texture for ${name}`,
    });
    if (typeof sel !== "string") return;
    setTexSpecs((prev) =>
      prev.map((s) => (s.name === name ? { ...s, color: sel, gameVmat: null } : s)),
    );
  }

  async function build() {
    if (!ws || !meshFile || !target) return;
    const useTextures = matMode === "textures";
    const specs = useTextures ? texSpecs.filter((s) => s.color || s.gameVmat) : [];
    if (useTextures && specs.length === 0) {
      push("error", "Assign a texture or game material to at least one material first");
      return;
    }
    setBuilding(true);
    setBuildSteps([]);
    try {
      const cacheDir = await join(await appDataDir(), "model_cache");
      const artifactOut = await join(cacheDir, `${target.key}.vmdl_c`);
      const materialsOut = await join(cacheDir, `${target.key}_mats`);
      const scale = Number(importScale) || 1;
      const camera = cameraOverrides();
      const rep = await modelBuild({
        cs2Root: settings.cs2Root,
        kind: target.kind,
        workspaceDir: ws.dir,
        vmdlInternal: wsTarget,
        meshFile,
        materialOverride: useTextures ? null : material || null,
        importScale: scale,
        artifactOut,
        materials: specs.map((s) => ({
          name: s.name,
          color: s.color,
          normal: s.normal,
          roughness: s.roughness,
          metalness: s.metalness,
          gameVmat: s.gameVmat ?? null,
        })),
        // Objects compile in the CSDK, so their builds always need it - not
        // just when custom textures are involved.
        toolsRoot: useTextures || target.kind === "prop" ? settings.csdkRoot : null,
        materialsOut: useTextures ? materialsOut : null,
        ffmpegPath: settings.ffmpegPath || null,
        camera,
      });
      setBuildSteps(rep.steps);
      if (rep.ok && rep.artifact) {
        const label = target.label;
        const next: ModelOverride = {
          id: `model_${target.key}`,
          hero: target.hero,
          label: target.kind === "prop" ? `${label} (object)` : `${label} model`,
          targetPath: `${wsTarget}_c`,
          artifact: rep.artifact,
          meshFile,
          materialOverride: useTextures ? null : material || null,
          materials: rep.materials,
          materialSpecs: useTextures ? specs : undefined,
          cameraOverrides: camera.length > 0 ? camera : undefined,
          enabled: true,
        };
        onChange([...overrides.filter((o) => o.id !== next.id), next]);
        push("success", `${label} model built - Compile & Install ships it`);
        // Bare material names ship at the VPK root - two heroes using the
        // same Blender material name would overwrite each other's textures.
        const clash = [
          ...new Set(
            overrides
              .filter((o) => o.id !== next.id && o.enabled !== false)
              .flatMap((o) => (o.materials ?? []).map((m) => m.targetRel))
              .filter(
                (rel) =>
                  rel.endsWith(".vmat_c") &&
                  rep.materials.some((m) => m.targetRel === rel),
              ),
          ),
        ];
        if (clash.length > 0) {
          push(
            "info",
            `Heads up: another model swap ships the same material name(s): ${clash
              .map((c) => c.replace(/\.vmat_c$/, ""))
              .join(", ")} - rename the Blender material on one of them if a texture comes out wrong`,
          );
        }
      } else {
        push("error", "Model build failed - see the steps below");
      }
    } catch (e) {
      push("error", `Model build failed: ${e}`);
    } finally {
      setBuilding(false);
    }
  }

  /** Stage the current setup and open it in ModelDoc for inspection. */
  async function openInModeldoc() {
    if (!ws || !meshFile || !target) return;
    setOpeningDoc(true);
    try {
      const cacheDir = await join(await appDataDir(), "model_cache");
      const specs =
        matMode === "textures" ? texSpecs.filter((s) => s.color || s.gameVmat) : [];
      const msg = await modelOpenModeldoc({
        cs2Root: settings.cs2Root,
        kind: target.kind,
        workspaceDir: ws.dir,
        vmdlInternal: wsTarget,
        meshFile,
        materialOverride: matMode === "textures" ? null : material || null,
        importScale: Number(importScale) || 1,
        toolsRoot: settings.csdkRoot,
        artifactOut: await join(cacheDir, `${target.key}.vmdl_c`),
        materials: specs.map((s) => ({
          name: s.name,
          color: s.color,
          normal: s.normal,
          roughness: s.roughness,
          metalness: s.metalness,
          gameVmat: s.gameVmat ?? null,
        })),
        camera: cameraOverrides(),
      });
      push("info", msg);
    } catch (e) {
      push("error", `Couldn't open ModelDoc: ${e}`);
    } finally {
      setOpeningDoc(false);
    }
  }

  const errorCount = preflight?.errors.length ?? 0;
  // Heroes compile in CS2, objects in the Deadlock CSDK.
  const compilerOk = mode === "hero" ? cs2Ok : toolsOk;
  const texAssigned = texSpecs.filter((s) => s.color || s.gameVmat).length;
  const texWithArt = texSpecs.filter((s) => s.color).length;
  const camChanged = ws ? cameraOverrides().length : 0;

  return (
    // The object picker is a grid - it needs more room than the hero form.
    <div className={`flex flex-col gap-4 ${mode === "object" ? "max-w-5xl" : "max-w-3xl"}`}>
      {/* Two halves of one pipeline: heroes need CS2's compiler, objects
          build with the normal mod tools everyone already has. */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        {(
          [
            ["hero", "Heroes"],
            ["object", "Objects"],
          ] as [SwapMode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setHero("");
              setObj(null);
              clearTarget();
            }}
            className={`rounded-md border px-3 py-1.5 transition ${
              mode === m
                ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-1 text-[11px] text-zinc-600">
          {mode === "hero"
            ? "put a custom character on any hero"
            : "the urn, crates, soul containers, map props"}
        </span>
      </div>

      {!cs2Ok && mode === "hero" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-300">
            CS2 Workshop Tools needed
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            Custom hero models need the modern Source 2 compiler, which only ships with
            Counter-Strike 2's Workshop Tools (free). In Steam: install CS2, then in its
            Installation options tick "Counter-Strike 2 Workshop Tools". Then hit detect.
            Object swaps work without any of this.
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
                {(o.materials?.length ?? 0) > 0 && (
                  <span className="shrink-0 rounded bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200/80">
                    {o.materialSpecs?.length ?? 0} textured
                  </span>
                )}
                <button
                  onClick={() => void startRebuild(o)}
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
          {mode === "hero" ? "1 - Pick a hero, get the Blender kit" : "1 - Pick an object"}
        </h3>

        {mode === "object" ? (
          <div className="mt-3">
            <ObjectPicker
              helperPath={settings.vpkHelperPath}
              pakPath={settings.deadlockPak}
              selected={obj?.model ?? ""}
              replaced={
                new Set(
                  overrides
                    .filter((o) => o.enabled !== false)
                    .map((o) => o.targetPath.replace(/_c$/, "")),
                )
              }
              onPick={(t) => void prepareObject(t)}
            />
          </div>
        ) : (
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
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {wsBusy && (
            <span className="text-xs text-zinc-500">
              {mode === "hero" ? "Decompiling the hero…" : "Decompiling the object…"}
            </span>
          )}
          {ws && (
            <>
              {obj && (
                <span className="text-xs font-medium text-zinc-200">{obj.label}</span>
              )}
              <span className="text-xs text-zinc-500">
                {ws.files} files
                {ws.bones.length > 0 ? `, ${ws.bones.length} bones` : ", no skeleton"}
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
          <div className="mt-3 flex flex-wrap gap-4">
            {/* The real thing, in 3D - textures alone never showed what an
                object actually looks like. */}
            <div className="flex w-64 shrink-0 flex-col gap-1.5">
              {meshFile && (
                <div className="flex items-center gap-1 text-[10px]">
                  {([[true, "Your model"], [false, "Original"]] as [boolean, string][]).map(
                    ([mine, label]) => (
                      <button
                        key={label}
                        onClick={() => setPreviewMine(mine)}
                        className={`rounded border px-2 py-0.5 transition ${
                          previewMine === mine
                            ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
                            : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                        }`}
                      >
                        {label}
                      </button>
                    ),
                  )}
                </div>
              )}
              <Suspense
                fallback={
                  <div className="flex h-48 w-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-[11px] text-zinc-500">
                    Loading the 3D view…
                  </div>
                }
              >
                <ModelPreview3D
                  glbPath={previewGlb}
                  fbxPath={
                    meshFile && previewMine && meshFile.toLowerCase().endsWith(".fbx")
                      ? meshFile
                      : undefined
                  }
                  textures={Object.fromEntries(
                    texSpecs.filter((s) => s.color).map((s) => [s.name, s.color as string]),
                  )}
                  className="h-48 w-full border border-zinc-800"
                />
              </Suspense>
              <button
                onClick={() => void downloadForBlender()}
                disabled={downloading}
                title="Save this model and its textures as a .glb you can import straight into Blender"
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
              >
                {downloading ? "Exporting…" : "Download for Blender (.glb)"}
              </button>
            </div>
            <ul className="flex min-w-[16rem] flex-1 list-disc flex-col gap-0.5 pl-5 text-[11px] text-zinc-500">
              {(mode === "hero" ? KIT_RULES : OBJECT_RULES).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
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
            3 - Materials and build
          </h3>
          {preflight && preflight.materials.length > 0 && (
            <div className="mt-2 flex items-center gap-1 text-[11px]">
              {(
                [
                  ["textures", "My textures"],
                  ["game", "One game material"],
                ] as [MatMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setMatMode(mode)}
                  className={`rounded-md border px-2.5 py-1 transition ${
                    matMode === mode
                      ? "border-rose-400/50 bg-rose-400/10 text-rose-200"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-1 text-zinc-600">
                {matMode === "textures"
                  ? "your PNGs become real game materials, one per Blender material"
                  : "one existing hero material stretched over the whole model"}
              </span>
            </div>
          )}

          {matMode === "textures" && preflight && preflight.materials.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void pickTextureFolder()}
                  disabled={matching}
                  className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
                >
                  {matching ? "Matching…" : "Pick your textures folder…"}
                </button>
                <span className="text-[11px] text-zinc-500">
                  files auto-match by name, e.g. Body_Base_color.png / Body_Normal.png
                </span>
              </div>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                {texSpecs.map((s) => (
                  <div key={s.name} className="flex items-center gap-2 text-[11px]">
                    <span
                      className={`w-44 shrink-0 truncate ${s.color || s.gameVmat ? "text-zinc-200" : "text-zinc-500"}`}
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    {s.color ? (
                      <>
                        <span className="truncate text-emerald-300/90" title={s.color}>
                          {s.color.split(/[\\/]/).pop()}
                        </span>
                        {([
                          ["normal", s.normal],
                          ["rough", s.roughness],
                          ["metal", s.metalness],
                        ] as const)
                          .filter(([, v]) => v)
                          .map(([k]) => (
                            <span
                              key={k}
                              className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-zinc-400"
                            >
                              {k}
                            </span>
                          ))}
                        <button
                          onClick={() =>
                            setTexSpecs((prev) =>
                              prev.map((x) =>
                                x.name === s.name
                                  ? { ...x, color: null, normal: null, roughness: null, metalness: null }
                                  : x,
                              ),
                            )
                          }
                          className="shrink-0 rounded px-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-red-300"
                          title="Clear this material's textures"
                        >
                          ✕
                        </button>
                      </>
                    ) : s.gameVmat ? (
                      <>
                        <span
                          className="truncate text-sky-300/90"
                          title={`Uses the game's material: ${s.gameVmat}`}
                        >
                          game: {s.gameVmat.split("/").pop()}
                        </span>
                        <button
                          onClick={() =>
                            setTexSpecs((prev) =>
                              prev.map((x) => (x.name === s.name ? { ...x, gameVmat: null } : x)),
                            )
                          }
                          className="shrink-0 rounded px-1 text-zinc-600 transition hover:bg-zinc-800 hover:text-red-300"
                          title="Clear the game-material mapping"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => void pickColorFor(s.name)}
                          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                        >
                          Pick color texture…
                        </button>
                        <select
                          value=""
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            setTexSpecs((prev) =>
                              prev.map((x) => (x.name === s.name ? { ...x, gameVmat: v } : x)),
                            );
                          }}
                          title="Or map this material onto one of the hero's existing game materials"
                          className="w-40 rounded border border-zinc-700/80 bg-zinc-950 px-1 py-0.5 text-[10px] text-zinc-400 outline-none"
                        >
                          <option value="">or use a game material…</option>
                          {ws.materials.map((m) => (
                            <option key={m} value={m}>
                              {m.split("/").pop()}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {texAssigned > 0 && texAssigned < texSpecs.length && (
                <p className="text-[10px] text-amber-300/80">
                  {texSpecs.length - texAssigned} material(s) still bare - those parts will be
                  invisible or untextured in game
                </p>
              )}
              {!toolsOk && texWithArt > 0 && (
                <p className="text-[10px] text-amber-300/80">
                  My textures mode needs the Deadlock compile tools - set them up in Settings
                  first
                </p>
              )}
            </div>
          )}

          {ws.camera.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setShowCam((v) => !v)}
                className="text-[11px] text-zinc-400 transition hover:text-zinc-200"
              >
                {showCam ? "▾" : "▸"} Camera (optional)
                {camChanged > 0 && (
                  <span className="ml-1.5 rounded bg-rose-400/10 px-1.5 py-0.5 text-[9px] text-rose-200/90">
                    {camChanged} changed
                  </span>
                )}
              </button>
              {showCam && (
                <div className="mt-1.5 flex flex-col gap-1.5">
                  <p className="text-[10px] text-zinc-600">
                    The hero's third-person camera, straight from its model file - the values
                    the community edits in ModelDoc after a swap. Tweak in small steps and
                    test in game; blank = keep stock.
                  </p>
                  <div className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-1">
                    {ws.camera.map((c) => (
                      <label
                        key={c.key}
                        className="flex items-center justify-between gap-2 text-[11px] text-zinc-400"
                        title={c.key}
                      >
                        <span className="truncate">{CAMERA_LABELS[c.key] ?? c.key}</span>
                        <input
                          value={camEdit[c.key] ?? ""}
                          onChange={(e) =>
                            setCamEdit((prev) => ({ ...prev, [c.key]: e.target.value }))
                          }
                          placeholder={String(c.value)}
                          spellCheck={false}
                          className="w-20 rounded-md border border-zinc-700/80 bg-zinc-950 px-2 py-1 text-right text-[11px] text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-rose-400/70"
                        />
                      </label>
                    ))}
                  </div>
                  {camChanged > 0 && (
                    <button
                      onClick={() => setCamEdit({})}
                      className="self-start rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      Reset to stock
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {matMode === "game" && (
              <select
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                title="One game material applied to the whole model, or keep the material names from Blender (checkerboards unless they match real game materials)"
                className="w-72 rounded-md border border-zinc-700/80 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-rose-400/70"
              >
                {ws.materials.map((m) => (
                  <option key={m} value={m}>
                    {m.split("/").pop()} ({m})
                  </option>
                ))}
                <option value="">
                  Advanced: keep my Blender material names (must match real game vmats, else
                  nothing renders)
                </option>
              </select>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              Scale
              <input
                value={importScale}
                onChange={(e) => setImportScale(e.target.value)}
                spellCheck={false}
                title="Mesh import scale. Blender's default FBX export lands x100 in game - 0.01 corrects it. DMX via the 39.37 Blender flow is 1."
                className="w-16 rounded-md border border-zinc-700/80 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 outline-none transition focus:border-rose-400/70"
              />
            </label>
            <button
              onClick={() => void build()}
              disabled={
                building ||
                !compilerOk ||
                errorCount > 0 ||
                (matMode === "textures" && (texAssigned === 0 || (texWithArt > 0 && !toolsOk)))
              }
              title={
                errorCount > 0
                  ? "Fix the preflight errors first"
                  : !compilerOk
                    ? mode === "hero"
                      ? "CS2 Workshop Tools required"
                      : "The Deadlock compile tools are required - set them up in Settings"
                    : matMode === "textures" && texAssigned === 0
                      ? "Assign a texture or game material to at least one material first"
                      : "Compile the model"
              }
              className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-50"
            >
              {building ? "Building…" : "Build the model"}
            </button>
            <button
              onClick={() => void openInModeldoc()}
              disabled={openingDoc || building || !compilerOk}
              title="Stage the model and open it in CS2's ModelDoc - inspect the skeleton, your weights and the cameras by hand"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {openingDoc ? "Opening…" : "Inspect in ModelDoc"}
            </button>
            {errorCount > 0 && (
              <span className="text-[11px] text-red-300">fix the {errorCount} error(s) above first</span>
            )}
            {building && (
              <span className="text-[11px] text-zinc-500">
                {mode === "object"
                  ? "objects compile in a couple of seconds"
                  : "a simple model takes ~15s, a big multi-mesh one can take 10+ minutes - hang tight"}
              </span>
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
