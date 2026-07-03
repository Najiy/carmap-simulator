import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  EXERCISES,
  LEVELS,
  evaluateExercise,
  exerciseById,
  type Exercise,
  type ExerciseEval,
  type ExerciseLevel,
} from "../engine/exercises";
import { getEngine } from "../engine/engines";
import { engine } from "../engine/store";
import { useGameStore } from "../store/gameStore";
import { useTuneStore, validMaps } from "../store/tuneStore";
import { buildAxes } from "../engine/axes";
import { baseMaps } from "../engine/defaults";

export default function AcademyPanel({
  currentEngineId,
  onStartExercise,
  onGotoEngine,
  onGotoTab,
}: {
  currentEngineId: string;
  onStartExercise: (ex: Exercise) => void;
  onGotoEngine: (engineId: string) => void;
  onGotoTab: (tab: "fuel" | "ign" | "dyno") => void;
}) {
  const completed = useGameStore((s) => s.completed);
  const activeId = useGameStore((s) => s.activeExerciseId);
  const setActive = useGameStore((s) => s.setActiveExercise);
  const completeExercise = useGameStore((s) => s.completeExercise);

  const [result, setResult] = useState<ExerciseEval | null>(null);
  const [showHints, setShowHints] = useState(false);
  const [justPassed, setJustPassed] = useState(false);

  const active = exerciseById(activeId);

  const doneCount = (lv: ExerciseLevel) =>
    EXERCISES.filter((e) => e.level === lv && completed[e.id]).length;

  const unlocked = (lv: ExerciseLevel) =>
    lv === "beginner"
      ? true
      : lv === "intermediate"
        ? doneCount("beginner") >= 2
        : doneCount("intermediate") >= 2;

  const validate = () => {
    if (!active) return;
    const spec = getEngine(active.engineId);
    const axes = buildAxes(spec);
    const stored = useTuneStore.getState().mapsByEngine[active.engineId];
    const maps = validMaps(stored, axes) ? stored : baseMaps(spec, axes);
    const ev = evaluateExercise(active, maps);
    setResult(ev);
    if (ev.passed && !completed[active.id]) {
      completeExercise(active.id, ev.run.peakHp.v);
      setJustPassed(true);
    }
  };

  const start = (ex: Exercise) => {
    setResult(null);
    setJustPassed(false);
    setShowHints(false);
    onStartExercise(ex);
  };

  const abandon = () => {
    setActive(null);
    setResult(null);
    setJustPassed(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {/* active exercise workbench */}
      <AnimatePresence>
        {active && (
          <ActiveExercise
            key={active.id}
            ex={active}
            currentEngineId={currentEngineId}
            result={result}
            justPassed={justPassed}
            showHints={showHints}
            setShowHints={setShowHints}
            onValidate={validate}
            onReset={() => start(active)}
            onAbandon={abandon}
            onGotoEngine={onGotoEngine}
            onGotoTab={onGotoTab}
            alreadyDone={!!completed[active.id]}
          />
        )}
      </AnimatePresence>

      {/* curriculum */}
      {LEVELS.map((lv) => {
        const list = EXERCISES.filter((e) => e.level === lv.id);
        const open = unlocked(lv.id);
        return (
          <section key={lv.id}>
            <div className="mb-2 flex items-baseline gap-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink">
                {lv.label}
              </h2>
              <span className="text-xs text-muted">{lv.blurb}</span>
              <span className="ml-auto shrink-0 text-xs font-semibold text-s2">
                {doneCount(lv.id)}/{list.length}
              </span>
            </div>
            {!open ? (
              <div className="rounded border border-dashed border-grid p-3 text-xs text-muted">
                🔒 Complete two {lv.id === "intermediate" ? "beginner" : "intermediate"}{" "}
                exercises to unlock.
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-3">
                {list.map((ex) => {
                  const done = completed[ex.id];
                  const isActive = active?.id === ex.id;
                  return (
                    <div
                      key={ex.id}
                      className={`flex flex-col gap-1.5 rounded border p-3 ${
                        isActive
                          ? "border-s1 bg-s1/5"
                          : done
                            ? "border-good/50 bg-good/5"
                            : "border-grid bg-surface"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-sm font-bold">{ex.title}</span>
                        {done && <span className="ml-auto text-good">✓</span>}
                      </div>
                      <div className="text-[11px] text-s3">
                        {getEngine(ex.engineId).name.split("—")[0].trim()} ·{" "}
                        {ex.wastegateKpa > 100 ? `${ex.wastegateKpa} kPa` : "NA"}
                      </div>
                      <p className="line-clamp-3 text-xs text-muted">{ex.brief}</p>
                      <button
                        onClick={() => start(ex)}
                        className={`mt-auto rounded px-2 py-1.5 text-xs font-bold ${
                          isActive
                            ? "border border-s1 text-s1"
                            : "bg-s1 text-white hover:opacity-90"
                        }`}
                      >
                        {isActive ? "Restart (re-sabotage)" : done ? "Do it again" : "Start"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <p className="text-[11px] text-muted">
        Starting an exercise loads its scenario maps onto the engine — your other engines'
        tunes are untouched. Practice on the Dyno tab (damage is real there), then Validate
        here: the grading pull runs on the shop dyno and never hurts your engine.
      </p>
    </div>
  );
}

function ActiveExercise({
  ex,
  currentEngineId,
  result,
  justPassed,
  showHints,
  setShowHints,
  onValidate,
  onReset,
  onAbandon,
  onGotoEngine,
  onGotoTab,
  alreadyDone,
}: {
  ex: Exercise;
  currentEngineId: string;
  result: ExerciseEval | null;
  justPassed: boolean;
  showHints: boolean;
  setShowHints: (b: boolean) => void;
  onValidate: () => void;
  onReset: () => void;
  onAbandon: () => void;
  onGotoEngine: (id: string) => void;
  onGotoTab: (tab: "fuel" | "ign" | "dyno") => void;
  alreadyDone: boolean;
}) {
  const spec = useMemo(() => getEngine(ex.engineId), [ex.engineId]);
  const wrongEngine = currentEngineId !== ex.engineId;

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded border border-s1/60 bg-s1/5 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-s1 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
          {ex.level}
        </span>
        <h3 className="text-base font-bold">{ex.title}</h3>
        <span className="text-xs text-s3">
          {spec.name} · validation at {ex.wastegateKpa > 100 ? `${ex.wastegateKpa} kPa` : "NA"}
        </span>
        <button
          onClick={onAbandon}
          className="ml-auto rounded border border-grid px-2 py-1 text-xs text-muted hover:text-ink"
        >
          ✕ Close
        </button>
      </div>

      <p className="mt-2 text-sm text-ink2">{ex.brief}</p>

      {wrongEngine && (
        <div className="mt-2 flex items-center gap-2 rounded border border-warn bg-warn/10 p-2 text-xs text-warn">
          You're on a different engine.
          <button
            onClick={() => onGotoEngine(ex.engineId)}
            className="rounded bg-warn px-2 py-0.5 font-bold text-black"
          >
            Switch to {spec.name.split("—")[0].trim()}
          </button>
        </div>
      )}

      {/* goals */}
      <div className="mt-3 grid gap-1.5 md:grid-cols-2">
        {(result?.goals ?? previewGoals(ex)).map((g, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
              result
                ? g.pass
                  ? "border-good/60 bg-good/10 text-ink2"
                  : "border-crit/60 bg-crit/10 text-ink2"
                : "border-grid bg-surface text-ink2"
            }`}
          >
            <span className="w-4 text-center">
              {result ? (g.pass ? "✅" : "❌") : "◻️"}
            </span>
            <span className="flex-1">{g.label}</span>
            {result && <span className="font-mono text-muted">{g.actual}</span>}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={onValidate}
          className="rounded bg-s2 px-4 py-2 text-sm font-bold text-white"
        >
          🏁 Validate my tune
        </motion.button>
        <button
          onClick={() => onGotoTab("fuel")}
          className="rounded border border-grid px-3 py-2 text-xs text-ink2 hover:text-ink"
        >
          → Fuel map
        </button>
        <button
          onClick={() => onGotoTab("ign")}
          className="rounded border border-grid px-3 py-2 text-xs text-ink2 hover:text-ink"
        >
          → Ignition map
        </button>
        <button
          onClick={() => {
            if (!wrongEngine) engine.setWastegate(ex.wastegateKpa);
            onGotoTab("dyno");
          }}
          className="rounded border border-grid px-3 py-2 text-xs text-ink2 hover:text-ink"
          title="Also sets your wastegate to the validation pressure"
        >
          → Practice on dyno
        </button>
        <button
          onClick={() => setShowHints(!showHints)}
          className="rounded border border-grid px-3 py-2 text-xs text-ink2 hover:text-ink"
        >
          {showHints ? "Hide hints" : `Hints (${ex.hints.length})`}
        </button>
        <button
          onClick={onReset}
          className="ml-auto rounded border border-grid px-3 py-2 text-xs text-muted hover:text-ink"
          title="Reload the exercise's starting maps"
        >
          ↻ Reset exercise
        </button>
      </div>

      <AnimatePresence>
        {showHints && (
          <motion.ul
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 list-disc space-y-1 overflow-hidden pl-5 text-xs text-muted"
          >
            {ex.hints.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {result?.passed && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-3 rounded border border-good bg-good/15 p-3 text-center"
          >
            <div className="text-lg font-black text-good">
              {justPassed ? "EXERCISE COMPLETE 🎓" : "Passed again — still got it ✓"}
            </div>
            <div className="text-xs text-ink2">
              {result.run.peakHp.v.toFixed(0)} whp @ {result.run.peakHp.rpm} rpm ·{" "}
              {result.run.knockEvents} knock · duty {result.run.maxDuty.toFixed(0)}%
            </div>
          </motion.div>
        )}
        {result && !result.passed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-3 rounded border border-grid bg-surface p-2 text-center text-xs text-muted"
          >
            Not yet — {result.goals.filter((g) => !g.pass).length} goal(s) failing. Fix the
            maps and validate again.{" "}
            {alreadyDone && "(You've beaten this before — no pressure.)"}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** goal labels before the first validation run — evaluate against a dummy? no:
 * show the label text by grading nothing; we reuse the goal builders with a
 * quick evaluation to extract labels, but display them unchecked. */
function previewGoals(ex: Exercise) {
  try {
    const spec = getEngine(ex.engineId);
    const axes = buildAxes(spec);
    const ev = evaluateExercise(ex, baseMaps(spec, axes));
    return ev.goals.map((g) => ({ ...g, pass: false, actual: "" }));
  } catch {
    return [];
  }
}
