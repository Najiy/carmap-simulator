import { useSyncExternalStore } from "react";
import {
  buildAxes,
  clamp,
  lookup,
  nearestCell,
  type Axes,
  type Grid,
} from "./axes";
import { ENGINES, GEARBOX, type EngineSpec } from "./engines";
import { boostCeiling, simulatePoint } from "./model";
import { baseMaps, type Maps } from "./defaults";
import { DRIVELINE, PULL_MS, type DynoRun } from "./dyno";
import type { RaceCar } from "./race";
import { engineSound } from "./sound";

export type SimMode = "dyno" | "drive";

export interface EngineSnapshot {
  running: boolean;
  blown: boolean;
  blowCause: string;
  rpm: number;
  mapKpa: number;
  throttle: number; // 0..1 as commanded
  afr: number;
  afrTarget: number;
  spark: number;
  torque: number;
  powerHp: number;
  egt: number;
  duty: number;
  health: number; // 100 → 0
  knockNow: boolean; // knock event within the last ~300 ms
  knockCount: number;
  misfire: boolean;
  limiter: boolean;
  mode: SimMode;
  gear: number; // 0-based; drive mode only
  speedKph: number;
  shifting: boolean;
  holdRpm: boolean;
  holdTarget: number;
  brake: number;
  wastegateKpa: number;
}

export interface CellSnapshot {
  ri: number; // rpm column under the operating point (-1 when off)
  li: number; // load row
  logVersion: number;
}

class EngineSim {
  private listeners = new Set<() => void>();
  private snap!: EngineSnapshot;
  private cellSnap: CellSnapshot = { ri: -1, li: -1, logVersion: 0 };

  spec: EngineSpec = ENGINES[0];
  axes: Axes = buildAxes(this.spec);
  maps: Maps = baseMaps(this.spec, this.axes);

  // control inputs (mutated directly by the UI)
  private ignition = false;
  private throttleIn = 0;
  private brake = 0.15;
  private wastegateKpa = ENGINES[0].stock.boostKpa;
  private mode: SimMode = "dyno";
  private holdRpm = false;
  private holdTarget = 3000;

  // physical state
  private rpm = 0;
  private mapKpa = 100;
  private egt = 20;
  private health = 100;
  private blown = false;
  private blowCause = "";
  private knockCount = 0;
  private lastKnockAt = -1;
  private gear = 0;
  private speedMs = 0;
  private shiftT = 0;

  /** last observed AFR per cell (NaN = never visited) — the "datalog" */
  afrLog: Grid = this.blankLog();
  private logDirty = false;
  private lastLogBump = 0;

  /** an in-progress dyno pull being replayed onto the gauges */
  private playback: {
    run: DynoRun;
    t0: number;
    durMs: number;
    lastIdx: number;
  } | null = null;

  private raf = 0;
  private lastT = 0;

  constructor() {
    this.publish(false, -1, -1, false, {
      afr: 14.7,
      afrTarget: 14.7,
      spark: 0,
      duty: 0,
      misfire: false,
    });
  }

  private blankLog(): Grid {
    return this.axes.load.map(() => this.axes.rpm.map(() => NaN));
  }

  start() {
    if (this.raf) return;
    this.lastT = performance.now();
    const loop = (t: number) => {
      const dt = clamp((t - this.lastT) / 1000, 0, 0.05);
      this.lastT = t;
      this.tick(dt, t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---- UI commands -------------------------------------------------------
  /** Swap the whole engine: fresh axes, fresh maps, fresh hardware. */
  configure(spec: EngineSpec, axes: Axes, maps: Maps) {
    this.spec = spec;
    this.axes = axes;
    this.maps = maps;
    this.ignition = false;
    this.throttleIn = 0;
    this.rpm = 0;
    this.mapKpa = 100;
    this.egt = 20;
    this.health = 100;
    this.blown = false;
    this.blowCause = "";
    this.knockCount = 0;
    this.gear = 0;
    this.speedMs = 0;
    this.shiftT = 0;
    this.playback = null;
    this.holdTarget = clamp(this.holdTarget, 1000, spec.redline);
    // fresh engine arrives at factory boost — raising it is a tuning decision
    this.wastegateKpa = spec.turbo
      ? clamp(spec.stock.boostKpa, 100, spec.turbo.maxKpa)
      : 100;
    this.afrLog = this.blankLog();
    this.logDirty = true;
  }

  setIgnition(on: boolean) {
    if (this.blown) return;
    this.ignition = on;
    if (on) {
      engineSound.ensure(); // AudioContext needs this user gesture
      if (this.rpm < 500) this.rpm = this.spec.idle + 100; // starter motor
    } else {
      this.throttleIn = 0;
    }
  }
  setThrottle(v: number) {
    this.throttleIn = clamp(v, 0, 1);
  }
  setBrake(v: number) {
    this.brake = clamp(v, 0, 1);
  }
  setWastegate(kpa: number) {
    const max = this.spec.turbo?.maxKpa ?? 100;
    this.wastegateKpa = clamp(kpa, 100, max);
  }
  setMode(mode: SimMode) {
    this.mode = mode;
    if (mode === "drive") {
      this.gear = 0;
      const ratio = GEARBOX.ratios[0] * GEARBOX.final;
      this.speedMs = Math.max(0, (this.rpm / 9.549 / ratio) * GEARBOX.wheelRadiusM);
      this.holdRpm = false;
    }
  }
  shift(dir: 1 | -1) {
    if (this.mode !== "drive") return;
    // -1 is neutral — one click below first
    const next = clamp(this.gear + dir, -1, GEARBOX.ratios.length - 1);
    if (next === this.gear) return;
    this.gear = next;
    this.shiftT = 0.25;
  }
  /** H-pattern style direct selection: 0-based gear, or -1 for neutral. */
  setGear(g: number) {
    if (this.mode !== "drive" || this.blown) return;
    const next = clamp(Math.round(g), -1, GEARBOX.ratios.length - 1);
    if (next === this.gear) return;
    this.gear = next;
    this.shiftT = 0.25;
  }
  setHold(on: boolean, target?: number) {
    this.holdRpm = on;
    if (target !== undefined)
      this.holdTarget = clamp(target, 1000, this.spec.redline);
  }
  applyDamage(d: number, cause: string) {
    if (d <= 0) return;
    this.health = clamp(this.health - d, 0, 100);
    if (this.health <= 0 && !this.blown) {
      this.blown = true;
      this.blowCause = cause;
      this.ignition = false;
      this.throttleIn = 0;
      engineSound.explosion();
    }
  }
  addKnockEvents(n: number, t = performance.now()) {
    if (n <= 0) return;
    this.knockCount += n;
    this.lastKnockAt = t;
  }
  logAfrSample(li: number, ri: number, afr: number) {
    const prev = this.afrLog[li][ri];
    this.afrLog[li][ri] = Number.isNaN(prev) ? afr : prev * 0.5 + afr * 0.5;
    this.logDirty = true;
  }
  clearAfrLog() {
    this.afrLog = this.blankLog();
    this.logDirty = true;
  }
  rebuildEngine() {
    this.health = 100;
    this.blown = false;
    this.blowCause = "";
    this.knockCount = 0;
    this.egt = 20;
    this.speedMs = 0;
    this.gear = 0;
  }

  /**
   * Replay a computed dyno run onto the live telemetry: revs sweep the
   * gauges, the trace crosses the map, knock pings and damage land exactly
   * when the sweep passes them, and the AFR log fills in as it goes.
   */
  playDynoPull(run: DynoRun, durMs = PULL_MS) {
    if (this.blown) return;
    engineSound.ensure();
    // strapping it to the rollers implies it's running — and it stays
    // running afterwards, falling back to idle on its own
    this.ignition = true;
    this.playback = { run, t0: performance.now(), durMs, lastIdx: -1 };
  }

  get pulling(): boolean {
    return this.playback !== null;
  }

  /**
   * While the drag strip owns the physics (the internal loop is stopped),
   * mirror the race car onto the gauges every frame: tach, boost, AFR, EGT,
   * gear and speed all live — and the wideband keeps logging cells for the
   * post-race tuning session.
   */
  feedRaceTelemetry(car: RaceCar) {
    const now = performance.now();
    this.rpm = car.rpm;
    this.mapKpa = car.mapKpa;
    this.egt = car.egt;
    this.gear = car.gear;
    this.speedMs = car.v;
    const running = !car.blown && car.rpm > 350;

    let ri = -1;
    let li = -1;
    if (running && car.throttle > 0) {
      const cell = nearestCell(this.axes, car.rpm, car.mapKpa);
      ri = cell.ri;
      li = cell.li;
      this.logAfrSample(li, ri, car.afr);
    }

    this.publish(running, ri, li, car.knocking, {
      afr: car.afr,
      afrTarget: lookup(this.maps.afrTarget, this.axes, car.rpm, car.mapKpa),
      spark: car.spark,
      duty: car.duty,
      misfire: false,
      torque: car.torqueNm,
      throttle: car.throttle,
      mode: "drive", // so the gear/speed tiles read out during the run
    });
    this.finishTick(ri, li, now);
  }

  private tickPlayback(dt: number, now: number) {
    const pb = this.playback!;
    const pts = pb.run.points;
    const p = clamp((now - pb.t0) / pb.durMs, 0, 1);
    const f = p * (pts.length - 1);
    const i0 = Math.floor(f);
    const k = f - i0;
    const a = pts[i0];
    const b = pts[Math.min(i0 + 1, pts.length - 1)];
    const lerp = (x: number, y: number) => x + (y - x) * k;

    // land the side effects of every point the rollers crossed this frame
    for (let i = pb.lastIdx + 1; i <= i0 && !this.blown; i++) {
      const pt = pts[i];
      const s = pb.run.afrSamples[i];
      if (s) this.logAfrSample(s.li, s.ri, s.afr);
      if (pt.knock) {
        this.knockCount += Math.max(1, Math.round(pt.knockSeverity * 2));
        this.lastKnockAt = now;
        engineSound.knockPing();
      }
      if (pt.damage > 0) {
        this.applyDamage(pt.damage, "knock and lean running on the dyno");
      }
    }
    pb.lastIdx = Math.max(pb.lastIdx, i0);

    const alive = !this.blown;
    if (!alive || p >= 1) this.playback = null;

    // physical state follows the sweep — when the pull ends, the normal
    // physics takes over from redline and the revs fall back on their own
    this.rpm = lerp(a.rpm, b.rpm);
    this.mapKpa = lerp(a.mapKpa, b.mapKpa);
    this.egt += (lerp(a.egt, b.egt) - this.egt) * clamp(dt / 0.6, 0, 1);

    const afr = lerp(a.afr, b.afr);
    engineSound.update(
      this.spec,
      this.rpm,
      1,
      clamp((this.mapKpa - 100) / 100, 0, 1),
      alive,
      afr,
    );

    const cell = nearestCell(this.axes, this.rpm, this.mapKpa);
    this.publish(alive, cell.ri, cell.li, now - this.lastKnockAt < 300, {
      afr,
      afrTarget: lerp(a.afrTarget, b.afrTarget),
      spark: lerp(a.spark, b.spark),
      duty: lerp(a.duty, b.duty),
      misfire: false,
      torque: lerp(a.torque, b.torque) / DRIVELINE, // gauges read crank Nm
      throttle: 1,
    });
    this.finishTick(cell.ri, cell.li, now);
  }

  // ---- simulation --------------------------------------------------------
  private tick(dt: number, now: number) {
    if (this.playback) {
      this.tickPlayback(dt, now);
      return;
    }
    const spec = this.spec;
    const running = this.ignition && !this.blown && this.rpm > 350;

    // throttle → manifold pressure, with turbo spool lag
    let thr = this.throttleIn;
    if (
      running &&
      !this.holdRpm &&
      thr < 0.12 &&
      this.rpm < spec.idle + 250
    ) {
      // idle governor — enough authority to hold idle against pumping losses
      thr = Math.max(thr, clamp((spec.idle + 100 - this.rpm) / 600, 0, 0.2));
    }
    const naPortion = 24 + thr * (98 - 24);
    const boostAvail = boostCeiling(spec, this.rpm, this.wastegateKpa) - 98;
    const boostPortion =
      Math.max(0, boostAvail) * clamp((thr - 0.55) / 0.45, 0, 1);
    const mapTarget = running ? naPortion + boostPortion : 100;
    const tau = mapTarget > this.mapKpa && this.mapKpa > 95 ? 0.3 : 0.09;
    this.mapKpa += (mapTarget - this.mapKpa) * clamp(dt / tau, 0, 1);

    // ECU table lookups
    const pw = running
      ? lookup(this.maps.fuel, this.axes, this.rpm, this.mapKpa)
      : 0;
    const spark = lookup(this.maps.ign, this.axes, this.rpm, this.mapKpa);
    const afrTarget = lookup(this.maps.afrTarget, this.axes, this.rpm, this.mapKpa);

    const r = simulatePoint(spec, Math.max(this.rpm, 500), this.mapKpa, pw, spark);
    let torque = running ? r.torque : this.rpm > 10 ? -12 : 0;

    // rev limiter (fuel cut)
    const limiter = running && this.rpm > spec.revLimit;
    if (limiter) torque = -20;

    // worn engine loses compression
    if (this.health < 50) torque *= 0.4 + 0.012 * this.health;

    // shift torque cut
    if (this.shiftT > 0) {
      this.shiftT -= dt;
      if (this.mode === "drive") torque = Math.min(torque, 0);
    }

    // ---- longitudinal / rotational dynamics ----
    if (this.mode === "drive") {
      if (this.gear < 0) {
        // neutral: nothing couples the crank to the wheels — the car
        // coasts and the engine free-revs
        const drag = 0.42 * this.speedMs ** 2 + 165 + this.brake * 2500;
        this.speedMs = Math.max(0, this.speedMs - (drag / GEARBOX.massKg) * dt);
        const loadTq = 4 + this.rpm * 0.004;
        const dOmega =
          ((torque - (running || this.rpm > 10 ? loadTq : 0)) / spec.inertia) *
          dt;
        this.rpm = Math.max(0, this.rpm + dOmega * 9.549);
        if (running) this.rpm = Math.max(this.rpm, spec.idle * 0.7);
        this.rpm = Math.min(this.rpm, spec.revLimit + 700);
      } else {
        const ratio = GEARBOX.ratios[this.gear] * GEARBOX.final;
        const force =
          (Math.max(0, torque) * ratio * GEARBOX.driveline) /
          GEARBOX.wheelRadiusM;
        const drag = 0.42 * this.speedMs ** 2 + 165 + this.brake * 2500;
        const accel = (force - drag) / GEARBOX.massKg;
        this.speedMs = Math.max(0, this.speedMs + accel * dt);
        const rpmWheels = (this.speedMs / GEARBOX.wheelRadiusM) * ratio * 9.549;
        if (running) {
          // clutch slips below idle so you can launch
          this.rpm = Math.max(rpmWheels, spec.idle + thr * 800);
        } else {
          this.rpm = rpmWheels;
        }
        // mechanical over-rev from a bad downshift — no fuel cut can save you
        if (rpmWheels > spec.revLimit + 300) {
          this.rpm = rpmWheels;
          this.applyDamage(
            (rpmWheels - spec.revLimit) * 0.004,
            "mechanical over-rev — the money shift",
          );
        }
        this.rpm = Math.min(this.rpm, spec.revLimit + 1200);
      }
    } else if (this.holdRpm && running) {
      this.rpm += (this.holdTarget - this.rpm) * clamp(dt * 4, 0, 1);
      if (limiter) this.rpm = Math.min(this.rpm, spec.revLimit);
    } else {
      const loadTq =
        4 + this.rpm * 0.004 + this.brake * (this.rpm / 1000) ** 2 * 8;
      const dOmega =
        ((torque - (running || this.rpm > 10 ? loadTq : 0)) / spec.inertia) *
        dt;
      this.rpm = Math.max(0, this.rpm + dOmega * 9.549);
      if (running) this.rpm = Math.max(this.rpm, spec.idle * 0.7);
      this.rpm = Math.min(this.rpm, spec.revLimit + 700);
    }

    // thermals
    const egtGoal = running ? r.egtTarget : 20;
    this.egt += (egtGoal - this.egt) * clamp(dt / 1.8, 0, 1);

    // knock events & damage
    let knockNow = now - this.lastKnockAt < 300;
    if (running && r.knockSeverity > 0) {
      const rate = 2 + r.knockSeverity * 4; // events / sec
      if (Math.random() < rate * dt) {
        this.knockCount++;
        this.lastKnockAt = now;
        knockNow = true;
        engineSound.knockPing();
        this.applyDamage(
          r.knockSeverity ** 1.5 * 0.35,
          "detonation — spark advance past the knock limit",
        );
      }
    }
    if (running && r.afr > 15.2 && this.mapKpa > 120 && !r.misfire) {
      this.applyDamage(
        (r.afr - 15.2) * ((this.mapKpa - 120) / 80) * 0.6 * dt,
        "lean mixture under boost — melted pistons",
      );
    }
    if (running && this.egt > 1000) {
      this.applyDamage(
        (this.egt - 1000) * 0.012 * dt,
        "exhaust gas temperature over 1000 °C",
      );
    }

    // datalog AFR into the active cell
    let ri = -1;
    let li = -1;
    if (running && r.fuelG > 1e-6) {
      const cell = nearestCell(this.axes, this.rpm, this.mapKpa);
      ri = cell.ri;
      li = cell.li;
      const prev = this.afrLog[li][ri];
      this.afrLog[li][ri] = Number.isNaN(prev)
        ? r.afr
        : prev + (r.afr - prev) * clamp(dt * 2, 0, 1);
      this.logDirty = true;
    }

    // audio
    const boost01 = clamp((this.mapKpa - 100) / 100, 0, 1);
    engineSound.update(
      spec,
      this.rpm,
      thr,
      boost01,
      running,
      running ? r.afr : 14.7,
    );

    // drowning-rich misfires backfire through the exhaust
    if (running && r.misfire && r.afr < 10 && this.rpm > 1200) {
      if (Math.random() < 3 * dt) {
        engineSound.pop(0.5 + Math.random() * 0.5);
      }
    }

    this.publish(running, ri, li, knockNow, {
      afr: running ? r.afr : 14.7,
      afrTarget,
      spark,
      duty: running ? r.duty : 0,
      misfire: running && r.misfire,
      torque: Math.max(0, torque),
      limiter,
    });
    this.finishTick(ri, li, now);
  }

  /** trailing bookkeeping shared by the live tick and the pull playback */
  private finishTick(ri: number, li: number, now: number) {
    let bumpLog = false;
    if (this.logDirty && now - this.lastLogBump > 250) {
      this.logDirty = false;
      this.lastLogBump = now;
      bumpLog = true;
    }
    if (ri !== this.cellSnap.ri || li !== this.cellSnap.li || bumpLog) {
      this.cellSnap = {
        ri,
        li,
        logVersion: this.cellSnap.logVersion + (bumpLog ? 1 : 0),
      };
    }
    this.listeners.forEach((fn) => fn());
  }

  private publish(
    running: boolean,
    _ri: number,
    _li: number,
    knockNow: boolean,
    o: {
      afr: number;
      afrTarget: number;
      spark: number;
      duty: number;
      misfire: boolean;
      torque?: number;
      limiter?: boolean;
      throttle?: number;
      mode?: SimMode;
    },
  ) {
    const torque = o.torque ?? 0;
    this.snap = {
      running,
      blown: this.blown,
      blowCause: this.blowCause,
      rpm: this.rpm,
      mapKpa: this.mapKpa,
      throttle: o.throttle ?? this.throttleIn,
      afr: o.afr,
      afrTarget: o.afrTarget,
      spark: o.spark,
      torque,
      powerHp: Math.max(0, (torque * this.rpm) / 7127),
      egt: this.egt,
      duty: o.duty,
      health: this.health,
      knockNow,
      knockCount: this.knockCount,
      misfire: o.misfire,
      limiter: o.limiter ?? false,
      mode: o.mode ?? this.mode,
      gear: this.gear,
      speedKph: this.speedMs * 3.6,
      shifting: this.shiftT > 0,
      holdRpm: this.holdRpm,
      holdTarget: this.holdTarget,
      brake: this.brake,
      wastegateKpa: this.wastegateKpa,
    };
  }

  // ---- store plumbing ----------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  getCellSnapshot = () => this.cellSnap;
}

export const engine = new EngineSim();

/** Full live telemetry — re-renders every animation frame. Gauges only. */
export function useEngineSnapshot(): EngineSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}

/** Active table cell + datalog version — cheap, changes rarely. */
export function useCellTrace(): CellSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getCellSnapshot);
}
