import { useEffect } from "react";
import { motion } from "framer-motion";
import type { EngineSpec } from "../engine/engines";
import { GEARBOX } from "../engine/engines";
import { engine, useEngineSnapshot } from "../engine/store";
import { engineSound } from "../engine/sound";
import { useTuneStore } from "../store/tuneStore";

export default function Controls({ spec }: { spec: EngineSpec }) {
  const s = useEngineSnapshot();
  const muted = useTuneStore((st) => st.muted);
  const setMuted = useTuneStore((st) => st.setMuted);

  // apply the persisted setting to the audio engine
  useEffect(() => {
    engineSound.setMuted(muted);
  }, [muted]);

  // global keys: W or Space = wide-open throttle, E/Q = shift gears,
  // digits = direct gear selection (0 = neutral)
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) =>
      (e.target as HTMLElement)?.closest("input,textarea,[tabindex]") !== null;
    const down = (e: KeyboardEvent) => {
      if (e.repeat || isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === "w" || e.code === "Space") {
        e.preventDefault(); // Space would otherwise scroll / toggle controls
        engine.setThrottle(1);
      } else if (k === "e") engine.shift(1);
      else if (k === "q") engine.shift(-1);
      else if (/^[0-9]$/.test(k)) engine.setGear(Number(k) - 1);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "w" || e.code === "Space")
        engine.setThrottle(0);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  return (
    <div className="flex flex-col gap-3 border-b border-grid p-3">
      <div className="flex items-center gap-2">
        <span className="mr-auto text-xs font-semibold uppercase tracking-wider text-ink2">
          Controls
        </span>
        <button
          onClick={() => setMuted(!muted)}
          className="rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
          title="Toggle engine sound"
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => engine.setIgnition(!s.running)}
          disabled={s.blown}
          className={`rounded px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-40 ${
            s.running
              ? "bg-good/20 text-good ring-1 ring-good"
              : "bg-raised text-ink2 ring-1 ring-grid hover:text-ink"
          }`}
        >
          {s.running ? "IGNITION ON" : "START ENGINE"}
        </motion.button>
      </div>

      {/* mode switch */}
      <div className="flex overflow-hidden rounded border border-grid text-xs">
        {(["dyno", "drive"] as const).map((m) => (
          <button
            key={m}
            onClick={() => engine.setMode(m)}
            className={`flex-1 px-2 py-1.5 font-semibold uppercase tracking-wider transition-colors ${
              s.mode === m ? "bg-s1/20 text-s1" : "bg-raised text-muted hover:text-ink2"
            }`}
          >
            {m === "dyno" ? "Dyno cell" : "Drive"}
          </button>
        ))}
      </div>

      <Slider
        label="Throttle"
        value={s.throttle * 100}
        suffix="%"
        min={0}
        max={100}
        step={1}
        onChange={(v) => engine.setThrottle(v / 100)}
        hint="hold W or Space for wide-open"
      />

      {s.mode === "drive" ? (
        <>
          {/* gear selector */}
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-ink2">Gearbox</span>
              <span className="text-[10px] text-muted">
                click a gear · keys 1–6, 0 = N · Q/E
              </span>
            </div>
            <div className="flex items-center gap-1">
              <ShiftBtn onClick={() => engine.shift(-1)}>▼</ShiftBtn>
              <div className="flex flex-1 gap-1">
                <motion.button
                  onClick={() => engine.setGear(-1)}
                  animate={{
                    backgroundColor: s.gear === -1 ? "#c98500" : "#222220",
                    scale: s.gear === -1 && s.shifting ? 1.12 : 1,
                  }}
                  whileTap={{ scale: 0.92 }}
                  className="tabular flex h-8 flex-1 items-center justify-center rounded text-sm font-bold"
                  title="Neutral — nothing drives the wheels"
                >
                  N
                </motion.button>
                {GEARBOX.ratios.map((_, i) => (
                  <motion.button
                    key={i}
                    onClick={() => engine.setGear(i)}
                    animate={{
                      backgroundColor: s.gear === i ? "#3987e5" : "#222220",
                      scale: s.gear === i && s.shifting ? 1.12 : 1,
                    }}
                    whileTap={{ scale: 0.92 }}
                    className="tabular flex h-8 flex-1 items-center justify-center rounded text-sm font-bold"
                    title={`Select gear ${i + 1} (key ${i + 1})`}
                  >
                    {i + 1}
                  </motion.button>
                ))}
              </div>
              <ShiftBtn onClick={() => engine.shift(1)}>▲</ShiftBtn>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted">
              Grab any gear directly — but a low gear at speed spins the
              engine past redline. That's the money shift.
            </p>
          </div>
          <Slider
            label="Brakes"
            value={s.brake * 100}
            suffix="%"
            min={0}
            max={100}
            step={1}
            onChange={(v) => engine.setBrake(v / 100)}
          />
        </>
      ) : (
        <Slider
          label="Dyno brake"
          value={s.brake * 100}
          suffix="%"
          min={0}
          max={100}
          step={1}
          onChange={(v) => engine.setBrake(v / 100)}
          hint="load on the engine"
        />
      )}

      {spec.turbo ? (
        <Slider
          label="Wastegate"
          value={s.wastegateKpa}
          suffix=" kPa"
          min={100}
          max={spec.turbo.maxKpa}
          step={5}
          onChange={(v) => engine.setWastegate(v)}
          hint={`${((s.wastegateKpa - 100) / 100).toFixed(2)} bar peak boost`}
        />
      ) : (
        <p className="rounded bg-raised/50 px-2 py-1 text-[10px] text-muted">
          Naturally aspirated — no boost control. All the power is in cams,
          mixture and timing.
        </p>
      )}

      {s.mode === "dyno" && (
        <>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink2">
              <input
                type="checkbox"
                checked={s.holdRpm}
                onChange={(e) => engine.setHold(e.target.checked)}
                className="accent-[#3987e5]"
              />
              Hold RPM (steady-state)
            </label>
            {s.holdRpm && (
              <input
                type="range"
                min={1000}
                max={spec.redline}
                step={100}
                value={s.holdTarget}
                onChange={(e) => engine.setHold(true, Number(e.target.value))}
                className="flex-1"
              />
            )}
            {s.holdRpm && (
              <span className="tabular w-12 text-right text-xs text-ink">
                {s.holdTarget}
              </span>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-muted">
            Steady-state mode pins the revs like a load-bearing dyno — set an
            RPM and a throttle, watch which cell lights up, and tune it live.
          </p>
        </>
      )}
    </div>
  );
}

function ShiftBtn({
  children,
  onClick,
}: {
  children: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      className="h-8 w-8 rounded border border-grid bg-raised text-sm text-ink2 hover:text-ink"
    >
      {children}
    </motion.button>
  );
}

function Slider({
  label,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between text-xs">
        <span className="text-ink2">{label}</span>
        <span className="tabular font-semibold text-ink">
          {Math.round(value)}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <div className="-mt-1 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}
