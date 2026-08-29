# CarMap — ECU Tuning Simulator

A browser-based engine calibration simulator for learning how to map cars.
You tune an open-loop speed-density ECU on a simulated 2.0 L 4-cylinder turbo
— the same workflow as real calibration software: edit tables, watch the
wideband, log AFR per cell, chase knock thresholds, and prove gains on the
dyno.

Built with React + Vite + TypeScript, Tailwind CSS v4, and Framer Motion.

## Run it

```sh
npm install
npm run dev
```

## What's simulated

- **Fuel map** (injector pulse width, ms) — the engine's *true* volumetric
  efficiency curve is hidden from you; the ECU just squirts what the table
  says. AFR = real airmass ÷ delivered fuel.
- **Ignition map** (° BTDC) — torque follows MBT; the knock threshold drops
  below MBT under boost and moves with mixture (rich = knock insurance).
- **AFR target map** — your reference; the datalog overlay and the
  VE-analyzer-style "Apply AFR correction" compare against it.
- **Live engine** — idle governor, turbo spool lag, adjustable wastegate
  (100–200 kPa), dyno brake, hold-RPM steady-state mode, rev limiter,
  cell trace on every table.
- **Dyno** — WOT pulls with torque/power curves, AFR strip vs target, knock
  markers, ghost-run comparison.
- **Consequences** — knock, lean-under-boost, and high EGT damage engine
  health; at 0% it grenades and you rebuild.

## Learning path

Open the **Guide** tab in the app. Short version: fix fueling against your
AFR targets first (log → correct → repeat), then advance timing at load until
the first hint of knock and back off 2°, raising boost only when the map
under it is proven. The **Pro tune** preset shows what finished maps look
like; the base calibration has a classic lean top-end waiting to be found.

## Garage

The **Garage** tab lists every car in the catalogue (`src/engine/cars.ts`) and
opens the ones with a 3D model in a full-bleed WebGL viewer, with the specs and
actions floating over the render. three.js is lazy-loaded, so it only reaches
the browser when someone actually opens a car.

### Free Drive and track races

The **Drive** tab puts the car in a scene you can actually drive. The
powertrain is unchanged — `engine/store.ts` still owns throttle, boost, the
gearbox, the clutch and road speed, so the gauges, the AFR datalog, the damage
model and the exhaust note all behave exactly as they do on the dyno. The game
layer adds only what a scene needs: where the car is pointing
(`game/vehicle.ts`) and what it runs into.

Steering is a kinematic bicycle model integrated at the **rear axle** — a car
pivots about its back wheels, so the nose swings wide and the tail cuts the
corner. Past the grip limit the surplus yaw becomes slip angle instead of
rotation, which is the tail stepping out.

Scenes are generated from a seed at load time (`game/world.ts`) — nothing to
download. Four of them: an airfield with a skidpad and a slalom, a random test
circuit with kerbs, a grid of city blocks with solid walls, and two kilometres
of runway.

**Multiplayer** reuses the drag strip's room mechanics wholesale
(`multiplayer/room.ts`): the same 5-letter codes, invite links, passwords,
public browser and server-clock green light. A `mode: "track"` room races the
generated circuit instead of the strip, and the two can't be joined by mistake.
The room's `circuitSeed` is what makes every client build the identical track;
each car streams its pose ten times a second and draws its rivals as smoothed
ghosts with name tags.

### Adding a car model

Models are served from `public/models` and fetched on demand — never bundled.
A raw photogrammetry scan is far too big to ship (the Focus ST arrived as a
468 MB GLB: 13 M triangles and an 8192² texture), so it goes through:

```sh
# 1. decimate to ~260 k triangles and meshopt-compress the geometry
node_modules/.bin/gltfpack -i scan.glb -o public/models/car.glb -si 0.02 -c

# 2. gltfpack's node build can't re-encode textures, so shrink it separately
ffmpeg -i tex8k.jpg -vf scale=4096:4096:flags=lanczos -q:v 4 tex4k.jpg
node scripts/glb-retexture.cjs public/models/car.glb tex4k.jpg out.glb
```

That lands the Focus ST at 3.3 MB. Then add a `model` entry to the car in
`src/engine/cars.ts`. Scans usually need two more things:

- `upAxis: "z"` — photogrammetry tools export Z-up and rotate nothing.
- `crop` / `body` — boxes, in the file's own coordinates, keeping the subject
  and dropping the car park around it. `scripts/glb-density.cjs` and
  `scripts/glb-projections.cjs` print density maps of a scan to find them.
- `align` — where the car actually sits in the file: which way the nose
  points, where the tyres touch, and how long the body measures in file units.
  A scan has no idea it is a car, so without this it cannot be put on its
  wheels facing a known direction at real scale.
  `scripts/glb-heading.cjs` prints the block ready to paste — it runs a PCA on
  the body's footprint for the long axis, then profiles roof height along it to
  tell the bonnet from the boot.

