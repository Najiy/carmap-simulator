import { create } from "zustand";

/**
 * Session-only UI state that more than one component has to agree on.
 * Deliberately not persisted — a reload should always land on the full app.
 */
interface UiState {
  /**
   * The drive scene has the whole screen: the header, the section tabs and
   * the phone telemetry dock step aside. On a phone in landscape they would
   * otherwise eat a third of the height before the road starts.
   */
  immersive: boolean;
  setImmersive: (on: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  immersive: false,
  setImmersive: (immersive) => set({ immersive }),
}));
