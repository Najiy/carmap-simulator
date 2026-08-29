import { lazy, Suspense, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CARS, carEngine, type Car } from "../engine/cars";
import { GEARBOX } from "../engine/engines";

// three.js is a third of a megabyte of JS nobody browsing the tuning tabs
// needs — it only arrives when someone actually opens a car
const CarViewer = lazy(() => import("./CarViewer"));

const stat = (label: string, value: string) => ({ label, value });

export default function GaragePanel({
  currentEngineId,
  onGotoEngine,
  onGotoTab,
}: {
  currentEngineId: string;
  onGotoEngine: (engineId: string) => void;
  onGotoTab: (tab: "fuel" | "dyno" | "race") => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = CARS.find((c) => c.id === openId) ?? null;

  return (
    <div className="h-full">
      <AnimatePresence mode="wait">
        {open ? (
          <motion.div
            key={open.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            <CarDetail
              car={open}
              isCurrent={open.engineId === currentEngineId}
              onBack={() => setOpenId(null)}
              onGotoEngine={onGotoEngine}
              onGotoTab={onGotoTab}
            />
          </motion.div>
        ) : (
          <motion.div
            key="list"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="h-full overflow-y-auto p-3 sm:p-4"
          >
            <div className="mb-3">
              <h2 className="text-sm font-bold uppercase tracking-wider">
                Garage
              </h2>
              <p className="text-xs text-muted">
                {CARS.length} cars — pick one to walk around it and put its
                engine on the dyno.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {CARS.map((car) => (
                <CarCard
                  key={car.id}
                  car={car}
                  isCurrent={car.engineId === currentEngineId}
                  onOpen={() => setOpenId(car.id)}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CarCard({
  car,
  isCurrent,
  onOpen,
}: {
  car: Car;
  isCurrent: boolean;
  onOpen: () => void;
}) {
  const spec = carEngine(car);
  return (
    <button
      onClick={onOpen}
      className={`group flex flex-col rounded border bg-surface p-3 text-left transition-colors hover:border-s1/60 ${
        isCurrent ? "border-s1/70" : "border-grid"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-muted">
            {car.maker} · {car.years}
          </div>
          <div className="truncate text-sm font-bold text-ink">{car.name}</div>
        </div>
        {car.model ? (
          <span className="shrink-0 rounded bg-s2/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-s2">
            3D
          </span>
        ) : (
          <span className="shrink-0 rounded border border-grid px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
            No model
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-ink2">
        <span className="tabular font-bold text-s1">{spec.stock.hp} bhp</span>
        <span className="tabular">{spec.stock.nm} Nm</span>
        <span className="tabular text-muted">{car.weightKg} kg</span>
      </div>

      <div className="mt-1.5 truncate text-[11px] text-muted">{spec.name}</div>

      {isCurrent && (
        <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-s1">
          On the dyno now
        </div>
      )}
    </button>
  );
}

function CarDetail({
  car,
  isCurrent,
  onBack,
  onGotoEngine,
  onGotoTab,
}: {
  car: Car;
  isCurrent: boolean;
  onBack: () => void;
  onGotoEngine: (engineId: string) => void;
  onGotoTab: (tab: "fuel" | "dyno" | "race") => void;
}) {
  const spec = carEngine(car);
  const stats = useMemo(
    () => [
      stat("Power", `${spec.stock.hp} bhp`),
      stat("Torque", `${spec.stock.nm} Nm`),
      stat("Displacement", `${spec.dispL.toFixed(1)} L`),
      stat("Cylinders", String(spec.ncyl)),
      stat(
        "Boost",
        spec.turbo ? `${spec.turbo.maxKpa - 100} kPa` : "naturally aspirated",
      ),
      stat("Redline", `${spec.redline.toLocaleString()} rpm`),
      stat("Kerb weight", `${car.weightKg} kg`),
      stat(
        "Power / tonne",
        `${Math.round((spec.stock.hp / car.weightKg) * 1000)} bhp`,
      ),
    ],
    [spec, car],
  );

  const send = (tab: "fuel" | "dyno" | "race") => {
    onGotoEngine(car.engineId);
    onGotoTab(tab);
  };

  // the car owns the whole area; everything else floats on top of it
  const [showSpecs, setShowSpecs] = useState(true);

  return (
    <div className="relative h-full bg-page">
      {car.model ? (
        <Suspense
          fallback={
            <div className="absolute inset-0 grid place-items-center text-xs text-muted">
              Starting the viewer…
            </div>
          }
        >
          {/* CarViewer is position:relative itself — size it, don't place it */}
          <CarViewer model={car.model} className="h-full w-full" />
        </Suspense>
      ) : (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div>
            <div className="text-sm text-ink2">No 3D model scanned yet</div>
            <div className="mt-1 text-xs text-muted">
              The engine is fully simulated — only the bodywork is missing.
            </div>
          </div>
        </div>
      )}

      {/* the chrome sits over the render and only catches clicks where it draws */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 p-2">
        <button
          onClick={onBack}
          className="pointer-events-auto shrink-0 rounded border border-grid bg-surface/80 px-2 py-1 text-xs text-ink2 backdrop-blur hover:text-ink"
        >
          ← Garage
        </button>
        <div className="pointer-events-auto min-w-0 rounded border border-grid bg-surface/80 px-2.5 py-1 backdrop-blur">
          <div className="truncate text-sm font-bold leading-tight">
            {car.maker} {car.name}
          </div>
          <div className="truncate text-[11px] text-muted">
            {car.years} · {car.layout}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showSpecs ? (
          <motion.aside
            key="specs"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-x-2 bottom-2 max-h-[55%] overflow-y-auto rounded border border-grid bg-surface/90 p-3 backdrop-blur lg:inset-x-auto lg:bottom-auto lg:right-2 lg:top-24 lg:max-h-[calc(100%-7rem)] lg:w-[320px]"
          >
            <div className="mb-2 flex items-start gap-2">
              <p className="flex-1 text-xs leading-relaxed text-ink2">
                {car.blurb}
              </p>
              <button
                onClick={() => setShowSpecs(false)}
                title="Hide the specs"
                className="shrink-0 rounded border border-grid px-1.5 py-0.5 text-xs text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4 lg:grid-cols-2">
              {stats.map((s) => (
                <div key={s.label}>
                  <dt className="text-[10px] uppercase tracking-wider text-muted">
                    {s.label}
                  </dt>
                  <dd className="tabular text-sm font-bold text-ink">
                    {s.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-3 rounded border border-grid bg-raised p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-muted">
                Engine
              </div>
              <div className="text-xs font-bold text-ink">{spec.name}</div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                {spec.desc}
              </p>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => send("fuel")}
                className="rounded bg-s1 px-3 py-1.5 text-xs font-bold text-white hover:brightness-110"
              >
                {isCurrent ? "Open the maps" : "Put it on the dyno"}
              </button>
              <button
                onClick={() => send("dyno")}
                className="rounded border border-grid px-3 py-1.5 text-xs text-ink2 hover:text-ink"
              >
                Dyno pull
              </button>
              <button
                onClick={() => send("race")}
                className="rounded border border-grid px-3 py-1.5 text-xs text-ink2 hover:text-ink"
              >
                Race it
              </button>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Every car races the same {GEARBOX.massKg} kg reference chassis —
              the engine is what changes.
              {car.model?.credit ? ` ${car.model.credit}.` : ""}
            </p>
          </motion.aside>
        ) : (
          <motion.button
            key="show"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowSpecs(true)}
            className="absolute bottom-2 right-2 rounded border border-grid bg-surface/80 px-2.5 py-1.5 text-xs text-ink2 backdrop-blur hover:text-ink"
          >
            Specs
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
