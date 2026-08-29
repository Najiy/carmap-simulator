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
const { GEARBOX } = await import("../src/engine/engines");

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

// ---- 7. the track surface -----------------------------------------------
{
  const circuit = buildWorld("circuit", 7);
  const line = circuit.race!.line;
  const on = circuit.onTarmac(line[10].x, line[10].z);
  // 30 m off the centreline is unambiguously in the field
  const a = line[10];
  const b = line[11];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const off = circuit.onTarmac(
    a.x + (-(b.z - a.z) / len) * 30,
    a.z + ((b.x - a.x) / len) * 30,
  );
  console.log(`circuit surface`);
  console.log(`  on the centreline: ${on}, 30 m off it: ${off}`);
  check("the ribbon is tarmac and the field is not", on && !off);
}

// ---- 8. running wide costs you the speed --------------------------------
{
  const mile = buildWorld("mile", 1);
  const car = createCarState(mile.spawn);
  car.speed = 60; // 216 km/h down the runway
  // put it well off the side of the 26 m strip
  car.x = 40;
  let scrubbed = 60;
  for (let t = 0; t < 3; t += DT) {
    scrubbed = stepCar(car, {
      dt: DT,
      input: { steer: 0, throttle: 1, brake: 0 },
      world: mile,
      // the powertrain keeps asking for the scrubbed speed back, exactly as
      // DriveCanvas feeds it in
      engineSpeed: scrubbed,
      wheelbaseM: WHEELBASE,
      halfW: 0.92,
      halfL: HALF_L,
      coasting: false,
    });
  }
  console.log(`3 s on the grass from 216 km/h, throttle pinned`);
  console.log(`  off track: ${car.offTrack}, speed now ${(scrubbed * 3.6).toFixed(0)} km/h`);
  check("the grass scrubs it to a crawl", car.offTrack && scrubbed * 3.6 < 50);
}

// ---- 9. ...and the tarmac does not --------------------------------------
{
  const mile = buildWorld("mile", 1);
  const car = createCarState(mile.spawn);
  car.speed = 60;
  let scrubbed = 60;
  for (let t = 0; t < 3; t += DT) {
    scrubbed = stepCar(car, {
      dt: DT,
      input: { steer: 0, throttle: 1, brake: 0 },
      world: mile,
      engineSpeed: 60,
      wheelbaseM: WHEELBASE,
      halfW: 0.92,
      halfL: HALF_L,
      coasting: false,
    });
  }
  console.log(`the same 3 s on the runway`);
  console.log(`  off track: ${car.offTrack}, speed now ${(scrubbed * 3.6).toFixed(0)} km/h`);
  check("the black stuff costs nothing", !car.offTrack && scrubbed > 59);
}

// ---- 10. the same penalty on the circuit, where races are actually held ---
{
  const circuit = buildWorld("circuit", 3);
  const line = circuit.race!.line;
  const a = line[20];
  const b = line[21];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  // 25 m off the centreline, pointing along the track
  const car = createCarState({
    x: a.x + (-(b.z - a.z) / len) * 25,
    z: a.z + ((b.x - a.x) / len) * 25,
    heading: Math.atan2(b.x - a.x, -(b.z - a.z)),
  });
  car.speed = 55;
  let scrubbed = 55;
  for (let t = 0; t < 3; t += DT) {
    scrubbed = stepCar(car, {
      dt: DT,
      input: { steer: 0, throttle: 1, brake: 0 },
      world: circuit,
      engineSpeed: scrubbed,
      wheelbaseM: WHEELBASE,
      halfW: 0.92,
      halfL: HALF_L,
      coasting: false,
    });
  }
  console.log(`3 s in the infield at 198 km/h, throttle pinned`);
  console.log(`  off track: ${car.offTrack}, speed now ${(scrubbed * 3.6).toFixed(0)} km/h`);
  check("the circuit punishes cutting too", car.offTrack && scrubbed * 3.6 < 50);
}

// ---- 11. the brakes actually stop the car -------------------------------
// Drive mode used to add a flat 2500 N, which on 1420 kg is 1.8 m/s²: you
// could stand on the pedal from 100 km/h and still be rolling sixteen seconds
// later. This pins the deceleration to something a road car does.
{
  const v = 100 / 3.6;
  const decel = 9.81 * GEARBOX.brakeG;
  const metres = (v * v) / (2 * decel);
  console.log(`full brake from 100 km/h`);
  console.log(`  ${decel.toFixed(1)} m/s², stops in ${metres.toFixed(1)} m`);
  check("stops in a road car's distance", metres > 32 && metres < 48);
}

const failed = results.filter(([, ok]) => !ok);
console.log(
  failed.length
    ? `${failed.length}/${results.length} FAILED: ${failed.map(([n]) => n).join(", ")}`
    : `all ${results.length} checks pass`,
);
process.exit(failed.length ? 1 : 0);
