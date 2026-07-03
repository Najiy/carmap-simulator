import {
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
  get,
  type DatabaseReference,
  type Unsubscribe,
} from "firebase/database";
import { app } from "../firebase";
import type { Maps } from "../engine/defaults";

/**
 * Room-code multiplayer over Firebase Realtime Database (WebSocket
 * transport). The host creates a room and shares a 5-letter code; the guest
 * joins with it. Tunes are exchanged in the lobby, the green light is
 * scheduled on the server clock, and each car streams compact live state
 * ~10×/s during the run.
 */

export interface RoomPlayer {
  name: string;
  engineId: string;
  engineName: string;
  wastegateKpa: number;
  peakHp: number;
  ready: boolean;
  maps: Maps;
}

export interface LiveState {
  t: number;
  d: number;
  v: number;
  rpm: number;
  gear: number;
  blown: boolean;
  finished: boolean;
}

export interface RaceResult {
  et: number | null;
  trapKph: number;
  sixtyFt: number | null;
  blown: boolean;
}

export type RoomStatus = "lobby" | "racing";

export const MAX_PLAYERS = 8;

export interface RoomSnapshot {
  code: string;
  hostId: string;
  status: RoomStatus;
  /** server-clock ms of the green light (set when the host launches) */
  greenAt: number | null;
  players: Record<string, RoomPlayer>;
  live: Record<string, LiveState>;
  results: Record<string, RaceResult>;
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeCode = () =>
  Array.from(
    { length: 5 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join("");

/** anonymous identity — fresh per page load (rooms are ephemeral; a
 *  disconnect removes the player, so there is nothing to reconnect to) */
const defaultId = () => crypto.randomUUID().slice(0, 12);

export function friendlyDbError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/permission|denied/i.test(msg)) {
    return "Database rejected the request — deploy database.rules.json (firebase deploy --only database).";
  }
  if (/network|offline|timeout|failed to fetch/i.test(msg)) {
    return "Can't reach the multiplayer server — check your connection.";
  }
  return `Multiplayer error: ${msg}`;
}

export class RaceRoom {
  readonly code: string;
  readonly isHost: boolean;
  readonly myId: string;

  private roomRef: DatabaseReference;
  private unsubRoom: Unsubscribe | null = null;
  private unsubClock: Unsubscribe | null = null;
  private clockOffset = 0;
  private lastLiveSend = 0;
  private snapshot: RoomSnapshot | null = null;
  private listeners = new Set<(s: RoomSnapshot | null) => void>();

  private constructor(code: string, isHost: boolean, id: string) {
    this.code = code;
    this.isHost = isHost;
    this.myId = id;
    this.roomRef = ref(getDatabase(app), `rooms/${code}`);
  }

  /** ms on the shared server clock */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  static async host(me: RoomPlayer, id = defaultId()): Promise<RaceRoom> {
    const db = getDatabase(app);
    // find a free code (collisions are astronomically rare, but be tidy)
    let code = makeCode();
    for (let i = 0; i < 4; i++) {
      const existing = await get(ref(db, `rooms/${code}`));
      if (!existing.exists()) break;
      code = makeCode();
    }
    const room = new RaceRoom(code, true, id);
    await set(room.roomRef, {
      createdAt: serverTimestamp(),
      hostId: id,
      status: "lobby",
      greenAt: null,
      players: { [id]: me },
    });
    // if the host vanishes, the room dies with them
    onDisconnect(room.roomRef).remove();
    room.listen();
    return room;
  }

  static async join(
    codeRaw: string,
    me: RoomPlayer,
    id = defaultId(),
  ): Promise<RaceRoom> {
    const code = codeRaw.trim().toUpperCase();
    const db = getDatabase(app);
    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) throw new Error(`No race found for code ${code}.`);
    const val = snap.val();
    const players = val.players ?? {};
    const ids = Object.keys(players);
    if (!ids.includes(id) && ids.length >= MAX_PLAYERS) {
      throw new Error(`That race is full (${MAX_PLAYERS} drivers max).`);
    }
    if (typeof val.createdAt === "number" && Date.now() - val.createdAt > 2 * 3600_000) {
      throw new Error("That race code has expired.");
    }
    const room = new RaceRoom(code, false, id);
    await set(ref(db, `rooms/${code}/players/${id}`), me);
    onDisconnect(ref(db, `rooms/${code}/players/${id}`)).remove();
    onDisconnect(ref(db, `rooms/${code}/live/${id}`)).remove();
    onDisconnect(ref(db, `rooms/${code}/results/${id}`)).remove();
    room.listen();
    return room;
  }

  private listen() {
    const db = getDatabase(app);
    this.unsubClock = onValue(ref(db, ".info/serverTimeOffset"), (s) => {
      this.clockOffset = s.val() ?? 0;
    });
    this.unsubRoom = onValue(this.roomRef, (s) => {
      if (!s.exists()) {
        this.snapshot = null;
        this.listeners.forEach((fn) => fn(null));
        return;
      }
      const v = s.val();
      this.snapshot = {
        code: this.code,
        hostId: v.hostId,
        status: v.status ?? "lobby",
        greenAt: typeof v.greenAt === "number" ? v.greenAt : null,
        players: v.players ?? {},
        live: v.live ?? {},
        results: v.results ?? {},
      };
      this.listeners.forEach((fn) => fn(this.snapshot));
    });
  }

  onChange(fn: (s: RoomSnapshot | null) => void): () => void {
    this.listeners.add(fn);
    if (this.snapshot) fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  get current(): RoomSnapshot | null {
    return this.snapshot;
  }

  /** everyone in the room except me */
  get opponentIds(): string[] {
    return Object.keys(this.snapshot?.players ?? {}).filter(
      (id) => id !== this.myId,
    );
  }

  async setReady(ready: boolean): Promise<void> {
    await update(this.roomRef, { [`players/${this.myId}/ready`]: ready });
  }

  /** rename yourself — visible to the whole lobby immediately */
  async setName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 20);
    if (!clean) return;
    await update(this.roomRef, { [`players/${this.myId}/name`]: clean });
  }

  /** lobby loadout changed (engine swap / retune / boost) — updates your
   *  card for everyone and un-readies you so rivals notice */
  async updateLoadout(
    meta: Pick<
      RoomPlayer,
      "engineId" | "engineName" | "wastegateKpa" | "peakHp" | "maps"
    >,
  ): Promise<void> {
    await update(this.roomRef, {
      [`players/${this.myId}/engineId`]: meta.engineId,
      [`players/${this.myId}/engineName`]: meta.engineName,
      [`players/${this.myId}/wastegateKpa`]: meta.wastegateKpa,
      [`players/${this.myId}/peakHp`]: meta.peakHp,
      [`players/${this.myId}/maps`]: meta.maps,
      [`players/${this.myId}/ready`]: false,
    });
  }

  /** host only: schedule the green light a few seconds out on the server clock */
  async launch(leadInMs = 4500): Promise<void> {
    if (!this.isHost) return;
    await update(this.roomRef, {
      status: "racing",
      greenAt: this.serverNow() + leadInMs,
      live: null,
      results: null,
    });
  }

  /** throttled to ~10 Hz; called from the race loop */
  sendLive(state: LiveState): void {
    const now = performance.now();
    if (now - this.lastLiveSend < 95) return;
    this.lastLiveSend = now;
    set(
      ref(getDatabase(app), `rooms/${this.code}/live/${this.myId}`),
      state,
    ).catch(() => {});
  }

  async sendResult(result: RaceResult): Promise<void> {
    await set(
      ref(getDatabase(app), `rooms/${this.code}/results/${this.myId}`),
      result,
    );
  }

  /** host only: back to the lobby for another round */
  async rematch(): Promise<void> {
    if (!this.isHost) return;
    const updates: Record<string, unknown> = {
      status: "lobby",
      greenAt: null,
      live: null,
      results: null,
    };
    for (const id of Object.keys(this.snapshot?.players ?? {})) {
      updates[`players/${id}/ready`] = false;
    }
    await update(this.roomRef, updates);
  }

  async leave(): Promise<void> {
    this.unsubRoom?.();
    this.unsubClock?.();
    this.listeners.clear();
    const db = getDatabase(app);
    try {
      if (this.isHost) {
        await remove(this.roomRef);
      } else {
        await remove(ref(db, `rooms/${this.code}/players/${this.myId}`));
        await remove(ref(db, `rooms/${this.code}/live/${this.myId}`));
        await remove(ref(db, `rooms/${this.code}/results/${this.myId}`));
      }
    } catch {
      // leaving best-effort; onDisconnect handlers mop up
    }
  }
}
