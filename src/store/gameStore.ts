import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface RaceRecord {
  et: number;
  trapKph: number;
  at: number;
}

interface GameState {
  playerName: string;
  autoShift: boolean;
  activeExerciseId: string | null;
  /** exercise id → completion info */
  completed: Record<string, { at: number; peakHp: number }>;
  /** engine id → best quarter-mile */
  bestEt: Record<string, RaceRecord>;
  setPlayerName: (name: string) => void;
  setAutoShift: (on: boolean) => void;
  setActiveExercise: (id: string | null) => void;
  completeExercise: (id: string, peakHp: number) => void;
  recordEt: (engineId: string, et: number, trapKph: number) => void;
}

const defaultName = () =>
  `Racer-${Math.floor(1000 + Math.random() * 9000)}`;

export const useGameStore = create<GameState>()(
  persist(
    (set) => ({
      playerName: defaultName(),
      autoShift: false,
      activeExerciseId: null,
      completed: {},
      bestEt: {},
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
    }),
    { name: "carmap-game-v1" },
  ),
);
