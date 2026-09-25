import * as THREE from "three";
import type { CarState } from "./vehicle";

/**
 * What the tyres leave behind.
 *
 * All three effects read the same number — `car.scrub`, how fast the contact
 * patch is sliding across the road — so the marks, the smoke and the squeal
 * can never disagree with each other or with the physics. Nothing here
 * allocates per frame: the marks are one ring buffer of quads and the puffs
 * are one Points cloud, both written in place.
 */

/** metres of sliding per second below which a tyre is just doing its job */
export const SCRUB_FLOOR = 2.2;
/** ...and the point past which it is doing nothing else */
export const SCRUB_FULL = 9;

/** 0..1 — how hard the tyres are protesting */
export const scrubLevel = (scrub: number) =>
  Math.min(1, Math.max(0, (scrub - SCRUB_FLOOR) / (SCRUB_FULL - SCRUB_FLOOR)));

/**
 * Black lines on the road, laid as a ribbon per rear wheel.
 *
 * A ring buffer of quads rather than a growing mesh: a long session would
 * otherwise allocate without limit, and a fixed budget means the oldest marks
 * simply fade out from under you, which is what tyre rubber does anyway.
 */
export class SkidMarks {
  readonly object: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private alpha: THREE.BufferAttribute;
  private next = 0;
  private readonly quads: number;
  /** the last contact point per wheel, so each quad joins the one before */
  private last: (THREE.Vector3 | null)[] = [null, null];

  constructor(quads = 900) {
    this.quads = quads;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3);
    this.alpha = new THREE.BufferAttribute(new Float32Array(quads * 4), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.pos);
    this.geo.setAttribute("aAlpha", this.alpha);

    const index: number[] = [];
    for (let q = 0; q < quads; q++) {
      const b = q * 4;
      index.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    }
    this.geo.setIndex(index);

    // a tiny shader beats vertex colours here: the marks need to fade along
    // their length *and* sit flat on the road without z-fighting it
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // the winding of each quad flips with the direction the car is
      // travelling, so half a doughnut would be culled away
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          gl_FragColor = vec4(0.04, 0.04, 0.045, vAlpha * 0.55);
        }`,
    });

    this.object = new THREE.Mesh(this.geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = -2;
  }

  /** drop the trail so a reset doesn't draw a line across the map */
  lift() {
    this.last = [null, null];
  }

  clear() {
    this.alpha.array.fill(0);
    this.alpha.needsUpdate = true;
    this.lift();
  }

  /**
   * Lay one step of rubber. `points` are this frame's contact patches; each
   * is bridged to the same wheel's previous point, so the ribbon is
   * continuous however fast the car is going.
   */
  lay(points: THREE.Vector3[], width: number, intensity: number) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = this.last[i];
      this.last[i] = p.clone();
      if (!prev) continue;

      const dx = p.x - prev.x;
      const dz = p.z - prev.z;
      const len = Math.hypot(dx, dz);
      // a stationary wheel would give a degenerate quad and a normal of NaN
      if (len < 1e-3) continue;
      const nx = (-dz / len) * width * 0.5;
      const nz = (dx / len) * width * 0.5;

      const q = this.next % this.quads;
      this.next++;
      const b = q * 4;
      const y = 0.015;
      this.pos.setXYZ(b, prev.x + nx, y, prev.z + nz);
      this.pos.setXYZ(b + 1, prev.x - nx, y, prev.z - nz);
      this.pos.setXYZ(b + 2, p.x + nx, y, p.z + nz);
      this.pos.setXYZ(b + 3, p.x - nx, y, p.z - nz);
      for (let k = 0; k < 4; k++) this.alpha.setX(b + k, intensity);
    }
    this.pos.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

/**
 * Tyre smoke on tarmac, dirt off it.
 *
 * One Points cloud with a fixed budget, recycled oldest-first. Each puff
 * rises, spreads and fades; the colour is set per particle so the same system
 * serves both surfaces.
 */
export class Puffs {
  readonly object: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private scale: THREE.BufferAttribute;
  private life: Float32Array;
  private maxLife: Float32Array;
  private vel: Float32Array;
  private next = 0;
  private readonly count: number;

  constructor(count = 260) {
    this.count = count;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.scale = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.scale.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.pos);
    this.geo.setAttribute("aColor", this.col);
    this.geo.setAttribute("aScale", this.scale);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.vel = new Float32Array(count * 3);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aScale;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          vColor = aColor;
          // aScale carries both size and remaining life; zero means retired
          vFade = clamp(aScale, 0.0, 1.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (18.0 + 90.0 * (1.0 - vFade)) * (30.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vFade;
        void main() {
          if (vFade <= 0.001) discard;
          // a soft round puff, no texture upload needed
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          float a = (1.0 - r * 4.0) * vFade * 0.5;
          gl_FragColor = vec4(vColor, a);
        }`,
    });

    this.object = new THREE.Points(this.geo, mat);
    this.object.frustumCulled = false;
  }

  /** put one puff at a contact patch, drifting the way the wheel is sliding */
  spawn(
    x: number,
    z: number,
    driftX: number,
    driftZ: number,
    colour: THREE.Color,
    life: number,
  ) {
    const i = this.next % this.count;
    this.next++;
    this.pos.setXYZ(i, x, 0.12, z);
    this.col.setXYZ(i, colour.r, colour.g, colour.b);
    this.scale.setX(i, 1);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.vel[i * 3] = driftX * 0.35 + (Math.random() - 0.5) * 0.7;
    this.vel[i * 3 + 1] = 0.7 + Math.random() * 0.9;
    this.vel[i * 3 + 2] = driftZ * 0.35 + (Math.random() - 0.5) * 0.7;
  }

  update(dt: number) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      dirty = true;
      if (this.life[i] <= 0) {
        this.scale.setX(i, 0);
        continue;
      }
      this.pos.setXYZ(
        i,
        this.pos.getX(i) + this.vel[i * 3] * dt,
        this.pos.getY(i) + this.vel[i * 3 + 1] * dt,
        this.pos.getZ(i) + this.vel[i * 3 + 2] * dt,
      );
      // slow as it expands, the way a cloud of anything does
      this.vel[i * 3] *= 1 - dt * 1.1;
      this.vel[i * 3 + 1] *= 1 - dt * 0.8;
      this.vel[i * 3 + 2] *= 1 - dt * 1.1;
      this.scale.setX(i, this.life[i] / this.maxLife[i]);
    }
    if (dirty) {
      this.pos.needsUpdate = true;
      this.col.needsUpdate = true;
      this.scale.needsUpdate = true;
    }
  }

  clear() {
    this.life.fill(0);
    (this.scale.array as Float32Array).fill(0);
    this.scale.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

const SMOKE = new THREE.Color(0.72, 0.72, 0.74);
const DUST = new THREE.Color(0.55, 0.5, 0.36);

/**
 * A graded sky instead of a flat clear colour.
 *
 * The horizon band is the fog colour, so scenery dissolves into the sky
 * rather than into a seam, and the overhead is a shade deeper — which is most
 * of what stops a scene reading as "a box painted one colour".
 */
export function skyDome(horizon: THREE.Color, radius: number) {
  const top = horizon.clone().multiplyScalar(0.55);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: top },
        uHorizon: { value: horizon.clone() },
      },
      vertexShader: `
        varying float vH;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vH = normalize(world.xyz - cameraPosition).y;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        varying float vH;
        void main() {
          // a soft curve, so the band sits just above the eyeline
          float t = clamp(pow(max(vH, 0.0), 0.6), 0.0, 1.0);
          gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
        }`,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/**
 * Brake lights.
 *
 * The scan has its lamps baked dark into the texture, so these are additive
 * panels sitting just proud of the rear bumper: invisible until you brake,
 * and the clearest signal in the game that the car in front is slowing.
 */
export function brakeLights(lengthM: number, widthM: number) {
  const object = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff2a16,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const geo = new THREE.PlaneGeometry(widthM * 0.2, 0.16);
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(geo, mat);
    // nose is -Z, so the lamps go on the +Z face, turned to look backwards
    lamp.position.set(side * widthM * 0.36, 0.78, lengthM * 0.5 + 0.02);
    lamp.rotation.y = Math.PI;
    object.add(lamp);
  }
  return {
    object,
    /** 0 = off, 1 = hard on the pedal */
    set(level: number) {
      mat.opacity = level;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/** where the rear tyres touch the road, in world space */
export function rearContacts(
  car: CarState,
  wheelbaseM: number,
  trackM: number,
  out: [THREE.Vector3, THREE.Vector3],
): [THREE.Vector3, THREE.Vector3] {
  const s = Math.sin(car.heading);
  const c = Math.cos(car.heading);
  // back down the car from its centre, then out to each side
  const rx = car.x - s * (wheelbaseM / 2);
  const rz = car.z + c * (wheelbaseM / 2);
  const half = trackM / 2;
  out[0].set(rx + c * half, 0, rz + s * half);
  out[1].set(rx - c * half, 0, rz - s * half);
  return out;
}

/**
 * Drive the marks and the puffs from one car state. Returns the 0..1 level
 * the audio should squeal at, so the caller doesn't recompute it.
 */
export class TyreFx {
  readonly marks = new SkidMarks();
  readonly puffs = new Puffs();
  private contacts: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private puffDue = 0;

  addTo(scene: THREE.Scene) {
    scene.add(this.marks.object);
    scene.add(this.puffs.object);
  }

  reset() {
    this.marks.clear();
    this.puffs.clear();
  }

  /** the car has been teleported — don't draw a line across the map */
  lift() {
    this.marks.lift();
  }

  update(
    car: CarState,
    dt: number,
    wheelbaseM: number,
    trackM: number,
  ): number {
    this.puffs.update(dt);

    const level = scrubLevel(car.scrub);
    const contacts = rearContacts(car, wheelbaseM, trackM, this.contacts);

    if (level <= 0.001 || Math.abs(car.speed) < 0.5) {
      this.marks.lift();
      return 0;
    }

    // rubber only marks the black stuff; on grass it is torn turf and dust
    if (!car.offTrack) this.marks.lay(contacts, 0.22, level);
    else this.marks.lift();

    // more sliding, more puffs — but rate-limited so a long slide doesn't
    // burn the whole budget in half a second
    this.puffDue -= dt * (6 + level * 26);
    if (this.puffDue <= 0) {
      this.puffDue = 1;
      const colour = car.offTrack ? DUST : SMOKE;
      const course = car.heading - car.slip;
      const dx = Math.sin(course) * car.speed;
      const dz = -Math.cos(course) * car.speed;
      for (const p of contacts) {
        this.puffs.spawn(p.x, p.z, dx, dz, colour, 0.5 + level * 0.9);
      }
    }
    return level;
  }

  dispose() {
    this.marks.dispose();
    this.puffs.dispose();
  }
}
