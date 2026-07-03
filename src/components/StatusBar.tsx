import { motion } from "framer-motion";
import { useEngineSnapshot } from "../engine/store";

type Tone = "good" | "info" | "warn" | "crit";

interface Lamp {
  id: string;
  label: string;
  desc: string;
  active: boolean;
  tone: Tone;
  value?: string;
}

const DOT: Record<Tone, string> = {
  good: "bg-good shadow-[0_0_8px_2px_rgba(12,163,12,0.45)]",
  info: "bg-s1 shadow-[0_0_8px_2px_rgba(57,135,229,0.45)]",
  warn: "bg-warn shadow-[0_0_8px_2px_rgba(250,178,25,0.45)]",
  crit: "bg-crit shadow-[0_0_8px_2px_rgba(208,59,59,0.55)] animate-pulse",
};

const TEXT: Record<Tone, string> = {
  good: "text-good",
  info: "text-s1",
  warn: "text-warn",
  crit: "text-crit",
};

const ROW_BG: Record<Tone, string> = {
  good: "bg-good/5",
  info: "bg-raised",
  warn: "bg-warn/5",
  crit: "bg-crit/10",
};

export default function StatusBar() {
  const s = useEngineSnapshot();

  const leanLoad = s.running && s.afr > 15.2 && s.mapKpa > 110;

  // the whole annunciator panel is always on display — only the lamps move
  const lamps: Lamp[] = [
    {
      id: "run",
      label: "ENGINE",
      desc: s.running ? "running" : "off",
      active: s.running,
      tone: "good",
    },
    {
      id: "knock",
      label: "KNOCK",
      desc: "retard timing / add fuel",
      active: s.knockNow,
      tone: "crit",
    },
    {
      id: "lean",
      label: "LEAN LOAD",
      desc: "add fuel now",
      active: leanLoad,
      tone: "crit",
    },
    {
      id: "egt",
      label: "EGT",
      desc: "exhaust overheat",
      active: s.egt > 950,
      tone: s.egt > 1000 ? "crit" : "warn",
      value: `${s.egt.toFixed(0)} °C`,
    },
    {
      id: "mis",
      label: "MISFIRE",
      desc: "mixture out of range",
      active: s.misfire,
      tone: "warn",
    },
    {
      id: "leanish",
      label: "LEAN",
      desc: "leaner than target",
      active: s.running && !leanLoad && s.afr > s.afrTarget + 0.5 && s.mapKpa > 80,
      tone: "warn",
    },
    {
      id: "duty",
      label: "INJ DUTY",
      desc: "injectors near limit",
      active: s.duty > 85,
      tone: "warn",
      value: `${s.duty.toFixed(0)}%`,
    },
    {
      id: "lim",
      label: "LIMITER",
      desc: "fuel cut",
      active: s.limiter,
      tone: "warn",
    },
    {
      id: "rich",
      label: "RICH",
      desc: "wasting fuel",
      active: s.running && s.afr < s.afrTarget - 0.8,
      tone: "info",
    },
  ];

  const healthTone =
    s.health > 70 ? "bg-good" : s.health > 35 ? "bg-warn" : "bg-crit";

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink2">Engine health</span>
        <div className="h-2 flex-1 overflow-hidden rounded bg-raised">
          <motion.div
            className={`h-full ${healthTone}`}
            animate={{ width: `${s.health}%` }}
            transition={{ type: "spring", stiffness: 80, damping: 20 }}
          />
        </div>
        <span className="tabular w-9 text-right font-semibold">
          {s.health.toFixed(0)}%
        </span>
      </div>

      {s.blown && (
        <div className="flex items-center gap-2 rounded bg-crit/15 px-2 py-1 text-xs font-semibold text-crit">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-crit shadow-[0_0_8px_2px_rgba(208,59,59,0.55)]" />
          DESTROYED — {s.blowCause}
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        {lamps.map((l) => (
          <div
            key={l.id}
            className={`flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors duration-200 ${
              l.active ? ROW_BG[l.tone] : ""
            }`}
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full transition-all duration-200 ${
                l.active ? DOT[l.tone] : "bg-axis"
              }`}
            />
            <span
              className={`w-16 shrink-0 font-bold tracking-wide transition-colors duration-200 ${
                l.active ? TEXT[l.tone] : "text-muted"
              }`}
            >
              {l.label}
            </span>
            <span
              className={`truncate transition-colors duration-200 ${
                l.active ? "text-ink2" : "text-muted/60"
              }`}
            >
              {l.desc}
            </span>
            {l.value && (
              <span
                className={`tabular ml-auto shrink-0 font-semibold transition-colors duration-200 ${
                  l.active ? TEXT[l.tone] : "text-muted"
                }`}
              >
                {l.value}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
