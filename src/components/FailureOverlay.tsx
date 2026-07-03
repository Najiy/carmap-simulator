import { motion, AnimatePresence } from "framer-motion";
import { engine, useEngineSnapshot } from "../engine/store";

/** Full-screen red-alert takeover when the engine lets go. */
export default function FailureOverlay() {
  const s = useEngineSnapshot();

  return (
    <AnimatePresence>
      {s.blown && (
        <motion.div
          key="blown"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
        >
          {/* red shockwave */}
          <motion.div
            initial={{ scale: 0, opacity: 0.9 }}
            animate={{ scale: 14, opacity: 0 }}
            transition={{ duration: 1.1, ease: "circOut" }}
            className="pointer-events-none absolute h-40 w-40 rounded-full bg-crit"
          />
          {/* flying debris */}
          {Array.from({ length: 26 }, (_, i) => {
            const a = (i / 26) * Math.PI * 2 + (i % 3) * 0.35;
            const dist = 240 + (i % 5) * 110;
            return (
              <motion.div
                key={i}
                initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
                animate={{
                  x: Math.cos(a) * dist,
                  y: Math.sin(a) * dist + 130,
                  opacity: 0,
                  rotate: 300 + i * 47,
                }}
                transition={{ duration: 1.3 + (i % 4) * 0.22, ease: "circOut" }}
                className="pointer-events-none absolute"
                style={{ fontSize: 15 + (i % 4) * 6 }}
              >
                {["🔩", "⚙️", "🔧", "💨", "🔥"][i % 5]}
              </motion.div>
            );
          })}

          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{
              scale: 1,
              opacity: 1,
              x: [0, -14, 12, -8, 5, -2, 0],
            }}
            transition={{
              duration: 0.55,
              x: { duration: 0.6, times: [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1] },
            }}
            className="relative mx-4 max-w-md rounded-lg border-2 border-crit bg-surface p-8 text-center shadow-2xl"
          >
            <motion.div
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ duration: 0.8, repeat: Infinity }}
              className="text-6xl"
            >
              💥
            </motion.div>
            <motion.h2
              animate={{ opacity: [1, 0.45, 1] }}
              transition={{ duration: 0.7, repeat: Infinity }}
              className="mt-3 text-2xl font-black tracking-wide text-crit"
            >
              ENGINE FAILURE
            </motion.h2>
            <p className="mt-3 text-sm text-ink2">
              Cause of death:{" "}
              <span className="font-semibold text-crit">
                {s.blowCause || "catastrophic mechanical failure"}
              </span>
            </p>
            <p className="mt-2 text-xs text-muted">
              {s.knockCount > 0 && `${s.knockCount} knock events on record. `}
              The maps survive — the hardware didn't. Rebuild, think about what
              went wrong, and tune your way out of it.
            </p>
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => engine.rebuildEngine()}
              className="mt-6 rounded bg-crit px-6 py-2.5 text-sm font-bold text-white"
            >
              🔧 Rebuild engine
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
