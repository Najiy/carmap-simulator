import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { clamp, type Axes } from "../engine/axes";
import type { EngineSpec } from "../engine/engines";
import { GEARBOX } from "../engine/engines";
import type { Maps } from "../engine/defaults";
import { runDyno } from "../engine/dyno";
import { engine, useEngineSnapshot } from "../engine/store";
import { engineSound } from "../engine/sound";
import {
  AI_LEVELS,
  aiEnv,
  computeShiftRpm,
  createRaceCar,
  QUARTER_MILE_M,
  RACE_STEP,
  RACE_TIMEOUT,
  simulateGhost,
  STAGE_S,
  stepRaceCar,
  type AiLevel,
  type GhostResult,
  type RaceCar,
  type RaceEnv,
} from "../engine/race";
import { useGameStore } from "../store/gameStore";
import {
  friendlyDbError,
  MAX_PLAYERS,
  RaceRoom,
  type LobbyEntry,
  type RaceResult,
  type RoomSnapshot,
} from "../multiplayer/room";

type Phase = "setup" | "lobby" | "armed" | "done";

interface OppDisp {
  id: string;
  d: number;
  v: number;
  gear: number;
  label: string;
  blown: boolean;
  color: string;
}

/** lane colors for rivals — the player is always series-1 blue */
const OPP_COLORS = [
  "#c98500",
  "#9d5cd0",
  "#199e70",
  "#e070a0",
  "#4db6ac",
  "#b0642f",
  "#7a86e8",
];

interface SoloOutcome {
  kind: "solo";
  me: RaceResult;
  ghost: GhostResult;
  aiLabel: string;
}
interface MpOutcome {
  kind: "mp";
}
type Outcome = SoloOutcome | MpOutcome;

const fmtEt = (et: number | null | undefined) =>
  et === null || et === undefined ? "—" : `${et.toFixed(3)} s`;
const fmtT = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? "—" : `${v.toFixed(d)} s`;

/** interpolate the ghost's position at race time t */
function ghostAt(g: GhostResult, t: number) {
  const f = g.frames;
  if (!f.length) return { d: 0, v: 0, gear: 0, done: true };
  if (t <= f[0].t) return { d: f[0].d, v: f[0].v, gear: f[0].gear, done: false };
  const last = f[f.length - 1];
  if (t >= last.t)
    return { d: last.d, v: last.v, gear: last.gear, done: true };
  let lo = 0;
  let hi = f.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = f[lo];
  const b = f[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  return {
    d: a.d + (b.d - a.d) * k,
    v: a.v + (b.v - a.v) * k,
    gear: b.gear,
    done: false,
  };
}

/** pull a room code out of anything: "XKR42", "drag-XKR42", or a full invite URL */
function extractJoinCode(raw: string): string {
  const up = raw.trim().toUpperCase();
  const m = up.match(/DRAG-([A-Z0-9]{4,8})/);
  if (m) return m[1].slice(0, 5);
  return up.replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

/** shareable invite URL for a room */
const inviteLink = (code: string) =>
  `${window.location.origin}${window.location.pathname}?join=drag-${code}`;

/** invite links are consumed once per page load, surviving tab switches */
let autoJoinConsumed = false;

/** the live room outlives this component so you can tab away and tune —
 *  it only dies on Leave, host departure, or page close (onDisconnect) */
let activeRoom: RaceRoom | null = null;

export default function RacePanel({
  spec,
  axes,
  maps,
  autoJoinCode = null,
}: {
  spec: EngineSpec;
  axes: Axes;
  maps: Maps;
  /** room code from a ?join=drag-XXXXX invite link — joined once on mount */
  autoJoinCode?: string | null;
}) {
  const snap = useEngineSnapshot();
  const playerName = useGameStore((s) => s.playerName);
  const autoShift = useGameStore((s) => s.autoShift);
  const setAutoShift = useGameStore((s) => s.setAutoShift);
  const bestEt = useGameStore((s) => s.bestEt[spec.id]);
  const recordEt = useGameStore((s) => s.recordEt);

  const [phase, setPhase] = useState<Phase>(activeRoom ? "lobby" : "setup");
  const [aiLevel, setAiLevel] = useState<AiLevel>("street");
  const [hud, setHud] = useState<RaceCar | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [roomSnap, setRoomSnap] = useState<RoomSnapshot | null>(
    activeRoom?.current ?? null,
  );
  const [mpError, setMpError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [hostPass, setHostPass] = useState("");
  const [lobbyList, setLobbyList] = useState<LobbyEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const envRef = useRef<RaceEnv | null>(null);
  const ghostRef = useRef<GhostResult | null>(null);
  const roomRef = useRef<RaceRoom | null>(activeRoom);
  const unsubRoomRef = useRef<(() => void) | null>(null);
  const greenAtPerfRef = useRef(0);
  const throttleRef = useRef(false);
  const shiftQueueRef = useRef(0);
  const gearRequestRef = useRef<number | null>(null);
  const autoShiftRef = useRef(autoShift);
  const phaseRef = useRef(phase);
  const roomSnapRef = useRef<RoomSnapshot | null>(null);

  autoShiftRef.current = autoShift;
  phaseRef.current = phase;
  roomSnapRef.current = roomSnap;

  // your build, measured fresh whenever the tune changes
  const myDyno = useMemo(
    () => runDyno(spec, axes, maps, snap.wastegateKpa, 0),
    [spec, axes, maps, snap.wastegateKpa],
  );

  // ---- lifecycle -----------------------------------------------------------
  useEffect(
    () => () => {
      // stop feeding a dead component — but the room itself stays alive so
      // the player can tab over to Tune and come back
      unsubRoomRef.current?.();
      unsubRoomRef.current = null;
    },
    [],
  );

  const buildEnv = useCallback((): RaceEnv => {
    return {
      spec,
      axes,
      maps: structuredClone(maps),
      wastegateKpa: snap.wastegateKpa,
      shiftRpm: computeShiftRpm(spec, axes, maps, snap.wastegateKpa),
    };
  }, [spec, axes, maps, snap.wastegateKpa]);

  // the room's launch handler must see the tune as it is AT the green light,
  // not as it was when the lobby was entered
  const buildEnvRef = useRef(buildEnv);
  buildEnvRef.current = buildEnv;

  // ---- solo flow -----------------------------------------------------------
  const stageSolo = useCallback(() => {
    if (snap.blown) return;
    engineSound.ensure();
    envRef.current = buildEnv();
    const ai = aiEnv(aiLevel, spec, axes);
    ghostRef.current = simulateGhost(ai.env, ai.throttleFrom);
    greenAtPerfRef.current = performance.now() + (STAGE_S + 0.4) * 1000;
    throttleRef.current = false;
    shiftQueueRef.current = 0;
    setOutcome(null);
    setPhase("armed");
  }, [snap.blown, buildEnv, aiLevel, spec, axes]);

  // ---- multiplayer flow ----------------------------------------------------
  const myMeta = useCallback(
    () => ({
      name: playerName,
      engineId: spec.id,
      engineName: spec.name,
      wastegateKpa: snap.wastegateKpa,
      peakHp: Math.round(myDyno.peakHp.v),
      ready: false,
      maps: structuredClone(maps),
    }),
    [playerName, spec, snap.wastegateKpa, myDyno, maps],
  );

  const attachRoom = useCallback((room: RaceRoom) => {
    roomRef.current = room;
    activeRoom = room;
    unsubRoomRef.current?.();
    unsubRoomRef.current = room.onChange((s) => {
      setRoomSnap(s);
      if (!s) {
        // room vanished (host left / connection lost)
        if (phaseRef.current !== "setup") {
          setMpError("The race room closed — the host may have left.");
          setPhase("setup");
        }
        roomRef.current = null;
        activeRoom = null;
        return;
      }
      if (
        s.status === "racing" &&
        s.greenAt !== null &&
        phaseRef.current === "lobby"
      ) {
        engineSound.ensure();
        // lock the tune in NOW — whatever you dialled in while waiting races
        envRef.current = buildEnvRef.current();
        greenAtPerfRef.current =
          performance.now() + (s.greenAt - room.serverNow());
        throttleRef.current = false;
        shiftQueueRef.current = 0;
        setOutcome({ kind: "mp" });
        setPhase("armed");
      }
      if (s.status === "lobby" && phaseRef.current === "done") {
        setPhase("lobby");
        setHud(null);
      }
    });
  }, []);

  // remount while a room lives (user tabbed away to tune): re-attach and
  // pick up wherever the room is — including a race that started without us
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    attachRoom(room);
    const s = room.current;
    if (s?.status === "racing" && s.greenAt !== null) {
      const raceClock = (room.serverNow() - s.greenAt) / 1000;
      if (s.results[room.myId] || raceClock >= RACE_TIMEOUT) {
        setOutcome({ kind: "mp" });
        setPhase("done");
      } else {
        engineSound.ensure();
        envRef.current = buildEnvRef.current();
        greenAtPerfRef.current = performance.now() - raceClock * 1000;
        setOutcome({ kind: "mp" });
        setPhase("armed"); // late to the tree = late off the line
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the lobby card honest: engine swaps, map edits and wastegate moves
  // update your loadout live — and un-ready you so rivals notice
  useEffect(() => {
    const room = roomRef.current;
    if (phase !== "lobby" || !room) return;
    const mine = roomSnap?.players[room.myId];
    if (!mine) return;
    // renaming yourself in the header syncs to the lobby card too
    if (mine.name !== playerName) {
      room.setName(playerName).catch(() => {});
    }
    const hp = Math.round(myDyno.peakHp.v);
    if (
      mine.engineId === spec.id &&
      mine.wastegateKpa === snap.wastegateKpa &&
      mine.peakHp === hp
    ) {
      return;
    }
    room
      .updateLoadout({
        engineId: spec.id,
        engineName: spec.name,
        wastegateKpa: snap.wastegateKpa,
        peakHp: hp,
        maps: structuredClone(maps),
      })
      .catch(() => {});
  }, [phase, roomSnap, spec, snap.wastegateKpa, myDyno, maps, playerName]);

  const hostRace = useCallback(async () => {
    if (snap.blown || busy) return;
    setBusy(true);
    setMpError(null);
    try {
      const room = await RaceRoom.host(myMeta(), { pass: hostPass });
      attachRoom(room);
      setPhase("lobby");
    } catch (e) {
      setMpError(friendlyDbError(e));
    } finally {
      setBusy(false);
    }
  }, [snap.blown, busy, myMeta, attachRoom, hostPass]);

  const joinRace = useCallback(
    async (codeArg?: string) => {
      const code = extractJoinCode(codeArg ?? joinCode);
      if (snap.blown || busy || code.length < 4) return;
      setBusy(true);
      setMpError(null);
      try {
        const room = await RaceRoom.join(code, myMeta(), joinPass);
        attachRoom(room);
        setPhase("lobby");
      } catch (e) {
        setMpError(friendlyDbError(e));
      } finally {
        setBusy(false);
      }
    },
    [snap.blown, busy, joinCode, joinPass, myMeta, attachRoom],
  );

  // arriving via an invite link: prefill, scrub the URL, join once — the
  // latch lives at module scope so tab switches don't re-trigger the join
  useEffect(() => {
    if (!autoJoinCode || autoJoinConsumed) return;
    autoJoinConsumed = true;
    const code = extractJoinCode(autoJoinCode);
    setJoinCode(code);
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState({}, "", url);
    void joinRace(code);
  }, [autoJoinCode, joinRace]);

  const leaveRoom = useCallback(() => {
    unsubRoomRef.current?.();
    unsubRoomRef.current = null;
    roomRef.current?.leave();
    roomRef.current = null;
    activeRoom = null;
    setRoomSnap(null);
    setPhase("setup");
    setHud(null);
    setOutcome(null);
  }, []);

  // the "open races" browser is live while you're on the setup screen
  useEffect(() => {
    if (phase !== "setup") return;
    return RaceRoom.watchLobby(setLobbyList);
  }, [phase]);

  // ---- the race runner -----------------------------------------------------
  useEffect(() => {
    if (phase !== "armed") return;
    const env = envRef.current;
    if (!env) return;

    engine.stop(); // race owns the audio + the crank now
    const car = createRaceCar(env.spec, engine.getSnapshot().health);
    car.t = (performance.now() - greenAtPerfRef.current) / 1000;

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastHealth = car.health;
    let lastGear = car.gear;
    let sentResult = false;
    let endAt: number | null = null;
    let stopped = false;

    const loop = (now: number) => {
      if (stopped) return;
      // allow big catch-up chunks: background tabs throttle timers to ~1 Hz
      acc += Math.min(2.5, (now - last) / 1000);
      last = now;
      let guard = 0;
      while (acc >= RACE_STEP && guard++ < 400) {
        acc -= RACE_STEP;
        let shift = false;
        if (car.t >= 0 && car.shiftT <= 0 && car.v > 2) {
          if (shiftQueueRef.current > 0) {
            shift = true;
            shiftQueueRef.current = 0;
          } else if (
            autoShiftRef.current &&
            !roomRef.current && // auto-shift is a solo assist — multiplayer is manual
            car.gear >= 0 && // never auto-engage first from neutral at speed
            car.rpm >= env.shiftRpm &&
            car.gear < GEARBOX.ratios.length - 1
          ) {
            shift = true;
          }
        } else if (car.t < 0) {
          shiftQueueRef.current = 0;
          gearRequestRef.current = null;
        }
        // H-pattern grab: applied as soon as the box is free
        let gearSel: number | null = null;
        if (gearRequestRef.current !== null && car.t >= 0 && car.shiftT <= 0) {
          gearSel = gearRequestRef.current;
          gearRequestRef.current = null;
        }
        stepRaceCar(car, env, throttleRef.current, shift, gearSel);
      }

      // damage is real: it carries into the engine you tune
      if (car.health < lastHealth - 0.01) {
        engine.applyDamage(
          lastHealth - car.health,
          "drag racing — knock/lean under load",
        );
        lastHealth = car.health;
      }

      // mirror the car onto the sidebar gauges (tach, boost, AFR, EGT…)
      engine.feedRaceTelemetry(car);

      engineSound.update(
        env.spec,
        Math.max(car.rpm, 0),
        car.throttle,
        clamp((car.mapKpa - 100) / 100, 0, 1),
        !car.blown,
        car.afr,
      );
      // knock is audible, and rich shift cuts bark through the exhaust
      if (car.knocking) engineSound.knockPing();
      if (car.gear !== lastGear) {
        lastGear = car.gear;
        if (car.afr < 13.4) {
          engineSound.pop(0.45 + Math.random() * 0.4);
        }
      }

      const room = roomRef.current;
      if (room) {
        room.sendLive({
          t: car.t,
          d: car.d,
          v: car.v,
          rpm: Math.round(car.rpm),
          gear: car.gear,
          blown: car.blown,
          finished: car.finished,
        });
        if (!sentResult && (car.finished || (car.blown && car.v < 1))) {
          sentResult = true;
          room
            .sendResult({
              et: car.et,
              trapKph: car.trapKph,
              sixtyFt: car.sixtyFt,
              blown: car.blown,
            })
            .catch(() => {});
        }
      }

      setHud({ ...car });

      const meDone = car.finished || (car.blown && car.v < 1) || car.t > RACE_TIMEOUT;
      let oppDone: boolean;
      if (room) {
        const s = roomSnapRef.current;
        const oppIds = Object.keys(s?.players ?? {}).filter(
          (pid) => pid !== room.myId,
        );
        // done when every remaining rival has finished, blown up, or reported
        // a result — drivers who disconnect drop out of players automatically
        oppDone =
          oppIds.length === 0 ||
          car.t > RACE_TIMEOUT ||
          oppIds.every((pid) => {
            if (s?.results[pid]) return true;
            const l = s?.live[pid];
            return l ? l.finished || (l.blown && l.v < 1) : false;
          });
      } else {
        const g = ghostRef.current!;
        oppDone = g.et !== null ? car.t > g.et + 0.4 : ghostAt(g, car.t).done;
      }
      if (meDone && oppDone && endAt === null) endAt = now + 1400;

      if (endAt !== null && now >= endAt) {
        // make sure the opponent always gets a result, even on a timeout/DNF
        if (roomRef.current && !sentResult) {
          sentResult = true;
          roomRef.current
            .sendResult({
              et: car.et,
              trapKph: car.trapKph,
              sixtyFt: car.sixtyFt,
              blown: car.blown,
            })
            .catch(() => {});
        }
        if (car.et !== null) recordEt(env.spec.id, car.et, car.trapKph);
        if (!roomRef.current) {
          setOutcome({
            kind: "solo",
            me: {
              et: car.et,
              trapKph: car.trapKph,
              sixtyFt: car.sixtyFt,
              blown: car.blown,
            },
            ghost: ghostRef.current!,
            aiLabel:
              AI_LEVELS.find((l) => l.id === aiLevel)?.label ?? "Rival",
          });
        }
        stopped = true;
        clearInterval(hiddenTimer);
        setPhase("done");
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // rAF freezes in background tabs — keep the physics (and live streaming)
    // going so a hidden player's car doesn't park on the strip mid-race
    const hiddenTimer = window.setInterval(() => {
      if (!stopped && document.hidden) {
        cancelAnimationFrame(raf);
        loop(performance.now());
      }
    }, 100);

    return () => {
      stopped = true;
      clearInterval(hiddenTimer);
      cancelAnimationFrame(raf);
      engineSound.update(env.spec, 0, 0, 0, false);
      engine.start();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ---- inputs --------------------------------------------------------------
  useEffect(() => {
    if (phase !== "armed") return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        throttleRef.current = true;
      } else if (!e.repeat && (e.key === "ArrowUp" || e.key.toLowerCase() === "e")) {
        e.preventDefault();
        shiftQueueRef.current = 1;
      } else if (!e.repeat && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        gearRequestRef.current = Number(e.key) - 1; // 0 = neutral
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") throttleRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      throttleRef.current = false;
      gearRequestRef.current = null;
    };
  }, [phase]);

  // ---- opponent display state ---------------------------------------------
  const room = roomRef.current;
  const t = hud?.t ?? -STAGE_S;

  let opps: OppDisp[] = [];
  if (phase === "armed" || phase === "done") {
    if (room) {
      opps = Object.keys(roomSnap?.players ?? {})
        .filter((pid) => pid !== room.myId)
        .map((pid, i) => {
          const meta = roomSnap!.players[pid];
          const live = roomSnap?.live[pid];
          const color = OPP_COLORS[i % OPP_COLORS.length];
          if (!live) {
            return { id: pid, d: 0, v: 0, gear: 0, label: meta.name, blown: false, color };
          }
          const age = clamp(t - live.t, 0, 0.6);
          return {
            id: pid,
            d: live.d + (live.finished || live.blown ? 0 : live.v * age),
            v: live.v,
            gear: live.gear,
            label: meta.name,
            blown: live.blown,
            color,
          };
        });
    } else if (ghostRef.current) {
      const g = ghostAt(ghostRef.current, t);
      opps = [
        {
          id: "ghost",
          d: g.d,
          v: g.v,
          gear: g.gear,
          label: AI_LEVELS.find((l) => l.id === aiLevel)?.label ?? "Rival",
          blown: ghostRef.current.blown && g.done,
          color: OPP_COLORS[0],
        },
      ];
    }
  }

  // ---- render ---------------------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      {phase === "setup" && (
        <SetupView
          spec={spec}
          blown={snap.blown}
          peakHp={myDyno.peakHp.v}
          wastegateKpa={snap.wastegateKpa}
          bestEt={bestEt ? bestEt.et : null}
          aiLevel={aiLevel}
          setAiLevel={setAiLevel}
          onStage={stageSolo}
          onHost={hostRace}
          hostPass={hostPass}
          setHostPass={setHostPass}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          joinPass={joinPass}
          setJoinPass={setJoinPass}
          onJoin={joinRace}
          lobbyList={lobbyList}
          busy={busy}
          mpError={mpError}
          autoShift={autoShift}
          setAutoShift={setAutoShift}
        />
      )}

      {phase === "lobby" && room && (
        <LobbyView
          room={room}
          snap={roomSnap}
          onLeave={leaveRoom}
          blown={snap.blown}
        />
      )}

      {(phase === "armed" || phase === "done") && (
        <>
          <TrackView
            t={t}
            me={{
              d: hud?.d ?? 0,
              label: room ? playerName : "You",
              blown: hud?.blown ?? false,
              finished: hud?.finished ?? false,
            }}
            opps={opps}
          />
          {hud && (
            <RaceHud
              car={hud}
              env={envRef.current!}
              autoShift={autoShift && !room}
              allowAutoShift={!room}
              setAutoShift={setAutoShift}
              onThrottle={(v) => (throttleRef.current = v)}
              onShift={() => (shiftQueueRef.current = 1)}
            />
          )}
        </>
      )}

      <AnimatePresence>
        {phase === "done" && (
          <ResultsView
            outcome={outcome}
            hud={hud}
            room={room}
            roomSnap={roomSnap}
            bestEt={bestEt ? bestEt.et : null}
            onAgain={() => {
              setPhase("setup");
              setHud(null);
            }}
            onRematch={() => room?.rematch()}
            onLeave={leaveRoom}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================ sub-views ======================================

function SetupView(p: {
  spec: EngineSpec;
  blown: boolean;
  peakHp: number;
  wastegateKpa: number;
  bestEt: number | null;
  aiLevel: AiLevel;
  setAiLevel: (l: AiLevel) => void;
  onStage: () => void;
  onHost: () => void;
  hostPass: string;
  setHostPass: (v: string) => void;
  joinCode: string;
  setJoinCode: (c: string) => void;
  joinPass: string;
  setJoinPass: (v: string) => void;
  onJoin: (code?: string) => void;
  lobbyList: LobbyEntry[];
  busy: boolean;
  mpError: string | null;
  autoShift: boolean;
  setAutoShift: (b: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded border border-grid bg-surface p-3">
        <div>
          <div className="text-sm font-bold">Quarter mile — {QUARTER_MILE_M.toFixed(0)} m</div>
          <div className="text-xs text-muted">
            Your build: <span className="font-semibold text-s2">{p.peakHp.toFixed(0)} whp</span>
            {p.spec.turbo ? ` at ${p.wastegateKpa.toFixed(0)} kPa` : " (NA)"} · the tune you race
            is the tune on your maps right now
          </div>
        </div>
        <div className="ml-auto text-right text-xs text-muted">
          Best ET ({p.spec.name.split("—")[0].trim()})
          <div className="text-base font-bold text-s1">{fmtEt(p.bestEt)}</div>
        </div>
      </div>

      {p.blown && (
        <div className="rounded border border-crit bg-crit/10 p-3 text-sm text-crit">
          Engine is blown — rebuild it (sidebar) before racing.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* solo */}
        <div className="flex flex-col gap-3 rounded border border-grid bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink2">
            Solo — race the house
          </div>
          <div className="flex flex-col gap-2">
            {AI_LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => p.setAiLevel(l.id)}
                className={`rounded border p-2 text-left text-sm transition-colors ${
                  p.aiLevel === l.id
                    ? "border-s1 bg-s1/10 text-ink"
                    : "border-grid text-ink2 hover:border-axis"
                }`}
              >
                <div className="font-semibold">{l.label}</div>
                <div className="text-xs text-muted">{l.desc}</div>
              </button>
            ))}
          </div>
          <div className="text-xs text-muted">
            The rival drives the same {p.spec.name.split("—")[0].trim()} — only the tune differs.
          </div>
          <label className="flex items-center gap-2 rounded border border-grid bg-raised/40 p-2 text-xs text-ink2">
            <input
              type="checkbox"
              checked={p.autoShift}
              onChange={(e) => p.setAutoShift(e.target.checked)}
            />
            <span>
              <span className="font-semibold text-ink">Auto-shift</span> — the box
              changes gears for you (solo only)
            </span>
          </label>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={p.onStage}
            disabled={p.blown}
            className="rounded bg-s1 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
          >
            ▶ Stage up
          </motion.button>
        </div>

        {/* multiplayer */}
        <div className="flex flex-col gap-3 rounded border border-grid bg-surface p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink2">
            Multiplayer — race your friends (2–8 drivers)
          </div>

          {/* host */}
          <div className="flex flex-col gap-2 rounded border border-grid bg-raised/40 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-s2">
              Host a race
            </div>
            <div className="flex items-center gap-2">
              <input
                value={p.hostPass}
                onChange={(e) => p.setHostPass(e.target.value)}
                placeholder="Password (optional)"
                maxLength={24}
                title="Set a password to keep randoms out of your race"
                className="min-w-0 flex-1 rounded border border-grid bg-raised px-2 py-1.5 text-sm"
              />
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={p.onHost}
                disabled={p.blown || p.busy}
                className="shrink-0 rounded bg-s2 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
              >
                {p.busy ? "…" : `Host${p.hostPass.trim() ? " 🔒" : ""}`}
              </motion.button>
            </div>
            <div className="text-[11px] text-muted">
              You get a room code and an invite link to share. A password locks the room.
            </div>
          </div>

          {/* join */}
          <div className="flex flex-col gap-2 rounded border border-grid bg-raised/40 p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-s1">
              Join a race
            </div>
            <div className="flex items-center gap-2">
              <input
                value={p.joinCode}
                onChange={(e) => p.setJoinCode(extractJoinCode(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && p.onJoin()}
                placeholder="CODE"
                title="Paste a code or a whole invite link"
                className="w-24 shrink-0 rounded border border-grid bg-raised px-2 py-1.5 text-center font-mono text-base font-bold tracking-[0.3em]"
              />
              <input
                value={p.joinPass}
                onChange={(e) => p.setJoinPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && p.onJoin()}
                placeholder="Password"
                maxLength={24}
                title="Only needed for locked races"
                className="min-w-0 flex-1 rounded border border-grid bg-raised px-2 py-1.5 text-sm"
              />
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={() => p.onJoin()}
                disabled={p.blown || p.busy || p.joinCode.trim().length < 4}
                className="shrink-0 rounded border border-s1 px-4 py-2 text-sm font-bold text-s1 disabled:opacity-40"
              >
                Join
              </motion.button>
            </div>
            <div className="text-[11px] text-muted">
              Paste a code or a whole invite link — the password is only needed for 🔒 rooms.
            </div>
          </div>

          {p.mpError && (
            <div className="rounded border border-warn bg-warn/10 p-2 text-xs text-warn">
              {p.mpError}
            </div>
          )}
          <div className="mt-auto text-xs text-muted">
            You can keep tuning in the lobby — your loadout locks at the green light.
          </div>
        </div>
      </div>

      {/* open races browser */}
      <div className="flex flex-col gap-2 rounded border border-grid bg-surface p-4">
        <div className="flex items-baseline gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink2">
            Open races
          </div>
          <span className="text-[11px] text-muted">
            live — pick one and jump in ({p.lobbyList.length})
          </span>
        </div>
        {p.lobbyList.length === 0 ? (
          <div className="rounded border border-dashed border-grid p-3 text-center text-xs text-muted">
            Nobody's hosting right now — start one and share the code.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {p.lobbyList.map((e) => {
              const joinable = e.status === "lobby" && e.players < MAX_PLAYERS;
              return (
                <div
                  key={e.code}
                  className="flex items-center gap-3 rounded border border-grid bg-raised px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs font-bold tracking-[0.2em] text-s1">
                    {e.code}
                  </span>
                  <span className="truncate font-semibold">{e.hostName}</span>
                  <span className="hidden truncate text-xs text-ink2 sm:inline">
                    {e.engineName.split("—")[0].trim()} · {e.peakHp} whp
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted">
                    {e.players}/{MAX_PLAYERS}
                    {e.hasPass ? " · 🔒" : ""}
                    {e.status === "racing" ? " · racing" : ""}
                  </span>
                  <button
                    onClick={() => {
                      p.setJoinCode(e.code);
                      p.onJoin(e.code); // locked + no password → helpful error
                    }}
                    disabled={p.blown || p.busy || !joinable}
                    title={
                      e.hasPass
                        ? "Locked — type the password in the field above, then click"
                        : "Join this race"
                    }
                    className="shrink-0 rounded bg-s2 px-3 py-1 text-xs font-bold text-white disabled:opacity-30"
                  >
                    {e.hasPass ? "Join 🔒" : "Join"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="text-[11px] text-muted">
        Controls: hold <kbd className="rounded border border-grid px-1">Space</kbd> = throttle,{" "}
        <kbd className="rounded border border-grid px-1">E</kbd> /{" "}
        <kbd className="rounded border border-grid px-1">↑</kbd> = shift up,{" "}
        <kbd className="rounded border border-grid px-1">1–6</kbd> = grab a gear,{" "}
        <kbd className="rounded border border-grid px-1">0</kbd> = neutral. Multiplayer is always
        manual.
      </div>
    </div>
  );
}

function LobbyView({
  room,
  snap,
  onLeave,
  blown,
}: {
  room: RaceRoom;
  snap: RoomSnapshot | null;
  onLeave: () => void;
  blown: boolean;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const setPlayerName = useGameStore((s) => s.setPlayerName);
  const players = snap?.players ?? {};
  const ids = Object.keys(players);
  const me = players[room.myId];
  const allReady = ids.length >= 2 && ids.every((id) => players[id].ready);

  const commitName = () => {
    if (nameDraft === null) return;
    const clean = nameDraft.trim().slice(0, 20);
    if (clean && clean !== me?.name) {
      setPlayerName(clean);
      room.setName(clean).catch(() => {});
    }
    setNameDraft(null);
  };

  const copy = (what: "code" | "link") => {
    navigator.clipboard?.writeText(
      what === "code" ? room.code : inviteLink(room.code),
    );
    setCopied(what);
    setTimeout(() => setCopied(null), 1400);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col items-center gap-1 rounded border border-grid bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-muted">Room code</div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-4xl font-black tracking-[0.35em] text-s1">
            {room.code}
          </span>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => copy("code")}
              className="rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
            >
              {copied === "code" ? "Copied ✓" : "Copy code"}
            </button>
            <button
              onClick={() => copy("link")}
              className="rounded bg-s2 px-2 py-1 text-xs font-bold text-white hover:opacity-90"
              title={inviteLink(room.code)}
            >
              {copied === "link" ? "Copied ✓" : "🔗 Copy invite link"}
            </button>
          </div>
        </div>
        <div className="text-xs text-muted">
          Share the link — it drops your rivals straight into this lobby. Up to {MAX_PLAYERS}{" "}
          drivers ({ids.length}/{MAX_PLAYERS} in the room).
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ids.map((id) => {
          const pl = players[id];
          return (
            <div
              key={id}
              className={`flex min-h-28 flex-col gap-1 rounded border p-3 ${
                pl.ready ? "border-good bg-good/5" : "border-grid bg-surface"
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-bold">
                {id === room.myId ? (
                  <input
                    value={nameDraft ?? pl.name}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    maxLength={20}
                    title="Click to rename yourself"
                    className="-mx-1 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-sm font-bold text-ink outline-none hover:border-grid focus:border-s1 focus:bg-raised"
                  />
                ) : (
                  <span className="truncate">{pl.name}</span>
                )}
                {id === room.myId && (
                  <span className="rounded bg-s1/20 px-1.5 text-[10px] text-s1">you</span>
                )}
                {id === snap?.hostId && (
                  <span className="rounded bg-raised px-1.5 text-[10px] text-muted">host</span>
                )}
              </div>
              <div className="truncate text-xs text-ink2">{pl.engineName}</div>
              <div className="text-xs text-muted">
                <span className="font-semibold text-s2">{pl.peakHp} whp</span>
                {pl.wastegateKpa > 100 ? ` @ ${pl.wastegateKpa} kPa` : ""}
              </div>
              <div
                className={`mt-auto text-xs font-semibold ${pl.ready ? "text-good" : "text-muted"}`}
              >
                {pl.ready ? "READY" : "not ready"}
              </div>
            </div>
          );
        })}
        {ids.length < MAX_PLAYERS && (
          <div className="flex min-h-28 flex-col rounded border border-dashed border-grid p-3">
            <div className="m-auto animate-pulse text-center text-xs text-muted">
              waiting for rivals…
              <div className="mt-1 font-mono text-ink2">{room.code}</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-3">
        <motion.button
          whileTap={{ scale: 0.97 }}
          disabled={blown}
          onClick={() => room.setReady(!me?.ready)}
          className={`rounded px-5 py-2.5 text-sm font-bold disabled:opacity-40 ${
            me?.ready
              ? "border border-good text-good"
              : "bg-good text-white"
          }`}
        >
          {me?.ready ? "Un-ready" : "Ready ✓"}
        </motion.button>
        {room.isHost && (
          <motion.button
            whileTap={{ scale: 0.97 }}
            disabled={!allReady}
            onClick={() => room.launch()}
            className="rounded bg-s1 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            title={allReady ? "Go!" : "Needs 2+ drivers, everyone ready"}
          >
            🏁 Launch race
          </motion.button>
        )}
        <button
          onClick={onLeave}
          className="rounded border border-grid px-3 py-2 text-xs text-muted hover:text-ink"
        >
          Leave
        </button>
      </div>
      {!room.isHost && allReady && (
        <div className="text-center text-xs text-muted">
          Waiting for the host to launch…
        </div>
      )}
      <div className="text-center text-[11px] text-muted">
        You can still swap engines and edit maps from the Tune tab — your card updates
        live and changing anything un-readies you. The tune racing is the one you have
        at the green light.
      </div>
    </div>
  );
}

function TreeLights({ t }: { t: number }) {
  const green = t >= 0;
  return (
    <div className="flex flex-col items-center gap-1 px-2">
      {[0, 1, 2].map((i) => {
        const on = !green && t >= -STAGE_S + i * 0.5;
        return (
          <div
            key={i}
            className={`h-4 w-4 rounded-full border border-grid transition-colors ${
              on ? "bg-warn shadow-[0_0_10px_2px_rgba(250,178,25,0.6)]" : "bg-raised"
            }`}
          />
        );
      })}
      <div
        className={`h-5 w-5 rounded-full border border-grid transition-colors ${
          green ? "bg-good shadow-[0_0_14px_3px_rgba(12,163,12,0.7)]" : "bg-raised"
        }`}
      />
    </div>
  );
}

function Lane({
  d,
  label,
  blown,
  color,
  gear,
  v,
  compact,
}: {
  d: number;
  label: string;
  blown: boolean;
  color: string;
  gear?: number;
  v?: number;
  compact?: boolean;
}) {
  const pct = clamp((d / QUARTER_MILE_M) * 100, 0, 100);
  return (
    <div
      className={`relative overflow-hidden rounded border border-grid bg-page ${
        compact ? "h-8" : "h-12"
      }`}
    >
      {/* distance markers: 60ft, 1/8, 1000ft */}
      {[4.55, 50, 75.7].map((m) => (
        <div key={m} className="absolute inset-y-0 w-px bg-grid" style={{ left: `${m}%` }} />
      ))}
      {/* finish line */}
      <div
        className="absolute inset-y-0 right-0 w-2 opacity-70"
        style={{
          backgroundImage:
            "repeating-conic-gradient(#fff 0% 25%, #111 0% 50%)",
          backgroundSize: "6px 6px",
        }}
      />
      <div className="absolute left-1 top-0.5 z-10 text-[10px] font-semibold text-muted">
        {label}
        {!compact && v !== undefined && v > 0.5 && (
          <span className="ml-2 text-ink2">
            {(v * 3.6).toFixed(0)} km/h
            {gear !== undefined ? ` · ${gear < 0 ? "N" : gear + 1}` : ""}
          </span>
        )}
      </div>
      <div
        className={`absolute top-1/2 -translate-y-1/2 rounded-sm transition-none ${
          compact ? "h-3 w-7" : "h-4 w-9"
        }`}
        style={{ left: `calc(${pct}% * 0.94)`, background: blown ? "#d03b3b" : color }}
      >
        {blown && <span className="absolute -top-3 left-2 text-xs">💥</span>}
        <div className="absolute inset-y-1 left-1 w-1 rounded-full bg-black/40" />
        <div className="absolute inset-y-1 right-1 w-1 rounded-full bg-black/40" />
      </div>
    </div>
  );
}

function TrackView({
  t,
  me,
  opps,
}: {
  t: number;
  me: { d: number; label: string; blown: boolean; finished: boolean };
  opps: OppDisp[];
}) {
  const compact = opps.length > 2;
  return (
    <div className="flex items-stretch gap-2 rounded border border-grid bg-surface p-3">
      <TreeLights t={t} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        {opps.length === 0 ? (
          <div className="flex h-12 items-center justify-center rounded border border-grid text-xs text-muted">
            no opponent
          </div>
        ) : (
          opps.map((o) => (
            <Lane
              key={o.id}
              d={o.d}
              label={o.label}
              blown={o.blown}
              color={o.color}
              v={o.v}
              gear={o.gear}
              compact={compact}
            />
          ))
        )}
        <Lane d={me.d} label={me.label} blown={me.blown} color="#3987e5" compact={compact} />
      </div>
      <div className="flex w-20 flex-col items-center justify-center rounded bg-page font-mono">
        <div className="text-[10px] uppercase text-muted">clock</div>
        <div
          className={`text-lg font-bold ${
            t >= RACE_TIMEOUT
              ? "text-crit"
              : t >= RACE_TIMEOUT - 5
                ? "text-warn"
                : "text-ink"
          }`}
        >
          {t < 0
            ? t.toFixed(1)
            : Math.min(t, RACE_TIMEOUT).toFixed(2)}
        </div>
        {t >= RACE_TIMEOUT && (
          <div className="text-[9px] uppercase text-crit">time out</div>
        )}
      </div>
    </div>
  );
}

function RaceHud({
  car,
  env,
  autoShift,
  allowAutoShift,
  setAutoShift,
  onThrottle,
  onShift,
}: {
  car: RaceCar;
  env: RaceEnv;
  autoShift: boolean;
  /** auto-shift is a solo assist — hidden entirely in multiplayer */
  allowAutoShift: boolean;
  setAutoShift: (b: boolean) => void;
  onThrottle: (v: boolean) => void;
  onShift: () => void;
}) {
  const spec = env.spec;
  const rpmPct = clamp((car.rpm / spec.revLimit) * 100, 0, 100);
  const shiftPct = clamp((env.shiftRpm / spec.revLimit) * 100, 0, 100);
  const wantShift =
    car.rpm >= env.shiftRpm && car.gear < GEARBOX.ratios.length - 1 && car.t >= 0;
  const boost = Math.max(0, car.mapKpa - 100);

  return (
    <div className="flex flex-col gap-3 rounded border border-grid bg-surface p-3">
      {/* rpm bar with shift marker */}
      <div className="relative h-6 overflow-hidden rounded bg-page">
        <div
          className={`absolute inset-y-0 left-0 ${
            car.knocking
              ? "bg-crit"
              : wantShift
                ? "bg-warn"
                : "bg-linear-to-r from-s2 to-s1"
          }`}
          style={{ width: `${rpmPct}%` }}
        />
        <div
          className="absolute inset-y-0 w-0.5 bg-warn"
          style={{ left: `${shiftPct}%` }}
          title="shift point"
        />
        <div className="absolute inset-0 flex items-center justify-between px-2 font-mono text-xs font-bold text-white mix-blend-difference">
          <span>{Math.round(car.rpm)} rpm</span>
          {wantShift && !autoShift && <span className="animate-pulse">SHIFT ▲</span>}
          {car.knocking && <span className="animate-pulse">KNOCK!</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-sm">
        <div>
          <span className="text-[10px] uppercase text-muted">gear </span>
          <span className="text-2xl font-black text-ink">
            {car.shiftT > 0 ? "·" : car.gear < 0 ? "N" : car.gear + 1}
          </span>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted">speed </span>
          <span className="text-2xl font-black text-ink">{(car.v * 3.6).toFixed(0)}</span>
          <span className="text-xs text-muted"> km/h</span>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted">boost </span>
          <span className={`text-lg font-bold ${boost > 1 ? "text-s3" : "text-muted"}`}>
            {boost.toFixed(0)} kPa
          </span>
        </div>
        <div>
          <span className="text-[10px] uppercase text-muted">dist </span>
          <span className="text-lg font-bold text-ink2">{car.d.toFixed(0)} m</span>
        </div>
        <div className="min-w-24 flex-1">
          <div className="mb-0.5 text-[10px] uppercase text-muted">health</div>
          <div className="h-1.5 overflow-hidden rounded bg-page">
            <div
              className={`h-full ${car.health > 60 ? "bg-good" : car.health > 30 ? "bg-warn" : "bg-crit"}`}
              style={{ width: `${car.health}%` }}
            />
          </div>
        </div>
        <label
          className={`flex items-center gap-1.5 text-xs text-ink2 ${
            allowAutoShift ? "" : "hidden"
          }`}
        >
          <input
            type="checkbox"
            checked={autoShift}
            onChange={(e) => setAutoShift(e.target.checked)}
          />
          auto-shift
        </label>
      </div>

      {/* touch / mouse controls */}
      <div className="flex gap-2">
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            onThrottle(true);
          }}
          onPointerUp={() => onThrottle(false)}
          onPointerLeave={() => onThrottle(false)}
          onPointerCancel={() => onThrottle(false)}
          className={`h-14 flex-1 select-none rounded text-sm font-black tracking-widest ${
            car.throttle > 0 ? "bg-s2 text-white" : "bg-raised text-ink2"
          }`}
        >
          THROTTLE — hold (Space)
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            onShift();
          }}
          disabled={autoShift}
          className={`h-14 w-36 select-none rounded text-sm font-black tracking-widest disabled:opacity-30 ${
            wantShift ? "bg-warn text-black" : "bg-raised text-ink2"
          }`}
        >
          SHIFT ▲ (E)
        </button>
      </div>
      {car.t < 0 && (
        <div className="text-center text-xs text-warn">
          Staged — hold throttle to build revs and boost. Green in {(-car.t).toFixed(1)} s…
        </div>
      )}
    </div>
  );
}

function ResultsView({
  outcome,
  hud,
  room,
  roomSnap,
  bestEt,
  onAgain,
  onRematch,
  onLeave,
}: {
  outcome: Outcome | null;
  hud: RaceCar | null;
  room: RaceRoom | null;
  roomSnap: RoomSnapshot | null;
  bestEt: number | null;
  onAgain: () => void;
  onRematch: () => void;
  onLeave: () => void;
}) {
  let rows: { name: string; res: Partial<RaceResult>; me: boolean }[] = [];
  let verdict = "";

  if (outcome?.kind === "solo" && hud) {
    rows = [
      { name: "You", res: outcome.me, me: true },
      {
        name: outcome.aiLabel,
        res: {
          et: outcome.ghost.et,
          trapKph: outcome.ghost.trapKph,
          sixtyFt: outcome.ghost.sixtyFt,
          blown: outcome.ghost.blown,
        },
        me: false,
      },
    ];
    const a = outcome.me.et;
    const b = outcome.ghost.et;
    verdict =
      a !== null && (b === null || a <= b)
        ? "YOU WIN"
        : a === null && b === null
          ? "NOBODY FINISHED"
          : "YOU LOSE";
  } else if (room && roomSnap) {
    const ids = Object.keys(roomSnap.players);
    rows = ids.map((id) => ({
      name: roomSnap.players[id].name,
      res: roomSnap.results[id] ?? {},
      me: id === room.myId,
    }));
    const pending = ids.filter((id) => !roomSnap.results[id]).length;
    const myEt = roomSnap.results[room.myId]?.et ?? null;
    if (ids.length <= 1) verdict = "EVERYONE LEFT";
    else if (pending > 0) verdict = `WAITING FOR ${pending} RESULT${pending > 1 ? "S" : ""}…`;
    else if (myEt === null) verdict = "DNF";
    else {
      const finishers = ids
        .map((id) => roomSnap.results[id]?.et ?? null)
        .filter((et): et is number => et !== null)
        .sort((a, b) => a - b);
      const rank = finishers.indexOf(myEt) + 1;
      verdict = rank === 1 ? "YOU WIN" : `P${rank} OF ${ids.length}`;
    }
  }

  // standings order: quickest ET first, DNFs at the bottom
  rows.sort(
    (a, b) => (a.res.et ?? Number.POSITIVE_INFINITY) - (b.res.et ?? Number.POSITIVE_INFINITY),
  );

  const win = verdict === "YOU WIN";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mx-auto w-full max-w-xl rounded border border-grid bg-surface p-4"
    >
      <div
        className={`mb-3 text-center text-2xl font-black tracking-wide ${
          win ? "text-good" : verdict === "YOU LOSE" ? "text-crit" : "text-ink2"
        }`}
      >
        {verdict}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted">
            <th className="w-6 py-1">#</th>
            <th>Driver</th>
            <th>60 ft</th>
            <th>ET</th>
            <th>Trap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name + (r.me ? "-me" : i)} className="border-t border-grid font-mono">
              <td className="py-1.5 text-muted">
                {r.res.et !== null && r.res.et !== undefined ? i + 1 : "—"}
              </td>
              <td className={`py-1.5 ${r.me ? "font-bold text-s1" : "text-ink2"}`}>
                {r.name} {r.res.blown && "💥"}
              </td>
              <td>{fmtT(r.res.sixtyFt)}</td>
              <td className="font-bold">{fmtEt(r.res.et)}</td>
              <td>
                {r.res.trapKph && r.res.trapKph > 0
                  ? `${r.res.trapKph.toFixed(0)} km/h`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bestEt !== null && (
        <div className="mt-2 text-center text-xs text-muted">
          Personal best on this engine: <span className="font-bold text-s1">{fmtEt(bestEt)}</span>
        </div>
      )}
      <div className="mt-4 flex justify-center gap-3">
        {room ? (
          <>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={onRematch}
              className="rounded bg-s1 px-4 py-2 text-sm font-bold text-white"
            >
              ↻ Back to lobby
            </motion.button>
            <button
              onClick={onLeave}
              className="rounded border border-grid px-4 py-2 text-sm text-ink2 hover:text-ink"
            >
              Leave room
            </button>
          </>
        ) : (
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={onAgain}
            className="rounded bg-s1 px-4 py-2 text-sm font-bold text-white"
          >
            ↻ Race again
          </motion.button>
        )}
      </div>
      <div className="mt-2 text-center text-[11px] text-muted">
        Everyone stays in the room — “Back to lobby” regroups all drivers for another
        round. Knock and lean damage carries over, so check your health first.
      </div>
    </motion.div>
  );
}
