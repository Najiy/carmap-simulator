import * as THREE from "three";
import { progressAt, type RaceLayout, type World } from "./world";
import type { LiveState, RoomSnapshot } from "../multiplayer/room";

/**
 * Lap timing and standings for a track race.
 *
 * Position is decided by one number — how far round the lap you are, plus how
 * many laps you have banked. That is enough to order the field, to know when
 * someone has finished, and to tell a rival's ghost where to be.
 */

export interface LapState {
  /** completed laps */
  lap: number;
  /** 0..1 round the current lap */
  frac: number;
  /** lap + frac; the number everything else is sorted by */
  progress: number;
  lapTimes: number[];
  bestLap: number | null;
  currentLapStart: number;
  finished: boolean;
  finishTime: number | null;
}

export function createLapState(): LapState {
  return {
    lap: 0,
    frac: 0,
    progress: 0,
    lapTimes: [],
    bestLap: null,
    currentLapStart: 0,
    finished: false,
    finishTime: null,
  };
}

/**
 * Advance lap bookkeeping. `clock` is seconds since the green light.
 *
 * The wrap test only fires when the car crosses the line going forwards from
 * the last stretch into the first — reversing over the line does nothing, and
 * neither does jittering on it.
 */
export function updateLaps(
  s: LapState,
  layout: RaceLayout,
  x: number,
  z: number,
  clock: number,
  totalLaps: number,
): void {
  if (s.finished) return;
  const frac = progressAt(layout, x, z);

  if (layout.kind === "dash") {
    s.frac = frac;
    s.progress = frac;
    if (frac >= 1) {
      s.finished = true;
      s.finishTime = clock;
    }
    return;
  }

  const prev = s.frac;
  if (prev > 0.75 && frac < 0.25) {
    // over the line
    s.lap++;
    const t = clock - s.currentLapStart;
    if (s.lap > 0 && t > 3) {
      s.lapTimes.push(t);
      if (s.bestLap === null || t < s.bestLap) s.bestLap = t;
    }
    s.currentLapStart = clock;
    if (s.lap >= totalLaps) {
      s.finished = true;
      s.finishTime = clock;
    }
  } else if (prev < 0.25 && frac > 0.75) {
    // reversed back over the line — give the lap back
    s.lap = Math.max(0, s.lap - 1);
  }

  s.frac = frac;
  s.progress = s.lap + frac;
}

export interface Standing {
  id: string;
  name: string;
  progress: number;
  lap: number;
  finished: boolean;
  isMe: boolean;
}

/** the field, leader first */
export function standings(
  snap: RoomSnapshot,
  myId: string,
  myProgress: number,
  myLap: number,
  myFinished: boolean,
  layout: RaceLayout,
): Standing[] {
  const rows: Standing[] = Object.entries(snap.players).map(([id, p]) => {
    if (id === myId) {
      return {
        id,
        name: p.name,
        progress: myProgress,
        lap: myLap,
        finished: myFinished,
        isMe: true,
      };
    }
    const live = snap.live[id];
    const lap = live?.lap ?? 0;
    const frac =
      live?.x !== undefined && live?.z !== undefined
        ? progressAt(layout, live.x, live.z)
        : 0;
    return {
      id,
      name: p.name,
      progress: layout.kind === "dash" ? frac : lap + frac,
      lap,
      finished: !!snap.results[id],
      isMe: false,
    };
  });
  return rows.sort((a, b) => b.progress - a.progress);
}

/**
 * A rival's car, smoothed.
 *
 * Live state arrives ten times a second over the network; the screen wants
 * sixty. Each ghost eases toward the last pose it was told about, which is
 * both simpler and steadier than extrapolating — a rival that lags a frame
 * behind looks far better than one that overshoots into a wall.
 */
export class Ghost {
  readonly object = new THREE.Group();
  private target = new THREE.Vector3();
  private targetH = 0;
  private started = false;

  constructor(
    body: THREE.Object3D,
    label: THREE.Sprite | null,
  ) {
    this.object.add(body);
    if (label) this.object.add(label);
  }

  set(live: LiveState) {
    if (live.x === undefined || live.z === undefined) return;
    this.target.set(live.x, 0, live.z);
    this.targetH = live.h ?? 0;
    if (!this.started) {
      this.started = true;
      this.object.position.copy(this.target);
      this.object.rotation.y = this.targetH;
    }
  }

  update(dt: number) {
    if (!this.started) return;
    const k = Math.min(1, dt * 9);
    this.object.position.lerp(this.target, k);
    // shortest way round the circle, so a car crossing north doesn't spin
    let d = this.targetH - this.object.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.object.rotation.y += d * k;
  }
}

/** a floating name tag, drawn once into a canvas texture */
export function nameSprite(text: string, color: string): THREE.Sprite {
  const pad = 12;
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d")!;
  ctx.font = "600 32px system-ui, sans-serif";
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  cv.width = Math.max(64, w);
  cv.height = 56;
  const g = cv.getContext("2d")!;
  g.font = "600 32px system-ui, sans-serif";
  g.fillStyle = "rgba(13,13,13,0.72)";
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = color;
  g.fillRect(0, cv.height - 5, cv.width, 5);
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(text, pad, cv.height / 2 - 2);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv),
      depthTest: false,
      transparent: true,
    }),
  );
  sprite.scale.set((cv.width / cv.height) * 1.1, 1.1, 1);
  sprite.position.y = 2.6;
  sprite.renderOrder = 10;
  return sprite;
}

/** stable per-driver colour, so the same rival is the same colour for everyone */
export function driverColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 72%, 58%)`;
}

/** where the car goes on the grid — pole to the leader of the lobby list */
export function gridSlotFor(world: World, index: number) {
  const grid = world.race?.grid;
  if (!grid || !grid.length) return world.spawn;
  return grid[Math.min(index, grid.length - 1)];
}
