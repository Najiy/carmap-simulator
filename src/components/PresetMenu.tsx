import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Axes } from "../engine/axes";
import type { EngineSpec } from "../engine/engines";
import { PRESETS, type Maps } from "../engine/defaults";
import { engine } from "../engine/store";
import { useTuneStore, validMaps } from "../store/tuneStore";
import { downloadCar, importCar } from "../lib/transfer";

export default function PresetMenu({
  spec,
  axes,
  maps,
  onLoad,
}: {
  spec: EngineSpec;
  axes: Axes;
  maps: Maps;
  onLoad: (maps: Maps) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const userPresets = useTuneStore((s) => s.userPresets);
  const savePreset = useTuneStore((s) => s.savePreset);
  const deletePreset = useTuneStore((s) => s.deletePreset);

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    const result = importCar(await file.text());
    setNotice(result);
    if (result.ok) setTimeout(() => setOpen(false), 1600);
  };

  const mine = userPresets.filter((p) => p.engineId === spec.id);

  const save = () => {
    savePreset(name, spec.id, maps);
    setName("");
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded border px-2 py-1 text-xs transition-colors ${
          open
            ? "border-s1 text-ink"
            : "border-grid bg-raised text-ink2 hover:text-ink"
        }`}
      >
        Presets ▾
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 z-40 mt-1 w-72 rounded border border-grid bg-raised p-2 shadow-xl"
            >
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Built-in
              </div>
              {PRESETS.filter(
                (p) => !p.engineId || p.engineId === spec.id,
              ).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onLoad(p.make(spec, axes));
                    if (p.wastegateKpa && spec.turbo) {
                      engine.setWastegate(p.wastegateKpa);
                    }
                    setOpen(false);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs text-ink2 hover:bg-surface hover:text-ink"
                >
                  {p.label}
                  {p.wastegateKpa ? (
                    <span className="ml-1 text-[10px] text-muted">
                      (sets wastegate {p.wastegateKpa} kPa)
                    </span>
                  ) : null}
                </button>
              ))}

              <div className="mt-2 border-t border-grid px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                My tunes — {spec.name.split("—")[0].trim()}
              </div>
              {mine.length === 0 && (
                <div className="px-2 py-1 text-[11px] text-muted">
                  Nothing saved for this engine yet.
                </div>
              )}
              {mine.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-center gap-1 rounded hover:bg-surface"
                >
                  <button
                    onClick={() => {
                      if (validMaps(p.maps, axes)) {
                        onLoad(structuredClone(p.maps));
                        setOpen(false);
                      }
                    }}
                    className="min-w-0 flex-1 px-2 py-1.5 text-left text-xs text-ink2 group-hover:text-ink"
                  >
                    <span className="block truncate">{p.name}</span>
                    <span className="text-[10px] text-muted">
                      {new Date(p.savedAt).toLocaleDateString()}{" "}
                      {new Date(p.savedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </button>
                  <button
                    onClick={() => deletePreset(p.id)}
                    title="Delete preset"
                    className="px-2 text-muted opacity-0 transition-opacity hover:text-crit group-hover:opacity-100"
                  >
                    ✕
                  </button>
                </div>
              ))}

              <div className="mt-2 flex gap-1 border-t border-grid pt-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder="Name this tune…"
                  className="min-w-0 flex-1 rounded border border-grid bg-surface px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-s1 focus:outline-none"
                />
                <button
                  onClick={save}
                  className="rounded bg-s1 px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
                >
                  💾 Save
                </button>
              </div>

              {/* move the whole car between devices */}
              <div className="mt-2 flex gap-1 border-t border-grid pt-2">
                <button
                  onClick={() => {
                    downloadCar(spec.id, maps);
                    setNotice({ ok: true, message: "Car file downloaded." });
                  }}
                  className="flex-1 rounded border border-grid px-2 py-1.5 text-xs text-ink2 hover:border-axis hover:text-ink"
                >
                  ⇪ Export car
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex-1 rounded border border-grid px-2 py-1.5 text-xs text-ink2 hover:border-axis hover:text-ink"
                >
                  ⇩ Import car…
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    void onImportFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="px-1 pt-1 text-[10px] leading-snug text-muted">
                A car file bundles the engine, its current tune, your saved
                presets and drag-strip PB — import it on any device.
              </p>
              {notice && (
                <div
                  className={`mt-1 rounded px-2 py-1 text-[11px] ${
                    notice.ok
                      ? "bg-good/15 text-good"
                      : "bg-crit/15 text-crit"
                  }`}
                >
                  {notice.message}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
