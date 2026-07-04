import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { PULL_MS, type DynoRun } from "../engine/dyno";

const W = 760;
const H = 330;
const AFR_H = 110;
const M = { l: 46, r: 14, t: 12, b: 6 };
const X0 = 1500;

/** the reveal tracks the live telemetry playback — same clock, same sweep */
const DRAW_S = PULL_MS / 1000;

const COL_TQ = "#3987e5";
const COL_HP = "#199e70";
const COL_AFR = "#c98500";

export default function DynoChart({
  runs,
  current,
  maxRpm,
  animate = true,
  pinnedIds = [],
}: {
  runs: DynoRun[];
  current: DynoRun | null;
  maxRpm: number;
  /** replay the left-to-right sweep (fresh pull); false when just browsing */
  animate?: boolean;
  /** ghost runs the user pinned — drawn brighter with a 📌 marker */
  pinnedIds?: number[];
}) {
  const [hoverI, setHoverI] = useState<number | null>(null);
  const X1 = Math.ceil((maxRpm + 200) / 500) * 500;

  const yMax = useMemo(() => {
    const all = [...runs, ...(current ? [current] : [])];
    const m = Math.max(120, ...all.flatMap((r) => r.points.map((p) => Math.max(p.torque, p.hp))));
    return Math.ceil((m * 1.08) / 50) * 50;
  }, [runs, current]);

  const x = (rpm: number) => M.l + ((rpm - X0) / (X1 - X0)) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - v / yMax) * (H - M.t - M.b - 20);
  const yAfr = (v: number) => {
    const lo = 10;
    const hi = 17;
    return 8 + (1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (AFR_H - 24);
  };

  const path = (pts: { rpm: number }[], val: (p: any) => number, yFn: (v: number) => number) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.rpm).toFixed(1)},${yFn(val(p)).toFixed(1)}`).join(" ");

  const hover =
    current && hoverI !== null ? current.points[Math.min(hoverI, current.points.length - 1)] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!current) return;
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const rpm = X0 + ((px - M.l) / (W - M.l - M.r)) * (X1 - X0);
    const pts = current.points;
    const step = (pts[pts.length - 1].rpm - pts[0].rpm) / (pts.length - 1);
    const i = Math.round((rpm - pts[0].rpm) / step);
    setHoverI(Math.max(0, Math.min(i, pts.length - 1)));
  };

  const gridRpms = Array.from(
    { length: Math.floor(X1 / 1000) - 1 },
    (_, i) => (i + 2) * 1000,
  );
  const gridVals = Array.from({ length: yMax / 50 }, (_, i) => (i + 1) * 50).filter(
    (v) => v % (yMax > 400 ? 100 : 50) === 0,
  );

  return (
    <div className="relative">
      {/* legend */}
      <div className="mb-1 flex items-center gap-4 px-1 text-xs text-ink2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: COL_TQ }} />
          Torque (Nm)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: COL_HP }} />
          Power (hp)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-crit" />
          Knock
        </span>
        <span className="ml-auto text-muted">wheel figures · previous runs ghosted</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H + AFR_H}`}
        className="w-full rounded border border-grid bg-surface"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverI(null)}
      >
        {/* grid */}
        {gridRpms.map((r) => (
          <line key={r} x1={x(r)} y1={M.t} x2={x(r)} y2={H + AFR_H - 16} stroke="#2c2c2a" strokeWidth="1" />
        ))}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={M.l} y1={y(v)} x2={W - M.r} y2={y(v)} stroke="#2c2c2a" strokeWidth="1" />
            <text x={M.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#898781" className="tabular">
              {v}
            </text>
          </g>
        ))}
        {gridRpms.map((r) => (
          <text key={r} x={x(r)} y={H + AFR_H - 4} textAnchor="middle" fontSize="10" fill="#898781">
            {r}
          </text>
        ))}
        <text x={M.l - 34} y={M.t + 10} fontSize="9" fill="#898781">
          Nm/hp
        </text>

        {/* ghost runs — pinned ones brighter, with a 📌 at their power peak */}
        {runs.map((run) => {
          const isPinned = pinnedIds.includes(run.id);
          return (
            <g key={run.id} opacity={isPinned ? 0.6 : 0.28}>
              <path
                d={path(run.points, (p) => p.torque, y)}
                fill="none"
                stroke={COL_TQ}
                strokeWidth="1.5"
                strokeDasharray={isPinned ? undefined : "5 4"}
              />
              <path
                d={path(run.points, (p) => p.hp, y)}
                fill="none"
                stroke={COL_HP}
                strokeWidth="1.5"
                strokeDasharray={isPinned ? undefined : "5 4"}
              />
              {isPinned && (
                <text
                  x={x(run.peakHp.rpm)}
                  y={y(run.peakHp.v) - 6}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#c98500"
                  className="tabular"
                >
                  📌 {run.peakHp.v.toFixed(0)}
                </text>
              )}
            </g>
          );
        })}

        {/* current run — revealed left-to-right in sync with the pull */}
        {current &&
          (() => {
            const pts = current.points;
            const xStart = x(pts[0].rpm);
            const xEnd = x(pts[pts.length - 1].rpm);
            const frac = (rpm: number) =>
              (rpm - pts[0].rpm) / Math.max(1, pts[pts.length - 1].rpm - pts[0].rpm);
            return (
              <g key={current.id}>
                <defs>
                  <clipPath id={`sweep-${current.id}`}>
                    <motion.rect
                      x={xStart - 3}
                      y={0}
                      height={H + AFR_H}
                      initial={{ width: animate ? 0 : xEnd - xStart + 6 }}
                      animate={{ width: xEnd - xStart + 6 }}
                      transition={{ duration: animate ? DRAW_S : 0, ease: "linear" }}
                    />
                  </clipPath>
                </defs>
                <g clipPath={`url(#sweep-${current.id})`}>
                  <path
                    d={path(current.points, (p) => p.torque, y)}
                    fill="none"
                    stroke={COL_TQ}
                    strokeWidth="2"
                  />
                  <path
                    d={path(current.points, (p) => p.hp, y)}
                    fill="none"
                    stroke={COL_HP}
                    strokeWidth="2"
                  />
                  {current.points
                    .filter((p) => p.knock)
                    .map((p) => (
                      <circle
                        key={p.rpm}
                        cx={x(p.rpm)}
                        cy={y(p.torque)}
                        r="3.5"
                        fill="#d03b3b"
                        stroke="#1a1a19"
                        strokeWidth="1.5"
                      />
                    ))}
                </g>
                {/* roller sweep cursor */}
                {animate && (
                  <motion.line
                    y1={M.t}
                    y2={H + AFR_H - 16}
                    stroke="#c3c2b7"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    initial={{ x1: xStart, x2: xStart, opacity: 0.7 }}
                    animate={{ x1: xEnd, x2: xEnd, opacity: 0 }}
                    transition={{
                      duration: DRAW_S,
                      ease: "linear",
                      opacity: { delay: DRAW_S, duration: 0.3 },
                    }}
                  />
                )}
                {/* peak labels appear as the sweep passes them */}
                <motion.text
                  x={x(current.peakTq.rpm)}
                  y={y(current.peakTq.v) - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#c3c2b7"
                  className="tabular"
                  initial={{ opacity: animate ? 0 : 1 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: animate ? DRAW_S * frac(current.peakTq.rpm) + 0.15 : 0 }}
                >
                  {current.peakTq.v.toFixed(0)} Nm
                </motion.text>
                <motion.text
                  x={x(current.peakHp.rpm)}
                  y={y(current.peakHp.v) - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#c3c2b7"
                  className="tabular"
                  initial={{ opacity: animate ? 0 : 1 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: animate ? DRAW_S * frac(current.peakHp.rpm) + 0.15 : 0 }}
                >
                  {current.peakHp.v.toFixed(0)} hp
                </motion.text>
              </g>
            );
          })()}

        {/* AFR strip (own scale — avoids a dual axis on the main plot) */}
        <g transform={`translate(0 ${H})`}>
          <line x1={M.l} y1={0} x2={W - M.r} y2={0} stroke="#383835" strokeWidth="1" />
          <text x={M.l - 6} y={yAfr(12) + 3} textAnchor="end" fontSize="9" fill="#898781" className="tabular">
            12
          </text>
          <text x={M.l - 6} y={yAfr(15) + 3} textAnchor="end" fontSize="9" fill="#898781" className="tabular">
            15
          </text>
          <line x1={M.l} y1={yAfr(12)} x2={W - M.r} y2={yAfr(12)} stroke="#2c2c2a" />
          <line x1={M.l} y1={yAfr(15)} x2={W - M.r} y2={yAfr(15)} stroke="#2c2c2a" />
          <text x={M.l - 34} y={12} fontSize="9" fill="#898781">
            AFR
          </text>
          {current && (
            <g clipPath={`url(#sweep-${current.id})`}>
              <path
                d={path(current.points, (p) => p.afrTarget, yAfr)}
                fill="none"
                stroke="#898781"
                strokeWidth="1.2"
                strokeDasharray="4 3"
              />
              <path
                d={path(current.points, (p) => p.afr, yAfr)}
                fill="none"
                stroke={COL_AFR}
                strokeWidth="2"
              />
            </g>
          )}
        </g>

        {/* crosshair + tooltip */}
        {hover && (
          <g pointerEvents="none">
            <line x1={x(hover.rpm)} y1={M.t} x2={x(hover.rpm)} y2={H + AFR_H - 16} stroke="#898781" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover.rpm)} cy={y(hover.torque)} r="3" fill={COL_TQ} />
            <circle cx={x(hover.rpm)} cy={y(hover.hp)} r="3" fill={COL_HP} />
            <circle cx={x(hover.rpm)} cy={H + yAfr(hover.afr)} r="3" fill={COL_AFR} />
            {(() => {
              const bx = Math.min(x(hover.rpm) + 10, W - 170);
              return (
                <g transform={`translate(${bx} ${M.t + 6})`}>
                  <rect width="160" height="96" rx="4" fill="#222220" stroke="#383835" />
                  <text x="8" y="16" fontSize="11" fill="#ffffff" fontWeight="600" className="tabular">
                    {hover.rpm} rpm · {hover.mapKpa.toFixed(0)} kPa
                  </text>
                  <text x="8" y="32" fontSize="10" fill={COL_TQ} className="tabular">
                    Torque {hover.torque.toFixed(0)} Nm
                  </text>
                  <text x="8" y="46" fontSize="10" fill={COL_HP} className="tabular">
                    Power {hover.hp.toFixed(0)} hp
                  </text>
                  <text x="8" y="60" fontSize="10" fill={COL_AFR} className="tabular">
                    AFR {hover.afr.toFixed(1)} (target {hover.afrTarget.toFixed(1)})
                  </text>
                  <text x="8" y="74" fontSize="10" fill="#c3c2b7" className="tabular">
                    Spark {hover.spark.toFixed(1)}° · duty {hover.duty.toFixed(0)}%
                  </text>
                  <text x="8" y="88" fontSize="10" fill={hover.knock ? "#d03b3b" : "#898781"}>
                    {hover.knock ? `KNOCK +${hover.knockSeverity.toFixed(1)}°` : "no knock"}
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}
