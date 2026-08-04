import { convertFileSrc } from "@tauri-apps/api/core";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Render a .glb to a PNG data URL offscreen - the picker's cards use these
 * so nobody has to guess an object from a flat texture swatch.
 *
 * Same lighting recipe as the live preview (PBR metals go black without an
 * environment to reflect). One renderer is shared and kept alive between
 * calls: a WebGL context per thumbnail would blow the browser's context
 * limit after ~16 models.
 */
let shared: { renderer: THREE.WebGLRenderer; env: THREE.Texture } | null = null;

function ensureRenderer(size: number) {
  if (shared) return shared;
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // required to read the canvas back
  });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  shared = { renderer, env };
  return shared;
}

/** Free the shared GPU context (called when the picker unmounts). */
export function disposeThumbRenderer() {
  if (!shared) return;
  shared.env.dispose();
  shared.renderer.dispose();
  shared.renderer.forceContextLoss();
  shared = null;
}

export async function renderModelThumb(glbPath: string, size = 320): Promise<string> {
  const { renderer, env } = ensureRenderer(size);
  let url = glbPath;
  try {
    url = convertFileSrc(glbPath);
  } catch {
    /* browser preview */
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  const scene = new THREE.Scene();
  scene.environment = env;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 2, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.9);
  rim.position.set(-2, 1, -1.5);
  scene.add(rim);

  // Stand the model up if it came through lying down, then frame it.
  let box = new THREE.Box3().setFromObject(root);
  const s0 = box.getSize(new THREE.Vector3());
  if (s0.z > s0.y * 1.2) {
    root.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(root);
  }
  const center = box.getCenter(new THREE.Vector3());
  const dims = box.getSize(new THREE.Vector3());
  root.position.sub(center);
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
  const radius = Math.max(dims.x, dims.y, dims.z) || 1;
  // Three-quarter view: reads better on a card than a flat front-on shot.
  camera.position.set(radius * 0.85, radius * 0.42, radius * 1.45);
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  renderer.setSize(size, size, false);
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL("image/png");

  // Drop this model's GPU memory; the renderer itself stays for the next one.
  root.traverse((o) => {
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
  return data;
}
