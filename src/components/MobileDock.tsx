import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { EngineSpec } from "../engine/engines";
import { useEngineSnapshot } from "../engine/store";
import Gauges from "./Gauges";
import Controls from "./Controls";
import StatusBar from "./StatusBar";

/**
 * Phone replacement for the desktop sidebar: an always-visible telemetry
 * strip docked to the bottom, expanding into a full drawer with the gauges,
 * controls and warnings.
 */
export default function MobileDock({ spec }: { spec: EngineSpec }) {
  const [open, setOpen] = useState(false);
  const s = useEngineSnapshot();

  const boostBar = (s.mapKpa - 100) / 100;
  const alert = s.knockNow || s.blown || (s.egt > 950 && s.running);

  return (
    <>
      {/* docked strip */}
      <button
        onClick={() => setOpen(true)}
        className={`flex shrink-0 items-center gap-3 border-t px-3 py-2 text-left ${
          alert ? "border-crit bg-crit/15" : "border-grid bg-surface"
        }`}
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            s.blown
              ? "bg-crit"
              : s.knockNow
                ? "animate-pulse bg-crit"
                : s.running
                  ? "bg-good"
                  : "bg-axis"
          }`}
        />
        <Mini label="rpm" value={s.rpm.toFixed(0)} />
        <Mini
          label="AFR"
          value={s.afr.toFixed(1)}
          tone={
            s.running && s.afr > s.afrTarget + 0.5 && s.mapKpa > 80
              ? "text-crit"
              : undefined
          }
        />
        {spec.turbo && <Mini label="boost" value={boostBar.toFixed(2)} />}
        <Mini
          label="hp"
          value={s.powerHp.toFixed(0)}
        />
        <Mini
          label="health"
          value={`${s.health.toFixed(0)}%`}
          tone={
            s.health < 35
              ? "text-crit"
              : s.health < 70
                ? "text-warn"
                : undefined
          }
        />
        {s.mode === "drive" && (
          <Mini label="gear" value={`${s.gear + 1}`} />
        )}
        <span className="ml-auto text-lg text-muted">⌃</span>
      </button>

      {/* drawer */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/60"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-xl border-t border-grid bg-surface"
            >
              <button
                onClick={() => setOpen(false)}
                className="flex shrink-0 items-center justify-center py-2"
              >
                <span className="h-1 w-10 rounded-full bg-axis" />
              </button>
              <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <Gauges spec={spec} />
                <Controls spec={spec} />
                <StatusBar />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className={`tabular text-sm font-semibold ${tone ?? "text-ink"}`}>
        {value}
      </span>
      <span className="text-[9px] uppercase tracking-wider text-muted">
        {label}
      </span>
    </span>
  );
}
