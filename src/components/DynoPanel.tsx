import { useState } from "react";
import { motion } from "framer-motion";
import type { Axes } from "../engine/axes";
import type { EngineSpec } from "../engine/engines";
import { DRIVELINE, PULL_MS, runDyno, type DynoRun } from "../engine/dyno";
import { engine } from "../engine/store";
import type { Maps } from "../engine/defaults";
import { useGameStore } from "../store/gameStore";
import DynoChart from "./DynoChart";

export default function DynoPanel({
  spec,
  axes,
  maps,
}: {
  spec: EngineSpec;
  axes: Axes;
  maps: Maps;
}) {
  // dyno history lives in the persisted store, scoped per engine, so runs
  // survive refreshes and don't leak between engines
  const slot = useGameStore((s) => s.dyno[spec.id]);
  const recents = slot?.recents ?? [];
  const pinned = slot?.pinned ?? [];
  const takeDynoId = useGameStore((s) => s.takeDynoId);
  const addDynoRun = useGameStore((s) => s.addDynoRun);
  const toggleDynoPin = useGameStore((s) => s.toggleDynoPin);
  const clearDyno = useGameStore((s) => s.clearDyno);

  // only a fresh pull replays the animated sweep; a reload/browse is instant
  const [animateId, setAnimateId] = useState<number | null>(null);
  const [pulling, setPulling] = useState(false);

  const snap = engine.getSnapshot();

  // the newest run is the focused graph (full colour + stats + animation)
  const current = recents[0] ?? null;
  const pinnedIds = pinned.map((p) => p.id);
  const isPinned = (id: number) => pinnedIds.includes(id);

  // everything else on the chart, deduped, drawn as ghosts behind the focus
  const ghostMap = new Map<number, DynoRun>();
  for (const r of recents.slice(1)) ghostMap.set(r.id, r);
  for (const r of pinned) if (r.id !== current?.id) ghostMap.set(r.id, r);
  const ghostRuns = [...ghostMap.values()];

  // the chip strip: recents ∪ pinned, newest first
  const chipMap = new Map<number, DynoRun>();
  for (const r of recents) chipMap.set(r.id, r);
  for (const r of pinned) if (!chipMap.has(r.id)) chipMap.set(r.id, r);
  const chips = [...chipMap.values()].sort((a, b) => b.id - a.id);

  const doPull = () => {
    if (pulling || snap.blown) return;
    setPulling(true);
    const run = runDyno(spec, axes, maps, snap.wastegateKpa, takeDynoId());
    // replay it "for real": the gauges sweep the pull, and knock, damage and
    // AFR log samples land exactly when the rollers pass them
    engine.playDynoPull(run);
    addDynoRun(spec.id, run);
    setAnimateId(run.id);
    setTimeout(() => setPulling(false), PULL_MS + 200);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={doPull}
          disabled={pulling || snap.blown}
          className="rounded bg-s1 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pulling ? "Pulling…" : snap.blown ? "Engine blown" : "▶ WOT dyno pull"}
        </motion.button>
        <div className="text-xs text-muted">
          Full-throttle sweep 1600–{Math.min(spec.redline + 100, spec.revLimit)}{" "}
          rpm
          {spec.turbo
            ? ` at wastegate pressure (${snap.wastegateKpa.toFixed(0)} kPa ≈ ${((snap.wastegateKpa - 100) / 100).toFixed(1)} bar)`
            : " (naturally aspirated)"}
          . Knock and lean mixtures during a pull damage the engine — check
          the AFR strip and red knock dots, fix the maps, pull again.
        </div>
        {(recents.length > 0 || pinned.length > 0) && (
          <button
            onClick={() => clearDyno(spec.id)}
            className="ml-auto rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
          >
            Clear all
          </button>
        )}
      </div>

      {/* runs strip — last 3 roll automatically; 📌 keeps up to 3 more */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Runs
          </span>
          {chips.map((r) => {
            const focus = r.id === current?.id;
            const kept = isPinned(r.id);
            return (
              <div
                key={r.id}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
                  focus
                    ? "border-s1 bg-s1/15 text-ink"
                    : kept
                      ? "border-s3/50 bg-s3/5 text-ink2"
                      : "border-grid text-ink2"
                }`}
              >
                <span className="font-semibold">Run {r.id}</span>
                <span className="tabular text-muted">{r.peakHp.v.toFixed(0)} whp</span>
                {r.knockEvents > 0 && <span className="text-crit">⚠</span>}
                {focus && (
                  <span className="rounded bg-s1/25 px-1 text-[9px] font-bold text-s1">
                    LIVE
                  </span>
                )}
                <button
                  onClick={() => toggleDynoPin(spec.id, r)}
                  disabled={!kept && pinned.length >= 3}
                  title={
                    kept
                      ? "Unpin — let it roll off"
                      : pinned.length >= 3
                        ? "3 pinned already — unpin one first"
                        : "Pin to keep it on the chart"
                  }
                  className={`ml-0.5 rounded px-1 transition-opacity ${
                    kept ? "opacity-100" : "opacity-40 hover:opacity-80"
                  } disabled:opacity-15`}
                >
                  📌
                </button>
              </div>
            );
          })}
          <span className="text-[10px] text-muted">
            {recents.length} recent · {pinned.length}/3 pinned
          </span>
        </div>
      )}

      {current ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
            <Stat
              label="Peak power (wheel)"
              value={`${current.peakHp.v.toFixed(0)} whp`}
              sub={`@ ${current.peakHp.rpm} rpm · ≈${(current.peakHp.v / DRIVELINE).toFixed(0)} hp crank`}
              tone={
                current.peakHp.v >= spec.stock.hp * DRIVELINE * 1.02
                  ? "text-good"
                  : "text-ink"
              }
            />
            <Stat
              label="Peak torque (wheel)"
              value={`${current.peakTq.v.toFixed(0)} Nm`}
              sub={`@ ${current.peakTq.rpm} rpm · ≈${(current.peakTq.v / DRIVELINE).toFixed(0)} Nm crank`}
            />
            <Stat
              label="Factory rating"
              value={`${(spec.stock.hp * DRIVELINE).toFixed(0)} whp`}
              sub={`${spec.stock.hp} hp crank · rollers read ~${Math.round((1 - DRIVELINE) * 100)}% less`}
            />
            <Stat
              label="Knock events"
              value={`${current.knockEvents}`}
              sub={current.knockEvents ? `−${current.damage.toFixed(1)} health` : "clean pull"}
              tone={current.knockEvents ? "text-crit" : "text-good"}
            />
            <Stat
              label="AFR at load"
              value={`${current.minAfr.toFixed(1)}–${current.maxAfr.toFixed(1)}`}
              sub="min–max above 95 kPa"
              tone={current.maxAfr > 13.5 ? "text-warn" : "text-ink"}
            />
            <Stat
              label="Max inj duty"
              value={`${current.maxDuty.toFixed(0)}%`}
              sub={current.maxDuty > 85 ? "injectors near limit" : "headroom OK"}
              tone={current.maxDuty > 85 ? "text-warn" : "text-ink"}
            />
          </div>
          <DynoChart
            runs={ghostRuns}
            current={current}
            maxRpm={Math.min(spec.redline + 100, spec.revLimit)}
            animate={animateId != null && animateId === current.id}
            pinnedIds={pinnedIds}
          />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded border border-dashed border-grid text-sm text-muted">
          No runs yet — strap it to the rollers and make a pull.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
}) {
  return (
    <div className="rounded border border-grid bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`tabular text-lg font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] text-muted">{sub}</div>
    </div>
  );
}
