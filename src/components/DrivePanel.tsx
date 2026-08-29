import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CARS, carForEngine, type Car } from "../engine/cars";
import { GEARBOX, type EngineSpec } from "../engine/engines";
import { engine, useEngineSnapshot } from "../engine/store";
import type { Maps } from "../engine/defaults";
import { engineSound } from "../engine/sound";
import { useTuneStore } from "../store/tuneStore";
import { SCENES, type SceneId } from "../game/world";
import { runDyno } from "../engine/dyno";
import { buildAxes } from "../engine/axes";
import { useGameStore } from "../store/gameStore";
import {
  friendlyDbError,
  RaceRoom,
  type RoomSnapshot,
} from "../multiplayer/room";
import { LobbyBrowser, LobbyRoom } from "./DriveLobby";
import type { CameraMode, DriveHud, RaceSetup, RawInput } from "./DriveCanvas";

// three.js only arrives when someone actually drives
const DriveCanvas = lazy(() => import("./DriveCanvas"));

const CAMERAS: { id: CameraMode; label: string }[] = [
  { id: "chase", label: "Chase" },
  { id: "bonnet", label: "Bonnet" },
  { id: "orbit", label: "Orbit" },
];

const EMPTY_HUD: DriveHud = {
  speedKph: 0,
  cones: 0,
  distance: 0,
  reversing: false,
  slip: 0,
  ready: false,
  loadPct: 0,
  error: null,
  race: null,
};

type Mode = "solo" | "browse" | "lobby" | "race";

/** the room outlives this panel, so you can tab away to tune and come back */
let activeRoom: RaceRoom | null = null;
/** invite links are consumed once per page load, surviving tab switches */
let autoJoinConsumed = false;

export default function DrivePanel({
  spec,
  engineId,
  maps,
  onGotoEngine,
  autoJoinCode = null,
}: {
  spec: EngineSpec;
  engineId: string;
  maps: Maps;
  onGotoEngine: (id: string) => void;
  /** room code from a ?join=track-XXXXX invite — joined once on mount */
  autoJoinCode?: string | null;
}) {
  const s = useEngineSnapshot();
  const muted = useTuneStore((st) => st.muted);
  const setMuted = useTuneStore((st) => st.setMuted);

  const [sceneId, setSceneId] = useState<SceneId>("airfield");
  const [seed, setSeed] = useState(1);
  const [camera, setCamera] = useState<CameraMode>("chase");
  const [hud, setHud] = useState<DriveHud>(EMPTY_HUD);
  const [resetToken, setResetToken] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  // ---- multiplayer -------------------------------------------------------
  const playerName = useGameStore((st) => st.playerName);
  const [mode, setMode] = useState<Mode>(activeRoom ? "lobby" : "solo");
  const [roomSnap, setRoomSnap] = useState<RoomSnapshot | null>(
    activeRoom?.current ?? null,
  );
  const [mpError, setMpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [raceSetup, setRaceSetup] = useState<RaceSetup | null>(null);
  const [finish, setFinish] = useState<{
    totalS: number;
    bestLap: number | null;
  } | null>(null);
  const roomRef = useRef<RaceRoom | null>(activeRoom);
  const unsubRef = useRef<(() => void) | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // your build, measured fresh whenever the tune changes — the lobby card
  // shows the same whp figure the drag strip would
  const peakHp = useMemo(() => {
    try {
      const axes = buildAxes(spec);
      return Math.round(runDyno(spec, axes, maps, s.wastegateKpa, 0).peakHp.v);
    } catch {
      return 0;
    }
  }, [spec, maps, s.wastegateKpa]);

  const myMeta = useCallback(
    () => ({
      name: playerName,
      engineId: spec.id,
      engineName: spec.name,
      wastegateKpa: s.wastegateKpa,
      peakHp,
      ready: false,
      maps: structuredClone(maps),
    }),
    [playerName, spec, s.wastegateKpa, peakHp, maps],
  );

  const attachRoom = useCallback((room: RaceRoom) => {
    roomRef.current = room;
    activeRoom = room;
    unsubRef.current?.();
    unsubRef.current = room.onChange((snap) => {
      setRoomSnap(snap);
      if (!snap) {
        roomRef.current = null;
        activeRoom = null;
        setRaceSetup(null);
        if (modeRef.current !== "solo") {
          setMpError("The race room closed — the host may have left.");
          setMode("browse");
        }
        return;
      }
      if (snap.status === "racing" && snap.greenAt !== null) {
        if (modeRef.current !== "race") {
          try {
            engineSound.ensure();
          } catch {
            /* silence is fine */
          }
          engine.setIgnition(true);
          if (engine.getSnapshot().gear < 0) engine.setGear(0);
          setFinish(null);
          setSceneId((snap.scene as SceneId) ?? "circuit");
          setSeed(snap.circuitSeed ?? 1);
          setRaceSetup({
            room,
            // the server clock says when; convert it to this machine's
            greenAtPerf: performance.now() + (snap.greenAt - room.serverNow()),
            laps: snap.laps,
            onFinish: (r) => {
              setFinish(r);
              room
                .sendResult({
                  et: r.totalS,
                  trapKph: 0,
                  sixtyFt: null,
                  blown: engine.getSnapshot().blown,
                  bestLap: r.bestLap,
                })
                .catch(() => {});
            },
          });
          setMode("race");
        }
      } else if (snap.status === "lobby" && modeRef.current === "race") {
        setRaceSetup(null);
        setMode("lobby");
      }
    });
  }, []);

  // re-attach when the panel remounts on a live room (tabbed away to tune)
  useEffect(() => {
    const room = roomRef.current;
    if (room) attachRoom(room);
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [attachRoom]);

  const hostRace = useCallback(
    async (opts: { pass: string; scene: SceneId; laps: number }) => {
      if (busy) return;
      setBusy(true);
      setMpError(null);
      try {
        const room = await RaceRoom.host(myMeta(), {
          pass: opts.pass,
          mode: "track",
          scene: opts.scene,
        });
        attachRoom(room);
        setMode("lobby");
      } catch (e) {
        setMpError(friendlyDbError(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, myMeta, attachRoom],
  );

  const joinRace = useCallback(
    async (code: string, pass: string) => {
      if (busy) return;
      setBusy(true);
      setMpError(null);
      try {
        const room = await RaceRoom.join(code, myMeta(), pass, undefined, [
          "track",
        ]);
        attachRoom(room);
        setMode("lobby");
      } catch (e) {
        setMpError(friendlyDbError(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, myMeta, attachRoom],
  );

  const leaveRoom = useCallback(() => {
    roomRef.current?.leave().catch(() => {});
    unsubRef.current?.();
    unsubRef.current = null;
    roomRef.current = null;
    activeRoom = null;
    setRoomSnap(null);
    setRaceSetup(null);
    setMode("solo");
  }, []);

  // an invite link drops you straight into the lobby, once per page load
  useEffect(() => {
    if (!autoJoinCode || autoJoinConsumed || roomRef.current) return;
    autoJoinConsumed = true;
    setMode("browse");
    joinRace(autoJoinCode, "");
  }, [autoJoinCode, joinRace]);

  // keep the lobby card honest as you retune next door
  useEffect(() => {
    const room = roomRef.current;
    if (mode !== "lobby" || !room) return;
    const mine = roomSnap?.players[room.myId];
    if (!mine) return;
    if (mine.name !== playerName) room.setName(playerName).catch(() => {});
    if (
      mine.engineId === spec.id &&
      mine.wastegateKpa === s.wastegateKpa &&
      mine.peakHp === peakHp
    )
      return;
    room
      .updateLoadout({
        engineId: spec.id,
        engineName: spec.name,
        wastegateKpa: s.wastegateKpa,
        peakHp,
        maps: structuredClone(maps),
      })
      .catch(() => {});
  }, [mode, roomSnap, playerName, spec, s.wastegateKpa, peakHp, maps]);

  // Drive the car that fronts the fitted engine. Most of the catalogue has
  // no scan yet, so those fall back to the one body that does exist — the
  // engine is still theirs, and the HUD says whose shell it is wearing.
  const own = carForEngine(engineId);
  const car: Car = useMemo(
    () => (own?.model ? own : (CARS.find((c) => c.model) ?? CARS[0])),
    [own],
  );
  const borrowed = own && own.id !== car.id ? own : null;

  const input = useRef<RawInput>({ steer: 0, throttle: 0, brake: 0 });

  // held keys → analog-ish targets; DriveCanvas does the ramping
  useEffect(() => {
    const held = new Set<string>();
    const apply = () => {
      const has = (...k: string[]) => k.some((x) => held.has(x));
      input.current.throttle = has("w", "arrowup", " ") ? 1 : 0;
      input.current.brake = has("s", "arrowdown") ? 1 : 0;
      input.current.steer =
        (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0);
    };
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement)?.closest("input,textarea,select") !== null;

    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        e.preventDefault();
        held.add(k);
        apply();
        return;
      }
      if (e.repeat) return;
      if (k === "r") setResetToken((t) => t + 1);
      else if (k === "c") setCamera((c) => CAMERAS[(CAMERAS.findIndex((x) => x.id === c) + 1) % CAMERAS.length].id);
    };
    const up = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase());
      apply();
    };
    const blur = () => {
      held.clear();
      apply();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      blur();
    };
  }, []);

  // gearbox keys live in Controls (the sidebar) on desktop, but the game has
  // to work on its own — bind the shifts here too
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      const k = e.key.toLowerCase();
      if (k === "e" || k === "shift") engine.shift(1);
      else if (k === "q" || k === "control") engine.shift(-1);
      else if (/^[0-9]$/.test(k)) engine.setGear(Number(k) - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // the sidebar owns this on desktop, but the game has to stand alone
  useEffect(() => {
    engineSound.setMuted(muted);
  }, [muted]);

  const onHud = useCallback((h: DriveHud) => setHud(h), []);

  const start = () => {
    // audio must never be able to stop the car from starting
    try {
      engineSound.ensure();
    } catch {
      /* no audio on this device — drive on in silence */
    }
    engine.setIgnition(true);
    if (s.gear < 0) engine.setGear(0);
  };

  const gear = hud.reversing ? "R" : s.gear < 0 ? "N" : String(s.gear + 1);
  const rpm01 = Math.min(1, s.rpm / spec.revLimit);
  const shiftLight = s.rpm > spec.redline * 0.94;

  const room = roomRef.current;
  const race = hud.race;

  if (mode === "browse" || (mode === "lobby" && !room)) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="p-2">
          <button
            onClick={() => setMode("solo")}
            className="rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
          >
            ← Free drive
          </button>
        </div>
        <LobbyBrowser
          onHost={hostRace}
          onJoin={joinRace}
          busy={busy}
          error={mpError}
        />
      </div>
    );
  }

  if (mode === "lobby" && room) {
    return (
      <div className="h-full overflow-y-auto">
        <LobbyRoom
          room={room}
          snap={roomSnap}
          onLeave={leaveRoom}
          blown={s.blown}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full bg-page">
      <Suspense
        fallback={
          <div className="absolute inset-0 grid place-items-center text-xs text-muted">
            Starting the scene…
          </div>
        }
      >
        <DriveCanvas
          car={car}
          sceneId={sceneId}
          seed={seed}
          camera={camera}
          input={input}
          onHud={onHud}
          resetToken={resetToken}
          race={mode === "race" ? raceSetup : null}
          className="h-full w-full"
        />
      </Suspense>

      {/* top bar: scene, camera, sound */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-1.5 p-2">
        {mode === "solo" ? (
          <>
            <div className="pointer-events-auto flex overflow-hidden rounded border border-grid bg-surface/85 text-[11px] backdrop-blur">
              {SCENES.map((sc) => (
                <button
                  key={sc.id}
                  onClick={() => setSceneId(sc.id)}
                  title={sc.blurb}
                  className={`px-2.5 py-1.5 font-semibold transition-colors ${
                    sceneId === sc.id
                      ? "bg-s1/25 text-s1"
                      : "text-muted hover:text-ink2"
                  }`}
                >
                  {sc.name}
                </button>
              ))}
            </div>

            <button
              onClick={() => setSeed((n) => n + 1)}
              title="Generate another layout"
              className="pointer-events-auto rounded border border-grid bg-surface/85 px-2 py-1.5 text-[11px] text-ink2 backdrop-blur hover:text-ink"
            >
              ⟳ New layout
            </button>

            <button
              onClick={() => {
                setMpError(null);
                setMode("browse");
              }}
              className="pointer-events-auto rounded border border-s1/60 bg-s1/15 px-2.5 py-1.5 text-[11px] font-semibold text-s1 backdrop-blur hover:bg-s1/25"
            >
              🏁 Race someone
            </button>
          </>
        ) : (
          <div className="pointer-events-auto flex items-center gap-2 rounded border border-grid bg-surface/85 px-2.5 py-1.5 text-[11px] backdrop-blur">
            <span className="font-mono font-bold tracking-[0.2em] text-s1">
              {room?.code}
            </span>
            <span className="text-muted">
              {SCENES.find((sc) => sc.id === sceneId)?.name}
              {race && race.kind === "lap" ? ` · ${race.totalLaps} laps` : ""}
            </span>
            <button
              onClick={() => {
                setRaceSetup(null);
                setMode("lobby");
              }}
              className="rounded border border-grid px-1.5 py-0.5 text-muted hover:text-ink"
            >
              Lobby
            </button>
          </div>
        )}

        <div className="pointer-events-auto ml-auto flex gap-1.5">
          <div className="flex overflow-hidden rounded border border-grid bg-surface/85 text-[11px] backdrop-blur">
            {CAMERAS.map((c) => (
              <button
                key={c.id}
                onClick={() => setCamera(c.id)}
                className={`px-2 py-1.5 transition-colors ${
                  camera === c.id ? "bg-s1/25 text-s1" : "text-muted hover:text-ink2"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setMuted(!muted)}
            title="Engine sound"
            className="rounded border border-grid bg-surface/85 px-2 py-1.5 text-[11px] text-ink2 backdrop-blur hover:text-ink"
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="rounded border border-grid bg-surface/85 px-2 py-1.5 text-[11px] text-ink2 backdrop-blur hover:text-ink"
          >
            ?
          </button>
        </div>
      </div>

      {/* what is actually being driven */}
      <div className="pointer-events-none absolute left-2 top-12 text-[11px] text-muted">
        {borrowed ? (
          <>
            {borrowed.maker} {borrowed.name}
            <span className="text-muted/70"> · {car.name} body</span>
          </>
        ) : (
          `${car.maker} ${car.name}`
        )}
        <span className="text-muted/70"> · {spec.name}</span>
        {hud.error && <span className="text-serious"> · {hud.error}</span>}
      </div>

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2">
        <div className="rounded border border-grid bg-surface/85 px-3 py-2 backdrop-blur">
          <div className="flex items-baseline gap-2">
            <span className="tabular text-3xl font-bold leading-none text-ink">
              {Math.round(hud.speedKph)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted">
              km/h
            </span>
            <span
              className={`tabular ml-2 rounded px-2 py-0.5 text-lg font-bold leading-none ${
                hud.reversing ? "bg-warn/20 text-warn" : "bg-raised text-ink"
              }`}
            >
              {gear}
            </span>
          </div>

          {/* tacho */}
          <div className="mt-2 h-1.5 w-52 overflow-hidden rounded bg-grid">
            <div
              className={`h-full transition-[width] duration-75 ${
                shiftLight ? "bg-crit" : s.rpm > spec.redline * 0.8 ? "bg-warn" : "bg-s2"
              }`}
              style={{ width: `${rpm01 * 100}%` }}
            />
          </div>
          <div className="mt-1 flex items-baseline gap-3 text-[10px] text-muted">
            <span className="tabular">{Math.round(s.rpm)} rpm</span>
            <span className="tabular">
              {s.mapKpa > 101 ? `+${((s.mapKpa - 100) / 100).toFixed(2)} bar` : "vacuum"}
            </span>
            <span className="tabular">{(hud.distance / 1000).toFixed(2)} km</span>
            {hud.cones > 0 && <span className="tabular text-s3">{hud.cones} cones</span>}
          </div>
        </div>

        {/* pedals + slip, and the touch pad on phones */}
        <div className="flex items-end gap-2">
          <div className="hidden rounded border border-grid bg-surface/85 p-2 backdrop-blur sm:block">
            <Bar label="THR" v={s.throttle} color="bg-s2" />
            <Bar label="BRK" v={s.brake} color="bg-crit" />
            <Bar label="SLIP" v={hud.slip} color="bg-s3" />
          </div>
          <TouchPad input={input} onShift={(d) => engine.shift(d)} />
        </div>
      </div>

      {/* race overlays */}
      {race && (
        <>
          {/* the lights */}
          <AnimatePresence>
            {race.countdown > -1.4 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.25 }}
                className="pointer-events-none absolute inset-x-0 top-[22%] grid place-items-center"
              >
                <div
                  className={`tabular text-6xl font-black tracking-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] ${
                    race.countdown > 0 ? "text-warn" : "text-good"
                  }`}
                >
                  {race.countdown > 0 ? Math.ceil(race.countdown) : "GO"}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* standings */}
          <div className="pointer-events-none absolute right-2 top-12 w-52 rounded border border-grid bg-surface/85 p-2 backdrop-blur">
            <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-muted">
              <span>Position</span>
              <span className="tabular">
                {race.kind === "lap"
                  ? `Lap ${Math.min(race.lap + 1, race.totalLaps)}/${race.totalLaps}`
                  : `${Math.round((race.standings[0]?.progress ?? 0) * 100)}%`}
              </span>
            </div>
            {race.standings.map((row, i) => (
              <div
                key={row.id}
                className={`flex items-baseline gap-1.5 py-0.5 text-[11px] ${
                  row.isMe ? "text-ink" : "text-ink2"
                }`}
              >
                <span className="tabular w-4 text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {row.name}
                  {row.isMe && (
                    <span className="ml-1 text-[9px] text-s1">you</span>
                  )}
                </span>
                {row.finished ? (
                  <span className="text-[10px] text-good">fin</span>
                ) : (
                  <span
                    className="tabular text-[10px] text-muted"
                    title="gap in laps"
                  >
                    {i === 0
                      ? "—"
                      : `-${(race.standings[0].progress - row.progress).toFixed(2)}`}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* lap board */}
          <div className="pointer-events-none absolute left-2 top-[4.5rem] rounded border border-grid bg-surface/85 px-2.5 py-1.5 text-[11px] backdrop-blur">
            <div className="tabular text-sm font-bold text-ink">
              {fmtLap(race.clock)}
            </div>
            <div className="tabular text-muted">
              last {fmtLap(race.lastLap)} · best{" "}
              <span className="text-s2">{fmtLap(race.bestLap)}</span>
            </div>
          </div>
        </>
      )}

      {/* finished */}
      <AnimatePresence>
        {finish && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute inset-x-0 bottom-24 grid place-items-center"
          >
            <div className="pointer-events-auto rounded border border-grid bg-surface/95 px-5 py-3 text-center backdrop-blur">
              <div className="text-xs uppercase tracking-wider text-muted">
                Finished
              </div>
              <div className="tabular text-2xl font-black text-s1">
                {fmtLap(finish.totalS)}
              </div>
              <div className="tabular text-xs text-muted">
                best lap {fmtLap(finish.bestLap)}
              </div>
              <div className="mt-2 flex justify-center gap-2">
                <button
                  onClick={() => {
                    setFinish(null);
                    roomRef.current?.rematch().catch(() => {});
                  }}
                  className="rounded bg-s1 px-3 py-1.5 text-xs font-bold text-white"
                >
                  Back to lobby
                </button>
                <button
                  onClick={() => setFinish(null)}
                  className="rounded border border-grid px-3 py-1.5 text-xs text-ink2 hover:text-ink"
                >
                  Keep driving
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* start prompt — the AudioContext needs the gesture anyway */}
      <AnimatePresence>
        {!s.running && !s.blown && mode === "solo" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 grid place-items-center bg-page/55 backdrop-blur-[2px]"
          >
            <div className="pointer-events-auto text-center">
              <button
                onClick={start}
                className="rounded bg-s1 px-5 py-2.5 text-sm font-bold text-white hover:brightness-110"
              >
                START ENGINE
              </button>
              <p className="mt-2 max-w-xs text-[11px] leading-relaxed text-muted">
                W / S to drive and brake, A / D to steer, Q and E for gears.
                Hold S at a standstill for reverse.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHelp && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute right-2 top-12 w-64 rounded border border-grid bg-surface/95 p-3 text-[11px] leading-relaxed text-ink2 backdrop-blur"
          >
            <div className="mb-1.5 text-xs font-bold text-ink">Controls</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {[
                ["W / ↑ / Space", "throttle"],
                ["S / ↓", "brake, then reverse"],
                ["A / D / ← →", "steer"],
                ["Q / E", "shift down / up"],
                ["1–6, 0", "select a gear, 0 = neutral"],
                ["R", "back to the grid"],
                ["C", "change camera"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="tabular text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-muted">
              It is the same engine as the dyno — your maps, your boost, your
              damage. Blow it up here and it is blown up there.
            </p>
            {borrowed && (
              <button
                onClick={() => onGotoEngine(car.engineId)}
                className="mt-2 rounded border border-grid px-2 py-1 text-[11px] hover:text-ink"
              >
                Fit the {car.name} engine too
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* gearbox strip — clickable, so it works without a keyboard */}
      <div className="pointer-events-none absolute inset-y-0 right-2 hidden items-center lg:flex">
        <div className="pointer-events-auto flex flex-col gap-1 rounded border border-grid bg-surface/85 p-1.5 backdrop-blur">
          {Array.from({ length: GEARBOX.ratios.length }, (_, i) => GEARBOX.ratios.length - 1 - i).map(
            (g) => (
              <button
                key={g}
                onClick={() => engine.setGear(g)}
                className={`tabular h-7 w-7 rounded text-xs font-bold transition-colors ${
                  s.gear === g ? "bg-s1 text-white" : "bg-raised text-muted hover:text-ink"
                }`}
              >
                {g + 1}
              </button>
            ),
          )}
          <button
            onClick={() => engine.setGear(-1)}
            className={`h-7 w-7 rounded text-xs font-bold transition-colors ${
              s.gear < 0 ? "bg-s1 text-white" : "bg-raised text-muted hover:text-ink"
            }`}
          >
            N
          </button>
        </div>
      </div>
    </div>
  );
}

/** m:ss.mmm, or a dash when there is nothing to show yet */
function fmtLap(t: number | null | undefined) {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return m > 0
    ? `${m}:${sec.toFixed(2).padStart(5, "0")}`
    : `${sec.toFixed(2)}`;
}

function Bar({ label, v, color }: { label: string; v: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 text-[9px] tracking-wider text-muted">{label}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded bg-grid">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(1, v) * 100}%` }} />
      </div>
    </div>
  );
}

/** thumb controls — steering on the left, pedals on the right */
function TouchPad({
  input,
  onShift,
}: {
  input: React.RefObject<RawInput>;
  onShift: (d: 1 | -1) => void;
}) {
  const hold = (set: (v: RawInput) => void, clear: (v: RawInput) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      set(input.current);
    },
    onPointerUp: () => clear(input.current),
    onPointerCancel: () => clear(input.current),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const btn =
    "flex h-12 w-12 select-none items-center justify-center rounded border border-grid bg-surface/85 text-sm font-bold text-ink2 backdrop-blur active:bg-s1/30 active:text-ink";

  return (
    <div className="flex items-end gap-1.5 lg:hidden">
      <div className="flex gap-1.5">
        <button className={btn} {...hold((i) => (i.steer = -1), (i) => (i.steer = 0))}>
          ◀
        </button>
        <button className={btn} {...hold((i) => (i.steer = 1), (i) => (i.steer = 0))}>
          ▶
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          <button className={`${btn} h-9 w-9 text-xs`} onClick={() => onShift(-1)}>
            ▼
          </button>
          <button className={`${btn} h-9 w-9 text-xs`} onClick={() => onShift(1)}>
            ▲
          </button>
        </div>
        <div className="flex gap-1.5">
          <button className={btn} {...hold((i) => (i.brake = 1), (i) => (i.brake = 0))}>
            BRK
          </button>
          <button className={btn} {...hold((i) => (i.throttle = 1), (i) => (i.throttle = 0))}>
            GO
          </button>
        </div>
      </div>
    </div>
  );
}
