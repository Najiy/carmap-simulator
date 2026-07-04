import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DynoRun } from "../engine/dyno";

export interface RaceRecord {
  et: number;
  trapKph: number;
  at: number;
}

/** dyno history for one engine — rolling recents + user-pinned runs */
export interface DynoSlot {
  recents: DynoRun[];
  pinned: DynoRun[];
}

const EMPTY_SLOT: DynoSlot = { recents: [], pinned: [] };

interface GameState {
  playerName: string;
  autoShift: boolean;
  activeExerciseId: string | null;
  /** exercise id → completion info */
  completed: Record<string, { at: number; peakHp: number }>;
  /** engine id → best quarter-mile */
  bestEt: Record<string, RaceRecord>;
  /** engine id → saved dyno runs (persisted across refreshes) */
  dyno: Record<string, DynoSlot>;
  /** monotonic run-id source so labels stay unique across reloads */
  dynoSeq: number;
  setPlayerName: (name: string) => void;
  setAutoShift: (on: boolean) => void;
  setActiveExercise: (id: string | null) => void;
  completeExercise: (id: string, peakHp: number) => void;
  recordEt: (engineId: string, et: number, trapKph: number) => void;
  takeDynoId: () => number;
  addDynoRun: (engineId: string, run: DynoRun) => void;
  toggleDynoPin: (engineId: string, run: DynoRun) => void;
  clearDyno: (engineId: string) => void;
}

const defaultName = () =>
  `Racer-${Math.floor(1000 + Math.random() * 9000)}`;

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      playerName: defaultName(),
      autoShift: false,
      activeExerciseId: null,
      completed: {},
      bestEt: {},
      dyno: {},
      dynoSeq: 1,
      setPlayerName: (playerName) =>
        set({ playerName: playerName.trim().slice(0, 20) || defaultName() }),
      setAutoShift: (autoShift) => set({ autoShift }),
      setActiveExercise: (activeExerciseId) => set({ activeExerciseId }),
      completeExercise: (id, peakHp) =>
        set((s) => ({
          completed: {
            ...s.completed,
            [id]: { at: Date.now(), peakHp: Math.round(peakHp) },
          },
        })),
      recordEt: (engineId, et, trapKph) =>
        set((s) => {
          const prev = s.bestEt[engineId];
          if (prev && prev.et <= et) return s;
          return {
            bestEt: {
              ...s.bestEt,
              [engineId]: { et, trapKph, at: Date.now() },
            },
          };
        }),
      takeDynoId: () => {
        const id = get().dynoSeq;
        set({ dynoSeq: id + 1 });
        return id;
      },
      addDynoRun: (engineId, run) =>
        set((s) => {
          const slot = s.dyno[engineId] ?? EMPTY_SLOT;
          const recents = [
            run,
            ...slot.recents.filter((r) => r.id !== run.id),
          ].slice(0, 3);
          return { dyno: { ...s.dyno, [engineId]: { ...slot, recents } } };
        }),
      toggleDynoPin: (engineId, run) =>
        set((s) => {
          const slot = s.dyno[engineId] ?? EMPTY_SLOT;
          const has = slot.pinned.some((r) => r.id === run.id);
          if (!has && slot.pinned.length >= 3) return s;
          const pinned = has
            ? slot.pinned.filter((r) => r.id !== run.id)
            : [...slot.pinned, run];
          return { dyno: { ...s.dyno, [engineId]: { ...slot, pinned } } };
        }),
      clearDyno: (engineId) =>
        set((s) => ({
          dyno: { ...s.dyno, [engineId]: { recents: [], pinned: [] } },
        })),
    }),
    { name: "carmap-game-v1" },
  ),
);
