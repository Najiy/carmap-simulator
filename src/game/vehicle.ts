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
}

export interface DriveInput {
  /** -1 full left … +1 full right */
  steer: number;
  throttle: number;
  brake: number;
}

export function createCarState(spawn: World["spawn"]): CarState {
  return {
    x: spawn.x,
    z: spawn.z,
    heading: spawn.heading,
    slip: 0,
    roll: 0,
    pitch: 0,
    speed: 0,
    reversing: false,
    hitCones: 0,
    impact: 0,
  };
}

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

  const v = car.speed;
  const absV = Math.abs(v);

  // steering: the bicycle model gives the yaw rate the front wheels ask for
  const steer = input.steer * steerLimit(absV);
  const yawWanted = (v / Math.max(0.6, a.wheelbaseM)) * Math.tan(steer);

  // ...and grip decides how much of it the car actually gets. Past the limit
  // the surplus becomes slip angle instead of rotation, which is the tail
  // stepping out; power-on makes it worse, as it should.
  const gripYaw = absV > 0.5 ? (9.2 * (1 + 0.35 * input.brake)) / Math.max(absV, 1) : yawWanted;
  const yaw = clamp(yawWanted, -gripYaw, gripYaw);
  const surplus = yawWanted - yaw;
  car.slip += (surplus * 0.55 - car.slip * (2.4 + absV * 0.05)) * dt;
  car.slip = clamp(car.slip, -0.7, 0.7);
  if (input.throttle > 0.7 && absV > 4)
    car.slip += surplus * input.throttle * 0.35 * dt;

  car.heading += (yaw + car.slip * 1.4) * dt;

  // A car pivots about its rear axle, not its middle: turn the wheel and the
  // nose swings wide while the tail cuts the corner. Integrating the body
  // centre directly makes it slew like a tank, so move the rear axle and put
  // the body back on the end of it.
  const halfWb = a.wheelbaseM / 2;
  const rx = car.x - Math.sin(car.heading) * halfWb;
  const rz = car.z + Math.cos(car.heading) * halfWb;

  // it travels along its heading minus whatever slip it is carrying
  const course = car.heading - car.slip;
  const nx = rx + Math.sin(course) * v * dt + Math.sin(car.heading) * halfWb;
  const nz = rz - Math.cos(course) * v * dt - Math.cos(car.heading) * halfWb;

  const scrub = resolve(car, nx, nz, a);

  // cosmetic weight transfer — small, but it is most of what sells the speed
  const rollTarget = clamp(-yaw * absV * 0.05, -0.09, 0.09);
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
  return Math.abs(car.speed);
}
