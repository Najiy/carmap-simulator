import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { BoxSpec, CarModel } from "../engine/cars";

/** one loader for the whole app — the meshopt decoder only needs wiring once */
let loader: GLTFLoader | null = null;
const getLoader = () => {
  if (!loader) loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return loader;
};

export interface LoadedCar {
  /**
   * Ready to drive: origin at the middle of the contact patch, +Y up,
   * **nose along -Z**, one unit = one metre.
   */
  object: THREE.Group;
  /** the body's bounding box in that frame, metres */
  size: THREE.Vector3;
  /** true when the model still carries the ground it was scanned on */
  hasGround: boolean;
}

/**
 * Load a car model and put it in a frame the rest of the app can rely on.
 *
 * A scan lands at an arbitrary angle, at an arbitrary scale, wherever the
 * photogrammetry put its origin — the viewer and the game both need it on its
 * wheels, facing a known direction, sized in metres. `model.align` carries the
 * three measurements that make that possible (see scripts/glb-heading.cjs);
 * without it the model is only centred on its own bounding box.
 */
export function loadCarModel(
  model: CarModel,
  opts: {
    /** drop the scanned ground and keep the car alone */
    bodyOnly?: boolean;
    /** real length in metres — the model is scaled to match */
    lengthM?: number;
    onProgress?: (pct: number) => void;
  } = {},
): Promise<LoadedCar> {
  return new Promise((resolve, reject) => {
    getLoader().load(
      model.url,
      (gltf) => {
        try {
          resolve(align(gltf.scene, model, opts));
        } catch (err) {
          reject(err);
        }
      },
      (e) => {
        if (e.total > 0) opts.onProgress?.((e.loaded / e.total) * 100);
      },
      () => reject(new Error("could not load " + model.url)),
    );
  });
}

function align(
  scene: THREE.Group,
  model: CarModel,
  opts: { bodyOnly?: boolean; lengthM?: number },
): LoadedCar {
  if (model.scan) makeUnlit(scene);

  // Crop first, and in the file's own coordinates: the packed GLB stores
  // quantized integer positions and undoes them with a node transform, so
  // only matrixWorld puts a vertex back where the boxes are written.
  const keep = opts.bodyOnly ? (model.body ?? model.crop) : model.crop;
  if (keep) {
    scene.updateMatrixWorld(true);
    const box = boxOf(keep);
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) cropGeometry(m, box, m.matrixWorld);
    });
  }

  const object = new THREE.Group();
  object.add(scene);

  if (model.align) {
    const { forward, origin, lengthUnits } = model.align;

    // file space → world: move the body centre to the origin, stand the
    // model up, then yaw the nose onto -Z
    const m = new THREE.Matrix4().makeTranslation(-origin[0], -origin[1], -origin[2]);
    if (model.upAxis === "z") {
      m.premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    }
    const nose = new THREE.Vector3(...forward)
      .applyMatrix4(new THREE.Matrix4().extractRotation(m))
      .setY(0)
      .normalize();
    m.premultiply(new THREE.Matrix4().makeRotationY(Math.atan2(nose.x, -nose.z)));
    scene.applyMatrix4(m);

    // scale off the measured body length, not the bounding box — the box
    // may still contain the ground the car was scanned on
    const scale = (opts.lengthM ?? 4.4) / lengthUnits;
    object.scale.setScalar(scale);
  } else {
    if (model.upAxis === "z") scene.rotateX(-Math.PI / 2);
    const bb = new THREE.Box3().setFromObject(scene);
    const mid = bb.getCenter(new THREE.Vector3());
    scene.position.set(-mid.x, -bb.min.y, -mid.z);
    const span = bb.getSize(new THREE.Vector3());
    object.scale.setScalar(
      (opts.lengthM ?? 4.4) / Math.max(span.x, span.y, span.z, 1e-3),
    );
  }

  // seat it on y = 0 whatever the measurements said
  const bb = new THREE.Box3().setFromObject(object);
  object.position.y = -bb.min.y;

  return {
    object,
    size: bb.getSize(new THREE.Vector3()),
    hasGround: !opts.bodyOnly && !!model.crop,
  };
}

const boxOf = (b: BoxSpec) =>
  new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));

/**
 * Photogrammetry has the scene lighting baked into the texture, so shading it
 * again with scene lights double-darkens every crease. Swap in an unlit
 * material and the scan looks like the photos it came from.
 */
function makeUnlit(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    m.material = new THREE.MeshBasicMaterial({
      map: src.map,
      color: src.color,
      side: THREE.DoubleSide,
    });
    src.dispose();
  });
}

/**
 * Keep only the triangles whose centroid falls inside `box`. Scans come with
 * however much driveway and hedge the photos caught; the subject is the point.
 */
function cropGeometry(mesh: THREE.Mesh, box: THREE.Box3, toBoxSpace: THREE.Matrix4) {
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const kept: number[] = [];
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();

  for (let i = 0; i < n; i += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const j = idx ? idx.getX(i + k) : i + k;
      c.add(v.fromBufferAttribute(pos, j).applyMatrix4(toBoxSpace));
    }
    if (box.containsPoint(c.divideScalar(3)))
      for (let k = 0; k < 3; k++) kept.push(idx ? idx.getX(i + k) : i + k);
  }

  // a box that keeps almost nothing is a mistake in the box, not in the scan
  if (kept.length < n * 0.02) {
    console.warn("carModel: crop box kept almost no geometry — ignoring it");
  } else if (kept.length < n) {
    geo.setIndex(kept);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

/** free every geometry, material and texture under an object */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of [m.material].flat()) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}
