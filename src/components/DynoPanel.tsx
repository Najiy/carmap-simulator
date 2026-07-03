import { useRef, useState } from "react";
import { motion } from "framer-motion";
import type { Axes } from "../engine/axes";
import type { EngineSpec } from "../engine/engines";
import { DRIVELINE, PULL_MS, runDyno, type DynoRun } from "../engine/dyno";
import { engine } from "../engine/store";
import type { Maps } from "../engine/defaults";
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
  const [runs, setRuns] = useState<DynoRun[]>([]);
  const [current, setCurrent] = useState<DynoRun | null>(null);
  const [pulling, setPulling] = useState(false);
  const nextId = useRef(1);

  const snap = engine.getSnapshot();

  const doPull = () => {
    if (pulling || snap.blown) return;
    setPulling(true);
    const run = runDyno(spec, axes, maps, snap.wastegateKpa, nextId.current++);
    // replay it "for real": the gauges sweep the pull, and knock, damage and
    // AFR log samples land exactly when the rollers pass them
    engine.playDynoPull(run);
    setRuns((rs) => (current ? [...rs.slice(-2), current] : rs));
    setCurrent(run);
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
        {runs.length > 0 && (
          <button
            onClick={() => setRuns([])}
            className="ml-auto rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
          >
            Clear ghosts
          </button>
        )}
      </div>

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
            runs={runs}
            current={current}
            maxRpm={Math.min(spec.redline + 100, spec.revLimit)}
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
