import { buildAxes } from "../engine/axes";
import type { Maps } from "../engine/defaults";
import { getEngine, ENGINES } from "../engine/engines";
import { engine } from "../engine/store";
import { useTuneStore, validMaps, type UserPreset } from "../store/tuneStore";
import { useGameStore, type RaceRecord } from "../store/gameStore";

/** Portable "car" file: the engine, its working tune, saved presets, PBs. */
export interface CarExport {
  app: "bobs-real-dynos";
  kind: "car";
  version: 1;
  exportedAt: number;
  playerName: string;
  engineId: string;
  engineName: string;
  wastegateKpa: number;
  maps: Maps;
  presets: { name: string; savedAt: number; maps: Maps }[];
  bestEt: RaceRecord | null;
}

export function buildCarExport(engineId: string, maps: Maps): CarExport {
  const spec = getEngine(engineId);
  const tune = useTuneStore.getState();
  const game = useGameStore.getState();
  return {
    app: "bobs-real-dynos",
    kind: "car",
    version: 1,
    exportedAt: Date.now(),
    playerName: game.playerName,
    engineId,
    engineName: spec.name,
    wastegateKpa: engine.getSnapshot().wastegateKpa,
    maps: structuredClone(maps),
    presets: tune.userPresets
      .filter((p) => p.engineId === engineId)
      .map((p) => ({
        name: p.name,
        savedAt: p.savedAt,
        maps: structuredClone(p.maps),
      })),
    bestEt: game.bestEt[engineId] ?? null,
  };
}

export function downloadCar(engineId: string, maps: Maps) {
  const data = buildCarExport(engineId, maps);
  const slug = getEngine(engineId)
    .name.split("—")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bobs-dynos-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  ok: boolean;
  message: string;
}

/** Validate and apply a car file: engine, tune, presets, personal best. */
export function importCar(raw: string): ImportResult {
  let data: CarExport;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Not a valid JSON file." };
  }
  if (data?.app !== "bobs-real-dynos" || data?.kind !== "car") {
    return { ok: false, message: "This isn't a Bob's Real Dynos car file." };
  }
  if (!ENGINES.some((e) => e.id === data.engineId)) {
    return {
      ok: false,
      message: `Unknown engine "${data.engineId}" — update the app and retry.`,
    };
  }
  const spec = getEngine(data.engineId);
  const axes = buildAxes(spec);
  if (!validMaps(data.maps, axes)) {
    return { ok: false, message: "The tune tables don't fit this engine." };
  }

  const tune = useTuneStore.getState();
  const game = useGameStore.getState();

  tune.setEngineId(data.engineId);
  tune.setMaps(data.engineId, structuredClone(data.maps));

  // merge presets, skipping ones we already have (same name + timestamp)
  let added = 0;
  const existing = new Set(
    tune.userPresets.map((p: UserPreset) => `${p.engineId}|${p.name}|${p.savedAt}`),
  );
  for (const p of data.presets ?? []) {
    if (!validMaps(p.maps, axes)) continue;
    if (existing.has(`${data.engineId}|${p.name}|${p.savedAt}`)) continue;
    useTuneStore.setState((s) => ({
      userPresets: [
        ...s.userPresets,
        {
          id: crypto.randomUUID(),
          name: p.name,
          engineId: data.engineId,
          maps: structuredClone(p.maps),
          savedAt: p.savedAt ?? Date.now(),
        },
      ],
    }));
    added++;
  }

  if (data.bestEt) {
    game.recordEt(data.engineId, data.bestEt.et, data.bestEt.trapKph);
  }

  // the engine swap resets the wastegate to stock — restore the tuner's
  // setting once the sim has reconfigured
  if (typeof data.wastegateKpa === "number") {
    setTimeout(() => engine.setWastegate(data.wastegateKpa), 200);
  }

  return {
    ok: true,
    message: `Imported ${spec.name.split("—")[0].trim()} with its tune${
      added ? ` + ${added} preset${added > 1 ? "s" : ""}` : ""
    }${data.bestEt ? ` · PB ${data.bestEt.et.toFixed(2)}s` : ""}.`,
  };
}
