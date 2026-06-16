import { create } from "zustand";
import { persist } from "zustand/middleware";

interface OnboardingState {
  dismissedTips: string[];
  tourCompleted: boolean;
  dismissTip: (id: string) => void;
  setTourCompleted: () => void;
  resetOnboarding: () => void;
  isTipDismissed: (id: string) => boolean;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      dismissedTips: [],
      tourCompleted: false,
      dismissTip: (id) =>
        set((state) => ({
          dismissedTips: [...state.dismissedTips, id],
        })),
      setTourCompleted: () => set({ tourCompleted: true }),
      resetOnboarding: () =>
        set({
          tourCompleted: false,
          dismissedTips: [],
        }),
      isTipDismissed: (id) => get().dismissedTips.includes(id),
    }),
    { name: "quanttrader-onboarding" }
  )
);
