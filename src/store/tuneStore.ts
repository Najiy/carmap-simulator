import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Axes } from "../engine/axes";
import type { Maps } from "../engine/defaults";
import { ENGINES } from "../engine/engines";

export interface UserPreset {
  id: string;
  name: string;
  engineId: string;
  maps: Maps;
  savedAt: number;
}

interface TuneState {
  engineId: string;
  /** working (possibly half-tuned) maps, kept per engine across reloads */
  mapsByEngine: Record<string, Maps>;
  userPresets: UserPreset[];
  muted: boolean;
  setEngineId: (id: string) => void;
  setMaps: (engineId: string, maps: Maps) => void;
  savePreset: (name: string, engineId: string, maps: Maps) => void;
  deletePreset: (id: string) => void;
  setMuted: (muted: boolean) => void;
}

export const useTuneStore = create<TuneState>()(
  persist(
    (set) => ({
      engineId: ENGINES[0].id,
      mapsByEngine: {},
      userPresets: [],
      muted: false,
      setEngineId: (engineId) => set({ engineId }),
      setMaps: (engineId, maps) =>
        set((s) => ({
          mapsByEngine: { ...s.mapsByEngine, [engineId]: maps },
        })),
      savePreset: (name, engineId, maps) =>
        set((s) => ({
          userPresets: [
            ...s.userPresets,
            {
              id: crypto.randomUUID(),
              name: name.trim().slice(0, 40) || "Untitled tune",
              engineId,
              maps: structuredClone(maps),
              savedAt: Date.now(),
            },
          ],
        })),
      deletePreset: (id) =>
        set((s) => ({
          userPresets: s.userPresets.filter((p) => p.id !== id),
        })),
      setMuted: (muted) => set({ muted }),
    }),
    { name: "carmap-tune-v1" },
  ),
);

/** Guard against stale localStorage after an axes/schema change. */
export function validMaps(maps: Maps | undefined, axes: Axes): maps is Maps {
  if (!maps) return false;
  const okGrid = (g: unknown) =>
    Array.isArray(g) &&
    g.length === axes.load.length &&
    g.every(
      (row) =>
        Array.isArray(row) &&
        row.length === axes.rpm.length &&
        row.every((v) => typeof v === "number" && Number.isFinite(v)),
    );
  return okGrid(maps.fuel) && okGrid(maps.ign) && okGrid(maps.afrTarget);
}
