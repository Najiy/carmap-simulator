// steering geometry check — run with: npx tsx scripts/steering-check.ts
//
// The bug this exists to catch: computing the rear-axle offset from the
// already-updated heading makes the two offsets cancel, so the car slews about
// its middle like a tank while every other number still looks plausible.
//
// The property that discriminates the two is sharp: on a rear-axle bicycle
// model the rear wheels have no slip angle, so the rear axle's velocity points
// exactly along the heading. Pivot about the centre instead and it doesn't.

const { createCarState, stepCar } = await import("../src/game/vehicle");
const { buildWorld } = await import("../src/game/world");

const world = buildWorld("airfield", 1);
const WHEELBASE = 2.64;
const DT = 1 / 120;
const HALF_WB = WHEELBASE / 2;
const HALF_L = 2.18;

const deg = (r: number) => (r * 180) / Math.PI;
const rearOf = (p: { x: number; z: number; h: number }) => ({
  x: p.x - Math.sin(p.h) * HALF_WB,
  z: p.z + Math.cos(p.h) * HALF_WB,
});

function run(steer: number, speed: number, seconds: number) {
  const car = createCarState({ x: 0, z: 0, heading: 0 });
  const path: { x: number; z: number; h: number }[] = [];
  for (let t = 0; t < seconds; t += DT) {
    stepCar(car, {
      dt: DT,
      input: { steer, throttle: 0.3, brake: 0 },
      world,
      engineSpeed: speed,
      wheelbaseM: WHEELBASE,
      halfW: 0.92,
      halfL: HALF_L,
      coasting: false,
    });
    path.push({ x: car.x, z: car.z, h: car.heading });
  }
  return { car, path };
}

const steerLimit = (v: number) =>
  (Math.PI / 5.2) * (0.28 + 0.72 / (1 + (v / 11) ** 1.7));

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}\n`);
};

// ---- 1. kinematic radius, where grip is not the limit --------------------
// A gentle input at a moderate speed keeps the tyres inside their envelope,
// so the steady-state radius must be exactly the geometric L / tan(delta).
{
  const V = 8;
  const IN = 0.25;
  const delta = IN * steerLimit(V);
  const expected = WHEELBASE / Math.tan(delta);
  const { path } = run(IN, V, 12);
  const tail = path.slice(-120);
  const yaw = (tail.at(-1)!.h - tail[0].h) / ((tail.length - 1) * DT);
  const measured = V / Math.abs(yaw);
  console.log(`steady-state radius, ${V} m/s at ${(IN * 100).toFixed(0)}% lock`);
  console.log(`  expected L/tan(delta) ${expected.toFixed(2)} m`);
  console.log(`  measured v/yawRate    ${measured.toFixed(2)} m`);
  check("radius matches the bicycle model", Math.abs(measured / expected - 1) < 0.05);
}

// ---- 2. the rear axle has no slip angle ---------------------------------
// This is the one that fails outright if the pivot is the body centre.
{
  const V = 8;
  const { path } = run(0.25, V, 12);
  const a = path.at(-2)!;
  const b = path.at(-1)!;
  const ra = rearOf(a);
  const rb = rearOf(b);
  const course = Math.atan2(rb.x - ra.x, -(rb.z - ra.z));
  let err = course - b.h;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;

  // what the same measurement would read if the step pivoted about the centre
  const yaw = (b.h - a.h) / DT;
  const ifCentre = Math.atan((HALF_WB * yaw) / V);

  console.log(`rear-axle slip angle at ${V} m/s`);
  console.log(`  measured        ${deg(err).toFixed(3)}°`);
  console.log(`  a centre pivot would read ${deg(ifCentre).toFixed(3)}°`);
  check("rear wheels track the heading", Math.abs(deg(err)) < 0.3);
}

// ---- 3. past the limit it understeers, it does not shrink the radius -----
{
  const V = 12;
  const delta = steerLimit(V);
  const geometric = WHEELBASE / Math.tan(delta);
  const { path } = run(1, V, 12);
  const tail = path.slice(-120);
  const yaw = (tail.at(-1)!.h - tail[0].h) / ((tail.length - 1) * DT);
  const measured = V / Math.abs(yaw);
  console.log(`full lock at ${V} m/s — beyond the grip limit`);
  console.log(`  geometric ${geometric.toFixed(2)} m, actual ${measured.toFixed(2)} m`);
  check("runs wide of the geometric radius", measured > geometric * 1.1);
}

// ---- 4. the nose swings outside the arc, the tail cuts inside ------------
{
  const { car, path } = run(1, 12, 1.2);
  const nose = { x: car.x + Math.sin(car.heading) * HALF_L };
  const tail = { x: car.x - Math.sin(car.heading) * HALF_L };
  console.log(`1.2 s of right lock from the origin facing -Z`);
  console.log(
    `  nose x ${nose.x.toFixed(2)} · centre x ${car.x.toFixed(2)} · tail x ${tail.x.toFixed(2)}`,
  );
  check("nose leads the centre, tail trails it", nose.x > car.x && car.x > tail.x);
  void path;
}

// ---- 5. yaw inertia -----------------------------------------------------
{
  const { path } = run(1, 12, 12);
  const first = Math.abs(path[0].h) / DT;
  const tail = path.slice(-120);
  const settled = Math.abs(
    (tail.at(-1)!.h - tail[0].h) / ((tail.length - 1) * DT),
  );
  console.log(`yaw take-up`);
  console.log(`  first frame ${first.toFixed(3)} rad/s, settled ${settled.toFixed(3)} rad/s`);
  check("builds up rather than snapping", first < settled * 0.3);
}

// ---- 6. a parked car cannot rotate --------------------------------------
{
  const car = createCarState({ x: 0, z: 0, heading: 0 });
  for (let i = 0; i < 120; i++) {
    stepCar(car, {
      dt: DT,
      input: { steer: 1, throttle: 0, brake: 0 },
      world,
      engineSpeed: 0,
      wheelbaseM: WHEELBASE,
      halfW: 0.92,
      halfL: HALF_L,
      coasting: false,
    });
  }
  console.log(`stationary with full lock held`);
  console.log(`  heading moved ${car.heading.toFixed(6)} rad`);
  check("a parked car does not rotate", Math.abs(car.heading) < 1e-6);
}

const failed = results.filter(([, ok]) => !ok);
console.log(
  failed.length
    ? `${failed.length}/${results.length} FAILED: ${failed.map(([n]) => n).join(", ")}`
    : `all ${results.length} checks pass`,
);
process.exit(failed.length ? 1 : 0);
