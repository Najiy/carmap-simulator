import { motion } from "framer-motion";
import { clamp } from "../engine/axes";
import type { EngineSpec } from "../engine/engines";
import { useEngineSnapshot } from "../engine/store";

/** 240° sweep radial gauge, needle spring-animated by framer-motion. */
function RadialGauge({
  label,
  unit,
  value,
  min,
  max,
  size = 132,
  format,
  warnFrom,
  critFrom,
  goodBand,
  ticks = 5,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  size?: number;
  format: (v: number) => string;
  warnFrom?: number;
  critFrom?: number;
  goodBand?: [number, number];
  ticks?: number;
}) {
  const START = -210; // degrees; 0° = 3 o'clock, sweep to +30
  const SWEEP = 240;
  const angleOf = (v: number) =>
    START + (clamp(v, min, max) - min) / (max - min) * SWEEP;
  const R = 44;
  const cx = 50;
  const cy = 54;
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (from: number, to: number, r: number) => {
    const [x0, y0] = pt(from, r);
    const [x1, y1] = pt(to, r);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.92} viewBox="0 0 100 92">
        <path
          d={arc(START, START + SWEEP, R)}
          fill="none"
          stroke="#2c2c2a"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {goodBand && (
          <path
            d={arc(angleOf(goodBand[0]), angleOf(goodBand[1]), R)}
            fill="none"
            stroke="#0ca30c"
            strokeWidth="6"
            strokeLinecap="butt"
            opacity="0.55"
          />
        )}
        {warnFrom !== undefined && (
          <path
            d={arc(angleOf(warnFrom), angleOf(critFrom ?? max), R)}
            fill="none"
            stroke="#fab219"
            strokeWidth="6"
            strokeLinecap="butt"
            opacity="0.8"
          />
        )}
        {critFrom !== undefined && (
          <path
            d={arc(angleOf(critFrom), START + SWEEP, R)}
            fill="none"
            stroke="#d03b3b"
            strokeWidth="6"
            strokeLinecap="butt"
          />
        )}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = min + ((max - min) * i) / ticks;
          const a = angleOf(v);
          const [x0, y0] = pt(a, R - 7);
          const [x1, y1] = pt(a, R - 2);
          const [tx, ty] = pt(a, R - 14);
          return (
            <g key={i}>
              <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#898781" strokeWidth="1.4" />
              <text
                x={tx}
                y={ty + 2}
                textAnchor="middle"
                fontSize="6.5"
                fill="#898781"
              >
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        {/* plain SVG rotate — framer's rotate on SVG <g> picks the wrong
            origin, and the sim already updates the value every frame */}
        <g transform={`rotate(${angleOf(value)} ${cx} ${cy})`}>
          <line
            x1={cx}
            y1={cy}
            x2={cx + R - 8}
            y2={cy}
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
        <circle cx={cx} cy={cy} r="3.5" fill="#383835" stroke="#898781" strokeWidth="1" />
      </svg>
      <div className="tabular -mt-3 text-sm font-semibold">{format(value)}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label} <span className="normal-case">({unit})</span>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded border border-grid bg-raised px-2 py-1.5">
      <div className={`tabular text-sm font-semibold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
    </div>
  );
}

export default function Gauges({ spec }: { spec: EngineSpec }) {
  const s = useEngineSnapshot();
  const boostBar = (s.mapKpa - 100) / 100; // bar gauge pressure
  const tachMax = Math.ceil(spec.revLimit / 1000);

  return (
    <div className="border-b border-grid p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink2">
          Telemetry
        </span>
        {/* knock lamp */}
        <motion.span
          animate={
            s.knockNow
              ? { opacity: [1, 0.3, 1], transition: { duration: 0.25, repeat: Infinity } }
              : { opacity: 1 }
          }
          className={`rounded px-2 py-0.5 text-[10px] font-bold ${
            s.knockNow
              ? "bg-crit text-white"
              : "bg-raised text-muted"
          }`}
        >
          KNOCK {s.knockCount > 0 ? s.knockCount : ""}
        </motion.span>
      </div>

      <div className="flex justify-between">
        <RadialGauge
          label="Engine"
          unit="rpm ×1000"
          value={s.rpm / 1000}
          min={0}
          max={tachMax}
          ticks={tachMax}
          warnFrom={spec.redline / 1000}
          critFrom={spec.revLimit / 1000}
          format={(v) => `${Math.round(v * 1000)}`}
        />
        <RadialGauge
          label="Wideband"
          unit="AFR"
          value={s.afr}
          min={10}
          max={18}
          ticks={4}
          goodBand={[Math.max(10, s.afrTarget - 0.4), Math.min(18, s.afrTarget + 0.4)]}
          warnFrom={15.2}
          critFrom={16.2}
          format={(v) => v.toFixed(1)}
        />
      </div>
      <div className="flex items-center justify-between">
        <RadialGauge
          label="Boost"
          unit="bar"
          value={boostBar}
          min={-1}
          max={1.2}
          size={112}
          ticks={4}
          warnFrom={0.9}
          critFrom={1.05}
          format={(v) => v.toFixed(2)}
        />
        <div className="grid flex-1 grid-cols-2 gap-1.5 pl-2">
          <Tile label="Torque Nm" value={s.torque.toFixed(0)} />
          <Tile label="Power hp" value={s.powerHp.toFixed(0)} />
          <Tile
            label="EGT °C"
            value={s.egt.toFixed(0)}
            tone={s.egt > 1000 ? "text-crit" : s.egt > 950 ? "text-warn" : "text-ink"}
          />
          <Tile
            label="Inj duty %"
            value={s.duty.toFixed(0)}
            tone={s.duty > 92 ? "text-crit" : s.duty > 85 ? "text-warn" : "text-ink"}
          />
          <Tile label="Spark °BTDC" value={s.spark.toFixed(1)} />
          <Tile label="MAP kPa" value={s.mapKpa.toFixed(0)} />
          <Tile
            label="Gear"
            value={
              s.mode === "drive"
                ? `${s.gear < 0 ? "N" : s.gear + 1}${s.shifting ? "…" : ""}`
                : "—"
            }
          />
          <Tile
            label="Speed km/h"
            value={s.mode === "drive" ? s.speedKph.toFixed(0) : "—"}
          />
        </div>
      </div>
    </div>
  );
}
