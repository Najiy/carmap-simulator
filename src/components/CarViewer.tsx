import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CarModel } from "../engine/cars";
import { disposeTree, loadCarModel } from "../game/carModel";

type Phase =
  | { s: "loading"; pct: number }
  | { s: "ready" }
  | { s: "error"; msg: string };

export default function CarViewer({
  model,
  lengthM = 4.4,
  className = "",
}: {
  model: CarModel;
  /** real length, m — the loader scales the model to it */
  lengthM?: number;
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

    loadCarModel(model, {
      lengthM,
      onProgress: (pct) => {
        if (!disposed) setPhase({ s: "loading", pct });
      },
    })
      .then(({ object, size }) => {
        if (disposed) {
          disposeTree(object);
          return;
        }
        pivot.add(object);

        // frame on the widest thing in the scene — with a scan that is the
        // patch of ground the car was standing on, and it should be in shot
        const r = Math.max(size.x, size.z);
        const home = new THREE.Vector3(r * 0.62, size.y * 0.95, r * 0.76);
        const aim = new THREE.Vector3(0, size.y * 0.42, 0);
        controls.minDistance = r * 0.45;
        controls.maxDistance = r * 4;
        resetView.current = () => {
          camera.position.copy(home);
          controls.target.copy(aim);
          controls.update();
        };
        resetView.current();
        setPhase({ s: "ready" });
      })
      .catch(() => {
        if (!disposed) setPhase({ s: "error", msg: "Couldn't load the model file." });
      });

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
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [model, lengthM]);

  // the canvas fills whatever it is given, so going fullscreen is just a
  // matter of asking for it — the ResizeObserver handles the rest
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === root.current);
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
