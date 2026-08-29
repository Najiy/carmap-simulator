import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  friendlyDbError,
  MAX_PLAYERS,
  RaceRoom,
  type LobbyEntry,
  type RoomSnapshot,
} from "../multiplayer/room";
import { RACE_SCENES, SCENES, type SceneId } from "../game/world";
import { useGameStore } from "../store/gameStore";

/**
 * The Drive tab's front desk: host a track race, join one by code, or pick a
 * room out of the public browser.
 *
 * The room mechanics are the drag strip's — same codes, same invite links,
 * same password, same server-clock green light. Only the race at the end of
 * it differs, so `mode: "track"` keeps the two from being joined by mistake.
 */

/** track rooms get their own prefix so the link opens the Drive tab */
const inviteLink = (code: string) =>
  `${window.location.origin}${window.location.pathname}?join=track-${code}`;

export function LobbyBrowser({
  onHost,
  onJoin,
  busy,
  error,
}: {
  onHost: (opts: { pass: string; scene: SceneId; laps: number }) => void;
  onJoin: (code: string, pass: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [list, setList] = useState<LobbyEntry[]>([]);
  const [code, setCode] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [hostPass, setHostPass] = useState("");
  const [scene, setScene] = useState<SceneId>("circuit");
  const [laps, setLaps] = useState(3);

  useEffect(() => RaceRoom.watchLobby(setList, ["track"]), []);

  const raceScenes = SCENES.filter((s) => RACE_SCENES.includes(s.id));
  const isDash = scene === "mile";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wider">
          Multiplayer track race
        </h2>
        <p className="text-xs text-muted">
          Up to {MAX_PLAYERS} cars on one generated circuit. Everyone races the
          engine and the maps they are running right now.
        </p>
      </div>

      {error && (
        <div className="rounded border border-crit/50 bg-crit/10 px-3 py-2 text-xs text-serious">
          {error}
        </div>
      )}

      <div className="rounded border border-grid bg-surface p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink2">
          Host a race
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {raceScenes.map((sc) => (
            <button
              key={sc.id}
              onClick={() => setScene(sc.id)}
              className={`rounded border p-2.5 text-left transition-colors ${
                scene === sc.id
                  ? "border-s1 bg-s1/10"
                  : "border-grid bg-raised hover:border-axis"
              }`}
            >
              <div className="text-xs font-bold">
                {sc.id === "circuit" ? "🏁 " : "🛣️ "}
                {sc.name}
              </div>
              <div className="text-[11px] text-muted">{sc.blurb}</div>
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!isDash && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Laps
              <select
                value={laps}
                onChange={(e) => setLaps(Number(e.target.value))}
                className="rounded border border-grid bg-raised px-2 py-1 text-xs text-ink"
              >
                {[1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            value={hostPass}
            onChange={(e) => setHostPass(e.target.value)}
            placeholder="password (optional)"
            className="min-w-0 flex-1 rounded border border-grid bg-raised px-2 py-1 text-xs text-ink placeholder:text-muted"
          />
          <motion.button
            whileTap={{ scale: 0.97 }}
            disabled={busy}
            onClick={() => onHost({ pass: hostPass, scene, laps })}
            className="rounded bg-s1 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            Host
          </motion.button>
        </div>
      </div>

      <div className="rounded border border-grid bg-surface p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink2">
          Join by code
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={code}
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/DRAG-/, "")
                  .replace(/[^A-Z0-9]/g, "")
                  .slice(0, 5),
              )
            }
            placeholder="CODE"
            className="w-28 rounded border border-grid bg-raised px-2 py-1 font-mono text-sm tracking-[0.25em] text-ink placeholder:tracking-normal placeholder:text-muted"
          />
          <input
            value={joinPass}
            onChange={(e) => setJoinPass(e.target.value)}
            placeholder="password"
            className="min-w-0 flex-1 rounded border border-grid bg-raised px-2 py-1 text-xs text-ink placeholder:text-muted"
          />
          <button
            disabled={busy || code.length < 4}
            onClick={() => onJoin(code, joinPass)}
            className="rounded border border-grid px-4 py-1.5 text-xs font-bold text-ink2 hover:text-ink disabled:opacity-40"
          >
            Join
          </button>
        </div>
      </div>

      <div className="rounded border border-grid bg-surface p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink2">
          Open races
        </div>
        {list.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted">
            Nobody is hosting a track race right now — host one and share the
            link.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {list.map((e) => (
              <button
                key={e.code}
                disabled={busy}
                onClick={() => onJoin(e.code, "")}
                className="flex items-center gap-3 rounded border border-grid bg-raised px-2.5 py-2 text-left hover:border-s1/60 disabled:opacity-40"
              >
                <span className="font-mono text-sm font-bold tracking-[0.2em] text-s1">
                  {e.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="font-semibold">{e.hostName}</span>
                  <span className="text-muted"> · {e.engineName}</span>
                </span>
                <span className="tabular text-xs text-s2">{e.peakHp} whp</span>
                <span className="text-[11px] text-muted">
                  {e.players}/{MAX_PLAYERS}
                </span>
                {e.hasPass && <span className="text-[11px]">🔒</span>}
                {e.status === "racing" && (
                  <span className="rounded bg-warn/20 px-1.5 text-[10px] text-warn">
                    racing
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function LobbyRoom({
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
  const scene = (snap?.scene as SceneId) ?? "circuit";
  const sceneDef = SCENES.find((s) => s.id === scene);
  const isDash = scene === "mile";
  const [laps, setLaps] = useState(snap?.laps ?? 3);

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-col items-center gap-1 rounded border border-grid bg-surface p-4">
        <div className="mb-1 flex flex-wrap items-center justify-center gap-2">
          {room.isHost ? (
            SCENES.filter((s) => RACE_SCENES.includes(s.id)).map((sc) => (
              <button
                key={sc.id}
                onClick={() => room.setMode("track", sc.id).catch(() => {})}
                className={`rounded border px-3 py-1 text-xs font-bold ${
                  scene === sc.id
                    ? "border-s1 bg-s1/15 text-ink"
                    : "border-grid text-muted hover:text-ink2"
                }`}
              >
                {sc.id === "circuit" ? "🏁 " : "🛣️ "}
                {sc.name}
              </button>
            ))
          ) : (
            <span className="rounded bg-raised px-3 py-1 text-xs font-bold text-ink2">
              {sceneDef?.name}
            </span>
          )}
          {room.isHost && !isDash && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Laps
              <select
                value={laps}
                onChange={(e) => setLaps(Number(e.target.value))}
                className="rounded border border-grid bg-raised px-2 py-1 text-xs text-ink"
              >
                {[1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="text-[11px] text-muted">
          The layout is rolled at launch — nobody gets to learn it first.
        </div>

        <div className="mt-2 text-xs uppercase tracking-wider text-muted">
          Room code
        </div>
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
          {ids.length}/{MAX_PLAYERS} drivers in the room.
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
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                    }}
                    maxLength={20}
                    title="Click to rename yourself"
                    className="-mx-1 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-sm font-bold text-ink outline-none hover:border-grid focus:border-s1 focus:bg-raised"
                  />
                ) : (
                  <span className="truncate">{pl.name}</span>
                )}
                {id === room.myId && (
                  <span className="rounded bg-s1/20 px-1.5 text-[10px] text-s1">
                    you
                  </span>
                )}
                {id === snap?.hostId && (
                  <span className="rounded bg-raised px-1.5 text-[10px] text-muted">
                    host
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-ink2">{pl.engineName}</div>
              <div className="text-xs text-muted">
                <span className="font-semibold text-s2">{pl.peakHp} whp</span>
                {pl.wastegateKpa > 100 ? ` @ ${pl.wastegateKpa} kPa` : ""}
              </div>
              <div
                className={`mt-auto text-xs font-semibold ${
                  pl.ready ? "text-good" : "text-muted"
                }`}
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

      <div className="flex flex-wrap items-center justify-center gap-3">
        <motion.button
          whileTap={{ scale: 0.97 }}
          disabled={blown}
          onClick={() => room.setReady(!me?.ready)}
          className={`rounded px-5 py-2.5 text-sm font-bold disabled:opacity-40 ${
            me?.ready ? "border border-good text-good" : "bg-good text-white"
          }`}
        >
          {me?.ready ? "Un-ready" : "Ready ✓"}
        </motion.button>
        {room.isHost && (
          <motion.button
            whileTap={{ scale: 0.97 }}
            disabled={!allReady}
            onClick={() =>
              room.launch(5000, {
                circuitSeed: (Math.random() * 2 ** 31) | 0,
                laps: isDash ? 1 : laps,
                scene,
              })
            }
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
      <div className="text-center text-[11px] leading-relaxed text-muted">
        Swap engines and edit maps from the Tune tab while you wait — your card
        updates live, and changing anything un-readies you. The tune you race is
        the one you have at the green light.
      </div>
    </div>
  );
}

export { friendlyDbError };
