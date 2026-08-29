import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { CarModel } from "../engine/cars";

type Phase =
  | { s: "loading"; pct: number }
  | { s: "ready" }
  | { s: "error"; msg: string };

/** one loader for the whole app — the meshopt decoder only needs wiring once */
let loader: GLTFLoader | null = null;
const getLoader = () => {
  if (!loader) loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return loader;
};

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

export default function CarViewer({
  model,
  className = "",
}: {
  model: CarModel;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ s: "loading", pct: 0 });
  const [spin, setSpin] = useState(true);
  const [full, setFull] = useState(false);
  // the reset button needs to reach into the imperative scene
  const resetView = useRef<() => void>(() => {});

  // spin is read by the render loop through a ref so toggling it doesn't
  // tear down and refetch the model
  const spinning = useRef(spin);
  spinning.current = spin;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setPhase({ s: "error", msg: "This browser can't open a WebGL canvas." });
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    renderer.domElement.style.cssText = "width:100%;height:100%;display:block";
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      42,
      Math.max(el.clientWidth, 1) / Math.max(el.clientHeight, 1),
      0.05,
      500,
    );
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    // never let the orbit dip under the car and show the hollow underside
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.autoRotateSpeed = 0.9;

    // enough light for a lit glTF; the unlit scan path ignores all of it
    scene.add(new THREE.HemisphereLight(0xffffff, 0x30302c, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 4);
    scene.add(key);

    let frame = 0;
    let disposed = false;
    const pivot = new THREE.Group();
    scene.add(pivot);

    getLoader().load(
      model.url,
      (gltf) => {
        if (disposed) return;
        const car = gltf.scene;
        if (model.scan) makeUnlit(car);

        // Crop before anything is rotated: the packed GLB stores quantized
        // integer positions and undoes them with a node transform, so only
        // matrixWorld puts a vertex back in the coordinates the box is
        // written in.
        if (model.crop) {
          car.updateMatrixWorld(true);
          const box = new THREE.Box3(
            new THREE.Vector3(...model.crop.min),
            new THREE.Vector3(...model.crop.max),
          );
          car.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) cropGeometry(m, box, m.matrixWorld);
          });
        }

        // RealityScan writes Z-up; glTF says Y-up and nothing rotates it
        if (model.upAxis === "z") car.rotateX(-Math.PI / 2);

        // centre on the ground plane, then scale to a ~4 m long car so every
        // model in the garage frames the same way whatever its source units
        const bb = new THREE.Box3().setFromObject(car);
        const size = bb.getSize(new THREE.Vector3());
        const mid = bb.getCenter(new THREE.Vector3());
        const scale = 4.2 / Math.max(size.x, size.y, size.z, 1e-3);
        car.position.set(-mid.x, -bb.min.y, -mid.z);
        pivot.scale.setScalar(scale);
        pivot.add(car);

        const r = Math.max(size.x, size.z) * scale;
        const home = new THREE.Vector3(r * 0.78, size.y * scale * 0.9, r * 0.95);
        controls.target.set(0, size.y * scale * 0.42, 0);
        controls.minDistance = r * 0.55;
        controls.maxDistance = r * 4;
        resetView.current = () => {
          camera.position.copy(home);
          controls.target.set(0, size.y * scale * 0.42, 0);
          controls.update();
        };
        resetView.current();
        setPhase({ s: "ready" });
      },
      (e) => {
        if (!disposed && e.total > 0)
          setPhase({ s: "loading", pct: (e.loaded / e.total) * 100 });
      },
      () => {
        if (!disposed)
          setPhase({ s: "error", msg: "Couldn't load the model file." });
      },
    );

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(el);

    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.autoRotate = spinning.current;
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of [m.material].flat()) {
          (mat as THREE.MeshBasicMaterial).map?.dispose();
          mat.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [model]);

  // the canvas fills whatever it is given, so going fullscreen is just a matter
  // of asking for it — the ResizeObserver handles the rest
  useEffect(() => {
    const onChange = () =>
      setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.current?.requestFullscreen?.().catch(() => {});
  };

  return (
    <div ref={root} className={`relative overflow-hidden bg-page ${className}`}>
      <div ref={host} className="absolute inset-0" />

      {phase.s !== "ready" && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          {phase.s === "loading" ? (
            <div className="w-56">
              <div className="mb-2 text-xs uppercase tracking-wider text-muted">
                Loading model · {model.sizeMb} MB
              </div>
              <div className="h-1 overflow-hidden rounded bg-grid">
                <div
                  className="h-full bg-s1 transition-[width] duration-150"
                  style={{ width: `${Math.max(3, phase.pct)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="text-sm text-serious">{phase.msg}</div>
          )}
        </div>
      )}

      {phase.s === "ready" && (
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <div className="flex gap-1">
            <button
              onClick={() => setSpin((v) => !v)}
              className="rounded border border-grid bg-surface/80 px-2 py-1 text-xs text-ink2 backdrop-blur hover:text-ink"
            >
              {spin ? "⏸ Spin" : "▶ Spin"}
            </button>
            <button
              onClick={() => resetView.current()}
              className="rounded border border-grid bg-surface/80 px-2 py-1 text-xs text-ink2 backdrop-blur hover:text-ink"
            >
              ⌂ Reset
            </button>
            <button
              onClick={toggleFullscreen}
              title={full ? "Leave full screen" : "Full screen"}
              className="rounded border border-grid bg-surface/80 px-2 py-1 text-xs text-ink2 backdrop-blur hover:text-ink"
            >
              {full ? "⤡ Exit" : "⛶ Full"}
            </button>
          </div>
          <span className="pointer-events-none pr-0.5 text-[11px] text-muted">
            drag to orbit · scroll to zoom
          </span>
        </div>
      )}
    </div>
  );
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
    console.warn("CarViewer: crop box kept almost no geometry — ignoring it");
  } else if (kept.length < n) {
    geo.setIndex(kept);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}
