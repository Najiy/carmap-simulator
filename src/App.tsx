import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { buildAxes, clamp, cloneGrid } from "./engine/axes";
import { ENGINES, getEngine } from "./engine/engines";
import { baseMaps, type Maps } from "./engine/defaults";
import { engine } from "./engine/store";
import { useTuneStore, validMaps } from "./store/tuneStore";
import PresetMenu from "./components/PresetMenu";
import MapEditor from "./components/MapEditor";
import Gauges from "./components/Gauges";
import Controls from "./components/Controls";
import StatusBar from "./components/StatusBar";
import DynoPanel from "./components/DynoPanel";
import HelpPanel from "./components/HelpPanel";
import FailureOverlay from "./components/FailureOverlay";
import RacePanel from "./components/RacePanel";
import AcademyPanel from "./components/AcademyPanel";
import DriverName from "./components/DriverName";
import MobileDock from "./components/MobileDock";
import GaragePanel from "./components/GaragePanel";
import { useGameStore } from "./store/gameStore";
import { useMediaQuery } from "./lib/useMediaQuery";
import type { Exercise } from "./engine/exercises";

type Tab =
  | "garage"
  | "fuel"
  | "ign"
  | "afr"
  | "dyno"
  | "race"
  | "learn"
  | "guide";
type Section = "garage" | "tune" | "race" | "learn";

const SECTIONS: {
  id: Section;
  label: string;
  tabs: { id: Tab; label: string }[];
}[] = [
  {
    id: "garage",
    label: "Garage",
    tabs: [{ id: "garage", label: "Garage" }],
  },
  {
    id: "tune",
    label: "Tune",
    tabs: [
      { id: "fuel", label: "Fuel" },
      { id: "ign", label: "Ignition" },
      { id: "afr", label: "AFR Target" },
      { id: "dyno", label: "Dyno" },
    ],
  },
  {
    id: "race",
    label: "Race",
    tabs: [{ id: "race", label: "Drag Strip" }],
  },
  {
    id: "learn",
    label: "Learn",
    tabs: [
      { id: "learn", label: "Tuning School" },
      { id: "guide", label: "Guide" },
    ],
  },
];

const sectionOf = (t: Tab): Section =>
  SECTIONS.find((s) => s.tabs.some((x) => x.id === t))!.id;

/** invite links: ?join=drag-XKR42 lands the guest straight in the lobby */
const pendingJoinCode = (() => {
  const raw = new URLSearchParams(window.location.search).get("join");
  const m = raw?.match(/^drag-([A-Za-z0-9]{4,8})$/i);
  return m ? m[1].toUpperCase() : null;
})();

export default function App() {
  const engineId = useTuneStore((s) => s.engineId);
  const setEngineId = useTuneStore((s) => s.setEngineId);
  const storedMaps = useTuneStore((s) => s.mapsByEngine[s.engineId]);
  const setStoredMaps = useTuneStore((s) => s.setMaps);

  const spec = useMemo(() => getEngine(engineId), [engineId]);
  const axes = useMemo(() => buildAxes(spec), [spec]);
  // stored working maps if they fit this engine's axes, else a fresh base cal
  const maps = useMemo(
    () => (validMaps(storedMaps, axes) ? storedMaps : baseMaps(spec, axes)),
    [storedMaps, spec, axes],
  );
  const [tab, setTab] = useState<Tab>(pendingJoinCode ? "race" : "fuel");
  // the active top-level section falls out of the active tab; each section
  // remembers where you left it
  const section = sectionOf(tab);
  const activeSection = SECTIONS.find((s) => s.id === section)!;
  const lastTabBySection = useRef<Record<Section, Tab>>({
    garage: "garage",
    tune: "fuel",
    race: "race",
    learn: "learn",
  });

  const gotoTab = useCallback((t: Tab) => {
    lastTabBySection.current[sectionOf(t)] = t;
    setTab(t);
  }, []);
  const gotoSection = useCallback(
    (s: Section) => setTab(lastTabBySection.current[s]),
    [],
  );

  const history = useRef<Maps[]>([]);

  // engine loop lifecycle
  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, []);

  // configure the sim on engine swap (and first mount); afterwards just feed
  // it the latest maps without resetting hardware
  const configuredFor = useRef("");
  useEffect(() => {
    if (configuredFor.current !== spec.id) {
      configuredFor.current = spec.id;
      history.current = [];
      engine.configure(spec, axes, maps);
    } else {
      engine.maps = maps;
    }
  }, [spec, axes, maps]);

  const swapEngine = useCallback(
    (id: string) => setEngineId(id),
    [setEngineId],
  );

  const change = useCallback(
    (next: Maps) => {
      history.current.push(maps);
      if (history.current.length > 80) history.current.shift();
      setStoredMaps(engineId, next);
    },
    [maps, engineId, setStoredMaps],
  );

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setStoredMaps(engineId, prev);
  }, [engineId, setStoredMaps]);

  /** Tuning School: load an exercise's scenario onto its engine. */
  const startExercise = useCallback(
    (ex: Exercise) => {
      const exSpec = getEngine(ex.engineId);
      const exAxes = buildAxes(exSpec);
      setEngineId(ex.engineId);
      setStoredMaps(ex.engineId, ex.start(exSpec, exAxes));
      useGameStore.getState().setActiveExercise(ex.id);
      // engine.configure resets the wastegate on swap — set ours after
      setTimeout(() => engine.setWastegate(ex.wastegateKpa), 150);
    },
    [setEngineId, setStoredMaps],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  /** VE-analyzer style: rescale pulse width by measured ÷ target AFR. */
  const applyAfrCorrection = useCallback(
    (sel: { ar: number; ac: number; fr: number; fc: number } | null) => {
      const log = engine.afrLog;
      const g = cloneGrid(maps.fuel);
      const multi =
        sel && (Math.abs(sel.ar - sel.fr) > 0 || Math.abs(sel.ac - sel.fc) > 0);
      const r0 = multi ? Math.min(sel!.ar, sel!.fr) : 0;
      const r1 = multi ? Math.max(sel!.ar, sel!.fr) : axes.load.length - 1;
      const c0 = multi ? Math.min(sel!.ac, sel!.fc) : 0;
      const c1 = multi ? Math.max(sel!.ac, sel!.fc) : axes.rpm.length - 1;
      let touched = 0;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const measured = log[r]?.[c];
          if (measured === undefined || Number.isNaN(measured)) continue;
          const factor = clamp(measured / maps.afrTarget[r][c], 0.7, 1.4);
          const eff = Math.max(0, g[r][c] - spec.injDeadtimeMs);
          g[r][c] =
            Math.round((eff * factor + spec.injDeadtimeMs) * 100) / 100;
          touched++;
        }
      }
      if (touched > 0) change({ ...maps, fuel: g });
    },
    [maps, change, axes, spec],
  );

  const isDesktop = useMediaQuery("(min-width: 1024px)");

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <FailureOverlay />

      {/* header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-grid bg-surface px-2 py-2 sm:px-4">
        <span className="text-sm font-bold tracking-wide">
          BOB'S <span className="text-s1">REAL</span> DYNOS
        </span>
        <select
          value={engineId}
          onChange={(e) => swapEngine(e.target.value)}
          className="max-w-[52vw] rounded border border-grid bg-raised px-2 py-1 text-xs font-semibold text-ink sm:max-w-none"
          title={spec.desc}
        >
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <span className="hidden text-xs text-muted xl:inline">{spec.desc}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:block">
            <DriverName />
          </span>
          <button
            onClick={undo}
            className="rounded border border-grid px-2 py-1 text-xs text-ink2 hover:text-ink"
            title="Ctrl+Z"
          >
            ↩ Undo
          </button>
          <PresetMenu spec={spec} axes={axes} maps={maps} onLoad={change} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* main: section tabs + sub-tabs + content */}
        <main className="flex min-w-0 flex-1 flex-col">
          <nav className="border-b border-grid bg-surface">
            <div className="flex gap-1 overflow-x-auto px-3">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => gotoSection(s.id)}
                  className={`relative px-4 py-2 text-sm font-bold uppercase tracking-wider transition-colors ${
                    section === s.id ? "text-ink" : "text-muted hover:text-ink2"
                  }`}
                >
                  {s.label}
                  {section === s.id && (
                    <motion.div
                      layoutId="section-underline"
                      className="absolute inset-x-1 bottom-0 h-0.5 bg-s1"
                    />
                  )}
                </button>
              ))}
            </div>
            {activeSection.tabs.length > 1 && (
              <div className="flex gap-1 overflow-x-auto border-t border-grid bg-page/40 px-3">
                {activeSection.tabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => gotoTab(t.id)}
                    className={`relative px-3 py-1.5 text-xs transition-colors ${
                      tab === t.id ? "text-ink" : "text-muted hover:text-ink2"
                    }`}
                  >
                    {t.label}
                    {tab === t.id && (
                      <motion.div
                        layoutId="tab-underline"
                        className="absolute inset-x-1 bottom-0 h-0.5 bg-s2"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </nav>

          <div className="min-h-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={`${tab}-${engineId}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full"
              >
                {tab === "garage" && (
                  <GaragePanel
                    currentEngineId={engineId}
                    onGotoEngine={swapEngine}
                    onGotoTab={(t) => gotoTab(t)}
                  />
                )}
                {tab === "fuel" && (
                  <MapEditor
                    axes={axes}
                    title="Fuel — injector pulse width"
                    subtitle="milliseconds of injector open time per cycle; more = richer"
                    grid={maps.fuel}
                    onChange={(g) => change({ ...maps, fuel: g })}
                    unit="ms"
                    decimals={2}
                    min={0}
                    max={25}
                    step={0.1}
                    bigStep={0.5}
                    heatRange={[1, 16]}
                    logTools={{
                      targetGrid: maps.afrTarget,
                      onApplyCorrection: applyAfrCorrection,
                    }}
                  />
                )}
                {tab === "ign" && (
                  <MapEditor
                    axes={axes}
                    title="Ignition — spark advance"
                    subtitle="degrees before TDC; more = more torque until knock"
                    grid={maps.ign}
                    onChange={(g) => change({ ...maps, ign: g })}
                    unit="° BTDC"
                    decimals={1}
                    min={0}
                    max={45}
                    step={0.5}
                    bigStep={2}
                    heatRange={[4, 40]}
                  />
                )}
                {tab === "afr" && (
                  <MapEditor
                    axes={axes}
                    title="AFR Target — your goal mixture"
                    subtitle="reference only: the logger and corrections compare against this"
                    grid={maps.afrTarget}
                    onChange={(g) => change({ ...maps, afrTarget: g })}
                    unit="AFR"
                    decimals={1}
                    min={10}
                    max={16}
                    step={0.1}
                    bigStep={0.5}
                    heatRange={[11, 15]}
                  />
                )}
                {tab === "dyno" && (
                  <DynoPanel spec={spec} axes={axes} maps={maps} />
                )}
                {tab === "race" && (
                  <RacePanel
                    spec={spec}
                    axes={axes}
                    maps={maps}
                    autoJoinCode={pendingJoinCode}
                  />
                )}
                {tab === "learn" && (
                  <AcademyPanel
                    currentEngineId={engineId}
                    onStartExercise={startExercise}
                    onGotoEngine={swapEngine}
                    onGotoTab={(t) => gotoTab(t)}
                  />
                )}
                {tab === "guide" && <HelpPanel />}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

        {/* desktop sidebar: gauges, controls, warnings */}
        {isDesktop && (
          <aside className="flex w-[330px] shrink-0 flex-col overflow-y-auto border-l border-grid bg-surface">
            <Gauges spec={spec} />
            <Controls spec={spec} />
            <StatusBar />
          </aside>
        )}
      </div>

      {/* phone: live telemetry strip + slide-up drawer */}
      {!isDesktop && <MobileDock spec={spec} />}
    </div>
  );
}
