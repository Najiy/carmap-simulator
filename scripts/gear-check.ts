// Behavior check: neutral + direct gear selection (money shift) in races.
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { baseMaps } = await import("../src/engine/defaults");
const { createRaceCar, stepRaceCar, computeShiftRpm } = await import(
  "../src/engine/race"
);

const spec = ENGINES[0];
const axes = buildAxes(spec);
const maps = baseMaps(spec, axes);
const env = {
  spec,
  axes,
  maps,
  wastegateKpa: 155,
  shiftRpm: computeShiftRpm(spec, axes, maps, 155),
};
const car = createRaceCar(spec);

// launch and run up to speed with sequential auto shifts
while (car.t < 8) {
  const shift =
    car.t >= 0 && car.shiftT <= 0 && car.v > 2 && car.rpm >= env.shiftRpm && car.gear < 5;
  stepRaceCar(car, env, true, shift);
}
console.log(
  `at t=8: gear ${car.gear + 1}, ${(car.v * 3.6).toFixed(0)} km/h, ${car.rpm.toFixed(0)} rpm, health ${car.health.toFixed(1)}`,
);

// grab neutral at WOT: revs flare, car coasts, no damage
stepRaceCar(car, env, true, false, -1);
for (let i = 0; i < 240; i++) stepRaceCar(car, env, true, false);
console.log(
  `2s in N @ WOT: gear ${car.gear}, ${(car.v * 3.6).toFixed(0)} km/h, ${car.rpm.toFixed(0)} rpm, health ${car.health.toFixed(1)}`,
);

// the money shift: grab 1st at highway speed
stepRaceCar(car, env, false, false, 0);
for (let i = 0; i < 120; i++) stepRaceCar(car, env, false, false);
console.log(
  `1s after grabbing 1st at speed: ${car.rpm.toFixed(0)} rpm, health ${car.health.toFixed(1)}, blown=${car.blown}`,
);
