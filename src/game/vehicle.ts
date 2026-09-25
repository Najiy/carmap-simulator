import { clamp } from "../engine/axes";
import { knockCone, type World } from "./world";

/**
 * The bit of the car the dyno doesn't simulate.
 *
 * `engine/store.ts` already owns everything longitudinal — throttle, boost,
 * gearbox, clutch, road speed. This adds the two things a driving scene needs
 * on top of it: which way the car is pointing, and what happens when it meets
 * a wall.
 *
 * Steering is a kinematic bicycle model with a slip term, which is enough to
 * feel like a car: the nose follows the front wheels, the tail runs wide when
 * you ask for more grip than there is, and it settles when you unwind.
 */

export interface CarState {
  x: number;
  z: number;
  /** radians, 0 = facing -Z, positive = turning right */
  heading: number;
  /** how far the body is rotated away from its direction of travel */
  slip: number;
  /** rad/s the body is actually rotating at — lags the steering demand */
  yawRate: number;
  /** cosmetic: body roll and pitch under load, radians */
  roll: number;
  pitch: number;
  /** metres per second along the heading, mirrored from the engine sim */
  speed: number;
  /** reverse creep, handled here because the gearbox sim has no reverse */
  reversing: boolean;
  hitCones: number;
  /** set for one frame when the car lands a solid hit */
  impact: number;
  /** on the grass — the HUD warns, and the physics is punishing it */
  offTrack: boolean;
  /**
   * How fast the contact patch is sliding across the road, m/s. This is the
   * honest driver for everything the tyres tell you about — the squeal, the
   * smoke, and the marks left behind — so all three agree with the physics
   * rather than each guessing from the slip angle separately.
   */
  scrub: number;
  /** lateral acceleration, g — roll, camera lean and the HUD all read it */
  lateralG: number;
  /** echo of the handbrake input, for the lights and the effects */
  handbrake: number;
}

export interface DriveInput {
  /** -1 full left … +1 full right */
  steer: number;
  throttle: number;
  brake: number;
  /** 0..1 — locks the rears; the reason a car park has a skidpan */
  handbrake: number;
}

export function createCarState(spawn: World["spawn"]): CarState {
  return {
    x: spawn.x,
    z: spawn.z,
    heading: spawn.heading,
    slip: 0,
    yawRate: 0,
    roll: 0,
    pitch: 0,
    speed: 0,
    reversing: false,
    hitCones: 0,
    impact: 0,
    offTrack: false,
    scrub: 0,
    lateralG: 0,
    handbrake: 0,
  };
}

/**
 * How fast the body takes up the yaw rate the steering is asking for. A real
 * car settles into a corner over roughly a fifth of a second; this is the
 * reciprocal of that time constant.
 */
const YAW_RESPONSE = 7;

/**
 * The penalty for being off the black stuff. Speed decays hard toward a crawl
 * and the front axle stops biting, so cutting a corner always costs more than
 * the metres it saves — without which a race is just a contest of who is
 * willing to ignore the track.
 */
const GRASS_CAP = 12; // m/s — about 43 km/h
const GRASS_DRAG = 2.4; // per second, toward the cap
const GRASS_GRIP = 0.55;

/**
 * The handbrake. Locked rears do two things at once: they drag the car down
 * (less hard than the footbrake, which has all four corners and the front
 * weight transfer) and they take the back axle's grip away, which is the
 * whole point — the tail comes round.
 */
const HANDBRAKE_G = 0.42;
const HANDBRAKE_GRIP_LOSS = 0.72;

/** front wheels stop biting long before the wheel does — speed-sensitive */
const steerLimit = (speedMs: number) =>
  (Math.PI / 5.2) * (0.28 + 0.72 / (1 + (speedMs / 11) ** 1.7));

export interface StepArgs {
  dt: number;
  input: DriveInput;
  world: World;
  /** road speed from the engine sim, m/s */
  engineSpeed: number;
  wheelbaseM: number;
  /** half-width and half-length of the body, for collisions */
  halfW: number;
  halfL: number;
  /** true while the car is in neutral or the engine is off */
  coasting: boolean;
  /** held on the grid before the green — no creep, no reverse, no slip */
  frozen?: boolean;
}

/**
 * Advance the car one frame. Returns the speed the engine sim should be
 * pulled back to when a collision scrubs it off.
 */
export function stepCar(car: CarState, a: StepArgs): number {
  const { dt, input, world } = a;
  car.impact = Math.max(0, car.impact - dt * 4);

  if (a.frozen) {
    // brakes hard on at the lights: the reverse creep below must not read
    // that as a request to back off the grid
    car.speed = 0;
    car.reversing = false;
    car.slip = 0;
    car.yawRate = 0;
    car.offTrack = false;
    car.scrub = 0;
    car.lateralG = 0;
    car.roll += (0 - car.roll) * clamp(dt * 5, 0, 1);
    car.pitch += (0 - car.pitch) * clamp(dt * 4, 0, 1);
    return 0;
  }

  // reverse: the gearbox sim only goes forwards, so hold the brake at a
  // standstill and the car creeps back under its own steam
  const stopped = a.engineSpeed < 0.4;
  if (stopped && input.brake > 0.5 && !car.reversing && car.speed <= 0.05) {
    car.reversing = true;
  }
  if (car.reversing) {
    if (input.throttle > 0.05) {
      car.reversing = false;
      car.speed = 0;
    } else {
      const target = input.brake > 0.5 ? -4.5 : 0;
      car.speed += (target - car.speed) * clamp(dt * 1.4, 0, 1);
      if (Math.abs(car.speed) < 0.05 && input.brake <= 0.5) {
        car.speed = 0;
        car.reversing = false;
      }
    }
  } else {
    car.speed = a.coasting ? car.speed * (1 - clamp(dt * 0.35, 0, 1)) : a.engineSpeed;
  }

  // off the track: scrub hard toward a crawl. The returned speed is fed back
  // into the powertrain by the caller, so the revs drop with it and you have
  // to drive out of it rather than just waiting.
  car.offTrack = !world.onTarmac(car.x, car.z);
  if (car.offTrack && !car.reversing && Math.abs(car.speed) > GRASS_CAP) {
    const cap = Math.sign(car.speed) * GRASS_CAP;
    car.speed += (cap - car.speed) * clamp(dt * GRASS_DRAG, 0, 1);
  }

  // handbrake: locked rears drag the car down and give up their grip
  const hb = car.reversing ? 0 : clamp(input.handbrake, 0, 1);
  car.handbrake = hb;
  if (hb > 0.02 && Math.abs(car.speed) > 0.1) {
    const decel = HANDBRAKE_G * 9.81 * hb * dt;
    car.speed = Math.sign(car.speed) * Math.max(0, Math.abs(car.speed) - decel);
  }

  const v = car.speed;
  const absV = Math.abs(v);
  const halfWb = a.wheelbaseM / 2;

  // Where the rear axle is *before* this step. A car turns about its back
  // wheels, so that is the point the whole step pivots around — and it has to
  // be measured on the old heading, or the offset just cancels itself out and
  // the car slews about its middle like a tank.
  const h0 = car.heading;
  const rx = car.x - Math.sin(h0) * halfWb;
  const rz = car.z + Math.cos(h0) * halfWb;

  // steering: the bicycle model gives the yaw rate the front wheels ask for
  const steer = input.steer * steerLimit(absV);
  const yawWanted = (v / Math.max(0.6, a.wheelbaseM)) * Math.tan(steer);

  // ...and grip decides how much of it the car actually gets. Past the limit
  // the surplus becomes slip angle instead of rotation, which is the tail
  // stepping out; power-on makes it worse, as it should.
  const grip =
    9.2 *
    (1 + 0.35 * input.brake) *
    (1 - HANDBRAKE_GRIP_LOSS * hb) *
    (car.offTrack ? GRASS_GRIP : 1);
  const gripYaw = absV > 0.5 ? grip / Math.max(absV, 1) : yawWanted;
  const yawGrip = clamp(yawWanted, -gripYaw, gripYaw);
  const surplus = yawWanted - yawGrip;
  car.slip += (surplus * 0.55 - car.slip * (2.4 + absV * 0.05)) * dt;
  car.slip = clamp(car.slip, -0.7, 0.7);
  if (input.throttle > 0.7 && absV > 4)
    car.slip += surplus * input.throttle * 0.35 * dt;
  // with the rears locked the back steps out whichever way it is pointed,
  // not just when you have asked for more than the fronts can give
  if (hb > 0.02 && absV > 2)
    car.slip += Math.sign(input.steer || car.slip || 1) * hb * 1.1 * dt;
  car.slip = clamp(car.slip, -0.7, 0.7);

  // A car has yaw inertia. It takes a beat to take a set on turn-in and
  // another to stop rotating when you unwind, and chasing the demand
  // instantly is exactly what makes a car feel like it is on rails.
  const yawDemand = yawGrip + car.slip * 1.4;
  car.yawRate += (yawDemand - car.yawRate) * clamp(dt * YAW_RESPONSE, 0, 1);
  car.heading = h0 + car.yawRate * dt;

  // the rear axle travels along the heading it had, minus the slip it is
  // carrying...
  const course = h0 - car.slip;
  const nrx = rx + Math.sin(course) * v * dt;
  const nrz = rz - Math.cos(course) * v * dt;
  // ...and the body finishes the step half a wheelbase ahead of it on the
  // *new* heading. That difference is the nose swinging wide.
  const nx = nrx + Math.sin(car.heading) * halfWb;
  const nz = nrz - Math.cos(car.heading) * halfWb;

  const scrub = resolve(car, nx, nz, a);

  // What the tyres are actually doing, in one number: how fast the contact
  // patch is sliding sideways across the road. Squeal, smoke and skid marks
  // all read this, so they can never disagree with each other or with the
  // physics. Locked rears drag along the car's whole direction of travel.
  car.scrub = Math.abs(Math.sin(car.slip)) * absV + hb * absV * 0.55;
  car.lateralG = Math.abs(car.yawRate * v) / 9.81;

  // cosmetic weight transfer — small, but it is most of what sells the speed.
  // Roll follows lateral acceleration, which is yaw rate times road speed.
  const rollTarget = clamp(-car.yawRate * absV * 0.05, -0.09, 0.09);
  car.roll += (rollTarget - car.roll) * clamp(dt * 5, 0, 1);
  const pitchTarget = clamp((input.brake * 0.035 - input.throttle * 0.02) * Math.min(1, absV / 8), -0.05, 0.05);
  car.pitch += (pitchTarget - car.pitch) * clamp(dt * 4, 0, 1);

  // cones: knock anything the body sweeps over
  for (const c of world.cones) {
    if (c.down) continue;
    const dx = c.x - car.x;
    const dz = c.z - car.z;
    if (dx * dx + dz * dz < 2.6) {
      knockCone(world, c, Math.sin(course), -Math.cos(course));
      car.hitCones++;
    }
  }

  // fell off the edge of the world — put it back on the grid
  if (Math.hypot(car.x, car.z) > world.radius * 1.6) {
    car.x = world.spawn.x;
    car.z = world.spawn.z;
    car.heading = world.spawn.heading;
    car.slip = 0;
    car.yawRate = 0;
    car.speed = 0;
    return 0;
  }

  return scrub;
}

/**
 * Push the car out of anything it drove into and return the speed left over.
 * The body is treated as a circle: at these sizes the difference is not worth
 * the arithmetic, and it never snags on a corner.
 */
function resolve(car: CarState, nx: number, nz: number, a: StepArgs): number {
  const r = Math.max(a.halfW, a.halfL * 0.62);
  let x = nx;
  let z = nz;
  let hit = false;

  for (const w of a.world.walls) {
    const cx = clamp(x, w.minX, w.maxX);
    const cz = clamp(z, w.minZ, w.maxZ);
    const dx = x - cx;
    const dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;

    hit = true;
    const d = Math.sqrt(d2);
    if (d > 1e-4) {
      x = cx + (dx / d) * r;
      z = cz + (dz / d) * r;
    } else {
      // dead centre of a wall — back out the way we came in
      x = car.x;
      z = car.z;
    }
  }

  car.x = x;
  car.z = z;

  if (!hit) return Math.abs(car.speed);

  // a solid hit scrubs most of the speed and unsettles the car
  const before = Math.abs(car.speed);
  car.impact = Math.min(1, before / 18);
  car.speed *= 0.25;
  car.slip *= 0.3;
  car.yawRate *= 0.3;
  return Math.abs(car.speed);
}
