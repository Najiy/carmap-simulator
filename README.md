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
- `crop` — a box, in the file's own coordinates, keeping the subject and
  dropping the car park around it. `scripts/glb-density.cjs` and
  `scripts/glb-projections.cjs` print density maps of a scan to find one.

