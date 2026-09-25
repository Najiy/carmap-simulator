import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { clamp } from "../engine/axes";
import { engine } from "../engine/store";
import { GEARBOX } from "../engine/engines";
import type { Car } from "../engine/cars";
import { disposeTree, loadCarModel } from "../game/carModel";
import { buildWorld, disposeWorld, type SceneId, type World } from "../game/world";
import { createCarState, stepCar, type DriveInput } from "../game/vehicle";
import { brakeLights, skyDome, TyreFx } from "../game/effects";
import { tyreSound } from "../engine/tyreSound";
import {
  createLapState,
  driverColor,
  Ghost,
  gridSlotFor,
  nameSprite,
  standings,
  updateLaps,
  type Standing,
} from "../game/raceState";
import type { RaceRoom } from "../multiplayer/room";

export type CameraMode = "chase" | "bonnet" | "orbit";

/**
 * How quickly the chase camera takes up the car's heading, per second, and
 * the furthest it is ever allowed to fall behind. Together these keep the car
 * pointing up the screen: a hard corner angles it a handful of degrees into
 * the turn, and a spin turns the world around it rather than swinging the car
 * side-on.
 */
const CAM_YAW_LAG = 9;
const CAM_YAW_MAX = 0.12; // ~7°

/**
 * The body is squared up to the camera, so this lean is the only angle you
 * ever see on it: a few degrees into the corner, the way a racing game does
 * it. It is a lie about where the car is pointing, and it is what makes a
 * turn read without the car swinging round to a side-on view.
 */
const LEAN_STEER = 0.1;
const LEAN_SLIP = 0.22;
const LEAN_MAX = 0.13; // ~7.5°

/**
 * A soft blob under the car. Real shadow mapping on a photogrammetry mesh
 * costs more than it is worth here, and without *something* on the ground the
 * car reads as floating.
 */
function contactShadow(lengthM: number, widthM: number) {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthM * 1.7, lengthM * 1.15),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(cv),
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.renderOrder = -1;
  return mesh;
}

/** what the keyboard and the touch pad put in; the canvas smooths it */
export interface RawInput {
  steer: number; // -1 … 1
  throttle: number; // 0 … 1
  brake: number; // 0 … 1
  handbrake: number; // 0 … 1
}

export interface DriveHud {
  speedKph: number;
  cones: number;
  /** distance driven this session, metres */
  distance: number;
  reversing: boolean;
  /** how sideways the car is right now, 0..1 — the HUD shows it as a bar */
  slip: number;
  /** on the grass, and being scrubbed for it */
  offTrack: boolean;
  ready: boolean;
  loadPct: number;
  error: string | null;
  /** multiplayer only */
  race: RaceHud | null;
}

export interface RaceHud {
  /** seconds to the green light; negative once it has gone */
  countdown: number;
  clock: number;
  lap: number;
  totalLaps: number;
  bestLap: number | null;
  lastLap: number | null;
  finished: boolean;
  finishTime: number | null;
  standings: Standing[];
  kind: "lap" | "dash";
}

export interface RaceSetup {
  room: RaceRoom;
  /** performance.now() ms at which the lights go green */
  greenAtPerf: number;
  laps: number;
  onFinish: (r: { totalS: number; bestLap: number | null }) => void;
}

/**
 * The driving scene.
 *
 * three.js owns the frame loop, but the powertrain stays in
 * `engine/store.ts` — so the gauges, the AFR datalog, the damage model and
 * the exhaust note all keep working exactly as they do on the dyno. The car
 * is simply somewhere with room to use them. All this adds is where the car
 * is pointing and what it runs into.
 */
export default function DriveCanvas({
  car,
  sceneId,
  seed,
  camera: cameraMode,
  input,
  autoShift,
  shiftRpm,
  onHud,
  resetToken,
  race,
  className = "",
}: {
  car: Car;
  sceneId: SceneId;
  seed: number;
  camera: CameraMode;
  /** present only for a multiplayer race — solo free drive leaves it out */
  race?: RaceSetup | null;
  /** live controls, read every frame — a ref so input never re-renders */
  input: React.RefObject<RawInput>;
  /** let the gearbox shift itself */
  autoShift: boolean;
  /** rpm the auto changes up at — the dyno's optimal shift point */
  shiftRpm: number;
  onHud: (h: DriveHud) => void;
  /** bump to put the car back on the grid */
  resetToken: number;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  // read through refs so changing them never tears the scene down
  const camRef = useRef(cameraMode);
  camRef.current = cameraMode;
  const resetRef = useRef(resetToken);
  resetRef.current = resetToken;
  const hudRef = useRef(onHud);
  hudRef.current = onHud;
  const raceRef = useRef(race ?? null);
  raceRef.current = race ?? null;
  const autoRef = useRef(autoShift);
  autoRef.current = autoShift;
  const shiftRpmRef = useRef(shiftRpm);
  shiftRpmRef.current = shiftRpm;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setErr("This browser can't open a WebGL canvas.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth || 1, el.clientHeight || 1, false);
    renderer.domElement.style.cssText = "width:100%;height:100%;display:block";
    el.appendChild(renderer.domElement);

    const world: World = buildWorld(sceneId, seed);
    const scene = new THREE.Scene();
    const horizon = new THREE.Color(world.sky);
    scene.background = horizon.clone();
    scene.fog = new THREE.Fog(world.sky, 140, world.radius * 1.6);
    scene.add(skyDome(horizon, world.radius * 2.1));
    scene.add(world.group);

    scene.add(new THREE.HemisphereLight(0xbcd0e8, 0x33352c, 2.4));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    sun.position.set(-120, 180, 90);
    scene.add(sun);

    const cam = new THREE.PerspectiveCamera(
      62,
      (el.clientWidth || 1) / (el.clientHeight || 1),
      0.2,
      world.radius * 2.4,
    );

    // the body sits under a holder, so roll and pitch never fight the
    // heading the physics owns
    const holder = new THREE.Group();
    const body = new THREE.Group();
    holder.add(body);
    holder.add(contactShadow(car.lengthM, car.widthM));
    const lamps = brakeLights(car.lengthM, car.widthM);
    body.add(lamps.object);
    scene.add(holder);

    // rubber, smoke and dust — all driven off the one scrub number
    const fx = new TyreFx();
    fx.addTo(scene);

    const startRace = raceRef.current;
    const gridIndex = startRace
      ? Object.keys(startRace.room.current?.players ?? {}).sort().indexOf(
          startRace.room.myId,
        )
      : 0;
    const state = createCarState(
      startRace ? gridSlotFor(world, Math.max(0, gridIndex)) : world.spawn,
    );
    const laps = createLapState();
    let raceHud: RaceHud | null = null;
    let reported = false;
    const smooth: DriveInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };
    let half = { w: car.widthM / 2, l: car.lengthM / 2 };
    let ready = false;
    let distance = 0;
    let lastReset = resetRef.current;
    let disposed = false;
    let loadPct = car.model ? 0 : 100;
    let loadErr: string | null = null;

    const emit = () =>
      hudRef.current({
        speedKph: Math.abs(state.speed) * 3.6,
        cones: state.hitCones,
        distance,
        reversing: state.reversing,
        slip: Math.min(1, Math.abs(state.slip) / 0.45),
        offTrack: state.offTrack,
        ready,
        loadPct,
        error: loadErr,
        race: raceHud,
      });

    // a stand-in so the scene is drivable while the model downloads
    const stub = new THREE.Mesh(
      new THREE.BoxGeometry(car.widthM, 1.35, car.lengthM),
      new THREE.MeshLambertMaterial({ color: 0x3987e5 }),
    );
    stub.position.y = 0.68;
    body.add(stub);
    const dropStub = () => {
      body.remove(stub);
      stub.geometry.dispose();
      (stub.material as THREE.Material).dispose();
    };

    if (car.model) {
      loadCarModel(car.model, {
        bodyOnly: true,
        lengthM: car.lengthM,
        onProgress: (p) => {
          loadPct = p;
        },
      })
        .then((loaded) => {
          if (disposed) {
            disposeTree(loaded.object);
            return;
          }
          dropStub();
          body.add(loaded.object);
          half = { w: loaded.size.x / 2, l: loaded.size.z / 2 };
          loadPct = 100;
        })
        .catch(() => {
          loadPct = 100;
          loadErr = "Couldn't load the car model — driving a stand-in.";
        });
    }

    // rivals: one ghost each, cloned off whatever body we ended up with.
    // clone() shares geometry and materials, so eight cars cost one upload.
    const ghosts = new Map<string, Ghost>();
    const ghostBody = () => {
      const src = body.children[0];
      if (src) return src.clone(true);
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(car.widthM, 1.35, car.lengthM),
        new THREE.MeshLambertMaterial({ color: 0x8e8c83 }),
      );
      box.position.y = 0.68;
      return box;
    };
    const ghostFor = (id: string, name: string) => {
      let g = ghosts.get(id);
      if (!g) {
        g = new Ghost(ghostBody(), nameSprite(name, driverColor(id)));
        g.object.add(contactShadow(car.lengthM, car.widthM));
        scene.add(g.object);
        ghosts.set(id, g);
      }
      return g;
    };

    engine.setMode("drive");
    engine.setBrake(0);
    // a new scene starts on the grid, not at whatever speed the last one
    // left the car doing
    engine.setRoadSpeed(0);

    // the auto needs a beat between changes or it hunts on the threshold
    let lastShiftAt = 0;
    // the chase camera's own heading, easing toward the car's course
    let camYaw = world.spawn.heading;
    const camPos = new THREE.Vector3();
    let orbit = 0;
    // the chase camera eases toward where it wants to be, but it has to
    // *start* there — lerping in from the origin flies it through the car
    let camPlaced = false;
    // camera shake: decays on its own, topped up by impacts and by everything
    // the car is doing that ought to come up through the seat
    let shake = 0;
    let last = performance.now();

    const frame = () => {
      if (disposed) return;
      requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (resetRef.current !== lastReset) {
        lastReset = resetRef.current;
        state.x = world.spawn.x;
        state.z = world.spawn.z;
        state.heading = world.spawn.heading;
        state.slip = 0;
        state.yawRate = 0;
        state.speed = 0;
        state.reversing = false;
        camPlaced = false;
        camYaw = world.spawn.heading;
        shake = 0;
        fx.reset();
        engine.setRoadSpeed(0);
      }

      // keys are on/off; a car is not. Ramping here is most of what makes
      // it feel like a pedal rather than a switch.
      const raw = input.current;
      const rate = (from: number, to: number, up: number, down: number) =>
        from + (to - from) * clamp(dt * (to > from ? up : down), 0, 1);
      smooth.throttle = rate(smooth.throttle, raw.throttle, 9, 14);
      smooth.brake = rate(smooth.brake, raw.brake, 14, 16);
      smooth.steer = rate(smooth.steer, raw.steer, 7, 11);
      // the handbrake is a lever, not a pedal — it comes on fast
      smooth.handbrake = rate(smooth.handbrake, raw.handbrake, 22, 20);

      // ---- race: hold the field on the grid until the lights go out ----
      const rc = raceRef.current;
      const layout = world.race;
      let frozen = false;
      if (rc && layout) {
        const clock = (now - rc.greenAtPerf) / 1000;
        frozen = clock < 0;
        if (clock < 0) {
          // brakes on, no throttle: you can rev it, you cannot leave
          smooth.throttle = 0;
          smooth.brake = 1;
          smooth.handbrake = 0;
          laps.currentLapStart = 0;
        } else if (!laps.finished) {
          updateLaps(laps, layout, state.x, state.z, clock, rc.laps);
          if (laps.finished && !reported) {
            reported = true;
            rc.onFinish({
              totalS: laps.finishTime ?? clock,
              bestLap: laps.bestLap,
            });
          }
        } else {
          // over the line — coast it down rather than stopping dead
          smooth.throttle = 0;
        }

        const roomSnap = rc.room.current;
        if (roomSnap) {
          rc.room.sendLive({
            t: clock,
            d: laps.progress * layout.lengthM,
            v: Math.abs(state.speed),
            rpm: engine.getSnapshot().rpm,
            gear: engine.getSnapshot().gear,
            blown: engine.getSnapshot().blown,
            finished: laps.finished,
            x: state.x,
            z: state.z,
            h: state.heading,
            lap: laps.lap,
          });

          // draw everyone else where they last said they were
          const seen = new Set<string>();
          for (const [id, p] of Object.entries(roomSnap.players)) {
            if (id === rc.room.myId) continue;
            const live = roomSnap.live[id];
            if (!live || live.x === undefined) continue;
            seen.add(id);
            ghostFor(id, p.name).set(live);
          }
          for (const [id, g] of ghosts) {
            if (!seen.has(id)) {
              scene.remove(g.object);
              ghosts.delete(id);
            }
          }

          raceHud = {
            countdown: -clock,
            clock: Math.max(0, clock),
            lap: laps.lap,
            totalLaps: rc.laps,
            bestLap: laps.bestLap,
            lastLap: laps.lapTimes.at(-1) ?? null,
            finished: laps.finished,
            finishTime: laps.finishTime,
            standings: standings(
              roomSnap,
              rc.room.myId,
              laps.progress,
              laps.lap,
              laps.finished,
              layout,
            ),
            kind: layout.kind,
          };
        }
      }
      for (const g of ghosts.values()) g.update(dt);

      const s = engine.getSnapshot();
      engine.setThrottle(smooth.throttle);
      engine.setBrake(smooth.brake);

      // ---- the automatic ----------------------------------------------
      // Change up at the dyno's optimal shift point. The downshift point is
      // derived from the ratio step, so landing after a change is always
      // comfortably below the up-shift point and the box never hunts.
      if (autoRef.current && s.running && !state.reversing && !s.shifting) {
        const top = GEARBOX.ratios.length - 1;
        const g = s.gear;
        if (g < 0) {
          engine.setGear(0);
          lastShiftAt = now;
        } else if (now - lastShiftAt > 380) {
          const up = shiftRpmRef.current;
          if (g < top && s.rpm >= up) {
            engine.shift(1);
            lastShiftAt = now;
          } else if (g > 0) {
            const step = GEARBOX.ratios[g] / GEARBOX.ratios[g - 1];
            if (s.rpm <= up * step * 0.82) {
              engine.shift(-1);
              lastShiftAt = now;
            }
          }
        }
      }

      const scrubbed = stepCar(state, {
        dt,
        input: smooth,
        world,
        engineSpeed: engine.roadSpeedMs,
        wheelbaseM: car.wheelbaseM,
        halfW: half.w,
        halfL: half.l,
        coasting: s.gear < 0 || !s.running,
        frozen,
      });
      if (!state.reversing && scrubbed < engine.roadSpeedMs - 0.05) {
        engine.setRoadSpeed(scrubbed);
      }
      distance += Math.abs(state.speed) * dt;

      // rubber, smoke and squeal, all off the same scrub number
      const squeal = fx.update(state, dt, car.wheelbaseM, car.widthM * 0.82);
      tyreSound.update(squeal, state.scrub, state.offTrack, s.running && !frozen);
      lamps.set(Math.min(1, smooth.brake * 0.9 + state.handbrake * 0.7));

      holder.position.set(state.x, 0, state.z);
      // A heading of h is a scene rotation of -h: the physics travels along
      // (sin h, -cos h) but three.js maps a model's nose (local -Z) to
      // (-sin h, -cos h). Using +h mirrors the car — dead right at heading 0,
      // and wrong by twice the heading the moment it turns.
      // See scripts/yaw-check.mjs.
      holder.rotation.y = -state.heading;

      const sinH = Math.sin(state.heading);
      const cosH = Math.cos(state.heading);
      const speed01 = clamp(Math.abs(state.speed) / 60, 0, 1);

      // the axis the shot is taken down; the chase view overrides it
      let viewYaw = state.heading;

      if (camRef.current === "bonnet") {
        cam.position.set(state.x + sinH * 0.2, 1.16, state.z - cosH * 0.2);
        cam.lookAt(state.x + sinH * 30, 1.0, state.z - cosH * 30);
      } else if (camRef.current === "orbit") {
        orbit += dt * 0.3;
        cam.position.set(
          state.x + Math.sin(orbit) * 9,
          3.2,
          state.z + Math.cos(orbit) * 9,
        );
        cam.lookAt(state.x, 0.85, state.z);
      } else {
        // Chase. camYaw is where the shot is taken from; the body is then
        // squared up to it below, so the car always points up the screen.
        let d = state.heading - camYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        camYaw += d * clamp(dt * CAM_YAW_LAG, 0, 1);
        camYaw = clamp(
          camYaw,
          state.heading - CAM_YAW_MAX,
          state.heading + CAM_YAW_MAX,
        );

        viewYaw = camYaw;
        const sinC = Math.sin(camYaw);
        const cosC = Math.cos(camYaw);
        const back = 7.2 + speed01 * 2.6;
        camPos.set(
          state.x - sinC * back,
          2.75 - speed01 * 0.45,
          state.z + cosC * back,
        );
        // Set the position outright rather than easing toward it. camYaw is
        // already the smoothed, clamped angle; lerping the Cartesian position
        // on top of it adds a *second* lag, and in a fast spin the target
        // sweeps round the car quicker than the lerp follows — which swings
        // the camera out to the side and shows the car's flank.
        if (!camPlaced) {
          camYaw = state.heading;
          camPlaced = true;
        }
        cam.position.copy(camPos);
        cam.lookAt(state.x + sinC * 5.5, 1.15, state.z - cosC * 5.5);
      }
      // The car faces straight up the screen whatever the physics is doing.
      // holder carries the true heading — the ghosts, the collisions and the
      // network all need that — so the shell is counter-rotated onto the
      // camera's axis, and the only angle you ever see is the few degrees it
      // is leaned into the corner.
      const lean = clamp(
        smooth.steer * LEAN_STEER + state.slip * LEAN_SLIP,
        -LEAN_MAX,
        LEAN_MAX,
      );
      body.rotation.set(
        state.pitch,
        state.heading - viewYaw - lean,
        state.roll,
      );

      // a touch of fov with speed — cheap, and it does most of the work
      cam.fov = 62 + speed01 * 15;
      cam.updateProjectionMatrix();

      // Camera shake, applied after lookAt so it moves the eye without
      // changing the aim. Two incommensurate sines beat random jitter: noise
      // reads as a dropped frame, whereas this reads as a car.
      shake = Math.max(shake - dt * 2.6, state.impact);
      const rumble =
        speed01 * 0.1 + squeal * 0.22 + (s.limiter ? 0.28 : 0) +
        (state.offTrack ? 0.3 : 0);
      const amp = shake * 0.22 + rumble * 0.022;
      if (amp > 0.0004 && camRef.current !== "orbit") {
        const st = now * 0.001;
        cam.position.x += (Math.sin(st * 37.1) + Math.sin(st * 23.3) * 0.7) * amp;
        cam.position.y +=
          (Math.sin(st * 41.7 + 1.3) + Math.sin(st * 19.9 + 0.4) * 0.7) * amp * 0.8;
        cam.rotateZ(Math.sin(st * 17.7) * amp * 0.09);
      }

      if (!ready) {
        ready = true;
        emit();
      }
      renderer.render(scene, cam);
    };

    // a steady HUD tick, so React re-renders ten times a second and not 60
    const hudTimer = window.setInterval(emit, 100);
    requestAnimationFrame(frame);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    });
    ro.observe(el);

    return () => {
      disposed = true;
      window.clearInterval(hudTimer);
      ro.disconnect();
      engine.setThrottle(0);
      engine.setBrake(0.15);
      engine.setMode("dyno");
      tyreSound.silence();
      fx.dispose();
      lamps.dispose();
      disposeWorld(world);
      disposeTree(holder);
      for (const g of ghosts.values()) {
        scene.remove(g.object);
        // the bodies are clones sharing the holder's geometry, which
        // disposeTree above already released — only the labels are ours
        g.object.traverse((o) => {
          const sp = o as THREE.Sprite;
          if (sp.isSprite) {
            sp.material.map?.dispose();
            sp.material.dispose();
          }
        });
      }
      ghosts.clear();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // a different car, scene or race rebuilds the world — that is the point
  }, [car, sceneId, seed, input, race?.greenAtPerf]);

  return (
    <div className={`relative overflow-hidden bg-page ${className}`}>
      <div ref={host} className="absolute inset-0" />
      {err && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-serious">
          {err}
        </div>
      )}
    </div>
  );
}
