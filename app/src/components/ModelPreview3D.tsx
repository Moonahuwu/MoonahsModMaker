import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** A material name -> the color texture the user assigned to it. */
export type PreviewTextures = Record<string, string>;

/**
 * Turntable preview of a game model, loaded from a .glb the backend exported
 * (textures ride along as sibling PNGs the glb references by name). Drag to
 * orbit, scroll to zoom.
 *
 * Everything here is bundled - no CDN - so it works under the app's CSP.
 */
export function ModelPreview3D({
  glbPath,
  fbxPath,
  textures,
  className = "",
}: {
  /** Absolute path of the exported .glb, or "" while it's being made. */
  glbPath: string;
  /** The user's own mesh - when set, THIS renders instead of the vanilla glb. */
  fbxPath?: string;
  /** Color textures per material name, applied to the user's mesh. */
  textures?: PreviewTextures;
  className?: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mount = holder.current;
    if (!mount || !(fbxPath || glbPath)) return;
    setError(null);
    setReady(false);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // PBR metals render BLACK without an environment to reflect; three's
    // procedural room supplies one with no external asset.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(1, 2, 2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.9);
    rim.position.set(-2, 1, -1.5);
    scene.add(rim);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;

    const size = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(mount);

    let root: THREE.Object3D | null = null;
    let disposed = false;
    let src = fbxPath || glbPath;
    try {
      src = convertFileSrc(fbxPath || glbPath);
    } catch {
      /* outside Tauri (browser preview): fall through with the raw path */
    }
    const isFbx = !!fbxPath;
    const loader = isFbx ? new FBXLoader() : new GLTFLoader();
    loader.load(
      src,
      // FBXLoader hands back the object itself; GLTFLoader wraps it.
      (loaded: unknown) => {
        if (disposed) return;
        root = (loaded as { scene?: THREE.Object3D }).scene ?? (loaded as THREE.Object3D);
        if (isFbx) {
          // Paint the user's assigned color maps onto their own materials,
          // so this shows what the build will actually produce.
          const texLoader = new THREE.TextureLoader();
          const cache = new Map<string, THREE.Texture>();
          root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const wasArray = Array.isArray(mesh.material);
            const mats = wasArray ? (mesh.material as THREE.Material[]) : [mesh.material as THREE.Material];
            const swapped = mats.map((m) => {
              const name = (m as THREE.Material)?.name ?? "";
              const src = textures?.[name];
              const std = new THREE.MeshStandardMaterial({
                name,
                color: 0xffffff,
                roughness: 0.85,
                metalness: 0,
              });
              if (src) {
                let tex = cache.get(src);
                if (!tex) {
                  let url = src;
                  try {
                    url = convertFileSrc(src);
                  } catch {
                    /* browser preview */
                  }
                  tex = texLoader.load(url);
                  tex.colorSpace = THREE.SRGBColorSpace;
                  tex.flipY = false; // FBX/glTF UV convention
                  cache.set(src, tex);
                }
                std.map = tex;
              } else {
                // Unassigned materials read as "missing", not as white.
                std.color = new THREE.Color(0x8b5cf6);
                std.wireframe = false;
                std.opacity = 0.85;
                std.transparent = true;
              }
              return std;
            });
            mesh.material = wasArray ? swapped : swapped[0];
          });
        }
        // Source models are Z-up, glTF is Y-up. The exporter usually
        // converts, but stand the model up if it came through lying down.
        let box = new THREE.Box3().setFromObject(root);
        const s = box.getSize(new THREE.Vector3());
        if (s.z > s.y * 1.2) {
          root.rotation.x = -Math.PI / 2;
          root.updateMatrixWorld(true);
          box = new THREE.Box3().setFromObject(root);
        }
        const center = box.getCenter(new THREE.Vector3());
        const dims = box.getSize(new THREE.Vector3());
        root.position.sub(center); // orbit around the model, not the origin
        scene.add(root);
        const radius = Math.max(dims.x, dims.y, dims.z) || 1;
        camera.position.set(radius * 1.3, radius * 0.25, radius * 2.2);
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
        setReady(true);
      },
      undefined,
      () => !disposed && setError("couldn't load the preview"),
    );

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      // GPU memory is not garbage collected - drop it by hand.
      root?.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material;
        for (const one of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          for (const v of Object.values(one)) {
            if (v instanceof THREE.Texture) v.dispose();
          }
          one.dispose();
        }
      });
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [glbPath, fbxPath, textures]);

  return (
    <div className={`relative overflow-hidden rounded-lg bg-zinc-950 ${className}`}>
      <div ref={holder} className="h-full w-full" />
      {!ready && !error && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-zinc-500">
          {fbxPath || glbPath ? "Loading the model…" : "Preparing the model…"}
        </p>
      )}
      {error && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-red-300">
          {error}
        </p>
      )}
      {ready && (
        <p className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-zinc-600">
          drag to turn, scroll to zoom
        </p>
      )}
    </div>
  );
}
