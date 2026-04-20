import { create } from "zustand";
import { persist } from "zustand/middleware";

interface OnboardingState {
  dismissedTips: string[];
  tourCompleted: boolean;
  chatSeen: boolean;
  dismissTip: (id: string) => void;
  setTourCompleted: () => void;
  setChatSeen: () => void;
  isTipDismissed: (id: string) => boolean;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      dismissedTips: [],
      tourCompleted: false,
      chatSeen: false,
      dismissTip: (id) =>
        set((state) => ({
          dismissedTips: [...state.dismissedTips, id],
        })),
      setTourCompleted: () => set({ tourCompleted: true }),
      setChatSeen: () => set({ chatSeen: true }),
      isTipDismissed: (id) => get().dismissedTips.includes(id),
    }),
    { name: "quanttrader-onboarding" }
  )
);
